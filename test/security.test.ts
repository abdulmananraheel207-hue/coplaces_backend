import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

describe('security headers', () => {
  it('let the browser show an uploaded floor plan picture and run the PDF reader, and keep everything else closed', async () => {
    const { app } = await setup();
    const csp = (await request(app).get('/api/health').expect(200)).headers['content-security-policy']!;
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
  });
});
