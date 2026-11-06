-- Localized versions of a post, one row per locale, made from a specific post revision.
CREATE TABLE IF NOT EXISTS post_translations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  image_alt TEXT NOT NULL DEFAULT '',
  keyword TEXT,
  -- ready, needs_review, edited, or running while a translation is being made.
  status TEXT NOT NULL DEFAULT 'needs_review' CHECK (status IN ('ready', 'needs_review', 'edited', 'running')),
  findings JSONB NOT NULL DEFAULT '[]',
  source_revision_id UUID REFERENCES post_revisions(id) ON DELETE SET NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS post_translations_post_locale_idx ON post_translations (post_id, locale);
CREATE INDEX IF NOT EXISTS post_translations_site_idx ON post_translations (user_id, site_id);

ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS localization JSONB;
