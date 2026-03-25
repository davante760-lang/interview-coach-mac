// Knowledge Base Module
// Handles dual-layer document storage, chunking, and search
// Layer 1: Playbook (static) — persists across calls
// Layer 2: Prospect Intel (per-call) — cleared between calls
//
// Storage: pgvector for semantic search, in-memory arrays as cache for local model
// Embeddings: OpenAI text-embedding-3-small (1536 dimensions)

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const https = require('https');

class KnowledgeBase {
  constructor(dataDir, pool) {
    this.dataDir = dataDir;
    this.playbookDir = path.join(dataDir, 'playbook');
    this.prospectDir = path.join(dataDir, 'prospect');

    // In-memory cache (used by localModel.loadPlaybookTerms and as fallback)
    this.playbookChunks = [];
    this.prospectChunks = [];
    this.playbookFiles = [];
    this.prospectFiles = [];

    // Postgres pool for pgvector
    this.pool = pool || null;
    this.vectorReady = false;
    this.openaiKey = process.env.OPENAI_API_KEY || null;

    // Ensure directories exist
    fs.mkdirSync(this.playbookDir, { recursive: true });
    fs.mkdirSync(this.prospectDir, { recursive: true });

    // Initialize vector table if we have a pool
    if (this.pool) {
      this._initVectorTable().then(() => {
        this._loadFromPostgres();
      });
    } else {
      this._loadExistingPlaybook();
    }
  }

  // ─── PGVECTOR INIT ──────────────────────────────────

  async _initVectorTable() {
    try {
      await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');

      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS kb_chunks (
          id SERIAL PRIMARY KEY,
          file_id TEXT NOT NULL,
          file_name TEXT NOT NULL,
          layer TEXT NOT NULL DEFAULT 'playbook',
          section TEXT DEFAULT 'company_overview',
          chunk_index INTEGER NOT NULL,
          text TEXT NOT NULL,
          embedding vector(1536),
          created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_kb_layer ON kb_chunks(layer);
        CREATE INDEX IF NOT EXISTS idx_kb_file_id ON kb_chunks(file_id);
      `);

      // HNSW index for fast cosine search
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_kb_embedding ON kb_chunks
        USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
      `).catch(() => {
        console.log('[KB] HNSW index deferred (no rows yet)');
      });

      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS kb_files (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          layer TEXT NOT NULL DEFAULT 'playbook',
          section TEXT DEFAULT 'company_overview',
          chunk_count INTEGER DEFAULT 0,
          added_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      this.vectorReady = true;
      console.log('[KB] pgvector tables initialized');
    } catch (error) {
      console.error('[KB] pgvector init failed:', error.message);
      console.log('[KB] Falling back to in-memory search');
      this._loadExistingPlaybook();
    }
  }

  async _loadFromPostgres() {
    try {
      const fileRes = await this.pool.query(
        "SELECT * FROM kb_files WHERE layer = 'playbook' ORDER BY added_at"
      );
      this.playbookFiles = fileRes.rows.map(r => ({
        id: r.id,
        name: r.name,
        section: r.section,
        addedAt: r.added_at,
        chunkCount: r.chunk_count
      }));

      const chunkRes = await this.pool.query(
        "SELECT file_id, file_name, section, chunk_index, text FROM kb_chunks WHERE layer = 'playbook' ORDER BY file_id, chunk_index"
      );
      this.playbookChunks = chunkRes.rows.map(r => ({
        text: r.text,
        source: r.file_name,
        layer: 'playbook',
        section: r.section,
        fileId: r.file_id,
        index: r.chunk_index
      }));

      console.log(`[KB] Loaded ${this.playbookFiles.length} playbook files (${this.playbookChunks.length} chunks) from Postgres`);
    } catch (error) {
      console.error('[KB] Failed to load from Postgres:', error.message);
      this._loadExistingPlaybook();
    }
  }

  // ─── OPENAI EMBEDDINGS ──────────────────────────────

  async _getEmbeddings(texts) {
    if (!this.openaiKey) {
      console.warn('[KB] No OPENAI_API_KEY — skipping embeddings');
      return null;
    }

    // Validate and clean inputs — OpenAI rejects null, empty, or non-string values
    const cleaned = texts.map(t => {
      if (!t || typeof t !== 'string') return '';
      return t.trim().slice(0, 8000); // OpenAI max is ~8191 tokens per input
    }).filter(t => t.length > 0);

    if (cleaned.length === 0) {
      console.warn('[KB] No valid texts to embed');
      return null;
    }

    const batches = [];
    for (let i = 0; i < cleaned.length; i += 100) {
      batches.push(cleaned.slice(i, i + 100));
    }

    const allEmbeddings = [];

    for (const batch of batches) {
      const body = JSON.stringify({
        model: 'text-embedding-3-small',
        input: batch
      });

      const embeddings = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.openai.com',
          path: '/v1/embeddings',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.openaiKey}`,
            'Content-Length': Buffer.byteLength(body)
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.error) {
                reject(new Error(parsed.error.message));
                return;
              }
              resolve(parsed.data.map(d => d.embedding));
            } catch (e) {
              reject(e);
            }
          });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      allEmbeddings.push(...embeddings);
    }

    return allEmbeddings;
  }

  async _getEmbedding(text) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) return null;
    const results = await this._getEmbeddings([text]);
    return results ? results[0] : null;
  }

  // ─── FILE PROCESSING ───────────────────────────────

  async extractText(filePath, originalName) {
    const ext = path.extname(originalName || filePath).toLowerCase();

    if (ext === '.txt' || ext === '.md') {
      return fs.readFileSync(filePath, 'utf-8');
    }

    if (ext === '.pdf') {
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      return data.text;
    }

    if (ext === '.docx') {
      const buffer = fs.readFileSync(filePath);
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }

    return fs.readFileSync(filePath, 'utf-8');
  }

  chunkText(text, chunkSize = 500, overlap = 50) {
    const sentences = text.split(/(?<=[.!?])\s+/);
    const chunks = [];
    let currentChunk = [];
    let currentLength = 0;

    for (const sentence of sentences) {
      const words = sentence.split(/\s+/).length;

      if (currentLength + words > chunkSize && currentChunk.length > 0) {
        chunks.push(currentChunk.join(' '));
        const overlapSentences = [];
        let overlapLen = 0;
        for (let i = currentChunk.length - 1; i >= 0; i--) {
          const sWords = currentChunk[i].split(/\s+/).length;
          if (overlapLen + sWords > overlap) break;
          overlapSentences.unshift(currentChunk[i]);
          overlapLen += sWords;
        }
        currentChunk = [...overlapSentences];
        currentLength = overlapLen;
      }

      currentChunk.push(sentence);
      currentLength += words;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join(' '));
    }

    return chunks;
  }

  // ─── TOKEN SEARCH (FALLBACK) ────────────────────────

  _tokenize(text) {
    return text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  }

  _scoreChunk(chunk, queryTokens) {
    const chunkTokens = this._tokenize(chunk.text);
    const chunkTokenSet = new Set(chunkTokens);
    const chunkTokenFreq = {};
    chunkTokens.forEach(t => { chunkTokenFreq[t] = (chunkTokenFreq[t] || 0) + 1; });

    let score = 0;
    let matchedTerms = 0;

    for (const qt of queryTokens) {
      if (chunkTokenSet.has(qt)) {
        matchedTerms++;
        score += Math.log(1 + (chunkTokenFreq[qt] || 0));
      }
      for (const ct of chunkTokenSet) {
        if (ct.includes(qt) || qt.includes(ct)) {
          score += 0.3;
        }
      }
    }

    if (queryTokens.length > 0) {
      score += (matchedTerms / queryTokens.length) * 2;
    }

    return score;
  }

  _fallbackSearch(query, topK = 5) {
    const queryTokens = this._tokenize(query);
    if (queryTokens.length === 0) return [];

    const allChunks = [...this.prospectChunks, ...this.playbookChunks];
    const scored = allChunks.map(chunk => ({
      ...chunk,
      score: this._scoreChunk(chunk, queryTokens)
    }));

    scored.forEach(s => {
      if (s.layer === 'prospect') s.score *= 1.5;
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.filter(s => s.score > 0).slice(0, topK);
  }

  // ─── PLAYBOOK (LAYER 1) ────────────────────────────

  async addPlaybookFile(filePath, originalName, section) {
    const text = await this.extractText(filePath, originalName);
    const chunks = this.chunkText(text);

    const fileEntry = {
      id: Date.now().toString(),
      name: originalName,
      path: filePath,
      section: section || 'company_overview',
      addedAt: new Date().toISOString(),
      chunkCount: chunks.length
    };

    const indexedChunks = chunks.map((chunkText, i) => ({
      text: chunkText,
      source: originalName,
      layer: 'playbook',
      section: section || 'company_overview',
      fileId: fileEntry.id,
      index: i
    }));

    // Always update in-memory cache
    this.playbookFiles.push(fileEntry);
    this.playbookChunks.push(...indexedChunks);

    // Store in Postgres with embeddings
    if (this.vectorReady && this.pool) {
      try {
        await this.pool.query(
          'INSERT INTO kb_files (id, name, layer, section, chunk_count) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING',
          [fileEntry.id, originalName, 'playbook', section || 'company_overview', chunks.length]
        );

        // Generate embeddings for all chunks
        const embeddings = await this._getEmbeddings(chunks);

        // Insert chunks with embeddings
        for (let i = 0; i < chunks.length; i++) {
          const embeddingStr = embeddings ? `[${embeddings[i].join(',')}]` : null;
          await this.pool.query(
            `INSERT INTO kb_chunks (file_id, file_name, layer, section, chunk_index, text, embedding)
             VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
            [fileEntry.id, originalName, 'playbook', section || 'company_overview', i, chunks[i], embeddingStr]
          );
        }

        console.log(`[KB] Stored ${chunks.length} chunks with embeddings for: ${originalName}`);
      } catch (error) {
        console.error('[KB] Postgres store failed:', error.message);
      }
    }

    this._savePlaybookIndex();
    return fileEntry;
  }

  removePlaybookFile(fileId) {
    this.playbookFiles = this.playbookFiles.filter(f => f.id !== fileId);
    this.playbookChunks = this.playbookChunks.filter(c => c.fileId !== fileId);

    if (this.vectorReady && this.pool) {
      this.pool.query('DELETE FROM kb_chunks WHERE file_id = $1', [fileId]).catch(() => {});
      this.pool.query('DELETE FROM kb_files WHERE id = $1', [fileId]).catch(() => {});
    }

    try {
      const files = fs.readdirSync(this.playbookDir);
      files.forEach(f => {
        if (f.startsWith(fileId + '_')) {
          fs.unlinkSync(path.join(this.playbookDir, f));
        }
      });
    } catch (e) {}

    this._savePlaybookIndex();
  }

  // Store pre-chunked text array (bypasses chunkText splitter — each item = one chunk)
  // embedTexts: optional separate texts to use for embedding (e.g., just the question, not the full Q&A)
  async addRawChunks(chunks, fileName, section, embedTexts) {
    const fileId = Date.now().toString();
    const fileEntry = {
      id: fileId, name: fileName, path: '', section: section,
      addedAt: new Date().toISOString(), chunkCount: chunks.length
    };

    const indexedChunks = chunks.map((text, i) => ({
      text, source: fileName, layer: 'playbook', section, fileId, index: i
    }));

    this.playbookFiles.push(fileEntry);
    this.playbookChunks.push(...indexedChunks);

    if (this.vectorReady && this.pool) {
      try {
        await this.pool.query(
          'INSERT INTO kb_files (id, name, layer, section, chunk_count) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING',
          [fileId, fileName, 'playbook', section, chunks.length]
        );
        // Use embedTexts for embedding if provided (e.g., question-only for Q&A pairs)
        const textsToEmbed = embedTexts || chunks;
        const embeddings = await this._getEmbeddings(textsToEmbed);
        for (let i = 0; i < chunks.length; i++) {
          const embStr = embeddings ? `[${embeddings[i].join(',')}]` : null;
          await this.pool.query(
            `INSERT INTO kb_chunks (file_id, file_name, layer, section, chunk_index, text, embedding)
             VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
            [fileId, fileName, 'playbook', section, i, chunks[i], embStr]
          );
        }
        console.log(`[KB] Stored ${chunks.length} raw chunks with embeddings for: ${fileName}`);
      } catch (error) {
        console.error('[KB] Raw chunks store failed:', error.message);
      }
    }
    this._savePlaybookIndex();
    return fileEntry;
  }

  getPlaybookFiles() {
    return this.playbookFiles;
  }

  getChunksForFile(fileId) {
    return this.playbookChunks.filter(c => c.fileId === fileId);
  }

  // ─── PROSPECT INTEL (LAYER 2) ─────────────────────

  async addProspectFile(filePath, originalName) {
    const text = await this.extractText(filePath, originalName);
    const chunks = this.chunkText(text);

    const fileEntry = {
      id: Date.now().toString(),
      name: originalName,
      path: filePath,
      addedAt: new Date().toISOString(),
      chunkCount: chunks.length
    };

    const indexedChunks = chunks.map((chunkText, i) => ({
      text: chunkText,
      source: originalName,
      layer: 'prospect',
      fileId: fileEntry.id,
      index: i
    }));

    this.prospectFiles.push(fileEntry);
    this.prospectChunks.push(...indexedChunks);

    if (this.vectorReady && this.pool) {
      try {
        await this.pool.query(
          'INSERT INTO kb_files (id, name, layer, section, chunk_count) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING',
          [fileEntry.id, originalName, 'prospect', 'prospect_intel', chunks.length]
        );

        const embeddings = await this._getEmbeddings(chunks);

        for (let i = 0; i < chunks.length; i++) {
          const embeddingStr = embeddings ? `[${embeddings[i].join(',')}]` : null;
          await this.pool.query(
            `INSERT INTO kb_chunks (file_id, file_name, layer, section, chunk_index, text, embedding)
             VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
            [fileEntry.id, originalName, 'prospect', 'prospect_intel', i, chunks[i], embeddingStr]
          );
        }

        console.log(`[KB] Stored ${chunks.length} prospect chunks with embeddings for: ${originalName}`);
      } catch (error) {
        console.error('[KB] Prospect store failed:', error.message);
      }
    }

    return fileEntry;
  }

  clearProspectIntel() {
    this.prospectChunks = [];
    this.prospectFiles = [];

    if (this.vectorReady && this.pool) {
      this.pool.query("DELETE FROM kb_chunks WHERE layer = 'prospect'").catch(() => {});
      this.pool.query("DELETE FROM kb_files WHERE layer = 'prospect'").catch(() => {});
    }

    try {
      const files = fs.readdirSync(this.prospectDir);
      files.forEach(f => {
        fs.unlinkSync(path.join(this.prospectDir, f));
      });
    } catch (e) {}
  }

  getProspectFiles() {
    return this.prospectFiles;
  }

  // ─── SEARCH (VECTOR WITH FALLBACK) ─────────────────

  async search(query, topK = 5) {
    // Try vector search first
    if (this.vectorReady && this.pool && this.openaiKey) {
      try {
        const results = await this._vectorSearch(query, topK);
        if (results.length > 0) return results;
      } catch (error) {
        console.error('[KB] Vector search failed, falling back:', error.message);
      }
    }

    // Fallback to token-based search
    return this._fallbackSearch(query, topK);
  }

  async _vectorSearch(query, topK = 5) {
    const embedding = await this._getEmbedding(query);
    if (!embedding) return [];

    const embeddingStr = `[${embedding.join(',')}]`;

    // Cosine distance search — prospect intel gets 1.5x boost
    const result = await this.pool.query(`
      SELECT
        file_id as "fileId",
        file_name as source,
        layer,
        section,
        chunk_index as index,
        text,
        1 - (embedding <=> $1::vector) as similarity
      FROM kb_chunks
      WHERE embedding IS NOT NULL
      ORDER BY
        (embedding <=> $1::vector) * CASE WHEN layer = 'prospect' THEN 0.67 ELSE 1.0 END
      ASC
      LIMIT $2
    `, [embeddingStr, topK]);

    // Scale similarity to match old token-search thresholds
    // similarity 0.3 → score 3 (relevant), 0.5 → score 5 (very relevant)
    return result.rows
      .filter(r => r.similarity > 0.2)
      .map(r => ({
        text: r.text,
        source: r.source,
        layer: r.layer,
        section: r.section,
        fileId: r.fileId,
        index: r.index,
        score: r.similarity * 10,
        similarity: r.similarity
      }));
  }

  // Search only a specific section (e.g., 'quick_answers')
  async searchSection(query, section, topK = 3) {
    if (!this.vectorReady || !this.pool || !this.openaiKey) return [];
    try {
      const embedding = await this._getEmbedding(query);
      if (!embedding) return [];
      const embeddingStr = `[${embedding.join(',')}]`;
      const result = await this.pool.query(`
        SELECT file_id as "fileId", file_name as source, section, chunk_index as index, text,
               1 - (embedding <=> $1::vector) as similarity
        FROM kb_chunks
        WHERE embedding IS NOT NULL AND section = $3
        ORDER BY embedding <=> $1::vector ASC
        LIMIT $2
      `, [embeddingStr, topK, section]);
      return result.rows.filter(r => r.similarity > 0.2).map(r => ({
        text: r.text, source: r.source, section: r.section,
        fileId: r.fileId, index: r.index, score: r.similarity * 10, similarity: r.similarity
      }));
    } catch (e) {
      console.error('[KB] Section search failed:', e.message);
      return [];
    }
  }

  // ─── PERSISTENCE (FILESYSTEM BACKUP) ─────────────

  _savePlaybookIndex() {
    try {
      const indexPath = path.join(this.playbookDir, '_index.json');
      fs.writeFileSync(indexPath, JSON.stringify({
        files: this.playbookFiles,
        chunks: this.playbookChunks
      }, null, 2));
    } catch (e) {}
  }

  _loadExistingPlaybook() {
    const indexPath = path.join(this.playbookDir, '_index.json');
    if (fs.existsSync(indexPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        this.playbookFiles = data.files || [];
        this.playbookChunks = data.chunks || [];
        console.log(`[KB] Loaded ${this.playbookFiles.length} playbook files (${this.playbookChunks.length} chunks) from filesystem`);
      } catch (e) {
        console.error('[KB] Failed to load playbook index:', e.message);
      }
    }
  }

  // Backfill embeddings for existing chunks that don't have them
  async backfillEmbeddings() {
    if (!this.vectorReady || !this.pool || !this.openaiKey) {
      return { status: 'skipped', reason: 'Vector search not configured' };
    }

    try {
      const missing = await this.pool.query(
        'SELECT id, text FROM kb_chunks WHERE embedding IS NULL ORDER BY id'
      );

      if (missing.rows.length === 0) {
        return { status: 'done', backfilled: 0 };
      }

      console.log(`[KB] Backfilling embeddings for ${missing.rows.length} chunks...`);

      const texts = missing.rows.map(r => r.text);
      const embeddings = await this._getEmbeddings(texts);

      if (!embeddings) {
        return { status: 'error', reason: 'Failed to generate embeddings' };
      }

      for (let i = 0; i < missing.rows.length; i++) {
        const embeddingStr = `[${embeddings[i].join(',')}]`;
        await this.pool.query(
          'UPDATE kb_chunks SET embedding = $1::vector WHERE id = $2',
          [embeddingStr, missing.rows[i].id]
        );
      }

      console.log(`[KB] Backfilled ${missing.rows.length} embeddings`);
      return { status: 'done', backfilled: missing.rows.length };
    } catch (error) {
      console.error('[KB] Backfill failed:', error.message);
      return { status: 'error', reason: error.message };
    }
  }

  getStats() {
    return {
      playbook: {
        files: this.playbookFiles.length,
        chunks: this.playbookChunks.length
      },
      prospect: {
        files: this.prospectFiles.length,
        chunks: this.prospectChunks.length
      },
      vectorSearch: this.vectorReady && !!this.openaiKey
    };
  }
}

const STOP_WORDS = new Set([
  'the', 'be', 'to', 'of', 'and', 'in', 'that', 'have', 'it', 'for',
  'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at', 'this', 'but',
  'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she', 'or', 'an',
  'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what', 'so',
  'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me', 'when',
  'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know', 'take',
  'people', 'into', 'year', 'your', 'good', 'some', 'could', 'them',
  'see', 'other', 'than', 'then', 'now', 'look', 'only', 'come', 'its',
  'over', 'think', 'also', 'back', 'after', 'use', 'two', 'how', 'our',
  'work', 'well', 'way', 'even', 'new', 'want', 'because', 'any',
  'these', 'give', 'day', 'most', 'are', 'was', 'were', 'been', 'has',
  'had', 'did', 'got', 'may', 'shall', 'should', 'must', 'need',
  'very', 'really', 'actually', 'basically', 'just', 'yeah', 'yes',
  'right', 'okay', 'sure', 'well', 'umm', 'uh', 'like', 'know'
]);

module.exports = KnowledgeBase;
