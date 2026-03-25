// Interview Coach — Main Server
// Express + WebSocket server that ties together all modules

require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const KnowledgeBase = require('./lib/knowledge');
const CoachingAI = require('./lib/claude');
const DeepgramProxy = require('./lib/deepgram-raw');
const SkribbyBot = require('./lib/skribby');
const LocalModel = require('./lib/local-model');
const { MeddpiccExtractor, MEDDPICC_SCHEMA } = require('./lib/meddpicc-extractor');
const CallHistory = require('./lib/database');
const KeywordManager = require('./lib/keyword-manager');

// ─── INIT ──────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// WebSocket keepalive — ping every 25 seconds to prevent Railway/proxy from killing idle connections
const WS_PING_INTERVAL = setInterval(() => {
  wss.clients.forEach((client) => {
    if (client.isAlive === false) {
      console.log('[WS] Client failed ping — terminating');
      return client.terminate();
    }
    client.isAlive = false;
    client.ping();
  });
}, 25000);

wss.on('close', () => clearInterval(WS_PING_INTERVAL));

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

// Helper: Extract the most relevant excerpt from a chunk instead of dumping raw text
// Finds sentences containing key terms from the query, returns a focused excerpt
function _extractExcerpt(chunkText, queryText, maxLen = 300) {
  const sentences = chunkText.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 10);
  if (sentences.length <= 2) return chunkText.slice(0, maxLen);

  // Score each sentence by overlap with query terms
  const queryWords = new Set(
    (queryText || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3)
  );

  const scored = sentences.map((s, i) => {
    const words = s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
    let score = 0;
    // Boost sentences with numbers/stats (most actionable for sales)
    if (/\d+%|\$[\d,]+|\d+\s*(x|times|reduction|increase|savings|months?|years?)/i.test(s)) score += 3;
    // Boost by query term overlap
    for (const w of words) {
      if (queryWords.has(w)) score += 1;
      for (const qw of queryWords) {
        if (w.includes(qw) || qw.includes(w)) score += 0.5;
      }
    }
    return { sentence: s, score, index: i };
  });

  scored.sort((a, b) => b.score - a.score);

  // Take top 2-3 sentences, reorder by original position
  const topSentences = scored.slice(0, 3).sort((a, b) => a.index - b.index);
  let excerpt = topSentences.map(s => s.sentence).join(' ');

  if (excerpt.length > maxLen) excerpt = excerpt.slice(0, maxLen - 3) + '...';
  return excerpt;
}

// Helper: Simple text similarity using word overlap (Jaccard-like)
// Returns 0-1 where 1 = identical content
function _textSimilarity(textA, textB) {
  if (!textA || !textB) return 0;
  const wordsA = new Set(textA.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(textB.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) { if (wordsB.has(w)) overlap++; }
  return overlap / Math.max(wordsA.size, wordsB.size);
}

// Initialize modules
const callHistory = new CallHistory(process.env.DATABASE_URL);
const kb = new KnowledgeBase(DATA_DIR, callHistory.pool);
const ai = new CoachingAI(process.env.ANTHROPIC_API_KEY);
const dgProxy = new DeepgramProxy(process.env.DEEPGRAM_API_KEY);
const skribby = process.env.SKRIBBY_API_KEY ? new SkribbyBot(process.env.SKRIBBY_API_KEY) : null;
const localModel = new LocalModel();

// Feed playbook content into local model for smarter relevance scoring
setTimeout(() => { localModel.loadPlaybookTerms(kb); }, 3000);

// Initialize deals module (shares the same pool as callHistory)
const Deals = require('./lib/deals');
const deals = new Deals(callHistory.pool);
const keywordMgr = new KeywordManager(callHistory.pool, process.env.ANTHROPIC_API_KEY);

// Calendar integration
const CalendarIntegration = require('./lib/calendar');
const calendar = new CalendarIntegration(callHistory.pool);

// Track active WebSocket clients for calendar auto-join
const activeClients = new Set();

// Active calendar sessions — run server-side without browser
const calendarSessions = new Map(); // botId -> { callId, transcript, scorecard, coachingLog, meddpiccExtractor, etc }
const desktopSessions = new Map();  // sessionId -> { ws, attachedBrowserWs }

// Start calendar polling if credentials are configured
if (process.env.SKRIBBY_API_KEY) {
  calendar.onBotRequest(async (meeting) => {
    console.log('[Calendar] Auto-sending bot to:', meeting.title, meeting.meetingUrl);
    if (!skribby) return;

    // Initialize session state
    const session = {
      callId: null,
      botId: null,
      meeting,
      fullTranscript: '',
      recentTranscript: '',
      coachingLog: [],
      scorecard: {
        situation_context: 'empty', actions_taken: 'empty', results_impact: 'empty',
        skills_demonstrated: 'empty', company_knowledge: 'empty', questions_asked: 'empty', red_flags: 'empty'
      },
      meddpiccExtractor: null,
      meddpiccData: {},
      startTime: Date.now(),
      attachedWs: null,
      speakerMap: {},
      shownChunks: new Set(),
      lastAiCoachingTime: 0,
      lastAiCoachingText: ''
    };

    // Create call in database
    const prospectName = (meeting.attendees || []).filter(a => !a.self).map(a => a.name).join(', ') || meeting.title;
    session.callId = await callHistory.startCall(prospectName, '');

    // Start MEDDPICC extractor
    session.meddpiccExtractor = new MeddpiccExtractor(process.env.ANTHROPIC_API_KEY);
    session.meddpiccExtractor.start(
      (extractedData) => {
        session.meddpiccData = extractedData;
        for (const [field, subFields] of Object.entries(extractedData)) {
          const filledCount = Object.values(subFields).filter(v => v !== null).length;
          const totalCount = Object.keys(subFields).length;
          if (filledCount === 0) session.scorecard[field] = 'empty';
          else if (filledCount >= totalCount) session.scorecard[field] = 'complete';
          else session.scorecard[field] = 'partial';
        }
        // Forward to attached browser if any
        if (session.attachedWs && session.attachedWs.readyState === 1) {
          session.attachedWs.send(JSON.stringify({ type: 'scorecard_update', scorecard: session.scorecard }));
          session.attachedWs.send(JSON.stringify({ type: 'meddpicc_data', data: extractedData }));
        }
      },
      (error) => console.error('[Calendar Scorecard] Error:', error.message)
    );

    // Create bot
    const bot = await skribby.createBot(
      meeting.meetingUrl,
      'Call Coach',
      // onTranscript
      (transcriptData) => {
        const text = transcriptData.text;
        const speaker = transcriptData.speaker;
        session.fullTranscript += (speaker ? speaker + ': ' : '') + text + '\n';
        session.recentTranscript += text + ' ';

        // Keep recent to 500 words
        const words = session.recentTranscript.split(/\s+/);
        if (words.length > 500) session.recentTranscript = words.slice(-500).join(' ');

        // Feed MEDDPICC
        if (session.meddpiccExtractor) {
          session.meddpiccExtractor.addTranscript((speaker ? speaker + ': ' : '') + text);
        }

        // Forward to attached browser
        if (session.attachedWs && session.attachedWs.readyState === 1) {
          session.attachedWs.send(JSON.stringify({
            type: 'transcript',
            text: text,
            isFinal: true,
            confidence: 1,
            speaker: speaker,
            speakerId: null
          }));
        }

        // ── SERVER-SIDE COACHING (runs with or without browser) ──
        (async () => {
          try {
            // Local model classification — use recent context, not just single utterance
            const calClassifyText = session.recentTranscript.split(/\s+/).slice(-200).join(' ') || text;
            const classification = await localModel.classify(calClassifyText);

            // Update scorecard from classification
            if (classification.meddpiccField && classification.relevance > 0.4 &&
                session.scorecard[classification.meddpiccField] === 'empty') {
              session.scorecard[classification.meddpiccField] = 'partial';
              if (session.attachedWs && session.attachedWs.readyState === 1) {
                session.attachedWs.send(JSON.stringify({ type: 'scorecard_update', scorecard: session.scorecard }));
              }
            }

            // Keyword detection
            const kwMatches = keywordMgr.match(text, 'behavioral');
            for (const coaching of kwMatches) {
              if (coaching.field && session.scorecard[coaching.field] === 'empty') {
                session.scorecard[coaching.field] = 'partial';
              }
              coaching.relevance = classification.relevance;
              session.coachingLog.push(coaching);
            }

            // Knowledge base search — use recent transcript for better semantic matching
            const calSearchQuery = session.recentTranscript.split(/\s+/).slice(-100).join(' ') || text;
            const knowledgeResults = await kb.search(calSearchQuery, 3);
            if (knowledgeResults.length > 0 && knowledgeResults[0].score > 2.5) {
              const topResult = knowledgeResults[0];
              const hasSpecificData = /\d+%|\$[\d,]+|\d+\s*(x|times|percent|reduction|increase|improvement|savings|roi)/i.test(topResult.text);
              const highConfidence = topResult.score > 4;
              const chunkKey = topResult.fileId + ':' + topResult.index;
              if ((hasSpecificData || highConfidence) && !session.shownChunks.has(chunkKey)) {
                session.shownChunks.add(chunkKey);
                const cardText = _extractExcerpt(topResult.text, text);
                const coaching = {
                  tier: 2,
                  text: cardText,
                  source: 'knowledge',
                  sourceFile: topResult.source,
                  section: topResult.section,
                  layer: topResult.layer,
                  timestamp: new Date().toISOString(),
                  color: topResult.layer === 'prospect' ? '#0EA5E9' : '#8B5CF6'
                };
                session.coachingLog.push(coaching);
                if (session.attachedWs && session.attachedWs.readyState === 1) {
                  session.attachedWs.send(JSON.stringify({ type: 'coaching', data: coaching }));
                }
              }

              // Deep AI coaching on high-relevance moments
              if ((classification.relevance > 0.6 || knowledgeResults[0].score > 3.5) &&
                  session.recentTranscript.split(/\s+/).length > 15) {
                const calNow = Date.now();
                if (calNow - session.lastAiCoachingTime >= 15000) {
                  if (session.attachedWs && session.attachedWs.readyState === 1) {
                    session.attachedWs.send(JSON.stringify({ type: 'ai_thinking', active: true }));
                  }
                  const coaching = await ai.generateCoaching(session.recentTranscript, knowledgeResults, session.scorecard, 'behavioral', null);
                  if (session.attachedWs && session.attachedWs.readyState === 1) {
                    session.attachedWs.send(JSON.stringify({ type: 'ai_thinking', active: false }));
                  }
                  if (coaching) {
                    const sim = _textSimilarity(coaching.text, session.lastAiCoachingText);
                    if (sim <= 0.3) {
                      session.lastAiCoachingTime = Date.now();
                      session.lastAiCoachingText = coaching.text;
                      session.coachingLog.push(coaching);
                      if (session.attachedWs && session.attachedWs.readyState === 1) {
                        session.attachedWs.send(JSON.stringify({ type: 'coaching', data: coaching }));
                      }
                    } else {
                      console.log('[Calendar Coaching] Skipped — similar to last (sim=' + sim.toFixed(2) + ')');
                    }
                  }
                }
              }
            } else if (classification.relevance > 0.7 && session.recentTranscript.split(/\s+/).length > 15) {
              const calNow2 = Date.now();
              if (calNow2 - session.lastAiCoachingTime >= 15000) {
                const fallbackResults = await kb.search(session.recentTranscript.slice(-500), 3);
                if (session.attachedWs && session.attachedWs.readyState === 1) {
                  session.attachedWs.send(JSON.stringify({ type: 'ai_thinking', active: true }));
                }
                const coaching = await ai.generateCoaching(session.recentTranscript, fallbackResults, session.scorecard, 'behavioral', null);
                if (session.attachedWs && session.attachedWs.readyState === 1) {
                  session.attachedWs.send(JSON.stringify({ type: 'ai_thinking', active: false }));
                }
                if (coaching) {
                  const sim2 = _textSimilarity(coaching.text, session.lastAiCoachingText);
                  if (sim2 <= 0.3) {
                    session.lastAiCoachingTime = Date.now();
                    session.lastAiCoachingText = coaching.text;
                    session.coachingLog.push(coaching);
                    if (session.attachedWs && session.attachedWs.readyState === 1) {
                      session.attachedWs.send(JSON.stringify({ type: 'coaching', data: coaching }));
                    }
                  }
                }
              }
            }
          } catch (err) {
            console.error('[Calendar Coaching] Error:', err.message);
          }
        })();
      },
      // onStatus
      (status) => {
        console.log('[Calendar Bot] Status:', status.type);
        // Cache speaker map on session so it's available when browser attaches later
        if (status.type === 'speaker_identified' && status.speakerMap) {
          session.speakerMap = { ...session.speakerMap, ...status.speakerMap };
          console.log('[Calendar Bot] Updated speakerMap:', JSON.stringify(session.speakerMap));
        }
        if (session.attachedWs && session.attachedWs.readyState === 1) {
          session.attachedWs.send(JSON.stringify({ type: 'bot_status', data: status }));
        }
      },
      // onError
      (error) => {
        console.error('[Calendar Bot] Error:', error.message);
      }
    );

    if (bot) {
      session.botId = bot.id;
      calendarSessions.set(bot.id, session);
      console.log('[Calendar] Session created:', bot.id, 'call:', session.callId);

      // Notify any connected browsers
      for (const c of activeClients) {
        if (c.readyState === 1) {
          console.log('[Calendar] Notifying connected browser of active session:', bot.id);
          c.send(JSON.stringify({
            type: 'calendar_call_active',
            data: {
              botId: bot.id,
              callId: session.callId,
              title: meeting.title,
              meetingUrl: meeting.meetingUrl,
              attendees: meeting.attendees,
              startTime: session.startTime
            }
          }));
        }
      }

      // Update calendar event
      await callHistory.pool.query(
        'UPDATE calendar_events SET bot_id = $1, call_id = $2 WHERE calendar_id = $3 AND event_id = $4',
        [bot.id, session.callId, meeting.calendarId, meeting.eventId]
      ).catch(() => {});
    }
  });

  calendar.startPolling(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.OUTLOOK_CLIENT_ID,
    process.env.OUTLOOK_CLIENT_SECRET
  );
}

// API endpoint to list active calendar sessions and attach to one
app.get('/api/calendar/active-sessions', (req, res) => {
  const sessions = [];
  for (const [botId, s] of calendarSessions) {
    sessions.push({
      botId,
      callId: s.callId,
      title: s.meeting.title,
      meetingUrl: s.meeting.meetingUrl,
      startTime: s.startTime,
      transcriptLength: s.fullTranscript.length,
      scorecard: s.scorecard
    });
  }
  res.json({ sessions });
});

// File upload config
const playbookUpload = multer({
  dest: path.join(DATA_DIR, 'playbook'),
  limits: { fileSize: 20 * 1024 * 1024 }
});
const prospectUpload = multer({
  dest: path.join(DATA_DIR, 'prospect'),
  limits: { fileSize: 20 * 1024 * 1024 }
});
const dealAssetUpload = multer({
  dest: path.join(DATA_DIR, 'deal-assets'),
  limits: { fileSize: 20 * 1024 * 1024 }
});

// ─── MIDDLEWARE ─────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  }
}));

// ─── API ROUTES ────────────────────────────────────

// --- Playbook (Layer 1) ---

app.get('/api/playbook', (req, res) => {
  res.json({ files: kb.getPlaybookFiles(), stats: kb.getStats().playbook });
});

app.post('/api/playbook/upload', playbookUpload.array('files', 20), async (req, res) => {
  try {
    const section = req.body.section || 'company_overview';
    const results = [];
    for (const file of req.files) {
      const entry = await kb.addPlaybookFile(file.path, file.originalname, section);
      results.push(entry);

      // Auto-mine keywords from uploaded playbook content in background
      if (entry.chunkCount > 0) {
        const chunks = kb.getChunksForFile(entry.id);
        if (chunks && chunks.length > 0) {
          const content = chunks.map(c => c.text).join('\n');
          keywordMgr.minePlaybookContent(content, file.originalname).then(extracted => {
            if (extracted.length > 0) {
              keywordMgr.bulkAdd(extracted, 'playbook-mined').then(added => {
                console.log('[Keywords] Auto-mined', added.length, 'keywords from', file.originalname);
              });
            }
          }).catch(e => console.error('[Keywords] Auto-mine failed:', e.message));
        }
      }
    }
    res.json({ uploaded: results, stats: kb.getStats().playbook });
    // Refresh local model's playbook terms
    localModel.loadPlaybookTerms(kb);
  } catch (error) {
    console.error('Playbook upload error:', error);
    res.status(500).json({ error: 'Upload failed: ' + error.message });
  }
});

app.delete('/api/playbook/:fileId', (req, res) => {
  kb.removePlaybookFile(req.params.fileId);
  res.json({ success: true, stats: kb.getStats().playbook });
});

// Clear ALL prep docs (full reset for new interview)
app.delete('/api/playbook', async (req, res) => {
  const files = kb.getPlaybookFiles();
  const keepResume = req.query.keepResume === 'true';
  let removed = 0;
  for (const file of files) {
    if (keepResume && file.section === 'resume') continue;
    await kb.removePlaybookFile(file.id);
    removed++;
  }
  // Reset quick answers in memory
  quickAnswers = [];
  res.json({ success: true, removed, keepResume });
});

// --- Prospect Intel (Layer 2) ---

app.get('/api/prospect', (req, res) => {
  res.json({ files: kb.getProspectFiles(), stats: kb.getStats().prospect });
});

app.post('/api/prospect/upload', prospectUpload.array('files', 20), async (req, res) => {
  try {
    const results = [];
    for (const file of req.files) {
      const entry = await kb.addProspectFile(file.path, file.originalname);
      results.push(entry);
    }
    res.json({ uploaded: results, stats: kb.getStats().prospect });
  } catch (error) {
    console.error('Prospect upload error:', error);
    res.status(500).json({ error: 'Upload failed: ' + error.message });
  }
});

app.delete('/api/prospect/clear', (req, res) => {
  kb.clearProspectIntel();
  res.json({ success: true });
});

// --- Call History ---

app.get('/api/calls', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const calls = await callHistory.listCalls(limit, offset);
  const stats = await callHistory.getStats();
  res.json({ calls, stats });
});

app.get('/api/calls/:id', async (req, res) => {
  const call = await callHistory.getCall(req.params.id);
  if (!call) return res.status(404).json({ error: 'Call not found' });
  res.json(call);
});

app.get('/api/calls/search/:query', async (req, res) => {
  const calls = await callHistory.searchCalls(req.params.query);
  res.json({ calls });
});

app.delete('/api/calls/:id', async (req, res) => {
  await callHistory.deleteCall(req.params.id);
  res.json({ success: true });
});

// Assign a call to a deal after the fact (links + merges intel)
app.post('/api/calls/:id/assign-deal', async (req, res) => {
  try {
    const callId = req.params.id;
    const dealId = req.body.deal_id;
    if (!dealId) return res.status(400).json({ error: 'deal_id required' });

    // Link call to deal
    await deals.linkCallToDeal(callId, dealId);

    // Get the call data
    const call = await callHistory.getCall(callId);
    if (!call) return res.status(404).json({ error: 'Call not found' });

    // Extract intel from transcript if not already done
    let meddpiccData = call.meddpicc_extracted || {};
    let painPoints = call.pain_points_extracted || [];
    let stakeholders = call.stakeholders_extracted || [];

    // If no extracted data, run extraction now
    if (Object.keys(meddpiccData).length === 0 && call.transcript) {
      console.log('[API] Running intel extraction for retroactive deal assignment');
      const intel = await ai.extractCallIntel(call.transcript);
      painPoints = intel.pain_points || [];
      stakeholders = intel.stakeholders || [];

      // Save extracted data to the call record
      await callHistory.pool.query(
        'UPDATE calls SET pain_points_extracted = $1, stakeholders_extracted = $2 WHERE id = $3',
        [JSON.stringify(painPoints), JSON.stringify(stakeholders), callId]
      ).catch(() => {});
    }

    // Merge into deal
    await deals.mergeCallIntel(dealId, {
      callId,
      meddpicc: meddpiccData,
      painPoints,
      stakeholders,
      competitiveIntel: {}
    });

    console.log('[API] Call', callId, 'assigned to deal', dealId, 'with intel merge');
    res.json({ success: true });
  } catch (error) {
    console.error('[API] Assign deal failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// --- Knowledge Base Search (for testing) ---

app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Query required' });
  const results = await kb.search(query);
  res.json({ results });
});

// Backfill embeddings for existing chunks that were stored before pgvector
app.post('/api/knowledge/backfill', async (req, res) => {
  try {
    const result = await kb.backfillEmbeddings();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Vector search stats
app.get('/api/knowledge/stats', (req, res) => {
  res.json(kb.getStats());
});

// --- Style Profile (analyze candidate's speech patterns from transcripts) ---

app.post('/api/style-profile/generate', async (req, res) => {
  try {
    // Get all transcript chunks from the 'transcripts' playbook section
    const files = kb.getPlaybookFiles().filter(f => f.section === 'transcripts');
    if (files.length === 0) return res.status(400).json({ error: 'No transcripts uploaded. Upload past interview transcripts first.' });

    let allText = '';
    for (const file of files) {
      const chunks = kb.getChunksForFile(file.id);
      if (chunks) {
        allText += chunks.map(c => c.text).join('\n') + '\n\n---\n\n';
      }
    }

    if (allText.length < 200) return res.status(400).json({ error: 'Not enough transcript content to analyze.' });

    // Truncate to ~15k chars to fit in context
    if (allText.length > 15000) allText = allText.slice(0, 15000);

    const response = await ai.client.messages.create({
      model: ai.model,
      max_tokens: 1500,
      system: `You analyze interview transcripts to build a candidate's speech style profile. The transcripts contain both interviewer questions and candidate answers. The candidate's responses are the longer, more detailed answers — interviewers ask shorter questions.

Your job is to extract HOW the candidate naturally communicates so a coaching AI can give advice that sounds like them, not like a generic AI.

Return a clear, useful style profile. Be specific with examples from the transcripts.`,
      messages: [{
        role: 'user',
        content: `Analyze these interview transcripts and build my speaking style profile. Extract:

1. **NATURAL PHRASING** — How I start answers, transition between points, and wrap up. Quote 3-5 real phrases I use naturally.

2. **VOCABULARY LEVEL** — Am I formal/casual? Technical/conversational? Do I use jargon or plain language?

3. **STORY STRUCTURE** — How do I naturally tell stories? Do I set up context first or jump to action? Am I concise or detailed?

4. **FILLER PATTERNS** — Any verbal tics, hedging language, or filler words I lean on? (e.g., "you know", "like", "honestly", "so basically")

5. **STRENGTHS** — What do I do well in interviews? (e.g., concrete examples, good energy, strong closings)

6. **WEAKNESSES** — Where do I fall short? (e.g., rambling, not quantifying results, weak openings, not connecting to the role)

7. **COACHING NOTES** — 3-5 specific, actionable things the real-time coaching AI should remind me to do during live interviews, based on my actual patterns.

TRANSCRIPTS:
${allText}`
      }]
    });

    const profile = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    res.json({ profile, transcriptCount: files.length });
  } catch (error) {
    console.error('[StyleProfile] Generation error:', error.message);
    res.status(500).json({ error: 'Failed to generate style profile: ' + error.message });
  }
});

app.get('/api/style-profile', async (req, res) => {
  // Check if transcripts exist
  const files = kb.getPlaybookFiles().filter(f => f.section === 'transcripts');
  res.json({ transcriptCount: files.length, files: files.map(f => ({ id: f.id, name: f.name })) });
});

// --- Quick Answers (pre-loaded Q&A pairs for instant matching) ---

// In-memory store for quick answers (also persisted to playbook as JSON)
let quickAnswers = []; // [{id, question, answer, embedding}]

// Load quick answers from DB on startup
async function loadQuickAnswers() {
  const files = kb.getPlaybookFiles().filter(f => f.section === 'quick_answers');
  quickAnswers = [];
  for (const file of files) {
    const chunks = kb.getChunksForFile(file.id);
    if (chunks) {
      for (const chunk of chunks) {
        try {
          const parsed = JSON.parse(chunk.text);
          if (parsed.question && parsed.answer) {
            quickAnswers.push({ id: file.id + ':' + chunk.index, question: parsed.question, answer: parsed.answer });
          }
        } catch (e) {
          // Not JSON, skip
        }
      }
    }
  }
  console.log(`[QuickAnswers] Loaded ${quickAnswers.length} Q&A pairs`);
}
// Load after KB is ready (delayed)
setTimeout(loadQuickAnswers, 5000);

app.get('/api/quick-answers', (req, res) => {
  res.json({ answers: quickAnswers.map(qa => ({ id: qa.id, question: qa.question, answer: qa.answer })) });
});

// Upload a Q&A doc (DOCX, TXT, PDF, MD) — auto-parses Q: / A: pairs
app.post('/api/quick-answers/upload', playbookUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    // Extract text from the uploaded file
    let text = '';
    const ext = path.extname(req.file.originalname).toLowerCase();
    console.log(`[QuickAnswers] Upload: ${req.file.originalname} ext=${ext} size=${req.file.size}`);
    
    if (ext === '.docx') {
      try {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ path: req.file.path });
        text = result.value;
      } catch (docxErr) {
        console.error('[QuickAnswers] DOCX parse failed, trying as text:', docxErr.message);
        text = fs.readFileSync(req.file.path, 'utf-8');
      }
    } else if (ext === '.pdf') {
      try {
        const pdfParse = require('pdf-parse');
        const buf = fs.readFileSync(req.file.path);
        const result = await pdfParse(buf);
        text = result.text;
      } catch (pdfErr) {
        console.error('[QuickAnswers] PDF parse failed:', pdfErr.message);
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Could not read PDF. Try uploading as DOCX or TXT instead.' });
      }
    } else {
      text = fs.readFileSync(req.file.path, 'utf-8');
    }
    
    console.log(`[QuickAnswers] Extracted ${text.length} chars from ${ext} file`);

    // Parse Q&A pairs — look for lines starting with Q: and collect answer text until next Q:
    const lines = text.split('\n');
    const pairs = [];
    let currentQ = null;
    let currentA = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^Q:\s*/i.test(trimmed)) {
        // Save previous pair
        if (currentQ && currentA.length > 0) {
          const answerText = currentA.join(' ').replace(/^[""]|[""]$/g, '').trim();
          if (answerText.length > 20) {
            pairs.push({ question: currentQ, answer: answerText });
          }
        }
        currentQ = trimmed.replace(/^Q:\s*/i, '').trim();
        currentA = [];
      } else if (currentQ && trimmed.length > 0) {
        // Skip section headers, coaching notes, and short lines
        const isHeader = /^(Section \d|⚠️|Keep this|One sentence|IMPORTANT|Note:|Tip:)/i.test(trimmed);
        const isCoachingNote = trimmed.length < 60 && !/[.!]$/.test(trimmed) && !trimmed.startsWith('"');
        if (!isHeader && !isCoachingNote) {
          currentA.push(trimmed);
        }
      }
    }
    // Save last pair
    if (currentQ && currentA.length > 0) {
      const answerText = currentA.join(' ').replace(/^[""]|[""]$/g, '').trim();
      if (answerText.length > 20) {
        pairs.push({ question: currentQ, answer: answerText });
      }
    }

    if (pairs.length === 0) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'No Q&A pairs found. Use "Q:" to mark questions in your document.' });
    }

    // Clear existing quick answers first
    const existingFiles = kb.getPlaybookFiles().filter(f => f.section === 'quick_answers');
    for (const file of existingFiles) {
      await kb.removePlaybookFile(file.id);
    }

    // Store each Q&A pair as its own chunk (bypass text splitter so JSON stays intact)
    const chunks = pairs.map(p => JSON.stringify({ question: p.question, answer: p.answer }));
    const embedTexts = pairs.map(p => p.question); // Embed ONLY the question for matching
    await kb.addRawChunks(chunks, req.file.originalname, 'quick_answers', embedTexts);
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    // Reload
    await loadQuickAnswers();

    console.log(`[QuickAnswers] Parsed ${pairs.length} Q&A pairs from ${req.file.originalname}`);
    res.json({ success: true, count: pairs.length, pairs: pairs.map(p => ({ question: p.question, answer: p.answer.slice(0, 100) + '...' })) });
  } catch (error) {
    console.error('[QuickAnswers] Upload parse error:', error.message);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  }
});

// Manual add (single pair)
app.post('/api/quick-answers', express.json(), async (req, res) => {
  const { pairs } = req.body;
  if (!pairs || !Array.isArray(pairs) || pairs.length === 0) {
    return res.status(400).json({ error: 'Provide an array of {question, answer} pairs' });
  }

  try {
    const tmpPath = path.join(require('os').tmpdir(), 'qa_' + Date.now() + '.txt');
    const content = pairs.map(p => JSON.stringify({ question: p.question, answer: p.answer })).join('\n---SPLIT---\n');
    fs.writeFileSync(tmpPath, content);
    await kb.addPlaybookFile(tmpPath, 'Quick Answers', 'quick_answers');
    fs.unlinkSync(tmpPath);
    await loadQuickAnswers();
    res.json({ success: true, count: pairs.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/quick-answers', async (req, res) => {
  // Delete all quick answer files
  const files = kb.getPlaybookFiles().filter(f => f.section === 'quick_answers');
  for (const file of files) {
    await kb.removePlaybookFile(file.id);
  }
  quickAnswers = [];
  res.json({ success: true });
});

// Match transcript against quick answers using vector search
async function matchQuickAnswer(transcript) {
  if (quickAnswers.length === 0) return null;

  // Search ONLY the quick_answers section — not the whole KB
  try {
    const results = await kb.searchSection(transcript, 'quick_answers', 3);
    for (const r of results) {
      if (r.similarity > 0.50) {
        try {
          const parsed = JSON.parse(r.text);
          if (parsed.question && parsed.answer) {
            console.log(`[QuickAnswers] MATCH (sim=${r.similarity.toFixed(2)}): "${parsed.question.slice(0, 50)}"`);
            return { question: parsed.question, answer: parsed.answer, similarity: r.similarity };
          }
        } catch (e) {}
      }
    }
    if (results.length > 0) {
      console.log(`[QuickAnswers] No match — best sim=${results[0].similarity.toFixed(2)} text="${results[0].text.slice(0, 40)}..."`);
    }
  } catch (e) {
    console.error('[QuickAnswers] Match error:', e.message);
  }
  return null;
}

// --- Prep Doc Generator ---

app.post('/api/generate-prep', express.json({ limit: '1mb' }), async (req, res) => {
  const { company, industry, role, territory, stage, interviewers, jd } = req.body;
  if (!company || !role) return res.status(400).json({ error: 'Company and role are required' });

  console.log(`[PrepGen] Starting generation for ${company} — ${role}`);

  // Get resume context from KB
  const resumeFiles = kb.getPlaybookFiles().filter(f => f.section === 'resume');
  let resumeContext = '';
  for (const file of resumeFiles) {
    const chunks = kb.getChunksForFile(file.id);
    if (chunks) resumeContext += chunks.map(c => c.text).join('\n') + '\n';
  }

  // Get transcript context for voice matching
  const transcriptFiles = kb.getPlaybookFiles().filter(f => f.section === 'transcripts');
  let transcriptContext = '';
  for (const file of transcriptFiles) {
    const chunks = kb.getChunksForFile(file.id);
    if (chunks) transcriptContext += chunks.map(c => c.text).join('\n') + '\n';
  }
  if (transcriptContext.length > 8000) transcriptContext = transcriptContext.slice(0, 8000);

  const systemPrompt = `You are an elite enterprise SaaS interview strategist. Generate a comprehensive interview prep brief.

OUTPUT FORMAT: Return your response with clear section markers using exactly these headers:
===SECTION: QUICK_ANSWERS===
===SECTION: COMPANY_RESEARCH===
===SECTION: ROLE_DETAILS===
===SECTION: INDUSTRY_KNOWLEDGE===
===SECTION: TOUGH_QUESTIONS===
===SECTION: INTERVIEW_FRAMEWORK===
===SECTION: PRACTICE_ANSWERS===
===SECTION: COMPANY_NEWS===
===SECTION: ACHIEVEMENT_STORIES===

RULES:
- QUICK_ANSWERS section: Output Q&A pairs formatted as "Q: [question]" followed by the answer on the next lines. These are scripted answers the candidate will read verbatim during the interview. Write 10-15 pairs.
- All other sections: Write dense, actionable prep content. No filler.
- Use the candidate's resume and interview transcripts to personalize everything.
- Be specific to THIS company and role — no generic advice.
- For scripted answers, match the candidate's natural speaking style from the transcripts.`;

  const userPrompt = `Generate interview prep docs for:

COMPANY: ${company}
INDUSTRY: ${industry || 'Unknown — research it'}
ROLE: ${role}
TERRITORY TYPE: ${territory || 'Enterprise'}
INTERVIEW STAGE: ${stage || 'Hiring manager first round'}
INTERVIEWER(S): ${interviewers || 'Unknown'}
DATE: ${new Date().toISOString().split('T')[0]}

JOB DESCRIPTION:
${jd || 'Not provided — use web search and company research to infer role requirements.'}

CANDIDATE RESUME:
${resumeContext || 'No resume uploaded.'}

CANDIDATE INTERVIEW TRANSCRIPTS (for voice matching):
${transcriptContext || 'No transcripts uploaded.'}

Generate all 9 sections with the exact section headers specified. For QUICK_ANSWERS, format each pair as "Q: [question]" followed by the scripted answer.`;

  try {
    const response = await ai.client.messages.create({
      model: ai.model, // Use Sonnet for quality generation
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const fullText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');

    // Parse sections
    const sectionMap = {};
    const sectionNames = [
      'QUICK_ANSWERS', 'COMPANY_RESEARCH', 'ROLE_DETAILS', 'INDUSTRY_KNOWLEDGE',
      'TOUGH_QUESTIONS', 'INTERVIEW_FRAMEWORK', 'PRACTICE_ANSWERS', 'COMPANY_NEWS', 'ACHIEVEMENT_STORIES'
    ];

    for (let i = 0; i < sectionNames.length; i++) {
      const marker = `===SECTION: ${sectionNames[i]}===`;
      const nextMarker = i < sectionNames.length - 1 ? `===SECTION: ${sectionNames[i + 1]}===` : null;
      const startIdx = fullText.indexOf(marker);
      if (startIdx === -1) continue;
      const contentStart = startIdx + marker.length;
      const endIdx = nextMarker ? fullText.indexOf(nextMarker) : fullText.length;
      if (endIdx === -1) continue;
      sectionMap[sectionNames[i]] = fullText.slice(contentStart, endIdx).trim();
    }

    console.log(`[PrepGen] Parsed ${Object.keys(sectionMap).length} sections`);
    res.json({ success: true, sections: sectionMap });
  } catch (error) {
    console.error('[PrepGen] Generation error:', error.message);
    res.status(500).json({ error: 'Generation failed: ' + error.message });
  }
});

// Approve a generated section — stores it in the KB
app.post('/api/generate-prep/approve', express.json({ limit: '1mb' }), async (req, res) => {
  const { sectionId, content, company } = req.body;
  if (!sectionId || !content) return res.status(400).json({ error: 'sectionId and content required' });

  // Map section IDs to KB sections
  const kbSectionMap = {
    'QUICK_ANSWERS': 'quick_answers',
    'COMPANY_RESEARCH': 'company_overview',
    'ROLE_DETAILS': 'products_pricing',
    'INDUSTRY_KNOWLEDGE': 'competitive_intel',
    'TOUGH_QUESTIONS': 'objection_handling',
    'INTERVIEW_FRAMEWORK': 'discovery_framework',
    'PRACTICE_ANSWERS': 'talk_tracks',
    'COMPANY_NEWS': 'industry_intel',
    'ACHIEVEMENT_STORIES': 'case_studies'
  };

  const kbSection = kbSectionMap[sectionId];
  if (!kbSection) return res.status(400).json({ error: 'Unknown section: ' + sectionId });

  try {
    // For Quick Answers, parse Q&A pairs and store individually
    if (sectionId === 'QUICK_ANSWERS') {
      // Clear existing quick answers
      const existingFiles = kb.getPlaybookFiles().filter(f => f.section === 'quick_answers');
      for (const file of existingFiles) await kb.removePlaybookFile(file.id);

      // Parse Q: pairs
      const lines = content.split('\n');
      const pairs = [];
      let currentQ = null;
      let currentA = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (/^Q:\s*/i.test(trimmed)) {
          if (currentQ && currentA.length > 0) {
            const ans = currentA.join(' ').replace(/^[""]|[""]$/g, '').trim();
            if (ans.length > 20) pairs.push({ question: currentQ, answer: ans });
          }
          currentQ = trimmed.replace(/^Q:\s*/i, '').trim();
          currentA = [];
        } else if (currentQ && trimmed.length > 0) {
          currentA.push(trimmed);
        }
      }
      if (currentQ && currentA.length > 0) {
        const ans = currentA.join(' ').replace(/^[""]|[""]$/g, '').trim();
        if (ans.length > 20) pairs.push({ question: currentQ, answer: ans });
      }

      if (pairs.length > 0) {
        const chunks = pairs.map(p => JSON.stringify({ question: p.question, answer: p.answer }));
        const embedTexts = pairs.map(p => p.question);
        await kb.addRawChunks(chunks, `${company || 'Interview'} Quick Answers`, 'quick_answers', embedTexts);
        // Reload quick answers in memory
        await loadQuickAnswers();
      }

      res.json({ success: true, type: 'quick_answers', count: pairs.length });
    } else {
      // For all other sections, store as a single playbook file
      // Clear existing content for this section
      const existingFiles = kb.getPlaybookFiles().filter(f => f.section === kbSection);
      for (const file of existingFiles) await kb.removePlaybookFile(file.id);

      // Store the generated content
      const tmpPath = path.join(require('os').tmpdir(), 'prep_' + Date.now() + '.txt');
      fs.writeFileSync(tmpPath, content);
      await kb.addPlaybookFile(tmpPath, `${company || 'Interview'} — ${sectionId.replace(/_/g, ' ')}`, kbSection);
      fs.unlinkSync(tmpPath);

      res.json({ success: true, type: kbSection });
    }
  } catch (error) {
    console.error('[PrepGen] Approve error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// --- Deals ---

app.post('/api/deals', async (req, res) => {
  const deal = await deals.createDeal(req.body);
  if (!deal) return res.status(500).json({ error: 'Failed to create deal' });
  res.json(deal);
});

app.get('/api/deals', async (req, res) => {
  const list = await deals.listDeals();
  const stats = await deals.getStats();
  res.json({ deals: list, stats });
});

app.get('/api/deals/:id', async (req, res) => {
  const deal = await deals.getDeal(req.params.id);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });
  const assets = await deals.listAssets(req.params.id);
  const calls = await deals.getCallsForDeal(req.params.id);
  res.json({ ...deal, assets, calls });
});

app.patch('/api/deals/:id', async (req, res) => {
  const deal = await deals.updateDeal(req.params.id, req.body);
  if (!deal) return res.status(500).json({ error: 'Failed to update deal' });
  res.json(deal);
});

app.delete('/api/deals/:id', async (req, res) => {
  await deals.deleteDeal(req.params.id);
  res.json({ success: true });
});

app.post('/api/deals/:id/assets', dealAssetUpload.array('files', 10), async (req, res) => {
  try {
    const results = [];
    const assetType = req.body.asset_type || 'other';
    for (const file of req.files) {
      const entry = await kb.addPlaybookFile(file.path, file.originalname, 'deal_' + req.params.id);
      const asset = await deals.addAsset(req.params.id, file.originalname, assetType, file.path, entry.chunkCount);
      results.push(asset);
    }
    res.json({ uploaded: results });
  } catch (error) {
    res.status(500).json({ error: 'Upload failed: ' + error.message });
  }
});

app.delete('/api/deals/:id/assets/:assetId', async (req, res) => {
  await deals.removeAsset(req.params.assetId);
  res.json({ success: true });
});

app.get('/api/deals/:id/calls', async (req, res) => {
  const callsList = await deals.getCallsForDeal(req.params.id);
  res.json({ calls: callsList });
});

// Generate deal brief for pre-call
app.get('/api/deals/:id/brief', async (req, res) => {
  try {
    const deal = await deals.getDeal(req.params.id);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    const callType = req.query.call_type || 'behavioral';
    const brief = await ai.generateDealBrief(deal, callType);
    res.json(brief || { error: 'Failed to generate brief' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Generate forecast readiness for war room
app.get('/api/deals/:id/forecast', async (req, res) => {
  try {
    const deal = await deals.getDeal(req.params.id);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    const checklist = await ai.generateForecastReadiness(deal);
    res.json({ checklist });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Deal AI Chat — streaming response
app.post('/api/deals/:id/chat', async (req, res) => {
  try {
    const deal = await deals.getDeal(req.params.id);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    const dealCalls = await deals.getCallsForDeal(req.params.id);

    const callSummaries = dealCalls.map(c => {
      const date = new Date(c.started_at).toLocaleDateString();
      const type = (c.call_type || 'behavioral').replace('_', ' ');
      return `[${date} — ${type}]\n${c.summary || 'No summary'}\n`;
    }).join('\n');

    const recentTranscripts = [];
    for (const c of dealCalls.slice(0, 3)) {
      if (c.id) {
        const fullCall = await callHistory.getCall(c.id);
        if (fullCall && fullCall.transcript) {
          recentTranscripts.push(`[${new Date(c.started_at).toLocaleDateString()} — ${(c.call_type || 'behavioral').replace('_', ' ')}]\n${fullCall.transcript}`);
        }
      }
    }

    // Search playbook for content relevant to the question
    const playbookResults = await kb.search(req.body.question, 5);
    const playbookContext = playbookResults
      .filter(r => r.score > 1.5)
      .map(r => `[${r.source}] ${r.text}`)
      .join('\n\n');

    // Set up SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();

    await ai.dealChatStream(
      deal,
      callSummaries,
      recentTranscripts.join('\n\n---\n\n'),
      req.body.question,
      playbookContext,
      (token) => { res.write(`data: ${JSON.stringify({ token })}\n\n`); if (res.flush) res.flush(); },
      () => { res.write(`data: ${JSON.stringify({ done: true })}\n\n`); res.end(); }
    );
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }
  }
});

// --- Calendar Integration ---

const APP_URL = process.env.APP_URL || 'https://aidiscocoach-production.up.railway.app';

// Get Google OAuth URL
app.get('/api/calendar/google/auth-url', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(400).json({ error: 'Google Calendar not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to environment.' });
  const url = calendar.getGoogleAuthUrl(APP_URL + '/api/calendar/google/callback', process.env.GOOGLE_CLIENT_ID);
  res.json({ url });
});

// Google OAuth callback
app.get('/api/calendar/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No authorization code');
  const connection = await calendar.connectGoogle(
    code,
    APP_URL + '/api/calendar/google/callback',
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  if (connection) {
    res.send('<html><body style="background:#0f172a;color:white;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh"><div style="text-align:center"><h2>Google Calendar Connected!</h2><p>You can close this window.</p><script>window.close()</script></div></body></html>');
  } else {
    res.status(500).send('Failed to connect Google Calendar');
  }
});

// Get Outlook OAuth URL
app.get('/api/calendar/outlook/auth-url', (req, res) => {
  if (!process.env.OUTLOOK_CLIENT_ID) return res.status(400).json({ error: 'Outlook Calendar not configured. Add OUTLOOK_CLIENT_ID and OUTLOOK_CLIENT_SECRET to environment.' });
  const url = calendar.getOutlookAuthUrl(APP_URL + '/api/calendar/outlook/callback', process.env.OUTLOOK_CLIENT_ID);
  res.json({ url });
});

// Outlook OAuth callback
app.get('/api/calendar/outlook/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No authorization code');
  const connection = await calendar.connectOutlook(
    code,
    APP_URL + '/api/calendar/outlook/callback',
    process.env.OUTLOOK_CLIENT_ID,
    process.env.OUTLOOK_CLIENT_SECRET
  );
  if (connection) {
    res.send('<html><body style="background:#0f172a;color:white;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh"><div style="text-align:center"><h2>Outlook Calendar Connected!</h2><p>You can close this window.</p><script>window.close()</script></div></body></html>');
  } else {
    res.status(500).send('Failed to connect Outlook Calendar');
  }
});

// List calendar connections
app.get('/api/calendar/connections', async (req, res) => {
  const connections = await calendar.listConnections();
  res.json({ connections });
});

// Update connection settings
app.patch('/api/calendar/connections/:id', async (req, res) => {
  const result = await calendar.updateConnection(req.params.id, req.body);
  res.json({ success: !!result });
});

// Delete connection
app.delete('/api/calendar/connections/:id', async (req, res) => {
  const result = await calendar.deleteConnection(req.params.id);
  res.json({ success: !!result });
});

// Get upcoming events
app.get('/api/calendar/events', async (req, res) => {
  const events = await calendar.getUpcomingEvents();
  res.json({ events });
});

// --- Call Type Assets ---

const callTypeUpload = multer({
  dest: path.join(DATA_DIR, 'call-type-assets'),
  limits: { fileSize: 20 * 1024 * 1024 }
});

app.get('/api/call-types/:type/assets', (req, res) => {
  const files = kb.getPlaybookFiles().filter(f => f.section === 'calltype_' + req.params.type);
  res.json({ files });
});

app.post('/api/call-types/:type/assets', callTypeUpload.array('files', 20), async (req, res) => {
  try {
    const section = 'calltype_' + req.params.type;
    const subsection = req.body.subsection || 'assets'; // 'assets' or 'transcripts'
    const results = [];
    for (const file of req.files) {
      const entry = await kb.addPlaybookFile(file.path, file.originalname, section + '_' + subsection);
      results.push(entry);
    }
    res.json({ uploaded: results });
  } catch (error) {
    res.status(500).json({ error: 'Upload failed: ' + error.message });
  }
});

// --- Keywords ---

app.get('/api/keywords', async (req, res) => {
  const keywords = await keywordMgr.list();
  const stats = await keywordMgr.getStats();
  res.json({ keywords, stats });
});

app.post('/api/keywords', async (req, res) => {
  const kw = await keywordMgr.add(req.body);
  if (!kw) return res.status(500).json({ error: 'Failed to add keyword' });
  res.json(kw);
});

app.patch('/api/keywords/:id', async (req, res) => {
  await keywordMgr.update(req.params.id, req.body);
  res.json({ success: true });
});

app.delete('/api/keywords/:id', async (req, res) => {
  await keywordMgr.remove(req.params.id);
  res.json({ success: true });
});

app.patch('/api/keywords/:id/toggle', async (req, res) => {
  await keywordMgr.toggleEnabled(req.params.id, req.body.enabled);
  res.json({ success: true });
});

app.post('/api/keywords/extract-from-transcript', async (req, res) => {
  try {
    const extracted = await keywordMgr.extractFromTranscript(req.body.transcript, req.body.call_type);
    res.json({ keywords: extracted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/keywords/extract-and-add', async (req, res) => {
  try {
    const extracted = await keywordMgr.extractFromTranscript(req.body.transcript, req.body.call_type);
    const added = await keywordMgr.bulkAdd(extracted, 'ai-transcript');
    res.json({ extracted: extracted.length, added: added.length, keywords: added });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/keywords/mine-playbook', async (req, res) => {
  try {
    const extracted = await keywordMgr.minePlaybookContent(req.body.content, req.body.source);
    const added = await keywordMgr.bulkAdd(extracted, 'playbook-mined');
    res.json({ extracted: extracted.length, added: added.length, keywords: added });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Stats ---

app.get('/api/stats', async (req, res) => {
  res.json({
    knowledge: kb.getStats(),
    calls: await callHistory.getStats(),
    deals: await deals.getStats(),
    activeSessions: dgProxy.getActiveSessionCount(),
    localModel: localModel.getStatus()
  });
});

app.get('/api/meddpicc/schema', (req, res) => {
  res.json(MEDDPICC_SCHEMA);
});

// ─── WEBSOCKET HANDLING ────────────────────────────

wss.on('connection', (ws) => {
  console.log('[WS] New client connected');
  activeClients.add(ws);
  
  // Keepalive: mark connection as alive on pong
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Check for active calendar sessions and notify
  console.log('[WS] Checking for active calendar sessions:', calendarSessions.size);
  for (const [botId, s] of calendarSessions) {
    console.log('[WS] Sending calendar_call_active for bot:', botId);
    ws.send(JSON.stringify({
      type: 'calendar_call_active',
      data: {
        botId,
        callId: s.callId,
        title: s.meeting.title,
        meetingUrl: s.meeting.meetingUrl,
        attendees: s.meeting.attendees,
        startTime: s.startTime
      }
    }));
  }

  // Check for active desktop sessions and notify so browser can auto-attach
  for (const [dsSessionId, ds] of desktopSessions) {
    if (ds.ws && ds.ws.readyState === 1) {
      console.log('[WS] Sending desktop_session_available for session:', dsSessionId);
      ws.send(JSON.stringify({ type: 'desktop_session_available', sessionId: dsSessionId }));
    }
  }

  let sessionId = null;
  let callId = null;
  let activeBotId = null;
  let activeDealId = null;
  let activeCallType = 'behavioral';
  let activeDealBrief = null;
  let activeProspectName = '';
  let activeProspectCompany = '';
  let speakerMap = {}; // Maps speaker IDs to names (e.g., {0: "Dave (Rep)", 1: "Prospect"})
  let fullTranscript = '';
  let recentTranscript = ''; // Rolling window for AI coaching
  let coachingLog = [];
  let shownChunks = new Set(); // Dedup: track which KB chunks have been shown
  let lastAiCoachingTime = 0; // Rate limit: minimum gap between AI calls
  let lastAiCoachingText = ''; // Similarity: text of last AI coaching card
  let lastAiQuestion = ''; // Dedup: last question the AI answered
  let lastAnswerTime = 0; // Global lockout: timestamp of last answer sent (QA or AI)
  let lastSpeakerRole = null; // Track: 'candidate' or 'interviewer'
  let lastSpeakerId = null; // Track: speaker ID to detect speaker changes
  let candidateSpeakerId = null; // Track: which speaker ID is the candidate
  let answeredQuestions = new Set(); // Dedup: questions already answered
  let lastAnsweredTranscript = ''; // Track: transcript when AI last fired
  let dgReady = false; // Track if Deepgram session is ready
  let audioBuffer = []; // Buffer audio until Deepgram is ready
  let interviewerSessionId = null; // Second Deepgram session for system audio
  let dgInterviewerReady = false;
  let interviewerAudioBuffer = [];
  let interimBuffer = ''; // Cross-segment question accumulator (last ~30s of speech)
  let meddpiccExtractor = null;
  let scorecard = {
    situation_context: 'empty',
    actions_taken: 'empty',
    results_impact: 'empty',
    skills_demonstrated: 'empty',
    company_knowledge: 'empty',
    questions_asked: 'empty',
    red_flags: 'empty'
  };

  ws.on('message', async (message) => {
    try {
      // Try to parse as JSON text first
      const str = message.toString();
      if (str.startsWith('{')) {
        const msg = JSON.parse(str);
        console.log('[WS] Received message:', msg.type);

        switch (msg.type) {
          case 'ping':
            // Keepalive — just acknowledge, don't log
            break;
          case 'start_call': {
          // Close any existing Deepgram session before creating a new one
          if (sessionId) {
            console.log('[WS] Closing existing Deepgram session before new start_call');
            dgProxy.closeSession(sessionId);
          }
          sessionId = 'session_' + Date.now();
          callId = await callHistory.startCall(msg.prospectName, msg.prospectCompany);
          activeDealId = msg.dealId || null;
          activeCallType = msg.callType || 'behavioral';
          activeProspectName = msg.prospectName || '';
          activeProspectCompany = msg.prospectCompany || '';
          activeDealBrief = null;
          if (activeDealId) {
            await deals.linkCallToDeal(callId, activeDealId);
            // Generate deal brief in background
            ai.generateDealBrief(await deals.getDeal(activeDealId), activeCallType).then(brief => {
              if (brief) {
                activeDealBrief = JSON.stringify(brief);
                ws.send(JSON.stringify({ type: 'deal_brief', data: brief }));
              }
            }).catch(e => console.error('[DealBrief]', e.message));
          }
          fullTranscript = '';
          recentTranscript = '';
          coachingLog = [];
          shownChunks = new Set();
          lastAiCoachingTime = 0;
          lastAiCoachingText = '';
          dgReady = false;
          audioBuffer = [];
          interimBuffer = '';  // rolling window of recent speech for cross-segment question detection

          // Reset scorecard
          Object.keys(scorecard).forEach(k => scorecard[k] = 'empty');

          // Start MEDDPICC extractor
          meddpiccExtractor = new MeddpiccExtractor(process.env.ANTHROPIC_API_KEY);
          meddpiccExtractor.start(
            (extractedData) => {
              // Update scorecard based on extracted data
              for (const [field, subFields] of Object.entries(extractedData)) {
                const filledCount = Object.values(subFields).filter(v => v !== null).length;
                const totalCount = Object.keys(subFields).length;
                if (filledCount === 0) scorecard[field] = 'empty';
                else if (filledCount >= totalCount) scorecard[field] = 'complete';
                else scorecard[field] = 'partial';
              }
              ws.send(JSON.stringify({ type: 'scorecard_update', scorecard }));
              ws.send(JSON.stringify({ type: 'meddpicc_data', data: extractedData }));
              console.log('[Scorecard] Data updated, sent to client');
            },
            (error) => {
              console.error('[Scorecard] Error:', error.message);
            }
          );
          // Send schema to client
          ws.send(JSON.stringify({ type: 'meddpicc_schema', schema: MEDDPICC_SCHEMA }));

          // Create a single Deepgram session with the sample rate from the client
          const clientSampleRate = msg.sampleRate || 16000;
          console.log(`[WS] Starting call ${callId}, creating Deepgram session (sampleRate=${clientSampleRate})`);
          dgProxy.createSession(
            sessionId,
            (transcriptData) => {
              transcriptData.audioSource = 'interviewer';
              transcriptData.speaker = activeProspectName || 'Interviewer';
              handleTranscript(ws, transcriptData, scorecard);
            },
            (error) => {
              console.error('[Deepgram] Error:', error);
              ws.send(JSON.stringify({ type: 'error', message: error.message || String(error) }));
            },
            () => {
              console.log(`[Deepgram] Session ${sessionId} ready, flushing ${audioBuffer.length} buffered chunks`);
              dgReady = true;
              for (const chunk of audioBuffer) {
                dgProxy.sendAudio(sessionId, chunk);
              }
              audioBuffer = [];
            },
            { sampleRate: clientSampleRate }
          );

          ws.send(JSON.stringify({
            type: 'call_started',
            callId,
            sessionId,
            timestamp: new Date().toISOString()
          }));

          // Register desktop app sessions so browser can attach
          if (msg.source === 'desktop_app') {
            desktopSessions.set(sessionId, { ws, attachedBrowserWs: null });
            console.log('[Desktop] Registered session:', sessionId);
            // Broadcast to all OTHER connected clients (browser tabs) so they can auto-attach
            wss.clients.forEach((client) => {
              if (client !== ws && client.readyState === 1) {
                client.send(JSON.stringify({ type: 'desktop_session_available', sessionId }));
              }
            });
          }
          break;
        }

        case 'desktop_transcript': {
          // Swift binary transcribed directly via Deepgram and forwarded here
          const transcriptData = {
            text: msg.text,
            isFinal: msg.isFinal !== false,
            confidence: 0.99,
            speaker: msg.speaker || 'Interviewer',
            speakerId: 1,
            audioSource: 'interviewer'
          };
          handleTranscript(ws, transcriptData, scorecard);
          break;
        }

        case 'attach_desktop_session': {
          const ds = desktopSessions.get(msg.sessionId);
          if (!ds) {
            ws.send(JSON.stringify({ type: 'error', message: 'Desktop session not found. Start capturing first.' }));
            break;
          }
          ds.attachedBrowserWs = ws;
          console.log('[Desktop] Browser attached to session:', msg.sessionId);
          ws.send(JSON.stringify({ type: 'desktop_session_attached', sessionId: msg.sessionId }));
          ws.send(JSON.stringify({ type: 'call_started', callId: null, sessionId: msg.sessionId, timestamp: new Date().toISOString(), mode: 'desktop' }));
          break;
        }

        case 'start_bot_call': {
          // Skribby bot-based call — no mic capture needed
          if (!skribby) {
            ws.send(JSON.stringify({ type: 'error', message: 'Skribby not configured. Add SKRIBBY_API_KEY to environment.' }));
            break;
          }

          callId = await callHistory.startCall(msg.prospectName, msg.prospectCompany);
          activeDealId = msg.dealId || null;
          activeCallType = msg.callType || 'behavioral';
          activeProspectName = msg.prospectName || '';
          activeProspectCompany = msg.prospectCompany || '';
          activeDealBrief = null;
          if (activeDealId) {
            await deals.linkCallToDeal(callId, activeDealId);
            ai.generateDealBrief(await deals.getDeal(activeDealId), activeCallType).then(brief => {
              if (brief) {
                activeDealBrief = JSON.stringify(brief);
                ws.send(JSON.stringify({ type: 'deal_brief', data: brief }));
              }
            }).catch(e => console.error('[DealBrief]', e.message));
          }
          fullTranscript = '';
          recentTranscript = '';
          coachingLog = [];
          shownChunks = new Set();
          lastAiCoachingTime = 0;
          lastAiCoachingText = '';
          Object.keys(scorecard).forEach(k => scorecard[k] = 'empty');

          // Start MEDDPICC extractor
          meddpiccExtractor = new MeddpiccExtractor(process.env.ANTHROPIC_API_KEY);
          meddpiccExtractor.start(
            (extractedData) => {
              for (const [field, subFields] of Object.entries(extractedData)) {
                const filledCount = Object.values(subFields).filter(v => v !== null).length;
                const totalCount = Object.keys(subFields).length;
                if (filledCount === 0) scorecard[field] = 'empty';
                else if (filledCount >= totalCount) scorecard[field] = 'complete';
                else scorecard[field] = 'partial';
              }
              ws.send(JSON.stringify({ type: 'scorecard_update', scorecard }));
              ws.send(JSON.stringify({ type: 'meddpicc_data', data: extractedData }));
            },
            (error) => console.error('[Scorecard] Error:', error.message)
          );
          ws.send(JSON.stringify({ type: 'meddpicc_schema', schema: MEDDPICC_SCHEMA }));

          console.log(`[WS] Starting bot call ${callId} for meeting: ${msg.meetingUrl}`);

          const bot = await skribby.createBot(
            msg.meetingUrl,
            msg.botName || 'Call Coach',
            // onTranscript — real-time transcript from Skribby
            (transcriptData) => {
              const data = {
                text: transcriptData.text,
                isFinal: true,
                confidence: 1,
                speaker: transcriptData.speaker,
                fromBot: true // Flag so handleTranscript doesn't add speakerId
              };
              handleTranscript(ws, data, scorecard);
            },
            // onStatus — bot status updates
            (status) => {
              console.log('[Skribby] Status:', status.type);
              ws.send(JSON.stringify({ type: 'bot_status', data: status }));
            },
            // onError
            (error) => {
              console.error('[Skribby] Error:', error.message);
              ws.send(JSON.stringify({ type: 'error', message: error.message }));
            }
          );

          if (bot) {
            activeBotId = bot.id;
            ws.send(JSON.stringify({
              type: 'call_started',
              callId,
              botId: bot.id,
              mode: 'bot',
              timestamp: new Date().toISOString()
            }));
          } else {
            ws.send(JSON.stringify({ type: 'error', message: 'Failed to create bot' }));
          }
          break;
        }

        case 'end_call': {
          // Capture MEDDPICC data before stopping extractor
          const endedMeddpiccData = meddpiccExtractor ? meddpiccExtractor.getData() : {};
          // Stop MEDDPICC extractor
          if (meddpiccExtractor) {
            meddpiccExtractor.stop();
            meddpiccExtractor = null;
          }
          // Capture bot ID before stopping
          const endedBotId = activeBotId;
          // Stop Skribby bot if active
          if (activeBotId && skribby) {
            skribby.stopBot(activeBotId).catch(e => console.error('[Skribby] Stop error:', e.message));
            activeBotId = null;
          }
          if (sessionId) {
            dgProxy.closeSession(sessionId);
            sessionId = null;
          }
          if (interviewerSessionId) {
            dgProxy.closeSession(interviewerSessionId);
            interviewerSessionId = null;
            dgInterviewerReady = false;
          }

          // Send call_ended to UI immediately so it doesn't hang
          const endedCallId = callId;
          const endedTranscript = fullTranscript;
          const endedScorecard = { ...scorecard };
          const endedCoachingLog = [...coachingLog];
          const endedCallType = activeCallType;

          ws.send(JSON.stringify({
            type: 'call_ended',
            callId: endedCallId,
            scorecard: endedScorecard
          }));

          callId = null;

          // Generate summary, analysis, and save in background
          (async () => {
            try {
              const knowledgeResults = await kb.search(endedTranscript);
              const summary = await ai.generateCallSummary(endedTranscript, endedScorecard, knowledgeResults);

              // Save bot_id with the call
              if (endedBotId) {
                await callHistory.pool.query('UPDATE calls SET bot_id = $1 WHERE id = $2', [endedBotId, endedCallId]).catch(() => {});
              }

              await callHistory.endCall(endedCallId, {
                transcript: endedTranscript,
                scorecard: endedScorecard,
                summary,
                coachingLog: endedCoachingLog,
                notes: msg.notes || ''
              });

              // Send summary as a follow-up message
              ws.send(JSON.stringify({
                type: 'call_summary',
                callId: endedCallId,
                summary
              }));
              console.log('[WS] Call summary generated and saved for', endedCallId);

              // Generate call name
              ai.generateCallName(endedTranscript, activeProspectCompany, endedCallType).then(async (callName) => {
                await callHistory.pool.query('UPDATE calls SET call_name = $1 WHERE id = $2', [callName, endedCallId]).catch(() => {});
                console.log('[WS] Call named:', callName);
              }).catch(e => console.error('[WS] Call naming failed:', e.message));

              // Run call analysis (missed topics, score, action items, etc.) in background
              ai.analyzeCall(endedTranscript, endedMeddpiccData, endedCoachingLog, endedCallType).then(async (analysis) => {
                if (analysis) {
                  await callHistory.pool.query('UPDATE calls SET call_analysis = $1 WHERE id = $2', [JSON.stringify(analysis), endedCallId]).catch(() => {});
                  console.log('[WS] Call analysis saved for', endedCallId);
                }
              }).catch(e => console.error('[WS] Analysis failed:', e.message));

              // Fetch recording URL from Skribby with retries (processing takes time)
              if (endedBotId && skribby) {
                const fetchRecording = async (attempt) => {
                  try {
                    const botData = await skribby.getBot(endedBotId);
                    if (botData && botData.recording_url) {
                      await callHistory.pool.query('UPDATE calls SET recording_url = $1 WHERE id = $2', [botData.recording_url, endedCallId]).catch(() => {});
                      console.log('[WS] Recording URL saved for', endedCallId, '(attempt', attempt + ')');
                    } else if (attempt < 5) {
                      console.log('[WS] Recording not ready yet, retry', attempt + 1, 'in 15s');
                      setTimeout(() => fetchRecording(attempt + 1), 15000);
                    } else {
                      console.log('[WS] Recording URL not available after 5 attempts for', endedCallId);
                    }
                  } catch (e) {
                    console.error('[WS] Recording fetch failed:', e.message);
                    if (attempt < 5) setTimeout(() => fetchRecording(attempt + 1), 15000);
                  }
                };
                setTimeout(() => fetchRecording(1), 10000);
              }

              // Merge intel into deal if linked
              const endedDealId = activeDealId;
              if (endedDealId) {
                try {
                  // Extract pain points, stakeholders, competitive intel from transcript
                  console.log('[WS] Extracting call intel for deal', endedDealId);
                  const intel = await ai.extractCallIntel(endedTranscript);
                  console.log('[WS] Extracted:', (intel.pain_points || []).length, 'pains,', (intel.stakeholders || []).length, 'stakeholders');

                  // Get MEDDPICC data captured before extractor stopped
                  const meddpiccData = endedMeddpiccData || {};

                  await deals.mergeCallIntel(endedDealId, {
                    callId: endedCallId,
                    meddpicc: meddpiccData,
                    painPoints: intel.pain_points || [],
                    stakeholders: intel.stakeholders || [],
                    competitiveIntel: intel.competitive_intel || {}
                  });
                  console.log('[WS] Deal intel merged for', endedDealId);
                } catch (mergeErr) {
                  console.error('[WS] Deal merge failed:', mergeErr.message);
                }
              }
              activeDealId = null;
            } catch (e) {
              console.error('[WS] Summary generation failed:', e.message);
              // Still save the call without summary
              await callHistory.endCall(endedCallId, {
                transcript: endedTranscript,
                scorecard: endedScorecard,
                summary: 'Summary generation failed.',
                coachingLog: endedCoachingLog,
                notes: ''
              }).catch(() => {});
            }
          })();

          break;
        }

        case 'request_coaching': {
          // Manual trigger for Tier 3 coaching
          if (recentTranscript.length > 20) {
            const knowledgeResults = await kb.search(recentTranscript);
            const coaching = await ai.generateCoaching(recentTranscript, knowledgeResults, scorecard);
            if (coaching) {
              coachingLog.push(coaching);
              ws.send(JSON.stringify({ type: 'coaching', data: coaching }));
            }
          }
          break;
        }

        case 'add_note': {
          // Manual note during call
          if (msg.text) {
            coachingLog.push({
              tier: 0,
              text: msg.text,
              timestamp: new Date().toISOString(),
              source: 'manual'
            });
          }
          break;
        }

        case 'label_speaker': {
          // User labels a speaker ID (e.g., "Speaker 0 is me")
          if (msg.speakerId !== undefined && msg.label) {
            speakerMap[msg.speakerId] = msg.label;
            console.log('[WS] Speaker', msg.speakerId, 'labeled as', msg.label);
            ws.send(JSON.stringify({ type: 'speaker_labeled', speakerId: msg.speakerId, label: msg.label, speakerMap }));
          }
          break;
        }

        case 'attach_calendar_session': {
          // Attach browser to an active calendar bot session
          const botIdToAttach = msg.botId;
          const session = calendarSessions.get(botIdToAttach);
          if (!session) {
            ws.send(JSON.stringify({ type: 'error', message: 'Calendar session not found' }));
            break;
          }

          console.log('[WS] Attaching browser to calendar session:', botIdToAttach);
          session.attachedWs = ws;
          callId = session.callId;
          activeBotId = session.botId;
          activeCallType = msg.callType || 'behavioral';
          activeDealId = msg.dealId || null;
          activeProspectName = msg.prospectName || session.meeting.title;
          activeProspectCompany = msg.prospectCompany || '';
          fullTranscript = session.fullTranscript;
          recentTranscript = session.recentTranscript;
          coachingLog = session.coachingLog;
          scorecard = session.scorecard;
          meddpiccExtractor = session.meddpiccExtractor;

          // Link deal if provided
          if (activeDealId) {
            deals.linkCallToDeal(callId, activeDealId).catch(() => {});
          }

          // Send current state to browser
          ws.send(JSON.stringify({
            type: 'call_started',
            callId,
            botId: activeBotId,
            mode: 'calendar_bot',
            timestamp: new Date(session.startTime).toISOString()
          }));

          // Send full transcript so far
          if (session.fullTranscript) {
            const lines = session.fullTranscript.split('\n').filter(l => l.trim());
            for (const line of lines) {
              const parts = line.match(/^(.+?):\s*(.+)$/);
              if (parts) {
                ws.send(JSON.stringify({ type: 'transcript', text: parts[2], isFinal: true, confidence: 1, speaker: parts[1], speakerId: null }));
              } else {
                ws.send(JSON.stringify({ type: 'transcript', text: line, isFinal: true, confidence: 1, speaker: null, speakerId: null }));
              }
            }
          }

          // Send current scorecard and MEDDPICC data
          ws.send(JSON.stringify({ type: 'scorecard_update', scorecard: session.scorecard }));
          ws.send(JSON.stringify({ type: 'meddpicc_schema', schema: MEDDPICC_SCHEMA }));
          if (Object.keys(session.meddpiccData).length > 0) {
            ws.send(JSON.stringify({ type: 'meddpicc_data', data: session.meddpiccData }));
          }

          // Send speaker name map so browser can retroactively label transcript lines
          if (session.speakerMap && Object.keys(session.speakerMap).length > 0) {
            ws.send(JSON.stringify({ type: 'bot_status', data: { type: 'speaker_identified', speakerMap: session.speakerMap } }));
            console.log('[WS] Sent speakerMap to browser:', JSON.stringify(session.speakerMap));
          }

          // Send coaching history so browser shows past coaching cards
          if (session.coachingLog && session.coachingLog.length > 0) {
            for (const coaching of session.coachingLog) {
              ws.send(JSON.stringify({ type: 'coaching', data: coaching }));
            }
            console.log('[WS] Sent', session.coachingLog.length, 'coaching cards to browser');
          }

          console.log('[WS] Browser synced — transcript:', session.fullTranscript.length, 'chars, scorecard:', JSON.stringify(scorecard));
          break;
        }
      }
      } else {
        // Not JSON — binary audio data
        // Handle both tagged (0x01/0x02 prefix) and untagged raw audio
        const bytes = Buffer.isBuffer(message) ? message : Buffer.from(message);
        let audioData = bytes;
        
        // Strip prefix byte if present
        if (bytes.length > 1 && (bytes[0] === 0x01 || bytes[0] === 0x02)) {
          audioData = bytes.slice(1);
        }
        
        // Route audio to Deepgram
        if (sessionId && dgReady) {
          dgProxy.sendAudio(sessionId, audioData);
        } else if (sessionId) {
          audioBuffer.push(audioData);
          if (audioBuffer.length % 50 === 0) console.log(`[Audio] Buffering: ${audioBuffer.length} chunks (waiting for Deepgram)`);
        } else {
          // No session yet — drop audio
        }
      }
    } catch (e) {
      // Parse error or binary data — treat as mic audio
      if (sessionId && dgReady) {
        dgProxy.sendAudio(sessionId, message);
      } else if (sessionId) {
        audioBuffer.push(message);
      }
    }
  });

  // Handle transcript data from Deepgram
  // Send a message to the ws AND to any browser attached to this desktop session
  function sendToBrowserToo(ws, msg) {
    const str = typeof msg === 'string' ? msg : JSON.stringify(msg);
    if (ws.readyState === 1) ws.send(str);
    for (const ds of desktopSessions.values()) {
      if (ds.ws === ws && ds.attachedBrowserWs && ds.attachedBrowserWs.readyState === 1) {
        ds.attachedBrowserWs.send(str);
      }
    }
  }

  async function handleTranscript(ws, data, scorecard) {
    if (data.type === 'utterance_end') {
      ws.send(JSON.stringify({ type: 'utterance_end' }));
      return;
    }

    if (!data.text || data.text.trim() === '') return;

    // Resolve speaker name from map
    let speakerLabel = data.speaker || null;
    if (data.speakerId !== undefined && data.speakerId !== null && speakerMap[data.speakerId]) {
      speakerLabel = speakerMap[data.speakerId];
    }

    // Send transcript to client
    const transcriptMsg = JSON.stringify({
      type: 'transcript',
      text: data.text,
      isFinal: data.isFinal,
      confidence: data.confidence,
      speaker: speakerLabel,
      speakerId: data.fromBot ? null : (data.speakerId !== undefined ? data.speakerId : null)
    });
    ws.send(transcriptMsg);

    // Also forward to any browser attached to this desktop session
    for (const ds of desktopSessions.values()) {
      if (ds.ws === ws && ds.attachedBrowserWs && ds.attachedBrowserWs.readyState === 1) {
        ds.attachedBrowserWs.send(transcriptMsg);
      }
    }

    // Accumulate interim text into a sliding buffer for cross-segment question detection
    // This ensures questions split across multiple Deepgram segments are still caught
    if (!data.isFinal) {
      interimBuffer = (interimBuffer + ' ' + data.text).trim();
      // Keep interimBuffer to last ~50 words
      const ibWords = interimBuffer.split(/\s+/);
      if (ibWords.length > 50) interimBuffer = ibWords.slice(-50).join(' ');
      return;
    }

    // Final segment: merge interim buffer + final text for richer question detection
    const combinedText = (interimBuffer + ' ' + data.text).trim();
    interimBuffer = ''; // reset after final

    console.log(`[Transcript] Final: "${data.text.slice(0, 80)}" combined: "${combinedText.slice(0, 80)}" words_so_far=${recentTranscript.split(/\s+/).length}`);

    fullTranscript += data.text + ' ';
    recentTranscript += data.text + ' ';

    // Feed into MEDDPICC extractor
    if (meddpiccExtractor) {
      const speakerPrefix = data.speaker ? data.speaker + ': ' : '';
      meddpiccExtractor.addTranscript(speakerPrefix + data.text);
    }

    // Keep recent transcript to last ~500 words
    const words = recentTranscript.split(/\s+/);
    if (words.length > 500) {
      recentTranscript = words.slice(-500).join(' ');
    }

    // ── LOCAL MODEL: Classify transcript segment ──
    // Use last ~200 words for classification context (not just the single utterance)
    const classifyText = recentTranscript.split(/\s+/).slice(-200).join(' ') || data.text;
    const classification = await localModel.classify(classifyText);

    // Update MEDDPICC scorecard based on model classification
    if (classification.meddpiccField && classification.relevance > 0.4 &&
        scorecard[classification.meddpiccField] === 'empty') {
      scorecard[classification.meddpiccField] = 'partial';
      ws.send(JSON.stringify({ type: 'scorecard_update', scorecard }));
    }

    // Send classification to client for UI enrichment
    if (classification.category !== 'none' && classification.relevance > 0.3) {
      ws.send(JSON.stringify({
        type: 'classification',
        data: {
          category: classification.category,
          relevance: classification.relevance,
          meddpiccField: classification.meddpiccField,
          confidence: classification.confidence,
          source: classification.source,
          text: data.text.slice(0, 100)
        }
      }));
    }

    // ── TIER 1: Keyword Detection (via KeywordManager) ──
    const kwMatches = keywordMgr.match(data.text, activeCallType);
    for (const coaching of kwMatches) {
      // Update scorecard if applicable
      if (coaching.field && scorecard[coaching.field] === 'empty') {
        scorecard[coaching.field] = 'partial';
        ws.send(JSON.stringify({ type: 'scorecard_update', scorecard }));
      }
      coaching.relevance = classification.relevance;
      coachingLog.push(coaching);
      // Keywords fire silently — they trigger Claude but don't show in coaching feed
    }

    // ── COACHING TRIGGER ──
    // ONLY fire when the INTERVIEWER asks a new question.
    // NEVER fire when the CANDIDATE is speaking.
    
    const speakerId = data.speakerId !== undefined ? data.speakerId : null;
    
    // MOST RELIABLE: audioSource tag from dual-stream capture
    // 'candidate' = mic input, 'interviewer' = system/tab audio
    const audioSource = data.audioSource || null;
    
    // Label-based detection (fallback for bot mode)
    const labelLower = (speakerLabel || '').toLowerCase();
    const isLabeledCandidate = labelLower.includes('you') || labelLower.includes('rep') || 
      labelLower.includes('(me)') || labelLower.includes('dave') || 
      labelLower.includes('candidate') || labelLower.includes('davante');
    
    // Named speakers from meeting = interviewer (bot mode only)
    const isNamedSpeaker = speakerLabel && !/^speaker\s*\d/i.test(speakerLabel) && !isLabeledCandidate;
    
    // Set candidateSpeakerId when identified
    if (isLabeledCandidate && speakerId !== null) candidateSpeakerId = speakerId;
    
    // Determine who's speaking using all available signals
    const isCandidateSpeaking = 
      audioSource === 'candidate' ||  // dual-stream: mic = candidate (most reliable)
      isLabeledCandidate || 
      (candidateSpeakerId !== null && speakerId === candidateSpeakerId);
    
    const isInterviewer = 
      audioSource === 'interviewer' ||  // dual-stream: system audio = interviewer (most reliable)
      isNamedSpeaker || 
      (speakerLabel === activeProspectName && activeProspectName);
    
    // Track speaker changes
    const speakerChanged = speakerId !== null && speakerId !== lastSpeakerId;
    if (speakerId !== null) lastSpeakerId = speakerId;
    
    // If candidate is speaking and NOT the interviewer, do NOT fire coaching
    if (isCandidateSpeaking && !isInterviewer) return;
    
    // If we can't tell who's speaking (unlabeled Speaker N in bot mode), 
    // only fire on clear question patterns
    const unknownSpeaker = !isCandidateSpeaking && !isInterviewer;
    
    console.log(`[Coaching] Speaker: "${speakerLabel || '?'}" candidate=${isCandidateSpeaking} interviewer=${isInterviewer} unknown=${unknownSpeaker}`);
    
    // From here, it's the interviewer speaking
    const searchQuery = recentTranscript.split(/\s+/).slice(-100).join(' ') || data.text;
    const wordCount = recentTranscript.split(/\s+/).length;
    
    // Detect if this utterance contains a question
    // Use combinedText (interim + final) for question detection — catches split questions
    const looksLikeQuestion = /\?\s*$/.test(combinedText.trim()) || 
      /\b(tell me|walk me|describe|explain|how do you|what is|why did|can you|could you|what would|where do|talk about|what does|what made|what kind|what are|how would|have you ever|give me an example|share an example|what experience)\b/i.test(combinedText);
    
    // Dedup: fingerprint the combined window, not just the final segment
    const questionFingerprint = combinedText.trim().toLowerCase().replace(/[^a-z ]/g, '').slice(0, 80);
    if (!answeredQuestions) answeredQuestions = new Set();
    
    // Global lockout: after ANY answer fires (QA or AI), block everything for 15 seconds
    const now = Date.now();
    if (now - lastAnswerTime < 15000) {
      console.log(`[Coaching] BLOCKED — lockout (${Math.round((15000 - (now - lastAnswerTime))/1000)}s remaining)`);
      return;
    }
    
    const shouldFire = looksLikeQuestion && wordCount > 10 && !answeredQuestions.has(questionFingerprint);
    
    if (!shouldFire) {
      console.log(`[Coaching] NOT firing — question=${looksLikeQuestion} words=${wordCount} dupe=${answeredQuestions.has(questionFingerprint)} text="${data.text.slice(0, 50)}"`);
    }
    
    if (shouldFire) {
      answeredQuestions.add(questionFingerprint);
      lastAnsweredTranscript = recentTranscript;
      console.log(`[Coaching] FIRING — speaker=${speakerLabel || speakerId || '?'} question="${data.text.slice(0, 50)}"`);
      
      // STEP 1: Check pre-loaded Quick Answers first (instant, no AI call)
      const qaMatch = await matchQuickAnswer(combinedText);
      if (qaMatch) {
        // Dedup: skip if same QA question was already shown
        if (lastAiQuestion && _textSimilarity(qaMatch.question, lastAiQuestion) > 0.5) {
          console.log(`[Coaching] QA skipped — same question as last`);
          return;
        }
        lastAiQuestion = qaMatch.question;
        lastAnswerTime = Date.now(); // LOCK OUT
        const coaching = {
          tier: 3,
          question: qaMatch.question,
          text: qaMatch.answer,
          timestamp: new Date().toISOString(),
          source: 'quick_answer'
        };
        coachingLog.push(coaching);
        sendToBrowserToo(ws, { type: 'coaching', data: coaching });
        console.log(`[Coaching] Quick Answer hit — locked for 15s`);
      } else {
        // STEP 2: No quick answer match — fall back to Claude AI
        const knowledgeResults = await kb.search(searchQuery, 3);
        triggerDeepCoaching(ws, knowledgeResults);
      }
    }
  }

  async function triggerDeepCoaching(ws, knowledgeResults) {
    // Rate limit — one AI call per 10 seconds minimum
    const now = Date.now();
    if (now - lastAiCoachingTime < 10000) return;
    lastAiCoachingTime = now;

    // Signal browser that AI is generating
    if (ws.readyState === 1) { ws.send(JSON.stringify({ type: 'ai_thinking', active: true })); sendToBrowserToo(ws, { type: 'ai_thinking', active: true }); }
    const coaching = await ai.generateCoaching(recentTranscript, knowledgeResults, scorecard, activeCallType, activeDealBrief);
    if (ws.readyState === 1) { ws.send(JSON.stringify({ type: 'ai_thinking', active: false })); sendToBrowserToo(ws, { type: 'ai_thinking', active: false }); }

    if (coaching) {
      // Skip if AI returned null
      if (!coaching.text || coaching.text === 'null') return;

      // Skip if the detected question is the same as the last one we answered
      if (coaching.question && lastAiQuestion) {
        const qSim = _textSimilarity(coaching.question, lastAiQuestion);
        if (qSim > 0.5) {
          console.log('[Coaching] Skipped — same question as last (qSim=' + qSim.toFixed(2) + ')');
          return;
        }
      }

      // Skip if answer too similar to last answer
      const similarity = _textSimilarity(coaching.text, lastAiCoachingText);
      if (similarity > 0.3) {
        console.log('[Coaching] Skipped — similar answer (similarity=' + similarity.toFixed(2) + ')');
        return;
      }

      lastAiCoachingText = coaching.text;
      lastAiQuestion = coaching.question || '';
      lastAnswerTime = Date.now(); // LOCK OUT
      coachingLog.push(coaching);
      sendToBrowserToo(ws, { type: 'coaching', data: coaching });
      console.log('[Coaching] Sent AI card: Q="' + (coaching.question || '?').slice(0, 50) + '" A="' + coaching.text.slice(0, 60) + '..."');
    }
  }

  ws.on('close', () => {
    activeClients.delete(ws);
    if (sessionId) {
      dgProxy.closeSession(sessionId);
    }
    // Don't stop calendar bots when browser disconnects — they keep running
    if (activeBotId && skribby && !calendarSessions.has(activeBotId)) {
      skribby.stopBot(activeBotId);
    }
    // Detach from calendar session but don't stop it
    for (const [botId, s] of calendarSessions) {
      if (s.attachedWs === ws) {
        s.attachedWs = null;
        console.log('[Calendar] Browser detached from session:', botId);
      }
    }
  });
});

// ─── START ─────────────────────────────────────────

server.listen(PORT, async () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║   Interview Coach               ║`);
  console.log(`  ║   Running on port ${PORT}               ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
  console.log(`  Open: http://localhost:${PORT}\n`);
  console.log(`  Playbook files: ${kb.getStats().playbook.files}`);
  const stats = await callHistory.getStats();
  console.log(`  Total calls: ${stats.totalCalls}\n`);
});
