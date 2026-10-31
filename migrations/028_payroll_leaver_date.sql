-- A leaver's pay date set by the program follows the employee's end date; one chosen by the user stays as chosen.
ALTER TABLE payroll_lines ADD COLUMN payment_date_manual boolean NOT NULL DEFAULT false;
