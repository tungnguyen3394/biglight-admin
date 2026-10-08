// 2026-10-08 chống bot + lọc 営業 cho form công khai (/api/inquiry, /api/download).
// - Turnstile (Cloudflare): chỉ bật khi có TURNSTILE_SECRET; chưa đặt khoá thì bỏ qua (không chặn khách thật).
// - Mã thời gian (form token): server ký thời điểm phát; gửi nhanh hơn MIN_FILL_MS hoặc không có mã → gắn cờ 'bot'.
// - Bộ lọc 営業: chấm điểm theo cụm từ của thư chào hàng; đủ điểm → gắn cờ 'sales'.
// Không xoá gì: bản ghi bị gắn cờ vẫn lưu, chỉ nằm ở tab 「営業・迷惑」 và không gửi mail thông báo / tự động trả lời.
const crypto = require('crypto');

const MIN_FILL_MS = 3000, MAX_TOKEN_AGE_MS = 24 * 60 * 60 * 1000;

function makeFormToken(secret, now = Date.now()) {
  const t = String(now);
  return t + '.' + crypto.createHmac('sha256', secret).update('form:' + t).digest('base64url').slice(0, 22);
}
/** → null (ổn) | lý do gắn cờ 'bot' */
function checkFormToken(secret, token, now = Date.now()) {
  const m = String(token || '').match(/^(\d{10,16})\.([A-Za-z0-9_-]{22})$/);
  if (!m) return 'フォームトークンなし';
  const want = crypto.createHmac('sha256', secret).update('form:' + m[1]).digest('base64url').slice(0, 22);
  if (!crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[2]))) return 'フォームトークン不正';
  const age = now - Number(m[1]);
  if (age < MIN_FILL_MS) return '入力が速すぎる（' + Math.max(0, age) + 'ms）';
  if (age > MAX_TOKEN_AGE_MS) return 'フォームトークン期限切れ';
  return null;
}

/** Cloudflare Turnstile → { ok, skipped?, reason? }. Lỗi mạng tới Cloudflare = cho qua (ghi log), không làm mất khách thật. */
async function verifyTurnstile(secret, token, ip) {
  if (!secret) return { ok: true, skipped: true };
  if (!token) return { ok: false, reason: 'turnstile なし' };
  try {
    const body = new URLSearchParams({ secret, response: String(token).slice(0, 2048) });
    if (ip) body.set('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    return j.success ? { ok: true } : { ok: false, reason: 'turnstile 失敗（' + (j['error-codes'] || []).join(',') + '）' };
  } catch (e) {
    console.error('turnstile verify:', e.message);
    return { ok: true, skipped: true };
  }
}

/* Thư chào hàng (フォーム営業). Điểm ≥ SALES_MIN → 'sales'. Hiệu chỉnh 2026-10-08 trên 88 問い合わせ thật:
   cụm "mạnh" hầu như chỉ thư chào hàng dùng; cụm "yếu" khách thật cũng có thể viết (御社・弊社…) nên một mình không đủ. */
const STRONG = [
  /突然の(ご連絡|ご案内|メール|お問い?合わせ)/, /(フォーム|問い?合わせ(窓口|フォーム)?)(より|から)(失礼|ご連絡)/,
  /無料(体験|トライアル|お試し|相談会のご案内)/, /配信(停止|不要)|今後.{0,10}(ご不要|不要)の(場合|際)/,
  /ご案内(させて|をさせて)?(いただき|頂き)?たく/, /(ご提案|ご紹介)(させて|をさせて)(いただき|頂き)/,
  /(営業|広報|マーケティング|人材紹介|人材)(ご)?担当(者)?(様|さま)/, /を(運営|提供|展開)して(おり|います)/,
  /(特典|キャンペーン)/, /(登録支援機関|人材紹介(会社|企業)?)様(向け|へ|に)/, /(ご支援|サポート)を(専門|行って)/,
];
const WEAK = [/弊社|当社|弊方/, /貴社|御社/, /ご提案/, /サービス/, /掲載/, /媒体/, /送客/, /代表者?(様|さま)/, /https?:\/\//, /資料を(お送り|送付)|ご案内(です|いたします)/, /件名[：:]/, /と申します/, /送り出し|送出機関/];
/* Câu của KHÁCH THẬT (doanh nghiệp muốn tuyển / người tìm việc) — trừ điểm. Thư chào hàng hầu như không viết thế này. */
const CUSTOMER = [/採用を(検討|考え)/, /(求人|仕事|職)を(探して|さがして)/, /就職を希望|働きたい|応募(したい|させて)/, /(ご相談|相談)させていただきたく/, /(紹介|教えて)(して)?いただきたい/, /受け入れを(検討|考え)/];
const SALES_MIN = 4;

function salesScore(text) {
  const s = String(text || '');
  let n = 0;
  for (const re of STRONG) if (re.test(s)) n += 2;
  for (const re of WEAK) if (re.test(s)) n += 1;
  for (const re of CUSTOMER) if (re.test(s)) n -= 3;
  return n;
}
/** Người gửi tự chọn 種別「営業・ご提案」 hoặc điểm đủ cao → 'sales'. */
function classifySales({ kind, company, message }) {
  if (/営業|ご提案|提案/.test(String(kind || ''))) return '種別：営業・ご提案';
  const n = salesScore((company || '') + '\n' + (message || ''));
  return n >= SALES_MIN ? '営業文の特徴（スコア ' + n + '）' : null;
}

module.exports = { makeFormToken, checkFormToken, verifyTurnstile, salesScore, classifySales, SALES_MIN, MIN_FILL_MS };
