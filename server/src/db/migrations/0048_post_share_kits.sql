-- One share kit per post: ready-to-post social copy written from the post on request. Never published by BlogFactory.
CREATE TABLE IF NOT EXISTS post_share_kits (
  post_id UUID PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kit JSONB NOT NULL,
  -- A hash of the post's title and content when the kit was written, so the page can say it is out of date.
  content_hash TEXT NOT NULL,
  model_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS post_share_kits_user_idx ON post_share_kits (user_id);
