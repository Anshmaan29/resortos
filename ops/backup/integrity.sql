-- Integrity checks run against a *restored* database (spec §55, §53.5).
--
-- Every row this returns is a finding. An empty result is a pass. Findings are never repaired here:
-- the point of a restore test is to learn the truth about the backup, and a script that quietly
-- fixed things would hide exactly what it exists to reveal (§55).
--
-- Money checks (payments, shifts, invoices) arrived with Phase 2 and sit at the end.

SELECT * FROM (
  -- The audit chain is the record that says what happened. If it does not verify in the restore,
  -- the restore is not evidence of anything.
  SELECT 'audit_chain' AS check_name,
         p.name AS subject,
         'hash chain does not verify from position ' || (v).first_bad_position::text AS finding
    FROM properties p, LATERAL (SELECT verify_audit_chain(p.id) AS v) x
   WHERE NOT (v).ok

  UNION ALL
  -- Should be impossible: it is an exclusion constraint. Verified anyway, because the whole purpose
  -- of a restore test is to check that the constraints came back with the data.
  SELECT 'overlapping_allocations',
         'rooms ' || a.room_id::text,
         'two live allocations overlap on ' || (a.start_date)::text
    FROM room_allocations a
    JOIN room_allocations b
      ON b.room_id = a.room_id AND b.id <> a.id
     AND daterange(a.start_date, a.end_date, '[)') && daterange(b.start_date, b.end_date, '[)')
   WHERE a.status IN ('reserved', 'checked_in') AND b.status IN ('reserved', 'checked_in')

  UNION ALL
  -- Every guest in house is in a room, and that room is not simultaneously free for somebody else.
  SELECT 'stay_without_allocation',
         'stay ' || s.id::text,
         'in house with no live room allocation'
    FROM stays s
   WHERE s.status = 'in_house'
     AND NOT EXISTS (SELECT 1 FROM room_allocations a
                      WHERE a.reservation_room_id = s.reservation_room_id AND a.status = 'checked_in')

  UNION ALL
  -- A registration card whose stored bytes no longer hash to what was recorded would mean the
  -- document store and the database disagree; here we can only check the row is internally sound.
  SELECT 'grc_version_chain',
         'card ' || g.number,
         'version ' || g.version::text || ' does not point at a previous version'
    FROM grc_documents g
   WHERE g.version > 1 AND g.supersedes_id IS NULL

  UNION ALL
  -- One night audit per business date, and no gaps: a missing date means a day nobody closed.
  SELECT 'night_audit_gap',
         p.name,
         'no night audit for ' || d::text || ', though later dates were closed'
    FROM properties p
    CROSS JOIN LATERAL (
      SELECT generate_series(min(business_date), max(business_date), interval '1 day')::date AS d
        FROM night_audits WHERE property_id = p.id
    ) days
   WHERE NOT EXISTS (SELECT 1 FROM night_audits na WHERE na.property_id = p.id AND na.business_date = days.d)

  UNION ALL
  -- The business date must never be behind a date that has been closed.
  SELECT 'business_date_behind',
         p.name,
         'business date ' || p.current_business_date::text || ' is not after the last closed date'
    FROM properties p
   WHERE EXISTS (SELECT 1 FROM night_audits na WHERE na.property_id = p.id AND na.business_date >= p.current_business_date)

  UNION ALL
  -- GST requires consecutive numbers per series and financial year (§31). A gap in a restored
  -- database means an invoice was lost, which is exactly what a backup must never do.
  SELECT 'invoice_number_gap',
         i.series || ' ' || i.financial_year,
         'numbers run to ' || max(i.seq)::text || ' but only ' || count(*)::text || ' documents exist'
    FROM invoices i
   GROUP BY i.property_id, i.series, i.financial_year
  HAVING max(i.seq) <> count(*)

  UNION ALL
  -- Every invoice adds up: header against its lines. (Checked at commit when it was written; checked
  -- again here because a restore is only evidence if the numbers came back with it.)
  SELECT 'invoice_totals',
         i.number,
         'lines add up to ' || COALESCE(sum(l.taxable_value), 0)::text || ', header says ' || i.taxable_total::text
    FROM invoices i LEFT JOIN invoice_lines l ON l.invoice_id = i.id
   GROUP BY i.id, i.number, i.taxable_total
  HAVING COALESCE(sum(l.taxable_value), 0) <> i.taxable_total

  UNION ALL
  -- A counter behind the documents it numbered would hand out a duplicate on the next invoice.
  SELECT 'document_counter_behind',
         c.series || ' ' || c.financial_year,
         'counter at ' || c.last_number::text || ' but documents go to ' || max(i.seq)::text
    FROM document_counters c
    JOIN invoices i ON i.property_id = c.property_id AND i.series = c.series AND i.financial_year = c.financial_year
   GROUP BY c.property_id, c.series, c.financial_year, c.last_number
  HAVING max(i.seq) > c.last_number

  UNION ALL
  -- A reversal undoes exactly what it reverses.
  SELECT 'reversal_mismatch',
         r.number,
         'does not match ' || o.number || ', which it reverses'
    FROM payments r JOIN payments o ON o.id = r.reverses_payment_id
   WHERE (r.amount, r.method, r.entry_type, r.payment_account_id) IS DISTINCT FROM (o.amount, o.method, o.entry_type, o.payment_account_id)

  UNION ALL
  -- A closed shift was judged against figures its payments must still add up to.
  SELECT 'shift_expected_mismatch',
         'shift ' || s.id::text,
         'closed against ' || s.expected_cash::text || ' cash, payments now add up to ' || calc.cash::text
    FROM cashier_shifts s
    CROSS JOIN LATERAL (
      SELECT (s.opening_cash + COALESCE(sum(l.amount) FILTER (WHERE a.kind = 'cash'), 0))::numeric(14,2) AS cash
        FROM account_ledger l JOIN payment_accounts a ON a.id = l.account_id
       WHERE l.cashier_shift_id = s.id
    ) calc
   WHERE s.closed_at IS NOT NULL AND calc.cash <> s.expected_cash
) findings
ORDER BY check_name, subject;
