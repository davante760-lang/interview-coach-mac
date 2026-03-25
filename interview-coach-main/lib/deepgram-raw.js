// Deepgram Streaming Proxy Module — Raw WebSocket version
// Uses raw WebSocket instead of SDK for full control over keepalive and reconnection

const WebSocket = require('ws');

class DeepgramProxy {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.connections = new Map();
    console.log('[Deepgram] Proxy initialized (raw WS mode), API key:', apiKey ? (apiKey.slice(0, 8) + '...') : 'MISSING');
  }

  createSession(sessionId, onTranscript, onError, onReady, options = {}) {
    const sampleRate = options.sampleRate || 16000;
    console.log('[Deepgram] Creating session ' + sessionId + '... (sampleRate=' + sampleRate + ')');

    // Build the Deepgram URL with query parameters
    const params = new URLSearchParams({
      model: 'nova-2',
      language: 'en',
      smart_format: 'false',
      interim_results: 'true',
      utterance_end_ms: '1000',
      vad_events: 'false',
      punctuate: 'true',
      diarize: 'false',
      encoding: 'linear16',
      sample_rate: sampleRate.toString(),
      channels: '1'
    });

    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
    
    try {
      const ws = new WebSocket(url, {
        headers: {
          'Authorization': `Token ${this.apiKey}`
        }
      });

      const session = {
        ws,
        intentionalClose: false,
        keepaliveInterval: null,
        sessionId
      };

      ws.on('open', () => {
        console.log('[Deepgram] Session ' + sessionId + ' OPEN (raw WS)');
        this.connections.set(sessionId, session);
        session.lastAudioTime = Date.now();

        // Keepalive: send KeepAlive JSON every 5s AND silent audio every 2s if no real audio
        session.keepaliveInterval = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          try {
            const timeSinceAudio = Date.now() - (session.lastAudioTime || 0);
            if (timeSinceAudio > 2000) {
              // No real audio recently — send 100ms of silence to keep connection alive
              const silenceSamples = new Int16Array(1600); // 100ms at 16kHz
              ws.send(Buffer.from(silenceSamples.buffer));
            }
            ws.send(JSON.stringify({ type: 'KeepAlive' }));
          } catch (e) {
            console.warn('[Deepgram] KeepAlive send failed:', e.message);
          }
        }, 3000);

        if (onReady) onReady();
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === 'Results') {
            const transcript = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
            if (transcript && transcript.transcript) {
              // Extract dominant speaker
              let speaker = null;
              if (transcript.words && transcript.words.length > 0) {
                const speakerCounts = {};
                for (const word of transcript.words) {
                  if (word.speaker !== undefined && word.speaker !== null) {
                    speakerCounts[word.speaker] = (speakerCounts[word.speaker] || 0) + 1;
                  }
                }
                let maxCount = 0;
                for (const [s, count] of Object.entries(speakerCounts)) {
                  if (count > maxCount) {
                    maxCount = count;
                    speaker = parseInt(s);
                  }
                }
              }

              onTranscript({
                text: transcript.transcript,
                confidence: transcript.confidence,
                isFinal: msg.is_final,
                speechFinal: msg.speech_final,
                words: transcript.words,
                speaker: speaker !== null ? 'Speaker ' + speaker : null,
                speakerId: speaker,
                start: msg.start,
                duration: msg.duration
              });
            }
          } else if (msg.type === 'UtteranceEnd') {
            onTranscript({
              type: 'utterance_end',
              timestamp: Date.now()
            });
          } else if (msg.type === 'Metadata') {
            console.log('[Deepgram] Session ' + sessionId + ' metadata received');
          } else if (msg.type === 'Error') {
            console.error('[Deepgram] Session ' + sessionId + ' error message:', JSON.stringify(msg));
          } else if (msg.type === 'Warning') {
            console.warn('[Deepgram] Session ' + sessionId + ' warning:', JSON.stringify(msg));
          }
        } catch (e) {
          // Binary response or parse error — ignore
        }
      });

      ws.on('error', (error) => {
        console.error('[Deepgram] Session ' + sessionId + ' WS ERROR:', error.message);
        if (onError) onError(error);
      });

      ws.on('close', (code, reason) => {
        console.log('[Deepgram] Session ' + sessionId + ' CLOSED — code:', code, 'reason:', reason?.toString() || 'none', 'intentional:', session.intentionalClose, 'timeSinceAudio:', Date.now() - (session.lastAudioTime||0) + 'ms');
        this.connections.delete(sessionId);
        
        if (session.keepaliveInterval) {
          clearInterval(session.keepaliveInterval);
          session.keepaliveInterval = null;
        }

        // Auto-reconnect unless intentionally closed
        if (!session.intentionalClose) {
          console.log('[Deepgram] Reconnecting session ' + sessionId + ' in 500ms...');
          setTimeout(() => {
            this.createSession(sessionId, onTranscript, onError, onReady, options);
          }, 500);
        }
      });

    } catch (error) {
      console.error('[Deepgram] Failed to create session ' + sessionId + ':', error);
      if (onError) onError(error);
    }
  }

  sendAudio(sessionId, audioData) {
    const session = this.connections.get(sessionId);
    if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
      try {
        session.lastAudioTime = Date.now();
        session.ws.send(audioData);
        // Log chunk sizes periodically to verify audio is arriving correctly
        if (!session._chunkCount) session._chunkCount = 0;
        session._chunkCount++;
        if (session._chunkCount % 100 === 0) {
          console.log(`[Deepgram] ${sessionId}: sent ${session._chunkCount} chunks, last chunk ${audioData.length} bytes (${Math.round(audioData.length/2)} int16 samples)`);
        }
      } catch (error) {
        console.error('[Deepgram] Send audio error for ' + sessionId + ':', error.message);
      }
    }
  }

  closeSession(sessionId) {
    const session = this.connections.get(sessionId);
    if (session) {
      session.intentionalClose = true;
      if (session.keepaliveInterval) {
        clearInterval(session.keepaliveInterval);
      }
      try {
        // Send CloseStream message before closing
        if (session.ws.readyState === WebSocket.OPEN) {
          session.ws.send(JSON.stringify({ type: 'CloseStream' }));
        }
        session.ws.close();
      } catch (e) {
        // Ignore close errors
      }
      this.connections.delete(sessionId);
    }
  }

  getActiveSessionCount() {
    return this.connections.size;
  }
}

module.exports = DeepgramProxy;
