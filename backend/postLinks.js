// 内部リンクチェック — biglight.jp (admin.biglight.jp が生成元)
//
// POST /api/posts, PUT /api/posts/:id で保存する前に:
//   1) normalizePostLinks: https://biglight.jp/... (www.可) → 相対パスへ自動変換（無音）
//   2) findBrokenPostLinks: admin.biglight.jp / localhost / 127.0.0.1 / http:// を含むリンク → 拒否
//                            /news/<slug>/ 形式は posts テーブルに存在し status=published か確認
//                            （allowDraftLinks=true なら下書き/予約でも許可）
//
// 対象フィールド: body, excerpt, faq[].q/a, cta_blocks[].url, related_articles,
//                canonical_url, og_title, og_description, og_image

function extractHrefs(html) {
  const out = [];
  const re = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const v = (m[1] !== undefined ? m[1] : m[2]) || '';
    if (v.trim()) out.push(v.trim());
  }
  return out;
}

function rewriteHrefs(html, map) {
  return String(html || '').replace(/href(\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (whole, eq, dq, sq) => {
    const v = ((dq !== undefined ? dq : sq) || '').trim();
    const to = v ? map(v) : null;
    if (to == null || to === v) return whole;
    return dq !== undefined ? `href${eq}"${to}"` : `href${eq}'${to}'`;
  });
}

// 絶対URL（biglight.jp / www.biglight.jp）→ 相対パス。対象外なら null。
const OWN_ORIGIN_RE = /^https?:\/\/(?:www\.)?biglight\.jp(?=[/?#]|$)/i;
function absoluteToRelative(href) {
  const m = String(href || '').match(OWN_ORIGIN_RE);
  if (!m) return null;
  const rest = href.slice(m[0].length);
  return rest.startsWith('/') ? rest : '/' + rest;
}

const FORBIDDEN_SNIPPETS = ['admin.biglight.jp', 'localhost', '127.0.0.1'];
function forbiddenReason(text) {
  const h = String(text || '').toLowerCase();
  for (const s of FORBIDDEN_SNIPPETS) {
    if (h.includes(s)) return `内部リンクに "${s}" が含まれています`;
  }
  if (/^http:\/\/(?:www\.)?biglight\.jp/i.test(text || '')) {
    return '内部リンクが http:// になっています（https:// を使用してください）';
  }
  return null;
}

// ----- 1) 自動正規化（無音） -----
function normalizePostLinks(b) {
  const next = Object.assign({}, b);
  if (typeof b.body === 'string') {
    next.body = rewriteHrefs(b.body, (href) => absoluteToRelative(href));
  }
  if (typeof b.canonical_url === 'string' && b.canonical_url.trim()) {
    const rel = absoluteToRelative(b.canonical_url.trim());
    if (rel) next.canonical_url = rel;
  }
  if (typeof b.og_image === 'string' && b.og_image.trim()) {
    const rel = absoluteToRelative(b.og_image.trim());
    if (rel) next.og_image = rel;
  }
  if (Array.isArray(b.cta_blocks)) {
    next.cta_blocks = b.cta_blocks.map((c) => {
      if (!c || typeof c !== 'object') return c;
      const url = typeof c.url === 'string' ? c.url.trim() : '';
      const rel = url ? absoluteToRelative(url) : null;
      return rel ? Object.assign({}, c, { url: rel }) : c;
    });
  }
  if (typeof b.related_articles === 'string' && b.related_articles.trim()) {
    next.related_articles = b.related_articles.split(',').map((s) => {
      const v = s.trim();
      if (!v) return '';
      const rel = absoluteToRelative(v);
      if (!rel) return v;
      const m = rel.match(/^\/news\/([a-z0-9-]+)\/?$/i);
      return m ? m[1] : rel;
    }).filter(Boolean).join(', ');
  }
  return next;
}

// ----- 2) + 3) 破損リンク検出（拒否ルール） -----
// opts.selfSlug / opts.selfPublished: 保存中の記事自身（新規はまだDBに無い）
async function findBrokenPostLinks(pool, b, opts) {
  opts = opts || {};
  const selfSlug = opts.selfSlug || null;
  const selfPublished = !!opts.selfPublished;
  const allowDraftLinks = !!b.allowDraftLinks;
  const found = []; // {field, href, reason}
  const newsRefs = []; // [field, href, slug]

  const checkHref = (field, hrefRaw) => {
    const href = String(hrefRaw || '').trim();
    if (!href) return;
    const reason = forbiddenReason(href);
    if (reason) { found.push({ field, href, reason }); return; }
    const rel = href.startsWith('/') && !href.startsWith('//') ? href : absoluteToRelative(href);
    if (!rel) return; // 外部サイト or 対象外 → チェックしない
    const m = rel.match(/^\/news\/([a-z0-9-]+)\/?(?:[?#].*)?$/i);
    if (m) newsRefs.push([field, href, m[1]]);
  };
  const scanText = (field, text) => {
    const reason = forbiddenReason(text);
    if (reason) found.push({ field, href: String(text || '').trim(), reason });
  };

  extractHrefs(b.body).forEach((h) => checkHref('body', h));
  if (b.excerpt) scanText('excerpt', b.excerpt);
  if (b.og_title) scanText('og_title', b.og_title);
  if (b.og_description) scanText('og_description', b.og_description);
  if (Array.isArray(b.faq)) b.faq.forEach((f, i) => {
    if (!f) return;
    if (f.q) scanText(`faq[${i}].q`, f.q);
    if (f.a) scanText(`faq[${i}].a`, f.a);
  });
  if (b.canonical_url) checkHref('canonical_url', b.canonical_url);
  if (b.og_image) checkHref('og_image', b.og_image);
  if (Array.isArray(b.cta_blocks)) b.cta_blocks.forEach((c, i) => {
    if (c && c.url) checkHref(`cta_blocks[${i}].url`, c.url);
  });
  if (b.related_articles) {
    String(b.related_articles).split(',').map((s) => s.trim()).filter(Boolean).forEach((v) => {
      const reason = forbiddenReason(v);
      if (reason) { found.push({ field: 'related_articles', href: v, reason }); return; }
      if (/^[a-z0-9-]+$/i.test(v)) newsRefs.push(['related_articles', v, v]);
    });
  }

  if (newsRefs.length) {
    const slugs = Array.from(new Set(newsRefs.map((e) => e[2])));
    const rows = (await pool.query('SELECT slug, status FROM posts WHERE slug = ANY($1)', [slugs])).rows;
    const bySlug = new Map(rows.map((r) => [r.slug, r.status]));
    for (const [field, href, slug] of newsRefs) {
      let status = bySlug.get(slug);
      if (!status && selfSlug && slug === selfSlug) status = selfPublished ? 'published' : 'draft';
      if (!status) { found.push({ field, href, reason: `記事 "${slug}" が存在しません` }); continue; }
      if (status !== 'published' && !allowDraftLinks) {
        found.push({ field, href, reason: `記事 "${slug}" はまだ公開されていません（下書き/予約）` });
      }
    }
  }
  return found;
}

module.exports = { normalizePostLinks, findBrokenPostLinks, forbiddenReason, absoluteToRelative, extractHrefs, rewriteHrefs };
