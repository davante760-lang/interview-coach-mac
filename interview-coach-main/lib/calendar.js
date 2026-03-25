// Calendar Integration Module
// Connects to Google Calendar and Microsoft Outlook
// Auto-joins meetings with video links via Skribby bot

const { Pool } = require('pg');

class CalendarIntegration {
  constructor(pool) {
    this.pool = pool;
    this.pollingIntervals = new Map(); // userId -> interval
    this.botCallback = null; // Function to send bot to meeting
    this._initTable();
  }

  async _initTable() {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS calendar_connections (
          id TEXT PRIMARY KEY DEFAULT ('cal_' || substr(md5(random()::text), 1, 12)),
          user_id TEXT DEFAULT 'default',
          provider TEXT NOT NULL,
          access_token TEXT,
          refresh_token TEXT,
          token_expires_at TIMESTAMPTZ,
          email TEXT,
          enabled BOOLEAN DEFAULT true,
          auto_join BOOLEAN DEFAULT true,
          filter_keywords TEXT DEFAULT '',
          filter_external_only BOOLEAN DEFAULT false,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS calendar_events (
          id TEXT PRIMARY KEY DEFAULT ('evt_' || substr(md5(random()::text), 1, 12)),
          calendar_id TEXT REFERENCES calendar_connections(id),
          event_id TEXT,
          title TEXT,
          start_time TIMESTAMPTZ,
          end_time TIMESTAMPTZ,
          meeting_url TEXT,
          attendees JSONB DEFAULT '[]',
          bot_sent BOOLEAN DEFAULT false,
          bot_id TEXT,
          call_id TEXT,
          deal_id TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(calendar_id, event_id)
        );
      `);
      console.log('[Calendar] Tables initialized');
    } catch (e) {
      console.error('[Calendar] Table init failed:', e.message);
    }
  }

  // Set the callback for sending bots
  onBotRequest(callback) {
    this.botCallback = callback;
  }

  // ─── GOOGLE CALENDAR ──────────────────────────────

  getGoogleAuthUrl(redirectUri, clientId) {
    const scopes = encodeURIComponent('https://www.googleapis.com/auth/calendar.readonly');
    return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scopes}&access_type=offline&prompt=consent`;
  }

  async connectGoogle(code, redirectUri, clientId, clientSecret) {
    try {
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code'
        })
      });

      const tokens = await response.json();
      if (tokens.error) throw new Error(tokens.error_description || tokens.error);

      // Get user email
      const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      });
      const profile = await profileRes.json();

      const expiresAt = new Date(Date.now() + (tokens.expires_in * 1000));

      const result = await this.pool.query(`
        INSERT INTO calendar_connections (provider, access_token, refresh_token, token_expires_at, email)
        VALUES ('google', $1, $2, $3, $4)
        RETURNING *
      `, [tokens.access_token, tokens.refresh_token, expiresAt, profile.email]);

      console.log('[Calendar] Google connected:', profile.email);
      return result.rows[0];
    } catch (e) {
      console.error('[Calendar] Google connect failed:', e.message);
      return null;
    }
  }

  async _refreshGoogleToken(connection, clientId, clientSecret) {
    try {
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          refresh_token: connection.refresh_token,
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token'
        })
      });

      const tokens = await response.json();
      if (tokens.error) throw new Error(tokens.error_description || tokens.error);

      const expiresAt = new Date(Date.now() + (tokens.expires_in * 1000));

      await this.pool.query(
        'UPDATE calendar_connections SET access_token = $1, token_expires_at = $2, updated_at = NOW() WHERE id = $3',
        [tokens.access_token, expiresAt, connection.id]
      );

      connection.access_token = tokens.access_token;
      connection.token_expires_at = expiresAt;
      return true;
    } catch (e) {
      console.error('[Calendar] Google token refresh failed:', e.message);
      return false;
    }
  }

  async _fetchGoogleEvents(connection, clientId, clientSecret) {
    // Refresh token if expired
    if (new Date(connection.token_expires_at) < new Date()) {
      const refreshed = await this._refreshGoogleToken(connection, clientId, clientSecret);
      if (!refreshed) return [];
    }

    try {
      const now = new Date().toISOString();
      const later = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // Next 30 minutes

      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now}&timeMax=${later}&singleEvents=true&orderBy=startTime`,
        { headers: { Authorization: `Bearer ${connection.access_token}` } }
      );

      const data = await response.json();
      if (data.error) {
        console.error('[Calendar] Google API error:', data.error.message);
        return [];
      }

      return (data.items || []).map(event => ({
        event_id: event.id,
        title: event.summary || 'Untitled',
        start_time: event.start?.dateTime || event.start?.date,
        end_time: event.end?.dateTime || event.end?.date,
        meeting_url: this._extractMeetingUrl(event),
        attendees: (event.attendees || []).map(a => ({
          email: a.email,
          name: a.displayName || a.email,
          self: a.self || false
        }))
      }));
    } catch (e) {
      console.error('[Calendar] Google fetch failed:', e.message);
      return [];
    }
  }

  // ─── MICROSOFT OUTLOOK ────────────────────────────

  getOutlookAuthUrl(redirectUri, clientId) {
    const scopes = encodeURIComponent('Calendars.Read offline_access');
    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scopes}`;
  }

  async connectOutlook(code, redirectUri, clientId, clientSecret) {
    try {
      const response = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          scope: 'Calendars.Read offline_access'
        })
      });

      const tokens = await response.json();
      if (tokens.error) throw new Error(tokens.error_description || tokens.error);

      // Get user email
      const profileRes = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      });
      const profile = await profileRes.json();

      const expiresAt = new Date(Date.now() + (tokens.expires_in * 1000));

      const result = await this.pool.query(`
        INSERT INTO calendar_connections (provider, access_token, refresh_token, token_expires_at, email)
        VALUES ('outlook', $1, $2, $3, $4)
        RETURNING *
      `, [tokens.access_token, tokens.refresh_token, expiresAt, profile.mail || profile.userPrincipalName]);

      console.log('[Calendar] Outlook connected:', profile.mail || profile.userPrincipalName);
      return result.rows[0];
    } catch (e) {
      console.error('[Calendar] Outlook connect failed:', e.message);
      return null;
    }
  }

  async _refreshOutlookToken(connection, clientId, clientSecret) {
    try {
      const response = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          refresh_token: connection.refresh_token,
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
          scope: 'Calendars.Read offline_access'
        })
      });

      const tokens = await response.json();
      if (tokens.error) throw new Error(tokens.error_description || tokens.error);

      const expiresAt = new Date(Date.now() + (tokens.expires_in * 1000));

      await this.pool.query(
        'UPDATE calendar_connections SET access_token = $1, refresh_token = $2, token_expires_at = $3, updated_at = NOW() WHERE id = $4',
        [tokens.access_token, tokens.refresh_token || connection.refresh_token, expiresAt, connection.id]
      );

      connection.access_token = tokens.access_token;
      connection.token_expires_at = expiresAt;
      return true;
    } catch (e) {
      console.error('[Calendar] Outlook token refresh failed:', e.message);
      return false;
    }
  }

  async _fetchOutlookEvents(connection, clientId, clientSecret) {
    if (new Date(connection.token_expires_at) < new Date()) {
      const refreshed = await this._refreshOutlookToken(connection, clientId, clientSecret);
      if (!refreshed) return [];
    }

    try {
      const now = new Date().toISOString();
      const later = new Date(Date.now() + 30 * 60 * 1000).toISOString();

      const response = await fetch(
        `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${now}&endDateTime=${later}&$select=subject,start,end,onlineMeeting,attendees,webLink`,
        { headers: { Authorization: `Bearer ${connection.access_token}` } }
      );

      const data = await response.json();
      if (data.error) {
        console.error('[Calendar] Outlook API error:', data.error.message);
        return [];
      }

      return (data.value || []).map(event => ({
        event_id: event.id,
        title: event.subject || 'Untitled',
        start_time: event.start?.dateTime + 'Z',
        end_time: event.end?.dateTime + 'Z',
        meeting_url: event.onlineMeeting?.joinUrl || this._extractUrlFromText(event.body?.content || ''),
        attendees: (event.attendees || []).map(a => ({
          email: a.emailAddress?.address,
          name: a.emailAddress?.name || a.emailAddress?.address,
          self: false
        }))
      }));
    } catch (e) {
      console.error('[Calendar] Outlook fetch failed:', e.message);
      return [];
    }
  }

  // ─── MEETING URL EXTRACTION ────────────────────────

  _extractMeetingUrl(googleEvent) {
    // Google Meet link from conference data
    if (googleEvent.conferenceData?.entryPoints) {
      const video = googleEvent.conferenceData.entryPoints.find(e => e.entryPointType === 'video');
      if (video) return video.uri;
    }

    // Check hangout link
    if (googleEvent.hangoutLink) return googleEvent.hangoutLink;

    // Search description and location for meeting URLs
    const text = (googleEvent.description || '') + ' ' + (googleEvent.location || '');
    return this._extractUrlFromText(text);
  }

  _extractUrlFromText(text) {
    if (!text) return null;
    const patterns = [
      /https:\/\/meet\.google\.com\/[a-z-]+/i,
      /https:\/\/[a-z0-9]+\.zoom\.us\/j\/\d+[^\s"]*/i,
      /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s"]*/i,
      /https:\/\/teams\.live\.com\/meet\/[^\s"]*/i
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[0];
    }
    return null;
  }

  // ─── POLLING ENGINE ───────────────────────────────

  async startPolling(googleClientId, googleClientSecret, outlookClientId, outlookClientSecret) {
    console.log('[Calendar] Starting polling engine (every 15s)');
    this._pendingBots = new Set(); // In-memory lock to prevent duplicates

    const poll = async () => {
      try {
        const connections = await this.pool.query(
          'SELECT * FROM calendar_connections WHERE enabled = true AND auto_join = true'
        );

        for (const conn of connections.rows) {
          let events = [];

          if (conn.provider === 'google') {
            events = await this._fetchGoogleEvents(conn, googleClientId, googleClientSecret);
          } else if (conn.provider === 'outlook') {
            events = await this._fetchOutlookEvents(conn, outlookClientId, outlookClientSecret);
          }

          for (const event of events) {
            if (!event.meeting_url) continue;

            // Apply filters
            if (conn.filter_keywords) {
              const keywords = conn.filter_keywords.split(',').map(k => k.trim().toLowerCase());
              const titleLower = event.title.toLowerCase();
              if (!keywords.some(k => titleLower.includes(k))) continue;
            }

            if (conn.filter_external_only) {
              const hasExternal = event.attendees.some(a => !a.self && !a.email?.endsWith(conn.email?.split('@')[1]));
              if (!hasExternal) continue;
            }

            // Check if we already sent a bot for this event at this time
            const existing = await this.pool.query(
              'SELECT id, start_time FROM calendar_events WHERE calendar_id = $1 AND event_id = $2 AND bot_sent = true',
              [conn.id, event.event_id]
            );

            // Skip if bot already sent for this exact start time
            // If rescheduled (start time changed), treat as new event
            if (existing.rows.length > 0) {
              const existingStart = new Date(existing.rows[0].start_time).getTime();
              const newStart = new Date(event.start_time).getTime();
              if (Math.abs(existingStart - newStart) < 60000) continue; // Same time, skip
              // Different time — rescheduled, reset bot_sent
              await this.pool.query(
                'UPDATE calendar_events SET bot_sent = false, start_time = $1 WHERE id = $2',
                [event.start_time, existing.rows[0].id]
              );
            }

            // Check if meeting starts within 2 minutes
            const startTime = new Date(event.start_time);
            const now = new Date();
            const minutesUntilStart = (startTime - now) / 60000;

            if (minutesUntilStart <= 5 && minutesUntilStart >= -30) {
              // In-memory lock — skip if already sending bot for this event
              const lockKey = conn.id + ':' + event.event_id;
              if (this._pendingBots.has(lockKey)) continue;
              this._pendingBots.add(lockKey);

              console.log('[Calendar] Auto-joining:', event.title, '| URL:', event.meeting_url);

              // Save event
              await this.pool.query(`
                INSERT INTO calendar_events (calendar_id, event_id, title, start_time, end_time, meeting_url, attendees, bot_sent)
                VALUES ($1, $2, $3, $4, $5, $6, $7, true)
                ON CONFLICT (calendar_id, event_id) DO UPDATE SET bot_sent = true
              `, [conn.id, event.event_id, event.title, event.start_time, event.end_time, event.meeting_url, JSON.stringify(event.attendees)]);

              // Send the bot
              if (this.botCallback) {
                this.botCallback({
                  meetingUrl: event.meeting_url,
                  title: event.title,
                  attendees: event.attendees,
                  calendarId: conn.id,
                  eventId: event.event_id
                });
              }
            }
          }
        }
      } catch (e) {
        console.error('[Calendar] Poll error:', e.message);
      }
    };

    // Run immediately then every 60 seconds
    poll();
    this._pollInterval = setInterval(poll, 15000);
  }

  stopPolling() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  // ─── MANAGEMENT ───────────────────────────────────

  async listConnections() {
    try {
      const result = await this.pool.query(
        'SELECT id, provider, email, enabled, auto_join, filter_keywords, filter_external_only, created_at FROM calendar_connections ORDER BY created_at DESC'
      );
      return result.rows;
    } catch (e) { return []; }
  }

  async updateConnection(id, updates) {
    const fields = [];
    const values = [];
    let idx = 1;

    if (updates.enabled !== undefined) { fields.push(`enabled = $${idx++}`); values.push(updates.enabled); }
    if (updates.auto_join !== undefined) { fields.push(`auto_join = $${idx++}`); values.push(updates.auto_join); }
    if (updates.filter_keywords !== undefined) { fields.push(`filter_keywords = $${idx++}`); values.push(updates.filter_keywords); }
    if (updates.filter_external_only !== undefined) { fields.push(`filter_external_only = $${idx++}`); values.push(updates.filter_external_only); }

    if (!fields.length) return null;
    fields.push(`updated_at = NOW()`);
    values.push(id);

    try {
      await this.pool.query(`UPDATE calendar_connections SET ${fields.join(', ')} WHERE id = $${idx}`, values);
      return true;
    } catch (e) { return false; }
  }

  async deleteConnection(id) {
    try {
      await this.pool.query('DELETE FROM calendar_events WHERE calendar_id = $1', [id]);
      await this.pool.query('DELETE FROM calendar_connections WHERE id = $1', [id]);
      return true;
    } catch (e) { return false; }
  }

  async getUpcomingEvents(limit = 10) {
    try {
      const result = await this.pool.query(`
        SELECT ce.*, cc.provider, cc.email
        FROM calendar_events ce
        JOIN calendar_connections cc ON ce.calendar_id = cc.id
        WHERE ce.start_time > NOW() - INTERVAL '1 hour'
        ORDER BY ce.start_time ASC
        LIMIT $1
      `, [limit]);
      return result.rows;
    } catch (e) { return []; }
  }
}

module.exports = CalendarIntegration;
