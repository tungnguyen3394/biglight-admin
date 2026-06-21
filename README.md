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
