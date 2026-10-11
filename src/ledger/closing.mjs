// Year-end closing (metų uždarymas): income and expense accounts (classes 5 and 6) are closed into 341 at the year end,
// and the year's result is moved from 341 to 342 at the start of the next year.
// A closing entry moves the result, it is not income or expense: the profit (loss) statement leaves such entries out,
// whether posted by this module ('year_close') or by hand (an entry touching only 5/6 and 34x/390 accounts).

/** SQL condition on journal_entries `e`: true for entries that are not closing entries. */
export const NOT_CLOSING = `e.source_type <> 'year_close' AND e.id NOT IN (SELECT entry_id FROM journal_lines GROUP BY entry_id
  HAVING bool_and(account_code ~ '^(5|6|34|390)') AND bool_or(account_code ~ '^[56]') AND bool_or(account_code ~ '^(34|390)'))`;
