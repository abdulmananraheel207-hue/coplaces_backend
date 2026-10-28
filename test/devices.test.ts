import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { attendance, deviceCommands, devicePunches, devices, staffAttendance, users } from '../src/db/schema.js';
import { deviceTimeToUtc, parseAttlog, parseCommandResults } from '../src/services/devices.js';
import { login, setupOpen as setup, TZ } from './helpers.js';

const SN = 'CQZ7224460001';

/** The device's wall clock in the location's timezone, `minutes` from now. */
const clock = (minutes = 0) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(
    new Date(Date.now() + minutes * 60_000),
  );
const punchLine = (pin: string, minutes: number) => `${pin}\t${clock(minutes)}\t0\t1\t0\t0\t0`;

async function withDevice() {
  const ctx = await setup();
  const owner = await login(ctx.app, 'owner@test.dev');
  const reg = await owner.post('/api/devices').send({ locationId: ctx.loc.id, serialNumber: SN, name: 'Front door' }).expect(201);
  // Punches from before a device was linked are ignored, so link it an hour ago.
  await ctx.db.update(devices).set({ createdAt: new Date(Date.now() - 3_600_000).toISOString() }).where(eq(devices.id, reg.body.id)).run();
  const pinOf = async (email: string) => (await ctx.db.select().from(users).where(eq(users.email, email)).get())!.devicePin!;
  const device = request(ctx.app);
  const push = (lines: string[]) => device.post(`/iclock/cdata?SN=${SN}&table=ATTLOG&Stamp=100`).type('text/plain').send(lines.join('\n'));
  const punches = () => ctx.db.select().from(devicePunches).all();
  return { ...ctx, owner, deviceId: reg.body.id as string, reg: reg.body, pinOf, device, push, punches };
}

describe('the ADMS text formats', () => {
  it('reads punch lines and skips anything malformed', () => {
    const lines = parseAttlog('12\t2026-10-28 09:01:02\t0\t1\t0\t0\t0\r\n\ngarbage\nabc\t2026-10-28 09:01:02\n7\t2026-10-28 18:00:00\t1\t15');
    expect(lines).toEqual([
      { pin: '12', time: '2026-10-28 09:01:02', state: 0, verify: 1 },
      { pin: '7', time: '2026-10-28 18:00:00', state: 1, verify: 15 },
    ]);
  });

  it('reads the device clock in the location timezone', () => {
    expect(deviceTimeToUtc('2026-10-28 09:01:02', 'Asia/Karachi')).toBe('2026-10-28T04:01:02.000Z');
    expect(deviceTimeToUtc('2026-02-30 09:00:00', 'Asia/Karachi')).toBeNull();
  });

  it('reads command results', () => {
    expect(parseCommandResults('ID=4&Return=0&CMD=DATA\nID=5&Return=-1002&CMD=DATA\n')).toEqual([
      { id: 4, returnCode: 0 },
      { id: 5, returnCode: -1002 },
    ]);
  });
});

describe('attendance device protocol', () => {
  it('refuses a device that is not registered', async () => {
    const ctx = await setup();
    await request(ctx.app).get('/iclock/cdata?SN=NOPE&options=all').expect(403);
    await request(ctx.app).get('/iclock/getrequest').expect(403);
  });

  it('answers the handshake without asking for fingerprints', async () => {
    const ctx = await withDevice();
    const r = await ctx.device.get(`/iclock/cdata?SN=${SN}&options=all&pushver=2.4.1`).expect(200);
    expect(r.type).toBe('text/plain');
    expect(r.text).toContain(`GET OPTION FROM: ${SN}`);
    expect(r.text).toMatch(/^TransFlag=TransData AttLog$/m);
    expect(r.text).not.toMatch(/FP/);
    expect(r.text).toMatch(/^TimeZone=-[45]$/m);
  });

  it('puts everyone at the location on the device, and takes in the results', async () => {
    const ctx = await withDevice();
    // Two members, the manager, the front desk and the owner; not the Uptown staff or the other tenant.
    expect(ctx.reg.sent).toBe(5);
    const first = await ctx.device.get(`/iclock/getrequest?SN=${SN}&INFO=Ver%206.60,5,0,0,192.168.1.20`).expect(200);
    const cmds = first.text.split('\n');
    expect(cmds).toHaveLength(5);
    expect(cmds).toContain(`C:${cmds[0]!.split(':')[1]}:DATA UPDATE USERINFO PIN=${await ctx.pinOf('pro@test.dev')}\tName=pro`);
    expect(first.text).not.toContain('uptown');
    expect((await ctx.device.get(`/iclock/getrequest?SN=${SN}`).expect(200)).text).toBe('OK');

    const ids = cmds.map((c) => c.split(':')[1]);
    await ctx.device.post(`/iclock/devicecmd?SN=${SN}`).type('text/plain').send(ids.map((id) => `ID=${id}&Return=0&CMD=DATA`).join('\n')).expect(200, 'OK');
    const rows = await ctx.db.select().from(deviceCommands).all();
    expect(rows.every((c) => c.status === 'done')).toBe(true);

    const list = await ctx.owner.get(`/api/devices?locationId=${ctx.loc.id}`).expect(200);
    expect(list.body[0]).toMatchObject({ online: true, commandsWaiting: 0, info: 'Ver 6.60,5,0,0,192.168.1.20' });
  });

  it('checks a member in and out by fingerprint, and ignores repeats and resends', async () => {
    const ctx = await withDevice();
    const pin = await ctx.pinOf('pro@test.dev');
    const batch = [punchLine(pin, -10), punchLine(pin, -9.5), punchLine(pin, -5)];
    expect((await ctx.push(batch).expect(200)).text).toBe('OK: 3');
    expect((await ctx.punches()).map((p) => p.result).sort()).toEqual(['checked_in', 'checked_out', 'duplicate']);
    const visits = await ctx.db.select().from(attendance).where(eq(attendance.memberId, ctx.pro.member.id)).all();
    expect(visits).toHaveLength(1);
    expect(visits[0]!.checkOutAt).not.toBeNull();

    // The device resends what it is not sure arrived.
    await ctx.push(batch).expect(200);
    expect(await ctx.punches()).toHaveLength(3);
    expect((await ctx.db.select().from(devices).get())!.attlogStamp).toBe('100');
  });

  it('records punches it cannot apply, and still answers OK', async () => {
    const ctx = await withDevice();
    const owner = ctx.owner;
    await owner.patch(`/api/members/${ctx.basic.member.id}`).send({ status: 'paused' }).expect(200);
    await ctx.push([punchLine('9999', -3), punchLine(await ctx.pinOf('basic@test.dev'), -2), punchLine(await ctx.pinOf('pro@test.dev'), 30)]).expect(200, 'OK: 3');
    const byPin = Object.fromEntries((await ctx.punches()).map((p) => [p.pin, p]));
    expect(byPin['9999']).toMatchObject({ result: 'unknown_pin', userId: null });
    expect(byPin[await ctx.pinOf('basic@test.dev')]).toMatchObject({ result: 'rejected', message: 'Membership is paused' });
    expect(byPin[await ctx.pinOf('pro@test.dev')]).toMatchObject({ result: 'rejected', message: 'The device clock is ahead of the server' });

    const unknown = await owner.get(`/api/devices/${ctx.deviceId}/punches?result=unknown_pin`).expect(200);
    expect(unknown.body.map((p: { pin: string }) => p.pin)).toEqual(['9999']);
  });

  it('clocks the team in and out without member rules', async () => {
    const ctx = await withDevice();
    const pin = await ctx.pinOf('desk@test.dev');
    await ctx.push([punchLine(pin, -45), punchLine(pin, -15)]).expect(200);
    const shifts = await ctx.db.select().from(staffAttendance).all();
    expect(shifts).toHaveLength(1);
    const list = await ctx.owner.get(`/api/attendance/staff?locationId=${ctx.loc.id}`).expect(200);
    expect(list.body[0]).toMatchObject({ name: 'desk@test.dev', minutes: 30 });
    // Staff of another location are on no device here, and refused if their PIN is used.
    const uptown = (await ctx.db.select().from(users).where(eq(users.email, 'uptown@test.dev')).get())!;
    await ctx.owner.put(`/api/devices/pins/${uptown.id}`).send({ pin: '777' }).expect(200);
    await ctx.push([punchLine('777', -1)]).expect(200);
    expect((await ctx.punches()).find((p) => p.pin === '777')).toMatchObject({ result: 'rejected', message: 'Not on the team at this location' });
  });

  it('takes a cancelled member off the device and renames people who change', async () => {
    const ctx = await withDevice();
    await ctx.device.get(`/iclock/getrequest?SN=${SN}`).expect(200);
    const pin = await ctx.pinOf('basic@test.dev');
    await ctx.owner.patch(`/api/members/${ctx.basic.member.id}`).send({ status: 'cancelled' }).expect(200);
    await ctx.owner.patch(`/api/members/${ctx.pro.member.id}`).send({ name: 'Ayesha Khan' }).expect(200);
    const next = (await ctx.device.get(`/iclock/getrequest?SN=${SN}`).expect(200)).text;
    expect(next).toContain(`DATA DELETE USERINFO PIN=${pin}`);
    expect(next).toContain('Name=Ayesha Khan');
  });

  it('gives a new member a PIN and sends them to the device', async () => {
    const ctx = await withDevice();
    await ctx.device.get(`/iclock/getrequest?SN=${SN}`).expect(200);
    const created = await ctx.owner.post('/api/members').send({ locationId: ctx.loc.id, name: 'New Person', email: 'new@test.dev' }).expect(201);
    expect(created.body.devicePin).toMatch(/^\d+$/);
    expect((await ctx.device.get(`/iclock/getrequest?SN=${SN}`).expect(200)).text).toMatch(new RegExp(`DATA UPDATE USERINFO PIN=${created.body.devicePin}\tName=New Person$`));
  });

  it('moves someone to a PIN they are already enrolled under', async () => {
    const ctx = await withDevice();
    await ctx.device.get(`/iclock/getrequest?SN=${SN}`).expect(200);
    const old = await ctx.pinOf('pro@test.dev');
    await ctx.owner.put(`/api/devices/pins/${ctx.pro.user.id}`).send({ pin: await ctx.pinOf('basic@test.dev') }).expect(409);
    await ctx.owner.put(`/api/devices/pins/${ctx.pro.user.id}`).send({ pin: '0042' }).expect(400);
    await ctx.owner.put(`/api/devices/pins/${ctx.pro.user.id}`).send({ pin: '42' }).expect(200);
    const next = (await ctx.device.get(`/iclock/getrequest?SN=${SN}`).expect(200)).text.split('\n');
    expect(next[0]).toMatch(new RegExp(`DATA DELETE USERINFO PIN=${old}$`));
    expect(next[1]).toMatch(/DATA UPDATE USERINFO PIN=42\tName=pro$/);
  });

  it('keeps devices to their own tenant and to managers', async () => {
    const ctx = await withDevice();
    const hive = await login(ctx.app, 'owner@hive.dev');
    await hive.get(`/api/devices/${ctx.deviceId}/punches`).expect(404);
    await hive.post(`/api/devices/${ctx.deviceId}/sync`).expect(404);
    const desk = await login(ctx.app, 'desk@test.dev');
    await desk.post(`/api/devices/${ctx.deviceId}/sync`).expect(403);
    await ctx.owner.post('/api/devices').send({ locationId: ctx.loc.id, serialNumber: SN, name: 'Again' }).expect(409);
  });

  it('stops answering a device that is switched off', async () => {
    const ctx = await withDevice();
    await ctx.owner.patch(`/api/devices/${ctx.deviceId}`).send({ active: false }).expect(200);
    await ctx.push([punchLine(await ctx.pinOf('pro@test.dev'), -1)]).expect(403);
  });
});
