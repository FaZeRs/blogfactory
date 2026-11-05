-- Weekly AI answer checks: one row per site, ISO week, engine and question.
CREATE TABLE IF NOT EXISTS ai_answer_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  week TEXT NOT NULL,
  question TEXT NOT NULL,
  question_hash TEXT NOT NULL,
  engine TEXT NOT NULL,
  engine_label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'failed')),
  error TEXT,
  answer TEXT,
  cited BOOLEAN NOT NULL DEFAULT false,
  cited_urls TEXT[] NOT NULL DEFAULT '{}',
  mentioned BOOLEAN NOT NULL DEFAULT false,
  other_hosts TEXT[] NOT NULL DEFAULT '{}',
  competitor_hosts TEXT[] NOT NULL DEFAULT '{}',
  cost_usd REAL NOT NULL DEFAULT 0,
  asked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_answer_checks_unique_idx ON ai_answer_checks (site_id, week, engine, question_hash);
CREATE INDEX IF NOT EXISTS ai_answer_checks_site_idx ON ai_answer_checks (user_id, site_id, week);

ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ai_visibility JSONB;
-- Set while a run is active (cleared when it ends); a value older than 30 minutes is stale.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS ai_visibility_run_started_at TIMESTAMPTZ;
