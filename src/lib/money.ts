import { z } from 'zod';
import { HttpError } from './errors.js';

/**
 * Limits on amounts, all in minor units. They keep every sum the application makes far inside the integers JavaScript holds exactly
 * (Number.MAX_SAFE_INTEGER is about 9e15), so no total is ever rounded by the computer.
 */

/** The most any single price, fee, rent, deposit or expense can be: 10,000,000,000.00. */
export const MONEY_MAX = 1_000_000_000_000;
/** The most an invoice (and so a single payment) can come to. */
export const INVOICE_MAX = 10_000_000_000_000;
/** The most of one thing on an invoice line. */
export const QUANTITY_MAX = 10_000;

/** A price or amount that may be zero. */
export const money = z.number().int().min(0).max(MONEY_MAX);
/** An amount that must be more than zero. */
export const positiveMoney = z.number().int().min(1).max(MONEY_MAX);
/** A payment: more than zero, up to the largest invoice. */
export const paymentAmount = z.number().int().min(1).max(INVOICE_MAX);

/** How far ahead of the server's clock a payment may be dated (a device or phone a little fast). */
const AHEAD_MS = 10 * 60_000;
/** How far back a payment may be dated when it is recorded late. */
const BACK_YEARS = 5;

/**
 * Checks the date a payment is said to have been made: not in the future, and not more than five years back. Money cannot be
 * recorded as received before it was, or so long ago that it rewrites years that are closed. Returns the instant to store.
 */
export function checkPaidAt(paidAt: string | undefined, now = new Date()): string {
  if (!paidAt) return now.toISOString();
  const at = Date.parse(paidAt);
  if (at > now.getTime() + AHEAD_MS) throw new HttpError(400, 'A payment cannot be dated in the future');
  const earliest = new Date(now);
  earliest.setUTCFullYear(earliest.getUTCFullYear() - BACK_YEARS);
  if (at < earliest.getTime()) throw new HttpError(400, `A payment cannot be dated more than ${BACK_YEARS} years back`);
  return new Date(at).toISOString();
}
