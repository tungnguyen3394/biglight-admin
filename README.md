# BIGLIGHT Admin (admin.biglight.jp)

Trang quản trị website biglight.jp — quản lý **お問い合わせ** + **お知らせ・HR Magazine**.
Dữ liệu lưu **PostgreSQL** (database `biglight_web`). Đăng nhập bằng **Google**.

- Backend: Node + Express (`backend/`)
- Chạy bằng Docker, sau Caddy (mạng `web`), domain `admin.biglight.jp`
- Phase 1: nền tảng + đăng nhập ✅ · Phase 2: お問い合わせ · Phase 3: お知らせ (SEO)

## Deploy (cách đang dùng thật — 2026-09-18)

VPS đã có sẵn quyền đọc repo này, nên deploy = SSH vào máy chủ (Termius) rồi chạy 2 lệnh:

```bash
cd /root/biglight-admin && git pull
docker compose -f docker-compose.yml up -d --build admin
```

Kiểm tra: `docker exec biglight-admin wget -qO- http://127.0.0.1:3000/healthz` → `{"ok":true}`
Quay lại bản cũ: `git reset --hard <commit cũ>` rồi chạy lại lệnh build.

⚠ Đừng dùng `docker compose up` trần trên VPS: `docker-compose.override.yml` là file chỉ dành cho máy local
(nó dựng database giả). File đó không nằm trong git nên VPS không có — vẫn nên chỉ định `-f docker-compose.yml`.

`.github/workflows/deploy.yml` có sẵn để tự động hoá, nhưng repo CHƯA có secret VPS nên hiện để chạy tay.

## Deploy lần đầu (VPS)
```bash
# 1) tạo database
docker exec postgres psql "$ADMIN_DB_SUPER" -c "CREATE DATABASE biglight_web OWNER crm_user;"
# 2) clone + cấu hình
git clone https://github.com/<user>/biglight-admin.git /root/biglight-admin
cd /root/biglight-admin && cp .env.example .env && nano .env
# 3) chạy
docker compose up -d --build
# 4) DNS: admin.biglight.jp -> IP VPS
```

## メール送信（問い合わせ／資料請求）
- 一覧で左のチェックボックスを選ぶ →「選択にメール送信」。1人1通ずつ個別送信、`{{company_name}}` などの変数は各社の情報に置換。
- テンプレート・署名・添付PDFの管理は各一覧の「テンプレート・資料」から（旧「営業メール管理」メニューは廃止）。
- 送信は各自の GAS(Gmail) 優先、未登録ならサーバ SMTP。添付ファイルが見つからない／合計24MB超の場合は送信しない。
- GAS は **v3**（CRM と同じ: senderName 対応・doGet で「v3」表示・sendTest）。差出人名 = ログイン名そのまま（会社名の前置きなし）。旧版の人は v3 を貼り直して「新しいデプロイ」→ 新 URL を登録。サーバは GAS の `{ok:false}` / `{success:false}` どちらも失敗として扱う。
- 添付ファイルは `/site/assets/materials/mat-<id>-<ランダム16文字>.<ext>`（公開 URL だが推測不可）。旧形式 `mat-<id>.<ext>` は起動時に自動リネーム。

## API・MCP連携（AI に作業を頼む）
- メニュー「API・MCP連携」（管理者のみ）で鍵を作成。鍵は **一度だけ** 表示、DB には sha256 のみ（`api_keys`）。
- スコープ: `read`（読む）⊂ `write`（記事の下書き作成/編集・テンプレート・問い合わせ状態）⊂ `publish`（公開・再生成）、`mail`（鍵作成者の Gmail/GAS からメール送信）。**削除は AI からできない。**
- AI は鍵を作った人の権限・GAS で動く（route を再ディスパッチ → 同じ権限チェック・同じ監査ログ。actor_name は `API:<鍵名>／<氏名>`）。
- 接続: Claude Code `claude mcp add --transport http biglight-admin https://admin.biglight.jp/mcp --header "Authorization: Bearer <鍵>"`、ChatGPT は `https://admin.biglight.jp/mcp/k/<鍵>`（認証なし）。GET /mcp は 405。
- 実装: `backend/mcp.js`（ツール一覧はその中の `TOOLS`。追加 = 配列に 1 要素）。レート 300 回/10 分/鍵。
- 画面の URL: `/inquiries/<id>` `/downloads/<id>` `/posts/<id>` `/mail` `/integrations` … は直接開ける（server.js の SPA フォールバック）。

## 監査ログ（管理者のみ）
- テーブル `audit_logs`。ログイン、作成・変更・削除、メール送信（失敗含む）、CSV出力を記録。画面から削除する手段はない。
