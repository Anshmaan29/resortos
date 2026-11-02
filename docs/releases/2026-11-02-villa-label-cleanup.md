# Villa Sol wording and owner-authorised test cleanup

The booking choice previously labelled **2 rooms** is now **Whole villa**, including on historical booking views. Internal `both_bedrooms` / legacy `whole_villa` values, room masks, agreed prices, dates, tax and allocation rules are unchanged. Legacy edit forms offer one Whole villa option. Future message rendering uses the same wording; previously sent messages are never rewritten or resent.

## Scoped operator correction

The owner explicitly authorised permanent removal of the two checked-out Anshmaan test bookings and all their linked test records. The owner separately chose to renumber only the **confirmed** Manas booking from BK-000004 to BK-000001. The cancelled Manas booking and all other real booking references remain unchanged. The reservation/payment/reference counters are preserved; the next booking remains BK-000007.

This is a one-off migration-role operation, not an application endpoint, startup migration or ordinary deletion capability. The exact private manifest, encrypted database/object recovery copies, operator scripts and verification evidence are held outside the repository. No credentials, document contents or guest contact details are included here.

The manifest includes two test invoices and payments, two stays, two exclusive test guest records, five private test documents, and their dependent rows. Only the test-only invoice series is returned to its empty state; that step refuses to run if any real invoice exists in that series. Other document/reference counters and real payments are protected. Append-only audit history remains intact, with a cleanup record containing identifiers and counts. Provider copies of previously delivered emails/messages cannot be recalled by deleting application records.

## Safety and verification

- Fresh AES-256-GCM encrypted database backup; independent PostgreSQL 18 restore verified all 68 public tables and 2,067 rows.
- Private document backup verified each stored SHA-256 before cleanup.
- Restore rehearsal rejects stale row hashes, yields to an existing writer, tests rollback after deletion, verifies trigger restoration, commit, and repeat safety.
- Per-table protected-row fingerprints compare all records outside the deletion manifest. The confirmed Manas record permits only its reference and normal version/update timestamp changes.
- Foreign keys remain enabled. Only specific deletion-protection triggers and the test-only invoice-counter guard are suspended transactionally and restored before commit. Runtime grants remain unchanged.
- Audit-chain verification and all restore integrity checks pass. Future numbering is checked inside a rolled-back transaction.
- Whole-villa allocation, conflicts, room lifecycle, payments, checkout, isolation, messages, desktop and phone browser flows are covered by regression checks.

The live cleanup is applied only after the same manifest passes the restore rehearsal. Verification requires exact deployment confirmation and fresh live read-only checks, including absence of the test rows, preserved real booking references/payments, restored triggers and no queued guest messages from this operation. Laxmi Palace is excluded from all mutations.
