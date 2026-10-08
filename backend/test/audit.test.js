#!/usr/bin/env node
/* ============================================================================
   Kiểm thử các bản vá audit 2026-10-06 — chạy MÁY CHỦ THẬT trên Postgres thật.
     TEST_DATABASE_URL=postgres://admin:adminlocal@127.0.0.1:55436/admin node test/audit.test.js
   Database đó sẽ bị XOÁ SẠCH (DROP SCHEMA public) — đừng trỏ vào DB thật.
   Postgres nhanh: docker run -d --name bladm-pg -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=adminlocal \
                     -e POSTGRES_DB=admin -p 55436:5432 postgres:16-alpine
   ============================================================================ */
'use strict';
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');
const signature = require('cookie-signature');
const { SMTPServer } = require('smtp-server');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.log('TEST_DATABASE_URL chưa đặt — bỏ qua.'); process.exit(0); }
if (!/127\.0\.0\.1|localhost/.test(DB)) { console.error('Chỉ chạy với Postgres cục bộ (DB sẽ bị xoá sạch).'); process.exit(1); }

const ROOT = path.join(__dirname, '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const PORT = 4600 + Math.floor(Math.random() * 300);
const BASE = 'http://127.0.0.1:' + PORT;
const SITE = fs.mkdtempSync(path.join(os.tmpdir(), 'bladm-site-'));
const ADMIN = 'boss@example.com', STAFF = 'staff@example.com', STAFF2 = 'staff2@example.com';
const pool = new Pool({ connectionString: DB });
let pass = 0, fail = 0;
async function ok(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- SMTP giả (nodemailer 10) + GAS giả ---- */
const smtpGot = [];
const smtp = new SMTPServer({ authOptional: true, logger: false,   // STARTTLS bật (chứng chỉ tự ký của smtp-server) — mã thật đặt requireTLS
  onData(stream, session, cb) { let d = ''; stream.on('data', c => { d += c; }); stream.on('end', () => { smtpGot.push({ to: session.envelope.rcptTo.map(r => r.address), raw: d }); cb(); }); } });
const gasGot = [];
const GAS_PORT = PORT + 400;
const gas = http.createServer((req, res) => {
  let b = ''; req.on('data', c => { b += c; }); req.on('end', () => {
    if (req.method === 'GET') return res.end('BIGLIGHT mail GAS v4 - test');
    const p = JSON.parse(b || '{}'); gasGot.push(p);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(p.secret && p.secret === gas.secret ? { ok: true } : { ok: false, error: 'forbidden_secret' }));
  });
});

let srv = null, srvLog = '';
function startServer(extraEnv) {
  return new Promise((resolve, reject) => {
    srvLog = '';
    srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, DATABASE_URL: DB, SESSION_SECRET: SECRET, PORT: String(PORT),
      SITE_DIR: SITE, ADMIN_EMAILS: ADMIN, GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com', NODE_ENV: 'test', NODE_TLS_REJECT_UNAUTHORIZED: '0',
      SMTP_HOST: '127.0.0.1', SMTP_PORT: String(PORT + 500), SMTP_SECURE: 'false', SMTP_NOAUTH: 'true', SMTP_USER: 'no-reply@example.com',
      MAIL_FROM: 'BIGLIGHT <no-reply@example.com>', ADMIN_NOTIFY_TO: 'notify@example.com', ...(extraEnv || {}) } });
    srv.stdout.on('data', d => { srvLog += d; }); srv.stderr.on('data', d => { srvLog += d; });
    const t0 = Date.now();
    (async function wait() {
      try { const r = await fetch(BASE + '/healthz'); if (r.ok) return resolve(); } catch (e) {}
      if (srv.exitCode != null) return reject(new Error('server exited: ' + srvLog));
      if (Date.now() - t0 > 20000) return reject(new Error('server start timeout: ' + srvLog));
      setTimeout(wait, 200);
    })();
  });
}
async function cookieFor(email) {
  const p = (await pool.query('SELECT * FROM profiles WHERE email=$1', [email])).rows[0];
  const sid = crypto.randomBytes(16).toString('hex');
  const sess = { cookie: { originalMaxAge: 7 * 864e5, expires: new Date(Date.now() + 7 * 864e5).toISOString(), httpOnly: true, path: '/', sameSite: 'lax' },
    user: { email: p.email, name: p.name, picture: '', role: p.role, mail_enabled: p.mail_enabled, gas_url: p.gas_url || '', status: p.status } };
  await pool.query('INSERT INTO admin_session(sid,sess,expire) VALUES($1,$2,now()+interval \'7 days\')', [sid, JSON.stringify(sess)]);
  return 'connect.sid=' + encodeURIComponent('s:' + signature.sign(sid, SECRET));
}
async function call(p, opt) {
  opt = opt || {};
  const headers = { 'Content-Type': 'application/json', ...(opt.headers || {}) };
  if (opt.cookie) headers.Cookie = opt.cookie;
  const r = await fetch(BASE + p, { method: opt.method || 'GET', headers, body: opt.body === undefined ? undefined : (typeof opt.body === 'string' ? opt.body : JSON.stringify(opt.body)) });
  let j = null; const txt = await r.text(); try { j = JSON.parse(txt); } catch (e) {}
  return { status: r.status, json: j, text: txt, headers: r.headers };
}

(async () => {
  await new Promise(r => smtp.listen(PORT + 500, '127.0.0.1', r));
  await new Promise(r => gas.listen(GAS_PORT, '127.0.0.1', r));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.query(`CREATE TABLE IF NOT EXISTS admin_session (sid varchar NOT NULL PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL)`);

  console.log('\nKhởi động');
  await ok('production + SESSION_SECRET yếu → máy chủ TỪ CHỐI chạy', async () => {
    const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, DATABASE_URL: DB, SESSION_SECRET: 'change-me', NODE_ENV: 'production', PORT: String(PORT + 1), SITE_DIR: SITE } });
    const code = await new Promise(r => p.on('exit', r));
    assert.strictEqual(code, 1);
  });
  await startServer();
  await ok('schema chạy trên DB trống + cột mới gas_secret / owner_email có mặt', async () => {
    const c = (await pool.query("SELECT table_name||'.'||column_name k FROM information_schema.columns WHERE column_name IN ('gas_secret','owner_email')")).rows.map(x => x.k).sort();
    assert.deepStrictEqual(c, ['mail_drafts.owner_email', 'profiles.gas_secret']);
  });
  await pool.query(`INSERT INTO profiles(email,name,role,status,mail_enabled) VALUES
    ($1,'Boss','admin','active',true),($2,'Staff','staff','active',true),($3,'Staff2','staff','active',false)`, [ADMIN, STAFF, STAFF2]);
  const A = await cookieFor(ADMIN), S = await cookieFor(STAFF), S2 = await cookieFor(STAFF2);

  console.log('\nTrang quản trị: CSP + Quill tự lưu');
  await ok('/ có Content-Security-Policy (frame-ancestors none, object-src none) và không còn x-powered-by', async () => {
    const r = await call('/');
    const csp = r.headers.get('content-security-policy') || '';
    assert.ok(/frame-ancestors 'none'/.test(csp) && /object-src 'none'/.test(csp), csp);
    assert.ok(!r.headers.get('x-powered-by'));
    assert.ok(r.text.includes('/vendor/quill.min.js') && !r.text.includes('cdn.quilljs.com'));
  });
  await ok('/posts/12 (đường SPA) cũng có CSP · /vendor/quill.min.js tải được', async () => {
    assert.ok(/default-src 'self'/.test((await call('/posts/12')).headers.get('content-security-policy') || ''));
    const q = await call('/vendor/quill.min.js'); assert.strictEqual(q.status, 200); assert.ok(q.text.length > 100000);
  });

  console.log('\n#3 Phiên: vô hiệu hoá / hạ quyền có tác dụng NGAY');
  await ok('staff đang đăng nhập đọc được /api/inquiries', async () => { assert.strictEqual((await call('/api/inquiries', { cookie: S2 })).status, 200); });
  await ok('admin đặt staff2 = 無効 → request kế tiếp của staff2 bị 401 (không chờ 14 ngày)', async () => {
    assert.strictEqual((await call('/api/profiles/' + STAFF2, { method: 'PUT', cookie: A, body: { status: 'disabled' } })).status, 200);
    assert.strictEqual((await call('/api/inquiries', { cookie: S2 })).status, 401);
    const S2b = await cookieFor(STAFF2); const me = await call('/api/me', { cookie: S2b });
    assert.strictEqual(me.status, 200); assert.strictEqual(me.json.user, null, '/api/me phải trả user=null');
    assert.strictEqual((await pool.query("SELECT count(*)::int n FROM admin_session WHERE sess->'user'->>'email'=$1", [STAFF2])).rows[0].n, 0, 'phiên chưa bị xoá');
  });
  await ok('hạ staff → viewer: quyền tạo bài mất trong ≤ 20 giây (cache), không cần đăng xuất', async () => {
    const S3 = await cookieFor(STAFF);
    assert.strictEqual((await call('/api/profiles/' + STAFF, { method: 'PUT', cookie: A, body: { role: 'viewer' } })).status, 200);
    const r = await call('/api/posts', { method: 'POST', cookie: S3, body: { title: 'x', body: '<p>x</p>' } });
    assert.strictEqual(r.status, 403);
    await call('/api/profiles/' + STAFF, { method: 'PUT', cookie: A, body: { role: 'staff' } });
  });
  await ok('xoá người dùng → phiên của họ bị xoá ngay', async () => {
    await pool.query("INSERT INTO profiles(email,name,role,status) VALUES('temp@example.com','T','staff','active')");
    const T = await cookieFor('temp@example.com');
    assert.strictEqual((await call('/api/profiles/temp@example.com', { method: 'DELETE', cookie: A })).status, 200);
    assert.strictEqual((await call('/api/stats', { cookie: T })).status, 401);
  });

  console.log('\nLỗi máy chủ: không sập, không lộ SQL');
  await ok('PATCH /api/inquiries/abc → 500 chung chung, máy chủ vẫn sống (trước: unhandled rejection làm tắt Node 22)', async () => {
    const r = await call('/api/inquiries/abc', { method: 'PATCH', cookie: A, body: { status: 'done' } });
    assert.strictEqual(r.status, 500); assert.ok(!/bigint|syntax|invalid input/i.test(r.text), r.text);
    await sleep(300); assert.strictEqual((await call('/healthz')).status, 200);
  });
  await ok('DELETE /api/posts/xyz + JSON hỏng → không sập', async () => {
    await call('/api/posts/xyz', { method: 'DELETE', cookie: A });
    assert.strictEqual((await call('/api/inquiry', { method: 'POST', body: '{bad json' })).status, 400);
    assert.strictEqual((await call('/healthz')).status, 200);
  });

  console.log('\n#2/#6 Lọc HTML bài viết + URL');
  const EVIL = '<h2>見出し</h2><p onclick="steal()">本文<img src="x" onerror="alert(1)"></p><script>alert(document.cookie)</script>' +
    '<a href="javascript:alert(1)">bad</a><a href="/news/" target="_blank">ok</a><iframe src="https://evil.example/x"></iframe>' +
    '<div class="nembed"><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" allowfullscreen></iframe></div><div class="ncallout">注意</div>';
  let pid = null;
  await ok('staff tạo bài chứa <script>/onerror/javascript:/iframe lạ → lưu bản ĐÃ LỌC, giữ phần hợp lệ', async () => {
    const r = await call('/api/posts', { method: 'POST', cookie: S, body: { title: 'テスト記事', slug: 'test-xss', body: EVIL, status: 'published' } });
    assert.strictEqual(r.status, 200, r.text); pid = r.json.item.id;
    const b = (await pool.query('SELECT body FROM posts WHERE id=$1', [pid])).rows[0].body;
    assert.ok(!/<script|onerror|onclick|javascript:|evil\.example/i.test(b), b);
    assert.ok(/youtube\.com\/embed\/dQw4w9WgXcQ/.test(b) && /class="ncallout"/.test(b) && /<h2>/.test(b), b);
    assert.ok(/rel="noopener noreferrer"/.test(b), 'target=_blank thiếu rel');
  });
  await ok('bài CŨ (lưu thẳng vào DB, chưa lọc) → GET /api/posts/:id trả bản đã lọc', async () => {
    await pool.query('UPDATE posts SET body=$1 WHERE id=$2', [EVIL, pid]);
    const r = await call('/api/posts/' + pid, { cookie: A });
    assert.ok(!/<script|onerror|javascript:/i.test(r.json.item.body), r.json.item.body);
  });
  await ok('trang tĩnh biglight.jp/news/test-xss/ sinh ra không có script độc (kể cả từ bài cũ)', async () => {
    await call('/api/news/regenerate', { method: 'POST', cookie: A });
    const html = fs.readFileSync(path.join(SITE, 'news', 'test-xss', 'index.html'), 'utf8');
    const art = html.slice(html.indexOf('<div class="nbody">'), html.indexOf('</article>'));
    assert.ok(!/alert\(|onerror|javascript:/i.test(art), art.slice(0, 400));
  });
  await ok('ảnh bìa / CTA / canonical là javascript: hoặc chứa dấu nháy → 400 nói rõ ô nào', async () => {
    let r = await call('/api/posts/' + pid, { method: 'PUT', cookie: A, body: { cover_image: 'javascript:alert(1)' } });
    assert.strictEqual(r.status, 400); assert.ok(/画像URL/.test(r.json.error), r.text);
    r = await call('/api/posts/' + pid, { method: 'PUT', cookie: A, body: { cta_blocks: [{ label: 'x', url: 'javascript:x' }] } });
    assert.strictEqual(r.status, 400); assert.ok(/CTA 1/.test(r.json.error));
    r = await call('/api/posts/' + pid, { method: 'PUT', cookie: A, body: { canonical_url: 'https://biglight.jp/a"><script>' } });
    assert.strictEqual(r.status, 400);
  });
  await ok("ảnh bìa có ' ( ) → mã hoá, không thoát được khỏi url('…') trong CSS", async () => {
    const r = await call('/api/posts/' + pid, { method: 'PUT', cookie: A, body: { cover_image: "https://biglight.jp/a').x{(b)" } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.item.cover_image, 'https://biglight.jp/a%27%29.x{%28b%29');
  });
  await ok('regenerate gọi 5 lần cùng lúc → không lỗi, file đầy đủ (hàng đợi)', async () => {
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => call('/api/news/regenerate', { method: 'POST', cookie: A })));
    assert.ok(rs.every(r => r.status === 200), rs.map(r => r.status).join(','));
    assert.ok(fs.existsSync(path.join(SITE, 'news', 'index.html')));
  });

  console.log('\n#5 Form công khai: IP + chống bắn mail');
  await ok('đổi phần đầu X-Forwarded-For KHÔNG né được hạn mức 8 lần/10 phút (IP lấy từ proxy tin cậy)', async () => {
    const codes = [];
    for (let i = 0; i < 9; i++) codes.push((await call('/api/download', { method: 'POST', headers: { 'X-Forwarded-For': '10.0.0.' + i + ', 203.0.113.9' }, body: { name: 'n', email: 'a' + i + '@example.com' } })).status);
    assert.deepStrictEqual(codes.slice(0, 8), [200, 200, 200, 200, 200, 200, 200, 200]); assert.strictEqual(codes[8], 429);
    const ips = (await pool.query('SELECT DISTINCT ip FROM downloads')).rows.map(r => r.ip);
    assert.deepStrictEqual(ips, ['203.0.113.9'], 'IP ghi sai: ' + ips);
  });
  // Mã thời gian (2026-10-08): form thật lấy ft từ /api/form-config rồi mới gửi (≥ 3 giây sau).
  const FT = (await call('/api/form-config')).json.ft; await sleep(3100);
  await ok('cùng một email gửi form 5 lần/24h → chỉ 3 thư tự động trả lời tới email đó (thông báo nội bộ vẫn đủ 5)', async () => {
    smtpGot.length = 0;
    for (let i = 0; i < 5; i++) await call('/api/inquiry', { method: 'POST', headers: { 'X-Forwarded-For': '198.51.100.' + i }, body: { name: 'N', email: 'victim@example.com', tel: '000', message: 'hi', ft: FT } });
    await sleep(1500);
    const toVictim = smtpGot.filter(m => m.to.includes('victim@example.com')).length, toNotify = smtpGot.filter(m => m.to.includes('notify@example.com')).length;
    assert.strictEqual(toVictim, 3, 'victim ' + toVictim); assert.strictEqual(toNotify, 5, 'notify ' + toNotify);
  });

  await ok('cùng một email lần thứ 6 trong 24h → 429 (đổi IP cũng không qua)', async () => {
    const r = await call('/api/inquiry', { method: 'POST', headers: { 'X-Forwarded-For': '198.51.100.77' }, body: { name: 'N', email: 'VICTIM@example.com', tel: '000', message: 'hi', ft: FT } });
    assert.strictEqual(r.status, 429, r.text);
  });

  console.log('\n2026-10-08 Chống bot + lọc 営業');
  const inq = (ip, body) => call('/api/inquiry', { method: 'POST', headers: { 'X-Forwarded-For': ip }, body: { name: '林', tel: '052', ...body } });
  const lastInq = async email => (await pool.query('SELECT * FROM inquiries WHERE email=$1 ORDER BY id DESC LIMIT 1', [email])).rows[0];
  await ok('/api/form-config: CORS biglight.jp, no-store, ft có chữ ký, chưa có khoá Turnstile → null', async () => {
    const r = await call('/api/form-config');
    assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://biglight.jp');
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    assert.ok(/^\d+\.[A-Za-z0-9_-]{22}$/.test(r.json.ft)); assert.strictEqual(r.json.turnstileSiteKey, null);
  });
  await ok('không có ft (bot POST thẳng) → vẫn lưu nhưng spam=bot, KHÔNG gửi mail nào', async () => {
    smtpGot.length = 0;
    assert.strictEqual((await inq('192.0.2.1', { email: 'bot1@example.com', message: '採用を検討しています' })).status, 200);
    await sleep(800);
    const r = await lastInq('bot1@example.com'); assert.strictEqual(r.spam, 'bot'); assert.ok(/トークンなし/.test(r.spam_reason));
    assert.strictEqual(smtpGot.length, 0);
  });
  await ok('ft giả chữ ký / gửi ngay khi vừa mở form (< 3 giây) → spam=bot', async () => {
    await inq('192.0.2.2', { email: 'bot2@example.com', message: 'x', ft: Date.now() + '.AAAAAAAAAAAAAAAAAAAAAA' });
    assert.ok(/不正/.test((await lastInq('bot2@example.com')).spam_reason));
    const fresh = (await call('/api/form-config')).json.ft;
    await inq('192.0.2.3', { email: 'bot3@example.com', message: 'x', ft: fresh });
    assert.ok(/速すぎる/.test((await lastInq('bot3@example.com')).spam_reason));
  });
  await ok('thư chào hàng (突然のご連絡…ご案内) → spam=sales, không thông báo', async () => {
    smtpGot.length = 0;
    await inq('192.0.2.4', { email: 'sales@example.com', company: '株式会社マルジュ', ft: FT, message: '突然のご連絡失礼いたします。株式会社マルジュの庭木と申します。弊社では登録支援機関様向けにフォームDMツールを提供しております。ぜひご案内させていただきたく、ご連絡いたしました。' });
    await sleep(800);
    const r = await lastInq('sales@example.com'); assert.strictEqual(r.spam, 'sales', JSON.stringify(r)); assert.strictEqual(smtpGot.length, 0);
  });
  await ok('người gửi tự chọn 種別「営業・ご提案」 → spam=sales, cột kind lưu lại', async () => {
    await inq('192.0.2.5', { email: 'kind@example.com', kind: '営業・ご提案', message: 'よろしくお願いします', ft: FT });
    const r = await lastInq('kind@example.com'); assert.strictEqual(r.spam, 'sales'); assert.strictEqual(r.kind, '営業・ご提案');
  });
  await ok('khách thật viết trang trọng (と申します・弊社・採用を検討) → KHÔNG bị gắn 営業, thông báo có 種別', async () => {
    smtpGot.length = 0;
    await inq('192.0.2.6', { email: 'act@example.com', company: 'アクト株式会社', kind: '外国人材の採用について', ft: FT, message: 'はじめまして。愛知県清須市で精密加工業を営んでおります、アクト株式会社の林と申します。このたび製造部門の体制強化に伴い、ベトナム人材の採用を検討しており、ご相談させていただきたくご連絡いたしました。弊社は半導体関連の部品を製造しております。' });
    await sleep(800);
    const r = await lastInq('act@example.com'); assert.strictEqual(r.spam, null, r.spam_reason);
    const n = smtpGot.find(m => m.to.includes('notify@example.com')); assert.ok(n, 'không có thông báo');
  });
  await ok('stats: 未対応 / 合計 không tính 営業・迷惑; có số 30 ngày', async () => {
    const st = (await call('/api/stats', { cookie: A })).json;
    const real = (await pool.query("SELECT count(*)::int n FROM inquiries WHERE spam IS NULL")).rows[0].n;
    assert.strictEqual(st.inquiriesTotal, real); assert.ok(st.inquiriesSpam30d >= 5, JSON.stringify(st));
  });
  await ok('PATCH spam: 「営業ではない」 trả về null + 監査ログ; giá trị lạ → 400; 資料請求 cũng đổi được', async () => {
    const id = (await lastInq('kind@example.com')).id;
    assert.strictEqual((await call('/api/inquiries/' + id, { method: 'PATCH', cookie: A, body: { spam: 'xxx' } })).status, 400);
    assert.strictEqual((await call('/api/inquiries/' + id, { method: 'PATCH', cookie: A, body: { spam: null } })).status, 200);
    assert.strictEqual((await lastInq('kind@example.com')).spam, null);
    const a = (await pool.query("SELECT detail FROM audit_logs WHERE entity='inquiry' AND entity_id=$1 ORDER BY id DESC LIMIT 1", [String(id)])).rows[0];
    assert.deepStrictEqual(a.detail.spam, { from: 'sales', to: null });
    const did = (await pool.query('SELECT id FROM downloads ORDER BY id LIMIT 1')).rows[0].id;
    assert.strictEqual((await call('/api/downloads/' + did, { method: 'PATCH', cookie: A, body: { spam: null } })).status, 200);
  });
  await ok('資料DL không ft → vẫn 200 (PDF đã tải) nhưng spam=bot; có ft → bình thường', async () => {
    await call('/api/download', { method: 'POST', headers: { 'X-Forwarded-For': '192.0.2.20' }, body: { name: 'n', email: 'dl1@example.com' } });
    await call('/api/download', { method: 'POST', headers: { 'X-Forwarded-For': '192.0.2.20' }, body: { name: 'n', email: 'dl2@example.com', ft: FT } });
    const rows = (await pool.query("SELECT email,spam FROM downloads WHERE email IN ('dl1@example.com','dl2@example.com') ORDER BY email")).rows;
    assert.deepStrictEqual(rows.map(r => r.spam), ['bot', null]);
  });

  console.log('\n2026-10-08 (G) Đăng nhập chỉ cho người đã thêm');
  await ok('admin thêm người dùng → active ngay; trùng → 409; email sai → 400; staff → 403', async () => {
    const r = await call('/api/profiles', { method: 'POST', cookie: A, body: { email: 'New@Example.com', role: 'staff', mail_enabled: true } });
    assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.json.item.status, 'active'); assert.strictEqual(r.json.item.email, 'new@example.com');
    assert.strictEqual((await call('/api/profiles', { method: 'POST', cookie: A, body: { email: 'new@example.com' } })).status, 409);
    assert.strictEqual((await call('/api/profiles', { method: 'POST', cookie: A, body: { email: 'abc' } })).status, 400);
    assert.strictEqual((await call('/api/profiles', { method: 'POST', cookie: S, body: { email: 'x@example.com' } })).status, 403);
  });
  await ok('/auth/google: quá 20 lần / 10 phút / IP → 429', async () => {
    const codes = [];
    for (let i = 0; i < 21; i++) codes.push((await call('/auth/google', { method: 'POST', headers: { 'X-Forwarded-For': '192.0.2.99' }, body: { credential: 'bad.token.' + i } })).status);
    assert.ok(codes.slice(0, 20).every(c => c === 401), codes.join(',')); assert.strictEqual(codes[20], 429);
  });

  console.log('\nGAS v4 + gửi mail (nodemailer 10)');
  await ok('/api/profiles KHÔNG trả URL GAS của người khác (chỉ gas_set)', async () => {
    await pool.query('UPDATE profiles SET gas_url=$1 WHERE email=$2', ['http://127.0.0.1:' + GAS_PORT + '/exec', STAFF]);
    const r = await call('/api/profiles', { cookie: A });
    const st = r.json.items.find(x => x.email === STAFF);
    assert.strictEqual(st.gas_set, true); assert.ok(!('gas_url' in st) && !/127\.0\.0\.1/.test(r.text));
  });
  let secret = null;
  await ok('/api/me/gas-secret: tạo 1 lần, gọi lại trả cùng khoá; người khác không đọc được khoá của mình', async () => {
    const a = await call('/api/me/gas-secret', { cookie: S }), b = await call('/api/me/gas-secret', { cookie: S });
    secret = a.json.secret; assert.ok(secret && secret.length >= 30); assert.strictEqual(b.json.secret, secret);
    assert.notStrictEqual((await call('/api/me/gas-secret', { cookie: A })).json.secret, secret);
  });
  await ok('gửi qua GAS mang theo khoá; GAS v4 có khoá khác → lỗi rõ ràng, KHÔNG ghi 送信', async () => {
    gas.secret = 'khac'; gasGot.length = 0;
    let r = await call('/api/mail/send', { method: 'POST', cookie: S, body: { to: 'c@example.com', subject: 's', body: 'b' } });
    assert.strictEqual(r.status, 500); assert.ok(/鍵が一致しません/.test(r.json.error), r.text);
    assert.strictEqual(gasGot[0].secret, secret);
    gas.secret = secret;
    r = await call('/api/mail/send', { method: 'POST', cookie: S, body: { to: 'c@example.com', subject: 's', body: 'b' } });
    assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.json.via, 'gas');
  });
  await ok('kiểm phiên bản GAS nhận ra v4', async () => {
    const r = await call('/api/gas/check', { method: 'POST', cookie: S, body: {} });
    assert.strictEqual(r.json.version, 'v4', r.text);
  });
  await ok('không có GAS → gửi bằng SMTP qua nodemailer 10, kèm file đính kèm', async () => {
    const MAT = path.join(SITE, 'assets', 'materials'); fs.mkdirSync(MAT, { recursive: true });
    fs.writeFileSync(path.join(MAT, 'mat-1-testfile.pdf'), '%PDF-1.4 test');
    const m = (await pool.query("INSERT INTO materials(name,filename,size) VALUES('会社案内','mat-1-testfile.pdf',13) RETURNING id")).rows[0];
    smtpGot.length = 0;
    const r = await call('/api/mail/send', { method: 'POST', cookie: A, body: { to: 'x@example.com', subject: '件名', body: '本文', attachIds: [m.id] } });
    assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.json.via, 'smtp');
    await sleep(500); assert.ok(smtpGot.length === 1 && /会社案内|filename/.test(smtpGot[0].raw));
  });

  console.log('\nNháp, lịch sử, danh sách');
  await ok('nháp mail: người khác không đọc / sửa / xoá được nháp của mình', async () => {
    const d = (await call('/api/mail/drafts', { method: 'POST', cookie: S, body: { subject: 'mine', body: 'b' } })).json.item;
    assert.strictEqual((await call('/api/mail/drafts', { cookie: A })).json.items.length, 0);
    await call('/api/mail/drafts', { method: 'POST', cookie: A, body: { id: d.id, subject: 'hijack' } });
    await call('/api/mail/drafts/' + d.id, { method: 'DELETE', cookie: A });
    const row = (await pool.query('SELECT subject FROM mail_drafts WHERE id=$1', [d.id])).rows[0];
    assert.strictEqual(row && row.subject, 'mine');
  });
  await ok('送信履歴: staff không xoá được (403), admin xoá được', async () => {
    const id = (await pool.query('SELECT id FROM mail_logs ORDER BY id LIMIT 1')).rows[0].id;
    assert.strictEqual((await call('/api/mail/logs/' + id, { method: 'DELETE', cookie: S })).status, 403);
    assert.strictEqual((await call('/api/mail/logs/' + id, { method: 'DELETE', cookie: A })).status, 200);
  });
  await ok('danh sách 問い合わせ trả total; limit nhỏ hơn total vẫn báo đúng tổng', async () => {
    const r = await call('/api/inquiries?limit=2', { cookie: A });
    assert.strictEqual(r.json.items.length, 2); assert.ok(r.json.total >= 5, r.text.slice(0, 200));
  });

  console.log('\nMCP vẫn chạy qua route đã bọc');
  await ok('khoá write: tools/list + admin_create_post với <script> → bài nháp đã lọc', async () => {
    const k = (await call('/api/api-keys', { method: 'POST', cookie: A, body: { name: 'test', scopes: ['read', 'write'] } })).json.key;
    const rpc = (method, params) => call('/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + k }, body: { jsonrpc: '2.0', id: 1, method, params } });
    const tl = await rpc('tools/list', {}); assert.ok(tl.json.result.tools.some(t => t.name === 'admin_create_post'));
    const c = await rpc('tools/call', { name: 'admin_create_post', arguments: { title: 'MCP記事', body: '<p>ok</p><script>x()</script>' } });
    assert.strictEqual(c.json.result.isError, false, c.text);
    const b = (await pool.query("SELECT body,status FROM posts WHERE title='MCP記事'")).rows[0];
    assert.strictEqual(b.status, 'draft'); assert.ok(!/script/.test(b.body), b.body);
    const li = await rpc('tools/call', { name: 'admin_list_inquiries', arguments: { limit: 3 } });
    assert.strictEqual(li.json.result.isError, false, li.text);
  });

  await ok('trong suốt bài test máy chủ không in unhandledRejection', async () => { assert.ok(!/unhandledRejection/.test(srvLog), srvLog.slice(-500)); });

  console.log('\n2026-10-08 Turnstile bật (TURNSTILE_SECRET)');
  srv.kill(); await new Promise(r => srv.on('exit', r));
  // Khoá thử của Cloudflare: 1x…AA luôn đạt (cần mạng; mất mạng thì server cho qua — vẫn đạt).
  await startServer({ TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET: '1x0000000000000000000000000000000AA' });
  await ok('form-config trả site key; thiếu token Turnstile → 400 code=turnstile, không lưu', async () => {
    assert.strictEqual((await call('/api/form-config')).json.turnstileSiteKey, '1x00000000000000000000AA');
    const r = await inq('192.0.2.30', { email: 'ts1@example.com', message: 'x', ft: FT });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.json.code, 'turnstile');
    assert.strictEqual(await lastInq('ts1@example.com'), undefined);
  });
  await ok('có token (khoá thử luôn đạt) → lưu bình thường', async () => {
    const r = await inq('192.0.2.31', { email: 'ts2@example.com', message: '採用を検討しています', ft: FT, turnstile: 'XXXX.DUMMY.TOKEN.XXXX' });
    assert.strictEqual(r.status, 200, r.text); assert.strictEqual((await lastInq('ts2@example.com')).spam, null);
  });

  console.log('\n' + (fail ? '✗' : '✓') + ' 通過 ' + pass + ' / 失敗 ' + fail);
  srv.kill(); smtp.close(); gas.close(); await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { srv && srv.kill(); } catch (x) {} process.exit(1); });
