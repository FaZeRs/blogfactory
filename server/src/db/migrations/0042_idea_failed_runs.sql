-- Terminal run failures per idea; the scheduler stops retrying at 3.
ALTER TABLE ideas ADD COLUMN IF NOT EXISTS failed_runs integer NOT NULL DEFAULT 0;
