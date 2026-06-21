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
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://biglight.jp';
const oauth = new OAuth2Client(GOOGLE_CLIENT_ID);

// ----- Email tự động (Gmail/Workspace SMTP) -----
const nodemailer = require('nodemailer');
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_FROM = process.env.MAIL_FROM || ('BIGLIGHT <' + SMTP_USER + '>');
const ADMIN_NOTIFY_TO = process.env.ADMIN_NOTIFY_TO || SMTP_USER;
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);
const SMTP_SECURE = process.env.SMTP_SECURE ? (process.env.SMTP_SECURE === 'true') : (SMTP_PORT === 465);
const SMTP_NOAUTH = process.env.SMTP_NOAUTH === 'true';   // true = SMTP relay xác thực bằng IP (không cần mật khẩu)
let transporter = null;
if (SMTP_HOST && (SMTP_PASS || SMTP_NOAUTH)) {
  const opt = { host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE, family: 4, requireTLS: !SMTP_SECURE };
  if (SMTP_PASS) opt.auth = { user: SMTP_USER, pass: SMTP_PASS };
  transporter = nodemailer.createTransport(opt);
}
async function sendInquiryMails(q) {
  if (!transporter) return;
  const sep = '\n――――――――――――――――――\n';
  const detail = `会社名：${q.company || '-'}\nお名前：${q.name}\nメール：${q.email}\n電話：${q.tel}\nお問い合わせ内容：\n${q.message}`;
  const greet = (q.company ? q.company + '\n' : '') + `${q.name} 様`;
  const autoReply = {
    from: MAIL_FROM, to: q.email,
    subject: '【BIGLIGHT株式会社】お問い合わせありがとうございます（自動返信）',
    text:
`${greet}

この度は、BIGLIGHT株式会社へお問い合わせいただき、誠にありがとうございます。
下記の内容にてお問い合わせを承りました。
内容を確認のうえ、担当者より3営業日以内にご連絡いたします。
今しばらくお待ちくださいますようお願い申し上げます。

──────────────────────────
■ お問い合わせ内容
会社名：${q.company || '（未入力）'}
お名前：${q.name}
メールアドレス：${q.email}
電話番号：${q.tel}
お問い合わせ内容：
${q.message}
──────────────────────────

※本メールは送信専用アドレスからの自動返信です。
※お心当たりのない場合は、お手数ですが本メールを破棄してください。
※3営業日を過ぎても返信がない場合は、誠に恐れ入りますが下記までお電話ください。

──────────────────────────
BIGLIGHT株式会社
〒462-0007 愛知県名古屋市北区如意一丁目112 A
TEL：052-908-7944 ／ FAX：052-908-7267
URL：https://biglight.jp
──────────────────────────`,
  };
  const notify = {
    from: MAIL_FROM, to: ADMIN_NOTIFY_TO, replyTo: q.email,
    subject: `【新規問い合わせ】${q.company || ''} ${q.name}`,
    text: `新しいお問い合わせが届きました。${sep}${detail}${sep}管理画面：https://admin.biglight.jp`,
  };
  try { await transporter.sendMail(autoReply); } catch (e) { console.error('mail autoReply:', e.message); }
  try { await transporter.sendMail(notify); } catch (e) { console.error('mail notify:', e.message); }
}

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

// ================= PUBLIC: nhận form 問い合わせ từ website =================
function setCors(res) {
  res.set('Access-Control-Allow-Origin', SITE_ORIGIN);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}
app.options('/api/inquiry', (_q, res) => { setCors(res); res.sendStatus(204); });

const rl = new Map();                      // chống spam đơn giản theo IP
function rateOk(ip) {
  const now = Date.now(), win = 10 * 60 * 1000, max = 8;
  const arr = (rl.get(ip) || []).filter(t => now - t < win);
  if (arr.length >= max) { rl.set(ip, arr); return false; }
  arr.push(now); rl.set(ip, arr); return true;
}

app.post('/api/inquiry', async (req, res) => {
  setCors(res);
  try {
    const b = req.body || {};
    if (b.website) return res.json({ ok: true });           // honeypot: bot điền -> giả thành công
    const company = String(b.company || '').trim().slice(0, 200);
    const name = String(b.name || '').trim().slice(0, 120);
    const email = String(b.email || '').trim().slice(0, 200);
    const tel = String(b.tel || '').trim().slice(0, 60);
    const message = String(b.message || '').trim().slice(0, 5000);
    if (!name || !email || !tel || !message) return res.status(400).json({ error: '必須項目が未入力です' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'メールアドレスが不正です' });
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
    if (!rateOk(ip)) return res.status(429).json({ error: 'しばらくしてから再度お試しください' });
    await pool.query(
      'INSERT INTO inquiries(company,name,email,tel,message,ip,user_agent) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [company, name, email, tel, message, ip, String(req.headers['user-agent'] || '').slice(0, 300)]
    );
    res.json({ ok: true });
    sendInquiryMails({ company, name, email, tel, message }).catch(() => {});
  } catch (e) {
    console.error('POST /api/inquiry:', e.message);
    res.status(500).json({ error: 'server error' });
  }
});

// ================= AUTH =================
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

// ================= ADMIN API =================
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
  const r = await pool.query('SELECT * FROM inquiries ORDER BY created_at DESC LIMIT 500');
  res.json({ items: r.rows });
});
app.patch('/api/inquiries/:id', requireAuth, async (req, res) => {
  const st = String((req.body || {}).status || '').trim();
  if (!['new', 'replied', 'done'].includes(st)) return res.status(400).json({ error: 'bad status' });
  await pool.query('UPDATE inquiries SET status=$1 WHERE id=$2', [st, req.params.id]);
  res.json({ ok: true });
});
app.delete('/api/inquiries/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM inquiries WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/posts', requireAuth, async (_q, res) => {
  const r = await pool.query('SELECT id,slug,title,category,status,published_at,updated_at FROM posts ORDER BY created_at DESC');
  res.json({ items: r.rows });
});

// ================= admin UI (tĩnh) =================
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
init()
  .then(() => app.listen(PORT, () => console.log('BIGLIGHT admin listening on ' + PORT)))
  .catch(e => { console.error('init failed:', e); process.exit(1); });
