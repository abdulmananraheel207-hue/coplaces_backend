import { randomBytes } from 'node:crypto';

/** A one-time password to hand to a new account holder. */
export const tempPassword = () => randomBytes(9).toString('base64url');
