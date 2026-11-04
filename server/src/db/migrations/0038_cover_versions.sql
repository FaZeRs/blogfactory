ALTER TABLE image_generation_requests
  ADD COLUMN IF NOT EXISTS reference_path TEXT,
  ADD COLUMN IF NOT EXISTS replaces_cover TEXT;
