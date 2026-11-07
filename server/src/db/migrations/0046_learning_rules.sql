-- Learned style rules: the owner's corrections (signals), the rules distilled from them, and the per-site switch.
CREATE TABLE IF NOT EXISTS learning_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  -- NULL for the English article.
  locale TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('edit', 'comment')),
  payload JSONB NOT NULL DEFAULT '{}',
  -- The UTC day, so an edit is stored once per post, locale and day (the latest diff replaces the earlier one).
  day DATE NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS learning_signals_site_idx ON learning_signals (user_id, site_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS learning_signals_edit_day_idx ON learning_signals (post_id, COALESCE(locale, ''), day) WHERE kind = 'edit';

CREATE TABLE IF NOT EXISTS style_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  -- 'draft' or 'translation:<locale>'.
  scope TEXT NOT NULL,
  rule TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  op TEXT NOT NULL DEFAULT 'add' CHECK (op IN ('add', 'retire')),
  target_rule_id UUID REFERENCES style_rules(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected', 'retired')),
  evidence JSONB NOT NULL DEFAULT '[]',
  eval JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS style_rules_site_status_idx ON style_rules (user_id, site_id, status);

ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS learning JSONB;
-- What the engine wrote, kept so a person's later edit can be diffed against it.
ALTER TABLE post_translations ADD COLUMN IF NOT EXISTS engine_content TEXT;
