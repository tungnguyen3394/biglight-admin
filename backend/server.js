// BIGLIGHT Admin — backend (Express + PostgreSQL + Google login)
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const news = require('./news');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ----- アップロード (アイキャッチ画像) -> /site/assets/uploads -> biglight.jp/assets/uploads -----
const UP_DIR = path.join(process.env.SITE_DIR || '/site', 'assets', 'uploads');
try { fs.mkdirSync(UP_DIR, { recursive: true }); } catch (e) {}
const upload = multer({
  storage: multer.diskStorage({
    destination: (_q, _f, cb) => cb(null, UP_DIR),
    filename: (_q, file, cb) => {
      let ext = (path.extname(file.originalname) || '').toLowerCase().replace(/[^.a-z0-9]/g, '');
      if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) ext = '.jpg';
      cb(null, 'img-' + Date.now().toString(36) + '-' + Math.round(Math.random() * 1e6).toString(36) + ext);
    }
  }),
  limits: { fileSize: 6 * 1024 * 1024 },   // 6MB
  fileFilter: (_q, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('JPG / PNG / WEBP のみ対応しています'), ok);
  }
});
// ----- アップロード (資料ファイル PDF等) -> /site/assets/materials -> biglight.jp/assets/materials -----
const MAT_DIR = path.join(process.env.SITE_DIR || '/site', 'assets', 'materials');
try { fs.mkdirSync(MAT_DIR, { recursive: true }); } catch (e) {}
const MAT_EXT = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.zip', '.txt', '.jpg', '.jpeg', '.png', '.webp'];
const matUpload = multer({
  storage: multer.diskStorage({
    destination: (_q, _f, cb) => cb(null, MAT_DIR),
    filename: (_q, file, cb) => cb(null, 'tmp-' + Date.now().toString(36) + '-' + Math.round(Math.random() * 1e6).toString(36))
  }),
  limits: { fileSize: 24 * 1024 * 1024 },   // 24MB (giới hạn đính kèm Gmail ~25MB)
  fileFilter: (_q, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase();
    cb(MAT_EXT.includes(ext) ? null : new Error('対応していないファイル形式です'), MAT_EXT.includes(ext));
  }
});
function matExt(orig) { const e = (path.extname(orig || '') || '').toLowerCase(); return MAT_EXT.includes(e) ? e : '.pdf'; }

function normTags(t) {
  const arr = Array.isArray(t) ? t : String(t || '').split(',');
  const out = arr.map(s => String(s).trim()).filter(Boolean).slice(0, 12);
  return out.length ? out.join(', ') : null;
}
// ----- posts: danh sách cột + builder giá trị (SEO標準エディタ) -----
const PCOLS = ['slug', 'title', 'category', 'subcategory', 'excerpt', 'body', 'cover_image', 'cover_alt', 'cover_caption', 'cover_title', 'lazy_load', 'meta_description', 'seo_title', 'focus_keyword', 'sub_keyword', 'related_keywords', 'canonical_url', 'robots_index', 'robots_follow', 'og_title', 'og_description', 'og_image', 'status', 'published_at', 'author', 'tags', 'faq', 'cta_blocks', 'jsonld_types', 'related_articles', 'related_category', 'download_pdf', 'consult_block', 'pinned', 'featured'];
function postVals(b, old, slug, status, pub) {
  const t = k => (b[k] != null ? b[k] : (old ? old[k] : null));
  const bl = (k, def) => (b[k] !== undefined ? !!b[k] : (old ? old[k] : def));
  const js = (k, def) => (b[k] !== undefined ? JSON.stringify(b[k]) : (old && old[k] != null ? JSON.stringify(old[k]) : JSON.stringify(def)));
  return [
    slug,
    String(t('title') || '').trim(),
    t('category') || 'news',
    t('subcategory') || null,
    t('excerpt') || null,
    t('body') || null,
    t('cover_image') || null,
    t('cover_alt') || null,
    t('cover_caption') || null,
    t('cover_title') || null,
    bl('lazy_load', true),
    t('meta_description') || null,
    t('seo_title') || null,
    (String(t('focus_keyword') || '').trim().slice(0, 120)) || null,
    t('sub_keyword') || null,
    t('related_keywords') || null,
    t('canonical_url') || null,
    bl('robots_index', true),
    bl('robots_follow', true),
    t('og_title') || null,
    t('og_description') || null,
    t('og_image') || null,
    status,
    pub,
    String(t('author') || 'BIGLIGHT編集部').trim().slice(0, 120),
    (b.tags != null ? normTags(b.tags) : (old ? old.tags : null)),
    js('faq', []),
    js('cta_blocks', []),
    js('jsonld_types', { article: true, breadcrumb: true, organization: true }),
    t('related_articles') || null,
    t('related_category') || null,
    t('download_pdf') || null,
    bl('consult_block', false),
    bl('pinned', false),
    bl('featured', false)
  ];
}
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

const MAIL_SIGN =
`──────────────────────────
BIGLIGHT株式会社
〒462-0007 愛知県名古屋市北区如意一丁目112 A
TEL：052-908-7944 ／ FAX：052-908-7267
URL：https://biglight.jp
──────────────────────────`;

// 資料請求のお客様へ 資料（file/link）をメール送信
async function sendMaterialsMail(dl, mats, extraMsg) {
  if (!transporter) throw new Error('SMTP が設定されていません');
  const greet = (dl.company ? dl.company + '\n' : '') + `${dl.name || 'ご担当者'} 様`;
  const links = mats.map(m => {
    const url = m.link_url || m.file_url;
    return `・${m.name}${url ? '\n  ' + url : ''}`;
  }).join('\n');
  const attachments = mats
    .filter(m => m.filename)
    .map(m => ({ filename: (m.name || 'material') + matExt(m.filename), path: path.join(MAT_DIR, m.filename) }))
    .filter(a => { try { return fs.existsSync(a.path); } catch (e) { return false; } });
  const mail = {
    from: MAIL_FROM, to: dl.email, replyTo: ADMIN_NOTIFY_TO,
    subject: '【BIGLIGHT株式会社】ご請求資料の送付',
    attachments,
    text:
`${greet}

この度は、BIGLIGHT株式会社の資料をご請求いただき、誠にありがとうございます。
ご請求いただきました資料をお送りいたします。
${extraMsg ? '\n' + extraMsg + '\n' : ''}
──────────────────────────
■ 資料一覧
${links || '（資料が選択されていません）'}
──────────────────────────

ご不明な点がございましたら、お気軽にお問い合わせください。
今後ともBIGLIGHT株式会社をよろしくお願い申し上げます。

${MAIL_SIGN}`,
  };
  await transporter.sendMail(mail);
}

// ---- メール送信: 各自の GAS(Gmail) を優先、なければ SMTP ----
const MIME_MAP = { '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.csv': 'text/csv', '.zip': 'application/zip', '.txt': 'text/plain', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
async function buildAttachments(materialIds) {
  const ids = (Array.isArray(materialIds) ? materialIds : []).map(x => parseInt(x, 10)).filter(Boolean);
  if (!ids.length) return [];
  const mats = (await pool.query('SELECT * FROM materials WHERE id = ANY($1::bigint[])', [ids])).rows;
  return mats.filter(m => m.filename)
    .map(m => ({ name: (m.name || 'material') + matExt(m.filename), path: path.join(MAT_DIR, m.filename) }))
    .filter(a => { try { return fs.existsSync(a.path); } catch (e) { return false; } });
}
// req から送信者を判定 → GAS 優先・SMTP フォールバック
async function sendMailSmart(req, opt) {
  const u = req.session.user;
  const prof = (await pool.query('SELECT gas_url FROM profiles WHERE email=$1', [u.email])).rows[0] || {};
  const gas = (prof.gas_url || u.gas_url || '').trim();
  const atts = await buildAttachments(opt.materialIds);
  if (gas) {
    const attachments = atts.map(a => ({ name: a.name, mimeType: MIME_MAP[path.extname(a.name).toLowerCase()] || 'application/octet-stream', dataBase64: fs.readFileSync(a.path).toString('base64') }));
    const payload = { to: opt.to, subject: opt.subject, body: opt.body, cc: opt.cc || '', bcc: opt.bcc || '', attachments };
    const resp = await fetch(gas, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const txt = await resp.text();
    let ok = resp.ok; try { const j = JSON.parse(txt); if (j && j.ok === false) ok = false; } catch (e) {}
    if (!ok) throw new Error('GAS送信エラー: ' + txt.slice(0, 200));
    return { via: 'gas' };
  }
  if (transporter) {
    await transporter.sendMail({ from: MAIL_FROM, to: opt.to, replyTo: opt.replyTo || ADMIN_NOTIFY_TO, subject: opt.subject, text: opt.body, attachments: atts.map(a => ({ filename: a.name, path: a.path })) });
    return { via: 'smtp' };
  }
  throw new Error('メール送信手段がありません（GAS未登録・SMTP未設定）');
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

// ----- public: 資料ダウンロード lead -----
app.options('/api/download', (_q, res) => { setCors(res); res.sendStatus(204); });
app.post('/api/download', async (req, res) => {
  setCors(res);
  try {
    const b = req.body || {};
    if (b.website) return res.json({ ok: true });
    const company = String(b.company || '').trim().slice(0, 200);
    const name = String(b.name || '').trim().slice(0, 120);
    const email = String(b.email || '').trim().slice(0, 200);
    if (!name || !email) return res.status(400).json({ error: '必須項目が未入力です' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'メールアドレスが不正です' });
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
    if (!rateOk(ip)) return res.status(429).json({ error: 'しばらくしてから再度お試しください' });
    const interest = (Array.isArray(b.interest) ? b.interest.join(' / ') : String(b.interest || '')).slice(0, 500);
    const note = String(b.note || '').trim().slice(0, 2000);
    await pool.query('INSERT INTO downloads(company,name,email,interest,note,ip) VALUES($1,$2,$3,$4,$5,$6)', [company, name, email, interest, note, ip]);
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/download:', e.message);
    res.status(500).json({ error: 'server error' });
  }
});

// ----- public: đếm lượt xem bài viết (beacon từ trang /news/<slug>/) -----
app.options('/api/posts/:id/view', (_q, res) => { setCors(res); res.sendStatus(204); });
app.post('/api/posts/:id/view', async (req, res) => {
  setCors(res);
  try { await pool.query('UPDATE posts SET views = views + 1 WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.json({ ok: false }); }
});
// public: bài viết mới nhất cho khối news trang chủ
app.options('/api/posts/latest', (_q, res) => { setCors(res); res.sendStatus(204); });
app.get('/api/posts/latest', async (_q, res) => {
  setCors(res);
  try { const r = await pool.query("SELECT slug,title,category,published_at FROM posts WHERE status='published' ORDER BY published_at DESC NULLS LAST, created_at DESC LIMIT 5"); res.json({ items: r.rows }); }
  catch (e) { res.json({ items: [] }); }
});

function slugify(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9぀-ヿ一-鿿-]+/g, '')
    .replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

// ================= AUTH =================
app.get('/healthz', (_q, res) => res.json({ ok: true }));
app.get('/api/config', (_q, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID }));
app.get('/api/me', (req, res) => res.json({ user: req.session.user || null }));

function sessionUser(prof) {
  return { email: prof.email, name: prof.name || prof.email, picture: prof.picture || '', role: prof.role, mail_enabled: !!prof.mail_enabled, gas_url: prof.gas_url || '', status: prof.status };
}
app.post('/auth/google', async (req, res) => {
  try {
    const { credential } = req.body || {};
    if (!credential) return res.status(400).json({ error: 'no credential' });
    const ticket = await oauth.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    const email = (p.email || '').toLowerCase();
    if (!p.email_verified) return res.status(403).json({ error: 'メールが確認されていません' });
    const boot = ADMIN_EMAILS.includes(email);
    // profiles に自動登録（初回=承認待ち。ADMIN_EMAILS は常に admin/有効）
    const existing = (await pool.query('SELECT * FROM profiles WHERE email=$1', [email])).rows[0];
    let prof;
    if (!existing) {
      prof = (await pool.query(
        'INSERT INTO profiles(email,name,picture,role,status,mail_enabled,last_login) VALUES($1,$2,$3,$4,$5,$6,now()) RETURNING *',
        [email, p.name || email, p.picture || '', boot ? 'admin' : 'viewer', boot ? 'active' : 'pending', boot])).rows[0];
    } else {
      prof = (await pool.query(
        `UPDATE profiles SET name=$2, picture=$3, last_login=now()${boot ? ", role='admin', status='active'" : ''} WHERE email=$1 RETURNING *`,
        [email, p.name || existing.name || email, p.picture || existing.picture || ''])).rows[0];
    }
    if (prof.status !== 'active' && !boot) {
      return res.status(403).json({ error: prof.status === 'disabled' ? 'このアカウントは無効化されています。' : '承認待ちです。管理者の承認をお待ちください。' });
    }
    req.session.user = sessionUser(prof);
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
function isAdmin(req) { const u = req.session && req.session.user; return !!u && (u.role === 'admin' || ADMIN_EMAILS.includes(u.email)); }
function requireAdmin(req, res, next) { if (isAdmin(req)) return next(); res.status(403).json({ error: '管理者権限が必要です' }); }
let ROLE_PERMS = {};
async function loadPerms() { try { const r = await pool.query("SELECT val FROM app_meta WHERE key='role_perms'"); ROLE_PERMS = (r.rows[0] && r.rows[0].val) || {}; } catch (e) { ROLE_PERMS = {}; } }
function can(req, appKey, action) { if (isAdmin(req)) return true; const u = req.session && req.session.user; if (!u) return false; const rp = ROLE_PERMS[u.role]; return !!(rp && rp[appKey] && rp[appKey][action]); }
function requirePerm(appKey, action) { return (req, res, next) => can(req, appKey, action) ? next() : res.status(403).json({ error: '権限がありません' }); }
function requireMail(req, res, next) { const u = req.session && req.session.user; if (u && (u.mail_enabled || isAdmin(req))) return next(); res.status(403).json({ error: 'メール送信の権限がありません（管理者に許可を依頼してください）' }); }

// ---- ユーザー管理 (admin) ----
app.get('/api/profiles', requireAuth, requireAdmin, async (_q, res) => {
  const r = await pool.query('SELECT email,name,picture,role,status,mail_enabled,gas_url,last_login,created_at FROM profiles ORDER BY (status=\'pending\') DESC, last_login DESC NULLS LAST');
  res.json({ items: r.rows });
});
app.put('/api/profiles/:email', requireAuth, requireAdmin, async (req, res) => {
  try {
    const email = String(req.params.email || '').toLowerCase();
    const cur = (await pool.query('SELECT * FROM profiles WHERE email=$1', [email])).rows[0];
    if (!cur) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const role = ['admin', 'manager', 'staff', 'viewer'].includes(b.role) ? b.role : cur.role;
    const status = ['pending', 'active', 'disabled'].includes(b.status) ? b.status : cur.status;
    const mail = b.mail_enabled !== undefined ? !!b.mail_enabled : cur.mail_enabled;
    const r = await pool.query('UPDATE profiles SET role=$1,status=$2,mail_enabled=$3 WHERE email=$4 RETURNING *', [role, status, mail, email]);
    res.json({ item: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/profiles/:email', requireAuth, requireAdmin, async (req, res) => {
  const email = String(req.params.email || '').toLowerCase();
  if (ADMIN_EMAILS.includes(email)) return res.status(400).json({ error: 'このアカウントは削除できません（管理者）' });
  await pool.query('DELETE FROM profiles WHERE email=$1', [email]);
  res.json({ ok: true });
});
// ---- 権限マトリクス ----
app.get('/api/perms', requireAuth, async (req, res) => {
  const u = req.session.user;
  res.json({ role: u.role, isAdmin: isAdmin(req), mail_enabled: !!u.mail_enabled, gas_set: !!u.gas_url, gas_url: u.gas_url || '', rolePerms: ROLE_PERMS });
});
app.put('/api/perms', requireAuth, requireAdmin, async (req, res) => {
  const val = (req.body || {}).rolePerms || {};
  await pool.query("INSERT INTO app_meta(key,val) VALUES('role_perms',$1) ON CONFLICT(key) DO UPDATE SET val=$1", [JSON.stringify(val)]);
  await loadPerms();
  res.json({ ok: true });
});
// ---- 自分の GAS 設定 ----
app.post('/api/me/gas', requireAuth, async (req, res) => {
  const url = String((req.body || {}).gas_url || '').trim();
  if (url && !/^https:\/\/script\.google\.com\//.test(url)) return res.status(400).json({ error: 'GAS の URL 形式が正しくありません' });
  await pool.query('UPDATE profiles SET gas_url=$1 WHERE email=$2', [url || null, req.session.user.email]);
  req.session.user.gas_url = url;
  res.json({ ok: true });
});

// ================= ADMIN API =================
app.get('/api/stats', requireAuth, async (_q, res) => {
  try {
    const a = await pool.query("SELECT COUNT(*)::int n FROM inquiries WHERE status='new'");
    const b = await pool.query("SELECT COUNT(*)::int n FROM inquiries");
    const c = await pool.query("SELECT COUNT(*)::int n FROM posts WHERE status='published'");
    const d = await pool.query("SELECT COUNT(*)::int n FROM posts");
    const dr = await pool.query("SELECT COUNT(*)::int n FROM posts WHERE status='draft'");
    const e2 = await pool.query("SELECT COUNT(*)::int n FROM downloads");
    const top = await pool.query("SELECT id,slug,title,views,status FROM posts ORDER BY views DESC, created_at DESC LIMIT 10");
    res.json({ inquiriesNew: a.rows[0].n, inquiriesTotal: b.rows[0].n, postsPublished: c.rows[0].n, postsTotal: d.rows[0].n, postsDraft: dr.rows[0].n, downloadsTotal: e2.rows[0].n, topPosts: top.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/inquiries', requireAuth, async (_q, res) => {
  const r = await pool.query('SELECT * FROM inquiries ORDER BY created_at DESC LIMIT 500');
  res.json({ items: r.rows });
});
app.patch('/api/inquiries/:id', requireAuth, requirePerm('inquiries', 'edit'), async (req, res) => {
  const st = String((req.body || {}).status || '').trim();
  if (!['new', 'replied', 'done'].includes(st)) return res.status(400).json({ error: 'bad status' });
  await pool.query('UPDATE inquiries SET status=$1 WHERE id=$2', [st, req.params.id]);
  res.json({ ok: true });
});
app.delete('/api/inquiries/:id', requireAuth, requirePerm('inquiries', 'del'), async (req, res) => {
  await pool.query('DELETE FROM inquiries WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/downloads', requireAuth, async (_q, res) => {
  const r = await pool.query('SELECT * FROM downloads ORDER BY created_at DESC LIMIT 500');
  res.json({ items: r.rows });
});
app.delete('/api/downloads/:id', requireAuth, requirePerm('downloads', 'del'), async (req, res) => {
  await pool.query('DELETE FROM downloads WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ----- 資料請求のお客様へ 資料をメール送信 -----
app.post('/api/downloads/:id/send', requireAuth, requireMail, async (req, res) => {
  try {
    const b = req.body || {};
    const ids = (Array.isArray(b.materialIds) ? b.materialIds : []).map(x => parseInt(x, 10)).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: '送信する資料を選択してください' });
    const dl = (await pool.query('SELECT * FROM downloads WHERE id=$1', [req.params.id])).rows[0];
    if (!dl) return res.status(404).json({ error: 'not found' });
    if (!dl.email) return res.status(400).json({ error: 'お客様のメールがありません' });
    const mats = (await pool.query('SELECT * FROM materials WHERE id = ANY($1::bigint[])', [ids])).rows;
    if (!mats.length) return res.status(400).json({ error: '資料が見つかりません' });
    const extraMsg = String(b.message || '').trim();
    const greet = (dl.company ? dl.company + '\n' : '') + `${dl.name || 'ご担当者'} 様`;
    const links = mats.map(m => { const url = m.link_url || m.file_url; return `・${m.name}${url ? '\n  ' + url : ''}`; }).join('\n');
    const body =
`${greet}

この度は、BIGLIGHT株式会社の資料をご請求いただき、誠にありがとうございます。
ご請求いただきました資料をお送りいたします。
${extraMsg ? '\n' + extraMsg + '\n' : ''}
──────────────────────────
■ 資料一覧
${links}
──────────────────────────

ご不明な点がございましたら、お気軽にお問い合わせください。

${MAIL_SIGN}`;
    await sendMailSmart(req, { to: dl.email, subject: '【BIGLIGHT株式会社】ご請求資料の送付', body, materialIds: ids });
    const note = mats.map(m => m.name).join(', ');
    await pool.query('UPDATE downloads SET sent_at=now(), sent_note=$1 WHERE id=$2', [note, req.params.id]);
    res.json({ ok: true, sent_at: new Date().toISOString(), sent_note: note });
  } catch (e) { console.error('POST /api/downloads/send:', e.message); res.status(500).json({ error: e.message }); }
});

// ================= 資料 (materials) =================
app.get('/api/materials', requireAuth, async (_q, res) => {
  const r = await pool.query('SELECT * FROM materials ORDER BY category NULLS LAST, created_at DESC');
  res.json({ items: r.rows });
});
// tạo/sửa: multipart (name, category, link_url + file tùy chọn)
function saveMatFile(id, file) {
  const ext = matExt(file.originalname);
  const finalName = 'mat-' + id + ext;
  const finalPath = path.join(MAT_DIR, finalName);
  // xoá file cũ khác đuôi (giữ URL ổn định khi cùng đuôi)
  try {
    for (const f of fs.readdirSync(MAT_DIR)) {
      if (f.startsWith('mat-' + id + '.') && f !== finalName) fs.unlinkSync(path.join(MAT_DIR, f));
    }
  } catch (e) {}
  fs.renameSync(file.path, finalPath);
  return { filename: finalName, file_url: SITE_ORIGIN + '/assets/materials/' + finalName, size: file.size };
}
app.post('/api/materials', requireAuth, requirePerm('salesmail', 'create'), (req, res) => {
  matUpload.single('file')(req, res, async err => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      const name = String((req.body || {}).name || '').trim();
      if (!name) { if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {} return res.status(400).json({ error: '資料名は必須です' }); }
      const category = String((req.body || {}).category || '').trim() || null;
      const link_url = String((req.body || {}).link_url || '').trim() || null;
      const ins = await pool.query('INSERT INTO materials(category,name,link_url) VALUES($1,$2,$3) RETURNING *', [category, name, link_url]);
      let row = ins.rows[0];
      if (req.file) {
        const f = saveMatFile(row.id, req.file);
        row = (await pool.query('UPDATE materials SET filename=$1,file_url=$2,size=$3,updated_at=now() WHERE id=$4 RETURNING *', [f.filename, f.file_url, f.size, row.id])).rows[0];
      }
      res.json({ item: row });
    } catch (e) { console.error('POST /api/materials:', e.message); res.status(500).json({ error: e.message }); }
  });
});
app.put('/api/materials/:id', requireAuth, requirePerm('salesmail', 'edit'), (req, res) => {
  matUpload.single('file')(req, res, async err => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      const cur = (await pool.query('SELECT * FROM materials WHERE id=$1', [req.params.id])).rows[0];
      if (!cur) { if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {} return res.status(404).json({ error: 'not found' }); }
      const b = req.body || {};
      const name = b.name != null ? String(b.name).trim() : cur.name;
      const category = b.category != null ? (String(b.category).trim() || null) : cur.category;
      const link_url = b.link_url != null ? (String(b.link_url).trim() || null) : cur.link_url;
      let filename = cur.filename, file_url = cur.file_url, size = cur.size;
      if (req.file) { const f = saveMatFile(cur.id, req.file); filename = f.filename; file_url = f.file_url; size = f.size; }
      const row = (await pool.query('UPDATE materials SET name=$1,category=$2,link_url=$3,filename=$4,file_url=$5,size=$6,updated_at=now() WHERE id=$7 RETURNING *',
        [name, category, link_url, filename, file_url, size, cur.id])).rows[0];
      res.json({ item: row });
    } catch (e) { console.error('PUT /api/materials:', e.message); res.status(500).json({ error: e.message }); }
  });
});
app.delete('/api/materials/:id', requireAuth, requirePerm('salesmail', 'del'), async (req, res) => {
  const cur = (await pool.query('SELECT filename FROM materials WHERE id=$1', [req.params.id])).rows[0];
  await pool.query('DELETE FROM materials WHERE id=$1', [req.params.id]);
  if (cur && cur.filename) try { fs.unlinkSync(path.join(MAT_DIR, cur.filename)); } catch (e) {}
  res.json({ ok: true });
});

// ================= 営業メール管理 (Sales Email Center) =================
const jparse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };
const toInt = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const senderName = req => (req.session.user && (req.session.user.name || req.session.user.email)) || '';

// 宛先候補: 資料請求 + お問い合わせ を統合
app.get('/api/recipients', requireAuth, async (_q, res) => {
  try {
    const d = await pool.query("SELECT id,company,name,email,interest,created_at FROM downloads WHERE email IS NOT NULL AND email<>'' ORDER BY created_at DESC LIMIT 1000");
    const i = await pool.query("SELECT id,company,name,email,tel,created_at FROM inquiries WHERE email IS NOT NULL AND email<>'' ORDER BY created_at DESC LIMIT 1000");
    const items = [
      ...d.rows.map(r => ({ key: 'download:' + r.id, kind: 'download', id: r.id, company: r.company || '', name: r.name || '', email: r.email, tel: '', industry: r.interest || '', address: '', created_at: r.created_at })),
      ...i.rows.map(r => ({ key: 'inquiry:' + r.id, kind: 'inquiry', id: r.id, company: r.company || '', name: r.name || '', email: r.email, tel: r.tel || '', industry: '', address: '', created_at: r.created_at })),
    ];
    res.json({ items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- テンプレート -----
app.get('/api/mail/templates', requireAuth, async (_q, res) => {
  const r = await pool.query('SELECT * FROM mail_templates ORDER BY favorite DESC, last_used DESC NULLS LAST, name');
  res.json({ items: r.rows.map(t => ({ ...t, attach_ids: jparse(t.attach_ids, []) })) });
});
app.post('/api/mail/templates', requireAuth, requirePerm('salesmail', 'create'), async (req, res) => {
  try {
    const b = req.body || {}; const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'テンプレート名は必須です' });
    const r = await pool.query(
      `INSERT INTO mail_templates(name,category,subject,body,signature_id,attach_ids,favorite,created_by,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()) RETURNING *`,
      [name, b.category || 'その他', b.subject || '', b.body || '', toInt(b.signature_id), JSON.stringify(b.attach_ids || []), !!b.favorite, senderName(req)]);
    res.json({ item: { ...r.rows[0], attach_ids: jparse(r.rows[0].attach_ids, []) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/mail/templates/:id', requireAuth, requirePerm('salesmail', 'edit'), async (req, res) => {
  try {
    const cur = (await pool.query('SELECT * FROM mail_templates WHERE id=$1', [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const f = (k, def) => b[k] != null ? b[k] : def;
    const r = await pool.query(
      `UPDATE mail_templates SET name=$1,category=$2,subject=$3,body=$4,signature_id=$5,attach_ids=$6,favorite=$7,last_used=$8,updated_at=now() WHERE id=$9 RETURNING *`,
      [String(f('name', cur.name)).trim(), f('category', cur.category), f('subject', cur.subject), f('body', cur.body),
       b.signature_id !== undefined ? toInt(b.signature_id) : cur.signature_id,
       b.attach_ids !== undefined ? JSON.stringify(b.attach_ids || []) : cur.attach_ids,
       b.favorite !== undefined ? !!b.favorite : cur.favorite,
       b.last_used ? new Date() : cur.last_used, req.params.id]);
    res.json({ item: { ...r.rows[0], attach_ids: jparse(r.rows[0].attach_ids, []) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/mail/templates/:id', requireAuth, requirePerm('salesmail', 'del'), async (req, res) => {
  await pool.query('DELETE FROM mail_templates WHERE id=$1', [req.params.id]); res.json({ ok: true });
});

// ----- 署名 -----
app.get('/api/mail/signatures', requireAuth, async (_q, res) => {
  const r = await pool.query('SELECT * FROM mail_signatures ORDER BY is_default DESC, id');
  res.json({ items: r.rows });
});
app.post('/api/mail/signatures', requireAuth, requirePerm('salesmail', 'create'), async (req, res) => {
  try {
    const b = req.body || {}; const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: '署名名は必須です' });
    if (b.is_default) await pool.query('UPDATE mail_signatures SET is_default=false');
    const r = await pool.query('INSERT INTO mail_signatures(name,body,is_default) VALUES($1,$2,$3) RETURNING *', [name, b.body || '', !!b.is_default]);
    res.json({ item: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/mail/signatures/:id', requireAuth, requirePerm('salesmail', 'edit'), async (req, res) => {
  try {
    const cur = (await pool.query('SELECT * FROM mail_signatures WHERE id=$1', [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    if (b.is_default) await pool.query('UPDATE mail_signatures SET is_default=false');
    const r = await pool.query('UPDATE mail_signatures SET name=$1,body=$2,is_default=$3 WHERE id=$4 RETURNING *',
      [b.name != null ? String(b.name).trim() : cur.name, b.body != null ? b.body : cur.body, b.is_default !== undefined ? !!b.is_default : cur.is_default, req.params.id]);
    res.json({ item: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/mail/signatures/:id', requireAuth, requirePerm('salesmail', 'del'), async (req, res) => {
  await pool.query('DELETE FROM mail_signatures WHERE id=$1', [req.params.id]); res.json({ ok: true });
});

// ----- 送信履歴 -----
app.get('/api/mail/logs', requireAuth, async (_q, res) => {
  const r = await pool.query('SELECT * FROM mail_logs ORDER BY created_at DESC LIMIT 1000');
  res.json({ items: r.rows });
});
app.delete('/api/mail/logs/:id', requireAuth, requirePerm('salesmail', 'del'), async (req, res) => {
  await pool.query('DELETE FROM mail_logs WHERE id=$1', [req.params.id]); res.json({ ok: true });
});

// ----- 下書き -----
app.get('/api/mail/drafts', requireAuth, async (_q, res) => {
  const r = await pool.query('SELECT * FROM mail_drafts ORDER BY updated_at DESC');
  res.json({ items: r.rows.map(d => ({ ...d, attach_ids: jparse(d.attach_ids, []) })) });
});
app.post('/api/mail/drafts', requireAuth, requireMail, async (req, res) => {   // upsert
  try {
    const b = req.body || {};
    if (b.id) {
      const r = await pool.query('UPDATE mail_drafts SET recipient_key=$1,subject=$2,body=$3,template_id=$4,attach_ids=$5,updated_at=now() WHERE id=$6 RETURNING *',
        [b.recipient_key || '', b.subject || '', b.body || '', toInt(b.template_id), JSON.stringify(b.attach_ids || []), b.id]);
      if (r.rows[0]) return res.json({ item: { ...r.rows[0], attach_ids: jparse(r.rows[0].attach_ids, []) } });
    }
    const r = await pool.query('INSERT INTO mail_drafts(recipient_key,subject,body,template_id,attach_ids) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [b.recipient_key || '', b.subject || '', b.body || '', toInt(b.template_id), JSON.stringify(b.attach_ids || [])]);
    res.json({ item: { ...r.rows[0], attach_ids: jparse(r.rows[0].attach_ids, []) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/mail/drafts/:id', requireAuth, requireMail, async (req, res) => {
  await pool.query('DELETE FROM mail_drafts WHERE id=$1', [req.params.id]); res.json({ ok: true });
});

// ----- meta (カテゴリ) -----
app.get('/api/mail/meta', requireAuth, async (_q, res) => {
  const r = await pool.query("SELECT key,val FROM mail_meta WHERE key IN ('tpl_cats','file_cats')");
  const o = { tpl_cats: [], file_cats: [] }; r.rows.forEach(x => { o[x.key] = x.val || []; }); res.json(o);
});
app.put('/api/mail/meta/:key', requireAuth, requirePerm('salesmail', 'edit'), async (req, res) => {
  const key = req.params.key;
  if (!['tpl_cats', 'file_cats'].includes(key)) return res.status(400).json({ error: 'bad key' });
  const val = (req.body || {}).val || [];
  await pool.query('INSERT INTO mail_meta(key,val) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET val=$2', [key, JSON.stringify(val)]);
  res.json({ ok: true });
});

// ----- 送信 (GAS優先・SMTPフォールバック) -----
app.post('/api/mail/send', requireAuth, requireMail, async (req, res) => {
  try {
    const b = req.body || {};
    const to = String(b.to || '').trim();
    if (!to) return res.status(400).json({ error: '宛先メールがありません' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: '宛先メールが不正です' });
    const subject = String(b.subject || '').trim();
    const body = String(b.body || '');
    const attachIds = (Array.isArray(b.attachIds) ? b.attachIds : []).map(x => parseInt(x, 10)).filter(Boolean);
    const result = await sendMailSmart(req, { to, subject, body, materialIds: attachIds });
    let rk = null, rid = null;
    if (b.recipientKey && String(b.recipientKey).indexOf(':') > 0) { const a = String(b.recipientKey).split(':'); rk = a[0]; rid = toInt(a[1]); }
    await pool.query(
      `INSERT INTO mail_logs(sender,to_email,to_name,recipient_kind,recipient_id,subject,template_id,template_name,status,att,note)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'送信',$9,$10)`,
      [senderName(req), to, b.toName || '', rk, rid, subject, toInt(b.templateId), b.templateName || '', b.att || '', b.note || '']);
    if (toInt(b.templateId)) { try { await pool.query('UPDATE mail_templates SET last_used=now() WHERE id=$1', [toInt(b.templateId)]); } catch (e) {} }
    res.json({ ok: true });
  } catch (e) { console.error('POST /api/mail/send:', e.message); res.status(500).json({ error: e.message }); }
});

// ----- posts CRUD -----
app.get('/api/posts', requireAuth, async (_q, res) => {
  const r = await pool.query('SELECT id,slug,title,category,status,published_at,updated_at,views,author,tags FROM posts ORDER BY created_at DESC');
  res.json({ items: r.rows });
});
app.get('/api/posts/:id', requireAuth, async (req, res) => {
  const r = await pool.query('SELECT * FROM posts WHERE id=$1', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  res.json({ item: r.rows[0] });
});
app.post('/api/posts', requireAuth, requirePerm('posts', 'create'), async (req, res) => {
  try {
    const b = req.body || {};
    const title = String(b.title || '').trim();
    if (!title) return res.status(400).json({ error: 'タイトルは必須です' });
    let slug = slugify(b.slug) || ('post-' + Date.now());
    const ex = await pool.query('SELECT 1 FROM posts WHERE slug=$1', [slug]);
    if (ex.rows[0]) slug = slug + '-' + Date.now().toString(36);
    const status = b.status === 'published' ? 'published' : (b.status === 'scheduled' ? 'scheduled' : 'draft');
    const pub = (status === 'published' || status === 'scheduled') ? (b.published_at ? new Date(b.published_at) : new Date()) : (b.published_at ? new Date(b.published_at) : null);
    const vals = postVals(b, null, slug, status, pub);
    const r = await pool.query(
      `INSERT INTO posts(${PCOLS.join(',')},updated_at) VALUES(${PCOLS.map((_, i) => '$' + (i + 1)).join(',')},now()) RETURNING *`, vals);
    res.json({ item: r.rows[0] });
    news.regenerate(pool).catch(() => {});
  } catch (e) { console.error('POST /api/posts:', e.message); res.status(500).json({ error: e.message }); }
});
app.put('/api/posts/:id', requireAuth, requirePerm('posts', 'edit'), async (req, res) => {
  try {
    const b = req.body || {};
    const cur = await pool.query('SELECT * FROM posts WHERE id=$1', [req.params.id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'not found' });
    const old = cur.rows[0];
    const title = String(b.title != null ? b.title : old.title).trim();
    let slug = b.slug != null ? (slugify(b.slug) || old.slug) : old.slug;
    if (slug !== old.slug) {
      const ex = await pool.query('SELECT 1 FROM posts WHERE slug=$1 AND id<>$2', [slug, req.params.id]);
      if (ex.rows[0]) slug = slug + '-' + Date.now().toString(36);
    }
    const status = b.status != null ? (b.status === 'published' ? 'published' : (b.status === 'scheduled' ? 'scheduled' : 'draft')) : old.status;
    let pub = old.published_at;
    if ((status === 'published' || status === 'scheduled') && !old.published_at) pub = b.published_at ? new Date(b.published_at) : new Date();
    if ((status === 'published' || status === 'scheduled') && b.published_at) pub = new Date(b.published_at);
    if (status === 'draft') pub = null;
    const vals = postVals(b, old, slug, status, pub);
    const r = await pool.query(
      `UPDATE posts SET ${PCOLS.map((c, i) => c + '=$' + (i + 1)).join(',')},updated_at=now() WHERE id=$${PCOLS.length + 1} RETURNING *`,
      [...vals, req.params.id]);
    res.json({ item: r.rows[0] });
    if (old.slug !== slug) news.removeSlug(old.slug);
    if (r.rows[0].status !== 'published') news.removeSlug(slug);
    news.regenerate(pool).catch(() => {});
  } catch (e) { console.error('PUT /api/posts:', e.message); res.status(500).json({ error: e.message }); }
});
app.delete('/api/posts/:id', requireAuth, requirePerm('posts', 'del'), async (req, res) => {
  const c = await pool.query('SELECT slug FROM posts WHERE id=$1', [req.params.id]);
  await pool.query('DELETE FROM posts WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
  if (c.rows[0]) news.removeSlug(c.rows[0].slug);
  news.regenerate(pool).catch(() => {});
});
app.post('/api/news/regenerate', requireAuth, requirePerm('posts', 'edit'), async (_q, res) => {
  try { const n = await news.regenerate(pool); res.json({ ok: true, count: n }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- アップロード画像 -----
app.post('/api/upload', requireAuth, requirePerm('posts', 'edit'), (req, res) => {
  upload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'ファイルが選択されていません' });
    res.json({ url: SITE_ORIGIN + '/assets/uploads/' + req.file.filename });
  });
});

// ----- カテゴリ -----
app.get('/api/categories', requireAuth, async (_q, res) => {
  const r = await pool.query('SELECT * FROM categories ORDER BY sort, id');
  res.json({ items: r.rows });
});
app.post('/api/categories', requireAuth, requirePerm('posts', 'edit'), async (req, res) => {
  try {
    const name = String((req.body || {}).name || '').trim();
    if (!name) return res.status(400).json({ error: 'カテゴリ名は必須です' });
    let slug = slugify((req.body || {}).slug || name) || ('cat-' + Date.now().toString(36));
    const ex = await pool.query('SELECT 1 FROM categories WHERE slug=$1', [slug]);
    if (ex.rows[0]) slug = slug + '-' + Date.now().toString(36);
    const r = await pool.query('INSERT INTO categories(slug,name,sort) VALUES($1,$2,$3) RETURNING *', [slug, name, parseInt((req.body || {}).sort, 10) || 99]);
    res.json({ item: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/categories/:id', requireAuth, requirePerm('posts', 'del'), async (req, res) => {
  await pool.query('DELETE FROM categories WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ================= admin UI (tĩnh) =================
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, must-revalidate'); }
}));

const PORT = process.env.PORT || 3000;
async function publishDue() {
  try {
    const r = await pool.query("UPDATE posts SET status='published' WHERE status='scheduled' AND published_at<=now() RETURNING id");
    if (r.rowCount) { console.log('auto-published ' + r.rowCount + ' scheduled post(s)'); news.regenerate(pool).catch(() => {}); }
  } catch (e) { console.error('publishDue:', e.message); }
}
init()
  .then(async () => {
    await loadPerms();
    app.listen(PORT, () => console.log('BIGLIGHT admin listening on ' + PORT));
    publishDue();
    setInterval(publishDue, 5 * 60 * 1000);   // 予約投稿の自動公開（5分毎）
    news.regenerate(pool).then(n => console.log('news regenerated: ' + n)).catch(e => console.error('news regen:', e.message));
  })
  .catch(e => { console.error('init failed:', e); process.exit(1); });
