// Tier 1 — Keyword Detection Configuration
// These trigger INSTANT (0ms) prompts in the coaching feed.
// Edit freely — add your own keywords and prompts as you learn what works.

const KEYWORD_CONFIG = {
  // ═══════════════════════════════════════════
  // BEHAVIORAL QUESTION SIGNALS
  // ═══════════════════════════════════════════

  behavioralQuestion: {
    keywords: ["tell me about a time", "describe a situation", "give me an example", "walk me through", "have you ever", "share an experience", "how did you handle", "what did you do when"],
    category: "interview",
    field: "situation_context",
    prompts: [
      "STAR RESPONSE: Set up the Situation clearly, then your specific Task.",
      "Structure it: What was the context? What was YOUR specific role?",
      "Start with 1 sentence of context, then go straight to your actions.",
      "Pick a specific example — avoid generalizing with 'usually I would...'"
    ],
    color: "#3B82F6"
  },

  technicalQuestion: {
    keywords: ["how would you", "design a", "implement", "what approach", "walk me through your thinking", "explain how", "code this", "build a", "architect"],
    category: "interview",
    field: "skills_demonstrated",
    prompts: [
      "CLARIFY: Ask 1-2 clarifying questions before diving in.",
      "Talk through your approach out loud before implementing.",
      "State your assumptions explicitly, then outline your plan.",
      "Start with the simplest solution, then discuss optimizations."
    ],
    color: "#8B5CF6"
  },

  // ═══════════════════════════════════════════
  // CHALLENGE / WEAKNESS SIGNALS
  // ═══════════════════════════════════════════

  weaknessQuestion: {
    keywords: ["weakness", "area of improvement", "what would you change", "biggest failure", "mistake you made", "what are you working on"],
    category: "interview",
    field: "red_flags",
    prompts: [
      "PIVOT: Name a real weakness, then immediately pivot to how you're improving.",
      "Be honest but strategic — show self-awareness and growth mindset.",
      "Frame it as a learning moment. What did you DO differently after?",
      "Avoid clichés like 'I'm a perfectionist.' Be specific and genuine."
    ],
    color: "#EF4444"
  },

  conflictQuestion: {
    keywords: ["conflict", "disagreement", "difficult person", "difficult coworker", "pushback", "didn't agree", "tension", "clash"],
    category: "interview",
    field: "situation_context",
    prompts: [
      "STAR RESPONSE: Focus on how you resolved it, not the drama.",
      "Show empathy — demonstrate you understood the other person's perspective.",
      "Highlight the outcome: resolution + what you learned about collaboration.",
      "Don't blame others. Frame it as 'different perspectives' not 'they were wrong.'"
    ],
    color: "#F59E0B"
  },

  // ═══════════════════════════════════════════
  // MOTIVATION & FIT SIGNALS
  // ═══════════════════════════════════════════

  motivationQuestion: {
    keywords: ["why this company", "why this role", "what interests you", "what attracted you", "why are you leaving", "why do you want to work here", "what excites you"],
    category: "interview",
    field: "company_knowledge",
    prompts: [
      "CLOSE STRONG: Reference specific company research — show you did your homework.",
      "Connect your personal mission to the company's mission.",
      "Be specific: 'I'm excited about X product because...' not 'I love your culture.'",
      "Tie it to your career trajectory — why is THIS the right next step?"
    ],
    color: "#10B981"
  },

  careerGoals: {
    keywords: ["where do you see yourself", "five years", "career goals", "long term", "what's next for you", "growth", "aspirations"],
    category: "interview",
    field: "company_knowledge",
    prompts: [
      "BRIDGE: Connect your growth goals to what this role offers.",
      "Show ambition but also commitment — don't sound like you'll leave in 6 months.",
      "Reference the role's growth path if you know it.",
      "Be authentic — interviewers can spot rehearsed answers."
    ],
    color: "#06B6D4"
  },

  // ═══════════════════════════════════════════
  // RESULTS & QUANTIFICATION SIGNALS
  // ═══════════════════════════════════════════

  resultsProbe: {
    keywords: ["what was the result", "what happened", "outcome", "impact", "how did it turn out", "what changed", "what did you achieve"],
    category: "interview",
    field: "results_impact",
    prompts: [
      "QUANTIFY: Add specific numbers — %, $, time saved, team size, revenue impact.",
      "Don't just say 'it went well.' Give the measurable before/after.",
      "If you don't have exact numbers, estimate: 'roughly 30% improvement in...'",
      "Connect the result to business impact, not just personal success."
    ],
    color: "#EC4899"
  },

  // ═══════════════════════════════════════════
  // COMPENSATION SIGNALS
  // ═══════════════════════════════════════════

  salaryQuestion: {
    keywords: ["salary", "compensation", "pay", "expectations", "benefits", "total comp", "equity", "stock options", "bonus", "what are you looking for"],
    category: "alert",
    field: null,
    prompts: [
      "⚡ PIVOT: Deflect if early stage — 'I'm focused on fit first, but happy to discuss when the time is right.'",
      "If pressed, give a range based on market research, not your current salary.",
      "Frame it: 'Based on my research for this role in this market, I'd expect...'",
      "Ask: 'What's the budgeted range for this role?' — make them go first if possible."
    ],
    color: "#DC2626"
  },

  // ═══════════════════════════════════════════
  // CLOSING SIGNALS
  // ═══════════════════════════════════════════

  closingTime: {
    keywords: ["any questions for us", "do you have questions", "what questions do you have", "anything you'd like to ask", "is there anything else"],
    category: "alert",
    field: "questions_asked",
    prompts: [
      "🎯 ASK SMART QUESTIONS: 'What does success look like in the first 90 days?'",
      "Ask about the TEAM: 'What's the team dynamic like? How do you collaborate?'",
      "Show strategic thinking: 'What's the biggest challenge the team is facing right now?'",
      "NEVER say 'No, I'm good.' Always have 2-3 thoughtful questions ready."
    ],
    color: "#059669"
  },

  wrappingUp: {
    keywords: ["wrap up", "running out of time", "last question", "before we go", "that's all we have", "thanks for your time", "next steps in the process"],
    category: "alert",
    field: null,
    prompts: [
      "⏰ CLOSE STRONG: Express genuine enthusiasm for the role.",
      "Summarize: 'I'm really excited about this because...' (1 sentence).",
      "Ask: 'What are the next steps in the process?'",
      "End with confidence: 'I'd love to continue the conversation. This feels like a great fit.'"
    ],
    color: "#D97706"
  }
};

module.exports = KEYWORD_CONFIG;
