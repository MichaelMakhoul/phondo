-- Lead Discovery & Lead Qualification Tool (SCRUM-140)
-- Two tables: search cache (avoid repeat Google Places API costs) and discovered businesses

-- ── Search cache ─────────────────────────────────────────────────────
CREATE TABLE lead_search_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_hash TEXT NOT NULL UNIQUE,
  location TEXT NOT NULL,
  professions TEXT[] NOT NULL,
  result_count INTEGER NOT NULL DEFAULT 0,
  google_response JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_lead_search_cache_hash ON lead_search_cache(query_hash);
CREATE INDEX idx_lead_search_cache_expires ON lead_search_cache(expires_at);

ALTER TABLE lead_search_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lead_search_cache_service_role" ON lead_search_cache
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── Discovered businesses ────────────────────────────────────────────
CREATE TABLE discovered_businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_place_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  website TEXT,
  google_rating NUMERIC(2,1),
  google_review_count INTEGER,
  google_types TEXT[],
  profession TEXT,
  detected_crm TEXT,            -- null = not scanned, 'none' = scanned but nothing found
  detected_crm_details JSONB,   -- { software, confidence, signals[] }
  website_scanned_at TIMESTAMPTZ,
  website_scan_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_discovered_biz_place_id ON discovered_businesses(google_place_id);
CREATE INDEX idx_discovered_biz_profession ON discovered_businesses(profession);
CREATE INDEX idx_discovered_biz_crm ON discovered_businesses(detected_crm);
CREATE INDEX idx_discovered_biz_location ON discovered_businesses USING gin (to_tsvector('english', coalesce(address, '')));

ALTER TABLE discovered_businesses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "discovered_businesses_service_role" ON discovered_businesses
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
