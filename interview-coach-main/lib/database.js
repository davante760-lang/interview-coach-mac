// Call History Database Module
// Postgres-based storage for transcripts, scorecards, and call metadata

const { Pool } = require('pg');

class CallHistory {
  constructor(databaseUrl) {
    // pgvector template doesn't support SSL; set DATABASE_SSL=false to disable
    // Default: try SSL in production, no SSL otherwise
    const useSSL = process.env.DATABASE_SSL !== 'false' && process.env.NODE_ENV === 'production';

    this.pool = new Pool({
      connectionString: databaseUrl || process.env.DATABASE_URL,
      ssl: useSSL ? { rejectUnauthorized: false } : false
    });
    this._initTables();
  }

  async _initTables() {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS calls (
          id TEXT PRIMARY KEY,
          prospect_name TEXT,
          prospect_company TEXT,
          started_at TIMESTAMPTZ NOT NULL,
          ended_at TIMESTAMPTZ,
          duration_seconds INTEGER,
          transcript TEXT,
          scorecard JSONB DEFAULT '{}',
          summary TEXT,
          coaching_log JSONB DEFAULT '[]',
          notes TEXT,
          status TEXT DEFAULT 'active'
        );

        CREATE INDEX IF NOT EXISTS idx_calls_started ON calls(started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_calls_prospect ON calls(prospect_company);
      `);
      console.log('[DB] Postgres tables initialized');
    } catch (error) {
      console.error('[DB] Failed to initialize tables:', error.message);
    }
  }

  // Start a new call record
  async startCall(prospectName, prospectCompany) {
    const id = 'call_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const now = new Date().toISOString();

    try {
      await this.pool.query(
        `INSERT INTO calls (id, prospect_name, prospect_company, started_at, status)
         VALUES ($1, $2, $3, $4, 'active')`,
        [id, prospectName || '', prospectCompany || '', now]
      );
    } catch (error) {
      console.error('[DB] startCall error:', error.message);
    }

    return id;
  }

  // End a call and save all data
  async endCall(callId, data) {
    const now = new Date().toISOString();
    let duration = 0;

    try {
      const result = await this.pool.query('SELECT started_at FROM calls WHERE id = $1', [callId]);
      if (result.rows.length > 0) {
        duration = Math.round((new Date(now) - new Date(result.rows[0].started_at)) / 1000);
      }

      await this.pool.query(
        `UPDATE calls SET
          ended_at = $1,
          duration_seconds = $2,
          transcript = $3,
          scorecard = $4,
          summary = $5,
          coaching_log = $6,
          notes = $7,
          status = 'completed'
        WHERE id = $8`,
        [
          now,
          duration,
          data.transcript || '',
          JSON.stringify(data.scorecard || {}),
          data.summary || '',
          JSON.stringify(data.coachingLog || []),
          data.notes || '',
          callId
        ]
      );
    } catch (error) {
      console.error('[DB] endCall error:', error.message);
    }

    return { id: callId, duration, ended_at: now };
  }

  // Get a single call
  async getCall(callId) {
    try {
      const result = await this.pool.query('SELECT * FROM calls WHERE id = $1', [callId]);
      if (result.rows.length === 0) return null;
      return result.rows[0];
    } catch (error) {
      console.error('[DB] getCall error:', error.message);
      return null;
    }
  }

  // List all calls (most recent first)
  async listCalls(limit = 50, offset = 0) {
    try {
      const result = await this.pool.query(
        `SELECT id, prospect_name, prospect_company, started_at, ended_at,
                duration_seconds, status, call_name, call_type, deal_id,
                LENGTH(transcript) as transcript_length
         FROM calls
         ORDER BY started_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      return result.rows;
    } catch (error) {
      console.error('[DB] listCalls error:', error.message);
      return [];
    }
  }

  // Search calls by prospect name or company
  async searchCalls(query) {
    try {
      const pattern = '%' + query + '%';
      const result = await this.pool.query(
        `SELECT id, prospect_name, prospect_company, started_at, ended_at,
                duration_seconds, status
         FROM calls
         WHERE prospect_name ILIKE $1 OR prospect_company ILIKE $2 OR transcript ILIKE $3
         ORDER BY started_at DESC
         LIMIT 20`,
        [pattern, pattern, pattern]
      );
      return result.rows;
    } catch (error) {
      console.error('[DB] searchCalls error:', error.message);
      return [];
    }
  }

  // Update notes on a call
  async updateNotes(callId, notes) {
    try {
      await this.pool.query('UPDATE calls SET notes = $1 WHERE id = $2', [notes, callId]);
    } catch (error) {
      console.error('[DB] updateNotes error:', error.message);
    }
  }

  // Delete a call
  async deleteCall(callId) {
    try {
      await this.pool.query('DELETE FROM calls WHERE id = $1', [callId]);
    } catch (error) {
      console.error('[DB] deleteCall error:', error.message);
    }
  }

  // Get call count stats
  async getStats() {
    try {
      const total = await this.pool.query("SELECT COUNT(*) as count FROM calls WHERE status = 'completed'");
      const thisWeek = await this.pool.query(
        "SELECT COUNT(*) as count FROM calls WHERE status = 'completed' AND started_at >= NOW() - INTERVAL '7 days'"
      );
      return {
        totalCalls: parseInt(total.rows[0].count),
        callsThisWeek: parseInt(thisWeek.rows[0].count)
      };
    } catch (error) {
      console.error('[DB] getStats error:', error.message);
      return { totalCalls: 0, callsThisWeek: 0 };
    }
  }
}

module.exports = CallHistory;
