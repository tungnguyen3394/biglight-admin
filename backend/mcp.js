// ============================================================================
// API・MCP連携 — cho AI (Claude / ChatGPT / script) làm việc trong admin.biglight.jp
//
// - Khoá API: bảng api_keys, chỉ lưu sha256; khoá thật hiện MỘT lần lúc tạo.
// - MCP Streamable HTTP, stateless: POST /mcp (Bearer) hoặc POST /mcp/k/<khoá>
//   (ChatGPT không gửi được header). GET /mcp → 405.
// - Mọi thao tác GHI đi qua đúng route Express đang có (dispatch lại route với
//   req giả mang session của NGƯỜI TẠO KHOÁ) → cùng kiểm tra quyền, cùng audit,
//   cùng luật link nội bộ, cùng GAS/SMTP của người đó. AI không bao giờ mạnh
//   hơn người tạo khoá.
// - Phạm vi: read ⊂ write ⊂ publish; mail riêng (gửi mail thật bằng Gmail của
//   người tạo khoá). KHÔNG có xoá qua AI.
// ============================================================================
const crypto = require('crypto');

const KEY_PREFIX = 'blad_';
const SCOPES = ['read', 'write', 'publish', 'mail'];
const SCOPE_LABEL = { read: '読む', write: '下書き作成・編集', publish: '公開・サイト再生成', mail: 'メール送信（作成者のGmail）' };
const RATE_LIMIT = 300, RATE_MS = 10 * 60 * 1000;
const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const hashKey = k => crypto.createHash('sha256').update(k).digest('hex');
const obj = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const toInt = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
class ToolError extends Error { constructor(code, status = 400) { super(code); this.code = code; this.status = status; } }

module.exports = function mountMcp(app, deps) {
  const { pool, sessionUser, audit, isAdminUser, canUser, clientIp, SITE_ORIGIN, ADMIN_ORIGIN } = deps;

  // ---------- gọi lại route Express có sẵn với req giả ----------
  function findRoute(method, path) {
    const st = (app._router && app._router.stack) || [];
    const l = st.find(x => x.route && x.route.path === path && x.route.methods[method]);
    if (!l) throw new Error('route not found: ' + method + ' ' + path);
    return l.route;
  }
  function callRoute(ctx, method, path, { params = {}, body = {}, query = {} } = {}) {
    return new Promise((resolve, reject) => {
      const route = findRoute(method, path);
      const req = { method: method.toUpperCase(), path, params, body, query, headers: { 'x-forwarded-for': ctx.ip }, ip: ctx.ip,
        session: { user: ctx.user }, apiKey: ctx.key };
      let status = 200, payload = null, done = false;
      const finish = () => { if (done) return; done = true; if (status >= 400) { const e = new ToolError((payload && payload.error) || ('http_' + status), status); e.payload = payload; reject(e); } else resolve(payload); };
      const res = {
        status(c) { status = c; return res; }, set() { return res; }, setHeader() { return res; },
        json(o) { payload = o; finish(); return res; }, send(o) { payload = o; finish(); return res; },
        sendStatus(c) { status = c; finish(); return res; }, end() { finish(); return res; },
      };
      route.dispatch(req, res, err => { if (err) reject(err); else if (!done) { status = 404; payload = { error: 'no_response' }; finish(); } });
    });
  }

  // ---------- điền biến giống màn hình ----------
  function fillVars(text, p, senderName) {
    const map = { '{{company_name}}': p.company || '', '{{contact_name}}': p.name || '', '{{today}}': new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' }),
      '{{sales_name}}': senderName || '', '{{phone}}': p.tel || '', '{{email}}': p.email || '', '{{industry}}': p.industry || '', '{{address}}': '' };
    return String(text || '').replace(/\{\{\w+\}\}/g, m => (m in map ? map[m] : m));
  }
  async function recipientOf(key) {
    const m = String(key || '').match(/^(inquiry|download):(\d+)$/);
    if (!m) throw new ToolError('recipient_key must be "inquiry:<id>" or "download:<id>"');
    const r = (await pool.query(m[1] === 'inquiry' ? 'SELECT id,company,name,email,tel FROM inquiries WHERE id=$1' : 'SELECT id,company,name,email,interest FROM downloads WHERE id=$1', [m[2]])).rows[0];
    if (!r) throw new ToolError('recipient_not_found', 404);
    return { key, kind: m[1], id: r.id, company: r.company || '', name: r.name || '', email: String(r.email || '').trim(), tel: r.tel || '', industry: r.interest || '' };
  }
  async function buildMail(ctx, a) {
    const p = a.recipient_key ? await recipientOf(a.recipient_key) : { key: null, kind: null, company: a.to_company || '', name: a.to_name || '', email: String(a.to || '').trim(), tel: '', industry: '' };
    if (!p.email) throw new ToolError('recipient_has_no_email');
    let subject = a.subject, body = a.body, sigId = a.signature_id, attach = Array.isArray(a.attach_ids) ? a.attach_ids : null, tpl = null;
    if (a.template_id) {
      tpl = (await pool.query('SELECT * FROM mail_templates WHERE id=$1', [a.template_id])).rows[0];
      if (!tpl) throw new ToolError('template_not_found', 404);
      if (subject == null) subject = tpl.subject; if (body == null) body = tpl.body;
      if (sigId == null) sigId = tpl.signature_id;
      if (attach == null) { try { attach = JSON.parse(tpl.attach_ids || '[]'); } catch (e) { attach = []; } }
    }
    if (!subject || !body) throw new ToolError('subject_and_body_required');
    let sig = null;
    if (sigId) sig = (await pool.query('SELECT * FROM mail_signatures WHERE id=$1', [sigId])).rows[0];
    else if (a.template_id == null && a.signature_id === undefined) sig = (await pool.query('SELECT * FROM mail_signatures ORDER BY is_default DESC, id LIMIT 1')).rows[0] || null;
    const ids = (attach || []).map(x => toInt(x)).filter(Boolean);
    const mats = ids.length ? (await pool.query('SELECT * FROM materials WHERE id = ANY($1::bigint[])', [ids])).rows : [];
    const files = mats.filter(m => m.filename), links = mats.filter(m => !m.filename && m.link_url);
    const sender = ctx.user.name || ctx.user.email;
    let text = fillVars(body, p, sender) + (sig ? '\n\n' + fillVars(sig.body, p, sender) : '');
    if (links.length) text += '\n\n【資料（リンク）】\n' + links.map(m => '・' + m.name + ': ' + m.link_url).join('\n');
    return { p, tpl, subject: fillVars(subject, p, sender).trim(), body: text, files, links, attachIds: files.map(m => m.id), att: mats.map(m => m.name).join(', ') };
  }

  const shapeInq = r => ({ id: r.id, kind: 'inquiry', recipient_key: 'inquiry:' + r.id, company: r.company, name: r.name, email: r.email, tel: r.tel, message: r.message, status: r.status, created_at: r.created_at, last_mail_at: r.last_mail_at || null, mail_count: r.mail_count || 0 });
  const shapeDl = r => ({ id: r.id, kind: 'download', recipient_key: 'download:' + r.id, company: r.company, name: r.name, email: r.email, interest: r.interest, note: r.note, created_at: r.created_at, last_mail_at: r.last_mail_at || null, mail_count: r.mail_count || 0, sent_note: r.sent_note || null });
  const q = (rows, s, fields) => { if (!s) return rows; const t = String(s).toLowerCase(); return rows.filter(r => fields.some(f => String(r[f] || '').toLowerCase().includes(t))); };
  const lim = (rows, n, d = 50) => rows.slice(0, Math.max(1, Math.min(500, toInt(n) || d)));
  const POST_FIELDS = ['slug', 'title', 'category', 'subcategory', 'excerpt', 'body', 'cover_image', 'cover_alt', 'cover_caption', 'meta_description', 'seo_title', 'focus_keyword', 'sub_keyword', 'related_keywords', 'canonical_url', 'og_title', 'og_description', 'og_image', 'author', 'tags', 'faq', 'cta_blocks', 'related_articles', 'related_category', 'download_pdf', 'consult_block', 'pinned', 'featured', 'robots_index', 'robots_follow'];
  const postProps = {
    title: { type: 'string' }, slug: { type: 'string', description: 'URL slug (a-z0-9-). Omitted → generated.' },
    category: { type: 'string', description: 'category slug from admin_list_categories (news / magazine / seido …)' }, subcategory: { type: 'string' },
    excerpt: { type: 'string' }, body: { type: 'string', description: 'Article body as HTML (h2/h3/p/ul/table…). Internal links: only real biglight.jp / job.biglight.jp pages.' },
    cover_image: { type: 'string' }, cover_alt: { type: 'string' }, cover_caption: { type: 'string' },
    meta_description: { type: 'string', description: '120–160 chars' }, seo_title: { type: 'string', description: '≤60 chars' }, focus_keyword: { type: 'string' }, sub_keyword: { type: 'string' }, related_keywords: { type: 'string', description: 'comma separated' },
    canonical_url: { type: 'string' }, og_title: { type: 'string' }, og_description: { type: 'string' }, og_image: { type: 'string' },
    author: { type: 'string' }, tags: { type: 'string', description: 'comma separated' },
    faq: { type: 'array', items: obj({ q: { type: 'string' }, a: { type: 'string' } }, ['q', 'a']) },
    cta_blocks: { type: 'array', items: obj({ type: { type: 'string' }, label: { type: 'string' }, url: { type: 'string' } }) },
    related_articles: { type: 'string', description: 'slugs, comma separated' }, related_category: { type: 'string' }, download_pdf: { type: 'string' },
    consult_block: { type: 'boolean' }, pinned: { type: 'boolean' }, featured: { type: 'boolean' }, robots_index: { type: 'boolean' }, robots_follow: { type: 'boolean' },
  };
  const pickPost = a => { const o = {}; for (const k of POST_FIELDS) if (a[k] !== undefined) o[k] = a[k]; return o; };
  const shapePostRow = p => ({ id: p.id, slug: p.slug, title: p.title, category: p.category, status: p.status, published_at: p.published_at, updated_at: p.updated_at, views: p.views, author: p.author, tags: p.tags, url: SITE_ORIGIN + '/news/' + p.slug + '/' });

  // ---------- bảng tool ----------
  const TOOLS = [
    { name: 'admin_get_stats', title: '概況', scope: 'read', description: 'Counts: inquiries (new/total), downloads, posts (published/draft/total) and top viewed posts.',
      inputSchema: obj({}), run: ctx => callRoute(ctx, 'get', '/api/stats') },
    { name: 'admin_list_inquiries', title: '問い合わせ一覧', scope: 'read', description: 'Contact-form inquiries (お問い合わせ) newest first. Contains customer personal data — use only for the operator\'s own work.',
      inputSchema: obj({ status: { type: 'string', enum: ['new', 'replied', 'done'] }, q: { type: 'string', description: 'search company/name/email/message' }, limit: { type: 'integer', minimum: 1, maximum: 500 } }),
      run: async (ctx, a) => { let rows = (await callRoute(ctx, 'get', '/api/inquiries')).items; if (a.status) rows = rows.filter(r => r.status === a.status); return { items: lim(q(rows, a.q, ['company', 'name', 'email', 'message']), a.limit).map(shapeInq) }; } },
    { name: 'admin_get_inquiry', title: '問い合わせ詳細', scope: 'read', description: 'One inquiry with its mail history.', inputSchema: obj({ id: { type: 'integer' } }, ['id']),
      run: async (ctx, a) => { const r = (await callRoute(ctx, 'get', '/api/inquiries')).items.find(x => String(x.id) === String(a.id)); if (!r) throw new ToolError('not_found', 404); const logs = (await callRoute(ctx, 'get', '/api/mail/logs', { query: { kind: 'inquiry', id: String(a.id) } })).items; return { ...shapeInq(r), mail_logs: logs }; } },
    { name: 'admin_list_downloads', title: '資料請求一覧', scope: 'read', description: 'Document-request leads (資料請求) newest first. unsent_only=true → leads that never received a mail.',
      inputSchema: obj({ q: { type: 'string' }, unsent_only: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 500 } }),
      run: async (ctx, a) => { let rows = (await callRoute(ctx, 'get', '/api/downloads')).items; if (a.unsent_only) rows = rows.filter(r => !r.last_mail_at); return { items: lim(q(rows, a.q, ['company', 'name', 'email', 'interest', 'note']), a.limit).map(shapeDl) }; } },
    { name: 'admin_get_download', title: '資料請求詳細', scope: 'read', description: 'One download lead with its mail history.', inputSchema: obj({ id: { type: 'integer' } }, ['id']),
      run: async (ctx, a) => { const r = (await callRoute(ctx, 'get', '/api/downloads')).items.find(x => String(x.id) === String(a.id)); if (!r) throw new ToolError('not_found', 404); const logs = (await callRoute(ctx, 'get', '/api/mail/logs', { query: { kind: 'download', id: String(a.id) } })).items; return { ...shapeDl(r), mail_logs: logs }; } },
    { name: 'admin_list_posts', title: '記事一覧', scope: 'read', description: 'Posts (お知らせ・HR Magazine) on biglight.jp/news/. Metadata only; use admin_get_post for the body.',
      inputSchema: obj({ status: { type: 'string', enum: ['draft', 'published', 'scheduled'] }, q: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 } }),
      run: async (ctx, a) => { let rows = (await callRoute(ctx, 'get', '/api/posts')).items; if (a.status) rows = rows.filter(r => r.status === a.status); return { items: lim(q(rows, a.q, ['title', 'slug', 'tags']), a.limit, 100).map(shapePostRow) }; } },
    { name: 'admin_get_post', title: '記事詳細', scope: 'read', description: 'Full post including HTML body and SEO fields.', inputSchema: obj({ id: { type: 'integer' } }, ['id']),
      run: async (ctx, a) => (await callRoute(ctx, 'get', '/api/posts/:id', { params: { id: String(a.id) } })).item },
    { name: 'admin_list_categories', title: 'カテゴリ', scope: 'read', description: 'Post categories (slug + name).', inputSchema: obj({}), run: ctx => callRoute(ctx, 'get', '/api/categories') },
    { name: 'admin_list_materials', title: '添付資料', scope: 'read', description: 'Attachment library (PDF files / external links) used in mails. Use ids in attach_ids.', inputSchema: obj({}),
      run: async ctx => ({ items: (await callRoute(ctx, 'get', '/api/materials')).items.map(m => ({ id: m.id, name: m.name, category: m.category, type: m.filename ? 'file' : 'link', size: m.size, link_url: m.link_url })) }) },
    { name: 'admin_list_mail_templates', title: 'メールテンプレート', scope: 'read', description: 'Mail templates with variables {{company_name}} {{contact_name}} {{today}} {{sales_name}} {{phone}} {{email}} {{industry}}.', inputSchema: obj({}),
      run: ctx => callRoute(ctx, 'get', '/api/mail/templates') },
    { name: 'admin_list_mail_signatures', title: '署名', scope: 'read', description: 'Mail signatures (is_default = appended automatically).', inputSchema: obj({}), run: ctx => callRoute(ctx, 'get', '/api/mail/signatures') },
    { name: 'admin_list_mail_logs', title: '送信履歴', scope: 'read', description: 'Sent-mail log, newest first. Filter by recipient (kind + id).',
      inputSchema: obj({ kind: { type: 'string', enum: ['inquiry', 'download'] }, id: { type: 'integer' }, limit: { type: 'integer', minimum: 1, maximum: 500 } }),
      run: async (ctx, a) => ({ items: lim((await callRoute(ctx, 'get', '/api/mail/logs', { query: a.kind && a.id ? { kind: a.kind, id: String(a.id) } : {} })).items, a.limit, 100) }) },
    { name: 'admin_preview_mail', title: 'メールのプレビュー', scope: 'read', description: 'Render a mail (template or subject/body) for one recipient with variables filled and signature/links appended — WITHOUT sending. Always preview before admin_send_mail.',
      inputSchema: obj({ recipient_key: { type: 'string', description: '"inquiry:<id>" or "download:<id>"' }, template_id: { type: 'integer' }, subject: { type: 'string' }, body: { type: 'string' }, signature_id: { type: 'integer' }, attach_ids: { type: 'array', items: { type: 'integer' } } }, ['recipient_key']),
      run: async (ctx, a) => { const m = await buildMail(ctx, a); return { to: m.p.email, to_name: m.p.name || m.p.company, subject: m.subject, body: m.body, attachments: m.files.map(f => f.name), links: m.links.map(l => l.name), sender: ctx.user.name }; } },

    { name: 'admin_update_inquiry_status', title: '問い合わせ状態変更', scope: 'write', description: 'Set inquiry status: new (未対応) / replied (対応中) / done (完了).',
      inputSchema: obj({ id: { type: 'integer' }, status: { type: 'string', enum: ['new', 'replied', 'done'] } }, ['id', 'status']),
      run: (ctx, a) => callRoute(ctx, 'patch', '/api/inquiries/:id', { params: { id: String(a.id) }, body: { status: a.status } }) },
    { name: 'admin_create_post', title: '記事の下書き作成', scope: 'write', description: 'Create a post as DRAFT (never published by this tool). Body is HTML. Internal links are validated: broken ones are rejected with the list.',
      inputSchema: obj(postProps, ['title', 'body']),
      run: async (ctx, a) => { const b = pickPost(a); b.status = 'draft'; const r = await callRoute(ctx, 'post', '/api/posts', { body: b }); return shapePostRow(r.item); } },
    { name: 'admin_update_post', title: '記事の編集', scope: 'write', description: 'Update fields of a post. Status is NOT changed here (use admin_publish_post / admin_unpublish_post). Editing a published post updates the live page.',
      inputSchema: obj({ id: { type: 'integer' }, ...postProps }, ['id']),
      run: async (ctx, a) => { const cur = (await callRoute(ctx, 'get', '/api/posts/:id', { params: { id: String(a.id) } })).item; if (cur.status === 'published' && !ctx.scopes.includes('publish')) throw new ToolError('scope_required:publish (editing a published post)', 403); const r = await callRoute(ctx, 'put', '/api/posts/:id', { params: { id: String(a.id) }, body: pickPost(a) }); return shapePostRow(r.item); } },
    { name: 'admin_create_mail_template', title: 'テンプレート作成', scope: 'write', description: 'Create a mail template.',
      inputSchema: obj({ name: { type: 'string' }, category: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, signature_id: { type: 'integer' }, attach_ids: { type: 'array', items: { type: 'integer' } } }, ['name', 'subject', 'body']),
      run: (ctx, a) => callRoute(ctx, 'post', '/api/mail/templates', { body: a }) },
    { name: 'admin_update_mail_template', title: 'テンプレート編集', scope: 'write', description: 'Update a mail template.',
      inputSchema: obj({ id: { type: 'integer' }, name: { type: 'string' }, category: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, signature_id: { type: 'integer' }, attach_ids: { type: 'array', items: { type: 'integer' } } }, ['id']),
      run: (ctx, a) => { const { id, ...b } = a; return callRoute(ctx, 'put', '/api/mail/templates/:id', { params: { id: String(id) }, body: b }); } },

    { name: 'admin_publish_post', title: '記事の公開', scope: 'publish', description: 'Publish a post now (or schedule with published_at ISO datetime). Regenerates the static site.',
      inputSchema: obj({ id: { type: 'integer' }, published_at: { type: 'string', description: 'ISO 8601; future → scheduled' } }, ['id']),
      run: async (ctx, a) => { const future = a.published_at && new Date(a.published_at).getTime() > Date.now(); const r = await callRoute(ctx, 'put', '/api/posts/:id', { params: { id: String(a.id) }, body: { status: future ? 'scheduled' : 'published', ...(a.published_at ? { published_at: a.published_at } : {}) } }); return shapePostRow(r.item); } },
    { name: 'admin_unpublish_post', title: '記事を下書きに戻す', scope: 'publish', description: 'Set a post back to draft (removes it from the site).', inputSchema: obj({ id: { type: 'integer' } }, ['id']),
      run: async (ctx, a) => shapePostRow((await callRoute(ctx, 'put', '/api/posts/:id', { params: { id: String(a.id) }, body: { status: 'draft' } })).item) },
    { name: 'admin_regenerate_site', title: '公開サイト再生成', scope: 'publish', description: 'Regenerate biglight.jp/news/ static pages + sitemap.', inputSchema: obj({}), run: ctx => callRoute(ctx, 'post', '/api/news/regenerate') },

    { name: 'admin_send_mail', title: 'メール送信', scope: 'mail', destructive: true, description: 'SEND a real e-mail from the key creator\'s Gmail (GAS) or server SMTP to ONE recipient. Variables filled, signature/link materials appended, file materials attached, logged in 送信履歴. Call admin_preview_mail first and get the person\'s OK.',
      inputSchema: obj({ recipient_key: { type: 'string', description: '"inquiry:<id>" or "download:<id>" (preferred)' }, to: { type: 'string', description: 'raw address when no recipient_key' }, to_name: { type: 'string' }, to_company: { type: 'string' },
        template_id: { type: 'integer' }, subject: { type: 'string' }, body: { type: 'string' }, signature_id: { type: 'integer' }, attach_ids: { type: 'array', items: { type: 'integer' } }, cc: { type: 'string' }, bcc: { type: 'string' } }),
      run: async (ctx, a) => { const m = await buildMail(ctx, a); const r = await callRoute(ctx, 'post', '/api/mail/send', { body: { to: m.p.email, cc: a.cc || '', bcc: a.bcc || '', toName: m.p.name || m.p.company, recipientKey: m.p.key, subject: m.subject, body: m.body, attachIds: m.attachIds, templateId: m.tpl ? m.tpl.id : null, templateName: m.tpl ? m.tpl.name : '', att: m.att, note: 'API:' + ctx.key.name } }); return { sent: true, via: r.via, to: m.p.email, subject: m.subject, attachments: m.files.map(f => f.name) }; } },
  ];
  const READ_SCOPES = ['read'];

  // ---------- quản trị khoá ----------
  const expandScopes = want => { const s = new Set(want.filter(x => SCOPES.includes(x))); s.add('read'); if (s.has('publish')) s.add('write'); return SCOPES.filter(x => s.has(x)); };
  app.get('/api/api-keys', deps.requireAuth, deps.requireAdmin, async (_q, res) => {
    const r = await pool.query('SELECT id,name,prefix,scopes,created_by,created_at,expires_at,last_used_at,use_count,revoked_at FROM api_keys ORDER BY (revoked_at IS NOT NULL), created_at DESC');
    res.json({ items: r.rows, origin: ADMIN_ORIGIN, scopes: SCOPES.map(s => ({ key: s, label: SCOPE_LABEL[s] })), tools: TOOLS.map(t => ({ name: t.name, title: t.title, scope: t.scope, description: t.description })) });
  });
  app.post('/api/api-keys', deps.requireAuth, deps.requireAdmin, async (req, res) => {
    const b = req.body || {}, u = req.session.user;
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: '名前は必須です' });
    const scopes = expandScopes(Array.isArray(b.scopes) ? b.scopes : ['read']);
    if (scopes.includes('mail') && !(u.mail_enabled || isAdminUser(u))) return res.status(403).json({ error: 'メール送信の権限がないため mail スコープの鍵は作れません' });
    const days = Math.max(0, Math.min(365, toInt(b.expires_days) == null ? 90 : toInt(b.expires_days)));
    const key = KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
    const r = await pool.query(`INSERT INTO api_keys(name,prefix,key_hash,scopes,created_by,expires_at) VALUES($1,$2,$3,$4,$5,${days ? `now() + interval '${days} days'` : 'NULL'}) RETURNING id,name,prefix,scopes,created_at,expires_at`,
      [name, key.slice(0, 12), hashKey(key), JSON.stringify(scopes), u.email]);
    audit(req, 'create', 'api_key', r.rows[0].id, 'APIキーを作成: ' + name, { scopes, expires_days: days });
    res.json({ key, item: r.rows[0], origin: ADMIN_ORIGIN });   // khoá thật chỉ trả ở đây, 1 lần
  });
  app.delete('/api/api-keys/:id', deps.requireAuth, deps.requireAdmin, async (req, res) => {
    const r = await pool.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING name', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    audit(req, 'revoke', 'api_key', req.params.id, 'APIキーを無効化: ' + r.rows[0].name);
    res.json({ ok: true });
  });

  // ---------- xác thực khoá ----------
  const rl = new Map();
  async function keyFromReq(req) {
    const h = String(req.headers.authorization || '');
    const m = h.match(/^Bearer\s+(blad_[A-Za-z0-9_-]{20,80})$/) || String(req.params.key || '').match(/^(blad_[A-Za-z0-9_-]{20,80})$/);
    if (!m) return { err: 'api_key_missing', code: 401 };
    const k = (await pool.query('SELECT * FROM api_keys WHERE key_hash=$1', [hashKey(m[1])])).rows[0];
    if (!k || k.revoked_at) return { err: 'api_key_invalid', code: 401 };
    if (k.expires_at && new Date(k.expires_at).getTime() < Date.now()) return { err: 'api_key_expired', code: 401 };
    const now = Date.now(), arr = (rl.get(k.id) || []).filter(t => now - t < RATE_MS);
    if (arr.length >= RATE_LIMIT) { rl.set(k.id, arr); return { err: 'rate_limited', code: 429 }; }
    arr.push(now); rl.set(k.id, arr);
    const prof = (await pool.query('SELECT * FROM profiles WHERE email=$1', [k.created_by])).rows[0];
    if (!prof || prof.status !== 'active') return { err: 'key_owner_inactive', code: 403 };
    pool.query('UPDATE api_keys SET last_used_at=now(), use_count=use_count+1 WHERE id=$1', [k.id]).catch(() => {});
    k.scopes = Array.isArray(k.scopes) ? k.scopes : [];
    return { key: k, user: sessionUser(prof) };
  }

  // ---------- MCP ----------
  const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id == null ? null : id, error: { code, message } });
  const m405 = (_q, res) => res.set('Allow', 'POST').status(405).json({ ok: false, error: 'method_not_allowed' });
  app.get('/mcp', m405); app.delete('/mcp', m405); app.get('/mcp/k/:key', m405);
  app.post('/mcp', mcpPost); app.post('/mcp/k/:key', mcpPost);

  async function mcpPost(req, res) {
    const origin = String(req.headers.origin || '');
    if (origin && origin !== ADMIN_ORIGIN) return res.status(403).json(rpcError(null, -32600, 'origin_not_allowed'));
    const auth = await keyFromReq(req);
    if (!auth.key) { res.set('WWW-Authenticate', 'Bearer realm="biglight-admin-mcp"'); return res.status(auth.code || 401).json(rpcError(null, -32001, auth.err)); }
    const ctx = { key: auth.key, user: auth.user, scopes: auth.key.scopes, ip: clientIp(req) };
    const msgs = Array.isArray(req.body) ? req.body : [req.body];
    const out = [];
    for (const m of msgs) { const r = await handleRpc(m, ctx); if (r) out.push(r); }
    if (!out.length) return res.status(202).end();
    res.json(Array.isArray(req.body) ? out : out[0]);
  }
  async function runTool(name, args, ctx) {
    const t = TOOLS.find(x => x.name === name);
    if (!ctx.scopes.includes(t.scope)) throw new ToolError('scope_required:' + t.scope, 403);
    return t.run(ctx, args || {});
  }
  async function handleRpc(m, ctx) {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return rpcError(m && m.id, -32600, 'invalid_request');
    if (m.id === undefined || m.id === null) return null;   // notification
    const ok = result => ({ jsonrpc: '2.0', id: m.id, result });
    switch (m.method) {
      case 'initialize': {
        const want = String((m.params || {}).protocolVersion || '');
        return ok({ protocolVersion: MCP_VERSIONS.includes(want) ? want : MCP_VERSIONS[0], capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'biglight-admin', title: 'BIGLIGHT 管理画面 (admin.biglight.jp)', version: '2026-09-24' },
          instructions: 'BIGLIGHT株式会社 corporate-site back office: contact-form inquiries (お問い合わせ), document-request leads (資料請求), ' +
            'posts for biglight.jp/news/ (お知らせ・HR Magazine, SEO fields), mail templates / signatures / attachment library and a sent-mail log. ' +
            'You act on behalf of the person who created this key (' + ctx.user.name + ') with at most their permissions; scopes of this key: ' + ctx.scopes.join(', ') + '. ' +
            'Articles: write Japanese HTML, always fill seo_title / meta_description / focus_keyword / excerpt / tags, only link to pages that exist; ' +
            'admin_create_post always creates a DRAFT — publishing needs the publish scope and an explicit request. ' +
            'Mail: build with a template when one fits (admin_list_mail_templates), ALWAYS admin_preview_mail and show it to the person before admin_send_mail; one recipient per call; never invent addresses. ' +
            'There is no delete via this API. Customer data is personal data: use it only for the requested task and do not repeat it unnecessarily.' });
      }
      case 'ping': return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS.filter(t => ctx.scopes.includes(t.scope)).map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
          annotations: { readOnlyHint: READ_SCOPES.includes(t.scope), destructiveHint: !!t.destructive, idempotentHint: READ_SCOPES.includes(t.scope), openWorldHint: t.scope === 'mail' } })) });
      case 'tools/call': {
        const name = String((m.params || {}).name || '');
        if (!TOOLS.some(t => t.name === name)) return rpcError(m.id, -32602, 'unknown_tool: ' + name);
        try {
          const data = await runTool(name, (m.params || {}).arguments, ctx);
          return ok({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data && typeof data === 'object' && !Array.isArray(data) ? data : { result: data }, isError: false });
        } catch (e) {
          const msg = e instanceof ToolError ? (e.code + (e.payload && e.payload.links ? ' ' + JSON.stringify(e.payload.links) : '')) : 'internal_error';
          if (!(e instanceof ToolError)) console.error('[mcp]', name, e.message);
          return ok({ content: [{ type: 'text', text: msg }], isError: true });
        }
      }
      default: return rpcError(m.id, -32601, 'method_not_found');
    }
  }

  return { TOOLS, SCOPES };
};
