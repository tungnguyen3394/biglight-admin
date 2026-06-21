-- Database: biglight_web (PostgreSQL thuần, bảng quan hệ)

-- 問い合わせ (form liên hệ)
CREATE TABLE IF NOT EXISTS inquiries (
  id          BIGSERIAL PRIMARY KEY,
  company     TEXT,
  name        TEXT,
  email       TEXT,
  tel         TEXT,
  message     TEXT,
  status      TEXT NOT NULL DEFAULT 'new',   -- new | replied | done
  ip          TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inq_created ON inquiries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inq_status  ON inquiries(status);

-- 資料請求 (người tải tài liệu PDF)
CREATE TABLE IF NOT EXISTS downloads (
  id          BIGSERIAL PRIMARY KEY,
  company     TEXT,
  name        TEXT,
  email       TEXT,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dl_created ON downloads(created_at DESC);

-- お知らせ・HR Magazine (bài viết)
CREATE TABLE IF NOT EXISTS posts (
  id               BIGSERIAL PRIMARY KEY,
  slug             TEXT UNIQUE NOT NULL,
  title            TEXT NOT NULL,
  category         TEXT NOT NULL DEFAULT 'news',   -- news | magazine | press
  excerpt          TEXT,
  body             TEXT,
  cover_image      TEXT,
  meta_description TEXT,
  status           TEXT NOT NULL DEFAULT 'draft',  -- draft | published
  published_at     TIMESTAMPTZ,
  author           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_posts_pub ON posts(status, published_at DESC);
