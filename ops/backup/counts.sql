-- The row counts and totals a restore is compared against (spec §53.5).
-- Kept deliberately small and stable: these are the things whose loss would be noticed.
SELECT json_build_object(
  'properties',        (SELECT count(*) FROM properties),
  'users',             (SELECT count(*) FROM users),
  'guests',            (SELECT count(*) FROM guests),
  'reservations',      (SELECT count(*) FROM reservations),
  'reservation_rooms', (SELECT count(*) FROM reservation_rooms),
  'room_allocations',  (SELECT count(*) FROM room_allocations),
  'stays',             (SELECT count(*) FROM stays),
  'guest_documents',   (SELECT count(*) FROM guest_documents),
  'grc_documents',     (SELECT count(*) FROM grc_documents),
  'night_audits',      (SELECT count(*) FROM night_audits),
  'audit_logs',        (SELECT count(*) FROM audit_logs),
  'outbox_events',     (SELECT count(*) FROM outbox_events),
  'nightly_rate_total',(SELECT coalesce(sum(nightly_rate), 0)::text FROM reservation_rooms),
  'room_night_total',  (SELECT coalesce(sum(room_rate + extra_person_amount + meal_amount), 0)::text FROM reservation_room_nights)
) AS counts;
