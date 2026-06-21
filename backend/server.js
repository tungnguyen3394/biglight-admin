// BIGLIGHT Admin — backend (Express + PostgreSQL + Google login)
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');
const path = require('path');
const fs = require('fs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const oauth = new OAuth2Client(GOOGLE_CLIENT_ID);

async function init() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

const app = express();
app.set('trust proxy', 1);                 // chạy sau Caddy (HTTPS)
app.use(express.json({ limit: '4mb' }));
app.use(session({
  store: new PgSession({ pool, tableName: 'admin_session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 14,      // 14 ngày
  },
}));

// ---- public ----
app.get('/healthz', (_q, res) => res.json({ ok: true }));
app.get('/api/config', (_q, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID }));
app.get('/api/me', (req, res) => res.json({ user: req.session.user || null }));

app.post('/auth/google', async (req, res) => {
  try {
    const { credential } = req.body || {};
    if (!credential) return res.status(400).json({ error: 'no credential' });
    const ticket = await oauth.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    const email = (p.email || '').toLowerCase();
    if (!p.email_verified || !ADMIN_EMAILS.includes(email)) {
      return res.status(403).json({ error: 'このアカウントは許可されていません' });
    }
    req.session.user = { email, name: p.name || email, picture: p.picture || '' };
    res.json({ ok: true, user: req.session.user });
  } catch (e) {
    console.error('auth/google:', e.message);
    res.status(401).json({ error: 'invalid token' });
  }
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'unauthorized' });
}

// ---- API (Phase 2/3 sẽ mở rộng) ----
app.get('/api/stats', requireAuth, async (_q, res) => {
  try {
    const a = await pool.query("SELECT COUNT(*)::int n FROM inquiries WHERE status='new'");
    const b = await pool.query("SELECT COUNT(*)::int n FROM inquiries");
    const c = await pool.query("SELECT COUNT(*)::int n FROM posts WHERE status='published'");
    const d = await pool.query("SELECT COUNT(*)::int n FROM posts");
    res.json({ inquiriesNew: a.rows[0].n, inquiriesTotal: b.rows[0].n, postsPublished: c.rows[0].n, postsTotal: d.rows[0].n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/inquiries', requireAuth, async (_q, res) => {
  const r = await pool.query('SELECT * FROM inquiries ORDER BY created_at DESC LIMIT 300');
  res.json({ items: r.rows });
});
app.get('/api/posts', requireAuth, async (_q, res) => {
  const r = await pool.query('SELECT id,slug,title,category,status,published_at,updated_at FROM posts ORDER BY created_at DESC');
  res.json({ items: r.rows });
});

// ---- admin UI (tĩnh) ----
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
init()
  .then(() => app.listen(PORT, () => console.log('BIGLIGHT admin listening on ' + PORT)))
  .catch(e => { console.error('init failed:', e); process.exit(1); });
