const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');

const db = require('./database');
const scanner = require('./scanner');
const opensubtitles = require('./opensubtitles');

const { spawn } = require('child_process');

const app = express();

// HLS session store: Map<sessionId, { ff, dir, mediaId, startSecs, duration, lastAccess }>
const hlsSessions = new Map();

// Helper: wait for a file to appear on disk
function waitForFile(filePath, timeoutMs, intervalMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function check() {
      if (fs.existsSync(filePath)) return resolve();
      if (Date.now() - start >= timeoutMs) return reject(new Error(`Timeout waiting for ${filePath}`));
      setTimeout(check, intervalMs);
    }
    check();
  });
}

// Helper: wait for an HLS playlist to contain at least one segment (.ts entry).
// ffmpeg creates the .m3u8 file immediately but writes segments incrementally —
// serving an empty playlist causes hls.js to give up rather than retry.
function waitForPlaylistReady(playlistPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function check() {
      try {
        if (fs.existsSync(playlistPath)) {
          const contents = fs.readFileSync(playlistPath, 'utf8');
          if (contents.includes('.ts')) return resolve(contents);
        }
      } catch {}
      if (Date.now() - start >= timeoutMs) return reject(new Error(`Timeout waiting for playlist ${playlistPath}`));
      setTimeout(check, 200);
    }
    check();
  });
}

// Helper: wait for a .ts segment to be FULLY written by ffmpeg.
// A segment is complete when the next segment exists (ffmpeg has moved on),
// or when the playlist contains #EXT-X-ENDLIST (stream finished).
// Falls back to serving whatever exists after timeoutMs to avoid infinite stall.
function waitForSegmentComplete(segPath, nextSegPath, playlistPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function check() {
      if (!fs.existsSync(segPath)) {
        // Segment doesn't exist yet — keep waiting
        if (Date.now() - start >= timeoutMs) return reject(new Error(`Timeout waiting for segment ${segPath}`));
        return setTimeout(check, 100);
      }
      // Segment exists — is it fully written?
      if (fs.existsSync(nextSegPath)) return resolve(); // next segment started → this one is done
      try {
        const playlist = fs.readFileSync(playlistPath, 'utf8');
        if (playlist.includes('#EXT-X-ENDLIST')) return resolve(); // stream ended → last seg is done
      } catch {}
      if (Date.now() - start >= timeoutMs) return resolve(); // timeout safety valve — serve what we have
      setTimeout(check, 100);
    }
    check();
  });
}

// Build ffmpeg args for HLS segmenting
function buildHlsArgs(filepath, startSecs = 0, needsVideoTranscode = false, audioChannels = 0, lowQuality = false) {
  // NOTE: ffmpeg is spawned with cwd=sessionDir, so segment/playlist paths are relative.
  // This ensures stream.m3u8 contains relative filenames (seg00000.ts) not absolute paths,
  // which is required for hls.js to build correct request URLs.
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (startSecs > 0) args.push('-ss', String(startSecs));
  args.push('-i', filepath);

  if (lowQuality) {
    // Low-quality mode: scale to 720p and cap bitrate — transcode regardless of input codec.
    // Single-pass direct from source avoids the double-encode quality loss of convert→stream.
    args.push(
      '-vf', 'scale=-2:720',
      '-c:v', 'libx264', '-preset', 'ultrafast',
      '-b:v', '2000k', '-maxrate', '2000k', '-bufsize', '4000k',
      '-force_key_frames', 'expr:gte(t,n_forced*2)'
    );
  } else if (needsVideoTranscode) {
    // HEVC/H.265 and other codecs unsupported by hls.js in MPEG-TS — transcode to H.264
    args.push(
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-force_key_frames', 'expr:gte(t,n_forced*2)'
    );
  } else {
    args.push('-c:v', 'copy');
  }

  // Transcode audio to AAC stereo for browser compatibility.
  // For multi-channel sources use the Dave750 downmix algorithm (same as Jellyfin default):
  //   c0=FL c1=FR c2=FC c3=LFE c4=SL/BL c5=SR/BR (index-based, works for 5.1 and 5.1(side))
  //   LFE included at 0.5 coefficient; volume=2.0 compensates for the ~6dB gain loss from downmix.
  //   -ac 2 is intentionally omitted when pan is used — pan=stereo already declares stereo output.
  if (audioChannels >= 6) {
    args.push('-af', 'pan=stereo|c0=0.5*c2+0.707*c0+0.707*c4+0.5*c3|c1=0.5*c2+0.707*c1+0.707*c5+0.5*c3,volume=2.0');
    args.push('-c:a', 'aac', '-ar', '48000', '-b:a', '192k');
  } else {
    args.push('-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k');
  }

  args.push(
    '-avoid_negative_ts', 'make_zero',
    '-hls_time', '6',
    '-hls_list_size', '0',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', 'seg%05d.ts',
    '-f', 'hls',
    'stream.m3u8'
  );
  return args;
}

// Build ffmpeg args for music-only HLS (no video stream)
function buildMusicHlsArgs(filepath, startSecs = 0) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (startSecs > 0) args.push('-ss', String(startSecs));
  args.push('-i', filepath);
  args.push('-vn');
  args.push('-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '192k');
  args.push(
    '-avoid_negative_ts', 'make_zero',
    '-hls_time', '6',
    '-hls_list_size', '0',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', 'seg%05d.ts',
    '-f', 'hls',
    'stream.m3u8'
  );
  return args;
}

// Clean up a single HLS session
function cleanupHlsSession(sessionId) {
  const session = hlsSessions.get(sessionId);
  if (!session) return;
  try { session.ff?.kill('SIGKILL'); } catch {}
  try { fs.rmSync(session.dir, { recursive: true, force: true }); } catch {}
  hlsSessions.delete(sessionId);
  console.log(`[HLS] Session ${sessionId} cleaned up`);
}

// Session watchdog: kill sessions idle for >90s
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of hlsSessions) {
    if (now - session.lastAccess > 90000) {
      console.log(`[HLS] Session ${sessionId} expired (idle), cleaning up`);
      cleanupHlsSession(sessionId);
    }
  }
}, 30000);
const PORT = process.env.PORT || 3000;

// In-memory token store for API clients (e.g. Tauri app) that can't use cookies
const apiTokens = new Map(); // token → { userId, email, isAdmin }

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS for cross-origin clients (Tauri app on Linux/macOS)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = ['http://localhost', 'tauri://localhost', 'https://tauri.localhost'];
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: path.join(__dirname, 'data') }),
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Mailer setup helper
function getTransporter() {
  const host = process.env.SMTP_HOST || 'mailpit';
  const port = parseInt(process.env.SMTP_PORT || '1025', 10);
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  const secure = process.env.SMTP_SECURE === 'true';

  // If smtp options are provided, use them. Otherwise, default to mailpit config
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
    tls: {
      rejectUnauthorized: false
    }
  });
}

// Send approval email to admin
async function sendApprovalEmail(userEmail, approvalToken, req) {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@dtv.local';
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  
  const approveUrl = `${baseUrl}/api/admin/approve-user-direct?token=${approvalToken}`;
  const denyUrl = `${baseUrl}/api/admin/deny-user-direct?token=${approvalToken}`;

  const transporter = getTransporter();

  const mailOptions = {
    from: process.env.SMTP_FROM || '"DTV Streaming Server" <noreply@dtv.local>',
    to: adminEmail,
    subject: `[DTV] New User Approval Request - ${userEmail}`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; background-color: #ffffff; color: #1a202c;">
        <h2 style="color: #4f46e5; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px;">DTV Registration Request</h2>
        <p>A new user has registered on DTV and is waiting for your approval:</p>
        <table style="width: 100%; margin: 20px 0; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #edf2f7;">Email/Username:</td>
            <td style="padding: 8px; border-bottom: 1px solid #edf2f7;">${userEmail}</td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #edf2f7;">Request Time:</td>
            <td style="padding: 8px; border-bottom: 1px solid #edf2f7;">${new Date().toLocaleString()}</td>
          </tr>
        </table>
        <div style="margin-top: 30px; display: flex; gap: 15px;">
          <a href="${approveUrl}" style="background-color: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Approve User</a>
          <a href="${denyUrl}" style="background-color: #ef4444; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; margin-left: 10px;">Deny Request</a>
        </div>
        <p style="font-size: 0.875rem; color: #718096; margin-top: 30px;">Alternatively, you can approve users directly from the Admin Dashboard after logging in.</p>
      </div>
    `
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`Approval email sent to ${adminEmail}. MessageId: ${info.messageId}`);
  } catch (error) {
    console.error('Failed to send registration approval email:', error);
    // Log the link in the console as a fallback
    console.log(`[FALLBACK LINK] Approve: ${approveUrl}`);
    console.log(`[FALLBACK LINK] Deny: ${denyUrl}`);
  }
}

async function sendUserApprovedEmail(userEmail) {
  const transporter = getTransporter();
  const mailOptions = {
    from: process.env.SMTP_FROM || '"DTV Streaming Server" <noreply@dtv.local>',
    to: userEmail,
    subject: `[DTV] Your account has been approved`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; background-color: #ffffff; color: #1a202c;">
        <h2 style="color: #4f46e5; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px;">Welcome to DTV</h2>
        <p>Good news — your account (<strong>${userEmail}</strong>) has been approved by the administrator.</p>
        <p style="margin-top: 16px;">You can now log in and start streaming.</p>
        <p style="font-size: 0.875rem; color: #718096; margin-top: 30px;">If you didn't register for a DTV account, you can safely ignore this email.</p>
      </div>
    `
  };
  try {
    await transporter.sendMail(mailOptions);
    console.log(`Approval notification sent to ${userEmail}`);
  } catch (err) {
    console.error(`Failed to send approval notification to ${userEmail}:`, err.message);
  }
}

// Authentication Middlewares
function resolveToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return apiTokens.get(auth.slice(7)) || null;
  }
  if (req.query.token) {
    return apiTokens.get(req.query.token) || null;
  }
  return null;
}

function requireAuth(req, res, next) {
  const tokenUser = resolveToken(req);
  if (tokenUser) {
    req.session.userId  = tokenUser.userId;
    req.session.email   = tokenUser.email;
    req.session.isAdmin = tokenUser.isAdmin;
    return next();
  }
  if (req.session && req.session.userId) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized. Please log in.' });
}

function requireAdmin(req, res, next) {
  const tokenUser = resolveToken(req);
  if (tokenUser) {
    req.session.userId  = tokenUser.userId;
    req.session.email   = tokenUser.email;
    req.session.isAdmin = tokenUser.isAdmin;
    if (tokenUser.isAdmin) return next();
    return res.status(403).json({ error: 'Forbidden. Admin privileges required.' });
  }
  if (req.session && req.session.isAdmin) {
    return next();
  }
  return res.status(403).json({ error: 'Forbidden. Admin privileges required.' });
}

// Serves static files from public
app.use(express.static(path.join(__dirname, 'public')));

// AUTH API ENDPOINTS

// Register
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const existingUser = await db.get('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUser) {
      return res.status(400).json({ error: 'An account with that email already exists' });
    }

    const hash = await bcrypt.hash(password, 10);
    const token = crypto.randomBytes(32).toString('hex');

    await db.run(
      'INSERT INTO users (email, password_hash, is_approved, is_admin, approval_token) VALUES (?, ?, 0, 0, ?)',
      [email, hash, token]
    );

    // Send email to admin asynchronously
    sendApprovalEmail(email, token, req);

    return res.json({ message: 'Registration successful! Your account is pending admin approval. You will receive an email once approved.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Registration failed. Internal server error.' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!user.is_approved) {
      return res.status(403).json({ error: 'Your account is pending admin approval. Please wait for confirmation.' });
    }

    // Establish session
    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.isAdmin = !!user.is_admin;

    // Also issue a Bearer token for API clients that can't use cookies
    const apiToken = crypto.randomBytes(32).toString('hex');
    apiTokens.set(apiToken, { userId: user.id, email: user.email, isAdmin: !!user.is_admin });

    return res.json({
      message: 'Login successful',
      token: apiToken,
      user: {
        id: user.id,
        email: user.email,
        isAdmin: !!user.is_admin
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Login failed. Internal server error.' });
  }
});

// Check current user state
app.get('/api/auth/me', (req, res) => {
  const tokenUser = resolveToken(req);
  if (tokenUser) {
    return res.json({ id: tokenUser.userId, email: tokenUser.email, isAdmin: tokenUser.isAdmin });
  }
  if (req.session && req.session.userId) {
    return res.json({ id: req.session.userId, email: req.session.email, isAdmin: req.session.isAdmin });
  }
  return res.status(401).json({ error: 'Not logged in' });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    apiTokens.delete(auth.slice(7));
    return res.json({ message: 'Logout successful' });
  }
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Could not log out' });
    return res.json({ message: 'Logout successful' });
  });
});

// Rename a TV show (updates all episodes with that show_name)
app.put('/api/tv/show-name', requireAuth, async (req, res) => {
  const { oldName, newName } = req.body;
  if (!oldName || !newName || !newName.trim()) {
    return res.status(400).json({ error: 'oldName and newName are required' });
  }
  try {
    await db.run('UPDATE media_items SET show_name = ? WHERE show_name = ?', [newName.trim(), oldName]);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// TV BROWSE ENDPOINTS

// List all shows
app.get('/api/tv/shows', requireAuth, async (req, res) => {
  try {
    const { sort, order } = req.query;
    const dir = order === 'desc' ? 'DESC' : 'ASC';
    let orderClause;
    if (sort === 'release_date') {
      orderClause = `ORDER BY CASE WHEN MIN(release_date) IS NULL THEN 1 ELSE 0 END, MIN(release_date) ${dir}`;
    } else if (sort === 'added_date') {
      orderClause = `ORDER BY MAX(created_at) ${dir}`;
    } else {
      orderClause = `ORDER BY show_name ${dir}`;
    }
    const rows = await db.all(
      `SELECT show_name, COUNT(*) as episode_count,
              MIN(id) as first_id
       FROM media_items
       WHERE type = 'tv' AND show_name IS NOT NULL
       GROUP BY show_name
       ${orderClause}`
    );
    // For each show find the poster: id of ep with lowest season+episode
    const shows = await Promise.all(rows.map(async row => {
      const first = await db.get(
        `SELECT id, trailer_key, tmdb_url FROM media_items WHERE type='tv' AND show_name=?
         ORDER BY season_number ASC, episode_number ASC LIMIT 1`,
        [row.show_name]
      );
      return { show_name: row.show_name, episode_count: row.episode_count, poster_id: first?.id, trailer_key: first?.trailer_key || null, tmdb_url: first?.tmdb_url || null };
    }));
    return res.json(shows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// List seasons for a show
app.get('/api/tv/seasons', requireAuth, async (req, res) => {
  const { show } = req.query;
  if (!show) return res.status(400).json({ error: 'show param required' });
  try {
    const rows = await db.all(
      `SELECT season_number, COUNT(*) as episode_count
       FROM media_items
       WHERE type='tv' AND show_name=?
       GROUP BY season_number
       ORDER BY season_number ASC`,
      [show]
    );
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// List episodes for a show + season
app.get('/api/tv/episodes', requireAuth, async (req, res) => {
  const { show, season } = req.query;
  if (!show || !season) return res.status(400).json({ error: 'show and season params required' });
  try {
    const rows = await db.all(
      `SELECT id, title, episode_number, episode_title, duration, size
       FROM media_items
       WHERE type='tv' AND show_name=? AND season_number=?
       ORDER BY episode_number ASC`,
      [show, parseInt(season, 10)]
    );
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// MUSIC BROWSE

app.get('/api/music/artists', requireAuth, async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT artist_name,
              COUNT(*) as track_count,
              COUNT(DISTINCT album_name) as album_count,
              MIN(id) as poster_id
       FROM media_items
       WHERE type = 'music' AND artist_name IS NOT NULL
       GROUP BY artist_name
       ORDER BY artist_name ASC`
    );
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/music/albums', requireAuth, async (req, res) => {
  const { artist } = req.query;
  if (!artist) return res.status(400).json({ error: 'artist param required' });
  try {
    const rows = await db.all(
      `SELECT album_name,
              COUNT(*) as track_count,
              MIN(id) as poster_id
       FROM media_items
       WHERE type = 'music' AND artist_name = ?
       GROUP BY album_name
       ORDER BY album_name ASC`,
      [artist]
    );
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/music/tracks', requireAuth, async (req, res) => {
  const { artist, album } = req.query;
  if (!artist || !album) return res.status(400).json({ error: 'artist and album params required' });
  try {
    const rows = await db.all(
      `SELECT id, title, filename, duration, track_number, artist_name, album_name
       FROM media_items
       WHERE type = 'music' AND artist_name = ? AND album_name = ?
       ORDER BY track_number ASC NULLS LAST, title ASC`,
      [artist, album]
    );
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// MUSIC ARTIST POSTERS

function artistPosterPath(name) {
  const hash = crypto.createHash('md5').update(name).digest('hex');
  return path.join(__dirname, 'data', 'thumbnails', `artist_${hash}.jpg`);
}

app.get('/api/music/artist-poster/:name', requireAuth, async (req, res) => {
  const p = artistPosterPath(req.params.name);
  if (fs.existsSync(p)) return res.sendFile(p);

  // Fall back to the first track's extracted album art
  const thumbsDir = path.join(__dirname, 'data', 'thumbnails');
  const row = await db.get(
    `SELECT id FROM media_items WHERE type='music' AND artist_name=? ORDER BY id ASC LIMIT 1`,
    [req.params.name]
  ).catch(() => null);
  if (row) {
    const tmdbThumb  = path.join(thumbsDir, `tmdb_${row.id}.jpg`);
    const musicThumb = path.join(thumbsDir, `music_${row.id}.jpg`);
    const fallback = fs.existsSync(tmdbThumb) ? tmdbThumb : fs.existsSync(musicThumb) ? musicThumb : null;
    if (fallback) return res.sendFile(fallback);
  }

  const TRANSPARENT_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQ' +
    'AABjkB6QAAAABJRU5ErkJggg==', 'base64'
  );
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('X-Placeholder', '1');
  res.send(TRANSPARENT_PNG);
});

app.post('/api/music/artist-poster/:name', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const imageRes = await fetch(url);
    if (!imageRes.ok) return res.status(400).json({ error: 'Failed to fetch image' });
    fs.writeFileSync(artistPosterPath(req.params.name), Buffer.from(await imageRes.arrayBuffer()));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PLAYBACK PROGRESS

// Save or update playback position
app.delete('/api/media/:id/progress', requireAuth, async (req, res) => {
  try {
    await db.run(
      'DELETE FROM playback_progress WHERE user_id = ? AND media_item_id = ?',
      [req.session.userId, req.params.id]
    );
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/media/:id/progress', requireAuth, async (req, res) => {
  const { position, duration: clientDuration } = req.body;
  if (typeof position !== 'number' || position < 0) {
    return res.status(400).json({ error: 'position must be a non-negative number' });
  }
  try {
    const item = await db.get('SELECT duration FROM media_items WHERE id = ?', [req.params.id]);
    const duration = item?.duration || (typeof clientDuration === 'number' ? clientDuration : null);
    if (duration && position >= duration - 300) {
      await db.run(
        'DELETE FROM playback_progress WHERE user_id = ? AND media_item_id = ?',
        [req.session.userId, req.params.id]
      );
      return res.json({ ok: true, completed: true });
    }
    await db.run(
      `INSERT INTO playback_progress (user_id, media_item_id, position, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, media_item_id) DO UPDATE SET position = excluded.position, updated_at = CURRENT_TIMESTAMP`,
      [req.session.userId, req.params.id, position]
    );
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Get recent progress for the current user (resume list)
app.get('/api/progress/recent', requireAuth, async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT pp.media_item_id AS id, pp.position, pp.updated_at,
              mi.title, mi.type, mi.duration
       FROM playback_progress pp
       JOIN media_items mi ON mi.id = pp.media_item_id
       WHERE pp.user_id = ?
         AND (mi.duration IS NULL OR pp.position < mi.duration - 300)
       ORDER BY pp.updated_at DESC
       LIMIT 10`,
      [req.session.userId]
    );
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// MEDIA STREAMING & DOWNLOADS

// List media
app.get('/api/media', requireAuth, async (req, res) => {
  const { type, search, sort, order } = req.query;
  let query = 'SELECT id, filename, title, type, size, duration, created_at, release_date, show_name, season_number, episode_number, trailer_key, tmdb_url, artist_name, album_name FROM media_items';
  let params = [];

  const conditions = [];
  if (type) {
    conditions.push('type = ?');
    params.push(type);
  }
  if (search) {
    conditions.push('(title LIKE ? OR show_name LIKE ? OR artist_name LIKE ? OR album_name LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  const dir = order === 'desc' ? 'DESC' : 'ASC';
  if (sort === 'release_date') {
    // Items without a release date sort to the end regardless of direction
    query += ` ORDER BY CASE WHEN release_date IS NULL THEN 1 ELSE 0 END, release_date ${dir}`;
  } else if (sort === 'added_date') {
    query += ` ORDER BY created_at ${dir}`;
  } else {
    query += ` ORDER BY title ${dir}`;
  }

  try {
    const items = await db.all(query, params);
    return res.json(items);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Pushover notification helper
async function sendPushoverNotification(message) {
  const token = process.env.PUSHOVER_TOKEN;
  const user  = process.env.PUSHOVER_USER;
  if (!token || !user) return;
  try {
    const body = new URLSearchParams({ token, user, message, title: 'DTV' });
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    if (!res.ok) console.error('Pushover error:', await res.text());
  } catch (err) {
    console.error('Pushover failed:', err.message);
  }
}

// Client signals actual playback start
app.post('/api/media/:id/notify-playing', requireAuth, async (req, res) => {
  const title = (await db.get('SELECT title FROM media_items WHERE id = ?', [req.params.id]))?.title || 'Unknown';
  sendPushoverNotification(`${req.session.email} started playing "${title}"`);
  res.json({ ok: true });
});

// Audio codecs browsers support natively
const BROWSER_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le']);

// Video codecs NOT supported by hls.js in MPEG-TS containers
const HLS_UNSUPPORTED_VIDEO = new Set(['hevc', 'h265', 'av1', 'vp9', 'vp8']);

function getAudioInfo(filepath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_streams', '-select_streams', 'a:0', filepath
    ]);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.on('close', () => {
      try {
        const s = JSON.parse(out).streams?.[0];
        resolve(s ? { codec: s.codec_name || null, channels: s.channels || 0 } : { codec: null, channels: 0 });
      } catch { resolve({ codec: null, channels: 0 }); }
    });
    proc.on('error', () => resolve({ codec: null, channels: 0 }));
  });
}

// Legacy single-value wrapper used by existing callers
function getAudioCodec(filepath) {
  return getAudioInfo(filepath).then(i => i.codec);
}

function getVideoCodec(filepath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_streams', '-select_streams', 'v:0', filepath
    ]);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.on('close', () => {
      try {
        const data = JSON.parse(out);
        resolve(data.streams?.[0]?.codec_name?.toLowerCase() || null);
      } catch { resolve(null); }
    });
    proc.on('error', () => resolve(null));
  });
}

function getMediaDuration(filepath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_format', filepath
    ]);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.on('close', () => {
      try {
        const data = JSON.parse(out);
        const secs = parseFloat(data.format?.duration);
        resolve(isFinite(secs) ? secs : null);
      } catch { resolve(null); }
    });
    proc.on('error', () => resolve(null));
  });
}

// Stream Media
app.get('/api/media/:id/stream', requireAuth, async (req, res) => {
  try {
    const item = await db.get('SELECT filepath, mime_type FROM media_items WHERE id = ?', [req.params.id]);
    if (!item) {
      return res.status(404).json({ error: 'Media file not found' });
    }

    const filepath = item.filepath;
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: 'Physical media file does not exist on disk' });
    }

    const seekSecs = req.query.seek ? parseFloat(req.query.seek) : 0;

    // Quality-reduced transcode: 720p / 2 Mbps for bandwidth-limited clients
    if (req.query.transcode === '1') {
      console.log(`[Stream] Quality transcode for ID ${req.params.id}: 720p / 2Mbps`);

      const ffmpegArgs = [
        '-hide_banner', '-loglevel', 'error',
        '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda',
        ...(seekSecs > 0 ? ['-ss', String(seekSecs)] : []),
        '-i', filepath,
        '-vf', 'scale_cuda=-2:720',
        '-c:v', 'h264_nvenc',
        '-b:v', '2M', '-maxrate', '2.5M', '-bufsize', '5M',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-f', 'mp4',
        'pipe:1'
      ];

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Transfer-Encoding', 'chunked');

      const ff = spawn('ffmpeg', ffmpegArgs);
      ff.stdout.pipe(res);
      ff.stderr.on('data', d => console.error('[ffmpeg transcode]', d.toString()));

      req.on('close', () => ff.kill('SIGKILL'));
      ff.on('error', err => {
        console.error('ffmpeg spawn error:', err);
        if (!res.headersSent) res.status(500).end();
      });
      return;
    }

    // Check if audio needs transcoding
    const audioCodec = await getAudioCodec(filepath);
    const needsTranscode = audioCodec && !BROWSER_AUDIO_CODECS.has(audioCodec);

    if (needsTranscode) {
      console.log(`[Stream] Transcoding audio for ID ${req.params.id}: ${audioCodec} → AAC`);

      const ffmpegArgs = [
        '-hide_banner', '-loglevel', 'error',
        '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda',
        ...(seekSecs > 0 ? ['-ss', String(seekSecs)] : []),
        '-i', filepath,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-ac', '2',          // downmix to stereo (handles 5.1 Atmos safely)
        '-b:a', '192k',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-f', 'mp4',
        'pipe:1'
      ];

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Transfer-Encoding', 'chunked');

      const ff = spawn('ffmpeg', ffmpegArgs);
      ff.stdout.pipe(res);
      ff.stderr.on('data', d => console.error('[ffmpeg]', d.toString()));

      req.on('close', () => ff.kill('SIGKILL'));
      ff.on('error', err => {
        console.error('ffmpeg spawn error:', err);
        if (!res.headersSent) res.status(500).end();
      });
      return;
    }

    // Direct stream (no transcode needed)
    const stat = fs.statSync(filepath);
    const fileSize = stat.size;
    const range = req.headers.range;

    console.log(`[Stream Request] ID: ${req.params.id}, Range: ${range || 'None'}, Path: ${filepath}, Size: ${fileSize}, Mime: ${item.mime_type}`);

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize) {
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        return res.status(416).send('Requested range not satisfiable');
      }

      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(filepath, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': item.mime_type,
      };
      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': item.mime_type,
      };
      res.writeHead(200, head);
      fs.createReadStream(filepath).pipe(res);
    }
  } catch (err) {
    console.error('Stream error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Download Media
app.get('/api/media/:id/download', requireAuth, async (req, res) => {
  try {
    const item = await db.get('SELECT filepath, filename FROM media_items WHERE id = ?', [req.params.id]);
    if (!item) {
      return res.status(404).json({ error: 'Media not found' });
    }

    const filepath = item.filepath;
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: 'File does not exist on disk' });
    }

    res.download(filepath, item.filename);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Serve Media Thumbnail
app.get('/api/media/:id/thumbnail', requireAuth, async (req, res) => {
  const thumbsDir = path.join(__dirname, 'data', 'thumbnails');
  const tmdbPath = path.join(thumbsDir, `tmdb_${req.params.id}.jpg`);
  const musicPath = path.join(thumbsDir, `music_${req.params.id}.jpg`);

  // For TV episodes, check the show-level poster first (stable across re-indexes)
  const itemMeta = await db.get(
    'SELECT type, show_name, artist_name, album_name FROM media_items WHERE id = ?',
    [req.params.id]
  ).catch(() => null);
  if (itemMeta?.type === 'tv' && itemMeta.show_name) {
    const showPoster = scanner.tvShowPosterPath(thumbsDir, itemMeta.show_name);
    if (fs.existsSync(showPoster)) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.sendFile(showPoster);
    }
  }

  if (fs.existsSync(tmdbPath)) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.sendFile(tmdbPath);
  }
  if (fs.existsSync(musicPath)) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.sendFile(musicPath);
  }

  // For music tracks with no embedded art, fall back to the album's representative track
  const item = itemMeta;
  if (item?.type === 'music' && item.artist_name && item.album_name) {
    const rep = await db.get(
      `SELECT id FROM media_items WHERE type='music' AND artist_name=? AND album_name=? ORDER BY id ASC LIMIT 1`,
      [item.artist_name, item.album_name]
    ).catch(() => null);
    if (rep && rep.id !== parseInt(req.params.id)) {
      const repTmdb  = path.join(thumbsDir, `tmdb_${rep.id}.jpg`);
      const repMusic = path.join(thumbsDir, `music_${rep.id}.jpg`);
      const repPath  = fs.existsSync(repTmdb) ? repTmdb : fs.existsSync(repMusic) ? repMusic : null;
      if (repPath) {
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.sendFile(repPath);
      }
    }
  }

  // Return a transparent 1x1 PNG rather than 404 to avoid browser console noise.
  // X-Placeholder header lets fetch() callers detect "no real image".
  const TRANSPARENT_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQ' +
    'AABjkB6QAAAABJRU5ErkJggg==', 'base64'
  );
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('X-Placeholder', '1');
  res.send(TRANSPARENT_PNG);
});

// TMDB episode summary for a TV episode (cached as ep_meta_{id}.json)
app.get('/api/media/:id/episode-summary', requireAuth, async (req, res) => {
  const item = await db.get(
    'SELECT show_name, season_number, episode_number FROM media_items WHERE id = ? AND type = ?',
    [req.params.id, 'tv']
  ).catch(() => null);
  if (!item?.show_name || item.season_number == null || item.episode_number == null) {
    return res.json({ overview: null });
  }

  const thumbsDir = path.join(__dirname, 'data', 'thumbnails');
  const cachePath = path.join(thumbsDir, `ep_meta_${req.params.id}.json`);
  if (fs.existsSync(cachePath)) {
    return res.json(JSON.parse(fs.readFileSync(cachePath, 'utf8')));
  }

  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return res.json({ overview: null });

  try {
    // Find the series TMDB id
    const searchUrl = new URL('https://api.themoviedb.org/3/search/tv');
    searchUrl.searchParams.append('api_key', apiKey);
    searchUrl.searchParams.append('query', item.show_name);
    const searchRes = await fetch(searchUrl.toString());
    if (!searchRes.ok) return res.json({ overview: null });
    const searchData = await searchRes.json();
    if (!searchData.results?.length) return res.json({ overview: null });

    const seriesId = searchData.results[0].id;
    const epUrl = `https://api.themoviedb.org/3/tv/${seriesId}/season/${item.season_number}/episode/${item.episode_number}?api_key=${apiKey}`;
    const epRes = await fetch(epUrl);
    if (!epRes.ok) return res.json({ overview: null });
    const epData = await epRes.json();

    const result = { overview: epData.overview || null };
    fs.writeFileSync(cachePath, JSON.stringify(result));
    res.json(result);
  } catch {
    res.json({ overview: null });
  }
});

// Fetch TMDB metadata for a media item (cached as JSON in data/thumbnails/)
app.get('/api/media/:id/info', requireAuth, async (req, res) => {
  const item = await db.get('SELECT duration FROM media_items WHERE id = ?', [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json({ duration: item.duration });
});

app.get('/api/media/:id/tmdb-info', requireAuth, async (req, res) => {
  const item = await db.get('SELECT title, type, show_name FROM media_items WHERE id = ?', [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Not found' });

  const thumbsDir = path.join(__dirname, 'data', 'thumbnails');
  const cachePath = path.join(thumbsDir, `tmdb_meta_${req.params.id}.json`);

  // Serve cached metadata if present
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return res.json(cached);
  }

  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'TMDB_API_KEY not configured' });

  // For TV items use the show name so TMDB search finds the series, not a single episode
  const searchTitle = (item.type === 'tv' && item.show_name) ? item.show_name : item.title;
  const yearMatch = searchTitle.match(/\((\d{4})\)/) || searchTitle.match(/\b(19\d\d|20\d\d)\b/);
  const year = yearMatch ? yearMatch[1] : '';
  const cleanQuery = searchTitle.replace(/\(\d{4}\)/g, '').replace(/\b(19\d\d|20\d\d)\b/g, '').trim();
  const searchType = item.type === 'tv' ? 'tv' : 'movie';

  const searchUrl = new URL(`https://api.themoviedb.org/3/search/${searchType}`);
  searchUrl.searchParams.append('api_key', apiKey);
  searchUrl.searchParams.append('query', cleanQuery);
  if (year) searchUrl.searchParams.append(searchType === 'movie' ? 'primary_release_year' : 'first_air_date_year', year);

  try {
    const searchRes = await fetch(searchUrl.toString());
    if (!searchRes.ok) return res.status(502).json({ error: 'TMDB search failed' });
    const searchData = await searchRes.json();

    if (!searchData.results || searchData.results.length === 0) {
      return res.status(404).json({ error: 'No TMDB results found' });
    }

    const top = searchData.results[0];
    const detailUrl = `https://api.themoviedb.org/3/${searchType}/${top.id}?api_key=${apiKey}&append_to_response=credits,videos`;
    const detailRes = await fetch(detailUrl);
    if (!detailRes.ok) return res.status(502).json({ error: 'TMDB detail fetch failed' });
    const detail = await detailRes.json();

    const genres = (detail.genres || []).map(g => g.name);
    const cast = (detail.credits?.cast || []).slice(0, 5).map(c => c.name);
    const director = (detail.credits?.crew || []).find(c => c.job === 'Director')?.name || null;
    const creators = (detail.created_by || []).map(c => c.name);
    const networks = (detail.networks || []).map(n => n.name);
    const trailer = (detail.videos?.results || [])
      .find(v => v.site === 'YouTube' && v.type === 'Trailer') ||
      (detail.videos?.results || []).find(v => v.site === 'YouTube');

    const meta = {
      tmdb_id: detail.id,
      type: searchType,
      title: detail.title || detail.name,
      tagline: detail.tagline || null,
      overview: detail.overview || null,
      release_date: detail.release_date || detail.first_air_date || null,
      runtime: detail.runtime || (detail.episode_run_time?.[0]) || null,
      seasons: detail.number_of_seasons || null,
      vote_average: detail.vote_average ? Math.round(detail.vote_average * 10) / 10 : null,
      vote_count: detail.vote_count || null,
      genres,
      director,
      creators,
      networks,
      cast,
      tmdb_url: `https://www.themoviedb.org/${searchType}/${detail.id}`,
      trailer_key: trailer?.key || null,
    };

    if (!fs.existsSync(thumbsDir)) fs.mkdirSync(thumbsDir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(meta));

    if (meta.release_date) {
      await db.run('UPDATE media_items SET release_date = ? WHERE id = ?', [meta.release_date, req.params.id]);
    }
    if (meta.trailer_key) {
      await db.run('UPDATE media_items SET trailer_key = ? WHERE id = ?', [meta.trailer_key, req.params.id]);
    }
    if (meta.tmdb_url) {
      await db.run('UPDATE media_items SET tmdb_url = ? WHERE id = ?', [meta.tmdb_url, req.params.id]);
    }

    return res.json(meta);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Update display title
app.put('/api/media/:id/title', requireAuth, async (req, res) => {
  const { title } = req.body;
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  try {
    await db.run('UPDATE media_items SET title = ? WHERE id = ?', [title.trim(), req.params.id]);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Set poster from URL
app.post('/api/media/:id/poster', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required' });

  // Basic URL validation — must be http/https
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return res.status(400).json({ error: 'URL must use http or https' });
  }

  try {
    const imageRes = await fetch(url);
    if (!imageRes.ok) return res.status(502).json({ error: `Failed to fetch image: ${imageRes.status}` });

    const contentType = imageRes.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      return res.status(422).json({ error: 'URL does not point to an image' });
    }

    const thumbsDir = path.join(__dirname, 'data', 'thumbnails');
    if (!fs.existsSync(thumbsDir)) fs.mkdirSync(thumbsDir, { recursive: true });

    const buffer = Buffer.from(await imageRes.arrayBuffer());

    // For TV episodes, save to show-level poster so re-indexing can't clobber it
    const mediaItem = await db.get('SELECT type, show_name FROM media_items WHERE id = ?', [req.params.id]).catch(() => null);
    let posterFile;
    if (mediaItem?.type === 'tv' && mediaItem.show_name) {
      posterFile = scanner.tvShowPosterPath(thumbsDir, mediaItem.show_name);
    } else {
      posterFile = path.join(thumbsDir, `tmdb_${req.params.id}.jpg`);
    }
    fs.writeFileSync(posterFile, buffer);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Get Subtitles List
app.get('/api/media/:id/subtitles', requireAuth, async (req, res) => {
  try {
    const subs = await db.all('SELECT id, language, source FROM subtitles WHERE media_item_id = ?', [req.params.id]);
    return res.json(subs);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Serve subtitle file (with SRT-to-WebVTT on-the-fly conversion)
app.get('/api/media/:id/subtitles/:subId/file', requireAuth, async (req, res) => {
  try {
    const sub = await db.get(
      'SELECT filepath FROM subtitles WHERE id = ? AND media_item_id = ?',
      [req.params.subId, req.params.id]
    );

    if (!sub || !fs.existsSync(sub.filepath)) {
      return res.status(404).send('Subtitle not found');
    }

    const content = fs.readFileSync(sub.filepath, 'utf8');
    const ext = path.extname(sub.filepath).toLowerCase();

    // Convert SRT to WebVTT on the fly for native browser video element
    if (ext === '.srt') {
      let vttContent = content.replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2');
      // Fix numbering (WebVTT does not require node IDs, though it allows them, it's safer to strip or just prefix)
      vttContent = 'WEBVTT\n\n' + vttContent;
      res.setHeader('Content-Type', 'text/vtt');
      return res.send(vttContent);
    } else {
      res.setHeader('Content-Type', ext === '.vtt' ? 'text/vtt' : 'application/x-subrip');
      return res.sendFile(sub.filepath);
    }
  } catch (err) {
    return res.status(500).send(err.message);
  }
});

// OPENSUBTITLES API INTEGRATION

// Search OpenSubtitles
app.get('/api/media/:id/opensubtitles/search', requireAuth, async (req, res) => {
  try {
    const item = await db.get('SELECT title FROM media_items WHERE id = ?', [req.params.id]);
    if (!item) {
      return res.status(404).json({ error: 'Media not found' });
    }

    const results = await opensubtitles.searchSubtitles(item.title);
    return res.json(results);
  } catch (err) {
    console.error('OpenSubtitles search error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Download Subtitle from OpenSubtitles
app.post('/api/media/:id/opensubtitles/download', requireAuth, async (req, res) => {
  const { fileId, language } = req.body;
  if (!fileId) {
    return res.status(400).json({ error: 'fileId is required' });
  }

  try {
    const item = await db.get('SELECT id FROM media_items WHERE id = ?', [req.params.id]);
    if (!item) {
      return res.status(404).json({ error: 'Media not found' });
    }

    const { filePath } = await opensubtitles.downloadSubtitle(fileId, item.id);
    
    // Insert subtitle into DB
    const lang = language || 'en';
    await db.run(
      'INSERT INTO subtitles (media_item_id, language, filepath, source) VALUES (?, ?, ?, ?)',
      [item.id, lang, filePath, 'opensubtitles']
    );

    return res.json({ message: 'Subtitle downloaded and added successfully' });
  } catch (err) {
    console.error('OpenSubtitles download error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ADMIN PANEL ROUTES (requireAdmin protected)

// List pending users
app.get('/api/admin/users/pending', requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await db.all('SELECT id, email, created_at FROM users WHERE is_approved = 0');
    return res.json(users);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Approve User
app.post('/api/admin/users/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const user = await db.get('SELECT email FROM users WHERE id = ?', [req.params.id]);
    await db.run('UPDATE users SET is_approved = 1, approval_token = NULL WHERE id = ?', [req.params.id]);
    if (user) sendUserApprovedEmail(user.email);
    return res.json({ message: 'User approved successfully.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Deny User
app.post('/api/admin/users/:id/deny', requireAuth, requireAdmin, async (req, res) => {
  try {
    await db.run('DELETE FROM users WHERE id = ? AND is_approved = 0', [req.params.id]);
    return res.json({ message: 'User request denied and removed.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// List all users
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await db.all('SELECT id, email, is_admin, is_approved, created_at FROM users ORDER BY created_at DESC');
    return res.json(users);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Delete a user (cannot delete yourself)
app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  if (parseInt(req.params.id) === req.session.userId) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }
  try {
    await db.run('DELETE FROM users WHERE id = ?', [req.params.id]);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Folders Management
app.get('/api/admin/folders', requireAuth, requireAdmin, async (req, res) => {
  try {
    const folders = await db.all('SELECT * FROM media_folders');
    return res.json(folders);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/folders', requireAuth, requireAdmin, async (req, res) => {
  const { path: folderPath, type } = req.body;
  if (!folderPath || !type) {
    return res.status(400).json({ error: 'Path and type are required' });
  }

  if (!['movie', 'tv', 'music'].includes(type)) {
    return res.status(400).json({ error: 'Type must be movie, tv, or music' });
  }

  // Resolve directory path
  const absolutePath = path.resolve(folderPath);

  // Check if directory exists
  if (!fs.existsSync(absolutePath)) {
    return res.status(400).json({ error: `Directory does not exist on server: ${absolutePath}` });
  }

  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Specified path is a file, not a directory' });
    }

    await db.run('INSERT INTO media_folders (path, type) VALUES (?, ?)', [absolutePath, type]);
    return res.json({ message: 'Folder added successfully' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Folder path is already configured' });
    }
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/folders/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await db.run('DELETE FROM media_folders WHERE id = ?', [req.params.id]);
    return res.json({ message: 'Folder removed successfully' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// SCAN INTERVAL SCHEDULER
const scanTimers = { movie: null, tv: null, music: null };

function restartScanTimer(type, intervalMinutes) {
  if (scanTimers[type]) {
    clearInterval(scanTimers[type]);
    scanTimers[type] = null;
  }
  if (intervalMinutes > 0) {
    scanTimers[type] = setInterval(() => {
      console.log(`Scheduled auto-scan triggered for type: ${type}`);
      scanner.scanByType(type);
    }, intervalMinutes * 60 * 1000);
    console.log(`Scan timer set for ${type}: every ${intervalMinutes} min`);
  }
}

async function initScanTimers() {
  for (const type of ['movie', 'tv', 'music']) {
    const row = await db.get('SELECT value FROM settings WHERE key = ?', [`scan_interval_${type}`]);
    const mins = row ? parseInt(row.value, 10) : 0;
    restartScanTimer(type, mins);
  }
}

// Get scan interval settings
app.get('/api/admin/scan-intervals', requireAuth, requireAdmin, async (req, res) => {
  try {
    const rows = await db.all("SELECT key, value FROM settings WHERE key LIKE 'scan_interval_%'");
    const result = { movie: 0, tv: 0, music: 0 };
    for (const row of rows) {
      const type = row.key.replace('scan_interval_', '');
      result[type] = parseInt(row.value, 10);
    }
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Save scan interval settings
app.post('/api/admin/scan-intervals', requireAuth, requireAdmin, async (req, res) => {
  const { movie, tv, music } = req.body;
  try {
    for (const [type, val] of [['movie', movie], ['tv', tv], ['music', music]]) {
      const mins = Math.max(0, parseInt(val, 10) || 0);
      await db.run(
        `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [`scan_interval_${type}`, String(mins)]
      );
      restartScanTimer(type, mins);
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Scan triggers
app.post('/api/admin/scan', requireAuth, requireAdmin, (req, res) => {
  scanner.scanAll(); // Run in background
  return res.json({ message: 'Scan started in background' });
});

app.get('/api/admin/scan/status', requireAuth, requireAdmin, (req, res) => {
  return res.json(scanner.getScanStatus());
});

// DIRECT APPROVAL/DENIAL ENDPOINTS (Used in Email links)

// Direct Approve
app.get('/api/admin/approve-user-direct', async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).send('<h1>Approval token is missing</h1>');
  }

  try {
    const user = await db.get('SELECT email FROM users WHERE approval_token = ? AND is_approved = 0', [token]);
    if (!user) {
      return res.status(400).send('<h1>Invalid or expired approval token</h1>');
    }

    await db.run('UPDATE users SET is_approved = 1, approval_token = NULL WHERE approval_token = ?', [token]);
    
    // Return a nice premium HTML response
    res.send(`
      <html>
        <head>
          <title>Access Approved</title>
          <style>
            body { font-family: sans-serif; background-color: #0d0e12; color: #ffffff; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: rgba(255, 255, 255, 0.05); padding: 40px; border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.1); text-align: center; max-width: 500px; box-shadow: 0 4px 30px rgba(0, 0, 0, 0.5); backdrop-filter: blur(5px); }
            h1 { color: #10b981; margin-bottom: 20px; }
            p { color: #cbd5e1; font-size: 1.1em; line-height: 1.5; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>User Approved!</h1>
            <p>The account <strong>${user.email}</strong> has been successfully approved.</p>
            <p>They can now log in and stream media on DTV.</p>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send(`<h1>Error processing approval</h1><p>${err.message}</p>`);
  }
});

// Direct Deny
app.get('/api/admin/deny-user-direct', async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).send('<h1>Denial token is missing</h1>');
  }

  try {
    const user = await db.get('SELECT email FROM users WHERE approval_token = ? AND is_approved = 0', [token]);
    if (!user) {
      return res.status(400).send('<h1>Invalid or expired token</h1>');
    }

    await db.run('DELETE FROM users WHERE approval_token = ? AND is_approved = 0', [token]);

    res.send(`
      <html>
        <head>
          <title>Access Denied</title>
          <style>
            body { font-family: sans-serif; background-color: #0d0e12; color: #ffffff; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: rgba(255, 255, 255, 0.05); padding: 40px; border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.1); text-align: center; max-width: 500px; box-shadow: 0 4px 30px rgba(0, 0, 0, 0.5); backdrop-filter: blur(5px); }
            h1 { color: #ef4444; margin-bottom: 20px; }
            p { color: #cbd5e1; font-size: 1.1em; line-height: 1.5; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Registration Denied</h1>
            <p>The registration request for <strong>${user.email}</strong> has been denied and removed from the system.</p>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send(`<h1>Error processing denial</h1><p>${err.message}</p>`);
  }
});

// CONVERSION ENDPOINTS

// Active conversion jobs: mediaId → { ff, progress, error, duration }
const conversionJobs = new Map();

function parseConversionTime(text) {
  // ffmpeg -progress output: out_time=HH:MM:SS.µµµµµµ
  const m = text.match(/out_time=(\d+):(\d+):(\d+\.\d+)/);
  if (!m) return null;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
}

// Start a conversion job (720p, 2 Mbps H.264)
app.post('/api/media/:id/convert', requireAuth, async (req, res) => {
  const id = String(req.params.id);

  // Already running?
  if (conversionJobs.has(id)) {
    const job = conversionJobs.get(id);
    return res.json({ status: 'running', progress: job.progress });
  }

  const item = await db.get('SELECT filepath, duration FROM media_items WHERE id = ?', [id]);
  if (!item) return res.status(404).json({ error: 'Media not found' });

  const outPath = `/conversions/${id}.mkv`;

  // Already done?
  if (fs.existsSync(outPath)) {
    await db.run('UPDATE media_items SET conversion_path = ? WHERE id = ?', [outPath, id]);
    return res.json({ status: 'done' });
  }

  const duration = item.duration || await getMediaDuration(item.filepath);

  const audioInfo = await getAudioInfo(item.filepath);
  const needsAudioTranscode = audioInfo.codec && !BROWSER_AUDIO_CODECS.has(audioInfo.codec);
  let audioArgs;
  if (needsAudioTranscode) {
    console.log(`[Convert] Transcoding audio for ${id}: ${audioInfo.codec} ${audioInfo.channels}ch → AAC stereo`);
    audioArgs = audioInfo.channels >= 6
      ? ['-af', 'pan=stereo|c0=0.5*c2+0.707*c0+0.707*c4+0.5*c3|c1=0.5*c2+0.707*c1+0.707*c5+0.5*c3,volume=2.0',
         '-c:a', 'aac', '-ar', '48000', '-b:a', '192k']
      : ['-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k'];
  } else {
    audioArgs = ['-c:a', 'copy'];
  }

  const ffArgs = [
    '-hide_banner', '-loglevel', 'error',
    '-progress', 'pipe:2',
    '-i', item.filepath,
    '-vf', 'scale=-2:720',
    '-pix_fmt', 'yuv420p',
    '-c:v', 'h264_nvenc', '-preset', 'fast',
    '-g', '72', '-keyint_min', '72',
    '-b:v', '2000k', '-maxrate', '2000k', '-bufsize', '4000k',
    ...audioArgs,
    '-sn',
    outPath
  ];

  const ff = spawn('ffmpeg', ffArgs);
  const job = { ff, progress: 0, error: null, duration };
  conversionJobs.set(id, job);
  console.log(`[Convert] Started media ${id} → ${outPath}`);

  ff.stderr.on('data', (data) => {
    const secs = parseConversionTime(data.toString());
    if (secs !== null && duration) {
      job.progress = Math.min(99, Math.round((secs / duration) * 100));
    }
  });

  ff.on('close', async (code) => {
    if (code === 0 || code === null) {
      job.progress = 100;
      await db.run('UPDATE media_items SET conversion_path = ? WHERE id = ?', [outPath, id]);
      console.log(`[Convert] Done: media ${id}`);
    } else {
      job.error = `ffmpeg exited with code ${code}`;
      console.error(`[Convert] Failed: media ${id}, code ${code}`);
      fs.unlink(outPath, () => {});
    }
  });

  ff.on('error', (err) => {
    job.error = err.message;
    console.error(`[Convert] Spawn error for media ${id}:`, err.message);
  });

  res.json({ status: 'started' });
});

// Poll conversion progress
app.get('/api/media/:id/convert/status', requireAuth, async (req, res) => {
  const id = String(req.params.id);

  if (conversionJobs.has(id)) {
    const job = conversionJobs.get(id);
    if (job.error) {
      conversionJobs.delete(id);
      return res.json({ status: 'error', message: job.error });
    }
    if (job.progress === 100) {
      conversionJobs.delete(id);
      return res.json({ status: 'done' });
    }
    return res.json({ status: 'running', progress: job.progress });
  }

  const item = await db.get('SELECT conversion_path FROM media_items WHERE id = ?', [id]);
  if (item?.conversion_path && fs.existsSync(item.conversion_path)) {
    return res.json({ status: 'done' });
  }

  res.json({ status: 'none' });
});

// Cancel a running conversion or delete a completed one
app.delete('/api/media/:id/convert', requireAuth, async (req, res) => {
  const id = String(req.params.id);

  if (conversionJobs.has(id)) {
    conversionJobs.get(id).ff.kill('SIGTERM');
    conversionJobs.delete(id);
  }

  const item = await db.get('SELECT conversion_path FROM media_items WHERE id = ?', [id]);
  if (item?.conversion_path) {
    fs.unlink(item.conversion_path, () => {});
    await db.run('UPDATE media_items SET conversion_path = NULL WHERE id = ?', [id]);
  }

  res.json({ ok: true });
});

// HLS STREAMING ENDPOINTS

// Start an HLS session
app.post('/api/music/hls/start', requireAuth, async (req, res) => {
  const { mediaId } = req.body;
  if (!mediaId) return res.status(400).json({ error: 'mediaId is required' });

  try {
    const item = await db.get('SELECT filepath FROM media_items WHERE id = ? AND type = ?', [mediaId, 'music']);
    if (!item) return res.status(404).json({ error: 'Music track not found' });
    if (!fs.existsSync(item.filepath)) return res.status(404).json({ error: 'File not found on disk' });

    const duration = await getMediaDuration(item.filepath);
    const sessionId = crypto.randomUUID();
    const sessionDir = path.join(__dirname, 'data', 'hls', sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const ffArgs = buildMusicHlsArgs(item.filepath);
    const ff = spawn('ffmpeg', ffArgs, { cwd: sessionDir });
    ff.stderr.on('data', d => console.error(`[MusicHLS ${sessionId}]`, d.toString().trim()));
    ff.on('error', err => console.error(`[MusicHLS ${sessionId}] ffmpeg error:`, err.message));

    hlsSessions.set(sessionId, {
      ff, dir: sessionDir, mediaId, startSecs: 0, duration, lastAccess: Date.now()
    });

    console.log(`[MusicHLS] Session ${sessionId} started for track ${mediaId}${duration ? ` (${Math.round(duration)}s)` : ''}`);

    return res.json({
      sessionId,
      duration,
      playlistUrl: `/api/hls/${sessionId}/stream.m3u8`,
    });
  } catch (err) {
    console.error('[MusicHLS] start error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/hls/start', requireAuth, async (req, res) => {
  const { mediaId, startSecs: rawStart, useConverted, lowQuality } = req.body;
  if (!mediaId) return res.status(400).json({ error: 'mediaId is required' });
  const startSecs = parseFloat(rawStart) || 0;

  try {
    const item = await db.get('SELECT filepath, mime_type, conversion_path FROM media_items WHERE id = ?', [mediaId]);
    if (!item) return res.status(404).json({ error: 'Media not found' });

    // lowQuality streams directly from the original — single-pass transcode avoids double-encode
    const filepath = (!lowQuality && useConverted && item.conversion_path && fs.existsSync(item.conversion_path))
      ? item.conversion_path
      : item.filepath;

    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found on disk' });

    const [duration, videoCodec, audioInfo] = await Promise.all([
      getMediaDuration(filepath),
      getVideoCodec(filepath),
      getAudioInfo(filepath),
    ]);
    const needsVideoTranscode = !lowQuality && videoCodec && HLS_UNSUPPORTED_VIDEO.has(videoCodec);
    if (lowQuality) {
      console.log(`[HLS] Low-quality mode: 720p/2Mbps transcode, audio: ${audioInfo.channels}ch ${audioInfo.codec} → AAC stereo`);
    } else {
      if (needsVideoTranscode) console.log(`[HLS] Video codec "${videoCodec}" not supported by hls.js — will transcode to H.264`);
      if (audioInfo.channels >= 6) console.log(`[HLS] Multi-channel audio (${audioInfo.channels}ch ${audioInfo.codec}) — applying stereo downmix filter`);
    }

    const sessionId = crypto.randomUUID();
    const sessionDir = path.join(__dirname, 'data', 'hls', sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const ffArgs = buildHlsArgs(filepath, startSecs, needsVideoTranscode, audioInfo.channels, !!lowQuality);
    const ff = spawn('ffmpeg', ffArgs, { cwd: sessionDir });
    ff.stderr.on('data', d => console.error(`[HLS ${sessionId}]`, d.toString().trim()));
    ff.on('error', err => console.error(`[HLS ${sessionId}] ffmpeg spawn error:`, err.message));

    hlsSessions.set(sessionId, {
      ff, dir: sessionDir, mediaId, startSecs, duration, lastAccess: Date.now()
    });

    // Backfill duration into DB if it was missing (e.g. HEVC files scanner couldn't probe)
    if (duration) {
      db.run('UPDATE media_items SET duration = ? WHERE id = ? AND duration IS NULL', [Math.round(duration), mediaId]).catch(() => {});
    }

    console.log(`[HLS] Session ${sessionId} started for media ${mediaId}${startSecs > 0 ? ` at ${startSecs}s` : ''}${duration ? ` (${Math.round(duration)}s)` : ''}`);

    return res.json({
      sessionId,
      startSecs,
      duration,
      playlistUrl: `/api/hls/${sessionId}/stream.m3u8`,
    });
  } catch (err) {
    console.error('[HLS] start error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Serve the primary HLS playlist
app.get('/api/hls/:sessionId/stream.m3u8', requireAuth, async (req, res) => {
  const session = hlsSessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.lastAccess = Date.now();

  const playlistPath = path.join(session.dir, 'stream.m3u8');
  try {
    await waitForPlaylistReady(playlistPath, 20000);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.sendFile(playlistPath);
  } catch {
    console.error(`[HLS] Playlist timeout for session ${req.params.sessionId}`);
    res.status(504).json({ error: 'Playlist not ready in time' });
  }
});



// Serve HLS segments (.ts files)
app.get('/api/hls/:sessionId/:segment', requireAuth, async (req, res) => {
  const session = hlsSessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.lastAccess = Date.now();

  const segName = req.params.segment;
  // Only serve .ts files
  if (!segName.endsWith('.ts')) return res.status(400).json({ error: 'Invalid segment' });

  const segPath = path.join(session.dir, segName);

  // Compute next segment path so we can detect when this segment is fully written
  const segNumMatch = segName.match(/seg(\d+)\.ts$/);
  const nextSegNum = segNumMatch ? parseInt(segNumMatch[1], 10) + 1 : null;
  const nextSegPath = nextSegNum !== null
    ? path.join(session.dir, `seg${String(nextSegNum).padStart(5, '0')}.ts`)
    : segPath; // fallback: same path (will rely on ENDLIST check)
  const playlistPath = path.join(session.dir, 'stream.m3u8');

  try {
    await waitForSegmentComplete(segPath, nextSegPath, playlistPath, 15000);
    res.setHeader('Content-Type', 'video/MP2T');
    res.sendFile(segPath);
  } catch {
    res.status(504).json({ error: 'Segment not ready in time' });
  }
});

// Delete / stop an HLS session
app.delete('/api/hls/:sessionId', requireAuth, (req, res) => {
  cleanupHlsSession(req.params.sessionId);
  res.json({ ok: true });
});

// Start Server
db.initDb().then(() => {
  // Clean up any leftover HLS session dirs from previous run
  const hlsBaseDir = path.join(__dirname, 'data', 'hls');
  try {
    if (fs.existsSync(hlsBaseDir)) {
      fs.rmSync(hlsBaseDir, { recursive: true, force: true });
      console.log('[HLS] Cleaned up leftover HLS session dirs from previous run');
    }
    fs.mkdirSync(hlsBaseDir, { recursive: true });
  } catch (err) {
    console.error('[HLS] Failed to clean up HLS dirs on startup:', err.message);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DTV Server running on http://0.0.0.0:${PORT}`);
    // Run thumbnail generation shortly after startup so TMDb posters are
    // fetched on every container restart (not just after manual scans).
    setTimeout(() => {
      console.log('Running startup thumbnail generation...');
      scanner.generateAllMissingThumbnails()
        .catch(err => console.error('Startup thumbnail generation failed:', err));
    }, 5000);

    // Migrate existing per-episode TV posters to show-level files
    setTimeout(async () => {
      const thumbsDir = path.join(__dirname, 'data', 'thumbnails');
      try {
        const shows = await db.all(
          `SELECT show_name, MIN(id) as first_id FROM media_items WHERE type='tv' AND show_name IS NOT NULL GROUP BY show_name`
        );
        let migrated = 0;
        for (const show of shows) {
          const showPoster = scanner.tvShowPosterPath(thumbsDir, show.show_name);
          if (fs.existsSync(showPoster)) continue;
          const episodePoster = path.join(thumbsDir, `tmdb_${show.first_id}.jpg`);
          if (fs.existsSync(episodePoster)) {
            fs.copyFileSync(episodePoster, showPoster);
            migrated++;
          }
        }
        if (migrated > 0) console.log(`Migrated ${migrated} TV show poster(s) to show-level files.`);
      } catch (err) {
        console.error('TV poster migration failed:', err.message);
      }
    }, 3000);

    initScanTimers().catch(err => console.error('Failed to init scan timers:', err));

    // Backfill TV hierarchy for existing items missing show_name
    setTimeout(async () => {
      try {
        const items = await db.all(
          `SELECT mi.id, mi.filepath, mf.path as folder_path
           FROM media_items mi
           JOIN media_folders mf ON mf.id = mi.folder_id
           WHERE mi.type = 'tv' AND mi.show_name IS NULL`
        );
        if (items.length === 0) return;
        const { parseTVInfoFromPath } = scanner;
        if (!parseTVInfoFromPath) return;
        let updated = 0;
        for (const item of items) {
          const info = parseTVInfoFromPath(item.filepath, item.folder_path);
          if (info.showName) {
            await db.run(
              `UPDATE media_items SET show_name=?, season_number=?, episode_number=?, episode_title=?
               WHERE id=?`,
              [info.showName, info.seasonNumber, info.episodeNumber, info.episodeTitle, item.id]
            );
            updated++;
          }
        }
        if (updated > 0) console.log(`Backfilled TV info for ${updated} items.`);
      } catch (err) {
        console.error('TV backfill failed:', err.message);
      }
    }, 4000);

    // Backfill artist/album/track_number for existing music items
    setTimeout(async () => {
      try {
        const items = await db.all(
          `SELECT mi.id, mi.filepath, mf.path as folder_path
           FROM media_items mi
           JOIN media_folders mf ON mf.id = mi.folder_id
           WHERE mi.type = 'music' AND mi.artist_name IS NULL`
        );
        if (items.length === 0) return;
        const { parseMusicInfoFromPath } = scanner;
        let musicMetadata;
        try { musicMetadata = require('music-metadata'); } catch {}
        let updated = 0;
        for (const item of items) {
          let artistName = null, albumName = null, trackNumber = null;
          if (musicMetadata) {
            try {
              const meta = await musicMetadata.parseFile(item.filepath);
              artistName = meta.common.albumartist || meta.common.artist || null;
              albumName = meta.common.album || null;
              trackNumber = meta.common.track?.no || null;
            } catch {}
          }
          if (!artistName || !albumName) {
            const fromPath = parseMusicInfoFromPath(item.filepath, item.folder_path);
            if (!artistName) artistName = fromPath.artistName;
            if (!albumName) albumName = fromPath.albumName;
          }
          if (artistName || albumName) {
            await db.run(
              'UPDATE media_items SET artist_name=?, album_name=?, track_number=? WHERE id=?',
              [artistName, albumName, trackNumber, item.id]
            );
            updated++;
          }
        }
        if (updated > 0) console.log(`Backfilled music hierarchy for ${updated} items.`);
      } catch (err) {
        console.error('Music backfill failed:', err.message);
      }
    }, 5000);

    setTimeout(() => {
      console.log('Running startup TMDB metadata fetch...');
      scanner.generateAllMissingMetadata()
        .catch(err => console.error('Startup metadata fetch failed:', err));
    }, 10000);

    // Backfill created_at from filesystem mtime for existing rows
    setTimeout(async () => {
      try {
        const items = await db.all('SELECT id, filepath FROM media_items');
        let updated = 0;
        for (const item of items) {
          try {
            const stat = fs.statSync(item.filepath);
            await db.run('UPDATE media_items SET created_at = ? WHERE id = ?', [stat.mtime.toISOString(), item.id]);
            updated++;
          } catch {} // file may not be accessible; leave created_at as-is
        }
        if (updated > 0) console.log(`Backfilled created_at (mtime) for ${updated} items.`);
      } catch (err) {
        console.error('created_at backfill failed:', err.message);
      }
    }, 3000);

    // Backfill release_date from cached TMDB metadata JSON files
    setTimeout(async () => {
      try {
        const thumbsDir = path.join(__dirname, 'data', 'thumbnails');
        const files = fs.readdirSync(thumbsDir).filter(f => f.startsWith('tmdb_meta_') && f.endsWith('.json'));
        let updated = 0;
        for (const file of files) {
          const id = file.replace('tmdb_meta_', '').replace('.json', '');
          try {
            const meta = JSON.parse(fs.readFileSync(path.join(thumbsDir, file), 'utf8'));
            if (meta.release_date) {
              const result = await db.run(
                'UPDATE media_items SET release_date = ? WHERE id = ? AND release_date IS NULL',
                [meta.release_date, id]
              );
              if (result.changes) updated++;
            }
          } catch {}
        }
        if (updated > 0) console.log(`Backfilled release_date for ${updated} items.`);
      } catch (err) {
        console.error('release_date backfill failed:', err.message);
      }
    }, 2000);
  });
});
