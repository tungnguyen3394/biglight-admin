// Sinh trang tĩnh cho お知らせ (biglight.jp/news/...) — chuẩn SEO (CMS nâng cấp)
const fs = require('fs');
const path = require('path');

const SITE = process.env.SITE_DIR || '/site';   // mount /var/www/biglight
const ADMIN = process.env.ADMIN_ORIGIN || 'https://admin.biglight.jp';
const BASE = 'https://biglight.jp';
const FALLBACK_CAT = { news: 'お知らせ', magazine: 'HR Magazine', seido: '制度・法改正情報', press: 'プレス' };

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// meta 用 SVG ラインアイコン（絵文字の置き換え）
const mi = d => `<svg class="mi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const MI = {
  cal: mi('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  upd: mi('<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>'),
  pen: mi('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  book: mi('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'),
  eye: mi('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>')
};
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

function jt(p) { const d = { article: true, faq: false, breadcrumb: true, organization: true, video: false, howto: false }; try { const o = typeof p.jsonld_types === 'string' ? JSON.parse(p.jsonld_types) : (p.jsonld_types || {}); return Object.assign(d, o); } catch (e) { return d; } }
function jarr(v) { try { return typeof v === 'string' ? JSON.parse(v) : (Array.isArray(v) ? v : []); } catch (e) { return []; } }
// 見出しに id を付与し、目次(TOC)を生成
function buildToc(html) {
  if (!html) return { html: '', toc: '' };
  let n = 0; const items = [];
  const withIds = String(html).replace(/<(h[23])(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (m, tag, attr, inner) => {
    const text = inner.replace(/<[^>]*>/g, '').trim(); if (!text) return m;
    const id = 'toc-' + (++n);
    items.push({ id, text, lv: tag.toLowerCase() === 'h2' ? 2 : 3 });
    return `<${tag}${attr || ''} id="${id}">${inner}</${tag}>`;
  });
  if (!items.length) return { html: withIds, toc: '' };
  const toc = `<nav class="ntoc" aria-label="目次"><div class="ntoc-h">目次</div><ol>${items.map(it => `<li class="lv${it.lv}"><a href="#${it.id}">${esc(it.text)}</a></li>`).join('')}</ol></nav>`;
  return { html: withIds, toc };
}
function lazyImgs(html) { return String(html || '').replace(/<img (?![^>]*\bloading=)/gi, '<img loading="lazy" '); }

function head(opts) {
  const img = opts.image || (BASE + '/assets/og-image.jpg');
  const ogTitle = opts.ogTitle || opts.title;
  const ogDesc = opts.ogDesc || opts.desc;
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="${opts.robots || 'index, follow'}">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.desc)}">
<link rel="canonical" href="${opts.canonical || opts.url}">
<meta property="og:type" content="${opts.ogtype || 'website'}">
<meta property="og:site_name" content="BIGLIGHT株式会社">
<meta property="og:locale" content="ja_JP">
<meta property="og:title" content="${esc(ogTitle)}">
<meta property="og:description" content="${esc(ogDesc)}">
<meta property="og:url" content="${opts.url}">
<meta property="og:image" content="${opts.ogImage || img}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(ogTitle)}">
<meta name="twitter:description" content="${esc(ogDesc)}">
<meta name="twitter:image" content="${opts.ogImage || img}">
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
.ntoc{background:#f6f9fe;border:1px solid #dbe6f4;border-radius:12px;padding:16px 20px;margin:0 0 28px}
.ntoc-h{font-weight:800;color:#0f4c81;margin-bottom:8px;font-size:15px}
.ntoc ol{margin:0;padding-left:20px}.ntoc li{margin:5px 0;line-height:1.6}
.ntoc li.lv3{margin-left:16px;list-style:circle;font-size:14px}
.ntoc a{color:#1e6fd6;text-decoration:none}.ntoc a:hover{text-decoration:underline}
.nbody .ncallout{border-left:4px solid #1e6fd6;background:#eef4fc;border-radius:8px;padding:14px 18px;margin:20px 0}
.nbody .ncallout.warn{border-color:#f5a623;background:#fff7ea}
.nbody .nbtn{display:inline-block;background:#e23b3b;color:#fff!important;padding:12px 26px;border-radius:10px;font-weight:700;text-decoration:none;margin:8px 0}
.nbody .nacc{border:1px solid #e2e8f0;border-radius:8px;margin:12px 0;overflow:hidden}
.nbody .nacc>summary{cursor:pointer;padding:13px 16px;font-weight:700;background:#f8fafc;list-style:none}
.nbody .nacc>summary::-webkit-details-marker{display:none}
.nbody .nacc>div{padding:13px 16px}
.nbody .ncheck{list-style:none;padding-left:0}.nbody .ncheck li{padding-left:28px;position:relative;margin:6px 0}
.nbody .ncheck li:before{content:"\\2714";position:absolute;left:0;color:#16a34a;font-weight:900}
.nbody .nembed{position:relative;padding-bottom:56.25%;height:0;margin:20px 0;border-radius:12px;overflow:hidden}
.nbody .nembed iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.ncaption{font-size:13px;color:#64748b;text-align:center;margin:-14px 0 22px}
.nfaq{margin:34px 0}.nfaq h2{font-size:22px;color:#0f4c81;margin-bottom:14px}
.nfaq-i{border:1px solid #e2e8f0;border-radius:10px;margin:10px 0;overflow:hidden}
.nfaq-i>summary{cursor:pointer;padding:15px 18px;font-weight:700;list-style:none;background:#f8fafc}
.nfaq-i>summary::-webkit-details-marker{display:none}
.nfaq-i>div{padding:15px 18px;line-height:1.8;white-space:pre-wrap}
.ncta{display:flex;gap:12px;flex-wrap:wrap;margin:28px 0}
.ncta-btn{display:inline-block;background:#e23b3b;color:#fff;padding:14px 30px;border-radius:12px;font-weight:700;text-decoration:none}
.nconsult{background:linear-gradient(135deg,#0f4c81,#1e6fd6);color:#fff;border-radius:16px;padding:28px;text-align:center;margin:34px 0}
.nconsult h3{font-size:20px;margin-bottom:8px}.nconsult p{opacity:.92;margin-bottom:16px}
.nconsult .btn-primary{display:inline-block;background:#fff;color:#0f4c81;padding:12px 30px;border-radius:10px;font-weight:800;text-decoration:none}
.ndl{margin:24px 0}.nrelated{margin:30px 0}.nrelated h3{font-size:18px;color:#0f4c81;margin-bottom:10px}
.nrelated ul{padding-left:20px}.nrelated li{margin:6px 0}
.mi{width:14px;height:14px;vertical-align:-2px;margin-right:4px;stroke:currentColor;flex-shrink:0}
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
      <div class="item">
        <a>会社情報 <span class="caret">&#9660;</span></a>
        <div class="dropdown">
          <a href="/about/#mv">理念（Mission / Vision）</a>
          <a href="/about/#message">代表メッセージ</a>
          <a href="/#strength">選ばれる理由</a>
          <a href="/about/#history">沿革</a>
          <a href="/about/#company">会社概要</a>
        </div>
      </div>
      <div class="item">
        <a>サービス <span class="caret">&#9660;</span></a>
        <div class="dropdown">
          <a href="/service/tokutei-ginou/">特定技能 採用サービス</a>
          <a href="/service/jinzai-shoukai/">技人国 人材紹介</a>
          <a href="/service/teichaku/">定着・生活支援</a>
          <a href="/flow/">導入の流れ</a>
          <a href="/case/">導入事例</a>
        </div>
      </div>
      <div class="item"><a href="/case/">導入事例</a></div>
      <div class="item"><a href="/faq/">よくある質問</a></div>
      <div class="item"><a href="/news/">お知らせ</a></div>
      <div class="item">
        <a>採用情報 <span class="caret">&#9660;</span></a>
        <div class="dropdown">
          <a href="/recruit/">採用トップ</a>
          <a href="/recruit/#culture">会社文化</a>
          <a href="/recruit/#senpai">先輩の声</a>
        </div>
      </div>
      <a class="cta" href="/contact/">無料相談</a>
    </nav>
    <div class="burger" onclick="document.getElementById('mnav').classList.add('open')">&#9776;</div>
  </div>
</header>
<div id="mnav">
  <div class="mclose" onclick="document.getElementById('mnav').classList.remove('open')">&times;</div>
  <div class="macc">
    <button type="button" class="macc-h">会社情報 <span class="macc-ar">&#9662;</span></button>
    <div class="macc-body">
      <a href="/about/#mv">理念（Mission / Vision）</a>
      <a href="/about/#message">代表メッセージ</a>
      <a href="/#strength">選ばれる理由</a>
      <a href="/about/#history">沿革</a>
      <a href="/about/#company">会社概要</a>
    </div>
  </div>
  <div class="macc">
    <button type="button" class="macc-h">サービス <span class="macc-ar">&#9662;</span></button>
    <div class="macc-body">
      <a href="/service/tokutei-ginou/">特定技能 採用サービス</a>
      <a href="/service/jinzai-shoukai/">技人国 人材紹介</a>
      <a href="/service/teichaku/">定着・生活支援</a>
      <a href="/flow/">導入の流れ</a>
      <a href="/case/">導入事例</a>
    </div>
  </div>
  <a class="macc-link" href="/case/">導入事例</a>
  <a class="macc-link" href="/faq/">よくある質問</a>
  <a class="macc-link" href="/news/">お知らせ</a>
  <div class="macc">
    <button type="button" class="macc-h">採用情報 <span class="macc-ar">&#9662;</span></button>
    <div class="macc-body">
      <a href="/recruit/">採用トップ</a>
      <a href="/recruit/#culture">会社文化</a>
      <a href="/recruit/#senpai">先輩の声</a>
    </div>
  </div>
  <a class="macc-cta" href="/contact/">無料相談</a>
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
        <div class="ncard-foot"><span>${MI.book}約${rt}分</span><span>${MI.pen}${esc(p.author || 'BIGLIGHT編集部')}</span></div>
      </div>
    </a>`;
}

function articleHTML(p, map) {
  const url = `${BASE}/news/${p.slug}/`;
  const seoTitle = (p.seo_title || '').trim() || `${p.title}｜お知らせ｜BIGLIGHT株式会社`;
  const desc = (p.meta_description || p.excerpt || p.title || '').replace(/\s+/g, ' ').slice(0, 200);
  const img = p.cover_image || p.og_image || (BASE + '/assets/og-image.jpg');
  const tags = tagsOf(p);
  const rt = readingMin(p.body);
  const author = p.author || 'BIGLIGHT編集部';
  const updated = p.updated_at && p.published_at && new Date(p.updated_at) - new Date(p.published_at) > 86400000;
  const types = jt(p);
  const faqs = jarr(p.faq).filter(f => f && (f.q || f.a));
  const ctas = jarr(p.cta_blocks).filter(c => c && (c.label || c.url));
  const robots = `${p.robots_index === false ? 'noindex' : 'index'}, ${p.robots_follow === false ? 'nofollow' : 'follow'}`;
  // 本文: 見出しID付与 + 目次 + 遅延読み込み
  let body = fixMdTables(p.body) || '';
  const built = buildToc(body); body = built.html;
  if (built.toc && /\[\[TOC\]\]|\[\[目次\]\]|<div class="ntoc-here"><\/div>/.test(body)) {
    body = body.replace(/\[\[TOC\]\]|\[\[目次\]\]|<div class="ntoc-here"><\/div>/g, built.toc);
  }
  if (p.lazy_load !== false) body = lazyImgs(body);
  // JSON-LD (種類ごとに出力)
  const ld = [];
  if (types.article) ld.push({
    '@context': 'https://schema.org', '@type': 'BlogPosting', mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    headline: p.title, description: desc, image: [img],
    datePublished: iso(p.published_at), dateModified: iso(p.updated_at || p.published_at),
    author: { '@type': /編集部|Admin/.test(author) ? 'Organization' : 'Person', name: author },
    publisher: { '@type': 'Organization', name: 'BIGLIGHT株式会社', logo: { '@type': 'ImageObject', url: BASE + '/assets/logo.png' } },
    keywords: tags.join(', '), articleSection: catName(map, p.category), inLanguage: 'ja'
  });
  if (types.breadcrumb) ld.push({
    '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'ホーム', item: BASE + '/' },
      { '@type': 'ListItem', position: 2, name: 'お知らせ', item: BASE + '/news/' },
      { '@type': 'ListItem', position: 3, name: p.title, item: url }]
  });
  if (types.organization) ld.push({ '@context': 'https://schema.org', '@type': 'Organization', name: 'BIGLIGHT株式会社', url: BASE + '/', logo: BASE + '/assets/logo.png' });
  if (types.faq && faqs.length) ld.push({
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: faqs.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } }))
  });
  const jsonld = ld.map(o => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join('\n');
  // 記事末尾ブロック
  const faqHtml = faqs.length ? `<div class="nfaq"><h2>よくある質問</h2>${faqs.map(f => `<details class="nfaq-i"><summary>${esc(f.q)}</summary><div>${esc(f.a)}</div></details>`).join('')}</div>` : '';
  const ctaHtml = ctas.length ? `<div class="ncta">${ctas.map(c => `<a class="ncta-btn" href="${esc(c.url || '#')}"${/^https?:/.test(c.url || '') ? ' target="_blank" rel="noopener"' : ''}>${esc(c.label || c.type || '詳しく見る')}</a>`).join('')}</div>` : '';
  const dl = String(p.download_pdf || '').trim();
  const dlHtml = dl ? `<div class="ndl"><a class="btn-outline" href="${esc(dl.split(/\s+/)[0])}" target="_blank" rel="noopener">📄 資料をダウンロード</a></div>` : '';
  const rel = String(p.related_articles || '').split(',').map(s => s.trim()).filter(Boolean);
  const relHtml = rel.length ? `<div class="nrelated"><h3>関連記事</h3><ul>${rel.map(x => /^[a-z0-9\-]+$/.test(x) ? `<li><a href="/news/${esc(x)}/">${esc(x)}</a></li>` : `<li>${esc(x)}</li>`).join('')}</ul></div>` : '';
  const consultHtml = p.consult_block ? `<div class="nconsult"><h3>無料相談のご案内</h3><p>外国人材の採用・特定技能についてお気軽にご相談ください。</p><a class="btn-primary" href="/contact/">無料相談する</a></div>` : '';
  return head({ title: seoTitle, desc, url, image: img, ogtype: 'article', jsonld, robots, canonical: (p.canonical_url || '').trim() || url, ogTitle: p.og_title || p.title, ogDesc: p.og_description || desc, ogImage: p.og_image || img })
    + HEADER
    + `<nav class="crumb" aria-label="パンくず"><a href="/">ホーム</a> ＞ <a href="/news/">お知らせ</a> ＞ <span>${esc(p.title)}</span></nav>
<article class="sec narticle"><div class="wrap nart">
  <span class="ncat ${esc(p.category)}">${esc(catName(map, p.category))}</span>
  <h1>${esc(p.title)}</h1>
  <div class="nmeta">
    <span>${MI.cal}公開 ${ymd(p.published_at)}</span>
    ${updated ? `<span>${MI.upd}更新 ${ymd(p.updated_at)}</span>` : ''}
    <span>${MI.pen}${esc(author)}</span>
    <span>${MI.book}約${rt}分で読めます</span>
    <span>${MI.eye}<span id="vcount">${(p.views || 0).toLocaleString()}</span> views</span>
  </div>
  ${p.cover_image ? `<img class="ncover" src="${esc(p.cover_image)}" alt="${esc(p.cover_alt || p.title)}"${p.cover_title ? ` title="${esc(p.cover_title)}"` : ''}>${p.cover_caption ? `<div class="ncaption">${esc(p.cover_caption)}</div>` : ''}` : ''}
  <div class="nbody">${body}</div>
  ${faqHtml}
  ${dlHtml}
  ${ctaHtml}
  ${consultHtml}
  ${relHtml}
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
