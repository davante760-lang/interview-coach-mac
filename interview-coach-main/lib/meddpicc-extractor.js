// Interview Scorecard Real-Time Extraction Module
// Processes transcript batches every ~12 seconds via Claude
// Extracts structured data and maps to interview performance dimensions

const Anthropic = require('@anthropic-ai/sdk');

const MEDDPICC_SCHEMA = {
  situation_context: {
    label: 'Situation / Context',
    fields: {
      scenario_clarity: 'Did the candidate clearly set up the scenario or problem?',
      role_in_scenario: 'Did they define their specific role and responsibilities?',
      stakes: 'Did they convey what was at stake or why it mattered?'
    }
  },
  actions_taken: {
    label: 'Actions Taken',
    fields: {
      specific_actions: 'What specific actions did THEY take (not the team)?',
      initiative: 'Did they show personal initiative and ownership?',
      methodology: 'Did they describe a structured approach or methodology?',
      collaboration: 'How did they work with or lead others?'
    }
  },
  results_impact: {
    label: 'Results / Impact',
    fields: {
      quantified_outcomes: 'Did they quantify results with specific numbers or metrics?',
      business_impact: 'What was the broader business or team impact?',
      lessons_learned: 'Did they reflect on what they learned or would do differently?'
    }
  },
  skills_demonstrated: {
    label: 'Skills Demonstrated',
    fields: {
      leadership: 'Did they demonstrate leadership or influence?',
      problem_solving: 'Did they show structured problem-solving ability?',
      communication: 'Was their communication clear and compelling?',
      technical_depth: 'Did they demonstrate relevant technical competency?',
      adaptability: 'Did they show adaptability or resilience?'
    }
  },
  company_knowledge: {
    label: 'Company Knowledge',
    fields: {
      company_research: 'Did they reference company-specific information?',
      role_understanding: 'Did they show understanding of the role requirements?',
      culture_fit: 'Did they demonstrate alignment with company culture or values?'
    }
  },
  questions_asked: {
    label: 'Questions Asked',
    fields: {
      thoughtful_questions: 'What insightful questions did they ask the interviewer?',
      role_clarity: 'Did they ask about role expectations or success criteria?',
      growth_interest: 'Did they ask about growth, team, or company direction?'
    }
  },
  red_flags: {
    label: 'Red Flags',
    fields: {
      gaps_or_evasion: 'Any questions they avoided or answered evasively?',
      inconsistencies: 'Any contradictions or inconsistencies in their stories?',
      negative_signals: 'Any concerning attitudes, complaints, or red flags?'
    }
  }
};

class MeddpiccExtractor {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
    this.model = 'claude-sonnet-4-20250514';
    this.lastExtractTime = 0;
    this.interval = 12000; // 12 seconds between extractions
    this.timer = null;
    this.extractedData = {};
    this.pendingTranscript = '';

    // Initialize empty extracted data
    for (const [field, config] of Object.entries(MEDDPICC_SCHEMA)) {
      this.extractedData[field] = {};
      for (const subField of Object.keys(config.fields)) {
        this.extractedData[field][subField] = null;
      }
    }
  }

  // Add transcript text to the pending buffer
  addTranscript(text) {
    this.pendingTranscript += text + ' ';
  }

  // Start the extraction loop
  start(onUpdate, onError) {
    this.onUpdate = onUpdate;
    this.onError = onError;

    this.timer = setInterval(() => {
      this._extractBatch();
    }, this.interval);

    console.log('[Scorecard] Extraction loop started (every 12s)');
  }

  // Stop the extraction loop
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Run one final extraction
    this._extractBatch();
    console.log('[Scorecard] Extraction loop stopped');
  }

  // Get current extracted data
  getData() {
    return this.extractedData;
  }

  // Get the schema (for sending to client)
  static getSchema() {
    return MEDDPICC_SCHEMA;
  }

  // Run one extraction batch
  async _extractBatch() {
    const transcript = this.pendingTranscript.trim();
    if (transcript.length < 20) return; // Not enough text

    // Reset pending
    this.pendingTranscript = '';

    try {
      const existingData = JSON.stringify(this.extractedData, null, 2);

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 800,
        system: `You extract structured interview performance data from job interview transcripts.

You will receive the latest transcript segment and the current state of extracted data. Your job is to identify any information that maps to the interview scorecard fields below.

INTERVIEW SCORECARD FIELDS:
${Object.entries(MEDDPICC_SCHEMA).map(([key, config]) => {
  return `${config.label} (${key}):\n${Object.entries(config.fields).map(([sub, desc]) => `  - ${sub}: ${desc}`).join('\n')}`;
}).join('\n\n')}

RULES:
- Only extract what was explicitly stated or strongly implied. Do not guess.
- For fields that already have a value: if the new transcript adds meaningful detail, MERGE the old and new into one improved summary. If the new info is redundant or less specific, keep the existing value and do NOT return that field.
- For empty fields: fill them if the transcript contains relevant information.
- Keep values concise — 1-2 sentences max per field, combining old + new info when merging.
- Use the candidate's own language when possible.
- Only return fields that are NEW or IMPROVED. Do not return unchanged fields.
- Return ONLY valid JSON, no markdown, no explanation.

RESPONSE FORMAT:
{
  "field_name": {
    "sub_field": "merged/improved value combining existing + new info"
  }
}

Example — existing data has actions_taken.specific_actions = "Led the migration project". New transcript says "I personally wrote the migration scripts, coordinated with 3 teams, and ran the rollback drills". Your response:
{ "actions_taken": { "specific_actions": "Personally wrote migration scripts, coordinated across 3 teams, and ran rollback drills for the migration project" } }

If no new or improved information was found, return: {}`,
        messages: [{
          role: 'user',
          content: `CURRENT EXTRACTED DATA:\n${existingData}\n\nNEW TRANSCRIPT SEGMENT:\n${transcript}`
        }]
      });

      const text = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');

      // Parse the response
      const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const newData = JSON.parse(cleaned);

      // Merge new data into existing
      let hasUpdates = false;
      for (const [field, subFields] of Object.entries(newData)) {
        if (!this.extractedData[field]) continue;
        for (const [subField, value] of Object.entries(subFields)) {
          if (value && this.extractedData[field][subField] !== value) {
            this.extractedData[field][subField] = value;
            hasUpdates = true;
          }
        }
      }

      if (hasUpdates && this.onUpdate) {
        this.onUpdate(this.extractedData);
      }

    } catch (error) {
      console.error('[Scorecard] Extraction error:', error.message);
      if (this.onError) this.onError(error);
    }
  }
}

module.exports = { MeddpiccExtractor, MEDDPICC_SCHEMA };
