// Sinh trang tĩnh cho お知らせ vào thư mục web (biglight.jp/news/...) — chuẩn SEO
const fs = require('fs');
const path = require('path');

const SITE = process.env.SITE_DIR || '/site';   // mount /var/www/biglight
const BASE = 'https://biglight.jp';
const CAT = { news: 'お知らせ', magazine: 'HR Magazine', press: 'プレス' };

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function ymd(d) { if (!d) return ''; const t = new Date(d); const p = n => String(n).padStart(2, '0'); return `${t.getFullYear()}.${p(t.getMonth() + 1)}.${p(t.getDate())}`; }
function iso(d) { return d ? new Date(d).toISOString() : ''; }

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

function articleHTML(p) {
  const url = `${BASE}/news/${p.slug}/`;
  const desc = (p.meta_description || p.excerpt || p.title || '').replace(/\s+/g, ' ').slice(0, 200);
  const img = p.cover_image || (BASE + '/assets/og-image.jpg');
  const jsonld =
`<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'Article',
  headline: p.title, description: desc, image: [img],
  datePublished: iso(p.published_at), dateModified: iso(p.updated_at || p.published_at),
  author: { '@type': 'Organization', name: 'BIGLIGHT株式会社' },
  publisher: { '@type': 'Organization', name: 'BIGLIGHT株式会社', logo: { '@type': 'ImageObject', url: BASE + '/assets/logo.png' } },
  mainEntityOfPage: url
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
  <span class="ncat ${esc(p.category)}">${esc(CAT[p.category] || p.category)}</span>
  <h1>${esc(p.title)}</h1>
  <div class="ndate">${ymd(p.published_at)}</div>
  ${p.cover_image ? `<img class="ncover" src="${esc(p.cover_image)}" alt="${esc(p.title)}">` : ''}
  <div class="nbody">${p.body || ''}</div>
  <div class="nback"><a class="btn-outline" href="/news/">&lsaquo; お知らせ一覧へ</a></div>
</div></article>`
    + FOOTER;
}

function listHTML(posts) {
  const url = BASE + '/news/';
  const items = posts.length ? posts.map(p => `
    <a class="ncard" href="/news/${esc(p.slug)}/">
      ${p.cover_image ? `<div class="ncard-img" style="background-image:url('${esc(p.cover_image)}')"></div>` : '<div class="ncard-img noimg"></div>'}
      <div class="ncard-b">
        <div class="ncard-meta"><span class="ndate">${ymd(p.published_at)}</span><span class="ncat ${esc(p.category)}">${esc(CAT[p.category] || p.category)}</span></div>
        <h3>${esc(p.title)}</h3>
        <p>${esc((p.excerpt || '').slice(0, 90))}</p>
      </div>
    </a>`).join('') : '<p style="text-align:center;color:#64748b;padding:40px">記事は準備中です。</p>';
  return head({ title: 'お知らせ・HR Magazine｜BIGLIGHT株式会社', desc: 'BIGLIGHTからのお知らせや、外国人材採用に役立つ情報（HR Magazine）をお届けします。', url })
    + HEADER
    + `<nav class="crumb" aria-label="パンくず"><a href="/">ホーム</a> ＞ <span>お知らせ</span></nav>
<section class="sec"><div class="wrap">
  <div class="sec-head reveal"><div class="en">News &amp; Magazine</div><h1>お知らせ・HR Magazine</h1><p>BIGLIGHTからのお知らせ・採用お役立ち情報。</p></div>
  <div class="ngrid">${items}</div>
</div></section>`
    + FOOTER;
}

function sitemapXML(posts) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${BASE}/news/</loc><changefreq>daily</changefreq><priority>0.8</priority></url>
${posts.map(p => `  <url><loc>${BASE}/news/${p.slug}/</loc><lastmod>${(iso(p.updated_at || p.published_at) || '').slice(0, 10)}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>`).join('\n')}
</urlset>`;
}

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

async function regenerate(pool) {
  const r = await pool.query("SELECT * FROM posts WHERE status='published' ORDER BY published_at DESC NULLS LAST, created_at DESC");
  const posts = r.rows;
  const newsDir = path.join(SITE, 'news');
  ensureDir(newsDir);
  fs.writeFileSync(path.join(newsDir, 'index.html'), listHTML(posts));
  fs.writeFileSync(path.join(newsDir, 'sitemap.xml'), sitemapXML(posts));
  for (const p of posts) { const d = path.join(newsDir, p.slug); ensureDir(d); fs.writeFileSync(path.join(d, 'index.html'), articleHTML(p)); }
  return posts.length;
}
function removeSlug(slug) {
  if (!slug) return;
  try { fs.rmSync(path.join(SITE, 'news', slug), { recursive: true, force: true }); } catch (e) {}
}

module.exports = { regenerate, removeSlug };
