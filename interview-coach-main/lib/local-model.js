// Local AI Model Module
// Runs a fine-tuned DistilBERT model via ONNX Runtime for instant inference
// Handles: coaching category classification, relevance scoring, scorecard field detection
// When no trained model is available, falls back to rule-based scoring

const path = require('path');
const fs = require('fs');

// Coaching categories the model outputs
const CATEGORIES = [
  'star_response',    // Behavioral question needing STAR structure
  'clarify',          // Need to ask clarifying question or add detail
  'pivot',            // Redirect or reframe the answer
  'quantify',         // Add numbers/metrics to strengthen answer
  'close_strong',     // Wrap up answer with impact or connection to role
  'none'              // Not a coaching moment
];

// Interview scorecard fields
const MEDDPICC_FIELDS = [
  'situation_context', 'actions_taken', 'results_impact',
  'skills_demonstrated', 'company_knowledge', 'questions_asked', 'red_flags'
];

class LocalModel {
  constructor(modelDir) {
    this.modelDir = modelDir || path.join(__dirname, '..', 'models');
    this.session = null;
    this.tokenizer = null;
    this.isLoaded = false;
    this.useRuleBased = true;
    this.playbookTerms = []; // Loaded from prep doc content

    this._initialize();
  }

  // Load terms from prep doc chunks — call this after knowledge base loads
  loadPlaybookTerms(knowledgeBase) {
    if (!knowledgeBase) return;
    const terms = new Set();

    try {
      const files = knowledgeBase.getPlaybookFiles();
      for (const file of files) {
        const chunks = knowledgeBase.getChunksForFile(file.id);
        for (const chunk of chunks) {
          // Extract notable terms: capitalized words, multi-word phrases, numbers with context
          const text = chunk.text || '';

          // Capitalized words (likely proper nouns: company names, products, people)
          const caps = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [];
          caps.forEach(t => { if (t.length > 2 && t.length < 40) terms.add(t.toLowerCase()); });

          // Quoted phrases
          const quoted = text.match(/"([^"]{3,50})"/g) || [];
          quoted.forEach(t => terms.add(t.replace(/"/g, '').toLowerCase()));

          // Dollar amounts and percentages (signals compensation/metrics language)
          const money = text.match(/\$[\d,]+(?:\.\d+)?(?:\s*[kmb])?/gi) || [];
          money.forEach(t => terms.add(t.toLowerCase()));

          const pcts = text.match(/\d+(?:\.\d+)?%/g) || [];
          pcts.forEach(t => terms.add(t));
        }
      }

      this.playbookTerms = Array.from(terms).filter(t => t.length > 2);
      console.log('[LocalModel] Loaded', this.playbookTerms.length, 'prep doc terms');
    } catch (e) {
      console.error('[LocalModel] Failed to load prep doc terms:', e.message);
    }
  }

  async _initialize() {
    const modelPath = path.join(this.modelDir, 'coaching-model.onnx');
    const tokenizerPath = path.join(this.modelDir, 'tokenizer.json');

    if (fs.existsSync(modelPath) && fs.existsSync(tokenizerPath)) {
      try {
        const ort = require('onnxruntime-node');
        this.session = await ort.InferenceSession.create(modelPath);
        this.tokenizer = JSON.parse(fs.readFileSync(tokenizerPath, 'utf-8'));
        this.isLoaded = true;
        this.useRuleBased = false;
        console.log('[LocalModel] ONNX model loaded successfully');
      } catch (error) {
        console.log('[LocalModel] Failed to load ONNX model:', error.message);
        console.log('[LocalModel] Using rule-based fallback');
        this.useRuleBased = true;
      }
    } else {
      console.log('[LocalModel] No trained model found at', modelPath);
      console.log('[LocalModel] Using rule-based fallback — train a model to enable local AI');
    }
  }

  // Main inference method — returns classification for a transcript segment
  async classify(text) {
    let result;
    if (this.useRuleBased) {
      result = this._ruleBasedClassify(text);
    } else {
      result = await this._modelClassify(text);
    }

    // Apply prep doc term boost
    const pbCheck = this._checkPlaybookTerms(text, result.relevance);
    if (pbCheck.boost > 0) {
      result.relevance = Math.min(1, result.relevance + pbCheck.boost);
      result.playbookMatches = pbCheck.matchedTerms;
      // If prep doc terms found but category was 'none', upgrade to clarify
      if (result.category === 'none' && pbCheck.matchedTerms.length >= 2) {
        result.category = 'clarify';
        result.confidence = Math.max(result.confidence, 0.6);
      }
    }

    return result;
  }

  // ─── ONNX MODEL INFERENCE ────────────────────────

  async _modelClassify(text) {
    try {
      const ort = require('onnxruntime-node');

      // Simple whitespace tokenization with vocab lookup
      const tokens = this._tokenize(text);
      const inputIds = new BigInt64Array(tokens.map(t => BigInt(t)));
      const attentionMask = new BigInt64Array(tokens.map(() => BigInt(1)));

      const feeds = {
        input_ids: new ort.Tensor('int64', inputIds, [1, tokens.length]),
        attention_mask: new ort.Tensor('int64', attentionMask, [1, tokens.length])
      };

      const results = await this.session.run(feeds);

      // Parse outputs
      const categoryLogits = results.category_logits?.data || [];
      const relevanceScore = results.relevance_score?.data?.[0] || 0;
      const meddpiccLogits = results.meddpicc_logits?.data || [];

      // Get top category
      const categoryIdx = this._argmax(categoryLogits);
      const category = CATEGORIES[categoryIdx] || 'none';

      // Get top scorecard field
      const meddpiccIdx = this._argmax(meddpiccLogits);
      const meddpiccField = MEDDPICC_FIELDS[meddpiccIdx] || null;

      return {
        category,
        relevance: Math.min(1, Math.max(0, relevanceScore)),
        meddpiccField,
        confidence: Math.max(...Array.from(categoryLogits).map(x => Math.exp(x))) /
                    Array.from(categoryLogits).reduce((s, x) => s + Math.exp(x), 0),
        source: 'model'
      };
    } catch (error) {
      console.error('[LocalModel] Inference error:', error.message);
      return this._ruleBasedClassify(text);
    }
  }

  _tokenize(text) {
    if (!this.tokenizer || !this.tokenizer.vocab) {
      // Fallback: simple hash-based token IDs
      return text.toLowerCase().split(/\s+/).slice(0, 128).map(w => {
        let hash = 0;
        for (let i = 0; i < w.length; i++) hash = ((hash << 5) - hash + w.charCodeAt(i)) | 0;
        return Math.abs(hash) % 30000;
      });
    }
    // Use vocab lookup
    return text.toLowerCase().split(/\s+/).slice(0, 128).map(w => {
      return this.tokenizer.vocab[w] || this.tokenizer.vocab['[UNK]'] || 0;
    });
  }

  _argmax(arr) {
    let maxIdx = 0;
    let maxVal = -Infinity;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] > maxVal) { maxVal = arr[i]; maxIdx = i; }
    }
    return maxIdx;
  }

  // ─── RULE-BASED FALLBACK ─────────────────────────
  // Smart heuristics that work without a trained model

  _ruleBasedClassify(text) {
    const lower = text.toLowerCase();
    let category = 'none';
    let relevance = 0;
    let meddpiccField = null;
    let confidence = 0;

    // Behavioral question signals → STAR response needed
    const behavioralWords = ['tell me about a time', 'describe a situation', 'give me an example', 'walk me through', 'how did you handle', 'what would you do if', 'have you ever', 'share an experience', 'can you describe'];
    const behavioralMatch = behavioralWords.filter(w => lower.includes(w));
    if (behavioralMatch.length > 0) {
      category = 'star_response';
      relevance = Math.min(1, 0.7 + behavioralMatch.length * 0.1);
      meddpiccField = 'situation_context';
      confidence = 0.85;
    }

    // Technical question signals → clarify and structure
    const technicalWords = ['how would you', 'design a', 'implement', 'architecture', 'algorithm', 'trade-off', 'optimize', 'scale', 'complexity', 'debug', 'system design', 'data structure', 'api', 'database'];
    const technicalMatch = technicalWords.filter(w => lower.includes(w));
    if (technicalMatch.length > 0 && technicalMatch.length >= behavioralMatch.length) {
      category = 'clarify';
      relevance = Math.min(1, 0.6 + technicalMatch.length * 0.12);
      meddpiccField = 'skills_demonstrated';
      confidence = 0.75;
    }

    // Weakness/challenge signals → pivot and reframe
    const weaknessWords = ['weakness', 'failure', 'mistake', 'difficult', 'conflict', 'disagree', 'criticism', 'struggle', 'challenge', 'what went wrong', 'biggest regret', 'shortcoming', 'improvement area'];
    const weaknessMatch = weaknessWords.filter(w => lower.includes(w));
    if (weaknessMatch.length > 0) {
      category = 'pivot';
      relevance = Math.min(1, 0.7 + weaknessMatch.length * 0.1);
      meddpiccField = 'red_flags';
      confidence = 0.8;
    }

    // Motivation signals → close strong with enthusiasm
    const motivationWords = ['why this company', 'why this role', 'what interests you', 'where do you see yourself', 'career goals', 'what motivates you', 'why are you leaving', 'what attracted you', 'why do you want'];
    const motivationMatch = motivationWords.filter(w => lower.includes(w));
    if (motivationMatch.length > 0 && motivationMatch.length >= weaknessMatch.length) {
      category = 'close_strong';
      relevance = Math.min(1, 0.6 + motivationMatch.length * 0.15);
      meddpiccField = 'company_knowledge';
      confidence = 0.75;
    }

    // Results/metrics signals → quantify
    const resultsWords = ['result', 'outcome', 'impact', 'metric', 'numbers', 'measure', 'improvement', 'percent', 'revenue', 'growth', 'saved', 'reduced', 'increased', 'achieved', 'delivered'];
    const resultsMatch = resultsWords.filter(w => lower.includes(w));
    if (resultsMatch.length > 0 && relevance < 0.6) {
      category = 'quantify';
      relevance = Math.min(1, 0.5 + resultsMatch.length * 0.12);
      meddpiccField = 'results_impact';
      confidence = 0.7;
    }

    // Leadership/collaboration signals
    const leadershipWords = ['led', 'managed', 'team', 'cross-functional', 'stakeholder', 'influenced', 'mentored', 'coached', 'delegated', 'coordinated'];
    if (leadershipWords.some(w => lower.includes(w))) {
      meddpiccField = 'skills_demonstrated';
      if (relevance < 0.5) {
        category = 'quantify';
        relevance = 0.6;
        confidence = 0.6;
      }
    }

    // Company/role knowledge signals
    const companyWords = ['your company', 'your product', 'your team', 'your mission', 'your culture', 'i read that', 'i noticed', 'on your website', 'in the job description', 'the role'];
    if (companyWords.some(w => lower.includes(w))) {
      meddpiccField = 'company_knowledge';
      if (relevance < 0.5) {
        category = 'close_strong';
        relevance = 0.6;
        confidence = 0.6;
      }
    }

    // Salary/compensation signals → pivot carefully
    const salaryWords = ['salary', 'compensation', 'benefits', 'expectations', 'pay range', 'total comp', 'equity', 'stock', 'bonus', 'offer'];
    if (salaryWords.some(w => lower.includes(w))) {
      category = 'pivot';
      relevance = Math.max(relevance, 0.8);
      confidence = 0.8;
    }

    // Closing signals → ask good questions
    const closingWords = ['any questions for us', 'is there anything else', 'do you have questions', 'what questions do you have', 'before we wrap', 'that\'s all the questions', 'anything you\'d like to ask'];
    if (closingWords.some(w => lower.includes(w))) {
      category = 'close_strong';
      relevance = Math.max(relevance, 0.85);
      meddpiccField = 'questions_asked';
      confidence = 0.85;
    }

    return {
      category,
      relevance,
      meddpiccField,
      confidence,
      source: 'rules'
    };
  }

  // Check if transcript text contains prep doc terms and boost relevance
  _checkPlaybookTerms(text, currentRelevance) {
    if (!this.playbookTerms.length) return { boost: 0, matchedTerms: [] };
    const lower = text.toLowerCase();
    const matched = this.playbookTerms.filter(term => lower.includes(term));
    if (matched.length === 0) return { boost: 0, matchedTerms: [] };

    // Each prep doc term match boosts relevance
    const boost = Math.min(0.3, matched.length * 0.1);
    return { boost, matchedTerms: matched };
  }

  // ─── STATUS ──────────────────────────────────────

  getStatus() {
    return {
      loaded: this.isLoaded,
      mode: this.useRuleBased ? 'rule-based' : 'onnx-model',
      modelDir: this.modelDir,
      categories: CATEGORIES,
      meddpiccFields: MEDDPICC_FIELDS
    };
  }
}

module.exports = LocalModel;
