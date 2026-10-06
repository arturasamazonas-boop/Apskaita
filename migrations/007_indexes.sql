-- Indexes for drill-down joins and settlement lookups (measured in docs/PERFORMANCE.md).
CREATE INDEX invoices_journal_entry_idx ON invoices(journal_entry_id);
CREATE INDEX allocations_journal_entry_idx ON allocations(journal_entry_id);
CREATE INDEX journal_lines_account_entry_idx ON journal_lines(account_code, entry_id);
CREATE INDEX invoice_vat_rows_invoice_idx ON invoice_vat_rows(invoice_id);
