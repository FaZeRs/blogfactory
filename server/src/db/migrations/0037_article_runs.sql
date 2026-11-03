-- Staged blog engine: one durable run per normal/deep article, with per-stage audit rows.
-- Child tables carry user_id (queries filter run_id AND user_id); only article_runs stores site_id.
CREATE TABLE IF NOT EXISTS article_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  post_id UUID REFERENCES posts(id) ON DELETE SET NULL,
  preferred_integration_id UUID REFERENCES site_integrations(id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK (mode IN ('normal', 'deep')),
  source_type TEXT NOT NULL,
  topic TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'en',
  settings JSONB NOT NULL, -- frozen preset + models + citation style at start
  current_stage TEXT NOT NULL DEFAULT 'research',
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'waiting_human', 'done', 'failed', 'escalated')),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 0,
  revise_count INTEGER NOT NULL DEFAULT 0,
  budget_usd REAL NOT NULL,
  spent_usd REAL NOT NULL DEFAULT 0,
  state_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS article_runs_claim_idx ON article_runs (next_attempt_at) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS article_runs_user_site_idx ON article_runs (user_id, site_id, created_at DESC);

CREATE TABLE IF NOT EXISTS article_stage_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES article_runs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'reused')),
  input_hash TEXT,
  model TEXT,
  prompt_version TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_usd REAL NOT NULL DEFAULT 0,
  output JSONB,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE (run_id, stage, attempt)
);

CREATE INDEX IF NOT EXISTS article_stage_runs_reuse_idx ON article_stage_runs (run_id, stage, input_hash) WHERE status = 'succeeded';

CREATE TABLE IF NOT EXISTS article_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES article_runs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  final_url TEXT,
  fetched_via TEXT,
  http_status INTEGER,
  text_length INTEGER,
  title TEXT,
  markdown TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS article_sources_run_idx ON article_sources (run_id, user_id);

CREATE TABLE IF NOT EXISTS article_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES article_runs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES article_sources(id) ON DELETE CASCADE,
  claim TEXT NOT NULL,
  quote TEXT NOT NULL,
  kind TEXT,
  verified BOOLEAN NOT NULL DEFAULT false,
  method TEXT CHECK (method IN ('exact', 'windowed')),
  ratio REAL,
  reason TEXT
);

CREATE INDEX IF NOT EXISTS article_evidence_run_idx ON article_evidence (run_id, user_id);

CREATE TABLE IF NOT EXISTS article_gate_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES article_runs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL DEFAULT 1,
  gate TEXT NOT NULL,
  passed BOOLEAN NOT NULL,
  severity TEXT,
  issues JSONB NOT NULL DEFAULT '[]'::JSONB,
  metrics JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS article_gate_results_run_idx ON article_gate_results (run_id, user_id);

ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS engine_settings JSONB;
