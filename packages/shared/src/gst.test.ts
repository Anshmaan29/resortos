import { describe, expect, it } from 'vitest';
import { computeTax, resolveTaxRule, TaxRuleError, type TaxRule, type TaxableLine } from './gst';
import { money, percentOf, toMoneyString } from './money';

/** Illustrative dated configuration — real values come from the tax_rules table (CA-reviewed). */
const RULES: TaxRule[] = [
  // before 22 Sep 2025
  { id: 'acc-old-low', taxCategory: 'accommodation', unitValueAbove: null, unitValueUpTo: '7500.00', ratePercent: '12.00', sac: '996311', effectiveFrom: '2017-07-01', effectiveTo: '2025-09-21' },
  { id: 'acc-old-high', taxCategory: 'accommodation', unitValueAbove: '7500.00', unitValueUpTo: null, ratePercent: '18.00', sac: '996311', effectiveFrom: '2017-07-01', effectiveTo: '2025-09-21' },
  // from 22 Sep 2025
  { id: 'acc-low', taxCategory: 'accommodation', unitValueAbove: null, unitValueUpTo: '7500.00', ratePercent: '5.00', sac: '996311', effectiveFrom: '2025-09-22', effectiveTo: null },
  { id: 'acc-high', taxCategory: 'accommodation', unitValueAbove: '7500.00', unitValueUpTo: null, ratePercent: '18.00', sac: '996311', effectiveFrom: '2025-09-22', effectiveTo: null },
  { id: 'food', taxCategory: 'food', unitValueAbove: null, unitValueUpTo: null, ratePercent: '5.00', sac: '996331', effectiveFrom: '2017-07-01', effectiveTo: null },
  { id: 'activity', taxCategory: 'activity', unitValueAbove: null, unitValueUpTo: null, ratePercent: '18.00', sac: '999652', effectiveFrom: '2017-07-01', effectiveTo: null },
  { id: 'laundry', taxCategory: 'laundry', unitValueAbove: null, unitValueUpTo: null, ratePercent: '18.00', sac: '999712', effectiveFrom: '2017-07-01', effectiveTo: null },
];

const room = (key: string, date: string, value: string): TaxableLine => ({
  key, taxCategory: 'accommodation', dateOfSupply: date, taxableValue: value, unitValue: value,
});

describe('GST slab boundary (spec §30.6)', () => {
  it('₹7,500.00 per night is taxed at 5%', () => {
    expect(resolveTaxRule(RULES, room('a', '2026-09-16', '7500.00')).ratePercent).toBe('5.00');
  });

  it('₹7,500.01 per night is taxed at 18%', () => {
    expect(resolveTaxRule(RULES, room('a', '2026-09-16', '7500.01')).ratePercent).toBe('18.00');
  });

  it('evaluates per room per night, not on the line total', () => {
    // 2 rooms × ₹5,000 = ₹10,000 line, but each room-night is ₹5,000 → 5%
    const line: TaxableLine = { key: 'x', taxCategory: 'accommodation', dateOfSupply: '2026-09-16', taxableValue: '10000.00', unitValue: '5000.00' };
    expect(resolveTaxRule(RULES, line).ratePercent).toBe('5.00');
  });
});

describe('discount crossing the slab', () => {
  it('₹8,000 night with 10% discount moves from 18% to 5%', () => {
    const before = computeTax(RULES, [room('n1', '2026-09-16', '8000.00')]);
    expect(before.groups[0]!.ratePercent).toBe('18.00');

    const discounted = toMoneyString(money('8000.00').minus(percentOf('8000.00', '10')));
    expect(discounted).toBe('7200.00');
    const after = computeTax(RULES, [room('n1', '2026-09-16', discounted)]);
    expect(after.groups[0]!.ratePercent).toBe('5.00');
    expect(after.taxTotal).toBe('360.00');
  });
});

describe('mixed-rate invoice (spec §29.3 example)', () => {
  const lines: TaxableLine[] = [
    room('r1', '2026-09-16', '4000.00'),
    { key: 'f1', taxCategory: 'food', dateOfSupply: '2026-09-16', taxableValue: '560.00' },
    room('r2', '2026-09-17', '4000.00'),
    { key: 'a1', taxCategory: 'activity', dateOfSupply: '2026-09-17', taxableValue: '3000.00' },
    { key: 'l1', taxCategory: 'laundry', dateOfSupply: '2026-09-17', taxableValue: '300.00' },
  ];
  const result = computeTax(RULES, lines);

  it('groups by rate with CGST/SGST split', () => {
    expect(result.groups).toEqual([
      { ratePercent: '5.00', taxableValue: '8560.00', cgst: '214.00', sgst: '214.00', igst: '0.00' },
      { ratePercent: '18.00', taxableValue: '3300.00', cgst: '297.00', sgst: '297.00', igst: '0.00' },
    ]);
  });

  it('totals match the worked example', () => {
    expect(result.taxableTotal).toBe('11860.00');
    expect(result.taxTotal).toBe('1022.00');
    expect(result.roundOff).toBe('0.00');
    expect(result.grandTotal).toBe('12882.00');
  });

  it('carries SAC per line', () => {
    expect(result.lines.find((l) => l.key === 'f1')!.sac).toBe('996331');
  });

  it('inter-state supply uses IGST only', () => {
    const inter = computeTax(RULES, lines, 'inter_state');
    expect(inter.groups[0]).toMatchObject({ cgst: '0.00', sgst: '0.00', igst: '428.00' });
    expect(inter.taxTotal).toBe('1022.00');
  });
});

describe('rate change on an effective date in the middle of a stay', () => {
  it('uses the rule valid on each night', () => {
    const result = computeTax(RULES, [
      room('n1', '2025-09-20', '4000.00'),
      room('n2', '2025-09-21', '4000.00'),
      room('n3', '2025-09-22', '4000.00'),
    ]);
    expect(result.lines.map((l) => l.ratePercent)).toEqual(['12.00', '12.00', '5.00']);
    expect(result.groups.map((g) => [g.ratePercent, g.taxableValue])).toEqual([
      ['5.00', '4000.00'],
      ['12.00', '8000.00'],
    ]);
    expect(result.taxTotal).toBe('1160.00');
  });
});

describe('rounding', () => {
  it('rounds invoice total half-up to the rupee with a visible round-off (x.50)', () => {
    const r = computeTax(RULES, [room('n', '2026-09-16', '10.00')]);
    expect(r.grossTotal).toBe('10.50');
    expect(r.roundOff).toBe('0.50');
    expect(r.grandTotal).toBe('11.00');
  });

  it('rounds down below .50', () => {
    const r = computeTax(RULES, [{ key: 'f', taxCategory: 'food', dateOfSupply: '2026-09-16', taxableValue: '109.00' }]);
    expect(r.grossTotal).toBe('114.46');
    expect(r.roundOff).toBe('-0.46');
    expect(r.grandTotal).toBe('114.00');
  });

  it('rounds each tax half-up at 2 decimals', () => {
    // 0.30 × 2.5% = 0.0075 → 0.01
    const r = computeTax(RULES, [{ key: 'f', taxCategory: 'food', dateOfSupply: '2026-09-16', taxableValue: '0.30' }]);
    expect(r.groups[0]!.cgst).toBe('0.01');
  });

  it('never drifts like floating point (0.1 + 0.2)', () => {
    const r = computeTax(RULES, [
      { key: 'a', taxCategory: 'food', dateOfSupply: '2026-09-16', taxableValue: '0.10' },
      { key: 'b', taxCategory: 'food', dateOfSupply: '2026-09-16', taxableValue: '0.20' },
    ]);
    expect(r.taxableTotal).toBe('0.30');
  });
});

describe('credit note symmetry', () => {
  it('a full credit note of the same lines produces identical totals', () => {
    const lines = [room('r1', '2026-09-16', '4000.00'), { key: 'f', taxCategory: 'food' as const, dateOfSupply: '2026-09-16', taxableValue: '560.00' }];
    const original = computeTax(RULES, lines);
    const credit = computeTax(RULES, lines.map((l) => ({ ...l })));
    expect(credit).toEqual(original);
  });
});

describe('configuration errors are loud, never silent', () => {
  it('throws when no rule matches', () => {
    expect(() => computeTax(RULES, [{ key: 't', taxCategory: 'transport', dateOfSupply: '2026-09-16', taxableValue: '500.00' }]))
      .toThrow(TaxRuleError);
  });

  it('throws on overlapping rules', () => {
    const overlapping = [...RULES, { ...RULES[4]!, id: 'food-dup' }];
    expect(() => resolveTaxRule(overlapping, { key: 'f', taxCategory: 'food', dateOfSupply: '2026-09-16', taxableValue: '100.00' }))
      .toThrow(/Overlapping/);
  });
});
