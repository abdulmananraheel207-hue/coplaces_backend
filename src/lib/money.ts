import { z } from 'zod';

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
