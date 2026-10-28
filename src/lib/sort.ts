const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Natural ordering, so "Desk 2" sorts before "Desk 10". */
export const byName = (a: string, b: string) => collator.compare(a, b);
