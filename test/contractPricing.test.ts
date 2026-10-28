import { describe, expect, it } from 'vitest';
import { monthCharges, monthlyTotal, type PricedPerson, type PricingTerms } from '../src/services/contractPricing.js';

const terms: PricingTerms = { pricingMode: 'per_member', pricePerMemberCents: 1_000_000, extraMemberCents: 500_000, fixedPriceCents: 0, startDate: '2026-01-01', endDate: null };
const person = (name: string, extra: Partial<PricedPerson> = {}): PricedPerson => ({ name, joinDate: '2026-01-01', leaveDate: null, hasDesk: false, ...extra });
const sum = (ls: { amountCents: number }[]) => ls.reduce((s, l) => s + l.amountCents, 0);
const month = ['2026-03-01', '2026-04-01'] as const; // 31 days

describe('company contract pricing', () => {
  it('charges the extra-person price for the one who does not fit in the room', () => {
    // six people, a room for five: five at 10k and the sixth at 5k
    const people = ['A', 'B', 'C', 'D', 'E', 'F'].map((n, i) => person(n, { joinDate: `2026-01-0${i + 1}` }));
    const lines = monthCharges(terms, people, 5, ...month);
    expect(sum(lines)).toBe(5_500_000);
    expect(lines.find((l) => l.description.startsWith('F'))?.description).toContain('extra person');
    expect(monthlyTotal(terms, people, 5)).toEqual({ totalCents: 5_500_000, extraPeople: 1 });
  });

  it('charges per member when the room is not full', () => {
    expect(sum(monthCharges(terms, [person('A'), person('B'), person('C')], 5, ...month))).toBe(3_000_000);
  });

  it('keeps people with their own desk out of the room count and charges them the normal price', () => {
    const people = [person('A'), person('B'), person('C', { hasDesk: true }), person('D', { hasDesk: true })];
    expect(sum(monthCharges(terms, people, 2, ...month))).toBe(4_000_000);
    expect(monthlyTotal(terms, people, 2).extraPeople).toBe(0);
  });

  it('fixed mode charges the space once, then only desks and extra people', () => {
    const fixed = { ...terms, pricingMode: 'fixed' as const, fixedPriceCents: 3_000_000 };
    const people = [person('A', { joinDate: '2026-01-01' }), person('B', { joinDate: '2026-01-02' }), person('C', { joinDate: '2026-01-03' }), person('D', { hasDesk: true })];
    // room for two: space 30k + C extra 5k + D desk 10k
    expect(sum(monthCharges(fixed, people, 2, ...month))).toBe(4_500_000);
  });

  it('charges by the day for someone who joins or leaves mid-month', () => {
    const joins = monthCharges(terms, [person('A', { joinDate: '2026-03-16' })], 5, ...month); // 16 of 31 days
    expect(sum(joins)).toBe(Math.round((1_000_000 * 16) / 31));
    expect(joins[0]!.description).toContain('16 of 31 days');
    const leaves = monthCharges(terms, [person('A', { leaveDate: '2026-03-10' })], 5, ...month); // 10 of 31 days
    expect(sum(leaves)).toBe(Math.round((1_000_000 * 10) / 31));
  });

  it('charges nothing before the contract starts or after it ends', () => {
    expect(monthCharges({ ...terms, startDate: '2026-05-01' }, [person('A')], 5, ...month)).toEqual([]);
    expect(monthCharges({ ...terms, endDate: '2026-02-28' }, [person('A')], 5, ...month)).toEqual([]);
    // ending on the 10th: ten days
    expect(sum(monthCharges({ ...terms, endDate: '2026-03-10' }, [person('A')], 5, ...month))).toBe(Math.round((1_000_000 * 10) / 31));
  });
});
