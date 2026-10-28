import type { Request } from 'express';
import { notFound } from './errors.js';

/** The `:id` route param as a string (Express types it as string | string[]). */
export function idParam(req: Request): string {
  const v = req.params.id;
  const id = Array.isArray(v) ? v[0] : v;
  if (!id) throw notFound();
  return id;
}

export function queryString(req: Request, key: string): string | undefined {
  const v = req.query[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}
