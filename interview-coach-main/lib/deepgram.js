// Deepgram Streaming Proxy Module
// Proxies audio from the browser through the server to Deepgram
// Keeps API key server-side and handles reconnection

const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

class DeepgramProxy {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.deepgram = createClient(apiKey);
    this.connections = new Map();
    console.log('[Deepgram] Proxy initialized, API key:', apiKey ? (apiKey.slice(0, 8) + '...') : 'MISSING');
  }

  createSession(sessionId, onTranscript, onError, onReady, options = {}) {
    const sampleRate = options.sampleRate || 16000;
    console.log('[Deepgram] Creating session ' + sessionId + '... (sampleRate=' + sampleRate + ')');

    try {
      const connection = this.deepgram.listen.live({
        model: 'nova-2',
        language: 'en',
        smart_format: true,
        interim_results: true,
        utterance_end_ms: 1500,
        vad_events: true,
        punctuate: true,
        diarize: true,
        encoding: 'linear16',
        sample_rate: sampleRate,
        channels: 1
      });

      connection.on(LiveTranscriptionEvents.Open, () => {
        console.log('[Deepgram] Session ' + sessionId + ' OPEN and ready (diarization ON)');
        this.connections.set(sessionId, connection);
        if (onReady) onReady();
      });

      connection.on(LiveTranscriptionEvents.Transcript, (data) => {
        const transcript = data.channel && data.channel.alternatives && data.channel.alternatives[0];
        if (transcript && transcript.transcript) {
          // Extract dominant speaker from word-level diarization
          let speaker = null;
          if (transcript.words && transcript.words.length > 0) {
            const speakerCounts = {};
            for (const word of transcript.words) {
              if (word.speaker !== undefined && word.speaker !== null) {
                speakerCounts[word.speaker] = (speakerCounts[word.speaker] || 0) + 1;
              }
            }
            // Find the most frequent speaker in this utterance
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
            isFinal: data.is_final,
            speechFinal: data.speech_final,
            words: transcript.words,
            speaker: speaker !== null ? 'Speaker ' + speaker : null,
            speakerId: speaker,
            start: data.start,
            duration: data.duration
          });
        }
      });

      connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
        onTranscript({
          type: 'utterance_end',
          timestamp: Date.now()
        });
      });

      connection.on(LiveTranscriptionEvents.Error, (error) => {
        console.error('[Deepgram] Session ' + sessionId + ' ERROR:', error);
        if (onError) onError(error);
      });

      connection.on(LiveTranscriptionEvents.Close, (closeEvent) => {
        console.log('[Deepgram] Session ' + sessionId + ' CLOSED — code:', closeEvent);
        this.connections.delete(sessionId);
        if (connection._keepaliveInterval) {
          clearInterval(connection._keepaliveInterval);
        }
        // Do NOT auto-reconnect — the client WS reconnect handler will send
        // a fresh start_call which creates a properly-routed new session.
        // Auto-reconnecting here causes orphaned sessions under the old sessionId.
      });

      // Send keepalive every 5 seconds to prevent Deepgram timeout
      connection._keepaliveInterval = setInterval(() => {
        if (this.connections.has(sessionId)) {
          try {
            if (typeof connection.keepAlive === 'function') {
              connection.keepAlive();
            } else {
              connection.send(JSON.stringify({ type: 'KeepAlive' }));
            }
          } catch (e) {
            console.warn('[Deepgram] keepAlive failed for ' + sessionId + ':', e.message);
          }
        } else {
          clearInterval(connection._keepaliveInterval);
        }
      }, 5000);

    } catch (error) {
      console.error('[Deepgram] Failed to create session ' + sessionId + ':', error);
      if (onError) onError(error);
    }
  }

  sendAudio(sessionId, audioData) {
    const connection = this.connections.get(sessionId);
    if (connection) {
      try {
        connection.send(audioData);
      } catch (error) {
        console.error('[Deepgram] Send audio error for ' + sessionId + ':', error.message);
      }
    } else {
      // Log occasionally when audio is being dropped (no session)
      if (!this._dropCount) this._dropCount = 0;
      this._dropCount++;
      if (this._dropCount % 100 === 1) {
        console.warn('[Deepgram] No session ' + sessionId + ' — dropping audio (' + this._dropCount + ' chunks dropped)');
      }
    }
  }

  closeSession(sessionId) {
    const connection = this.connections.get(sessionId);
    if (connection) {
      connection._intentionalClose = true;
      if (connection._keepaliveInterval) {
        clearInterval(connection._keepaliveInterval);
      }
      try {
        connection.finish();
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
