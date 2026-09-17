# BIGLIGHT Admin (admin.biglight.jp)

Trang quản trị website biglight.jp — quản lý **お問い合わせ** + **お知らせ・HR Magazine**.
Dữ liệu lưu **PostgreSQL** (database `biglight_web`). Đăng nhập bằng **Google**.

- Backend: Node + Express (`backend/`)
- Chạy bằng Docker, sau Caddy (mạng `web`), domain `admin.biglight.jp`
- Phase 1: nền tảng + đăng nhập ✅ · Phase 2: お問い合わせ · Phase 3: お知らせ (SEO)

## Deploy (VPS)
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

## 監査ログ（管理者のみ）
- テーブル `audit_logs`。ログイン、作成・変更・削除、メール送信（失敗含む）、CSV出力を記録。画面から削除する手段はない。
