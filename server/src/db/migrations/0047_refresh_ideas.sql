-- Refresh ideas: an idea may point at an existing post that should be re-drafted instead of a new article.
ALTER TABLE ideas ADD COLUMN IF NOT EXISTS refresh_post_id UUID REFERENCES posts(id) ON DELETE SET NULL;
ALTER TABLE ideas ADD COLUMN IF NOT EXISTS refresh_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_ideas_refresh_post ON ideas (user_id, site_id, refresh_post_id);
