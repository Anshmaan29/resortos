import { describe, expect, it } from 'vitest';
import { formatDate, formatINR, formatINRCompact, groupIndian, maskMobile } from './format';
import { money, round2, roundRupee, toMoneyString } from './money';
import { addDays, eachNight, financialYearLabel, isIsoDate, nightsBetween } from './dates';
import {
  aadhaarLast4, gstinCheckChar, isValidGstin, isValidIndianVehicleNumber, isValidPinCode, normalizeIndianMobile,
} from './validators';
import { formatDocumentNumber } from './numbering';
import { canTransition, roomDisplayState, isSellable } from './domain';
import { createReservationSchema, zMobile } from './schemas';

describe('money', () => {
  it('rejects garbage', () => {
    expect(() => money('12abc')).toThrow();
    expect(() => money('')).toThrow();
  });
  it('rounds half-up', () => {
    expect(toMoneyString('2.345')).toBe('2.35');
    expect(round2('-2.345').toFixed(2)).toBe('-2.35');
    expect(roundRupee('12882.50').toFixed(0)).toBe('12883');
  });
});

describe('Indian formatting', () => {
  it('groups digits the Indian way', () => {
    expect(groupIndian('112000')).toBe('1,12,000');
    expect(groupIndian('12345678')).toBe('1,23,45,678');
    expect(groupIndian('999')).toBe('999');
  });
  it('formats rupees', () => {
    expect(formatINR('112000')).toBe('₹1,12,000');
    expect(formatINR('12882', { paise: true })).toBe('₹12,882.00');
    expect(formatINR('-5000')).toBe('−₹5,000');
    expect(formatINR('4850.5')).toBe('₹4,850.50');
    expect(formatINRCompact('1460000')).toBe('₹14.6L');
  });
  it('formats dates', () => {
    expect(formatDate('2026-09-16')).toBe('16 Sep 2026');
    expect(formatDate('2026-09-16', { weekday: true, year: false })).toBe('Wed 16 Sep');
  });
  it('masks mobiles', () => {
    expect(maskMobile('+919876543210')).toBe('••••••3210');
  });
});

describe('dates', () => {
  it('validates real calendar dates only', () => {
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
  });
  it('counts nights and crosses months', () => {
    expect(nightsBetween('2026-09-16', '2026-09-18')).toBe(2);
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(eachNight('2026-12-31', '2027-01-02')).toEqual(['2026-12-31', '2027-01-01']);
  });
  it('labels Indian financial years', () => {
    expect(financialYearLabel('2026-04-01')).toBe('26-27');
    expect(financialYearLabel('2027-03-31')).toBe('26-27');
    expect(financialYearLabel('2099-12-01')).toBe('99-00');
  });
});

describe('validators', () => {
  it('normalises Indian mobiles', () => {
    expect(normalizeIndianMobile('98765 43210')).toBe('+919876543210');
    expect(normalizeIndianMobile('+91-98765-43210')).toBe('+919876543210');
    expect(normalizeIndianMobile('09876543210')).toBe('+919876543210');
    expect(normalizeIndianMobile('5876543210')).toBeNull();
    expect(normalizeIndianMobile('98765')).toBeNull();
  });
  it('accepts foreign E.164 numbers through the schema', () => {
    expect(zMobile.parse('+44 7911 123456')).toBe('+447911123456');
  });
  it('validates GSTIN checksum', () => {
    const body = '08AABCU9603R1Z';
    const valid = body + gstinCheckChar(body);
    expect(isValidGstin(valid)).toBe(true);
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true);
    const wrong = body + (valid.endsWith('A') ? 'B' : 'A');
    expect(isValidGstin(wrong)).toBe(false);
    expect(isValidGstin('99ZZZZZ0000Z1Z0')).toBe(false);
  });
  it('validates PIN codes, vehicles, Aadhaar last 4', () => {
    expect(isValidPinCode('302001')).toBe(true);
    expect(isValidPinCode('012345')).toBe(false);
    expect(isValidIndianVehicleNumber('RJ 14 CX 1234')).toBe(true);
    expect(isValidIndianVehicleNumber('22BH1234AA')).toBe(true);
    expect(isValidIndianVehicleNumber('HELLO')).toBe(false);
    expect(aadhaarLast4('1234 5678 9012')).toBe('9012');
  });
});

describe('document numbering', () => {
  it('fits the 16-character GST limit', () => {
    expect(formatDocumentNumber('INV', '26-27', 152)).toBe('INV/26-27/00152');
    expect(() => formatDocumentNumber('INV', '26-27', 0)).toThrow();
  });
});

describe('domain rules', () => {
  it('only allows valid reservation transitions', () => {
    expect(canTransition('confirmed', 'checked_in')).toBe(true);
    expect(canTransition('checked_out', 'checked_in')).toBe(false);
    expect(canTransition('cancelled', 'confirmed')).toBe(false);
  });
  it('derives sellable and display state', () => {
    expect(isSellable('vacant', 'inspected', 'in_service')).toBe(true);
    expect(isSellable('vacant', 'dirty', 'in_service')).toBe(false);
    expect(roomDisplayState('occupied', 'dirty', 'out_of_order')).toBe('out_of_order');
    expect(roomDisplayState('vacant', 'clean', 'in_service')).toBe('ready');
  });
});

describe('reservation schema', () => {
  const base = {
    guest: { firstName: 'Rahul', lastName: 'Sharma', mobile: '9876543210' },
    source: 'walk_in',
    arrival: '2026-09-16',
    departure: '2026-09-18',
    rooms: [{ roomTypeId: '6f1c1d52-8f0a-4b8e-9b7e-4b8f1f2d3c4a', adults: 2, nightlyRate: '4000' }],
  };
  it('accepts a normal walk-in', () => {
    const parsed = createReservationSchema.parse(base);
    expect(parsed.rooms[0]!.nightlyRate).toBe('4000.00');
    expect(parsed.guest!.mobile).toBe('+919876543210');
  });
  it('requires departure after arrival', () => {
    expect(createReservationSchema.safeParse({ ...base, departure: '2026-09-16' }).success).toBe(false);
  });
  it('requires OTA reference for OTA sources', () => {
    expect(createReservationSchema.safeParse({ ...base, source: 'booking_com' }).success).toBe(false);
    expect(createReservationSchema.safeParse({ ...base, source: 'booking_com', otaReference: '4455' }).success).toBe(true);
  });
  it('rejects float-looking money like 1e3', () => {
    expect(createReservationSchema.safeParse({ ...base, rooms: [{ ...base.rooms[0], nightlyRate: '1e3' }] }).success).toBe(false);
  });
});

describe('Indian display helpers', () => {
  it('formats mobiles for staff screens', async () => {
    const { formatMobile } = await import('./format');
    expect(formatMobile('+919849012345')).toBe('+91 98490 12345');
    expect(formatMobile('+447911123456')).toBe('+44 79111 23456');
    expect(formatMobile(null)).toBe('');
  });
  it('parses day-first dates only', async () => {
    const { parseIndianDate, formatDateInput } = await import('./format');
    expect(parseIndianDate('16/09/2026')).toBe('2026-09-16');
    expect(parseIndianDate('5-1-27')).toBe('2027-01-05');
    expect(parseIndianDate('09/16/2026')).toBeNull(); // US order is rejected, never silently swapped
    expect(parseIndianDate('31/02/2026')).toBeNull();
    expect(formatDateInput('2026-09-16')).toBe('16/09/2026');
  });
  it('formats timestamps in IST', async () => {
    const { formatDateTime } = await import('./format');
    expect(formatDateTime('2026-09-16T12:12:00Z')).toBe('16 Sep, 5:42 PM');
  });
});

describe('reservation schema rules', () => {
  it('rejects the same room twice and requires a version to update', async () => {
    const { createReservationSchema, updateReservationSchema } = await import('./schemas');
    const room = { roomTypeId: '6f1c1d52-8f0a-4b8e-9b7e-4b8f1f2d3c4a', roomId: '7f1c1d52-8f0a-4b8e-9b7e-4b8f1f2d3c4a', adults: 2 };
    const base = { guestId: '8f1c1d52-8f0a-4b8e-9b7e-4b8f1f2d3c4a', source: 'phone', arrival: '2026-09-16', departure: '2026-09-18', groupName: 'G' };
    expect(createReservationSchema.safeParse({ ...base, rooms: [room, room] }).success).toBe(false);
    expect(updateReservationSchema.safeParse({ ...base, rooms: [room] }).success).toBe(false);
    expect(updateReservationSchema.safeParse({ ...base, rooms: [room], version: 3 }).success).toBe(true);
  });
});

describe('document numbers (spec §31)', () => {
  it('fit the 16-character limit in every series', () => {
    for (const s of ['INV', 'BOS', 'CN', 'DN', 'RV'] as const) expect(formatDocumentNumber(s, '26-27', 99999).length).toBeLessThanOrEqual(16);
  });
});
