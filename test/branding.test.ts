import { describe, expect, it } from 'vitest';
import { login, setup } from './helpers.js';

const png = `data:image/png;base64,${Buffer.from('fake png bytes').toString('base64')}`;

describe('business logo', () => {
  it('the owner sets and removes it; staff and members of the business can read it; other businesses cannot see it', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const member = await login(ctx.app, 'pro@test.dev');
    expect((await owner.get('/api/branding/logo').expect(200)).body.dataUrl).toBeNull();

    const { logoVersion } = (await owner.put('/api/branding/logo').send({ dataUrl: png }).expect(200)).body;
    expect(logoVersion).toBeTruthy();
    expect((await owner.get('/api/auth/me').expect(200)).body.org.logoVersion).toBe(logoVersion);
    expect((await member.get('/api/branding/logo').expect(200)).body.dataUrl).toBe(png);
    await member.put('/api/branding/logo').send({ dataUrl: png }).expect(403);

    const hive = await login(ctx.app, 'owner@hive.dev');
    expect((await hive.get('/api/branding/logo').expect(200)).body.dataUrl).toBeNull();

    await owner.delete('/api/branding/logo').expect(204);
    expect((await owner.get('/api/branding/logo').expect(200)).body.dataUrl).toBeNull();
    expect((await owner.get('/api/auth/me').expect(200)).body.org.logoVersion).toBeNull();
  });

  it('accepts only a PNG, JPEG or WebP data URL of a sensible size', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    await owner.put('/api/branding/logo').send({ dataUrl: 'https://example.com/logo.png' }).expect(400);
    await owner.put('/api/branding/logo').send({ dataUrl: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}` }).expect(400);
    await owner.put('/api/branding/logo').send({ dataUrl: `data:image/png;base64,${'A'.repeat(400_100)}` }).expect(400);
    await owner.put('/api/branding/logo').send({ dataUrl: `data:image/jpeg;base64,${'A'.repeat(300_000)}` }).expect(200);
  });
});
