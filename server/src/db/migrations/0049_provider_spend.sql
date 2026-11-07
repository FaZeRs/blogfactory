-- Instance-wide monthly spend on a paid provider (DataForSEO), shared by the API and the worker so the monthly cap survives restarts.
-- Not tenant data: the provider credentials and the cap are instance settings.
CREATE TABLE IF NOT EXISTS provider_spend (
  provider TEXT NOT NULL,
  month TEXT NOT NULL,
  usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, month)
);
