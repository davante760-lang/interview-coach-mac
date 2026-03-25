// Interview Coach — Client Application
// Handles UI, audio capture, WebSocket communication, and rendering

// ═══════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════

let ws = null;
let isCallActive = false;
let callStartTime = null;
let timerInterval = null;
let wordCount = 0;

// ═══════════════════════════════════════════════════
// VIEW SWITCHING
// ═══════════════════════════════════════════════════

function switchView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));

  document.getElementById(`view-${view}`).classList.add('active');
  document.querySelector(`[data-view="${view}"]`).classList.add('active');

  if (view === 'deals') loadDeals();
  if (view === 'warroom') loadWarRoom(activeWarRoomDealId);
  if (view === 'playbook') loadPlaybookFiles();
  if (view === 'calltypes') renderCallTypeSettings();
  if (view === 'keywords') loadKeywords();
  if (view === 'history') loadCallHistory();
  if (view === 'settings') loadCalendarSettings();
}

function switchPanelTab(tab) {
  document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
  document.getElementById(`tab-${tab}`).classList.add('active');
}

// ═══════════════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════════════

function connectWebSocket() {
  // Prevent duplicate connections
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}`);

  ws.onopen = () => {
    console.log('WebSocket connected');
    const statusEl = document.getElementById('call-status');
    if (statusEl && !isCallActive) {
      statusEl.className = 'status-badge status-idle';
      statusEl.querySelector('.status-text').textContent = 'Ready';
    }
    // Safety net: also HTTP-poll for active sessions in case WS notification was missed
    pollActiveCalendarSessions();
    
    // Keepalive: send a ping every 20 seconds to prevent Railway from closing the connection
    if (ws._keepalive) clearInterval(ws._keepalive);
    ws._keepalive = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 20000);
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case 'call_started':
        onCallStarted(msg);
        break;
      case 'desktop_session_available':
        // Desktop app started capturing — auto-attach so transcripts flow here
        console.log('[Desktop] Session available, attaching:', msg.sessionId);
        window._desktopSessionId = msg.sessionId;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'attach_desktop_session', sessionId: msg.sessionId }));
        }
        // Update status badge
        const statusEl2 = document.getElementById('call-status');
        if (statusEl2) {
          statusEl2.className = 'status-badge status-active';
          statusEl2.querySelector('.status-text').textContent = 'Desktop Capture Active';
        }
        break;
      case 'desktop_session_attached':
        console.log('[Desktop] Browser attached to desktop session:', msg.sessionId);
        break;
      case 'transcript':
        onTranscript(msg);
        break;
      case 'utterance_end':
        onUtteranceEnd();
        break;
      case 'coaching':
        onCoaching(msg.data);
        break;
      case 'ai_thinking':
        onAiThinking(msg.active);
        break;
      case 'bot_status':
        console.log('Bot status:', msg.data);
        if (msg.data && msg.data.type === 'recording_started' && !window._botJoinedShown) {
          window._botJoinedShown = true;
          onCoaching({ tier: 0, text: '🤖 Bot joined the meeting and is recording.', source: 'system', color: '#10B981' });
        }
        // Retroactively label transcript lines when speaker names are identified
        if (msg.data && msg.data.type === 'speaker_identified' && msg.data.speakerMap) {
          retroLabelSpeakers(msg.data.speakerMap);
        }
        break;
      case 'calendar_call_active':
        console.log('[Calendar] Received calendar_call_active:', msg.data);
        onCalendarCallActive(msg.data);
        break;
      case 'scorecard_update':
        onScorecardUpdate(msg.scorecard);
        break;
      case 'meddpicc_schema':
        onMeddpiccSchema(msg.schema);
        break;
      case 'meddpicc_data':
        onMeddpiccData(msg.data);
        break;
      case 'deal_brief':
        onDealBrief(msg.data);
        break;
      case 'classification':
        break;
      case 'speaker_labeled':
        if (msg.speakerMap) localSpeakerMap = { ...localSpeakerMap, ...msg.speakerMap };
        break;
      case 'call_ended':
        onCallEnded(msg);
        break;
      case 'call_summary':
        if (msg.summary) showSummary(msg);
        break;
      case 'error':
        console.error('Server error:', msg.message);
        break;
    }
  };

  ws.onclose = () => {
    console.log('WebSocket disconnected');
    if (ws && ws._keepalive) clearInterval(ws._keepalive);
    const thisWs = ws;
    ws = null; // Clear immediately to prevent duplicate reconnects
    
    const statusEl = document.getElementById('call-status');
    if (statusEl && !isCallActive) {
      statusEl.className = 'status-badge status-idle';
      statusEl.querySelector('.status-text').textContent = 'Reconnecting...';
    }
    
    // Reconnect after 500ms
    setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) return;
      connectWebSocket();
    }, 500);
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
}

// Safety net: HTTP-poll for active calendar sessions on every WS reconnect
// Catches cases where the WS notification was missed (redeploy, tab backgrounded, etc.)
async function pollActiveCalendarSessions() {
  try {
    const res = await fetch('/api/calendar/active-sessions');
    const data = await res.json();
    if (data.sessions && data.sessions.length > 0 && !isCallActive) {
      console.log('[Calendar] HTTP poll found active sessions:', data.sessions.length);
      for (const s of data.sessions) {
        onCalendarCallActive(s);
      }
    }
  } catch (e) {
    // Silent — WS notification is the primary channel
  }
}

// ═══════════════════════════════════════════════════
// CALL CONTROLS
// ═══════════════════════════════════════════════════

async function startBotCall() {
  const name = document.getElementById('prospect-name').value;
  const company = document.getElementById('prospect-company').value;
  const meetingUrl = document.getElementById('meeting-url').value.trim();

  if (!meetingUrl) {
    alert('Please paste a meeting link (Zoom, Teams, or Google Meet).');
    return;
  }

  // Reuse existing WS if open, otherwise connect
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectWebSocket();
  }

  await new Promise((resolve, reject) => {
    const check = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        clearInterval(check);
        resolve();
      }
    }, 100);
    setTimeout(() => { clearInterval(check); reject(new Error('WebSocket timeout')); }, 5000);
  }).catch(err => {
    console.error('Failed to connect:', err);
    alert('Could not connect to server. Please try again.');
    return;
  });

  console.log('Sending start_bot_call message...');
  window._botJoinedShown = false;
  ws.send(JSON.stringify({
    type: 'start_bot_call',
    prospectName: name,
    prospectCompany: company,
    meetingUrl: meetingUrl,
    botName: 'Call Coach',
    dealId: document.getElementById('call-deal-select').value || null,
    callType: document.getElementById('call-type-select').value || 'behavioral'
  }));
}

function endCall() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'end_call' }));
  }
}

function onCallStarted(msg) {
  isCallActive = true;
  callStartTime = msg.mode === 'calendar_bot' ? new Date(msg.timestamp).getTime() : Date.now();
  localSpeakerMap = {};

  // Update UI
  
  document.getElementById('btn-bot').classList.add('hidden');
  document.getElementById('btn-end').classList.remove('hidden');
  document.getElementById('note-bar').classList.remove('hidden');

  const status = document.getElementById('call-status');
  status.className = 'status-badge status-live';
  status.querySelector('.status-text').textContent = msg.mode === 'calendar_bot' ? 'Calendar Live' : msg.mode === 'bot' ? 'Bot Live' : 'Live';

  const timer = document.getElementById('call-timer');
  timer.classList.remove('hidden');
  timerInterval = setInterval(updateTimer, 1000);

  // Clear previous data (unless syncing mid-call from calendar)
  if (msg.mode !== 'calendar_bot') {
    document.getElementById('transcript-feed').innerHTML = '';
    document.getElementById('coaching-feed').innerHTML = '';
    wordCount = 0;
    updateWordCount();
  }
}

function onCalendarCallActive(data) {
  // A calendar bot is already in a call — show banner and auto-attach
  console.log('[Calendar] Active call detected:', data.title);

  // Switch to Live Call view
  switchView('call');

  // Show a join banner
  const feed = document.getElementById('coaching-feed');
  const emptyState = feed.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  const elapsed = Math.floor((Date.now() - data.startTime) / 1000);
  const mins = Math.floor(elapsed / 60);

  const banner = document.createElement('div');
  banner.className = 'coaching-card coaching-ai';
  banner.id = 'calendar-join-banner';
  banner.innerHTML =
    '<div style="padding:4px 0">' +
      '<div style="font-size:14px;font-weight:600;color:var(--blue);margin-bottom:4px">📅 ' + escapeHtml(data.title) + '</div>' +
      '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">Bot joined ' + mins + ' min ago · Coaching is running server-side</div>' +
      '<button onclick="attachToCalendarSession(\'' + data.botId + '\')" style="background:var(--blue);color:white;border:none;border-radius:var(--radius-sm);padding:8px 16px;font-family:var(--font);font-size:13px;font-weight:600;cursor:pointer">Connect to Live Coaching</button>' +
    '</div>';
  feed.insertBefore(banner, feed.firstChild);

  // Auto-attach after 1 second (give UI time to render)
  setTimeout(() => attachToCalendarSession(data.botId), 1000);
}

function attachToCalendarSession(botId) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  // Remove join banner
  const banner = document.getElementById('calendar-join-banner');
  if (banner) banner.remove();

  const dealId = document.getElementById('call-deal-select')?.value || '';
  const callType = document.getElementById('call-type-select')?.value || 'behavioral';

  ws.send(JSON.stringify({
    type: 'attach_calendar_session',
    botId,
    dealId,
    callType,
    prospectName: document.getElementById('prospect-name')?.value || '',
    prospectCompany: document.getElementById('prospect-company')?.value || ''
  }));
}

function onCallEnded(msg) {
  isCallActive = false;
  

  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }

  // Update UI
  
  document.getElementById('btn-bot').classList.remove('hidden');
  document.getElementById('btn-end').classList.add('hidden');
  document.getElementById('note-bar').classList.add('hidden');

  const status = document.getElementById('call-status');
  status.className = 'status-badge status-idle';
  status.querySelector('.status-text').textContent = 'Ready';

  if (ws) { ws.close(); ws = null; }

  // Immediately re-establish always-on WS for calendar notifications
  setTimeout(() => connectWebSocket(), 500);

  // Show summary modal
  if (msg.summary) {
    showSummary(msg);
  }
}

function updateTimer() {
  if (!callStartTime) return;
  const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
  const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
  const secs = (elapsed % 60).toString().padStart(2, '0');
  document.getElementById('call-timer').textContent = `${mins}:${secs}`;
}

// ═══════════════════════════════════════════════════
// TRANSCRIPT RENDERING
// ═══════════════════════════════════════════════════

let interimElement = null;

let localSpeakerMap = {};

function onTranscript(msg) {
  const feed = document.getElementById('transcript-feed');

  // Clear empty state
  const emptyState = feed.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  if (msg.isFinal) {
    // Remove interim element if it exists
    if (interimElement) {
      interimElement.remove();
      interimElement = null;
    }

    // Resolve speaker label
    let speakerLabel = msg.speaker || null;
    if (msg.speakerId !== null && msg.speakerId !== undefined && localSpeakerMap[msg.speakerId]) {
      speakerLabel = localSpeakerMap[msg.speakerId];
    }
    const isRep = speakerLabel && speakerLabel.includes('(You)');

    // Add final transcript line
    const line = document.createElement('div');
    line.className = 'transcript-line final';
    if (speakerLabel && speakerLabel.includes('Speaker ')) {
      // Temporary speaker ID label — mark for retroactive update
      line.setAttribute('data-speaker-id', speakerLabel.replace('Speaker ', ''));
    }
    if (isRep) line.style.borderLeft = '2px solid var(--blue)';

    const timestamp = document.createElement('span');
    timestamp.className = 'transcript-timestamp';
    const elapsed = callStartTime ? Math.floor((Date.now() - callStartTime) / 1000) : 0;
    const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const secs = (elapsed % 60).toString().padStart(2, '0');
    timestamp.textContent = `${mins}:${secs}`;

    line.appendChild(timestamp);

    if (speakerLabel) {
      const speaker = document.createElement('span');
      speaker.className = 'speaker-label';
      speaker.style.cssText = 'color:' + (isRep ? 'var(--blue)' : 'var(--accent)') + ';font-weight:600;font-size:11px;margin-right:6px;';
      speaker.textContent = speakerLabel + ':';
      line.appendChild(speaker);
    } else if (msg.speakerId !== null && msg.speakerId !== undefined) {
      // Unknown speaker in mic mode — show label buttons
      line.setAttribute('data-speaker-id', msg.speakerId);
      const labelBtns = document.createElement('span');
      labelBtns.className = 'speaker-label';
      labelBtns.style.cssText = 'margin-right:6px;';
      labelBtns.innerHTML = '<span style="color:var(--text-muted);font-size:10px;margin-right:4px">Speaker ' + msg.speakerId + '</span>' +
        '<button style="background:var(--blue);color:white;border:none;border-radius:3px;font-size:9px;padding:1px 6px;cursor:pointer;margin-right:3px;font-family:var(--font)" ' +
          'onclick="labelSpeaker(' + msg.speakerId + ',true)">That\'s me</button>' +
        '<button style="background:var(--accent);color:white;border:none;border-radius:3px;font-size:9px;padding:1px 6px;cursor:pointer;font-family:var(--font)" ' +
          'onclick="labelSpeaker(' + msg.speakerId + ',false)">Interviewer</button>';
      line.appendChild(labelBtns);
    }

    line.appendChild(document.createTextNode(msg.text));
    feed.appendChild(line);

    // Update word count
    wordCount += msg.text.split(/\s+/).filter(w => w.length > 0).length;
    updateWordCount();
  } else {
    // Update or create interim element
    if (!interimElement) {
      interimElement = document.createElement('div');
      interimElement.className = 'transcript-line interim';
      feed.appendChild(interimElement);
    }
    interimElement.textContent = msg.text;
  }

  // Auto-scroll
  feed.scrollTop = feed.scrollHeight;
}

function labelSpeaker(speakerId, isMe) {
  const prospectName = document.getElementById('prospect-name').value || 'Interviewer';
  const label = isMe ? prospectName.split(' ')[0] + ' (You)' : prospectName || 'Interviewer';

  localSpeakerMap[speakerId] = label;

  // If labeling one speaker, auto-label the other
  if (isMe) {
    // Find any other speaker ID and label them as interviewer
    for (const el of document.querySelectorAll('.transcript-line')) {
      const btn = el.querySelector('button');
      if (btn) {
        const match = btn.getAttribute('onclick')?.match(/labelSpeaker\((\d+)/);
        if (match && parseInt(match[1]) !== speakerId && !localSpeakerMap[parseInt(match[1])]) {
          localSpeakerMap[parseInt(match[1])] = prospectName || 'Interviewer';
        }
      }
    }
  }

  // Send to server
  ws.send(JSON.stringify({ type: 'label_speaker', speakerId, label }));

  // Also label the other speaker on server
  for (const [id, lbl] of Object.entries(localSpeakerMap)) {
    if (parseInt(id) !== speakerId) {
      ws.send(JSON.stringify({ type: 'label_speaker', speakerId: parseInt(id), label: lbl }));
    }
  }

  // Re-render transcript with labels — replace all label buttons
  document.querySelectorAll('.transcript-line').forEach(line => {
    const btns = line.querySelectorAll('button');
    btns.forEach(btn => {
      const match = btn.getAttribute('onclick')?.match(/labelSpeaker\((\d+)/);
      if (match) {
        const sid = parseInt(match[1]);
        if (localSpeakerMap[sid]) {
          const parentSpan = btn.closest('span') || btn.parentElement;
          const isRepLabel = localSpeakerMap[sid].includes('(You)');
          parentSpan.innerHTML = '';
          const sp = document.createElement('span');
          sp.style.cssText = 'color:' + (isRepLabel ? 'var(--blue)' : 'var(--accent)') + ';font-weight:600;font-size:11px;margin-right:6px;';
          sp.textContent = localSpeakerMap[sid] + ':';
          parentSpan.replaceWith(sp);
          if (isRepLabel) line.style.borderLeft = '2px solid var(--blue)';
        }
      }
    });
  });
}

// Retroactively update transcript lines when Skribby identifies speaker names
function retroLabelSpeakers(speakerMap) {
  document.querySelectorAll('.transcript-line[data-speaker-id]').forEach(line => {
    const sid = line.getAttribute('data-speaker-id');
    const name = speakerMap[sid];
    if (!name) return;

    const existing = line.querySelector('.speaker-label');
    if (existing) {
      // Check if it's already showing the correct name
      if (existing.textContent === name + ':') return;
      // Replace with real name
      existing.innerHTML = '';
      existing.style.cssText = 'color:var(--accent);font-weight:600;font-size:11px;margin-right:6px;';
      existing.textContent = name + ':';
    } else {
      // No speaker label yet — add one after the timestamp
      const timestamp = line.querySelector('.transcript-timestamp');
      const sp = document.createElement('span');
      sp.className = 'speaker-label';
      sp.style.cssText = 'color:var(--accent);font-weight:600;font-size:11px;margin-right:6px;';
      sp.textContent = name + ':';
      if (timestamp && timestamp.nextSibling) {
        line.insertBefore(sp, timestamp.nextSibling);
      } else {
        line.insertBefore(sp, line.firstChild?.nextSibling || line.firstChild);
      }
    }
    // Remove the data attribute so we don't process again
    line.removeAttribute('data-speaker-id');
  });
}

function onUtteranceEnd() {
  // Visual break between utterances
  const feed = document.getElementById('transcript-feed');
  const spacer = document.createElement('div');
  spacer.style.height = '6px';
  feed.appendChild(spacer);
}

function updateWordCount() {
  document.getElementById('transcript-word-count').textContent = `${wordCount} words`;
}

// ═══════════════════════════════════════════════════
// COACHING RENDERING
// ═══════════════════════════════════════════════════

function onAiThinking(active) {
  const indicator = document.getElementById('ai-thinking');

  if (active) {
    if (indicator) indicator.style.display = 'flex';
  } else {
    if (indicator) indicator.style.display = 'none';
  }
}

function onCoaching(data) {
  // Clear thinking indicator when coaching arrives
  const indicator = document.getElementById('ai-thinking');
  if (indicator) indicator.style.display = 'none';

  // Only show AI tier 3 and quick_answer in coaching feed
  if (data.tier !== 3 && data.source !== 'ai' && data.source !== 'quick_answer') return;

  const feed = document.getElementById('coaching-feed');

  // Clear empty state
  const emptyState = feed.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  const isQuickAnswer = data.source === 'quick_answer';
  const badgeColor = isQuickAnswer ? 'var(--orange)' : 'var(--blue)';
  const badgeBg = isQuickAnswer ? 'rgba(249,115,22,0.15)' : 'rgba(59,130,246,0.15)';
  const badgeLabel = isQuickAnswer ? '⚡ Say This' : '💬 Say This';
  const borderColor = isQuickAnswer ? 'rgba(249,115,22,0.3)' : 'rgba(59,130,246,0.3)';
  const borderLeft = isQuickAnswer ? 'var(--orange)' : 'var(--blue)';

  // Show the detected question as an interviewer bubble (if present)
  if (data.question) {
    const qCard = document.createElement('div');
    qCard.className = 'coaching-card coaching-question';
    qCard.innerHTML = `
      <div class="coaching-meta">
        <span class="tier-badge" style="background:rgba(100,116,139,0.15);color:var(--text-muted)">🎤 Question</span>
        <span class="coaching-time">${timeStr}</span>
      </div>
      <div class="coaching-text coaching-question-text">${escapeHtml(data.question)}</div>
    `;
    feed.insertBefore(qCard, feed.firstChild);
  }

  // Show the answer
  const aCard = document.createElement('div');
  aCard.className = 'coaching-card coaching-answer';
  aCard.style.cssText = `background:${badgeBg.replace('0.15','0.06')};border:1px solid ${borderColor};border-left:3px solid ${borderLeft}`;
  aCard.innerHTML = `
    <div class="coaching-meta">
      <span class="tier-badge" style="background:${badgeBg};color:${badgeColor}">${badgeLabel}</span>
      <span class="coaching-time">${timeStr}</span>
    </div>
    <div class="coaching-text coaching-answer-text">${escapeHtml(data.text)}</div>
  `;
  feed.insertBefore(aCard, feed.firstChild);

  // Keep max 20 cards
  while (feed.children.length > 20) {
    feed.removeChild(feed.lastChild);
  }
}

function requestCoaching() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'request_coaching' }));
  }
}

// ═══════════════════════════════════════════════════
// SCORECARD
// ═══════════════════════════════════════════════════

function onScorecardUpdate(scorecard) {
  let covered = 0;
  const total = Object.keys(scorecard).length;

  for (const [field, status] of Object.entries(scorecard)) {
    const section = document.querySelector(`.meddpicc-section[data-field="${field}"]`);
    if (!section) continue;

    section.setAttribute('data-status', status);

    const statusEl = section.querySelector('.meddpicc-status');
    if (status === 'empty') {
      statusEl.textContent = '—';
    } else if (status === 'partial') {
      statusEl.textContent = '◐';
      covered += 0.5;
    } else if (status === 'complete') {
      statusEl.textContent = '✓';
      covered += 1;
    }
  }

  const pct = Math.round((covered / total) * 100);
  document.getElementById('scorecard-pct').textContent = `${pct}%`;

  const gaps = total - Math.ceil(covered);
  document.getElementById('scorecard-gaps').textContent = gaps > 0
    ? `${gaps} gap${gaps !== 1 ? 's' : ''} remaining`
    : 'All fields covered!';
}

// Add a bullet point to a scorecard section
function addMeddpiccBullet(field, text) {
  const container = document.getElementById('bullets-' + field);
  if (!container) return;

  // Remove the "no data" placeholder
  const empty = container.querySelector('.meddpicc-empty');
  if (empty) empty.remove();

  const bullet = document.createElement('p');
  bullet.className = 'meddpicc-bullet';
  bullet.textContent = text;
  container.appendChild(bullet);
}

// Render scorecard sub-field structure from schema
function onMeddpiccSchema(schema) {
  window._meddpiccSchema = schema;

  for (const [field, config] of Object.entries(schema)) {
    const container = document.getElementById('bullets-' + field);
    if (!container) continue;

    container.innerHTML = '';
    for (const [subField, description] of Object.entries(config.fields)) {
      const row = document.createElement('div');
      row.className = 'meddpicc-subfield';
      row.id = `mf-${field}-${subField}`;
      row.innerHTML = `
        <span class="meddpicc-sublabel">${description}</span>
        <span class="meddpicc-subvalue" id="mv-${field}-${subField}">—</span>
      `;
      container.appendChild(row);
    }
  }
}

// Update scorecard bullets with extracted data
function onMeddpiccData(data) {
  for (const [field, subFields] of Object.entries(data)) {
    const section = document.querySelector(`.meddpicc-section[data-field="${field}"]`);

    for (const [subField, value] of Object.entries(subFields)) {
      const el = document.getElementById(`mv-${field}-${subField}`);
      if (!el) continue;

      if (value) {
        el.textContent = value;
        el.classList.add('filled');
      }
    }

    // Update section status indicator
    if (section) {
      const filledCount = Object.values(subFields).filter(v => v !== null).length;
      const totalCount = Object.keys(subFields).length;
      if (filledCount === 0) section.setAttribute('data-status', 'empty');
      else if (filledCount >= totalCount) section.setAttribute('data-status', 'complete');
      else section.setAttribute('data-status', 'partial');

      const statusEl = section.querySelector('.meddpicc-status');
      if (statusEl) {
        if (filledCount === 0) statusEl.textContent = '—';
        else if (filledCount >= totalCount) statusEl.textContent = '✓';
        else statusEl.textContent = `${filledCount}/${totalCount}`;
      }
    }
  }
}

// ═══════════════════════════════════════════════════
// NOTES
// ═══════════════════════════════════════════════════

function addNote() {
  const input = document.getElementById('quick-note');
  const text = input.value.trim();
  if (!text) return;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'add_note', text }));
  }

  // Show in coaching feed as a manual note
  onCoaching({ tier: 0, text: `📝 ${text}`, source: 'manual', color: '#64748B' });
  input.value = '';
}

// ═══════════════════════════════════════════════════
// PLAYBOOK MANAGEMENT
// ═══════════════════════════════════════════════════

// ═══════════════════════════════════════════════════
// PLAYBOOK SECTIONS CONFIG
// ═══════════════════════════════════════════════════

const PLAYBOOK_SECTIONS = [
  {
    id: 'company_overview', name: 'Company Research', icon: '🏢',
    desc: 'Research on the company — mission, products, culture, recent news, competitors.',
    sources: 'Company website, Glassdoor, LinkedIn, annual reports, recent press releases.',
    levels: { ok: 1, good: 2, great: 4, worldClass: 6 },
    levelDescs: { ok: '1 overview doc', good: '+ culture notes', great: '3-5 docs (news, financials)', worldClass: '5+ with insider perspectives' }
  },
  {
    id: 'products_pricing', name: 'Role Details', icon: '📋',
    desc: 'Job description, role requirements, team structure, reporting lines, tech stack.',
    sources: 'Job posting, recruiter notes, LinkedIn profiles of team members, Glassdoor reviews.',
    levels: { ok: 1, good: 2, great: 4, worldClass: 8 },
    levelDescs: { ok: '1 job description', good: '+ team research', great: '3-5 docs with org chart', worldClass: '8+ with insider context' }
  },
  {
    id: 'value_propositions', name: 'My Value Props', icon: '🎯',
    desc: 'Your key selling points mapped to this role. Why YOU are the right fit.',
    sources: 'Resume, career highlights, manager feedback, performance reviews, self-assessment.',
    levels: { ok: 1, good: 3, great: 6, worldClass: 10 },
    levelDescs: { ok: '1 general pitch', good: '2-3 by competency', great: '5-8 with quantified impact', worldClass: '10+ per requirement' }
  },
  {
    id: 'competitive_intel', name: 'Industry Knowledge', icon: '🌐',
    desc: 'Industry trends, market dynamics, competitive landscape, and terminology.',
    sources: 'Industry reports, trade publications, analyst briefings, sector news.',
    levels: { ok: 1, good: 3, great: 6, worldClass: 10 },
    levelDescs: { ok: '1 industry overview', good: '2-3 trend summaries', great: '5-8 with data points', worldClass: '10+ with expert perspectives' }
  },
  {
    id: 'objection_handling', name: 'Tough Question Prep', icon: '🛡️',
    desc: 'Prepared responses for weakness, failure, conflict, salary, and gap questions.',
    sources: 'Self-reflection, career coach sessions, Glassdoor interview questions, mentors.',
    levels: { ok: 1, good: 1, great: 2, worldClass: 3 },
    levelDescs: { ok: '5-10 tough Qs', good: '15-20 with full answers', great: '25+ by category', worldClass: '40+ with practiced delivery' }
  },
  {
    id: 'discovery_framework', name: 'Interview Framework', icon: '🔍',
    desc: 'STAR examples, behavioral answer templates, structured response guides.',
    sources: 'STAR method templates, behavioral question banks, interview frameworks.',
    levels: { ok: 1, good: 3, great: 5, worldClass: 8 },
    levelDescs: { ok: '1 STAR template', good: '+ competency map', great: '3-5 per competency', worldClass: '8+ with scored examples' }
  },
  {
    id: 'talk_tracks', name: 'Practice Answers', icon: '🎙️',
    desc: 'Polished answers to common questions — "tell me about yourself," career story, motivation.',
    sources: 'Practice sessions, mock interviews, career coach feedback, self-recording.',
    levels: { ok: 1, good: 4, great: 8, worldClass: 15 },
    levelDescs: { ok: '1 intro pitch', good: '3-5 by question type', great: '8-10 + follow-ups', worldClass: '15+ with variations' }
  },
  {
    id: 'industry_intel', name: 'Company News & Culture', icon: '📰',
    desc: 'Recent company news, culture insights, leadership changes, product launches.',
    sources: 'Company blog, LinkedIn posts, TechCrunch, industry news, employee reviews.',
    levels: { ok: 1, good: 3, great: 5, worldClass: 10 },
    levelDescs: { ok: '1 news summary', good: '2-3 recent articles', great: '5+ with culture insights', worldClass: '10+ with leadership research' }
  },
  {
    id: 'case_studies', name: 'Achievement Stories', icon: '🏆',
    desc: 'Your best professional stories with quantified results — ready to deploy in STAR format.',
    sources: 'Career history, performance reviews, project retrospectives, manager feedback.',
    levels: { ok: 2, good: 5, great: 12, worldClass: 20 },
    levelDescs: { ok: '2-3 stories', good: '5-8 across competencies', great: '10-15 with metrics', worldClass: '20+ mapped to role requirements' }
  }
];

// Track files per section (in-memory, synced with server)
let playbookFilesBySection = {};

function getLevel(count, section) {
  if (count >= section.levels.worldClass) return 'world-class';
  if (count >= section.levels.great) return 'great';
  if (count >= section.levels.good) return 'good';
  if (count >= section.levels.ok) return 'ok';
  return 'empty';
}

function getLevelColor(level) {
  switch(level) {
    case 'world-class': return 'var(--green)';
    case 'great': return 'var(--purple)';
    case 'good': return 'var(--blue)';
    case 'ok': return 'var(--yellow)';
    default: return 'var(--text-muted)';
  }
}

function getLevelPct(count, section) {
  const max = section.levels.worldClass;
  return Math.min(100, Math.round((count / max) * 100));
}

function renderPlaybookSections() {
  const container = document.getElementById('playbook-sections');

  container.innerHTML = PLAYBOOK_SECTIONS.map(sec => {
    const files = playbookFilesBySection[sec.id] || [];
    const count = files.length;
    const level = getLevel(count, sec);
    const levelLabel = level === 'empty' ? 'Empty' : level === 'world-class' ? 'World Class' : level.charAt(0).toUpperCase() + level.slice(1);
    const pct = getLevelPct(count, sec);
    const color = getLevelColor(level);

    return `
      <div class="pb-section" id="pb-${sec.id}">
        <div class="pb-section-header" onclick="togglePbSection('${sec.id}')">
          <span class="pb-section-icon">${sec.icon}</span>
          <div class="pb-section-info">
            <div class="pb-section-name">${sec.name}</div>
            <div class="pb-section-count">${count} doc${count !== 1 ? 's' : ''} uploaded</div>
          </div>
          <div class="pb-section-meter">
            <div class="pb-meter-bar"><div class="pb-meter-fill" style="width:${pct}%;background:${color}"></div></div>
            <span class="pb-meter-label" data-level="${level}">${levelLabel}</span>
          </div>
          <span class="pb-section-chevron">▶</span>
        </div>
        <div class="pb-section-body">
          <button class="pb-info-toggle" onclick="event.stopPropagation();togglePbInfo('${sec.id}')">ℹ️ What is this & where to find it</button>
          <div class="pb-info-content" id="pb-info-${sec.id}">
            <p><strong>What:</strong> ${sec.desc}</p>
            <p><strong>Where to find it:</strong> ${sec.sources}</p>
            <div class="pb-info-levels">
              <div class="pb-info-level"><span class="pb-info-dot" style="background:var(--yellow)"></span><strong>Ok:</strong> ${sec.levelDescs.ok}</div>
              <div class="pb-info-level"><span class="pb-info-dot" style="background:var(--blue)"></span><strong>Good:</strong> ${sec.levelDescs.good}</div>
              <div class="pb-info-level"><span class="pb-info-dot" style="background:var(--purple)"></span><strong>Great:</strong> ${sec.levelDescs.great}</div>
              <div class="pb-info-level"><span class="pb-info-dot" style="background:var(--green)"></span><strong>World Class:</strong> ${sec.levelDescs.worldClass}</div>
            </div>
          </div>
          <div class="pb-upload" onclick="document.getElementById('pb-files-${sec.id}').click()"
               ondrop="handleSectionDrop(event,'${sec.id}')" ondragover="event.preventDefault();this.classList.add('dragover')"
               ondragleave="this.classList.remove('dragover')">
            <input type="file" id="pb-files-${sec.id}" multiple accept=".txt,.md,.pdf,.docx"
                   onchange="uploadSectionFiles('${sec.id}',this.files)" style="display:none">
            <p class="pb-upload-text">Drop files here or click to upload</p>
          </div>
          <div class="pb-file-list" id="pb-list-${sec.id}">
            ${files.map(f => {
              const ext = f.name.split('.').pop().toUpperCase();
              const icon = ext === 'PDF' ? '📄' : ext === 'DOCX' ? '📝' : '📃';
              const date = new Date(f.addedAt).toLocaleDateString();
              return `<div class="file-item">
                <div class="file-item-info"><span class="file-item-icon">${icon}</span><div>
                  <div class="file-item-name">${escapeHtml(f.name)}</div>
                  <div class="file-item-meta">${f.chunkCount} chunks · ${date}</div>
                </div></div>
                <button class="file-item-remove" onclick="removePlaybookFile('${f.id}','${sec.id}')" title="Remove">✕</button>
              </div>`;
            }).join('')}
          </div>
        </div>
      </div>
    `;
  }).join('');

  renderOverallMeter();
}

function renderOverallMeter() {
  const totalFiles = Object.values(playbookFilesBySection).reduce((sum, files) => sum + files.length, 0);
  const totalMax = PLAYBOOK_SECTIONS.reduce((sum, sec) => sum + sec.levels.worldClass, 0);
  const pct = Math.min(100, Math.round((totalFiles / totalMax) * 100));

  let overallLevel = 'empty';
  const sectionLevels = PLAYBOOK_SECTIONS.map(sec => getLevel((playbookFilesBySection[sec.id] || []).length, sec));
  const nonEmpty = sectionLevels.filter(l => l !== 'empty').length;
  if (nonEmpty >= 9) overallLevel = 'world-class';
  else if (nonEmpty >= 7) overallLevel = 'great';
  else if (nonEmpty >= 5) overallLevel = 'good';
  else if (nonEmpty >= 3) overallLevel = 'ok';

  const color = getLevelColor(overallLevel);
  const label = overallLevel === 'empty' ? 'Getting Started' : overallLevel === 'world-class' ? 'World Class' : overallLevel.charAt(0).toUpperCase() + overallLevel.slice(1);

  document.getElementById('playbook-overall-meter').innerHTML = `
    <span><strong>${totalFiles}</strong> docs across ${nonEmpty}/9 sections</span>
    <div class="overall-meter-bar"><div class="overall-meter-fill" style="width:${pct}%;background:${color}"></div></div>
    <span style="color:${color};font-weight:700;font-size:12px">${label}</span>
  `;
}

function togglePbSection(id) {
  document.getElementById('pb-' + id).classList.toggle('open');
}

function togglePbInfo(id) {
  document.getElementById('pb-info-' + id).classList.toggle('open');
}

async function loadPlaybookFiles() {
  try {
    const res = await fetch('/api/playbook');
    const data = await res.json();

    // Group files by section (using a simple naming convention or default to uncategorized)
    playbookFilesBySection = {};
    PLAYBOOK_SECTIONS.forEach(sec => { playbookFilesBySection[sec.id] = []; });

    for (const f of data.files) {
      // Check if file was tagged with a section
      const section = f.section || 'company_overview';
      if (playbookFilesBySection[section]) {
        playbookFilesBySection[section].push(f);
      } else {
        playbookFilesBySection['company_overview'].push(f);
      }
    }

    renderPlaybookSections();
  } catch (error) {
    console.error('Failed to load prep docs:', error);
  }
}

async function uploadSectionFiles(sectionId, files) {
  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file);
  }
  formData.append('section', sectionId);

  try {
    const res = await fetch('/api/playbook/upload', { method: 'POST', body: formData });
    const data = await res.json();
    loadPlaybookFiles();
  } catch (error) {
    console.error('Upload failed:', error);
    alert('Upload failed. Please try again.');
  }
}

function handleSectionDrop(event, sectionId) {
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.classList.remove('dragover');
  const files = event.dataTransfer.files;
  if (files.length > 0) uploadSectionFiles(sectionId, files);
}

async function removePlaybookFile(fileId, sectionId) {
  if (!confirm('Remove this file from your prep docs?')) return;
  try {
    await fetch(`/api/playbook/${fileId}`, { method: 'DELETE' });
    loadPlaybookFiles();
  } catch (error) {
    console.error('Remove failed:', error);
  }
}

// ═══════════════════════════════════════════════════
// PROSPECT INTEL
// ═══════════════════════════════════════════════════

async function uploadProspectFiles(files) {
  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file);
  }

  try {
    const res = await fetch('/api/prospect/upload', { method: 'POST', body: formData });
    const data = await res.json();
    document.getElementById('position-file-count').textContent =
      `${data.stats.files} file${data.stats.files !== 1 ? 's' : ''} loaded`;
  } catch (error) {
    console.error('Position upload failed:', error);
    alert('Upload failed. Please try again.');
  }
}

async function clearProspectIntel() {
  try {
    await fetch('/api/prospect/clear', { method: 'DELETE' });
    document.getElementById('position-file-count').textContent = 'No files loaded';
  } catch (error) {
    console.error('Clear failed:', error);
  }
}

// ═══════════════════════════════════════════════════
// RESUME UPLOAD
// ═══════════════════════════════════════════════════

async function uploadResume(files, fromPrepDocs) {
  if (!files || files.length === 0) return;
  const formData = new FormData();
  formData.append('files', files[0]);
  formData.append('section', 'resume');

  const statusEl = document.getElementById('resume-status');
  const dropZone = document.getElementById('resume-drop-zone');
  const dropIcon = document.getElementById('resume-drop-icon');
  const dropText = document.getElementById('resume-drop-text');
  if (statusEl) statusEl.textContent = 'Uploading...';
  if (dropText) dropText.innerHTML = '<div class="resume-drop-title">Uploading...</div>';

  try {
    const res = await fetch('/api/playbook/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.uploaded && data.uploaded.length > 0) {
      const fname = files[0].name;
      if (statusEl) {
        statusEl.textContent = '✓ ' + fname;
        statusEl.style.color = 'var(--green)';
      }
      if (dropZone) dropZone.classList.add('uploaded');
      if (dropIcon) dropIcon.textContent = '✓';
      if (dropText) dropText.innerHTML = '<div class="resume-drop-title" style="color:var(--green)">' + fname + '</div><div class="resume-drop-hint">Resume loaded — drop a new file to replace</div>';
    } else {
      if (statusEl) { statusEl.textContent = 'Upload failed'; statusEl.style.color = 'var(--red)'; }
      if (dropText) dropText.innerHTML = '<div class="resume-drop-title" style="color:var(--red)">Upload failed</div><div class="resume-drop-hint">Try again — PDF, DOCX, TXT, MD</div>';
    }
  } catch (error) {
    console.error('Resume upload failed:', error);
    if (statusEl) { statusEl.textContent = 'Upload failed'; statusEl.style.color = 'var(--red)'; }
    if (dropText) dropText.innerHTML = '<div class="resume-drop-title" style="color:var(--red)">Upload failed</div><div class="resume-drop-hint">Try again — PDF, DOCX, TXT, MD</div>';
  }
}

// Drag and drop handlers for resume zone
document.addEventListener('DOMContentLoaded', () => {
  const zone = document.getElementById('resume-drop-zone');
  if (!zone) return;

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove('drag-over');
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (files.length > 0) uploadResume(files, true);
  });
});

// Check if resume already uploaded on page load
async function checkResumeStatus() {
  try {
    const res = await fetch('/api/playbook');
    const data = await res.json();
    const resumeFiles = (data.files || []).filter(f => f.section === 'resume');
    if (resumeFiles.length > 0) {
      const fname = resumeFiles[0].name;
      const statusEl = document.getElementById('resume-status');
      if (statusEl) {
        statusEl.textContent = '✓ ' + fname;
        statusEl.style.color = 'var(--green)';
      }
      const dropZone = document.getElementById('resume-drop-zone');
      const dropIcon = document.getElementById('resume-drop-icon');
      const dropText = document.getElementById('resume-drop-text');
      if (dropZone) dropZone.classList.add('uploaded');
      if (dropIcon) dropIcon.textContent = '✓';
      if (dropText) dropText.innerHTML = '<div class="resume-drop-title" style="color:var(--green)">' + fname + '</div><div class="resume-drop-hint">Resume loaded — drop a new file to replace</div>';
    }
  } catch (e) {}
}
checkResumeStatus();

// ═══════════════════════════════════════════════════
// INTERVIEW TRANSCRIPT UPLOAD & STYLE PROFILE
// ═══════════════════════════════════════════════════

async function uploadTranscripts(files) {
  if (!files || files.length === 0) return;
  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file);
  }
  formData.append('section', 'transcripts');

  const dropIcon = document.getElementById('transcripts-drop-icon');
  const dropText = document.getElementById('transcripts-drop-text');
  if (dropText) dropText.innerHTML = '<div class="resume-drop-title">Uploading ' + files.length + ' file' + (files.length > 1 ? 's' : '') + '...</div>';

  try {
    const res = await fetch('/api/playbook/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.uploaded && data.uploaded.length > 0) {
      refreshTranscriptStatus();
      // Auto-generate style profile after upload
      generateStyleProfile();
    } else {
      if (dropText) dropText.innerHTML = '<div class="resume-drop-title" style="color:var(--red)">Upload failed</div><div class="resume-drop-hint">Try again</div>';
    }
  } catch (error) {
    console.error('Transcript upload failed:', error);
    if (dropText) dropText.innerHTML = '<div class="resume-drop-title" style="color:var(--red)">Upload failed</div><div class="resume-drop-hint">Try again</div>';
  }
}

async function refreshTranscriptStatus() {
  try {
    const res = await fetch('/api/style-profile');
    const data = await res.json();
    const count = data.transcriptCount || 0;
    const dropZone = document.getElementById('transcripts-drop-zone');
    const dropIcon = document.getElementById('transcripts-drop-icon');
    const dropText = document.getElementById('transcripts-drop-text');
    const fileList = document.getElementById('transcripts-file-list');

    if (count > 0) {
      if (dropZone) { dropZone.classList.add('uploaded'); dropZone.style.borderColor = 'var(--purple)'; }
      if (dropIcon) dropIcon.textContent = '🎙️';
      if (dropText) dropText.innerHTML = '<div class="resume-drop-title" style="color:var(--purple)">' + count + ' transcript' + (count > 1 ? 's' : '') + ' loaded</div><div class="resume-drop-hint">Drop more to add — the AI will re-analyze your style</div>';

      // Show file list
      if (fileList && data.files) {
        fileList.style.display = 'block';
        fileList.innerHTML = data.files.map(f =>
          '<div class="transcripts-file-item"><span class="tfn">' + escapeHtml(f.name) + '</span><span class="tfr" onclick="removeTranscript(\'' + f.id + '\')">✕</span></div>'
        ).join('');
      }
    }
  } catch (e) {}
}

async function removeTranscript(fileId) {
  try {
    await fetch('/api/playbook/' + fileId, { method: 'DELETE' });
    refreshTranscriptStatus();
    // Re-generate profile if transcripts remain
    const res = await fetch('/api/style-profile');
    const data = await res.json();
    if (data.transcriptCount > 0) {
      generateStyleProfile();
    } else {
      document.getElementById('style-profile').style.display = 'none';
      const dropZone = document.getElementById('transcripts-drop-zone');
      const dropText = document.getElementById('transcripts-drop-text');
      if (dropZone) { dropZone.classList.remove('uploaded'); dropZone.style.borderColor = 'rgba(139,92,246,0.35)'; }
      if (dropText) dropText.innerHTML = '<div class="resume-drop-title">Drop past interview transcripts here</div><div class="resume-drop-hint">Upload your real interviews so the AI learns how you naturally speak — multiple files OK</div>';
      document.getElementById('transcripts-file-list').style.display = 'none';
    }
  } catch (e) { console.error('Remove transcript failed:', e); }
}

async function generateStyleProfile() {
  const profileEl = document.getElementById('style-profile');
  const bodyEl = document.getElementById('style-profile-body');
  if (!profileEl || !bodyEl) return;

  profileEl.style.display = 'block';
  bodyEl.innerHTML = '<div style="color:var(--text-muted);padding:8px 0">Analyzing your interview transcripts...</div>';

  try {
    const res = await fetch('/api/style-profile/generate', { method: 'POST' });
    const data = await res.json();
    if (data.profile) {
      bodyEl.textContent = data.profile;
    } else {
      bodyEl.innerHTML = '<div style="color:var(--red)">' + (data.error || 'Failed to generate profile') + '</div>';
    }
  } catch (error) {
    console.error('Style profile generation failed:', error);
    bodyEl.innerHTML = '<div style="color:var(--red)">Failed to generate profile. Try again.</div>';
  }
}

function regenerateStyleProfile() {
  generateStyleProfile();
}

// Drag and drop for transcripts zone
document.addEventListener('DOMContentLoaded', () => {
  const zone = document.getElementById('transcripts-drop-zone');
  if (!zone) return;
  zone.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.remove('drag-over'); });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) uploadTranscripts(e.dataTransfer.files);
  });
});

// Load transcript status on page load
refreshTranscriptStatus();

// ═══════════════════════════════════════════════════
// QUICK ANSWERS (Pre-loaded Q&A pairs)
// ═══════════════════════════════════════════════════

async function loadQuickAnswers() {
  try {
    const res = await fetch('/api/quick-answers');
    const data = await res.json();
    const list = document.getElementById('qa-list');
    const count = document.getElementById('qa-count');
    if (!list) return;

    const answers = data.answers || [];
    count.textContent = answers.length + ' pair' + (answers.length !== 1 ? 's' : '') + ' loaded';

    if (answers.length === 0) {
      list.innerHTML = '<div style="padding:16px 18px;font-size:12px;color:var(--text-muted)">No quick answers yet. Click "+ Add Q&A" to pre-load your answers to common questions.</div>';
      return;
    }

    list.innerHTML = answers.map((qa, i) =>
      '<div class="qa-item">' +
        '<div class="qa-item-q">Q: ' + escapeHtml(qa.question) + '</div>' +
        '<div class="qa-item-a">' + escapeHtml(qa.answer).slice(0, 150) + (qa.answer.length > 150 ? '...' : '') + '</div>' +
      '</div>'
    ).join('');
  } catch (e) {
    console.error('Failed to load quick answers:', e);
  }
}

function showAddQAModal() {
  document.getElementById('qa-modal').classList.remove('hidden');
  document.getElementById('qa-question-input').value = '';
  document.getElementById('qa-answer-input').value = '';
  document.getElementById('qa-question-input').focus();
}

function closeQAModal() {
  document.getElementById('qa-modal').classList.add('hidden');
}

async function saveQAPair() {
  const q = document.getElementById('qa-question-input').value.trim();
  const a = document.getElementById('qa-answer-input').value.trim();
  if (!q || !a) return alert('Both question and answer are required.');

  try {
    const res = await fetch('/api/quick-answers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairs: [{ question: q, answer: a }] })
    });
    const data = await res.json();
    if (data.success) {
      closeQAModal();
      loadQuickAnswers();
    } else {
      alert('Save failed: ' + (data.error || 'Unknown error'));
    }
  } catch (e) {
    alert('Save failed: ' + e.message);
  }
}

// Load on page init
loadQuickAnswers();

// Upload Q&A doc file
async function uploadQAFile(files) {
  if (!files || files.length === 0) return;
  const formData = new FormData();
  formData.append('file', files[0]);

  const dropText = document.getElementById('qa-drop-text');
  const dropIcon = document.getElementById('qa-drop-icon');
  const dropZone = document.getElementById('qa-drop-zone');
  if (dropText) dropText.innerHTML = '<div class="resume-drop-title">Parsing Q&A pairs...</div>';

  try {
    const res = await fetch('/api/quick-answers/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.success) {
      if (dropZone) { dropZone.classList.add('uploaded'); dropZone.style.borderColor = 'var(--orange)'; }
      if (dropIcon) dropIcon.textContent = '✓';
      if (dropText) dropText.innerHTML = '<div class="resume-drop-title" style="color:var(--orange)">' + data.count + ' Q&A pairs loaded from ' + files[0].name + '</div><div class="resume-drop-hint">Drop a new file to replace</div>';
      loadQuickAnswers();
    } else {
      if (dropText) dropText.innerHTML = '<div class="resume-drop-title" style="color:var(--red)">' + (data.error || 'Parse failed') + '</div><div class="resume-drop-hint">Make sure questions start with "Q:"</div>';
    }
  } catch (e) {
    if (dropText) dropText.innerHTML = '<div class="resume-drop-title" style="color:var(--red)">Upload failed</div>';
  }
}

// Drag and drop for QA zone
document.addEventListener('DOMContentLoaded', () => {
  const zone = document.getElementById('qa-drop-zone');
  if (!zone) return;
  zone.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.remove('drag-over'); });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) uploadQAFile(e.dataTransfer.files);
  });
});

// ═══════════════════════════════════════════════════
// PREP HUB — AUTO GENERATE DOCS
// ═══════════════════════════════════════════════════

const SECTION_LABELS = {
  'QUICK_ANSWERS': { icon: '⚡', name: 'Quick Answers', desc: 'Pre-loaded Q&A pairs for instant matching' },
  'COMPANY_RESEARCH': { icon: '🏢', name: 'Company Research', desc: 'Business model, ICP, GTM motion' },
  'ROLE_DETAILS': { icon: '📋', name: 'Role Details', desc: 'Quota, org structure, sales motion' },
  'INDUSTRY_KNOWLEDGE': { icon: '🌐', name: 'Industry & Competition', desc: 'Market landscape, competitors, trends' },
  'TOUGH_QUESTIONS': { icon: '🛡️', name: 'Tough Question Prep', desc: 'Deal complexity, objections, stall patterns' },
  'INTERVIEW_FRAMEWORK': { icon: '🔍', name: 'Interview Framework', desc: '30-60-90, deal story alignment' },
  'PRACTICE_ANSWERS': { icon: '🎙️', name: 'Practice Answers', desc: 'Positioning, strategic questions, concerns' },
  'COMPANY_NEWS': { icon: '📰', name: 'Company News & Culture', desc: 'Cheat sheet, talking points, red flags' },
  'ACHIEVEMENT_STORIES': { icon: '🏆', name: 'Achievement Stories', desc: 'Mapped deal stories with proof points' }
};

async function generatePrepDocs() {
  const company = document.getElementById('gen-company').value.trim();
  const role = document.getElementById('gen-role').value.trim();
  if (!company || !role) return alert('Company and Role are required.');

  const btn = document.getElementById('gen-btn');
  const status = document.getElementById('gen-status');
  btn.disabled = true;
  btn.innerHTML = '<span class="gen-spinner"></span> Generating...';
  
  // Animated progress messages
  const messages = [
    'Researching ' + company + '...',
    'Analyzing job description...',
    'Building company research...',
    'Mapping your experience to the role...',
    'Writing scripted answers...',
    'Generating quick Q&A pairs...',
    'Building competitive intel...',
    'Creating interview framework...',
    'Finalizing prep docs...'
  ];
  let msgIdx = 0;
  status.textContent = messages[0];
  const msgTimer = setInterval(() => {
    msgIdx = (msgIdx + 1) % messages.length;
    status.textContent = messages[msgIdx];
  }, 5000);

  try {
    const res = await fetch('/api/generate-prep', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company,
        industry: document.getElementById('gen-industry').value.trim(),
        role,
        territory: document.getElementById('gen-territory').value,
        stage: document.getElementById('gen-stage').value,
        interviewers: document.getElementById('gen-interviewers').value.trim(),
        jd: document.getElementById('gen-jd').value.trim()
      })
    });

    const data = await res.json();
    if (!data.success) {
      alert('Generation failed: ' + (data.error || 'Unknown error'));
      return;
    }

    // Render results
    const resultsDiv = document.getElementById('prep-gen-results');
    const sectionsDiv = document.getElementById('prep-gen-sections');
    resultsDiv.classList.remove('hidden');
    sectionsDiv.innerHTML = '';

    const sectionOrder = ['QUICK_ANSWERS', 'COMPANY_RESEARCH', 'ROLE_DETAILS', 'INDUSTRY_KNOWLEDGE', 'TOUGH_QUESTIONS', 'INTERVIEW_FRAMEWORK', 'PRACTICE_ANSWERS', 'COMPANY_NEWS', 'ACHIEVEMENT_STORIES'];

    for (const secId of sectionOrder) {
      const content = data.sections[secId];
      if (!content) continue;
      const label = SECTION_LABELS[secId] || { icon: '📄', name: secId, desc: '' };

      const div = document.createElement('div');
      div.className = 'prep-gen-section';
      div.id = 'gen-sec-' + secId;
      div.innerHTML = `
        <div class="prep-gen-section-header" onclick="this.nextElementSibling.classList.toggle('open')">
          <span class="prep-gen-section-title">${label.icon} ${label.name}</span>
          <div class="prep-gen-section-actions">
            <button class="btn-sm" onclick="event.stopPropagation();approveSection('${secId}','${company}')" style="color:var(--green);border-color:var(--green)">✓ Approve</button>
          </div>
        </div>
        <div class="prep-gen-section-body open">${escapeHtml(content)}</div>
      `;
      sectionsDiv.appendChild(div);
    }

    status.textContent = Object.keys(data.sections).length + ' sections generated. Auto-approving...';
    
    // Auto-approve all sections
    for (const secId of sectionOrder) {
      if (data.sections[secId]) {
        await approveSection(secId, company);
      }
    }
    status.textContent = '✓ All sections approved and loaded. Ready for your interview!';
  } catch (e) {
    alert('Generation failed: ' + e.message);
    status.textContent = 'Failed. Try again.';
  } finally {
    clearInterval(msgTimer);
    btn.disabled = false;
    btn.innerHTML = '⚡ Generate Prep Docs';
  }
}

async function approveSection(sectionId, company) {
  const div = document.getElementById('gen-sec-' + sectionId);
  const body = div.querySelector('.prep-gen-section-body');
  const content = body.textContent;

  try {
    const res = await fetch('/api/generate-prep/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sectionId, content, company })
    });
    const data = await res.json();
    if (data.success) {
      div.classList.add('approved');
      const btn = div.querySelector('.prep-gen-section-actions button');
      btn.textContent = '✓ Approved';
      btn.disabled = true;
      btn.style.background = 'rgba(16,185,129,0.15)';
    } else {
      alert('Approve failed: ' + (data.error || 'Unknown'));
    }
  } catch (e) {
    alert('Approve failed: ' + e.message);
  }
}

async function approveAllSections() {
  const sections = document.querySelectorAll('.prep-gen-section:not(.approved)');
  const company = document.getElementById('gen-company').value.trim();
  for (const sec of sections) {
    const secId = sec.id.replace('gen-sec-', '');
    await approveSection(secId, company);
  }
}

// ═══════════════════════════════════════════════════
// CLEAR ALL PREP DOCS (New Interview Reset)
// ═══════════════════════════════════════════════════

async function clearAllPrepDocs() {
  if (!confirm('Clear all prep docs, quick answers, and transcripts for a new interview?\n\nYour resume will be kept.')) return;
  
  try {
    const res = await fetch('/api/playbook?keepResume=true', { method: 'DELETE' });
    const data = await res.json();
    
    // Reset UI elements
    const dropZone = document.getElementById('transcripts-drop-zone');
    const dropText = document.getElementById('transcripts-drop-text');
    if (dropZone) { dropZone.classList.remove('uploaded'); dropZone.style.borderColor = 'rgba(139,92,246,0.35)'; }
    if (dropText) dropText.innerHTML = '<div class="resume-drop-title">Drop past interview transcripts here</div><div class="resume-drop-hint">Upload your real interviews so the AI learns how you naturally speak — multiple files OK</div>';
    
    const qaZone = document.getElementById('qa-drop-zone');
    const qaText = document.getElementById('qa-drop-text');
    const qaIcon = document.getElementById('qa-drop-icon');
    if (qaZone) { qaZone.classList.remove('uploaded'); qaZone.style.borderColor = 'rgba(249,115,22,0.35)'; }
    if (qaText) qaText.innerHTML = '<div class="resume-drop-title">Drop your Q&A prep doc here</div><div class="resume-drop-hint">Format questions with "Q:" — DOCX, PDF, TXT, MD</div>';
    if (qaIcon) qaIcon.textContent = '⚡';
    
    document.getElementById('style-profile').style.display = 'none';
    document.getElementById('transcripts-file-list').style.display = 'none';
    
    // Reload everything
    loadQuickAnswers();
    refreshTranscriptStatus();
    loadPlaybookFiles();
    
    alert('Cleared ' + data.removed + ' docs. Resume kept. Ready for a new interview!');
  } catch (e) {
    alert('Clear failed: ' + e.message);
  }
}

// ═══════════════════════════════════════════════════
// CALL HISTORY
// ═══════════════════════════════════════════════════

async function loadCallHistory() {
  try {
    const res = await fetch('/api/calls');
    const data = await res.json();
    renderCallHistory(data.calls);
    renderHistoryStats(data.stats);
  } catch (error) {
    console.error('Failed to load history:', error);
  }
}

function renderCallHistory(calls) {
  const list = document.getElementById('call-list');
  if (calls.length === 0) {
    list.innerHTML = '<p style="color: var(--text-muted); font-size: 13px; padding: 20px 0; text-align: center;">No calls recorded yet.</p>';
    return;
  }

  list.innerHTML = calls.map(c => {
    const date = new Date(c.started_at).toLocaleString();
    const duration = c.duration_seconds
      ? `${Math.floor(c.duration_seconds / 60)}:${(c.duration_seconds % 60).toString().padStart(2, '0')}`
      : '—';
    const displayName = c.call_name || (c.prospect_name || c.prospect_company || 'Unknown') + (c.prospect_company && c.prospect_name ? ' · ' + c.prospect_company : '');

    return `
      <div class="call-item" onclick="viewCallDetail('${c.id}')">
        <div class="call-item-left">
          <div class="call-item-prospect">${escapeHtml(displayName)}</div>
          <div class="call-item-date">${date}</div>
        </div>
        <div class="call-item-right">
          <span class="call-item-duration">${duration}</span>
        </div>
      </div>
    `;
  }).join('');
}

function renderHistoryStats(stats) {
  document.getElementById('history-stats').innerHTML = `
    <div><span class="stat-value">${stats.totalCalls}</span> Total calls</div>
    <div><span class="stat-value">${stats.callsThisWeek}</span> This week</div>
  `;
}

async function searchCalls(query) {
  if (query.length < 2) { loadCallHistory(); return; }
  try {
    const res = await fetch(`/api/calls/search/${encodeURIComponent(query)}`);
    const data = await res.json();
    renderCallHistory(data.calls);
  } catch (error) {
    console.error('Search failed:', error);
  }
}

async function viewCallDetail(callId) {
  try {
    const res = await fetch(`/api/calls/${callId}`);
    const call = await res.json();

    // Load deals for assignment dropdown
    let dealsOptions = '<option value="">Assign to position...</option>';
    try {
      const dRes = await fetch('/api/deals');
      const dData = await dRes.json();
      (dData.deals || []).forEach(d => {
        const selected = call.deal_id === d.id ? ' selected' : '';
        dealsOptions += `<option value="${d.id}"${selected}>${escapeHtml(d.company_name)}</option>`;
      });
    } catch(e) {}

    const date = new Date(call.started_at).toLocaleString();
    const duration = call.duration_seconds
      ? `${Math.floor(call.duration_seconds / 60)}m ${call.duration_seconds % 60}s`
      : 'Unknown';

    document.getElementById('call-detail-body').innerHTML = `
      <h2>${escapeHtml(call.prospect_name || 'Unknown')} ${call.prospect_company ? '· ' + escapeHtml(call.prospect_company) : ''}</h2>
      <div class="detail-meta">${date} · ${duration}</div>

      <div style="margin:12px 0;display:flex;align-items:center;gap:10px">
        <label style="font-size:12px;color:var(--text-muted);font-weight:600">Deal:</label>
        <select id="call-deal-assign" onchange="assignCallToDeal('${callId}',this.value)" style="background:var(--bg-panel);border:1px solid var(--border);border-radius:var(--radius-sm);padding:5px 8px;font-family:var(--font);font-size:13px;color:var(--text-primary)">
          ${dealsOptions}
        </select>
        <span id="assign-status" style="font-size:11px;color:var(--green)"></span>
      </div>

      ${call.recording_url ? `
        <div class="detail-section">
          <h3>Recording</h3>
          <video controls style="width:100%;border-radius:var(--radius);max-height:300px;background:#000" src="${escapeHtml(call.recording_url)}"></video>
        </div>
      ` : ''}

      ${call.summary ? `
        <div class="detail-section">
          <h3>Summary</h3>
          <pre>${escapeHtml(call.summary)}</pre>
        </div>
      ` : ''}

      <div class="detail-section">
        <h3>Interview Scorecard</h3>
        <pre>${JSON.stringify(call.scorecard, null, 2)}</pre>
      </div>

      <div class="detail-section">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3>Transcript</h3>
          <button class="btn-sm" onclick="navigator.clipboard.writeText(document.getElementById('history-transcript').textContent).then(()=>{this.textContent='✓ Copied';setTimeout(()=>{this.textContent='📋 Copy'},2000)})" style="font-size:11px">📋 Copy</button>
        </div>
        <pre id="history-transcript">${escapeHtml(call.transcript || 'No transcript available')}</pre>
      </div>
    `;

    document.getElementById('call-detail-modal').classList.remove('hidden');
  } catch (error) {
    console.error('Failed to load call detail:', error);
  }
}

async function assignCallToDeal(callId, dealId) {
  const statusEl = document.getElementById('assign-status');
  if (!dealId) {
    statusEl.textContent = '';
    return;
  }
  statusEl.textContent = 'Assigning...';
  try {
    const res = await fetch('/api/calls/' + callId + '/assign-deal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deal_id: dealId })
    });
    const data = await res.json();
    if (data.success) {
      statusEl.textContent = '✓ Assigned & intel merged';
      statusEl.style.color = 'var(--green)';
    } else {
      statusEl.textContent = 'Failed';
      statusEl.style.color = 'var(--accent)';
    }
  } catch(e) {
    statusEl.textContent = 'Error';
    statusEl.style.color = 'var(--accent)';
  }
}

function closeCallDetail() {
  document.getElementById('call-detail-modal').classList.add('hidden');
}

// ═══════════════════════════════════════════════════
// SUMMARY MODAL
// ═══════════════════════════════════════════════════

function showSummary(msg) {
  document.getElementById('summary-body').innerHTML = `
    <h2>Call Summary</h2>
    <pre>${escapeHtml(msg.summary)}</pre>
  `;
  document.getElementById('summary-modal').classList.remove('hidden');
}

function closeSummary() {
  document.getElementById('summary-modal').classList.add('hidden');
}

// ═══════════════════════════════════════════════════
// RIGHT PANEL TABS (Feature 2/3)
// ═══════════════════════════════════════════════════

function switchRightTab(tab) {
  document.querySelectorAll('.rp-tab').forEach(t => t.classList.toggle('active', t.dataset.rp === tab));
  document.querySelectorAll('.rp-content').forEach(c => c.classList.toggle('active', c.id === 'rp-' + tab));
}

// ═══════════════════════════════════════════════════
// DEAL BRIEF (Feature 3)
// ═══════════════════════════════════════════════════

function onDealBrief(brief) {
  if (!brief) return;
  const body = document.getElementById('deal-brief-body');

  let html = '';

  // Mission
  if (brief.mission) {
    html += '<div class="brief-section"><div class="brief-section-label">Today\'s Mission</div>' +
      '<div class="brief-mission">' + escapeHtml(brief.mission) + '</div></div>';
  }

  // Probing areas
  if (brief.probing_areas && brief.probing_areas.length) {
    html += '<div class="brief-section"><div class="brief-section-label">Probing Areas</div><ul class="brief-list">';
    brief.probing_areas.forEach(a => { html += '<li>' + escapeHtml(a) + '</li>'; });
    html += '</ul></div>';
  }

  // Pain points
  if (brief.pain_points && brief.pain_points.length) {
    html += '<div class="brief-section"><div class="brief-section-label">Key Strengths</div>';
    brief.pain_points.forEach(p => {
      const dotClass = p.status === 'confirmed' ? 'pain-confirmed' : p.status === 'inferred' ? 'pain-inferred' : 'pain-mentioned';
      html += '<div style="font-size:12px;padding:2px 0"><span class="brief-pain-dot ' + dotClass + '"></span>' +
        escapeHtml(p.text) + ' <span style="color:var(--text-muted);font-size:10px">(' + (p.status || 'mentioned') + ')</span></div>';
    });
    html += '</div>';
  }

  // Suggested probes
  if (brief.suggested_probes && brief.suggested_probes.length) {
    html += '<div class="brief-section"><div class="brief-section-label">Suggested Probes</div>';
    brief.suggested_probes.forEach(q => { html += '<div class="brief-probe">"' + escapeHtml(q) + '"</div>'; });
    html += '</div>';
  }

  // Key risks
  if (brief.key_risks && brief.key_risks.length) {
    html += '<div class="brief-section"><div class="brief-section-label">Key Risks</div>';
    brief.key_risks.forEach(r => { html += '<div class="brief-risk">⚠ ' + escapeHtml(r) + '</div>'; });
    html += '</div>';
  }

  // Last recap
  if (brief.last_recap) {
    html += '<div class="brief-section"><div class="brief-section-label">Last Interaction</div>' +
      '<div style="font-size:12px;color:var(--text-secondary)">' + escapeHtml(brief.last_recap) + '</div></div>';
  }

  body.innerHTML = html || '<p class="meddpicc-empty">No briefing data available.</p>';

  // Auto-switch to brief tab when it arrives
  switchRightTab('brief');
}

// ═══════════════════════════════════════════════════
// HEALTH WIDGET (Feature 5)
// ═══════════════════════════════════════════════════

function showHealthWidget(score) {
  const widget = document.getElementById('deal-health-widget');
  const scoreEl = document.getElementById('health-widget-score');
  widget.classList.remove('hidden');

  scoreEl.textContent = score;
  const color = score >= 60 ? 'var(--green)' : score >= 30 ? 'var(--yellow)' : 'var(--accent)';
  scoreEl.style.borderColor = color;
  scoreEl.style.color = color;

  if (score < 30) {
    widget.classList.add('health-widget-pulse');
  } else {
    widget.classList.remove('health-widget-pulse');
  }
}

function hideHealthWidget() {
  document.getElementById('deal-health-widget').classList.add('hidden');
}

// ═══════════════════════════════════════════════════
// WAR ROOM (Feature 4)
// ═══════════════════════════════════════════════════

let activeWarRoomDealId = null;
let activeWarRoomDeal = null;

function switchWrTab(tab) {
  document.querySelectorAll('.wr-tab').forEach(t => t.classList.toggle('active', t.dataset.wt === tab));
  document.querySelectorAll('.wr-panel').forEach(p => p.classList.toggle('active', p.id === 'wr-' + tab));
}

async function loadWarRoom(dealId) {
  if (!dealId) {
    document.getElementById('warroom-picker').classList.remove('hidden');
    document.getElementById('warroom-dashboard').classList.add('hidden');
    // Show deal list for picking
    const res = await fetch('/api/deals');
    const data = await res.json();
    document.getElementById('warroom-deal-list').innerHTML = (data.deals || []).map(d => {
      const health = d.health_score || 0;
      const hClass = health >= 60 ? 'deal-health-green' : health >= 30 ? 'deal-health-yellow' : 'deal-health-red';
      return '<div class="deal-card" onclick="loadWarRoom(\'' + d.id + '\')">' +
        '<div class="deal-card-health ' + hClass + '">' + health + '</div>' +
        '<div class="deal-card-info"><div class="deal-card-name">' + escapeHtml(d.company_name) + '</div>' +
        '<div class="deal-card-meta"><span>' + (d.stage || '—') + '</span></div></div>' +
        '<span class="deal-stage-badge stage-' + (d.stage || 'applied') + '">' + (d.stage || '—').replace('_', ' ') + '</span></div>';
    }).join('') || '<p style="color:var(--text-muted);text-align:center;padding:40px">No positions yet. Create one from the Deals tab.</p>';
    return;
  }

  activeWarRoomDealId = dealId;
  try {
    const res = await fetch('/api/deals/' + dealId);
    activeWarRoomDeal = await res.json();
    document.getElementById('warroom-picker').classList.add('hidden');
    document.getElementById('warroom-dashboard').classList.remove('hidden');
    renderWrHeader(activeWarRoomDeal);
    renderWrOverview(activeWarRoomDeal);
    renderWrMeddpicc(activeWarRoomDeal);
    renderWrPain(activeWarRoomDeal);
    renderWrContacts(activeWarRoomDeal);
    renderWrCompetitive(activeWarRoomDeal);
    renderWrTimeline(activeWarRoomDeal);
    renderWrForecast(activeWarRoomDeal);
    renderDealSuggestions(activeWarRoomDeal);
    // Clear previous chat messages
    document.getElementById('wr-chat-messages').innerHTML = '';
    switchWrTab('overview');
  } catch (e) { console.error('Prep Hub load failed:', e); }
}

function renderWrHeader(deal) {
  const health = deal.health_score || 0;
  const hClass = health >= 60 ? 'deal-health-green' : health >= 30 ? 'deal-health-yellow' : 'deal-health-red';
  const value = deal.deal_value ? '$' + deal.deal_value.toLocaleString() : '—';
  const days = deal.updated_at ? Math.round((Date.now() - new Date(deal.created_at).getTime()) / 86400000) : 0;

  document.getElementById('wr-header').innerHTML =
    '<button class="wr-back-btn" onclick="loadWarRoom(null)">← Back to deals</button>' +
    '<div style="display:flex;align-items:center;gap:16px;width:100%">' +
      '<div class="wr-header-health ' + hClass + '">' + health + '</div>' +
      '<div class="wr-header-info">' +
        '<div class="wr-header-name">' + escapeHtml(deal.company_name) + '</div>' +
        '<div class="wr-header-meta">' +
          '<span>' + value + '</span>' +
          '<span>' + (deal.vehicle_count || '—') + ' vehicles</span>' +
          '<span class="deal-stage-badge stage-' + (deal.stage || 'applied') + '">' + (deal.stage || '—').replace('_', ' ') + '</span>' +
          '<span>' + days + ' days in pipeline</span>' +
          '<span>' + (deal.calls || []).length + ' calls</span>' +
        '</div>' +
      '</div>' +
      '<div class="wr-header-actions">' +
        '<button class="btn-sm" onclick="showCreateDealModal(' + JSON.stringify({id:deal.id,company_name:deal.company_name,deal_value:deal.deal_value,stage:deal.stage,vehicle_count:deal.vehicle_count,notes:deal.notes}).replace(/"/g, '&quot;') + ')">Edit</button>' +
      '</div>' +
    '</div>';
}

function renderWrOverview(deal) {
  const mData = deal.meddpicc_data || {};
  const pains = deal.pain_points || [];
  const stakes = deal.stakeholders || [];
  const calls = deal.calls || [];
  const health = deal.health_score || 0;

  // Scorecard summary
  let totalFilled = 0, totalFields = 0;
  const fieldNames = { situation_context: 'S', actions_taken: 'A', results_impact: 'R', skills_demonstrated: 'S', company_knowledge: 'C', questions_asked: 'Q', red_flags: '!' };
  for (const [f, subs] of Object.entries(mData)) {
    const vals = Object.values(subs || {});
    totalFields += vals.length;
    totalFilled += vals.filter(v => v).length;
  }
  const mPct = totalFields ? Math.round((totalFilled / totalFields) * 100) : 0;

  document.getElementById('wr-overview').innerHTML =
    '<div class="wr-grid-3">' +
      '<div class="wr-stat"><div class="wr-stat-value" style="color:' + (health >= 60 ? 'var(--green)' : health >= 30 ? 'var(--yellow)' : 'var(--accent)') + '">' + health + '</div><div class="wr-stat-label">Health Score</div></div>' +
      '<div class="wr-stat"><div class="wr-stat-value">' + mPct + '%</div><div class="wr-stat-label">Scorecard Coverage</div></div>' +
      '<div class="wr-stat"><div class="wr-stat-value">' + calls.length + '</div><div class="wr-stat-label">Calls Recorded</div></div>' +
    '</div>' +
    '<div class="wr-grid" style="margin-top:12px">' +
      '<div class="wr-card"><div class="wr-card-title">Top Key Strengths</div>' +
        (pains.length ? pains.slice(0, 3).map(p => '<div style="font-size:12px;padding:4px 0"><span class="brief-pain-dot ' + (p.status === 'confirmed' || p.status === 'quantified' ? 'pain-confirmed' : p.status === 'inferred' ? 'pain-inferred' : 'pain-mentioned') + '"></span>' + escapeHtml(p.text) + '</div>').join('') : '<p style="color:var(--text-muted);font-size:12px">None captured</p>') +
      '</div>' +
      '<div class="wr-card"><div class="wr-card-title">Key Contacts</div>' +
        (stakes.length ? stakes.slice(0, 3).map(s => '<div style="font-size:12px;padding:4px 0"><strong>' + escapeHtml(s.name) + '</strong> <span style="color:var(--text-muted)">(' + (s.role || '?') + ')</span> <span class="wr-sentiment-badge sentiment-' + (s.sentiment || 'unknown') + '">' + (s.sentiment || '?') + '</span></div>').join('') : '<p style="color:var(--text-muted);font-size:12px">None identified</p>') +
      '</div>' +
    '</div>' +
    (deal.notes ? '<div class="wr-card" style="margin-top:12px"><div class="wr-card-title">Notes</div><div style="font-size:13px;color:var(--text-secondary);white-space:pre-wrap">' + escapeHtml(deal.notes) + '</div></div>' : '');
}

function renderWrMeddpicc(deal) {
  const mData = deal.meddpicc_data || {};
  const fields = { situation_context: 'Situation', actions_taken: 'Actions', results_impact: 'Results', skills_demonstrated: 'Skills', company_knowledge: 'Company Knowledge', questions_asked: 'Questions Asked', red_flags: 'Red Flags' };

  let html = '';
  for (const [field, label] of Object.entries(fields)) {
    const subs = mData[field] || {};
    const entries = Object.entries(subs);
    const filled = entries.filter(([k, v]) => v).length;
    const total = entries.length || 1;
    const pct = Math.round((filled / total) * 100);
    const color = pct >= 80 ? 'var(--green)' : pct >= 40 ? 'var(--yellow)' : 'var(--accent)';

    html += '<div class="wr-card">' +
      '<div class="wr-progress-row">' +
        '<div class="wr-progress-label">' + label + '</div>' +
        '<div class="wr-progress-bar"><div class="wr-progress-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
        '<div class="wr-progress-pct" style="color:' + color + '">' + pct + '%</div>' +
      '</div>';

    entries.forEach(([sub, val]) => {
      if (val) {
        html += '<p class="wr-evidence">' + escapeHtml(val) + '</p>';
      } else {
        html += '<p class="wr-gap">' + sub.replace(/_/g, ' ') + ' — not yet captured</p>';
      }
    });

    html += '</div>';
  }
  document.getElementById('wr-meddpicc').innerHTML = html;
}

function renderWrPain(deal) {
  const pains = deal.pain_points || [];
  if (!pains.length) {
    document.getElementById('wr-pain').innerHTML = '<div class="wr-card"><p style="color:var(--text-muted);font-size:13px">No key strengths captured yet. Start a call linked to this deal.</p></div>';
    return;
  }
  document.getElementById('wr-pain').innerHTML = pains.map(p => {
    const dotClass = p.status === 'confirmed' || p.status === 'quantified' ? 'pain-confirmed' : p.status === 'inferred' ? 'pain-inferred' : 'pain-mentioned';
    const statusLabel = p.status === 'confirmed' ? 'Confirmed' : p.status === 'quantified' ? 'Quantified' : p.status === 'inferred' ? 'AI Inferred' : 'Mentioned';
    return '<div class="wr-card">' +
      '<div style="display:flex;justify-content:space-between;align-items:start">' +
        '<div style="font-size:14px;font-weight:600"><span class="brief-pain-dot ' + dotClass + '"></span>' + escapeHtml(p.text) + '</div>' +
        '<span class="deal-stage-badge" style="background:rgba(233,69,96,0.1);color:var(--accent)">' + statusLabel + '</span>' +
      '</div>' +
      '<div style="font-size:11px;color:var(--text-muted);margin-top:6px">' +
        (p.speaker ? 'Mentioned by: ' + escapeHtml(p.speaker) + ' · ' : '') +
        (p.discovered_at ? 'Discovered: ' + new Date(p.discovered_at).toLocaleDateString() : '') +
      '</div>' +
    '</div>';
  }).join('');
}

function renderWrContacts(deal) {
  const stakes = deal.stakeholders || [];
  if (!stakes.length) {
    document.getElementById('wr-stakeholders').innerHTML = '<div class="wr-card"><p style="color:var(--text-muted);font-size:13px">No stakeholders identified yet.</p></div>';
    return;
  }
  document.getElementById('wr-stakeholders').innerHTML = '<div class="wr-card">' +
    stakes.map(s => {
      const initials = (s.name || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
      const influence = '●'.repeat(s.influence || 1) + '○'.repeat(5 - (s.influence || 1));
      return '<div class="wr-stakeholder-row">' +
        '<div class="wr-stakeholder-avatar">' + initials + '</div>' +
        '<div class="wr-stakeholder-info">' +
          '<div class="wr-stakeholder-name">' + escapeHtml(s.name) + '</div>' +
          '<div class="wr-stakeholder-role">' + escapeHtml(s.role || 'Unknown') + ' · Influence: ' + influence + '</div>' +
        '</div>' +
        '<span class="wr-sentiment-badge sentiment-' + (s.sentiment || 'unknown') + '">' + (s.sentiment || 'Unknown') + '</span>' +
        '<div style="font-size:10px;color:var(--text-muted);text-align:right;min-width:60px">' + (s.interactions || 0) + ' calls' +
          (s.last_interaction ? '<br>' + new Date(s.last_interaction).toLocaleDateString() : '') + '</div>' +
      '</div>';
    }).join('') +
  '</div>';
}

function renderWrCompetitive(deal) {
  const comp = deal.competitive_intel || {};
  let html = '<div class="wr-card"><div class="wr-card-title">Known Competitors</div>';
  if (comp.competitors && comp.competitors.length) {
    html += '<div style="display:flex;flex-wrap:wrap;gap:6px">' +
      comp.competitors.map(c => '<span style="background:rgba(233,69,96,0.1);color:var(--accent);padding:4px 12px;border-radius:12px;font-size:13px;font-weight:600">' + escapeHtml(c) + '</span>').join('') + '</div>';
  } else {
    html += '<p style="color:var(--text-muted);font-size:12px">No competitors identified yet</p>';
  }
  html += '</div>';

  if (comp.contract_details) {
    html += '<div class="wr-card"><div class="wr-card-title">Contract Details</div><div style="font-size:13px;color:var(--text-secondary)">' + escapeHtml(comp.contract_details) + '</div></div>';
  }
  if (comp.positioning) {
    html += '<div class="wr-card"><div class="wr-card-title">Positioning</div><div style="font-size:13px;color:var(--text-secondary);white-space:pre-wrap">' + escapeHtml(JSON.stringify(comp.positioning, null, 2)) + '</div></div>';
  }

  document.getElementById('wr-competitive').innerHTML = html;
}

function renderWrTimeline(deal) {
  const calls = deal.calls || [];
  if (!calls.length) {
    document.getElementById('wr-timeline').innerHTML = '<div class="wr-card"><p style="color:var(--text-muted);font-size:13px">No events recorded yet.</p></div>';
    return;
  }

  // Build timeline: calls + deal creation
  const events = [];
  events.push({ type: 'deal_created', date: deal.created_at, title: 'Deal Created', detail: deal.company_name + ' added to pipeline' });
  calls.forEach(c => {
    events.push({
      type: 'call', date: c.started_at,
      title: (c.call_type || 'behavioral').replace('_', ' ') + ' call',
      detail: c.summary ? c.summary.slice(0, 200) + (c.summary.length > 200 ? '...' : '') : 'Duration: ' + (c.duration_seconds ? Math.round(c.duration_seconds / 60) + ' min' : 'unknown'),
      fullDetail: c.summary || '',
      id: c.id
    });
  });
  events.sort((a, b) => new Date(b.date) - new Date(a.date));

  document.getElementById('wr-timeline').innerHTML = '<div class="wr-card">' +
    events.map(e => {
      const dotColor = e.type === 'call' ? 'var(--accent)' : 'var(--green)';
      const date = new Date(e.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const time = new Date(e.date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const clickAttr = e.id ? ' style="cursor:pointer" onclick="openCallDetail(\'' + e.id + '\')"' : '';
      return '<div class="wr-timeline-item"' + clickAttr + '>' +
        '<div class="wr-timeline-dot" style="background:' + dotColor + '"></div>' +
        '<div class="wr-timeline-body">' +
          '<div class="wr-timeline-date">' + date + ' · ' + time + '</div>' +
          '<div class="wr-timeline-title">' + escapeHtml(e.title) + '</div>' +
          '<div class="wr-timeline-detail">' + escapeHtml(e.detail) + '</div>' +
          (e.fullDetail ? '<button class="wr-timeline-expand" onclick="this.nextElementSibling.classList.toggle(\'hidden\');this.textContent=this.textContent===\'Show more\'?\'Show less\':\'Show more\'">Show more</button><div class="hidden" style="font-size:12px;color:var(--text-secondary);white-space:pre-wrap;margin-top:6px">' + escapeHtml(e.fullDetail) + '</div>' : '') +
        '</div>' +
      '</div>';
    }).join('') +
  '</div>';
}

async function renderWrForecast(deal) {
  document.getElementById('wr-forecast').innerHTML = '<div class="wr-card"><p style="color:var(--text-muted);font-size:13px">Loading forecast readiness...</p></div>';

  try {
    const res = await fetch('/api/deals/' + deal.id + '/forecast');
    const data = await res.json();
    const items = data.checklist || [];

    if (!items.length) {
      document.getElementById('wr-forecast').innerHTML = '<div class="wr-card"><p style="color:var(--text-muted);font-size:13px">Not enough data to assess forecast readiness. Run more calls.</p></div>';
      return;
    }

    document.getElementById('wr-forecast').innerHTML = '<div class="wr-card"><div class="wr-card-title">Interview Readiness Checklist</div>' +
      items.map(item => {
        const icon = item.status === 'yes' ? '✅' : item.status === 'partial' ? '🟡' : '❌';
        return '<div class="wr-forecast-item">' +
          '<div class="wr-forecast-icon">' + icon + '</div>' +
          '<div class="wr-forecast-text">' +
            '<div class="wr-forecast-label">' + escapeHtml(item.item) + '</div>' +
            '<div class="wr-forecast-detail">' + escapeHtml(item.detail || '') + '</div>' +
          '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  } catch (e) {
    document.getElementById('wr-forecast').innerHTML = '<div class="wr-card"><p style="color:var(--text-muted);font-size:12px">Failed to load forecast.</p></div>';
  }
}

async function openWarRoom(dealId) {
  const id = dealId || activeWarRoomDealId || document.getElementById('call-deal-select').value;
  if (!id) { switchView('warroom'); return; }
  activeWarRoomDealId = id;
  switchView('warroom');
  loadWarRoom(id);
}

function formatChatResponse(text) {
  if (!text) return '';
  let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/`(.+?)`/g, '<code style="background:var(--bg-active);padding:1px 4px;border-radius:3px;font-size:12px">$1</code>');
  html = html.replace(/"([^"]{10,})"/g, '<span style="color:var(--text-primary);background:rgba(59,130,246,0.08);padding:1px 3px;border-radius:3px">"$1"</span>');
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  html = '<p>' + html + '</p>';
  html = html.replace(/<p><\/p>/g, '');
  return html;
}

function generateDealSuggestions(deal) {
  const suggestions = [];
  const mData = deal.meddpicc_data || {};
  const pains = deal.pain_points || [];
  const stakes = deal.stakeholders || [];

  // Smart suggestions based on deal state
  let totalFilled = 0, totalFields = 0;
  for (const subs of Object.values(mData)) {
    for (const v of Object.values(subs || {})) { totalFields++; if (v) totalFilled++; }
  }

  if (totalFilled === 0) {
    suggestions.push('What should I emphasize in my next round?');
    suggestions.push('Help me prep for my next interview');
  } else {
    suggestions.push('What gaps should I address before the next round?');
  }

  if (pains.length > 0) suggestions.push('Summarize my strongest talking points');
  else suggestions.push('What strengths should I highlight?');

  if (stakes.length > 1) suggestions.push('Who are the key interviewers and what do they care about?');

  const comp = deal.competitive_intel || {};
  if (comp.competitors && comp.competitors.length) suggestions.push('What concerns should I address proactively?');

  suggestions.push('What do I need to do to get the offer?');
  suggestions.push('Draft a thank-you email');

  return suggestions.slice(0, 5);
}

function renderDealSuggestions(deal) {
  const el = document.getElementById('wr-chat-suggestions');
  if (!el) return;
  const suggestions = generateDealSuggestions(deal);
  el.innerHTML = suggestions.map(s =>
    '<button class="wr-chat-suggestion" onclick="askDealAIWithQuestion(\'' + s.replace(/'/g, "\\'") + '\')">' + s + '</button>'
  ).join('');
}

function askDealAIWithQuestion(question) {
  document.getElementById('wr-chat-question').value = question;
  askDealAI();
}

async function askDealAI() {
  const input = document.getElementById('wr-chat-question');
  const question = input.value.trim();
  if (!question || !activeWarRoomDealId) return;

  const messages = document.getElementById('wr-chat-messages');

  // User bubble
  const userMsg = document.createElement('div');
  userMsg.className = 'wr-chat-msg-user';
  userMsg.innerHTML = '<div class="wr-chat-bubble-user">' + escapeHtml(question) + '</div>';
  messages.appendChild(userMsg);

  // AI bubble with thinking dots
  const aiMsg = document.createElement('div');
  aiMsg.className = 'wr-chat-msg-ai';
  aiMsg.innerHTML = '<div class="wr-chat-bubble-ai"><span class="wr-thinking"><span class="wr-thinking-dot"></span><span class="wr-thinking-dot"></span><span class="wr-thinking-dot"></span></span></div>';
  messages.appendChild(aiMsg);
  messages.scrollTop = messages.scrollHeight;

  const answerEl = aiMsg.querySelector('.wr-chat-bubble-ai');
  input.value = '';
  input.disabled = true;

  try {
    const res = await fetch('/api/deals/' + activeWarRoomDealId + '/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question })
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let started = false;
    let tokenQueue = [];
    let rendering = false;

    function renderLoop() {
      if (tokenQueue.length > 0) {
        const batch = Math.min(tokenQueue.length, 3);
        for (let i = 0; i < batch; i++) fullText += tokenQueue.shift();
        answerEl.innerHTML = formatChatResponse(fullText);
        messages.scrollTop = messages.scrollHeight;
      }
      if (tokenQueue.length > 0 || rendering) requestAnimationFrame(renderLoop);
    }

    rendering = true;
    requestAnimationFrame(renderLoop);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.token) {
              if (!started) { answerEl.innerHTML = ''; started = true; }
              tokenQueue.push(data.token);
            }
            if (data.done) { rendering = false; break; }
          } catch(e) {}
        }
      }
    }

    rendering = false;
    if (tokenQueue.length > 0) { fullText += tokenQueue.join(''); tokenQueue = []; }
    if (fullText) answerEl.innerHTML = formatChatResponse(fullText);
    else if (!started) answerEl.textContent = 'No response received.';
  } catch (e) {
    answerEl.innerHTML = '';
    answerEl.textContent = 'Error: ' + e.message;
  }

  input.disabled = false;
  input.focus();
  messages.scrollTop = messages.scrollHeight;
}

// ─── CALL DETAIL VIEW (inside Prep Hub) ─────────

async function openCallDetail(callId) {
  try {
    const res = await fetch('/api/calls/' + callId);
    const call = await res.json();
    renderCallDetailView(call);
  } catch (e) { console.error('Failed to load call:', e); }
}

function renderCallDetailView(call) {
  const dashboard = document.getElementById('warroom-dashboard');
  const date = new Date(call.started_at).toLocaleString();
  const duration = call.duration_seconds ? Math.floor(call.duration_seconds / 60) + 'm ' + (call.duration_seconds % 60) + 's' : '—';
  const analysis = call.call_analysis || {};
  const meddpicc = call.meddpicc_extracted || {};
  const coaching = call.coaching_log || [];
  const callScore = analysis.call_score || {};

  // Header
  let html = '<button class="wr-back-btn" onclick="loadWarRoom(\'' + activeWarRoomDealId + '\')">← Back to deal</button>';

  // Call header with score
  const score = callScore.overall || 0;
  const scoreColor = score >= 70 ? 'var(--green)' : score >= 40 ? 'var(--yellow)' : 'var(--accent)';
  html += '<div class="wr-header" style="flex-wrap:wrap">' +
    '<div style="display:flex;align-items:center;gap:16px;width:100%">' +
      (score ? '<div class="wr-header-health" style="border-color:' + scoreColor + ';color:' + scoreColor + '">' + score + '</div>' : '') +
      '<div class="wr-header-info">' +
        '<div class="wr-header-name">' + escapeHtml(call.prospect_name || 'Call') + ' · ' + escapeHtml(call.prospect_company || '') + '</div>' +
        '<div class="wr-header-meta">' +
          '<span>' + date + '</span><span>' + duration + '</span>' +
          '<span>' + (call.call_type || 'behavioral').replace('_', ' ') + '</span>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>';

  // Video player (if recording available)
  if (call.recording_url) {
    html += '<div class="wr-card"><div class="wr-card-title">Call Recording</div>' +
      '<video controls style="width:100%;border-radius:var(--radius);max-height:400px;background:#000" src="' + escapeHtml(call.recording_url) + '"></video></div>';
  }

  // Call score breakdown
  if (callScore.overall) {
    html += '<div class="wr-card"><div class="wr-card-title">Call Score</div>' +
      '<div class="wr-grid-3" style="margin-bottom:10px">';
    const scoreFields = [
      ['Qualification', callScore.qualification],
      ['Technical Depth', callScore.technical_depth],
      ['Listening', callScore.listening],
      ['Next Steps', callScore.next_steps]
    ];
    scoreFields.forEach(([label, val]) => {
      if (val !== undefined) {
        const c = val >= 70 ? 'var(--green)' : val >= 40 ? 'var(--yellow)' : 'var(--accent)';
        html += '<div class="wr-stat"><div class="wr-stat-value" style="color:' + c + '">' + val + '</div><div class="wr-stat-label">' + label + '</div></div>';
      }
    });
    html += '</div>';
    if (callScore.summary) html += '<div style="font-size:13px;color:var(--text-secondary)">' + escapeHtml(callScore.summary) + '</div>';

    // Talk ratio
    const ratio = analysis.talk_ratio;
    if (ratio) {
      html += '<div style="display:flex;align-items:center;gap:10px;margin-top:10px">' +
        '<div style="flex:1;height:8px;border-radius:4px;background:var(--bg-active);overflow:hidden;display:flex">' +
          '<div style="width:' + (ratio.rep_pct || 50) + '%;background:var(--blue);height:100%"></div>' +
          '<div style="width:' + (ratio.prospect_pct || 50) + '%;background:var(--accent);height:100%"></div>' +
        '</div>' +
        '<span style="font-size:11px;color:var(--text-muted)">You ' + (ratio.rep_pct || 50) + '% / Prospect ' + (ratio.prospect_pct || 50) + '%</span>' +
      '</div>';
      if (ratio.assessment) html += '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">' + escapeHtml(ratio.assessment) + '</div>';
    }
    html += '</div>';
  }

  // Two-column layout
  html += '<div class="wr-grid">';

  // Key quotes
  const quotes = analysis.key_quotes || [];
  html += '<div class="wr-card"><div class="wr-card-title">Key Quotes</div>';
  if (quotes.length) {
    quotes.forEach(q => {
      html += '<div style="padding:8px 0;border-bottom:1px solid var(--border)">' +
        '<div style="font-size:13px;color:var(--text-primary);font-style:italic">"' + escapeHtml(q.quote) + '"</div>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">' + escapeHtml(q.significance || '') + '</div></div>';
    });
  } else html += '<p style="color:var(--text-muted);font-size:12px">No key quotes captured</p>';
  html += '</div>';

  // Missed topics
  const missed = analysis.missed_topics || [];
  html += '<div class="wr-card"><div class="wr-card-title">Missed Topics</div>';
  if (missed.length) {
    missed.forEach(m => {
      html += '<div style="padding:8px 0;border-bottom:1px solid var(--border)">' +
        '<div style="font-size:13px;font-weight:600;color:var(--accent)">' + escapeHtml(m.topic) + '</div>' +
        '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px">' + escapeHtml(m.moment) + '</div>' +
        '<div style="font-size:11px;color:var(--blue);margin-top:2px;font-style:italic">→ ' + escapeHtml(m.suggested_followup) + '</div></div>';
    });
  } else html += '<p style="color:var(--green);font-size:12px">No missed topics — good coverage!</p>';
  html += '</div>';

  html += '</div>'; // end wr-grid

  // Next steps + Action items
  html += '<div class="wr-grid">';

  const nextSteps = analysis.next_steps || [];
  html += '<div class="wr-card"><div class="wr-card-title">Next Steps</div>';
  if (nextSteps.length) {
    nextSteps.forEach(ns => {
      const urgColor = ns.urgency === 'high' ? 'var(--accent)' : ns.urgency === 'medium' ? 'var(--yellow)' : 'var(--text-muted)';
      html += '<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:12px;display:flex;justify-content:space-between">' +
        '<span>' + escapeHtml(ns.action) + '</span>' +
        '<span style="color:' + urgColor + ';font-size:10px;font-weight:700">' + (ns.owner || '') + ' · ' + (ns.urgency || '') + '</span></div>';
    });
  } else html += '<p style="color:var(--text-muted);font-size:12px">No next steps identified</p>';
  html += '</div>';

  const actions = analysis.action_items || [];
  html += '<div class="wr-card"><div class="wr-card-title">Action Items</div>';
  if (actions.length) {
    actions.forEach(a => {
      html += '<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">' +
        '<div style="color:var(--text-primary)">' + escapeHtml(a.item) + '</div>' +
        '<div style="color:var(--text-muted);font-size:10px">' + escapeHtml(a.by_whom || '') + (a.deadline ? ' · by ' + a.deadline : '') + '</div></div>';
    });
  } else html += '<p style="color:var(--text-muted);font-size:12px">No commitments made</p>';
  html += '</div>';

  html += '</div>'; // end wr-grid

  // Scorecard data from this session
  const fieldNames = { situation_context: 'Situation', actions_taken: 'Actions', results_impact: 'Results', skills_demonstrated: 'Skills', company_knowledge: 'Company Knowledge', questions_asked: 'Questions Asked', red_flags: 'Red Flags' };
  html += '<div class="wr-card"><div class="wr-card-title">Scorecard Data This Session</div>';
  let hasAnyMeddpicc = false;
  for (const [field, label] of Object.entries(fieldNames)) {
    const subs = meddpicc[field] || {};
    const entries = Object.entries(subs).filter(([k, v]) => v);
    if (entries.length) {
      hasAnyMeddpicc = true;
      html += '<div style="margin-bottom:6px"><strong style="font-size:12px">' + label + '</strong>';
      entries.forEach(([k, v]) => { html += '<div style="font-size:11px;color:var(--text-secondary);padding-left:12px">• ' + escapeHtml(v) + '</div>'; });
      html += '</div>';
    }
  }
  if (!hasAnyMeddpicc) html += '<p style="color:var(--text-muted);font-size:12px">No scorecard data extracted from this session</p>';
  html += '</div>';

  // Coaching replay
  html += '<div class="wr-card"><div class="wr-card-title">Coaching Replay (' + coaching.length + ' prompts)</div>';
  if (coaching.length) {
    coaching.filter(c => c.tier >= 2).slice(0, 20).forEach(c => {
      const tierLabel = c.tier === 3 ? '✦ AI' : c.tier === 2 ? '📊 Insight' : 'Note';
      html += '<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">' +
        '<span style="font-size:10px;font-weight:700;color:var(--tier-' + (c.tier || 0) + ')">' + tierLabel + '</span> ' +
        '<span style="color:var(--text-secondary)">' + escapeHtml(c.text || '') + '</span></div>';
    });
  } else html += '<p style="color:var(--text-muted);font-size:12px">No coaching prompts recorded</p>';
  html += '</div>';

  // Transcript with copy button and search
  html += '<div class="wr-card">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
      '<div class="wr-card-title" style="margin:0">Full Transcript</div>' +
      '<div style="display:flex;gap:6px">' +
        '<input type="text" id="transcript-search" placeholder="Search..." oninput="searchTranscript(this.value)" style="background:var(--bg-active);border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px 8px;font-size:11px;color:var(--text-primary);font-family:var(--font);width:150px">' +
        '<button class="btn-sm" onclick="copyTranscript()" style="font-size:11px">📋 Copy</button>' +
      '</div>' +
    '</div>' +
    '<div id="call-detail-transcript" style="max-height:400px;overflow-y:auto;font-size:12px;line-height:1.8;color:var(--text-secondary);white-space:pre-wrap;font-family:var(--font)">' +
      escapeHtml(call.transcript || 'No transcript available') +
    '</div></div>';

  // Summary
  if (call.summary) {
    html += '<div class="wr-card"><div class="wr-card-title">AI Summary</div>' +
      '<div style="font-size:13px;color:var(--text-secondary);white-space:pre-wrap">' + escapeHtml(call.summary) + '</div></div>';
  }

  dashboard.innerHTML = html;
}

function copyTranscript() {
  const el = document.getElementById('call-detail-transcript');
  if (el) {
    navigator.clipboard.writeText(el.textContent).then(() => {
      const btn = document.querySelector('[onclick="copyTranscript()"]');
      if (btn) { btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = '📋 Copy'; }, 2000); }
    });
  }
}

function searchTranscript(query) {
  const el = document.getElementById('call-detail-transcript');
  if (!el) return;
  // Remove existing highlights
  el.innerHTML = el.textContent;
  if (!query || query.length < 2) return;
  const regex = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
  el.innerHTML = el.textContent.replace(regex, '<mark style="background:var(--yellow);color:#000;padding:0 2px;border-radius:2px">$1</mark>');
}

// Show health widget when deal is selected for a call
document.getElementById('call-deal-select')?.addEventListener('change', async function() {
  if (this.value) {
    try {
      const res = await fetch('/api/deals/' + this.value);
      const deal = await res.json();
      activeWarRoomDealId = this.value;
      showHealthWidget(deal.health_score || 0);
    } catch (e) { hideHealthWidget(); }
  } else {
    activeWarRoomDealId = null;
    hideHealthWidget();
  }
});

// ═══════════════════════════════════════════════════
// KEYWORD MANAGER
// ═══════════════════════════════════════════════════

let allKeywords = [];

async function loadKeywords() {
  try {
    const res = await fetch('/api/keywords');
    const data = await res.json();
    allKeywords = data.keywords || [];
    renderKeywords(allKeywords);
    renderKwStats(data.stats);
  } catch (e) { console.error('Failed to load keywords:', e); }
}

function renderKwStats(stats) {
  if (!stats) return;
  const el = document.getElementById('kw-stats');
  if (!el) return;
  el.innerHTML =
    '<div style="display:flex;gap:16px;font-size:12px;color:var(--text-muted)">' +
      '<span><strong style="color:var(--text-primary)">' + (stats.enabled || 0) + '</strong> active</span>' +
      '<span><strong style="color:var(--text-primary)">' + (stats.total || 0) + '</strong> total</span>' +
      (stats.topFired && stats.topFired.length ? '<span>Top fired: ' + stats.topFired.slice(0, 3).map(t => '<strong>' + escapeHtml(t.trigger_phrase) + '</strong> (' + t.fire_count + ')').join(', ') + '</span>' : '') +
    '</div>';
}

function renderKeywords(kwList) {
  const container = document.getElementById('kw-list');
  if (!container) return;
  if (!kwList.length) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:40px">No keywords found.</p>';
    return;
  }

  const sourceColors = { 'built-in': '#6B7280', 'manual': '#3B82F6', 'ai-transcript': '#8B5CF6', 'playbook-mined': '#10B981' };

  container.innerHTML = kwList.map(kw => {
    const srcColor = sourceColors[kw.source] || '#6B7280';
    const enabled = kw.enabled !== false;
    return '<div style="display:flex;align-items:start;gap:10px;padding:10px 14px;background:var(--bg-panel);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:6px;opacity:' + (enabled ? '1' : '0.5') + '">' +
      '<input type="checkbox" ' + (enabled ? 'checked' : '') + ' onchange="toggleKeyword(' + kw.id + ',this.checked)" style="margin-top:3px;cursor:pointer">' +
      '<div style="flex:1;min-width:0">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">' +
          '<span style="font-size:14px;font-weight:700;color:var(--accent)">"' + escapeHtml(kw.trigger_phrase) + '"</span>' +
          '<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:' + (kw.color || '#3B82F6') + '20;color:' + (kw.color || '#3B82F6') + ';font-weight:600">' + (kw.category || 'custom') + '</span>' +
          (kw.field ? '<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(100,116,139,0.1);color:#94A3B8">' + kw.field.replace(/_/g, ' ') + '</span>' : '') +
          (kw.call_type ? '<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(59,130,246,0.1);color:var(--blue)">' + kw.call_type.replace(/_/g, ' ') + '</span>' : '') +
        '</div>' +
        '<div style="font-size:12px;color:var(--text-primary)">' + escapeHtml(kw.prompt) + '</div>' +
        (kw.context ? '<div style="font-size:11px;color:var(--text-muted);margin-top:2px;font-style:italic">' + escapeHtml(kw.context) + '</div>' : '') +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0">' +
        '<span style="font-size:10px;color:' + srcColor + ';font-weight:600">' + (kw.source || '?') + '</span>' +
        '<span style="font-size:10px;color:var(--text-muted)">' + (kw.fire_count || 0) + '×</span>' +
        '<button style="background:none;border:none;cursor:pointer;font-size:13px;padding:2px" onclick="editKeyword(' + kw.id + ')">✏️</button>' +
        '<button style="background:none;border:none;cursor:pointer;font-size:13px;padding:2px" onclick="deleteKeyword(' + kw.id + ')">🗑️</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function filterKeywords() {
  const search = (document.getElementById('kw-search').value || '').toLowerCase();
  const source = document.getElementById('kw-filter-source').value;
  const category = document.getElementById('kw-filter-category').value;
  const filtered = allKeywords.filter(kw => {
    if (search && !kw.trigger_phrase.toLowerCase().includes(search) && !(kw.prompt || '').toLowerCase().includes(search)) return false;
    if (source && kw.source !== source) return false;
    if (category && kw.category !== category) return false;
    return true;
  });
  renderKeywords(filtered);
}

function showAddKeywordModal(kw) {
  document.getElementById('kw-modal-title').textContent = kw ? 'Edit Keyword' : 'Add Keyword';
  document.getElementById('kw-edit-id').value = kw ? kw.id : '';
  document.getElementById('kw-trigger').value = kw ? kw.trigger_phrase : '';
  document.getElementById('kw-prompt').value = kw ? kw.prompt : '';
  document.getElementById('kw-context').value = kw ? (kw.context || '') : '';
  document.getElementById('kw-category').value = kw ? (kw.category || 'custom') : 'custom';
  document.getElementById('kw-field').value = kw ? (kw.field || '') : '';
  document.getElementById('kw-cooldown').value = kw ? (kw.cooldown || 30) : 30;
  document.getElementById('kw-calltype').value = kw ? (kw.call_type || '') : '';
  document.getElementById('kw-modal').classList.remove('hidden');
}

function closeKwModal() { document.getElementById('kw-modal').classList.add('hidden'); }

async function saveKeyword() {
  const editId = document.getElementById('kw-edit-id').value;
  const data = {
    trigger: document.getElementById('kw-trigger').value,
    trigger_phrase: document.getElementById('kw-trigger').value,
    prompt: document.getElementById('kw-prompt').value,
    context: document.getElementById('kw-context').value,
    category: document.getElementById('kw-category').value,
    field: document.getElementById('kw-field').value || null,
    cooldown: parseInt(document.getElementById('kw-cooldown').value) || 30,
    call_type: document.getElementById('kw-calltype').value || null
  };
  if (!data.trigger) { alert('Trigger phrase required'); return; }
  if (!data.prompt) { alert('Coaching prompt required'); return; }

  try {
    if (editId) {
      await fetch('/api/keywords/' + editId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    } else {
      await fetch('/api/keywords', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    }
    closeKwModal();
    loadKeywords();
  } catch (e) { alert('Failed to save'); }
}

function editKeyword(id) {
  const kw = allKeywords.find(k => k.id === id);
  if (kw) showAddKeywordModal(kw);
}

async function deleteKeyword(id) {
  if (!confirm('Delete this keyword?')) return;
  await fetch('/api/keywords/' + id, { method: 'DELETE' });
  loadKeywords();
}

async function toggleKeyword(id, enabled) {
  await fetch('/api/keywords/' + id + '/toggle', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
}

function showExtractModal() { document.getElementById('extract-modal').classList.remove('hidden'); }
function closeExtractModal() { document.getElementById('extract-modal').classList.add('hidden'); }

async function extractKeywords(autoAdd) {
  const transcript = document.getElementById('extract-transcript').value;
  if (!transcript || transcript.length < 50) { alert('Paste a transcript first (minimum 50 characters)'); return; }

  const callType = document.getElementById('extract-calltype').value;
  const resultsEl = document.getElementById('extract-results');
  resultsEl.innerHTML = '<p style="color:var(--text-muted)">🤖 Analyzing transcript...</p>';

  try {
    const endpoint = autoAdd ? '/api/keywords/extract-and-add' : '/api/keywords/extract-from-transcript';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, call_type: callType })
    });
    const data = await res.json();
    console.log('Extraction response:', data);
    const keywords = data.keywords || [];

    if (data.error) {
      resultsEl.innerHTML = '<p style="color:var(--accent)">Error: ' + escapeHtml(data.error) + '</p>';
      return;
    }

    if (!keywords.length) {
      resultsEl.innerHTML = '<p style="color:var(--text-muted)">No keywords extracted. Try a longer transcript. Check browser console for details.</p>';
      return;
    }

    if (autoAdd) {
      resultsEl.innerHTML = '<p style="color:var(--green);font-weight:600">✅ Extracted ' + data.extracted + ' keywords, added ' + data.added + ' new (duplicates skipped).</p>';
      loadKeywords();
    } else {
      resultsEl.innerHTML = '<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">' + keywords.length + ' keywords found. Review below, then click "Extract & Add All" to save.</div>' +
        keywords.map(kw =>
          '<div style="padding:8px;background:var(--bg-panel);border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:6px">' +
            '<div style="font-size:13px;font-weight:600;color:var(--accent)">"' + escapeHtml(kw.trigger) + '"</div>' +
            '<div style="font-size:12px;color:var(--text-primary);margin:2px 0">' + escapeHtml(kw.prompt) + '</div>' +
            '<div style="font-size:11px;color:var(--text-muted)">' + escapeHtml(kw.context || '') + '</div>' +
          '</div>'
        ).join('');
    }
  } catch (e) {
    resultsEl.innerHTML = '<p style="color:var(--accent)">Extraction failed.</p>';
  }
}

// ═══════════════════════════════════════════════════
// CALL TYPE PLAYBOOKS
// ═══════════════════════════════════════════════════

const CALL_TYPE_CONFIG = [
  {
    id: 'behavioral', name: 'Behavioral', icon: '🎯',
    desc: 'Behavioral interviews — answer with STAR method, demonstrate competencies, show self-awareness.',
    assets: [
      { id: 'framework', name: 'STAR method framework / behavioral question bank', source: 'Interview prep resources, career coaches' },
      { id: 'competencies', name: 'Key competency checklist for the role', source: 'Job description, role requirements' },
      { id: 'stories', name: 'Pre-prepared STAR stories mapped to competencies', source: 'Practice sessions, self-reflection' },
      { id: 'persona_qs', name: 'Questions by interviewer role (HR, hiring manager, peer)', source: 'Glassdoor, interview prep guides' },
      { id: 'role_qs', name: 'Role-specific behavioral questions', source: 'Industry contacts, mentors' }
    ],
    transcriptGoals: { ok: 3, good: 5, great: 10, worldClass: 20 },
    transcriptDesc: 'Strong behavioral interviews where the candidate used STAR method effectively and demonstrated key competencies.'
  },
  {
    id: 'technical', name: 'Technical', icon: '💻',
    desc: 'Technical interviews — demonstrate problem-solving, system design, coding skills, and trade-off analysis.',
    assets: [
      { id: 'patterns', name: 'Common problem patterns and approaches', source: 'LeetCode, system design guides' },
      { id: 'frameworks', name: 'Technical problem-solving frameworks', source: 'Technical mentors, study groups' },
      { id: 'clarify', name: 'Clarifying question templates', source: 'System design guides, coding interview prep' },
      { id: 'tradeoffs', name: 'Trade-off analysis talking points', source: 'Architecture docs, tech blogs' },
      { id: 'domain', name: 'Domain-specific technical knowledge', source: 'Role-specific technical resources' }
    ],
    transcriptGoals: { ok: 3, good: 5, great: 10, worldClass: 20 },
    transcriptDesc: 'Technical interviews where the candidate demonstrated clear problem-solving methodology and communicated their approach well.'
  },
  {
    id: 'case_study', name: 'Case Study', icon: '📊',
    desc: 'Case study interviews — apply structured frameworks, quantitative reasoning, and crisp recommendations.',
    assets: [
      { id: 'case_fw', name: 'Case study frameworks (market sizing, profitability, etc.)', source: 'MBA case prep, consulting frameworks' },
      { id: 'math', name: 'Mental math and estimation practice', source: 'Case prep books, practice partners' },
      { id: 'structures', name: 'Issue tree and MECE structuring guides', source: 'Consulting prep resources' },
      { id: 'industry', name: 'Industry-specific case patterns', source: 'Industry reports, case books' },
      { id: 'recs', name: 'Recommendation delivery frameworks', source: 'Presentation skills resources' }
    ],
    transcriptGoals: { ok: 3, good: 5, great: 10, worldClass: 20 },
    transcriptDesc: 'Case study interviews where the candidate applied clear frameworks, used data effectively, and delivered actionable recommendations.'
  },
  {
    id: 'panel', name: 'Panel', icon: '👥',
    desc: 'Panel interviews — engage multiple interviewers, adapt communication style, show breadth and depth.',
    assets: [
      { id: 'panel_prep', name: 'Panel member research and backgrounds', source: 'LinkedIn, company website' },
      { id: 'multi_audience', name: 'Multi-audience communication strategies', source: 'Presentation skills guides' },
      { id: 'role_map', name: 'Interviewer role mapping (who cares about what)', source: 'Recruiter intel, job description' },
      { id: 'eye_contact', name: 'Panel engagement best practices', source: 'Interview coaches, career advisors' },
      { id: 'follow_up', name: 'Individual follow-up templates per panelist', source: 'Career coaches, networking guides' }
    ],
    transcriptGoals: { ok: 2, good: 4, great: 8, worldClass: 15 },
    transcriptDesc: 'Panel interviews where the candidate engaged all panelists, adapted their communication, and left each person with a clear impression.'
  },
  {
    id: 'executive', name: 'Executive', icon: '👔',
    desc: 'Executive interviews — demonstrate strategic thinking, business acumen, vision, and leadership maturity.',
    assets: [
      { id: 'exec_points', name: 'Executive presence talking points', source: 'Leadership development, executive coaches' },
      { id: 'vision', name: 'Strategic vision articulation framework', source: 'Business strategy resources' },
      { id: 'biz_acumen', name: 'Business impact stories with P&L context', source: 'Career history, past performance reviews' },
      { id: 'leadership', name: 'Leadership philosophy and style articulation', source: 'Self-reflection, 360 feedback' },
      { id: 'exec_qs', name: 'Smart questions for C-suite / VP-level', source: 'Executive interview prep guides' }
    ],
    transcriptGoals: { ok: 3, good: 5, great: 10, worldClass: 20 },
    transcriptDesc: 'Executive-level interviews where the candidate demonstrated strategic thinking, business acumen, and leadership maturity.'
  }
];

let callTypeAssetCounts = {};

async function loadCallTypeAssets(typeId) {
  try {
    const res = await fetch('/api/call-types/' + typeId + '/assets');
    const data = await res.json();
    return data.files || [];
  } catch (e) { return []; }
}

function getCtLevel(count, goals) {
  if (count >= goals.worldClass) return 'world-class';
  if (count >= goals.great) return 'great';
  if (count >= goals.good) return 'good';
  if (count >= goals.ok) return 'ok';
  return 'empty';
}

async function renderCallTypeSettings() {
  const container = document.getElementById('calltype-sections');

  // Load all asset counts
  const allFiles = [];
  try {
    const res = await fetch('/api/playbook');
    const data = await res.json();
    allFiles.push(...(data.files || []));
  } catch (e) {}

  container.innerHTML = CALL_TYPE_CONFIG.map(ct => {
    // Count assets for this interview type
    const assetFiles = allFiles.filter(f => f.section === 'calltype_' + ct.id + '_assets');
    const transcriptFiles = allFiles.filter(f => f.section === 'calltype_' + ct.id + '_transcripts');
    const assetCount = assetFiles.length;
    const transcriptCount = transcriptFiles.length;
    const tLevel = getCtLevel(transcriptCount, ct.transcriptGoals);
    const tPct = Math.min(100, Math.round((transcriptCount / ct.transcriptGoals.worldClass) * 100));
    const tColor = getLevelColor(tLevel);
    const tLabel = tLevel === 'empty' ? 'Empty' : tLevel === 'world-class' ? 'World Class' : tLevel.charAt(0).toUpperCase() + tLevel.slice(1);

    return '<div class="pb-section" id="ct-' + ct.id + '">' +
      '<div class="pb-section-header" onclick="document.getElementById(\'ct-' + ct.id + '\').classList.toggle(\'open\')">' +
        '<span class="pb-section-icon">' + ct.icon + '</span>' +
        '<div class="pb-section-info">' +
          '<div class="pb-section-name">' + ct.name + '</div>' +
          '<div class="pb-section-count">' + assetCount + ' assets · ' + transcriptCount + ' transcripts</div>' +
        '</div>' +
        '<span class="pb-section-chevron">▶</span>' +
      '</div>' +
      '<div class="pb-section-body">' +
        '<p style="font-size:12px;color:var(--text-secondary);margin-bottom:12px">' + ct.desc + '</p>' +

        // Assets section
        '<div style="margin-bottom:16px">' +
          '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:8px">Prep Docs Assets (' + assetCount + ')</div>' +
          '<button class="pb-info-toggle" onclick="event.stopPropagation();togglePbInfo(\'cta-' + ct.id + '\')">ℹ️ What to upload here</button>' +
          '<div class="pb-info-content" id="pb-info-cta-' + ct.id + '">' +
            ct.assets.map(a => '<div style="font-size:11px;padding:2px 0"><strong>' + a.name + '</strong> — <span style="color:var(--text-muted)">' + a.source + '</span></div>').join('') +
          '</div>' +
          '<div class="pb-upload" onclick="document.getElementById(\'ct-assets-' + ct.id + '\').click()"' +
            ' ondrop="handleCtDrop(event,\'' + ct.id + '\',\'assets\')" ondragover="event.preventDefault();this.classList.add(\'dragover\')"' +
            ' ondragleave="this.classList.remove(\'dragover\')">' +
            '<input type="file" id="ct-assets-' + ct.id + '" multiple accept=".txt,.md,.pdf,.docx"' +
              ' onchange="uploadCtFiles(\'' + ct.id + '\',\'assets\',this.files)" style="display:none">' +
            '<p class="pb-upload-text">Drop prep assets here or click to upload</p>' +
          '</div>' +
          '<div class="pb-file-list">' + assetFiles.map(f => renderCtFile(f, ct.id)).join('') + '</div>' +
        '</div>' +

        // Transcripts section
        '<div>' +
          '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:6px">Example Call Transcripts (' + transcriptCount + ')</div>' +
          '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
            '<div style="flex:1;height:6px;background:var(--bg-active);border-radius:3px;overflow:hidden">' +
              '<div style="height:100%;width:' + tPct + '%;background:' + tColor + ';border-radius:3px;transition:width 0.5s"></div>' +
            '</div>' +
            '<span style="font-size:10px;font-weight:700;color:' + tColor + '">' + tLabel + '</span>' +
          '</div>' +
          '<button class="pb-info-toggle" onclick="event.stopPropagation();togglePbInfo(\'ctt-' + ct.id + '\')">ℹ️ What transcripts to upload</button>' +
          '<div class="pb-info-content" id="pb-info-ctt-' + ct.id + '">' +
            '<p>' + ct.transcriptDesc + '</p>' +
            '<div class="pb-info-levels">' +
              '<div class="pb-info-level"><span class="pb-info-dot" style="background:var(--yellow)"></span><strong>Ok:</strong> ' + ct.transcriptGoals.ok + ' transcripts</div>' +
              '<div class="pb-info-level"><span class="pb-info-dot" style="background:var(--blue)"></span><strong>Good:</strong> ' + ct.transcriptGoals.good + ' transcripts</div>' +
              '<div class="pb-info-level"><span class="pb-info-dot" style="background:var(--purple)"></span><strong>Great:</strong> ' + ct.transcriptGoals.great + ' transcripts</div>' +
              '<div class="pb-info-level"><span class="pb-info-dot" style="background:var(--green)"></span><strong>World Class:</strong> ' + ct.transcriptGoals.worldClass + '+ transcripts</div>' +
            '</div>' +
          '</div>' +
          '<div class="pb-upload" onclick="document.getElementById(\'ct-trans-' + ct.id + '\').click()"' +
            ' ondrop="handleCtDrop(event,\'' + ct.id + '\',\'transcripts\')" ondragover="event.preventDefault();this.classList.add(\'dragover\')"' +
            ' ondragleave="this.classList.remove(\'dragover\')">' +
            '<input type="file" id="ct-trans-' + ct.id + '" multiple accept=".txt,.md,.pdf,.docx"' +
              ' onchange="uploadCtFiles(\'' + ct.id + '\',\'transcripts\',this.files)" style="display:none">' +
            '<p class="pb-upload-text">Drop call transcripts here or click to upload</p>' +
          '</div>' +
          '<div class="pb-file-list">' + transcriptFiles.map(f => renderCtFile(f, ct.id)).join('') + '</div>' +
        '</div>' +

      '</div>' +
    '</div>';
  }).join('');
}

function renderCtFile(f, typeId) {
  const ext = f.name.split('.').pop().toUpperCase();
  const icon = ext === 'PDF' ? '📄' : ext === 'DOCX' ? '📝' : ext === 'TXT' ? '📃' : '📁';
  const date = new Date(f.addedAt).toLocaleDateString();
  return '<div class="file-item" style="padding:8px 12px;margin-bottom:3px;background:var(--bg-panel);border:1px solid var(--border);border-radius:var(--radius-sm);display:flex;align-items:center;justify-content:space-between">' +
    '<div style="display:flex;align-items:center;gap:8px">' +
      '<span>' + icon + '</span>' +
      '<div><div style="font-size:12px;font-weight:500">' + escapeHtml(f.name) + '</div>' +
      '<div style="font-size:10px;color:var(--text-muted)">' + (f.chunkCount || 0) + ' chunks · ' + date + '</div></div>' +
    '</div>' +
    '<button style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:14px;padding:4px" ' +
      'onclick="removeCtFile(\'' + f.id + '\',\'' + typeId + '\')" title="Remove">✕</button>' +
  '</div>';
}

async function uploadCtFiles(typeId, section, files) {
  const formData = new FormData();
  for (const file of files) formData.append('files', file);
  formData.append('section', section);

  try {
    await fetch('/api/call-types/' + typeId + '/assets', { method: 'POST', body: formData });
    renderCallTypeSettings();
  } catch (e) {
    console.error('Upload failed:', e);
    alert('Upload failed');
  }
}

function handleCtDrop(event, typeId, section) {
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.classList.remove('dragover');
  if (event.dataTransfer.files.length > 0) uploadCtFiles(typeId, section, event.dataTransfer.files);
}

async function removeCtFile(fileId, typeId) {
  if (!confirm('Remove this file?')) return;
  try {
    await fetch('/api/call-types/' + typeId + '/assets/' + fileId, { method: 'DELETE' });
    renderCallTypeSettings();
  } catch (e) { console.error('Remove failed:', e); }
}

// Toggle for interview type sections (reuse pb toggle with prefix)
function toggleCtSection(id) {
  document.getElementById(id).classList.toggle('open');
}

// ═══════════════════════════════════════════════════
// DEALS
// ═══════════════════════════════════════════════════

let allDeals = [];

async function loadDeals() {
  try {
    const res = await fetch('/api/deals');
    const data = await res.json();
    allDeals = data.deals || [];
    renderDeals(allDeals);
    renderDealStats(data.stats);
    populateDealSelector();
  } catch (error) {
    console.error('Failed to load deals:', error);
  }
}

function renderDeals(dealsList) {
  const container = document.getElementById('deals-list');
  if (dealsList.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:40px 0">No positions yet. Click "+ New Position" to create one.</p>';
    return;
  }

  container.innerHTML = dealsList.map(d => {
    const health = d.health_score || 0;
    const healthClass = health >= 60 ? 'deal-health-green' : health >= 30 ? 'deal-health-yellow' : 'deal-health-red';
    const value = d.deal_value ? '$' + (d.deal_value >= 1000 ? Math.round(d.deal_value / 1000) + 'K' : d.deal_value) : '—';
    const vehicles = d.vehicle_count ? d.vehicle_count + ' vehicles' : '';
    const updated = new Date(d.updated_at).toLocaleDateString();

    // Scorecard mini badges
    const meddpiccFields = ['metrics', 'economic_buyer', 'decision_criteria', 'decision_process', 'identified_pain', 'champion', 'competition'];
    const letters = ['M', 'E', 'D', 'D', 'P', 'C', 'C'];
    const mData = d.meddpicc_data || {};
    const mBadges = meddpiccFields.map((f, i) => {
      const subFields = mData[f] || {};
      const filled = Object.values(subFields).filter(v => v).length;
      const total = Object.keys(subFields).length;
      let dotClass = 'meddpicc-empty-dot';
      if (total > 0 && filled >= total) dotClass = 'meddpicc-complete-dot';
      else if (filled > 0) dotClass = 'meddpicc-partial-dot';
      return '<span class="deal-meddpicc-dot ' + dotClass + '">' + letters[i] + '</span>';
    }).join('');

    // Top key strengths
    const pains = (d.pain_points || []).slice(0, 2);
    const painTags = pains.map(p => '<span class="deal-pain-tag">' + escapeHtml((p.text || '').slice(0, 30)) + '</span>').join('');

    return '<div class="deal-card" onclick="openWarRoom(\'' + d.id + '\')">' +
      '<div class="deal-card-health ' + healthClass + '">' + health + '</div>' +
      '<div class="deal-card-info">' +
        '<div class="deal-card-name">' + escapeHtml(d.company_name) + '</div>' +
        '<div class="deal-card-meta">' +
          '<span>' + value + '</span>' +
          (vehicles ? '<span>' + vehicles + '</span>' : '') +
          '<span>Updated ' + updated + '</span>' +
        '</div>' +
        (painTags ? '<div class="deal-card-pains">' + painTags + '</div>' : '') +
      '</div>' +
      '<div class="deal-card-meddpicc">' + mBadges + '</div>' +
      '<span class="deal-stage-badge stage-' + (d.stage || 'applied') + '">' + (d.stage || 'applied').replace('_', ' ') + '</span>' +
    '</div>';
  }).join('');
}

function renderDealStats(stats) {
  const el = document.getElementById('deals-stats');
  if (!el || !stats) return;
  el.innerHTML = '<span><span class="stat-val">' + (stats.activeDeals || 0) + '</span> active deals</span>' +
    '<span><span class="stat-val">' + (stats.totalDeals || 0) + '</span> total</span>';
}

function filterDeals(query) {
  const search = (query || document.getElementById('deals-search').value || '').toLowerCase();
  const stage = document.getElementById('deals-stage-filter').value;
  const filtered = allDeals.filter(d => {
    const matchSearch = !search || d.company_name.toLowerCase().includes(search);
    const matchStage = !stage || d.stage === stage;
    return matchSearch && matchStage;
  });
  renderDeals(filtered);
}

function populateDealSelector() {
  const select = document.getElementById('call-deal-select');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">No position</option>' +
    allDeals.filter(d => !['offer_accepted', 'rejected'].includes(d.stage))
      .map(d => '<option value="' + d.id + '">' + escapeHtml(d.company_name) + '</option>')
      .join('');
  select.value = current;
}

function showCreateDealModal(deal) {
  document.getElementById('deal-modal-title').textContent = deal ? 'Edit Deal' : 'New Position';
  document.getElementById('deal-edit-id').value = deal ? deal.id : '';
  document.getElementById('deal-company').value = deal ? deal.company_name : '';
  document.getElementById('deal-value').value = deal ? deal.deal_value : '';
  document.getElementById('deal-vehicles').value = deal ? deal.vehicle_count || '' : '';
  document.getElementById('deal-stage').value = deal ? deal.stage : 'discovery';
  document.getElementById('deal-notes').value = deal ? deal.notes : '';
  document.getElementById('deal-modal').classList.remove('hidden');
}

function closeDealModal() {
  document.getElementById('deal-modal').classList.add('hidden');
}

async function saveDeal() {
  const editId = document.getElementById('deal-edit-id').value;
  const data = {
    company_name: document.getElementById('deal-company').value,
    deal_value: parseInt(document.getElementById('deal-value').value) || 0,
    vehicle_count: parseInt(document.getElementById('deal-vehicles').value) || null,
    stage: document.getElementById('deal-stage').value,
    notes: document.getElementById('deal-notes').value
  };

  if (!data.company_name) { alert('Company name is required'); return; }

  try {
    if (editId) {
      await fetch('/api/deals/' + editId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    } else {
      await fetch('/api/deals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    }
    closeDealModal();
    loadDeals();
  } catch (error) {
    console.error('Save deal failed:', error);
    alert('Failed to save deal');
  }
}

async function viewDealDetail(dealId) {
  try {
    const res = await fetch('/api/deals/' + dealId);
    const deal = await res.json();

    const value = deal.deal_value ? '$' + deal.deal_value.toLocaleString() : '—';
    const health = deal.health_score || 0;
    const healthClass = health >= 60 ? 'deal-health-green' : health >= 30 ? 'deal-health-yellow' : 'deal-health-red';

    // Scorecard summary
    const mData = deal.meddpicc_data || {};
    let meddpiccHtml = '';
    const fieldNames = { situation_context: 'Situation', actions_taken: 'Actions', results_impact: 'Results', skills_demonstrated: 'Skills', company_knowledge: 'Company Knowledge', questions_asked: 'Questions Asked', red_flags: 'Red Flags' };
    for (const [field, label] of Object.entries(fieldNames)) {
      const subs = mData[field] || {};
      const entries = Object.entries(subs).filter(([k, v]) => v);
      meddpiccHtml += '<div style="margin-bottom:8px"><strong style="color:var(--text-primary)">' + label + '</strong>';
      if (entries.length === 0) {
        meddpiccHtml += ' <span style="color:var(--text-muted)">— No data</span>';
      } else {
        meddpiccHtml += '<ul style="margin:4px 0 0 16px;padding:0;list-style:disc">';
        entries.forEach(([k, v]) => { meddpiccHtml += '<li style="font-size:12px;color:var(--text-secondary);margin:2px 0">' + escapeHtml(v) + '</li>'; });
        meddpiccHtml += '</ul>';
      }
      meddpiccHtml += '</div>';
    }

    // Pain points
    const pains = deal.pain_points || [];
    const painsHtml = pains.length > 0
      ? pains.map(p => '<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">' +
          '<span style="color:var(--text-primary)">' + escapeHtml(p.text) + '</span>' +
          ' <span style="color:var(--text-muted);font-size:10px">(' + (p.status || 'mentioned') + ')</span></div>').join('')
      : '<p style="color:var(--text-muted);font-size:12px">No key strengths captured yet</p>';

    // Contacts
    const stakes = deal.stakeholders || [];
    const stakesHtml = stakes.length > 0
      ? stakes.map(s => '<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:12px;display:flex;justify-content:space-between">' +
          '<span style="color:var(--text-primary)">' + escapeHtml(s.name) + ' <span style="color:var(--text-muted)">(' + (s.role || '?') + ')</span></span>' +
          '<span style="font-size:10px;color:var(--text-muted)">' + (s.sentiment || 'unknown') + ' · ' + (s.interactions || 0) + ' interactions</span></div>').join('')
      : '<p style="color:var(--text-muted);font-size:12px">No stakeholders identified yet</p>';

    // Calls
    const callsArr = deal.calls || [];
    const callsHtml = callsArr.length > 0
      ? callsArr.map(c => '<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:12px;display:flex;justify-content:space-between">' +
          '<span style="color:var(--text-primary)">' + new Date(c.started_at).toLocaleDateString() + ' — ' + (c.call_type || 'behavioral') + '</span>' +
          '<span style="color:var(--text-muted)">' + (c.duration_seconds ? Math.round(c.duration_seconds / 60) + 'min' : '—') + '</span></div>').join('')
      : '<p style="color:var(--text-muted);font-size:12px">No calls recorded yet</p>';

    document.getElementById('deal-detail-body').innerHTML =
      '<div class="deal-detail-header">' +
        '<div class="deal-card-health ' + healthClass + '" style="width:50px;height:50px;font-size:18px">' + health + '</div>' +
        '<div><h2>' + escapeHtml(deal.company_name) + '</h2>' +
          '<div style="font-size:12px;color:var(--text-muted)">' + value + ' · ' + (deal.vehicle_count || '—') + ' vehicles · ' + (deal.stage || 'behavioral') + '</div>' +
        '</div>' +
        '<button class="btn-sm" onclick="showCreateDealModal(' + JSON.stringify(deal).replace(/"/g, '&quot;') + ')" style="margin-left:auto">Edit</button>' +
      '</div>' +
      '<div class="deal-detail-section"><h3>Interview Scorecard</h3>' + meddpiccHtml + '</div>' +
      '<div class="deal-detail-section"><h3>Key Strengths</h3>' + painsHtml + '</div>' +
      '<div class="deal-detail-section"><h3>Contacts</h3>' + stakesHtml + '</div>' +
      '<div class="deal-detail-section"><h3>Session History</h3>' + callsHtml + '</div>' +
      (deal.notes ? '<div class="deal-detail-section"><h3>Notes</h3><pre>' + escapeHtml(deal.notes) + '</pre></div>' : '');

    document.getElementById('deal-detail-modal').classList.remove('hidden');
  } catch (error) {
    console.error('Failed to load deal:', error);
  }
}

function closeDealDetail() {
  document.getElementById('deal-detail-modal').classList.add('hidden');
}

// ═══════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ═══════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  // Set initial scorecard state
  onScorecardUpdate({
    situation_context: 'empty',
    actions_taken: 'empty',
    results_impact: 'empty',
    skills_demonstrated: 'empty',
    company_knowledge: 'empty',
    questions_asked: 'empty',
    red_flags: 'empty'
  });
  // Load deals for the selector
  loadDeals();

  // Always-on WebSocket — connects immediately, reconnects on drop
  // This ensures calendar auto-join notifications reach the browser
  connectWebSocket();
});

// ═══════════════════════════════════════════════════
// CALENDAR INTEGRATION
// ═══════════════════════════════════════════════════

async function loadCalendarSettings() {
  try {
    const res = await fetch('/api/calendar/connections');
    const data = await res.json();
    renderCalendarConnections(data.connections || []);

    const evtRes = await fetch('/api/calendar/events');
    const evtData = await evtRes.json();
    renderUpcomingEvents(evtData.events || []);
  } catch (e) {
    console.error('Failed to load calendar settings:', e);
  }
}

function renderCalendarConnections(connections) {
  const el = document.getElementById('calendar-connections');
  if (!connections.length) {
    el.innerHTML = '<p style="font-size:13px;color:var(--text-muted)">No calendars connected yet.</p>';
    return;
  }

  el.innerHTML = connections.map(c => {
    const providerIcon = c.provider === 'google' ? 'G' : '⊞';
    const providerColor = c.provider === 'google' ? '#4285F4' : '#0078D4';
    const providerName = c.provider === 'google' ? 'Google Calendar' : 'Outlook Calendar';

    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px;background:var(--bg-active);border-radius:var(--radius);margin-bottom:8px">' +
      '<div style="display:flex;align-items:center;gap:10px">' +
        '<span style="background:' + providerColor + ';color:white;width:28px;height:28px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px">' + providerIcon + '</span>' +
        '<div>' +
          '<div style="font-size:13px;font-weight:600;color:var(--text-primary)">' + providerName + '</div>' +
          '<div style="font-size:11px;color:var(--text-muted)">' + escapeHtml(c.email || '') + '</div>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px">' +
        '<label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-muted);cursor:pointer">' +
          '<input type="checkbox" ' + (c.auto_join ? 'checked' : '') + ' onchange="toggleCalendarAutoJoin(\'' + c.id + '\',this.checked)"> Auto-join' +
        '</label>' +
        '<label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-muted);cursor:pointer">' +
          '<input type="checkbox" ' + (c.enabled ? 'checked' : '') + ' onchange="toggleCalendarEnabled(\'' + c.id + '\',this.checked)"> Enabled' +
        '</label>' +
        '<button onclick="disconnectCalendar(\'' + c.id + '\')" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:11px;font-family:var(--font)">Disconnect</button>' +
      '</div>' +
    '</div>';
  }).join('');

  // Render settings detail for first connection
  if (connections.length > 0) {
    renderCalendarSettingsDetail(connections[0]);
  }
}

function renderCalendarSettingsDetail(conn) {
  const el = document.getElementById('calendar-settings-detail');
  el.innerHTML =
    '<div style="display:flex;flex-direction:column;gap:12px">' +
      '<div>' +
        '<label style="font-size:12px;font-weight:600;color:var(--text-primary);display:block;margin-bottom:4px">Filter by keywords (comma-separated)</label>' +
        '<input type="text" value="' + escapeHtml(conn.filter_keywords || '') + '" placeholder="e.g. behavioral, technical, phone screen" ' +
          'onchange="updateCalendarFilter(\'' + conn.id + '\',\'filter_keywords\',this.value)" ' +
          'style="width:100%;background:var(--bg-panel);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px;font-family:var(--font);font-size:13px;color:var(--text-primary)">' +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">Leave empty to join all meetings. Bot only joins meetings whose title contains one of these keywords.</div>' +
      '</div>' +
      '<div>' +
        '<label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-primary);cursor:pointer">' +
          '<input type="checkbox" ' + (conn.filter_external_only ? 'checked' : '') + ' onchange="updateCalendarFilter(\'' + conn.id + '\',\'filter_external_only\',this.checked)">' +
          ' Only join meetings with external attendees' +
        '</label>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">Skip internal team meetings — only join calls with people outside your company.</div>' +
      '</div>' +
    '</div>';
}

function renderUpcomingEvents(events) {
  const el = document.getElementById('upcoming-events');
  if (!events.length) {
    el.innerHTML = '<p style="color:var(--text-muted)">No upcoming meetings detected.</p>';
    return;
  }

  el.innerHTML = events.map(e => {
    const time = new Date(e.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const date = new Date(e.start_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const status = e.bot_sent ? '<span style="color:var(--green);font-weight:600">Bot sent</span>' : '<span style="color:var(--text-muted)">Pending</span>';

    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">' +
      '<div>' +
        '<div style="font-size:13px;color:var(--text-primary)">' + escapeHtml(e.title) + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted)">' + date + ' at ' + time + ' · ' + (e.provider || '') + '</div>' +
      '</div>' +
      '<div>' + status + '</div>' +
    '</div>';
  }).join('');
}

async function connectGoogleCalendar() {
  try {
    const res = await fetch('/api/calendar/google/auth-url');
    const data = await res.json();
    if (data.error) { alert(data.error); return; }
    window.open(data.url, 'google-auth', 'width=500,height=600');
    // Poll for connection after auth
    setTimeout(() => loadCalendarSettings(), 5000);
    setTimeout(() => loadCalendarSettings(), 10000);
    setTimeout(() => loadCalendarSettings(), 15000);
  } catch (e) { alert('Failed to start Google Calendar connection'); }
}

async function connectOutlookCalendar() {
  try {
    const res = await fetch('/api/calendar/outlook/auth-url');
    const data = await res.json();
    if (data.error) { alert(data.error); return; }
    window.open(data.url, 'outlook-auth', 'width=500,height=600');
    setTimeout(() => loadCalendarSettings(), 5000);
    setTimeout(() => loadCalendarSettings(), 10000);
    setTimeout(() => loadCalendarSettings(), 15000);
  } catch (e) { alert('Failed to start Outlook Calendar connection'); }
}

async function toggleCalendarAutoJoin(id, enabled) {
  await fetch('/api/calendar/connections/' + id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auto_join: enabled })
  });
}

async function toggleCalendarEnabled(id, enabled) {
  await fetch('/api/calendar/connections/' + id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled })
  });
}

async function updateCalendarFilter(id, field, value) {
  const body = {};
  body[field] = value;
  await fetch('/api/calendar/connections/' + id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function disconnectCalendar(id) {
  if (!confirm('Disconnect this calendar? The bot will no longer auto-join meetings.')) return;
  await fetch('/api/calendar/connections/' + id, { method: 'DELETE' });
  loadCalendarSettings();
}
