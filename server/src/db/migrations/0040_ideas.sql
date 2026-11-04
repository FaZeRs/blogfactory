CREATE TABLE IF NOT EXISTS idea_discoveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  signal_count INTEGER NOT NULL DEFAULT 0,
  idea_count INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idea_discoveries_status_idx ON idea_discoveries (status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idea_discoveries_one_active_idx ON idea_discoveries (site_id) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idea_discoveries_site_idx ON idea_discoveries (user_id, site_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ideas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'approved', 'scheduled', 'in_progress', 'drafted', 'rejected', 'archived')),
  title TEXT NOT NULL,
  angle TEXT,
  primary_keyword TEXT,
  alternate_keywords TEXT[] NOT NULL DEFAULT '{}',
  search_intent TEXT,
  audience_question TEXT,
  brief JSONB NOT NULL DEFAULT '{}'::JSONB,
  score REAL,
  score_breakdown JSONB,
  origin TEXT NOT NULL DEFAULT 'discovered' CHECK (origin IN ('discovered', 'manual', 'refresh')),
  discovery_id UUID REFERENCES idea_discoveries(id) ON DELETE SET NULL,
  mode TEXT NOT NULL DEFAULT 'normal' CHECK (mode IN ('normal', 'deep')),
  scheduled_for TIMESTAMPTZ,
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  post_id UUID REFERENCES posts(id) ON DELETE SET NULL,
  rejected_reason TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ideas_user_site_status_idx ON ideas (user_id, site_id, status);
CREATE INDEX IF NOT EXISTS ideas_site_scheduled_idx ON ideas (site_id, scheduled_for);

ALTER TABLE posts ADD COLUMN IF NOT EXISTS publish_at TIMESTAMPTZ;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS idea_settings JSONB;
