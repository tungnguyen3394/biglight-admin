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
ALTER TABLE downloads ADD COLUMN IF NOT EXISTS interest TEXT;
ALTER TABLE downloads ADD COLUMN IF NOT EXISTS note TEXT;

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

-- News CMS 拡張 (tags / focus keyword / views)
ALTER TABLE posts ADD COLUMN IF NOT EXISTS tags          TEXT;   -- カンマ区切り
ALTER TABLE posts ADD COLUMN IF NOT EXISTS focus_keyword TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS views         BIGINT NOT NULL DEFAULT 0;
ALTER TABLE posts ALTER COLUMN author SET DEFAULT 'BIGLIGHT編集部';

-- カテゴリ (管理画面から追加可能)
CREATE TABLE IF NOT EXISTS categories (
  id         BIGSERIAL PRIMARY KEY,
  slug       TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  sort       INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO categories(slug,name,sort) VALUES
  ('news','お知らせ',1),
  ('magazine','HR Magazine',2),
  ('seido','制度・法改正情報',3)
ON CONFLICT (slug) DO NOTHING;
