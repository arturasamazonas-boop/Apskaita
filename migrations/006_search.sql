-- Trigram indexes for substring search on titles and reference numbers (e.g. "ST-2026").
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX documents_title_trgm ON documents USING gin (title gin_trgm_ops);
CREATE INDEX documents_ref_trgm ON documents USING gin (reference_number gin_trgm_ops);
