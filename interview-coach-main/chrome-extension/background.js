// Background service worker — orchestrates tab audio capture
// Click the extension icon on a Google Meet/Zoom tab to start capturing.
// Click again to stop.

chrome.action.onClicked.addListener(async (tab) => {
  const status = await chrome.storage.session.get('capturing');
  
  if (status.capturing) {
    // Stop capturing
    chrome.runtime.sendMessage({ type: 'stop_capture', target: 'offscreen' });
    await chrome.storage.session.set({ capturing: false });
    chrome.action.setBadgeText({ text: '' });
    return;
  }

  // Create offscreen document if needed
  const existingContexts = await chrome.runtime.getContexts({});
  const hasOffscreen = existingContexts.find(c => c.contextType === 'OFFSCREEN_DOCUMENT');
  
  if (!hasOffscreen) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Capture tab audio for real-time interview transcription'
    });
  }

  // Get stream ID for the current tab's audio
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id
  });

  // Get server URL
  const config = await chrome.storage.local.get(['serverUrl']);
  const serverUrl = config.serverUrl || 'wss://interview-coach-production-9c63.up.railway.app';

  // Tell offscreen document to start capturing
  chrome.runtime.sendMessage({
    type: 'start_capture',
    target: 'offscreen',
    streamId,
    serverUrl
  });

  await chrome.storage.session.set({ capturing: true });
  chrome.action.setBadgeText({ text: 'REC' });
  chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
});

// Listen for stop/error from offscreen
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'capture_stopped' || msg.type === 'capture_error') {
    chrome.storage.session.set({ capturing: false });
    chrome.action.setBadgeText({ text: '' });
  }
});
