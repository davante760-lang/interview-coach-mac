// Keyword Manager Module
// Database-backed keyword system with:
// - Editable keywords via UI
// - Auto-extraction from interview transcripts via Claude
// - Prep doc mining for role terms, company names, etc.
// - Context-aware coaching prompts

const Anthropic = require('@anthropic-ai/sdk');

// Default keywords to seed on first run
const SEED_KEYWORDS = [
  { trigger: 'tell me about a time', category: 'interview', field: 'situation_context', prompt: 'STAR RESPONSE: Set up the Situation clearly, then your specific Task.', context: 'Behavioral question detected — use the STAR method.', color: '#3B82F6', cooldown: 30, source: 'built-in' },
  { trigger: 'how would you', category: 'interview', field: 'skills_demonstrated', prompt: 'CLARIFY: Ask 1-2 clarifying questions before answering.', context: 'Technical or hypothetical question — clarify scope before diving in.', color: '#8B5CF6', cooldown: 30, source: 'built-in' },
  { trigger: 'weakness', category: 'interview', field: 'red_flags', prompt: 'PIVOT: Name a real weakness, then immediately show how you\'re improving.', context: 'Weakness question — be honest but strategic, show growth mindset.', color: '#EF4444', cooldown: 30, source: 'built-in' },
  { trigger: 'why this company', category: 'interview', field: 'company_knowledge', prompt: 'Reference specific company research — product, mission, recent news.', context: 'Motivation question — show you did your homework.', color: '#10B981', cooldown: 30, source: 'built-in' },
  { trigger: 'why this role', category: 'interview', field: 'company_knowledge', prompt: 'Connect your skills and career goals to what this specific role offers.', context: 'Role fit question — be specific about why THIS role, not just any job.', color: '#10B981', cooldown: 30, source: 'built-in' },
  { trigger: 'conflict', category: 'interview', field: 'situation_context', prompt: 'Focus on resolution, not blame. Show empathy and what you learned.', context: 'Conflict question — demonstrate emotional intelligence and maturity.', color: '#F59E0B', cooldown: 30, source: 'built-in' },
  { trigger: 'what was the result', category: 'interview', field: 'results_impact', prompt: 'QUANTIFY: Add specific numbers — %, $, time saved, team size.', context: 'Results probe — don\'t just say "it went well," give measurable outcomes.', color: '#EC4899', cooldown: 20, source: 'built-in' },
  { trigger: 'where do you see yourself', category: 'interview', field: 'company_knowledge', prompt: 'Show ambition aligned with this role\'s growth path. Don\'t say "your job."', context: 'Career goals question — balance ambition with commitment.', color: '#06B6D4', cooldown: 30, source: 'built-in' },
  { trigger: 'salary', category: 'alert', field: null, prompt: '⚡ PIVOT: Deflect if early — "I\'m focused on fit first." If pressed, give a researched range.', context: 'Compensation discussion — let them name a number first if possible.', color: '#DC2626', cooldown: 15, source: 'built-in' },
  { trigger: 'any questions for us', category: 'alert', field: 'questions_asked', prompt: '🎯 ASK: "What does success look like in the first 90 days?"', context: 'Closing — always have 2-3 thoughtful questions. Never say "no questions."', color: '#059669', cooldown: 10, source: 'built-in' },
  { trigger: 'do you have questions', category: 'alert', field: 'questions_asked', prompt: '🎯 ASK: "What\'s the biggest challenge the team is facing right now?"', context: 'Closing — show strategic thinking with your questions.', color: '#059669', cooldown: 10, source: 'built-in' },
  { trigger: 'wrap up', category: 'alert', field: null, prompt: '⏰ CLOSE STRONG: Express enthusiasm and ask about next steps.', context: 'Interview ending — last chance to leave a strong impression.', color: '#D97706', cooldown: 10, source: 'built-in' },
  { trigger: 'failure', category: 'interview', field: 'red_flags', prompt: 'PIVOT: Own it honestly, then focus 80% on what you learned and changed.', context: 'Failure question — show accountability and growth.', color: '#EF4444', cooldown: 20, source: 'built-in' },
  { trigger: 'leadership', category: 'interview', field: 'skills_demonstrated', prompt: 'STAR RESPONSE: Give a specific example where YOU led, not just participated.', context: 'Leadership probe — focus on influence and outcomes, not just title.', color: '#3B82F6', cooldown: 20, source: 'built-in' },
];

class KeywordManager {
  constructor(pool, anthropicKey) {
    this.pool = pool;
    this.client = anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null;
    this.keywords = []; // In-memory cache
    this.lastFired = {}; // Cooldown tracker
    this._initTable();
  }

  async _initTable() {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS keywords (
          id SERIAL PRIMARY KEY,
          trigger_phrase TEXT NOT NULL,
          category TEXT DEFAULT 'custom',
          field TEXT,
          prompt TEXT NOT NULL,
          context TEXT,
          color TEXT DEFAULT '#3B82F6',
          cooldown INTEGER DEFAULT 30,
          source TEXT DEFAULT 'manual',
          call_type TEXT,
          enabled BOOLEAN DEFAULT true,
          fire_count INTEGER DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_keywords_enabled ON keywords(enabled);
      `);

      // Seed if empty
      const count = await this.pool.query('SELECT COUNT(*) FROM keywords');
      if (parseInt(count.rows[0].count) === 0) {
        console.log('[Keywords] Seeding default keywords...');
        for (const kw of SEED_KEYWORDS) {
          await this.pool.query(
            `INSERT INTO keywords (trigger_phrase, category, field, prompt, context, color, cooldown, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [kw.trigger, kw.category, kw.field, kw.prompt, kw.context, kw.color, kw.cooldown, kw.source]
          );
        }
      }

      await this._loadCache();
      console.log('[Keywords] Loaded', this.keywords.length, 'keywords');
    } catch (error) {
      console.error('[Keywords] Init failed:', error.message);
    }
  }

  async _loadCache() {
    try {
      const result = await this.pool.query('SELECT * FROM keywords WHERE enabled = true ORDER BY id');
      this.keywords = result.rows;
    } catch (e) {
      console.error('[Keywords] Cache load failed:', e.message);
    }
  }

  // ─── MATCHING ─────────────────────────────────────

  match(text, callType) {
    const lower = text.toLowerCase();
    const matches = [];
    const now = Date.now();

    for (const kw of this.keywords) {
      // Skip if interview type doesn't match (null = all types)
      if (kw.call_type && kw.call_type !== callType) continue;

      if (lower.includes(kw.trigger_phrase.toLowerCase())) {
        // Check cooldown
        const lastTime = this.lastFired[kw.id] || 0;
        if (now - lastTime < (kw.cooldown || 30) * 1000) continue;

        this.lastFired[kw.id] = now;
        matches.push({
          tier: 1,
          text: kw.prompt,
          category: kw.category,
          field: kw.field,
          color: kw.color,
          context: kw.context,
          timestamp: new Date().toISOString(),
          source: 'keyword',
          trigger: kw.trigger_phrase,
          keywordId: kw.id
        });

        // Increment fire count in background
        this.pool.query('UPDATE keywords SET fire_count = fire_count + 1 WHERE id = $1', [kw.id]).catch(() => {});
      }
    }
    return matches;
  }

  // ─── CRUD ─────────────────────────────────────────

  async list() {
    try {
      const result = await this.pool.query('SELECT * FROM keywords ORDER BY category, trigger_phrase');
      return result.rows;
    } catch (e) { return []; }
  }

  async add(data) {
    try {
      const result = await this.pool.query(
        `INSERT INTO keywords (trigger_phrase, category, field, prompt, context, color, cooldown, source, call_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [data.trigger, data.category || 'custom', data.field || null, data.prompt,
         data.context || '', data.color || '#3B82F6', data.cooldown || 30,
         data.source || 'manual', data.call_type || null]
      );
      await this._loadCache();
      return result.rows[0];
    } catch (e) { console.error('[Keywords] Add failed:', e.message); return null; }
  }

  async update(id, data) {
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [key, val] of Object.entries(data)) {
      if (['trigger_phrase', 'category', 'field', 'prompt', 'context', 'color', 'cooldown', 'enabled', 'call_type'].includes(key)) {
        fields.push(`${key} = $${idx}`);
        values.push(val);
        idx++;
      }
    }
    if (!fields.length) return null;
    values.push(id);
    try {
      await this.pool.query(`UPDATE keywords SET ${fields.join(', ')} WHERE id = $${idx}`, values);
      await this._loadCache();
      return true;
    } catch (e) { return null; }
  }

  async remove(id) {
    try {
      await this.pool.query('DELETE FROM keywords WHERE id = $1', [id]);
      await this._loadCache();
      return true;
    } catch (e) { return false; }
  }

  async toggleEnabled(id, enabled) {
    try {
      await this.pool.query('UPDATE keywords SET enabled = $1 WHERE id = $2', [enabled, id]);
      await this._loadCache();
      return true;
    } catch (e) { return false; }
  }

  // ─── AI EXTRACTION FROM TRANSCRIPTS ───────────────

  async extractFromTranscript(transcript, callType) {
    if (!this.client) {
      console.error('[Keywords] No Anthropic client — ANTHROPIC_API_KEY may be missing');
      return [];
    }

    try {
      console.log('[Keywords] Extracting from transcript, length:', transcript.length, 'type:', callType);
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: `You analyze job interview transcripts to extract coaching-relevant keywords and phrases. For each keyword you find, explain WHY it matters and what coaching prompt should fire when it's heard again. Return ONLY valid JSON.`,
        messages: [{
          role: 'user',
          content: `Analyze this ${(callType || 'behavioral').replace('_', ' ')} interview transcript. Find the 10-20 most important trigger phrases — moments where a coach should have prompted the candidate. For each, provide:

1. trigger: The exact word or short phrase (2-4 words max) that signals the moment
2. prompt: What the coach should tell the candidate to say or do (1-2 sentences)
3. context: WHY this trigger matters — what's happening in the conversation
4. category: interview, alert, or custom
5. field: Scorecard field if applicable (situation_context, actions_taken, results_impact, skills_demonstrated, company_knowledge, questions_asked, red_flags) or null

Focus on:
- Phrases the INTERVIEWER says that signal a specific question type (behavioral, technical, motivation, weakness)
- Moments where the candidate should have quantified results or used STAR structure
- Opportunities to demonstrate company knowledge or ask better questions
- Role-specific terms and competencies mentioned

Return JSON array:
[{"trigger": "phrase", "prompt": "coaching text", "context": "why this matters", "category": "interview", "field": "situation_context"}]

TRANSCRIPT:
${transcript}`
        }]
      });

      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
      
      try {
        return JSON.parse(cleaned);
      } catch (parseErr) {
        console.log('[Keywords] JSON truncated, recovering...');
        const lastBrace = cleaned.lastIndexOf('}');
        if (lastBrace > 0) {
          try {
            return JSON.parse(cleaned.slice(0, lastBrace + 1) + ']');
          } catch (e2) { /* fall through */ }
        }
        return [];
      }
    } catch (error) {
      console.error('[Keywords] Transcript extraction failed:', error.message);
      return [];
    }
  }

  // ─── PREP DOC MINING ──────────────────────────────

  async minePlaybookContent(content, sourceName) {
    if (!this.client) return [];

    try {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: 'You extract coaching-relevant keywords from interview prep documents. Return ONLY valid JSON.',
        messages: [{
          role: 'user',
          content: `Extract trigger keywords from this interview prep document. Find:
- Role requirements and competencies the interviewer might ask about
- Company-specific terms, products, or initiatives to reference
- Technical skills or frameworks mentioned in the job description
- Common interview question phrases related to this role
- Achievement metrics or stories the candidate should be ready to share

For each, write a coaching prompt that should fire during the interview.

Return JSON array:
[{"trigger": "phrase", "prompt": "coaching text", "context": "why this matters", "category": "interview|alert|custom", "field": "scorecard_field_or_null"}]

Return 5-15 keywords. Include both phrases an INTERVIEWER would say and key terms the CANDIDATE should mention.

DOCUMENT (${sourceName}):
${content}`
        }]
      });

      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
      return JSON.parse(cleaned);
    } catch (error) {
      console.error('[Keywords] Prep doc mining failed:', error.message);
      return [];
    }
  }

  // ─── BULK ADD ─────────────────────────────────────

  async bulkAdd(keywords, source) {
    const added = [];
    for (const kw of keywords) {
      // Check for duplicate triggers
      const existing = this.keywords.find(k =>
        k.trigger_phrase.toLowerCase() === (kw.trigger || '').toLowerCase()
      );
      if (existing) continue;

      const result = await this.add({
        trigger: kw.trigger,
        category: kw.category || 'custom',
        field: kw.field || null,
        prompt: kw.prompt,
        context: kw.context || '',
        color: kw.color || '#3B82F6',
        cooldown: kw.cooldown || 30,
        source: source || 'ai-extracted',
        call_type: kw.call_type || null
      });
      if (result) added.push(result);
    }
    return added;
  }

  // ─── STATS ────────────────────────────────────────

  async getStats() {
    try {
      const total = await this.pool.query('SELECT COUNT(*) FROM keywords');
      const enabled = await this.pool.query('SELECT COUNT(*) FROM keywords WHERE enabled = true');
      const topFired = await this.pool.query('SELECT trigger_phrase, fire_count FROM keywords ORDER BY fire_count DESC LIMIT 5');
      return {
        total: parseInt(total.rows[0].count),
        enabled: parseInt(enabled.rows[0].count),
        topFired: topFired.rows
      };
    } catch (e) { return { total: 0, enabled: 0, topFired: [] }; }
  }
}

module.exports = KeywordManager;
