import { addDays, daysBetween } from '../lib/time.js';

export interface PricingTerms {
  pricingMode: 'per_member' | 'fixed';
  pricePerMemberCents: number;
  extraMemberCents: number;
  fixedPriceCents: number;
  startDate: string;
  endDate: string | null;
}

export interface PricedPerson {
  name: string;
  joinDate: string;
  leaveDate: string | null;
  /** Has a desk of their own, so does not use a seat in the shared space. */
  hasDesk: boolean;
}

export interface ChargeLine {
  description: string;
  amountCents: number;
}

/**
 * What a company owes for one calendar month ('YYYY-MM-01' to the last day), day by day for anyone who is there only part of it.
 *
 * People without a desk of their own share the contract's spaces. Those beyond the seats the spaces have (first come, first seated,
 * by join date) pay the extra-person price instead of the normal one. People with their own desk always pay the normal price.
 * In fixed mode the spaces cost one price however many sit there, and only desks and extra people are added.
 * ponytail: who is "extra" is decided by join order, not day by day, so a leaver never moves anyone else up. Day-by-day if owners ask.
 */
export function monthCharges(t: PricingTerms, people: PricedPerson[], seats: number, firstDay: string, nextFirstDay: string): ChargeLine[] {
  const lastDay = addDays(nextFirstDay, -1);
  const monthDays = daysBetween(firstDay, nextFirstDay);
  const daysIn = (from: string, to: string | null) => {
    const a = from > firstDay ? from : firstDay;
    const end = [to, lastDay].filter((x): x is string => !!x).sort()[0]!;
    return Math.max(0, daysBetween(a, end) + 1);
  };
  const share = (cents: number, days: number) => (days >= monthDays ? cents : Math.round((cents * days) / monthDays));
  const note = (days: number) => (days >= monthDays ? '' : `, ${days} of ${monthDays} days`);

  const lines: ChargeLine[] = [];
  const sharing = people.filter((p) => !p.hasDesk).sort((a, b) => a.joinDate.localeCompare(b.joinDate));
  const extra = new Set(sharing.slice(Math.max(0, seats)));

  if (t.pricingMode === 'fixed') {
    const days = daysIn(t.startDate, t.endDate);
    if (days > 0 && t.fixedPriceCents > 0) lines.push({ description: `Space rent${note(days)}`, amountCents: share(t.fixedPriceCents, days) });
  }
  for (const p of people) {
    const days = daysIn(p.joinDate > t.startDate ? p.joinDate : t.startDate, [p.leaveDate, t.endDate].filter((x): x is string => !!x).sort()[0] ?? null);
    if (days <= 0) continue;
    const isExtra = extra.has(p);
    if (t.pricingMode === 'fixed' && !isExtra && !p.hasDesk) continue; // covered by the fixed price
    const price = isExtra ? t.extraMemberCents : t.pricePerMemberCents;
    const amountCents = share(price, days);
    if (amountCents > 0) lines.push({ description: `${p.name}${isExtra ? ' (extra person)' : p.hasDesk ? ' (own desk)' : ''}${note(days)}`, amountCents });
  }
  return lines;
}

/** The full-month price with everyone present, for showing on the contract. */
export function monthlyTotal(t: PricingTerms, people: Omit<PricedPerson, 'name' | 'joinDate' | 'leaveDate'>[], seats: number) {
  const everyone = people.map((p, i) => ({ ...p, name: `P${i}`, joinDate: '2000-01-01', leaveDate: null }));
  const lines = monthCharges({ ...t, startDate: '2000-01-01', endDate: null }, everyone, seats, '2001-01-01', '2001-02-01');
  const sharing = people.filter((p) => !p.hasDesk).length;
  return { totalCents: lines.reduce((s, l) => s + l.amountCents, 0), extraPeople: Math.max(0, sharing - Math.max(0, seats)) };
}
