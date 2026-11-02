import { beforeAll, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { buildReconciliationScenario, bugsIn, reconcile, type Check } from './helpers/reconcile.js';

/**
 * Every screen that shows money agrees with the books, in one scenario full of awkward cases (see test/helpers/reconcile.ts).
 * Checks that are right today must hold. Each known bug's checks are one `it.fails`: fixing that bug flips exactly that test.
 * SHOW_BUGS=1 runs them as plain tests.
 */
const knownBug = process.env.SHOW_BUGS ? it : it.fails;

/** The bugs the scenario's checks are tagged with. Adding a tagged check without listing its bug here fails the first test. */
const BUGS: Record<string, string> = {
  L3: 'payments by method reconcile with money collected',
  R1: 'invoiced includes the part of a bill an advance paid',
  R2: 'tax is reported and kept out of profit and loss income',
  R4a: 'aging is as of the report end date',
  R4b: 'deposits held are as of the report end date',
};

let checks: Check[] = [];

beforeAll(async () => {
  const ctx = await setup();
  checks = await reconcile(ctx, await buildReconciliationScenario(ctx));
}, 60_000);

const failures = (list: Check[]) => list.filter((c) => JSON.stringify(c.actual) !== JSON.stringify(c.expected)).map((c) => `${c.label}: got ${JSON.stringify(c.actual)}, expected ${JSON.stringify(c.expected)}`);

describe('reconciliation: one scenario, every screen', () => {
  it('agrees on every definition that is right today', () => {
    expect(checks.length).toBeGreaterThan(60);
    expect(bugsIn(checks)).toEqual(Object.keys(BUGS).sort());
    expect(failures(checks.filter((c) => !c.bug))).toEqual([]);
  });

  for (const [bug, what] of Object.entries(BUGS)) {
    knownBug(`KNOWN BUG ${bug}: ${what}`, () => {
      expect(failures(checks.filter((c) => c.bug === bug))).toEqual([]);
    });
  }
});
