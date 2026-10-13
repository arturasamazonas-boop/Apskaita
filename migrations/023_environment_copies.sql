-- Copies of the main environment's data into a test environment (e.g. /ieva). One row per copy tag, so a requested
-- copy runs once. Not copied or truncated by the copy itself.
CREATE TABLE environment_copies (
  tag text PRIMARY KEY,
  source text NOT NULL DEFAULT 'main',
  copied_at timestamptz NOT NULL DEFAULT now(),
  tables int NOT NULL DEFAULT 0,
  rows bigint NOT NULL DEFAULT 0
);
