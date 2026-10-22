import { describe, expect, it } from 'vitest';
import { uniqueReturningGuest } from '../src/lib/returning-guest';

describe('returning guest autofill', () => {
  const guest = { id: 'one', mobile: '+919829066611', fullName: 'Returning Visitor' };
  it('recognises a full mobile with or without country code', () => {
    expect(uniqueReturningGuest([guest], '9829066611')).toBe(guest);
    expect(uniqueReturningGuest([guest], '+91 98290 66611')).toBe(guest);
  });
  it('does not guess from partial numbers, names or shared numbers', () => {
    expect(uniqueReturningGuest([guest], '66611')).toBeUndefined();
    expect(uniqueReturningGuest([guest], 'Returning Visitor')).toBeUndefined();
    expect(uniqueReturningGuest([guest, { ...guest, id: 'two' }], '9829066611')).toBeUndefined();
    expect(uniqueReturningGuest([guest], '9829066611', 'Different Person')).toBeUndefined();
  });
});
