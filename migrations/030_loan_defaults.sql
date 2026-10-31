-- New loans: actual/actual (365 or 366) with the repayment day included, as Lithuanian interest statements count.
ALTER TABLE loans ALTER COLUMN basis SET DEFAULT 'actact';
ALTER TABLE loans ALTER COLUMN include_last_day SET DEFAULT true;
