import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

describe('health check', () => {
  it('reports the database as connected while it answers', async () => {
    const { app } = await setup();
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body).toMatchObject({ ok: true, database: { kind: 'local', connected: true } });
    expect(res.body.database.latencyMs).toBeTypeOf('number');
  });

  it('answers 503 without the reason once the database is gone', async () => {
    const { app, db } = await setup();
    db.$client.close();
    const res = await request(app).get('/api/health').expect(503);
    expect(res.body).toEqual({ ok: false, database: { kind: 'local', connected: false } });
  });
});
