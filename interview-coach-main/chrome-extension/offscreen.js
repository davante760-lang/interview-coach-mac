// Offscreen document — captures tab audio, plays it back to user, streams to server
// This runs in a hidden DOM context with full Web Audio API access

let mediaStream = null;
let audioContext = null;
let processor = null;
let ws = null;
let streaming = false;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  
  if (msg.type === 'start_capture') {
    startCapture(msg.streamId, msg.serverUrl);
  }
  if (msg.type === 'stop_capture') {
    stopCapture();
  }
});

async function startCapture(streamId, serverUrl) {
  try {
    console.log('[IC Extension] Starting capture with stream ID:', streamId.slice(0, 20) + '...');

    // Get media stream from the tab capture stream ID
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    });

    console.log('[IC Extension] Got media stream, tracks:', mediaStream.getAudioTracks().length);

    // IMPORTANT: tabCapture suppresses audio to the user by default.
    // We must route it back to AudioContext.destination so the user can still hear the meeting.
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(mediaStream);
    
    // Route audio back to speakers so user can hear the meeting
    source.connect(audioContext.destination);
    
    console.log('[IC Extension] Audio routed to speakers, sample rate:', audioContext.sampleRate);

    // Connect to Interview Coach WebSocket
    ws = new WebSocket(serverUrl);

    ws.onopen = () => {
      console.log('[IC Extension] WebSocket connected');

      // Send start_call with the real sample rate
      ws.send(JSON.stringify({
        type: 'start_call',
        prospectName: '',
        prospectCompany: '',
        sampleRate: audioContext.sampleRate,
        source: 'chrome_extension'
      }));

      // Start streaming after Deepgram initializes
      setTimeout(() => {
        streaming = true;
        console.log('[IC Extension] Streaming audio to server');
      }, 1500);
    };

    ws.onerror = (err) => {
      console.error('[IC Extension] WebSocket error');
      chrome.runtime.sendMessage({ type: 'capture_error', error: 'WebSocket failed' });
    };

    ws.onclose = () => {
      console.log('[IC Extension] WebSocket closed');
      if (streaming) {
        streaming = false;
        chrome.runtime.sendMessage({ type: 'capture_stopped' });
      }
    };

    // Process audio into int16 PCM and send to server
    processor = audioContext.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      if (!streaming || !ws || ws.readyState !== WebSocket.OPEN) return;

      const input = event.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      ws.send(int16.buffer);
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

  } catch (error) {
    console.error('[IC Extension] Capture failed:', error);
    chrome.runtime.sendMessage({ type: 'capture_error', error: error.message });
  }
}

function stopCapture() {
  streaming = false;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'end_call' }));
    ws.close();
  }
  ws = null;

  if (processor) { processor.disconnect(); processor = null; }
  if (audioContext) { audioContext.close(); audioContext = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }

  console.log('[IC Extension] Capture stopped');
  chrome.runtime.sendMessage({ type: 'capture_stopped' });
}
