-- One idea per booked slot; the guard against double booking under concurrent approvals.
CREATE UNIQUE INDEX IF NOT EXISTS ideas_site_slot_unique_idx ON ideas (site_id, scheduled_for)
  WHERE scheduled_for IS NOT NULL AND status IN ('approved', 'scheduled', 'in_progress', 'drafted');
