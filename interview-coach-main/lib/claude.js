// Claude API Integration Module
// Handles Tier 3 "deep" coaching — contextual AI-generated prompts
// Streams responses for speed

const Anthropic = require('@anthropic-ai/sdk');

class CoachingAI {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
    this.model = 'claude-sonnet-4-20250514';
    this.fastModel = 'claude-haiku-4-5-20251001'; // Fast model for real-time coaching
    this.lastCallTime = 0;
    this.minInterval = 8000;
  }

  // Interview type coaching overrides
  static CALL_TYPE_PROMPTS = {
    behavioral: {
      focus: 'STAR method responses, leadership examples, conflict resolution, teamwork, adaptability stories',
      success: 'Used complete STAR responses with quantified results, showed self-awareness, connected stories to role requirements'
    },
    technical: {
      focus: 'Problem-solving approach, system design thinking, coding methodology, technical depth, trade-off analysis',
      success: 'Demonstrated structured thinking, communicated approach clearly, asked clarifying questions, discussed trade-offs'
    },
    case_study: {
      focus: 'Framework selection, hypothesis-driven analysis, quantitative reasoning, structured communication, actionable recommendations',
      success: 'Applied clear framework, used data to support conclusions, considered multiple angles, delivered crisp recommendation'
    },
    panel: {
      focus: 'Engaging all panelists, consistent messaging, reading the room, adapting communication style per audience',
      success: 'Made eye contact with all panelists, tailored depth to each person\'s role, showed breadth and depth'
    },
    executive: {
      focus: 'Strategic thinking, business acumen, vision articulation, executive presence, big-picture impact',
      success: 'Spoke in business outcomes not tasks, demonstrated strategic vision, showed leadership maturity'
    },
    phone_screen: {
      focus: 'Concise self-introduction, role fit articulation, motivation clarity, logistics/availability, enthusiasm',
      success: 'Clear 2-minute pitch, strong role-fit narrative, genuine enthusiasm, smart questions about the role'
    }
  };

  buildSystemPrompt(prepContext, positionContext, callType, dealBrief) {
    const typeConfig = CoachingAI.CALL_TYPE_PROMPTS[callType] || CoachingAI.CALL_TYPE_PROMPTS.behavioral;

    return `You are a real-time interview coach. You watch a live transcript and tell the candidate EXACTLY what to say next.

INTERVIEW TYPE: ${(callType || 'behavioral').replace('_', ' ').toUpperCase()}
COACHING FOCUS: ${typeConfig.focus}

RULES:
- Return ONLY valid JSON: {"question": "...", "answer": "..."}
- "question" = the interviewer's last question (short, 1 sentence)
- "answer" = the EXACT words the candidate should say. First person, natural speech, ready to read aloud. 3-5 sentences.
- ANSWER EVERY QUESTION. Even casual, creative, or off-the-wall questions. There are no "non-substantive" questions in an interview — everything is being evaluated.
- Do NOT include labels, frameworks, or meta-commentary. Just the words to say.
- ONLY return null if literally no question has been asked yet (the very start of the call with just greetings).

${dealBrief ? `\nINTERVIEW BRIEF:\n${dealBrief}\n` : ''}
${prepContext ? `\nPREP DOCS:\n${prepContext}\n` : ''}
${positionContext ? `\nPOSITION INTEL:\n${positionContext}\n` : ''}`;
  }

  async generateCoaching(transcript, knowledgeResults, scorecard, callType, dealBrief) {
    const now = Date.now();
    if (now - this.lastCallTime < this.minInterval) return null;
    this.lastCallTime = now;

    const prepContext = knowledgeResults
      .filter(r => r.layer === 'playbook')
      .map(r => r.text)
      .join('\n\n');

    const positionContext = knowledgeResults
      .filter(r => r.layer === 'prospect')
      .map(r => r.text)
      .join('\n\n');

    const gaps = [];
    if (scorecard) {
      for (const [field, status] of Object.entries(scorecard)) {
        if (status === 'empty') gaps.push(field);
      }
    }
    const gapNote = gaps.length > 0
      ? `\nScorecard gaps (not yet demonstrated): ${gaps.join(', ')}`
      : '';

    const systemPrompt = this.buildSystemPrompt(prepContext, positionContext, callType, dealBrief);

    try {
      const response = await this.client.messages.create({
        model: this.fastModel,
        max_tokens: 300,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: `Recent transcript:\n\n${transcript}${gapNote}\n\nReturn JSON with the question asked and the exact answer to say.`
        }]
      });

      const text = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');

      // Parse the JSON response
      try {
        const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleaned);
        if (!parsed.answer || parsed.answer === 'null') return null;

        return {
          tier: 3,
          question: parsed.question === 'null' ? null : (parsed.question || null),
          text: parsed.answer.trim(),
          timestamp: new Date().toISOString(),
          source: 'ai'
        };
      } catch (parseErr) {
        // Fallback: strip any JSON artifacts and use as plain text
        let cleanText = text.replace(/```json/g, '').replace(/```/g, '')
          .replace(/\{"question".*?"answer".*?\}/gs, '')
          .replace(/["{}]/g, '')
          .replace(/question\s*:|answer\s*:/gi, '')
          .replace(/null/g, '')
          .trim();
        if (!cleanText || cleanText.length < 10) return null;
        return {
          tier: 3,
          question: null,
          text: cleanText,
          timestamp: new Date().toISOString(),
          source: 'ai'
        };
      }
    } catch (error) {
      console.error('Claude API error:', error.message);
      return null;
    }
  }

  // Generate post-interview summary
  async generateCallSummary(fullTranscript, scorecard, knowledgeResults) {
    const positionContext = knowledgeResults
      .filter(r => r.layer === 'prospect')
      .map(r => r.text)
      .join('\n\n');

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1000,
        system: `You are an interview performance analyst. Generate a concise post-interview debrief for the candidate.`,
        messages: [{
          role: 'user',
          content: `Analyze this interview transcript and provide:

1. PERFORMANCE SUMMARY (2-3 sentences — how did the candidate do overall?)
2. STRONGEST MOMENTS (bullet list — what they did well, with specific examples)
3. SCORECARD ASSESSMENT (for each dimension: what was demonstrated, what was missing)
4. STAR COMPLETENESS (did answers include all STAR elements? Which were weak?)
5. RECOMMENDED IMPROVEMENTS (specific, actionable coaching for next time)
6. QUESTIONS TO PREPARE FOR (topics that came up but weren't fully addressed)

CURRENT SCORECARD STATE: ${JSON.stringify(scorecard)}

${positionContext ? `POSITION CONTEXT:\n${positionContext}\n` : ''}

TRANSCRIPT:
${fullTranscript}`
        }]
      });

      return response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');
    } catch (error) {
      console.error('Summary generation error:', error.message);
      return 'Summary generation failed. Full transcript is still available.';
    }
  }

  // ─── SESSION NAMING ─────────────────────────────────

  async generateCallName(transcript, company, callType) {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 50,
        system: 'You generate short descriptive names for job interview sessions. Return ONLY the key topic portion — 3-6 words, no quotes, no punctuation at the end.',
        messages: [{
          role: 'user',
          content: `What was this ${(callType || 'behavioral').replace('_', ' ')} interview primarily about? Summarize the main topics discussed in 3-6 words.

Examples of good key topics:
- Leadership & Conflict Resolution
- System Design & Scalability
- Product Strategy & Metrics
- Career Motivation & Culture Fit
- Technical Problem Solving
- Cross-Functional Collaboration

TRANSCRIPT (last portion):
${transcript.slice(-3000)}`
        }]
      });

      const topic = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
      const typeLabel = (callType || 'behavioral').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      return `${company || 'Unknown'} — ${typeLabel} — ${topic}`;
    } catch (error) {
      console.error('Session naming error:', error.message);
      const typeLabel = (callType || 'behavioral').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      return `${company || 'Unknown'} — ${typeLabel}`;
    }
  }

  // ─── INTERVIEW BRIEF ──────────────────────

  async generateDealBrief(deal, callType) {
    const scorecardData = JSON.stringify(deal.meddpicc_data || {});
    const strengths = JSON.stringify(deal.pain_points || []);
    const contacts = JSON.stringify(deal.stakeholders || []);
    const companyIntel = JSON.stringify(deal.competitive_intel || {});
    const typeConfig = CoachingAI.CALL_TYPE_PROMPTS[callType] || CoachingAI.CALL_TYPE_PROMPTS.behavioral;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 600,
        system: `You generate pre-interview briefings for job candidates. Be concise and actionable. Return ONLY valid JSON.`,
        messages: [{
          role: 'user',
          content: `Generate a pre-interview briefing for a ${(callType || 'behavioral').replace('_', ' ')} interview.

POSITION: ${deal.company_name} | Compensation: ${deal.deal_value ? '$' + deal.deal_value : 'Not specified'} | Stage: ${deal.stage}
SCORECARD DATA: ${scorecardData}
KEY STRENGTHS: ${strengths}
CONTACTS: ${contacts}
COMPANY INTEL: ${companyIntel}
INTERVIEW TYPE FOCUS: ${typeConfig.focus}

Return JSON:
{
  "mission": "1-2 sentence purpose of this interview round + what to accomplish",
  "talking_points": ["key point 1 to emphasize", "point 2", "point 3"],
  "likely_questions": [{"text": "predicted question", "status": "prepared|needs_work|new_topic"}],
  "suggested_stories": ["specific STAR story 1 to have ready", "story 2", "story 3"],
  "key_risks": ["risk 1", "risk 2"],
  "last_recap": "1 sentence about where things stand from prior rounds"
}`
        }]
      });

      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
      return JSON.parse(cleaned);
    } catch (error) {
      console.error('Interview brief error:', error.message);
      return null;
    }
  }

  // ─── INTERVIEW READINESS ──────────────────

  async generateForecastReadiness(deal) {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 400,
        system: 'You assess interview readiness for job candidates. Return ONLY valid JSON.',
        messages: [{
          role: 'user',
          content: `Assess interview readiness for this position. Return JSON array of checklist items.

POSITION: ${deal.company_name} | Compensation: ${deal.deal_value ? '$' + deal.deal_value : 'Not specified'} | Stage: ${deal.stage} | Readiness: ${deal.health_score}
SCORECARD DATA: ${JSON.stringify(deal.meddpicc_data || {})}
KEY STRENGTHS: ${JSON.stringify(deal.pain_points || [])}
CONTACTS: ${JSON.stringify(deal.stakeholders || [])}

Return:
[
  {"item": "STAR stories prepared for key competencies", "status": "yes|partial|no", "detail": "why"},
  {"item": "Company research completed", "status": "yes|partial|no", "detail": "why"},
  {"item": "Role requirements mapped to experience", "status": "yes|partial|no", "detail": "why"},
  {"item": "Interviewer backgrounds reviewed", "status": "yes|partial|no", "detail": "why"},
  {"item": "Technical preparation adequate", "status": "yes|partial|no", "detail": "why"},
  {"item": "Questions for interviewers prepared", "status": "yes|partial|no", "detail": "why"},
  {"item": "Salary expectations researched", "status": "yes|partial|no", "detail": "why"},
  {"item": "Weakness/challenge answers polished", "status": "yes|partial|no", "detail": "why"}
]`
        }]
      });

      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
      return JSON.parse(cleaned);
    } catch (error) {
      console.error('Interview readiness error:', error.message);
      return [];
    }
  }

  // ─── POST-INTERVIEW INTEL EXTRACTION ──────────────────

  async extractCallIntel(transcript) {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1000,
        system: 'You extract structured intelligence from job interview transcripts. Return ONLY valid JSON, no markdown, no explanation.',
        messages: [{
          role: 'user',
          content: `Extract the following from this interview transcript. Only include what was explicitly stated or strongly implied.

Return JSON:
{
  "pain_points": [
    {"text": "key strength or talking point demonstrated", "status": "strong|mentioned|weak", "speaker": "candidate or interviewer"}
  ],
  "stakeholders": [
    {"name": "interviewer name", "role": "their title or role", "sentiment": "impressed|positive|neutral|skeptical|unknown", "influence": 3}
  ],
  "competitive_intel": {
    "competitors": ["other concerns or gaps mentioned"],
    "contract_details": "any salary/comp info discussed or null",
    "positioning": {"strengths": "what impressed them", "weaknesses": "concerns or gaps raised"}
  }
}

Rules:
- pain_points: capture key talking points, achievements, or strengths demonstrated. Status is "strong" if well-received, "mentioned" if briefly covered, "weak" if poorly delivered.
- stakeholders: every interviewer by name or title. Sentiment based on reactions.
- competitive_intel: mentions of other candidates, team needs, compensation, timeline, or red flags.
- If nothing found, return empty arrays/null.

TRANSCRIPT:
${transcript}`
        }]
      });

      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
      return JSON.parse(cleaned);
    } catch (error) {
      console.error('Interview intel extraction error:', error.message);
      return { pain_points: [], stakeholders: [], competitive_intel: {} };
    }
  }

  // ─── INTERVIEW ANALYSIS ────────

  async analyzeCall(transcript, scorecardData, coachingLog, callType) {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2000,
        system: 'You analyze completed job interviews and generate a comprehensive performance debrief for the candidate. Return ONLY valid JSON.',
        messages: [{
          role: 'user',
          content: `Analyze this ${(callType || 'behavioral').replace('_', ' ')} interview. Generate a full debrief.

TRANSCRIPT:
${transcript}

SCORECARD DATA:
${JSON.stringify(scorecardData || {})}

Return JSON:
{
  "missed_topics": [
    {"topic": "what was missed or underdeveloped", "moment": "what the interviewer asked", "suggested_followup": "how to address in follow-up or next round"}
  ],
  "call_score": {
    "overall": 75,
    "star_completeness": 80,
    "technical_depth": 70,
    "communication": 75,
    "enthusiasm": 60,
    "summary": "1-2 sentence assessment of performance"
  },
  "next_steps": [
    {"action": "what to do next", "owner": "candidate|interviewer|recruiter", "urgency": "high|medium|low"}
  ],
  "action_items": [
    {"item": "specific follow-up", "by_whom": "candidate", "deadline": "when if mentioned"}
  ],
  "key_quotes": [
    {"quote": "notable interviewer statement", "significance": "what this signals"}
  ],
  "talk_ratio": {
    "rep_pct": 40,
    "prospect_pct": 60,
    "assessment": "good balance|candidate talked too much|interviewer dominated"
  }
}`
        }]
      });

      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
      try {
        return JSON.parse(cleaned);
      } catch (parseErr) {
        const lastBrace = cleaned.lastIndexOf('}');
        if (lastBrace > 0) {
          try { return JSON.parse(cleaned.slice(0, lastBrace + 1)); } catch(e2) {}
        }
        return null;
      }
    } catch (error) {
      console.error('Interview analysis error:', error.message);
      return null;
    }
  }

  // ─── INTERVIEW PREP AI CHAT (STREAMING) ─────────────────────

  async dealChatStream(deal, callSummaries, recentTranscripts, question, prepContext, onToken, onDone) {
    try {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: 1500,
        system: `You are an interview prep strategist who has complete access to everything about this candidate's interview process — every session, every transcript, every interviewer interaction. You also have access to the candidate's prep docs including resume talking points, company research, practice answers, and role details.

Answer questions naturally and conversationally, like a career coach who's been sitting in on every interview. Don't use headers, bullet points, or structured formats unless the user specifically asks for a list or report. Just talk.

When you reference something specific, mention where it came from naturally — "The interviewer seemed interested when you mentioned..." or "Based on what Sarah asked about your leadership experience..." or "Your resume highlights that...". Use exact quotes from transcripts when they're powerful. Reference prep docs when relevant.

If you don't have enough info to answer, just say so and suggest how to prepare. Be direct, be honest, don't pad your answers.`,
        messages: [{
          role: 'user',
          content: `POSITION: ${deal.company_name}
Compensation: ${deal.deal_value ? '$' + deal.deal_value : 'Not specified'} | Stage: ${deal.stage} | Readiness: ${deal.health_score}

SCORECARD DATA:
${JSON.stringify(deal.meddpicc_data || {}, null, 2)}

KEY STRENGTHS:
${JSON.stringify(deal.pain_points || [], null, 2)}

CONTACTS:
${JSON.stringify(deal.stakeholders || [], null, 2)}

COMPANY INTEL:
${JSON.stringify(deal.competitive_intel || {}, null, 2)}

SESSION SUMMARIES:
${callSummaries || 'No sessions recorded yet'}

RECENT TRANSCRIPTS:
${recentTranscripts || 'No transcripts available'}

${prepContext ? `PREP DOCS CONTEXT:\n${prepContext}\n` : ''}

QUESTION: ${question}`
        }]
      });

      stream.on('text', (text) => { if (onToken) onToken(text); });
      const finalMessage = await stream.finalMessage();
      if (onDone) onDone();
      return finalMessage.content.filter(b => b.type === 'text').map(b => b.text).join('');
    } catch (error) {
      console.error('Interview chat stream error:', error.message);
      if (onDone) onDone();
      return 'Failed to process your question. Please try again.';
    }
  }
}

module.exports = CoachingAI;
