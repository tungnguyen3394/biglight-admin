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
ALTER TABLE downloads ADD COLUMN IF NOT EXISTS sent_at   TIMESTAMPTZ;   -- lần gần nhất gửi tài liệu qua mail
ALTER TABLE downloads ADD COLUMN IF NOT EXISTS sent_note TEXT;          -- tài liệu đã gửi (tên, phân cách bằng , )

-- 資料 (tài liệu đính kèm gửi cho khách 資料請求)
CREATE TABLE IF NOT EXISTS materials (
  id          BIGSERIAL PRIMARY KEY,
  category    TEXT,                          -- tên phân loại tài liệu
  name        TEXT NOT NULL,                 -- tên hiển thị tài liệu
  filename    TEXT,                          -- tên file thật trên đĩa (mat-<id>.<ext>)
  file_url    TEXT,                          -- link công khai biglight.jp/assets/materials/...
  link_url    TEXT,                          -- link ngoài (Google Drive, v.v.)
  size        BIGINT,                        -- dung lượng file (byte)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mat_created ON materials(created_at DESC);

-- ============ 営業メール管理 (Sales Email Center) ============
-- テンプレート
CREATE TABLE IF NOT EXISTS mail_templates (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  category     TEXT DEFAULT 'その他',
  subject      TEXT,
  body         TEXT,
  signature_id BIGINT,
  attach_ids   TEXT,                          -- JSON mảng id materials
  favorite     BOOLEAN NOT NULL DEFAULT false,
  created_by   TEXT,
  last_used    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 署名
CREATE TABLE IF NOT EXISTS mail_signatures (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  body       TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 送信履歴
CREATE TABLE IF NOT EXISTS mail_logs (
  id             BIGSERIAL PRIMARY KEY,
  sender         TEXT,
  to_email       TEXT,
  to_name        TEXT,
  recipient_kind TEXT,                         -- download | inquiry | manual
  recipient_id   BIGINT,
  subject        TEXT,
  template_id    BIGINT,
  template_name  TEXT,
  status         TEXT DEFAULT '送信',
  att            TEXT,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mlog_created ON mail_logs(created_at DESC);
-- 下書き
CREATE TABLE IF NOT EXISTS mail_drafts (
  id            BIGSERIAL PRIMARY KEY,
  recipient_key TEXT,                          -- "kind:id"
  subject       TEXT,
  body          TEXT,
  template_id   BIGINT,
  attach_ids    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- meta (danh mục template / danh mục tài liệu…)
CREATE TABLE IF NOT EXISTS mail_meta (
  key TEXT PRIMARY KEY,
  val JSONB
);
INSERT INTO mail_meta(key,val) VALUES
  ('tpl_cats','["新規営業","お礼メール","アポイント依頼","資料送付","見積送付","契約後フォロー","定期フォロー","その他"]'::jsonb),
  ('file_cats','["会社案内","候補者名簿","履歴書","営業資料","提案書","その他"]'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ============ ユーザー管理 (profiles) + 権限 ============
CREATE TABLE IF NOT EXISTS profiles (
  email        TEXT PRIMARY KEY,
  name         TEXT,
  picture      TEXT,
  role         TEXT NOT NULL DEFAULT 'viewer',   -- admin | manager | staff | viewer
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | active | disabled
  mail_enabled BOOLEAN NOT NULL DEFAULT false,
  gas_url      TEXT,
  last_login   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- cấu hình chung (ma trận quyền theo role…)
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  val JSONB
);
-- ロール別 権限: {app:{create,edit,del}}. viewer=全false, admin=常に全true(コード側)
INSERT INTO app_meta(key,val) VALUES
  ('role_perms','{
    "manager":{"inquiries":{"create":true,"edit":true,"del":true},"downloads":{"create":true,"edit":true,"del":true},"posts":{"create":true,"edit":true,"del":true},"salesmail":{"create":true,"edit":true,"del":true}},
    "staff":{"inquiries":{"create":false,"edit":true,"del":false},"downloads":{"create":false,"edit":true,"del":false},"posts":{"create":true,"edit":true,"del":false},"salesmail":{"create":true,"edit":true,"del":true}},
    "viewer":{"inquiries":{"create":false,"edit":false,"del":false},"downloads":{"create":false,"edit":false,"del":false},"posts":{"create":false,"edit":false,"del":false},"salesmail":{"create":false,"edit":false,"del":false}}
  }'::jsonb)
ON CONFLICT (key) DO NOTHING;

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

-- SEO標準エディタ 拡張フィールド
ALTER TABLE posts ADD COLUMN IF NOT EXISTS seo_title        TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS subcategory      TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS sub_keyword      TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS related_keywords TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS canonical_url    TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS robots_index     BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS robots_follow    BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS cover_alt        TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS cover_caption    TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS cover_title      TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS lazy_load        BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS og_title         TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS og_description   TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS og_image         TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS faq              JSONB;   -- [{q,a}]
ALTER TABLE posts ADD COLUMN IF NOT EXISTS cta_blocks       JSONB;   -- [{type,label,url}]
ALTER TABLE posts ADD COLUMN IF NOT EXISTS jsonld_types     JSONB;   -- {article,faq,breadcrumb,organization,video,howto}
ALTER TABLE posts ADD COLUMN IF NOT EXISTS related_articles TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS related_category TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS download_pdf     TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS consult_block    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS pinned           BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS featured         BOOLEAN NOT NULL DEFAULT false;

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
