import { describe, it, expect } from 'vitest';
import { villaBookingSchema, villaBookingTotal } from './villa';
const valid = {
  useKind: 'pool',
  startsAt: '2026-10-17T10:00:00+05:30',
  endsAt: '2026-10-17T12:00:00+05:30',
  guestCount: 50,
  price: '1000.50',
  gstPercent: '5',
  guest: { firstName: 'Visitor', mobile: '9876543210' },
};
describe('villa booking rules', () => {
  it('accepts manual pool visitor counts and a same-day time slot', () => {
    expect(villaBookingSchema.safeParse(valid).success).toBe(true);
  });
  it('requires a positive time range and an explicit valid GST percentage', () => {
    expect(villaBookingSchema.safeParse({ ...valid, endsAt: valid.startsAt }).success).toBe(false);
    expect(villaBookingSchema.safeParse({ ...valid, gstPercent: '101' }).success).toBe(false);
    expect(villaBookingSchema.safeParse({ ...valid, gstPercent: '' }).success).toBe(false);
  });
  it('rounds the estimate the same way as the final invoice', () => {
    expect(villaBookingTotal('1000.50', '5')).toBe('1051.00');
    expect(villaBookingTotal('1250', '18')).toBe('1475.00');
    expect(villaBookingTotal('4000', '5', 2)).toBe('8400.00');
  });
});
