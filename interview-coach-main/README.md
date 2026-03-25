# Interview Coach

Live AI-powered interview coaching with real-time transcription. Built for job candidates.

## What It Does

- **Real-time transcription** via Deepgram — see the conversation as it happens
- **Three-tier coaching engine** — instant keyword prompts, knowledge base matches, and AI-generated coaching
- **Dual knowledge base** — static prep docs (your resume, frameworks) + per-interview position intel
- **Interview scorecard** — tracks STAR completeness, skills demonstrated, questions asked, and red flags in real time
- **Post-interview summaries** — AI-generated debrief with performance analysis
- **Session history** — searchable archive of all past interviews with transcripts and scorecards

---

## Quick Start

### 1. Get Your API Keys

- **Deepgram**: Sign up at [console.deepgram.com](https://console.deepgram.com) → Get API key (free $200 credit)
- **Anthropic**: Sign up at [console.anthropic.com](https://console.anthropic.com) → Get API key

### 2. Run Locally (for testing)

```bash
cd interview-coach

# Install dependencies
npm install

# Create .env file
cp .env.example .env

# Edit .env and add your API keys
# DEEPGRAM_API_KEY=your_key_here
# ANTHROPIC_API_KEY=your_key_here

# Start the server
npm start

# Open http://localhost:3000 in Chrome
```

### 3. Deploy to Railway (for production)

1. Push this project to a **GitHub repository**
2. Go to [railway.app](https://railway.app) and sign in with GitHub
3. Click **New Project → Deploy from GitHub Repo**
4. Select your repository
5. Go to **Variables** tab and add:
   - `DEEPGRAM_API_KEY` = your Deepgram key
   - `ANTHROPIC_API_KEY` = your Anthropic key
   - `SESSION_SECRET` = any random string
6. Railway auto-deploys and gives you a URL

---

## Audio Setup for Zoom/Teams/Meet

Since you're using a headset, your browser mic only captures **your voice** by default. To capture both sides of the conversation, you need a virtual audio cable.

### Mac (BlackHole)

1. Download **BlackHole 2ch** from [existential.audio/blackhole](https://existential.audio/blackhole/)
2. Install it (requires restart)
3. Open **Audio MIDI Setup** (search in Spotlight)
4. Click **+** → **Create Multi-Output Device**
5. Check both **BlackHole 2ch** and your **headphones/speakers**
6. Set this Multi-Output Device as your system output
7. In the Interview Coach app, select **BlackHole 2ch** as your microphone input

### Windows (VB-Cable)

1. Download **VB-Cable** from [vb-audio.com/Cable](https://vb-audio.com/Cable/)
2. Install and restart
3. Go to **Sound Settings → Output** → Set to **CABLE Input (VB-Audio)**
4. In Zoom/Teams: Set speaker to **CABLE Input**
5. In the Interview Coach app: Select **CABLE Output** as your microphone

---

## Usage

### Before Your First Interview

1. Go to the **Prep Docs** tab
2. Upload your resume, STAR stories, achievement examples, interview frameworks
3. These stay loaded permanently across all sessions

### Before Each Interview

1. Enter the **interviewer name** and **company**
2. Select the **interview type** (behavioral, technical, case study, panel, executive, phone screen)
3. Click **+ Add** next to Position Intel to upload interview-specific docs (job description, company research, interviewer LinkedIn profiles)
4. Click **Start Listening** or **Send Bot** to begin

### During the Interview

- **Left panel**: Live transcript + interview intel extraction
- **Center panel**: Real-time coaching prompts (color-coded by tier)
- **Right panel**: Interview scorecard with STAR tracking
- Click **⚡ Ask AI** to manually trigger a coaching prompt
- Type in the **quick note** bar for manual observations

### After the Interview

1. Click **End Call**
2. Review the AI-generated performance summary
3. Find the full transcript, scorecard, and summary in the **History** tab

---

## Interview Types

| Type | Focus | Best For |
|------|-------|----------|
| **Behavioral** | STAR method, competency stories, self-awareness | Most common interview rounds |
| **Technical** | Problem-solving, system design, coding approach | Engineering, data, product roles |
| **Case Study** | Frameworks, quantitative reasoning, recommendations | Consulting, strategy, PM roles |
| **Panel** | Multi-audience engagement, consistent messaging | Group interview rounds |
| **Executive** | Strategic thinking, business acumen, leadership vision | VP+, C-suite, director roles |
| **Phone Screen** | Concise intro, role fit, motivation, enthusiasm | Initial recruiter/hiring manager calls |

---

## Interview Scorecard Dimensions

| Dimension | What It Tracks |
|-----------|---------------|
| **S** — Situation/Context | Did you set up scenarios clearly? |
| **A** — Actions Taken | Did you describe YOUR specific actions? |
| **R** — Results/Impact | Did you quantify outcomes with numbers? |
| **S** — Skills Demonstrated | Which competencies did you show? |
| **C** — Company Knowledge | Did you reference company-specific research? |
| **Q** — Questions Asked | What questions did you ask the interviewer? |
| **!** — Red Flags | Any concerning answers, gaps, or evasion? |

---

## Customizing

### Keyword Triggers (Tier 1)

Edit keywords in the **Keywords** tab or `lib/keywords.js` to add interview-specific trigger phrases and coaching prompts.

### AI Coaching Behavior (Tier 3)

Edit the system prompt in `lib/claude.js` → `buildSystemPrompt()` to adjust the AI's coaching style or methodology.

### Scoring Sensitivity

Adjust `minInterval` in `lib/claude.js` to control AI coaching frequency (default: 8 seconds). Adjust score thresholds in `server.js` → `handleTranscript()` for Tier 2/3 activation.

---

## Tech Stack

- **Backend**: Node.js + Express + WebSocket (ws)
- **Transcription**: Deepgram Nova-2 Streaming API
- **AI Coaching**: Anthropic Claude Sonnet
- **Database**: PostgreSQL with pgvector
- **Embeddings**: OpenAI text-embedding-3-small
- **Frontend**: Vanilla HTML/CSS/JS (no build step)
- **Hosting**: Railway

---

## License

Private / Personal Use
