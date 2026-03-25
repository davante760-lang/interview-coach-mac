// Skribby Meeting Bot Module
// Handles bot creation, real-time transcript streaming via WebSocket

const WebSocket = require('ws');

class SkribbyBot {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.apiBase = 'https://platform.skribby.io/api/v1';
    this.activeBots = new Map(); // botId -> { ws, status }
    console.log('[Skribby] Initialized, API key:', apiKey ? (apiKey.slice(0, 12) + '...') : 'MISSING');
  }

  // Create a bot and send it to a meeting
  async createBot(meetingUrl, botName, onTranscript, onStatus, onError) {
    // Detect service from URL
    let service = 'gmeet';
    if (meetingUrl.includes('zoom.us') || meetingUrl.includes('zoom.com')) {
      service = 'zoom';
    } else if (meetingUrl.includes('teams.microsoft.com') || meetingUrl.includes('teams.live.com')) {
      service = 'teams';
    }

    console.log('[Skribby] Creating bot for', service, 'meeting...');

    try {
      const response = await fetch(this.apiBase + '/bot', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + this.apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          transcription_model: process.env.SKRIBBY_TRANSCRIPTION_MODEL || 'whisper',
          meeting_url: meetingUrl,
          service: service,
          bot_name: botName || 'Call Coach',
          lang: 'en',
          video: true,
          store_recording_for_1_year: true
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('[Skribby] Create bot failed:', response.status, errText);
        if (onError) onError(new Error('Failed to create bot: ' + response.status + ' ' + errText));
        return null;
      }

      const bot = await response.json();
      console.log('[Skribby] Bot created:', bot.id, 'Status:', bot.status);

      // Connect to real-time WebSocket if available
      if (bot.websocket_url) {
        this._connectWebSocket(bot.id, bot.websocket_url, onTranscript, onStatus, onError);
      } else if (bot.websocket_read_only_url) {
        this._connectWebSocket(bot.id, bot.websocket_read_only_url, onTranscript, onStatus, onError);
      } else {
        console.log('[Skribby] No websocket URL yet, will poll for it...');
        // Poll for bot status until websocket URL is available
        this._pollForWebSocket(bot.id, onTranscript, onStatus, onError);
      }

      return bot;
    } catch (error) {
      console.error('[Skribby] Create bot error:', error.message);
      if (onError) onError(error);
      return null;
    }
  }

  // Connect to Skribby's real-time WebSocket
  _connectWebSocket(botId, wsUrl, onTranscript, onStatus, onError) {
    console.log('[Skribby] Connecting to WebSocket for bot', botId);

    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      console.log('[Skribby] WebSocket connected for bot', botId);
      this.activeBots.set(botId, { ws, status: 'connected' });
      if (onStatus) onStatus({ type: 'connected', botId });
    });

    ws.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());
        const eventType = event.event || event.type;
        
        // Log every event for debugging
        if (eventType !== 'ping') {
          console.log('[Skribby] Event:', eventType, '| Keys:', Object.keys(event.data || event).join(','));
        }

        switch (eventType) {
          case 'ping':
            // Keep-alive, ignore
            break;

          case 'transcript':
          case 'ts':
            if (event.data && (event.data.text || event.data.transcript)) {
              if (!this._speakerNameMap) this._speakerNameMap = {};
              if (!this._speakerIdHistory) this._speakerIdHistory = {};
              
              const speakerId = event.data.speaker;
              let speakerName = event.data.speaker_name || event.data.participant_name || event.data.name || null;
              
              // Cache name for this speaker ID
              if (speakerName && speakerId !== undefined) {
                this._speakerNameMap[speakerId] = speakerName;
                
                // Also track all IDs this name has used
                if (!this._speakerIdHistory[speakerName]) this._speakerIdHistory[speakerName] = new Set();
                this._speakerIdHistory[speakerName].add(String(speakerId));
                
                // Build a full map of ALL speaker IDs to names (including old IDs)
                const fullMap = {};
                for (const [name, ids] of Object.entries(this._speakerIdHistory)) {
                  for (const id of ids) fullMap[id] = name;
                }
                // Also include direct ID->name mapping
                for (const [id, name] of Object.entries(this._speakerNameMap)) {
                  fullMap[String(id)] = name;
                }
                
                if (onStatus) {
                  onStatus({ type: 'speaker_identified', speakerId, name: speakerName, speakerMap: fullMap });
                }
              }
              
              // Use cached name if available
              if (!speakerName && speakerId !== undefined) {
                speakerName = this._speakerNameMap[speakerId] || ('Speaker ' + speakerId);
              }

              onTranscript({
                text: event.data.transcript || event.data.text,
                speaker: speakerName || null,
                isFinal: true,
                timestamp: event.data.start || Date.now()
              });
            }
            break;

          case 'started-speaking':
          case 'started_speaking':
            if (event.data) {
              if (!this._speakerNameMap) this._speakerNameMap = {};
              const spkName = event.data.participant_name || event.data.participantName;
              const spkId = event.data.speaker ?? event.data.speaker_id;
              if (spkName && spkId !== undefined) {
                this._speakerNameMap[spkId] = spkName;
                if (!this._speakerIdHistory) this._speakerIdHistory = {};
                if (!this._speakerIdHistory[spkName]) this._speakerIdHistory[spkName] = new Set();
                this._speakerIdHistory[spkName].add(String(spkId));
              }
            }
            if (onStatus) onStatus({ type: 'speaking', speaker: event.data?.participant_name || 'Unknown' });
            break;

          case 'stopped-speaking':
          case 'stopped_speaking':
            if (onStatus) onStatus({ type: 'stopped_speaking', speaker: event.data?.participantName || event.data?.participant_name || 'Unknown' });
            break;

          case 'participant-tracked':
          case 'participant_tracked':
            console.log('[Skribby] Participant tracked:', JSON.stringify(event.data));
            if (event.data) {
              if (!this._speakerNameMap) this._speakerNameMap = {};
              if (!this._speakerIdHistory) this._speakerIdHistory = {};
              // Map participant name to their speaker ID if available
              const pName = event.data.name || event.data.participant_name || event.data.displayName;
              const pId = event.data.speaker_id ?? event.data.speakerId ?? event.data.id;
              if (pName && pId !== undefined) {
                this._speakerNameMap[pId] = pName;
                if (!this._speakerIdHistory[pName]) this._speakerIdHistory[pName] = new Set();
                this._speakerIdHistory[pName].add(String(pId));
                console.log('[Skribby] Pre-mapped speaker', pId, '→', pName);
              }
            }
            if (onStatus) onStatus({ type: 'participant', data: event.data });
            break;

          case 'status-update':
          case 'start':
            console.log('[Skribby] Bot started recording');
            if (onStatus) onStatus({ type: 'recording_started', botId });
            break;

          case 'stop':
            console.log('[Skribby] Bot stopped');
            if (onStatus) onStatus({ type: 'stopped', botId });
            break;

          case 'error':
            console.error('[Skribby] Bot error:', event.data);
            if (onError) onError(new Error(event.data?.message || 'Bot error'));
            break;

          case 'chat_message':
            // Meeting chat message, could be useful
            if (onStatus) onStatus({ type: 'chat', data: event.data });
            break;

          default:
            console.log('[Skribby] Unknown event:', event.event || event.type, JSON.stringify(event.data || {}).slice(0, 200));
        }
      } catch (e) {
        // Non-JSON message, ignore
      }
    });

    ws.on('close', () => {
      console.log('[Skribby] WebSocket closed for bot', botId);
      this.activeBots.delete(botId);
      if (onStatus) onStatus({ type: 'disconnected', botId });
    });

    ws.on('error', (error) => {
      console.error('[Skribby] WebSocket error for bot', botId, ':', error.message);
      if (onError) onError(error);
    });
  }

  // Poll for WebSocket URL if not immediately available
  async _pollForWebSocket(botId, onTranscript, onStatus, onError) {
    let attempts = 0;
    const maxAttempts = 30; // 30 attempts x 2 seconds = 60 seconds max

    const poll = async () => {
      attempts++;
      if (attempts > maxAttempts) {
        console.error('[Skribby] Timed out waiting for WebSocket URL');
        if (onError) onError(new Error('Timed out waiting for bot to connect'));
        return;
      }

      try {
        const response = await fetch(this.apiBase + '/bot/' + botId, {
          headers: { 'Authorization': 'Bearer ' + this.apiKey }
        });
        const bot = await response.json();

        if (bot.websocket_url || bot.websocket_read_only_url) {
          this._connectWebSocket(botId, bot.websocket_url || bot.websocket_read_only_url, onTranscript, onStatus, onError);
          return;
        }

        if (bot.status === 'failed' || bot.status === 'error') {
          if (onError) onError(new Error('Bot failed to join: ' + (bot.status_message || bot.status)));
          return;
        }

        // Keep polling
        setTimeout(poll, 2000);
      } catch (error) {
        console.error('[Skribby] Poll error:', error.message);
        setTimeout(poll, 2000);
      }
    };

    setTimeout(poll, 2000);
  }

  // Stop a bot
  async stopBot(botId) {
    console.log('[Skribby] Stopping bot', botId);

    // Try WebSocket stop action first
    const botInfo = this.activeBots.get(botId);
    if (botInfo && botInfo.ws && botInfo.ws.readyState === WebSocket.OPEN) {
      try {
        botInfo.ws.send(JSON.stringify({ action: 'stop' }));
      } catch (e) {
        // Ignore
      }
    }

    // Also call the API
    try {
      await fetch(this.apiBase + '/bot/' + botId + '/stop', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + this.apiKey }
      });
    } catch (error) {
      console.error('[Skribby] Stop bot error:', error.message);
    }

    this.activeBots.delete(botId);
  }

  // Get bot details (for post-call data)
  async getBot(botId) {
    try {
      const response = await fetch(this.apiBase + '/bot/' + botId + '?with-speaker-events=true', {
        headers: { 'Authorization': 'Bearer ' + this.apiKey }
      });
      return await response.json();
    } catch (error) {
      console.error('[Skribby] Get bot error:', error.message);
      return null;
    }
  }

  getActiveBotCount() {
    return this.activeBots.size;
  }
}

module.exports = SkribbyBot;
