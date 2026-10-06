-- Optional database file storage (STORAGE_BACKEND=postgres) for hosts without a persistent disk.
-- Content-addressed and write-once, like the disk backend.
CREATE TABLE file_blobs (
  storage_key text PRIMARY KEY CHECK (storage_key ~ '^[a-f0-9]{2}/[a-f0-9]{64}$'),
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER file_blobs_immutable BEFORE UPDATE OR DELETE ON file_blobs
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
