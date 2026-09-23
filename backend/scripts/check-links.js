#!/usr/bin/env node
// Quét MỌI bài viết (posts) tìm link nội bộ hỏng — KHÔNG tự sửa gì.
//
//   node scripts/check-links.js
//
// Cron 06:00 JST (chạy trong container, DATABASE_URL/SMTP_* lấy từ env docker-compose):
//   0 21 * * * docker exec biglight-admin node scripts/check-links.js >> /var/log/biglight-linkcheck.log 2>&1
//   (21:00 UTC = 06:00 JST hôm sau)
//
// Luật kiểm tra: xem ../postLinks.js — admin.biglight.jp/localhost/127.0.0.1/http:// nội bộ,
// và href /news/<slug>/ trỏ tới bài không tồn tại hoặc chưa published.
// Có link hỏng → mail LINKCHECK_NOTIFY_TO (hoặc ADMIN_NOTIFY_TO) kèm bảng (bài, link, lý do).
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const { findBrokenPostLinks } = require('../postLinks');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows: posts } = await pool.query(
    "SELECT id, slug, title, status, body, excerpt, faq, cta_blocks, related_articles, canonical_url, og_title, og_description, og_image FROM posts ORDER BY created_at ASC"
  );
  console.log(`[${new Date().toISOString()}] biglight.jp — 記事 ${posts.length} 件を確認…\n`);

  const all = []; // {slug, title, field, href, reason}
  for (const p of posts) {
    const broken = await findBrokenPostLinks(pool, p, { selfSlug: p.slug, selfPublished: p.status === 'published' });
    for (const b of broken) all.push({ slug: p.slug, title: p.title, field: b.field, href: b.href, reason: b.reason });
  }

  if (!all.length) {
    console.log('リンク破損なし。');
    await pool.end();
    return;
  }

  console.log(`⚠ ${all.length} 件のリンクに問題:`);
  for (const x of all) console.log(`  ${x.slug} | ${x.field} | ${x.href} | ${x.reason}`);

  await notify(all);
  await pool.end();
}

async function notify(items) {
  const to = process.env.LINKCHECK_NOTIFY_TO || process.env.ADMIN_NOTIFY_TO || '';
  if (!to) { console.log('\n(LINKCHECK_NOTIFY_TO / ADMIN_NOTIFY_TO 未設定 — メール送信スキップ)'); return; }

  const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
  const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);
  const SMTP_USER = process.env.SMTP_USER || '';
  const SMTP_PASS = process.env.SMTP_PASS || '';
  const SMTP_SECURE = process.env.SMTP_SECURE ? (process.env.SMTP_SECURE === 'true') : (SMTP_PORT === 465);
  const SMTP_NOAUTH = process.env.SMTP_NOAUTH === 'true';
  if (!SMTP_HOST || !(SMTP_PASS || SMTP_NOAUTH)) { console.log('\n(SMTP 未設定 — メール送信スキップ)'); return; }

  const opt = { host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE, family: 4, requireTLS: !SMTP_SECURE };
  if (SMTP_PASS) opt.auth = { user: SMTP_USER, pass: SMTP_PASS };
  const transporter = nodemailer.createTransport(opt);
  const MAIL_FROM = process.env.MAIL_FROM || ('BIGLIGHT <' + SMTP_USER + '>');

  const rows = items.map((x) => `・${x.title}（${x.slug}）\n  [${x.field}] ${x.href}\n  → ${x.reason}`).join('\n\n');
  const text = `biglight.jp: 内部リンク破損 ${items.length} 件を検出しました（自動修正はしていません）。\n管理画面で確認・修正してください：https://admin.biglight.jp\n\n${rows}`;
  try {
    await transporter.sendMail({ from: MAIL_FROM, to, subject: `【biglight.jp】内部リンク破損 ${items.length}件`, text });
    console.log(`\nメール送信: ${to}`);
  } catch (e) {
    console.error('\nメール送信失敗:', e.message);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; pool.end(); });
