// Positions Module (reskinned from Deals)
// CRUD operations, asset management, and post-interview intelligence merging

const { Pool } = require('pg');

class Deals {
  constructor(pool) {
    this.pool = pool;
    this._initTables();
  }

  async _initTables() {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS deals (
          id TEXT PRIMARY KEY,
          company_name TEXT NOT NULL,
          deal_value INTEGER DEFAULT 0,
          stage TEXT DEFAULT 'applied',
          vehicle_count INTEGER,
          notes TEXT DEFAULT '',
          health_score FLOAT DEFAULT 0,
          meddpicc_data JSONB DEFAULT '{}',
          pain_points JSONB DEFAULT '[]',
          stakeholders JSONB DEFAULT '[]',
          competitive_intel JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS deal_assets (
          id TEXT PRIMARY KEY,
          deal_id TEXT REFERENCES deals(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          asset_type TEXT DEFAULT 'other',
          path TEXT,
          chunk_count INTEGER DEFAULT 0,
          uploaded_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);
        CREATE INDEX IF NOT EXISTS idx_deals_updated ON deals(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_deal_assets_deal ON deal_assets(deal_id);
      `);

      // Add extra columns to calls if they don't exist
      await this.pool.query(`
        DO $$ BEGIN
          ALTER TABLE calls ADD COLUMN IF NOT EXISTS deal_id TEXT;
          ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_type TEXT DEFAULT 'behavioral';
          ALTER TABLE calls ADD COLUMN IF NOT EXISTS meddpicc_extracted JSONB DEFAULT '{}';
          ALTER TABLE calls ADD COLUMN IF NOT EXISTS pain_points_extracted JSONB DEFAULT '[]';
          ALTER TABLE calls ADD COLUMN IF NOT EXISTS stakeholders_extracted JSONB DEFAULT '[]';
          ALTER TABLE calls ADD COLUMN IF NOT EXISTS bot_id TEXT;
          ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_url TEXT;
          ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_analysis JSONB DEFAULT '{}';
          ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_name TEXT;
        EXCEPTION WHEN others THEN NULL;
        END $$;
      `);

      console.log('[DB] Positions tables initialized');
    } catch (error) {
      console.error('[DB] Failed to initialize positions tables:', error.message);
    }
  }

  // ─── POSITION CRUD ────────────────────────────────

  async createDeal(data) {
    const id = 'deal_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const now = new Date().toISOString();

    try {
      await this.pool.query(
        `INSERT INTO deals (id, company_name, deal_value, stage, vehicle_count, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [id, data.company_name, data.deal_value || 0, data.stage || 'applied', data.vehicle_count || null, data.notes || '', now]
      );
      return await this.getDeal(id);
    } catch (error) {
      console.error('[DB] createDeal error:', error.message);
      return null;
    }
  }

  async getDeal(dealId) {
    try {
      const result = await this.pool.query('SELECT * FROM deals WHERE id = $1', [dealId]);
      if (result.rows.length === 0) return null;
      return result.rows[0];
    } catch (error) {
      console.error('[DB] getDeal error:', error.message);
      return null;
    }
  }

  async listDeals() {
    try {
      const result = await this.pool.query(
        `SELECT id, company_name, deal_value, stage, vehicle_count, health_score,
                pain_points, meddpicc_data, stakeholders, created_at, updated_at
         FROM deals ORDER BY updated_at DESC`
      );
      return result.rows;
    } catch (error) {
      console.error('[DB] listDeals error:', error.message);
      return [];
    }
  }

  async updateDeal(dealId, data) {
    const fields = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(data)) {
      if (['company_name', 'deal_value', 'stage', 'vehicle_count', 'notes', 'health_score'].includes(key)) {
        fields.push(`${key} = $${idx}`);
        values.push(value);
        idx++;
      }
    }

    if (fields.length === 0) return null;

    fields.push(`updated_at = $${idx}`);
    values.push(new Date().toISOString());
    idx++;

    values.push(dealId);

    try {
      await this.pool.query(
        `UPDATE deals SET ${fields.join(', ')} WHERE id = $${idx}`,
        values
      );
      return await this.getDeal(dealId);
    } catch (error) {
      console.error('[DB] updateDeal error:', error.message);
      return null;
    }
  }

  async deleteDeal(dealId) {
    try {
      await this.pool.query('DELETE FROM deals WHERE id = $1', [dealId]);
      return true;
    } catch (error) {
      console.error('[DB] deleteDeal error:', error.message);
      return false;
    }
  }

  // ─── POSITION ASSETS ──────────────────────────────

  async addAsset(dealId, name, assetType, path, chunkCount) {
    const id = 'asset_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);

    try {
      await this.pool.query(
        `INSERT INTO deal_assets (id, deal_id, name, asset_type, path, chunk_count)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, dealId, name, assetType || 'other', path, chunkCount || 0]
      );
      await this.pool.query('UPDATE deals SET updated_at = NOW() WHERE id = $1', [dealId]);
      return { id, deal_id: dealId, name, asset_type: assetType };
    } catch (error) {
      console.error('[DB] addAsset error:', error.message);
      return null;
    }
  }

  async listAssets(dealId) {
    try {
      const result = await this.pool.query(
        'SELECT * FROM deal_assets WHERE deal_id = $1 ORDER BY uploaded_at DESC',
        [dealId]
      );
      return result.rows;
    } catch (error) {
      console.error('[DB] listAssets error:', error.message);
      return [];
    }
  }

  async removeAsset(assetId) {
    try {
      await this.pool.query('DELETE FROM deal_assets WHERE id = $1', [assetId]);
      return true;
    } catch (error) {
      console.error('[DB] removeAsset error:', error.message);
      return false;
    }
  }

  // ─── POSITION-SESSION LINKING ────────────────────────

  async linkCallToDeal(callId, dealId) {
    try {
      await this.pool.query('UPDATE calls SET deal_id = $1 WHERE id = $2', [dealId, callId]);
      await this.pool.query('UPDATE deals SET updated_at = NOW() WHERE id = $1', [dealId]);
      return true;
    } catch (error) {
      console.error('[DB] linkCallToDeal error:', error.message);
      return false;
    }
  }

  async getCallsForDeal(dealId) {
    try {
      const result = await this.pool.query(
        `SELECT id, prospect_name, prospect_company, started_at, ended_at,
                duration_seconds, status, call_type, summary,
                meddpicc_extracted, pain_points_extracted, stakeholders_extracted
         FROM calls WHERE deal_id = $1 ORDER BY started_at DESC`,
        [dealId]
      );
      return result.rows;
    } catch (error) {
      console.error('[DB] getCallsForDeal error:', error.message);
      return [];
    }
  }

  // ─── POST-INTERVIEW MERGE ─────────────────────────

  async mergeCallIntel(dealId, callData) {
    try {
      const deal = await this.getDeal(dealId);
      if (!deal) return null;

      // 1. Merge scorecard data (best-answer: keep richer info)
      const existingScorecard = deal.meddpicc_data || {};
      const newScorecard = callData.meddpicc || {};
      const mergedScorecard = { ...existingScorecard };

      for (const [field, subFields] of Object.entries(newScorecard)) {
        if (!mergedScorecard[field]) mergedScorecard[field] = {};
        for (const [sub, value] of Object.entries(subFields || {})) {
          if (value && (!mergedScorecard[field][sub] || value.length > (mergedScorecard[field][sub] || '').length)) {
            mergedScorecard[field][sub] = value;
          }
        }
      }

      // 2. Append new talking points (deduplicate by similarity)
      const existingPoints = deal.pain_points || [];
      const newPoints = callData.painPoints || [];
      const mergedPoints = [...existingPoints];
      for (const np of newPoints) {
        const isDupe = existingPoints.some(ep =>
          ep.text && np.text && ep.text.toLowerCase().includes(np.text.toLowerCase().slice(0, 30))
        );
        if (!isDupe) {
          mergedPoints.push({
            text: np.text,
            status: np.status || 'mentioned',
            source_call: callData.callId,
            speaker: np.speaker || 'Unknown',
            discovered_at: new Date().toISOString()
          });
        }
      }

      // 3. Merge contacts by name
      const existingContacts = deal.stakeholders || [];
      const newContacts = callData.stakeholders || [];
      const mergedContacts = [...existingContacts];
      for (const ns of newContacts) {
        const existing = mergedContacts.find(es =>
          es.name && ns.name && es.name.toLowerCase() === ns.name.toLowerCase()
        );
        if (existing) {
          existing.interactions = (existing.interactions || 0) + 1;
          existing.last_interaction = new Date().toISOString();
          if (ns.role) existing.role = ns.role;
          if (ns.sentiment) existing.sentiment = ns.sentiment;
        } else if (ns.name) {
          mergedContacts.push({
            name: ns.name,
            role: ns.role || 'Unknown',
            sentiment: ns.sentiment || 'unknown',
            influence: ns.influence || 3,
            interactions: 1,
            last_interaction: new Date().toISOString()
          });
        }
      }

      // 4. Merge company intel
      const existingComp = deal.competitive_intel || {};
      const newComp = callData.competitiveIntel || {};
      const mergedComp = { ...existingComp };
      if (newComp.competitors) {
        mergedComp.competitors = [...new Set([...(existingComp.competitors || []), ...newComp.competitors])];
      }
      if (newComp.contract_details) mergedComp.contract_details = newComp.contract_details;
      if (newComp.positioning) mergedComp.positioning = { ...(existingComp.positioning || {}), ...newComp.positioning };

      // 5. Calculate readiness score
      const healthScore = this._calculateHealthScore(mergedScorecard, mergedPoints, mergedContacts, deal);

      // 6. Save everything
      await this.pool.query(
        `UPDATE deals SET
          meddpicc_data = $1,
          pain_points = $2,
          stakeholders = $3,
          competitive_intel = $4,
          health_score = $5,
          updated_at = NOW()
        WHERE id = $6`,
        [
          JSON.stringify(mergedScorecard),
          JSON.stringify(mergedPoints),
          JSON.stringify(mergedContacts),
          JSON.stringify(mergedComp),
          healthScore,
          dealId
        ]
      );

      // 7. Save session-level extracted data
      await this.pool.query(
        `UPDATE calls SET
          meddpicc_extracted = $1,
          pain_points_extracted = $2,
          stakeholders_extracted = $3
        WHERE id = $4`,
        [
          JSON.stringify(newScorecard),
          JSON.stringify(newPoints),
          JSON.stringify(newContacts),
          callData.callId
        ]
      );

      console.log(`[Positions] Merged session intel into position ${dealId}, readiness: ${healthScore}`);
      return await this.getDeal(dealId);
    } catch (error) {
      console.error('[DB] mergeCallIntel error:', error.message);
      return null;
    }
  }

  // Readiness score: 0-100 composite
  _calculateHealthScore(scorecard, talkingPoints, contacts, deal) {
    let score = 0;

    // Scorecard coverage — 40% weight
    let filledCount = 0;
    let totalCount = 0;
    for (const subFields of Object.values(scorecard)) {
      for (const value of Object.values(subFields || {})) {
        totalCount++;
        if (value) filledCount++;
      }
    }
    if (totalCount > 0) {
      score += (filledCount / totalCount) * 40;
    }

    // Strong talking points — 15% weight
    const strongPoints = talkingPoints.filter(p => p.status === 'strong' || p.status === 'confirmed');
    if (strongPoints.length >= 2) score += 15;
    else if (strongPoints.length === 1) score += 10;
    else if (talkingPoints.length > 0) score += 5;

    // Interviewer rapport — 15% weight
    const positiveContacts = contacts.some(s => s.sentiment === 'impressed');
    if (positiveContacts) score += 15;
    else if (contacts.some(s => s.sentiment === 'positive')) score += 7;

    // Company knowledge demonstrated — 15% weight
    const ck = scorecard.company_knowledge || {};
    const ckFilled = Object.values(ck).filter(v => v).length;
    const ckTotal = Object.keys(ck).length || 1;
    score += (ckFilled / ckTotal) * 15;

    // Recency — 15% weight
    if (deal.updated_at) {
      const daysSinceUpdate = (Date.now() - new Date(deal.updated_at).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceUpdate < 7) score += 15;
      else if (daysSinceUpdate < 14) score += 10;
      else if (daysSinceUpdate < 30) score += 5;
    }

    return Math.round(Math.min(100, Math.max(0, score)));
  }

  // ─── STATS ────────────────────────────────────────

  async getStats() {
    try {
      const total = await this.pool.query('SELECT COUNT(*) as count FROM deals');
      const active = await this.pool.query("SELECT COUNT(*) as count FROM deals WHERE stage NOT IN ('offer_accepted', 'rejected')");
      return {
        totalDeals: parseInt(total.rows[0].count),
        activeDeals: parseInt(active.rows[0].count)
      };
    } catch (error) {
      console.error('[DB] position stats error:', error.message);
      return { totalDeals: 0, activeDeals: 0 };
    }
  }
}

module.exports = Deals;
