// Pretends to be a ZKTeco attendance device talking ADMS, to try the server without the hardware.
//   npm run device:sim -- --sn CQZ7224460001 --url http://localhost:4310 --tz Asia/Karachi
// Register the serial number in the app first. Then type a PIN and Enter to punch; `users` lists who the server has
// sent; `q` quits.
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: { sn: { type: 'string', default: 'SIM0000001' }, url: { type: 'string', default: 'http://localhost:4310' }, tz: { type: 'string', default: 'Asia/Karachi' }, poll: { type: 'string', default: '5' } },
});
const base = `${args.url!.replace(/\/$/, '')}/iclock`;
const users = new Map<string, string>();
let stamp = 0;

async function call(method: 'GET' | 'POST', path: string, body?: string) {
  const res = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}SN=${encodeURIComponent(args.sn!)}`, { method, body, headers: body ? { 'content-type': 'text/plain' } : {} });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text;
}

const clock = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: args.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date());

/** Runs what the server queued, the way the device would, and reports each one done. */
async function poll() {
  const text = await call('GET', `/getrequest?INFO=${encodeURIComponent(`Simulator,${users.size},0,0,127.0.0.1`)}`);
  if (text.trim() === 'OK') return;
  const results: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^C:(\d+):(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, id, cmd] = m as unknown as [string, string, string];
    const fields = Object.fromEntries(cmd.split(/[\t ]/).filter((f) => f.includes('=')).map((f) => f.split('=') as [string, string]));
    if (cmd.startsWith('DATA UPDATE USERINFO')) {
      users.set(fields.PIN!, cmd.split('Name=')[1] ?? '');
      console.log(`  <- user ${fields.PIN} ${users.get(fields.PIN!)}`);
    } else if (cmd.startsWith('DATA DELETE USERINFO')) {
      users.delete(fields.PIN!);
      console.log(`  <- removed user ${fields.PIN}`);
    } else console.log(`  <- ${cmd}`);
    results.push(`ID=${id}&Return=0&CMD=${cmd.split(' ')[0]}`);
  }
  await call('POST', '/devicecmd', results.join('\n'));
}

console.log(`Handshake as ${args.sn} with ${base}`);
console.log((await call('GET', '/cdata?options=all&pushver=2.4.1')).replace(/^/gm, '  '));
await poll();
const timer = setInterval(() => poll().catch((e: Error) => console.error(e.message)), Number(args.poll) * 1000);

const rl = createInterface({ input: process.stdin, output: process.stdout });
for (;;) {
  const input = (await rl.question('PIN to punch (users, q): ')).trim();
  if (input === 'q') break;
  if (input === 'users') {
    for (const [pin, name] of [...users].sort((a, b) => Number(a[0]) - Number(b[0]))) console.log(`  ${pin}\t${name}`);
    continue;
  }
  if (!/^\d+$/.test(input)) continue;
  const line = `${input}\t${clock()}\t0\t1\t0\t0\t0`;
  try {
    console.log(`  -> ${line.replaceAll('\t', ' ')}: ${await call('POST', `/cdata?table=ATTLOG&Stamp=${++stamp}`, line)}`);
  } catch (e) {
    console.error((e as Error).message);
  }
}
clearInterval(timer);
rl.close();
