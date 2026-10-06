// ============================================================================
// Lọc HTML bài viết + kiểm URL (audit 2026-10-06, mục #2 / #6)
//
// Trước đây body bài viết là HTML thô: nút「</> HTML」trong trình soạn, link Markdown
// `[x](javascript:…)` và tool MCP admin_create_post đều ghi thẳng vào DB, rồi HTML đó
// chạy ở (1) trang công khai biglight.jp/news/… và (2) trình duyệt ADMIN khi mở bài
// (Quill dangerouslyPasteHTML). Một staff hoặc một khoá API scope write có thể cài
// script chiếm phiên admin. Nay: lọc theo danh sách cho phép ở MÁY CHỦ — khi lưu,
// khi trả bài về màn hình, và khi sinh trang tĩnh (bài cũ trong DB cũng được lọc).
// ============================================================================
const sanitizeHtml = require('sanitize-html');

const YT_RE = /^https:\/\/(?:www\.)?(?:youtube\.com|youtube-nocookie\.com)\/embed\/[A-Za-z0-9_-]{6,}(?:\?[^"'<>\s]*)?$/;

const OPTIONS = {
  allowedTags: ['h2', 'h3', 'h4', 'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'span', 'div',
    'a', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'img', 'figure', 'figcaption',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'details', 'summary', 'iframe'],
  allowedAttributes: {
    '*': ['class', 'id', 'title', 'contenteditable'],
    a: ['href', 'target', 'rel', 'name'],
    img: ['src', 'alt', 'width', 'height', 'loading'],
    iframe: ['src', 'allowfullscreen', 'loading', 'title', 'allow'],
    td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan', 'scope'],
    ol: ['start'], details: ['open'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowProtocolRelative: false,
  allowedIframeHostnames: ['www.youtube.com', 'youtube.com', 'www.youtube-nocookie.com'],
  exclusiveFilter: frame => frame.tag === 'iframe' && !YT_RE.test(frame.attribs.src || ''),
  transformTags: {
    a: (tag, attribs) => {
      const out = { ...attribs };
      if (out.target === '_blank') out.rel = 'noopener noreferrer';
      else delete out.target;
      return { tagName: 'a', attribs: out };
    },
  },
};

function cleanHtml(html) {
  if (html == null) return html;
  return sanitizeHtml(String(html), OPTIONS);
}

/** URL cho thuộc tính (ảnh bìa, OG, PDF, CTA, canonical): chỉ http(s) hoặc đường dẫn tương đối "/…".
 *  Mã hoá ' ( ) để không thoát được ra khỏi url('…') trong CSS. Không hợp lệ → null. */
function safeUrl(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (/[\s<>"\\`]/.test(s)) return null;
  if (!/^(https?:\/\/[^/]|\/(?!\/))/i.test(s)) return null;
  return s.replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/** Nhiều URL cách nhau bởi khoảng trắng (download_pdf) — giữ những cái hợp lệ. */
function safeUrlList(v) {
  const parts = String(v == null ? '' : v).trim().split(/\s+/).filter(Boolean).map(safeUrl).filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

module.exports = { cleanHtml, safeUrl, safeUrlList, OPTIONS };
