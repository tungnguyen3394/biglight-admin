// Sinh trang tĩnh cho お知らせ (biglight.jp/news/...) — chuẩn SEO (CMS nâng cấp)
const fs = require('fs');
const path = require('path');

const SITE = process.env.SITE_DIR || '/site';   // mount /var/www/biglight
const ADMIN = process.env.ADMIN_ORIGIN || 'https://admin.biglight.jp';
const BASE = 'https://biglight.jp';
const FALLBACK_CAT = { news: 'お知らせ', magazine: 'HR Magazine', seido: '制度・法改正情報', press: 'プレス' };

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function ymd(d) { if (!d) return ''; const t = new Date(d); const p = n => String(n).padStart(2, '0'); return `${t.getFullYear()}.${p(t.getMonth() + 1)}.${p(t.getDate())}`; }
function iso(d) { return d ? new Date(d).toISOString() : ''; }
function tagsOf(p) { return String(p.tags || '').split(',').map(s => s.trim()).filter(Boolean); }
function readingMin(html) { const n = String(html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, '').length; return Math.max(1, Math.round(n / 500)); }
function catName(map, slug) { return map[slug] || FALLBACK_CAT[slug] || slug; }
// An toàn: nếu body còn chứa Markdown table dạng text (<p>| ... |</p>) thì chuyển thành <table> chuẩn
function fixMdTables(html) {
  if (!html || html.indexOf('|') < 0) return html;
  const cells = r => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
  return String(html).replace(/(?:<p>\s*\|.+?\|\s*<\/p>\s*){2,}/g, block => {
    const rows = (block.match(/<p>\s*(\|.+?\|)\s*<\/p>/g) || []).map(r => r.replace(/<\/?p>/g, '').trim());
    if (rows.length < 2 || !/^\|[\s:|-]+\|$/.test(rows[1])) return block;
    const head = cells(rows[0]);
    let body = '';
    for (let i = 2; i < rows.length; i++) { const c = cells(rows[i]); body += '<tr>' + c.map(x => '<td>' + x + '</td>').join('') + '</tr>'; }
    return '<div class="nbody-tablewrap"><table class="nbody-table"><thead><tr>' + head.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  });
}

function head(opts) {
  const img = opts.image || (BASE + '/assets/og-image.jpg');
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="index, follow">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.desc)}">
<link rel="canonical" href="${opts.url}">
<meta property="og:type" content="${opts.ogtype || 'website'}">
<meta property="og:site_name" content="BIGLIGHT株式会社">
<meta property="og:locale" content="ja_JP">
<meta property="og:title" content="${esc(opts.title)}">
<meta property="og:description" content="${esc(opts.desc)}">
<meta property="og:url" content="${opts.url}">
<meta property="og:image" content="${img}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(opts.title)}">
<meta name="twitter:description" content="${esc(opts.desc)}">
<meta name="twitter:image" content="${img}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Great+Vibes&family=Parisienne&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/style.css">
<style>
.nbody .nbody-tablewrap{overflow-x:auto;margin:0 0 24px;-webkit-overflow-scrolling:touch}
.nbody table{width:100%;border-collapse:collapse;margin:24px 0;font-size:15px}
.nbody th,.nbody td{border:1px solid #dcdcdc;padding:14px;text-align:left;line-height:1.7;vertical-align:top}
.nbody th{background:#0f4c81;color:#fff;font-weight:700;white-space:nowrap}
.nbody tbody tr:nth-child(even){background:#f8fafc}
.nbody img{max-width:100%;height:auto}
@media(max-width:600px){.nbody th,.nbody td{padding:10px;font-size:13.5px}}
</style>
${opts.jsonld || ''}
</head>
<body>`;
}

const HEADER = `
<header id="hd">
  <div class="wrap nav">
    <a class="logo" href="/"><img src="/assets/logo.png" alt="BIGLIGHT株式会社"></a>
    <nav class="menu">
      <div class="item"><a href="/about/#company">会社情報</a></div>
      <div class="item"><a href="/service/tokutei-ginou/">サービス</a></div>
      <div class="item"><a href="/case/">導入事例</a></div>
      <div class="item"><a href="/news/">お知らせ</a></div>
      <a class="cta" href="/contact/">無料相談</a>
    </nav>
    <div class="burger" onclick="document.getElementById('mnav').classList.add('open')">&#9776;</div>
  </div>
</header>
<div id="mnav">
  <div class="mclose" onclick="document.getElementById('mnav').classList.remove('open')">&times;</div>
  <a href="/about/#company">会社情報</a>
  <a href="/service/tokutei-ginou/">特定技能 採用サービス</a>
  <a href="/service/jinzai-shoukai/">技人国 人材紹介</a>
  <a href="/case/">導入事例</a>
  <a href="/news/">お知らせ</a>
  <a href="/contact/">無料相談</a>
</div>`;

const FOOTER = `
<footer>
  <div class="wrap">
    <div class="fbottom">
      <span>BIGLIGHT株式会社 ／ 〒462-0007 愛知県名古屋市北区如意一丁目112 A ／ TEL 052-908-7944</span>
      <span>&copy; BIGLIGHT Co., Ltd.</span>
    </div>
  </div>
</footer>
<script src="/assets/main.js"></script>
</body></html>`;

function card(p, map) {
  const rt = readingMin(p.body);
  return `
    <a class="ncard" href="/news/${esc(p.slug)}/">
      ${p.cover_image ? `<div class="ncard-img" style="background-image:url('${esc(p.cover_image)}')"></div>` : '<div class="ncard-img noimg">BIGLIGHT</div>'}
      <div class="ncard-b">
        <div class="ncard-meta"><span class="ncat ${esc(p.category)}">${esc(catName(map, p.category))}</span><span class="ndate">${ymd(p.published_at)}</span></div>
        <h3>${esc(p.title)}</h3>
        <p>${esc((p.excerpt || '').slice(0, 90))}</p>
        <div class="ncard-foot"><span>📖 約${rt}分</span><span>✍ ${esc(p.author || 'BIGLIGHT編集部')}</span></div>
      </div>
    </a>`;
}

function articleHTML(p, map) {
  const url = `${BASE}/news/${p.slug}/`;
  const desc = (p.meta_description || p.excerpt || p.title || '').replace(/\s+/g, ' ').slice(0, 200);
  const img = p.cover_image || (BASE + '/assets/og-image.jpg');
  const tags = tagsOf(p);
  const rt = readingMin(p.body);
  const author = p.author || 'BIGLIGHT編集部';
  const updated = p.updated_at && p.published_at && new Date(p.updated_at) - new Date(p.published_at) > 86400000;
  const jsonld =
`<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'BlogPosting',
  mainEntityOfPage: { '@type': 'WebPage', '@id': url },
  headline: p.title, description: desc, image: [img],
  datePublished: iso(p.published_at), dateModified: iso(p.updated_at || p.published_at),
  author: { '@type': /編集部|Admin/.test(author) ? 'Organization' : 'Person', name: author },
  publisher: { '@type': 'Organization', name: 'BIGLIGHT株式会社', logo: { '@type': 'ImageObject', url: BASE + '/assets/logo.png' } },
  keywords: tags.join(', '), articleSection: catName(map, p.category), inLanguage: 'ja'
})}</script>
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'ホーム', item: BASE + '/' },
    { '@type': 'ListItem', position: 2, name: 'お知らせ', item: BASE + '/news/' },
    { '@type': 'ListItem', position: 3, name: p.title, item: url }]
})}</script>`;
  return head({ title: `${p.title}｜お知らせ｜BIGLIGHT株式会社`, desc, url, image: img, ogtype: 'article', jsonld })
    + HEADER
    + `<nav class="crumb" aria-label="パンくず"><a href="/">ホーム</a> ＞ <a href="/news/">お知らせ</a> ＞ <span>${esc(p.title)}</span></nav>
<article class="sec narticle"><div class="wrap nart">
  <span class="ncat ${esc(p.category)}">${esc(catName(map, p.category))}</span>
  <h1>${esc(p.title)}</h1>
  <div class="nmeta">
    <span>📅 公開 ${ymd(p.published_at)}</span>
    ${updated ? `<span>🔄 更新 ${ymd(p.updated_at)}</span>` : ''}
    <span>✍ ${esc(author)}</span>
    <span>📖 約${rt}分で読めます</span>
    <span>👁 <span id="vcount">${(p.views || 0).toLocaleString()}</span> views</span>
  </div>
  ${p.cover_image ? `<img class="ncover" src="${esc(p.cover_image)}" alt="${esc(p.title)}">` : ''}
  <div class="nbody">${fixMdTables(p.body) || ''}</div>
  ${tags.length ? `<div class="ntags">${tags.map(t => `<a href="/news/tag/${encodeURIComponent(t)}/">#${esc(t)}</a>`).join('')}</div>` : ''}
  <div class="nshare">
    <span>シェア：</span>
    <a target="_blank" rel="noopener" href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}">Facebook</a>
    <a target="_blank" rel="noopener" href="https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(url)}">LINE</a>
    <a target="_blank" rel="noopener" href="https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(p.title)}">X</a>
    <a target="_blank" rel="noopener" href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}">LinkedIn</a>
  </div>
  <div class="nback"><a class="btn-outline" href="/news/">&lsaquo; お知らせ一覧へ</a></div>
</div></article>
<script>(function(){try{var k='v'+${Number(p.id)};if(!sessionStorage.getItem(k)){sessionStorage.setItem(k,'1');fetch('${ADMIN}/api/posts/${Number(p.id)}/view',{method:'POST',mode:'cors'}).then(function(){var e=document.getElementById('vcount');if(e)e.textContent=(${Number(p.views || 0)}+1).toLocaleString();}).catch(function(){});}}catch(e){}})();</script>`
    + FOOTER;
}

function listShell(opts, posts, map) {
  const items = posts.length ? posts.map(p => card(p, map)).join('') : '<p style="text-align:center;color:#64748b;padding:40px;grid-column:1/-1">記事は準備中です。</p>';
  return head(opts) + HEADER
    + `<nav class="crumb" aria-label="パンくず">${opts.crumb}</nav>
<section class="sec"><div class="wrap">
  <div class="sec-head reveal"><div class="en">${opts.en || 'News &amp; Magazine'}</div><h1>${esc(opts.h1)}</h1><p>${esc(opts.lead)}</p></div>
  ${opts.tabs || ''}
  <div class="ngrid">${items}</div>
</div></section>` + FOOTER;
}

function listHTML(posts, map, tags) {
  const tabs = `<div class="ntabs"><a class="on" href="/news/">すべて</a>${tags.slice(0, 12).map(t => `<a href="/news/tag/${encodeURIComponent(t)}/">#${esc(t)}</a>`).join('')}</div>`;
  return listShell({
    title: 'お知らせ・HR Magazine｜BIGLIGHT株式会社',
    desc: 'BIGLIGHTからのお知らせや、外国人材採用（特定技能・技人国）に役立つ情報（HR Magazine）をお届けします。',
    url: BASE + '/news/', h1: 'お知らせ・HR Magazine', lead: 'BIGLIGHTからのお知らせ・採用お役立ち情報。',
    crumb: '<a href="/">ホーム</a> ＞ <span>お知らせ</span>', tabs
  }, posts, map);
}

function tagHTML(tag, posts, map) {
  const url = `${BASE}/news/tag/${encodeURIComponent(tag)}/`;
  return listShell({
    title: `${tag} の記事一覧｜お知らせ｜BIGLIGHT株式会社`,
    desc: `「${tag}」に関するBIGLIGHTのお知らせ・記事一覧です。`,
    url, h1: `# ${tag}`, lead: `「${tag}」の記事一覧`, en: 'Tag',
    crumb: `<a href="/">ホーム</a> ＞ <a href="/news/">お知らせ</a> ＞ <span># ${esc(tag)}</span>`
  }, posts, map);
}

function sitemapXML(posts, tags) {
  const u = (loc, last, pr) => `  <url><loc>${loc}</loc>${last ? `<lastmod>${last}</lastmod>` : ''}<changefreq>weekly</changefreq><priority>${pr}</priority></url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${u(BASE + '/news/', '', '0.8')}
${posts.map(p => u(`${BASE}/news/${p.slug}/`, (iso(p.updated_at || p.published_at) || '').slice(0, 10), '0.7')).join('\n')}
${tags.map(t => u(`${BASE}/news/tag/${encodeURIComponent(t)}/`, '', '0.5')).join('\n')}
</urlset>`;
}

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

async function regenerate(pool) {
  const r = await pool.query("SELECT * FROM posts WHERE status='published' ORDER BY published_at DESC NULLS LAST, created_at DESC");
  const posts = r.rows;
  let map = {};
  try { (await pool.query('SELECT slug,name FROM categories')).rows.forEach(c => { map[c.slug] = c.name; }); } catch (e) { map = FALLBACK_CAT; }
  const newsDir = path.join(SITE, 'news');
  ensureDir(newsDir);
  // tập hợp tag
  const tagSet = new Set();
  posts.forEach(p => tagsOf(p).forEach(t => tagSet.add(t)));
  const tags = [...tagSet];
  // list + sitemap
  fs.writeFileSync(path.join(newsDir, 'index.html'), listHTML(posts, map, tags));
  fs.writeFileSync(path.join(newsDir, 'sitemap.xml'), sitemapXML(posts, tags));
  // bài viết
  for (const p of posts) { const d = path.join(newsDir, p.slug); ensureDir(d); fs.writeFileSync(path.join(d, 'index.html'), articleHTML(p, map)); }
  // trang tag
  const tagRoot = path.join(newsDir, 'tag');
  try { fs.rmSync(tagRoot, { recursive: true, force: true }); } catch (e) {}
  for (const t of tags) {
    const sub = posts.filter(p => tagsOf(p).includes(t));
    const d = path.join(tagRoot, t); ensureDir(d);
    fs.writeFileSync(path.join(d, 'index.html'), tagHTML(t, sub, map));
  }
  return posts.length;
}
function removeSlug(slug) {
  if (!slug) return;
  try { fs.rmSync(path.join(SITE, 'news', slug), { recursive: true, force: true }); } catch (e) {}
}

module.exports = { regenerate, removeSlug };
