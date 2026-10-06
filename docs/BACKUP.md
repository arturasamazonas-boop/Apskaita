# Backup and restoration

Both parts are required: the **PostgreSQL database** and the **file storage directory** (`STORAGE_DIR/objects`).

## Backup

```bash
DATABASE_URL=... STORAGE_DIR=... npm run backup -- /secure/backups
```

The script creates `/secure/backups/apskaita-<timestamp>/` containing:

- `database.dump`: `pg_dump --format=custom --no-owner --no-privileges`
- `files.tar.gz`: the `objects/` tree
- `manifest.json`: SHA-256 and size of both files, the object count, and the creation time.

The database is dumped **before** the files. Stored files are write-once and never deleted, so every file referenced in the dump is in the archive. Files added during the backup are harmless extras.

**Recommendations:**

- Run nightly from cron or a systemd timer, and copy the result off-host (encrypted object storage).
- Keep several generations.
- Test a restore regularly. A volume snapshot of both paths taken at the same moment is an acceptable alternative.

## Restoration (tested procedure)

1. Create an **empty** database and an **empty** storage directory:

   ```bash
   createdb apskaita_restored
   mkdir -p /var/lib/apskaita/storage-restored
   ```

2. Restore and verify:

   ```bash
   DATABASE_URL=postgres://.../apskaita_restored STORAGE_DIR=/var/lib/apskaita/storage-restored npm run restore -- /secure/backups/apskaita-<timestamp>
   ```

   The restore script:

   - checks both files against the manifest checksums;
   - refuses a non-empty target database or storage directory;
   - runs `pg_restore --exit-on-error` and extracts the files;
   - **verifies** that every `stored_files` row has its object and that the SHA-256 matches;
   - checks that all journal entries balance;
   - prints row counts.

   It exits with code 2 when a problem is found.

3. Point `DATABASE_URL` and `STORAGE_DIR` at the restored copies and start the app. Migrations are already applied and are skipped.

## What was tested

`test/07-backup.test.mjs` (executed, passing) covers:

- posting an OCR'd invoice and storing a contract;
- backup, then the integrity check on the source;
- restoring into a fresh database `apskaita_restore_test` and a new directory;
- comparing counts with the source;
- refusal to restore over a non-empty target;
- detection of a tampered archive;
- starting the application on the restored copy and reading the original invoice bytes (byte-identical), with the ledger balanced.

A restore onto a separate host was not tested.
