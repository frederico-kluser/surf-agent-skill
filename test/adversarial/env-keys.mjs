#!/usr/bin/env node
// Brave keys exported in the environment: BRAVE_API_KEY / BRAVE_API_KEYS.
//
// The CLI used to read ~/.config/surf/keys.json and nothing else, while its
// own exit-78 message said it had checked the environment and ./.env, and the
// `requires` line of every skill promised the same. Exported keys now join the
// ring BEHIND the stored ones, in memory only, and saveStateAtomic() strips
// them, with every burn, cooldown and verdict that pointed at them, before any
// write. This suite pins that contract end to end:
//
//   · the state helpers and the one write door, including a concurrent writer
//     landing while a process holds an exported key;
//   · the real bin (gate, search, keys) against a loopback Brave stub, where
//     the X-Subscription-Token of each request says which key actually went out.
//
// Offline: the only socket is 127.0.0.1. The parent strips every exported key,
// points HOME at a throwaway directory before any src import, and fails the run
// if the md5 of the real keys.json or ratelimit.json moves.
//
// Run: node ./test/adversarial/env-keys.mjs

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SELF), '..', '..');
const CLI = path.join(REPO, 'bin', 'surf-research-skill.mjs');
const KEY_VARS = ['BRAVE_API_KEY', 'BRAVE_API_KEYS', 'OPENROUTER_API_KEY', 'OPENROUTER_API_KEYS'];

// ---------------------------------------------------------------- harness ---

if (!process.env.SURF_ENV_KEYS_CHILD) {
  // The keys this suite exports are fakes it picks per scenario. A real one
  // sitting in the developer's shell would change every verdict below.
  for (const k of KEY_VARS) delete process.env[k];
  const realHome = process.env.HOME || '';
  const real = [
    path.join(realHome, '.config', 'surf', 'keys.json'),
    path.join(realHome, '.cache', 'surf', 'ratelimit.json'),
  ];
  const md5 = (f) => (existsSync(f) ? createHash('md5').update(readFileSync(f)).digest('hex') : 'absent');
  const before = real.map(md5);
  const root = mkdtempSync(path.join(tmpdir(), 'surf-env-keys-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'cwd');
  mkdirSync(path.join(home, '.config', 'surf'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const r = spawnSync(process.execPath, [SELF], {
    stdio: 'inherit',
    cwd,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SURF_ENV_KEYS_CHILD: '1',
      SURF_ENV_KEYS_ROOT: root,
      SURF_QUIET: '1',
      SURF_NO_RATE_LIMIT: '1',
      SURF_NO_TIMEOUT: '1',
      // Every scenario points its own CLI at the loopback stub. Anything that
      // slips past it lands on hosts that do not resolve.
      SURF_BRAVE_API_BASE: 'https://brave.invalid/res/v1',
      SURF_OPENROUTER_BASE: 'https://openrouter.invalid/api/v1',
    },
  });
  try { rmSync(root, { recursive: true, force: true }); } catch {}
  const after = real.map(md5);
  if (after.join() !== before.join()) {
    process.stderr.write(`✗ the REAL keys.json / ratelimit.json changed during the run: ${before.join(' ')} → ${after.join(' ')}\n`);
    process.exit(1);
  }
  process.exit(r.status === null ? 1 : r.status);
}

// ------------------------------------------------------------------ child ---

let passed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; process.stdout.write(`  ✓ ${name}\n`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); process.stdout.write(`  ✗ ${name}${detail ? ' — ' + detail : ''}\n`); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t) { process.stdout.write(`\n${t}\n`); }

const ROOT = process.env.SURF_ENV_KEYS_ROOT;
const S = await import('../../src/lib/state.mjs');
const { discoverKeys } = await import('../../src/env.mjs');
const SNAPSHOT = Symbol.for('surf.state.snapshot');

// Fakes shaped like Brave keys, long enough that maskKey() masks them.
const STORED = 'BSAstoredGOOD00000000000001';
const STORED_DEAD = 'BSAstoredDEAD00000000000002';
const ENV = 'BSAenvGOOD0000000000000003';
const ENV2 = 'BSAenvGOODtoo0000000000004';
const ENV_DEAD = 'BSAenvDEAD0000000000000005';
const SECOND = 'BSAstoredSECOND000000000006';
const NAMES = new Map([
  [STORED, 'stored'], [STORED_DEAD, 'stored-dead'],
  [ENV, 'env'], [ENV2, 'env2'], [ENV_DEAD, 'env-dead'],
]);
const LIVE = new Set([STORED, ENV, ENV2]);
const masked = (k) => `${k.slice(0, 5)}…${k.slice(-4)}`;

function storedState(keys) {
  const at = new Date().toISOString();
  return {
    schema_version: 1,
    // Pre-validated, the way `keys add` leaves a key: the gate trusts it from
    // the cache and never probes it.
    brave: {
      keys, current: 0, burned: [], cooldowns: [],
      validated: keys.map((_, index) => ({ index, at, ok: true, status: 200, reason: null })),
    },
    openrouter: { keys: [], current: 0, burned: [], cooldowns: [], validated: [] },
    last_ok_provider: null,
  };
}
const nothingPast = (sec, n) => [...sec.burned, ...sec.cooldowns, ...sec.validated].every(e => e.index < n);

// ------------------------------------------------------- loopback Brave ---
// Answers the way Brave does where it matters here: a dead token gets a 422
// SUBSCRIPTION_TOKEN_INVALID whatever else was sent, a live token with no `q`
// gets the free probe's 422 VALIDATION, and a live token with a query gets one
// result.
const hits = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const token = String(req.headers['x-subscription-token'] || '');
  const q = u.searchParams.get('q');
  hits.push({ path: u.pathname, q, token });
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (u.pathname !== '/res/v1/web/search') return send(404, { error: { code: 'NOT_FOUND', detail: u.pathname } });
  if (!LIVE.has(token)) {
    return send(422, { type: 'ErrorResponse', error: { code: 'SUBSCRIPTION_TOKEN_INVALID', detail: 'The provided subscription token is invalid.', status: 422 } });
  }
  if (!q) {
    return send(422, { type: 'ErrorResponse', error: { code: 'VALIDATION', detail: 'Unable to validate request parameter(s).', status: 422 } });
  }
  return send(200, {
    type: 'search',
    query: { original: q, more_results_available: false },
    web: { type: 'search', results: [{ title: `About ${q}`, url: `https://example.com/${encodeURIComponent(q)}`, description: `A snippet about ${q}.` }] },
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}/res/v1`;
const who = (list) => list.map(h => NAMES.get(h.token) || '?').join(',');

let scenarios = 0;
function scenario({ keys, dotenv } = {}) {
  scenarios++;
  const home = path.join(ROOT, `home-${scenarios}`);
  const cwd = path.join(ROOT, `cwd-${scenarios}`);
  mkdirSync(path.join(home, '.config', 'surf'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const file = path.join(home, '.config', 'surf', 'keys.json');
  if (keys) writeFileSync(file, JSON.stringify(storedState(keys), null, 2), { mode: 0o600 });
  if (dotenv) writeFileSync(path.join(cwd, '.env'), dotenv);
  return {
    home, cwd,
    text: () => (existsSync(file) ? readFileSync(file, 'utf8') : ''),
    disk: () => JSON.parse(readFileSync(file, 'utf8')),
  };
}

// Async on purpose: the stub lives in THIS process, so a spawnSync would block
// the very event loop that has to answer the child's requests.
function cli(sc, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: sc.cwd,
      env: { ...process.env, HOME: sc.home, USERPROFILE: sc.home, SURF_BRAVE_API_BASE: BASE, ...env },
      // No TTY on stdin: a failed gate exits 78 instead of opening the wizard.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(stdout); } catch {}
      resolve({ status, stdout, stderr, json });
    });
  });
}

// =========================================================================
// PART 1 — the state helpers and the write door, in process
// =========================================================================

section('envKeysFor: what the environment holds');
eq('the plural CSV first, then the singular; trimmed, blanks and repeats dropped',
  S.envKeysFor('brave', { BRAVE_API_KEYS: ' a1 , b2,, a1 ', BRAVE_API_KEY: 'c3' }).join(), 'a1,b2,c3');
eq('a blank variable is no key', S.envKeysFor('brave', { BRAVE_API_KEY: '   ', BRAVE_API_KEYS: ' , ' }).length, 0);
eq('the singular repeating a plural entry adds nothing', S.envKeysFor('brave', { BRAVE_API_KEYS: 'a1', BRAVE_API_KEY: 'a1' }).length, 1);
eq('openrouter reads only its own variables', S.envKeysFor('openrouter', { OPENROUTER_API_KEY: 'o1', BRAVE_API_KEY: 'x' }).join(), 'o1');
eq('a provider surf does not know has no variables', S.envKeysFor('tavily', { TAVILY_API_KEY: 't' }).length, 0);

section('mergeEnvKeysInto: exported keys go BEHIND the stored ones');
{
  const st = { brave: { ...S.blankProvider(), keys: ['s0', 's1'] } };
  eq('an exported key that is already stored adds nothing', S.mergeEnvKeysInto(st, 'brave', { BRAVE_API_KEY: 's1' }), 0);
  eq('and leaves no marker behind', st.brave._storedKeyCount, undefined);
  eq('new exported keys are appended', S.mergeEnvKeysInto(st, 'brave', { BRAVE_API_KEYS: 'e0,s0', BRAVE_API_KEY: 'e1' }), 2);
  eq('after the stored keys, in order', st.brave.keys.join(), 's0,s1,e0,e1');
  eq('the stored count is recorded', st.brave._storedKeyCount, 2);
  eq('merging again is a no-op', S.mergeEnvKeysInto(st, 'brave', { BRAVE_API_KEYS: 'e0', BRAVE_API_KEY: 'e1' }), 0);
  eq('and does not move the count', st.brave._storedKeyCount, 2);
  ok('isEnvKeyIndex tells the two apart',
    !S.isEnvKeyIndex(st, 'brave', 1) && S.isEnvKeyIndex(st, 'brave', 2) && S.isEnvKeyIndex(st, 'brave', 3));
  ok('a section with no exported keys has none', !S.isEnvKeyIndex({ brave: { keys: ['s0'] } }, 'brave', 0));
  const bare = {};
  eq('a state with no brave section still takes an exported key', S.mergeEnvKeysInto(bare, 'brave', { BRAVE_API_KEY: 'e0' }), 1);
  eq('as its only key, marked as not stored', `${bare.brave.keys.join()}|${bare.brave._storedKeyCount}`, 'e0|0');
}

section('stripEnvKeys: what is safe to write');
{
  const st = {
    schema_version: 1,
    brave: {
      keys: ['s0', 'e0', 'e1'], current: 2, _storedKeyCount: 1,
      burned: [{ index: 0, at: 'x', reason: 'auth' }, { index: 2, at: 'x', reason: 'auth' }],
      cooldowns: [{ index: 1, until: 'y' }],
      validated: [{ index: 0, ok: true }, { index: 1, ok: false }],
    },
    openrouter: { keys: ['o0'], current: 0, burned: [], cooldowns: [], validated: [] },
  };
  st[SNAPSHOT] = { text: '{}', base: {} };
  const out = S.stripEnvKeys(st);
  eq('only the stored keys remain', out.brave.keys.join(), 's0');
  eq('a current that pointed at an exported key falls back to 0', out.brave.current, 0);
  eq('the burn on the exported key is dropped, the stored one kept', out.brave.burned.map(b => b.index).join(), '0');
  eq('the cooldown on an exported key is dropped', out.brave.cooldowns.length, 0);
  eq('the verdict on an exported key is dropped, the stored one kept', out.brave.validated.map(v => v.index).join(), '0');
  ok('the marker never reaches the file', !('_storedKeyCount' in out.brave));
  ok('a section with no exported keys passes through untouched', out.openrouter === st.openrouter);
  ok('the merge snapshot rides along on the copy', out[SNAPSHOT] === st[SNAPSHOT]);
  ok('the live state keeps every key, burn and pointer',
    st.brave.keys.length === 3 && st.brave._storedKeyCount === 1 && st.brave.burned.length === 2 && st.brave.current === 2);
  const plain = { brave: { keys: ['s0'], current: 0, burned: [], cooldowns: [], validated: [] } };
  ok('a state with no exported keys comes back as the same object', S.stripEnvKeys(plain) === plain);
}

section('verdicts about exported keys: kept for the process, never written');
{
  const first = { brave: { ...S.blankProvider(), keys: ['memo-s0'] } };
  S.mergeEnvKeysInto(first, 'brave', { BRAVE_API_KEY: 'memo-e0' });
  S.setValidation(first, 'brave', 1, { ok: true, status: 422 });
  // A second load in the same process, the way the bin's gate is followed by
  // dispatch or surf-ai; here another stored key has appeared in between.
  const second = { brave: { ...S.blankProvider(), keys: ['memo-s0', 'memo-s1'] } };
  S.mergeEnvKeysInto(second, 'brave', { BRAVE_API_KEY: 'memo-e0' });
  const inherited = S.getValidation(second, 'brave', 2);
  eq("the next load in the same process inherits the verdict, at the key's new index", inherited && inherited.ok, true);
  S.markBurned(second, 'brave', 2, '422');
  const third = { brave: { ...S.blankProvider(), keys: ['memo-s0'] } };
  S.mergeEnvKeysInto(third, 'brave', { BRAVE_API_KEY: 'memo-e0' });
  eq('a burn forgets it, so no later load trusts a key that just died', S.getValidation(third, 'brave', 1), null);
}

section('saveStateAtomic: the one write door never writes an exported key');
{
  writeFileSync(S.KEYS_FILE, JSON.stringify(storedState([STORED])), { mode: 0o600 });
  process.env.BRAVE_API_KEY = ENV;
  const st = await S.loadCliState();
  delete process.env.BRAVE_API_KEY;
  eq('loadCliState appends the exported key behind the stored one', st.brave.keys.join(), `${STORED},${ENV}`);
  S.markBurned(st, 'brave', 1, '422');
  S.setCooldown(st, 'brave', 1, Date.now() + 60_000);
  st.brave.current = 1;
  await S.saveStateAtomic(st);
  const text = readFileSync(S.KEYS_FILE, 'utf8');
  const disk = JSON.parse(text);
  ok('the exported key is not in keys.json', !text.includes(ENV));
  eq('keys.json keeps exactly the stored key', disk.brave.keys.join(), STORED);
  ok('no burn, cooldown or verdict on disk points past the stored keys', nothingPast(disk.brave, 1), JSON.stringify(disk.brave));
  eq('current on disk points at a stored key', disk.brave.current, 0);
  ok('the running process still holds the key, its burn and its pointer',
    st.brave.keys.length === 2 && st.brave.burned.some(b => b.index === 1) && st.brave.current === 1);
}

section('saveStateAtomic: another writer lands while an exported key is held');
{
  writeFileSync(S.KEYS_FILE, JSON.stringify(storedState([STORED])), { mode: 0o600 });
  process.env.BRAVE_API_KEY = ENV;
  const mine = await S.loadCliState();
  delete process.env.BRAVE_API_KEY;
  // A second process stores a key. In the file it takes index 1, the index
  // the exported key holds in this process's memory.
  const other = await S.loadState();
  other.brave.keys.push(SECOND);
  await S.saveStateAtomic(other);
  S.markBurned(mine, 'brave', 1, '422');
  await S.saveStateAtomic(mine);
  const text = readFileSync(S.KEYS_FILE, 'utf8');
  const disk = JSON.parse(text);
  eq("the other writer's key survives the merge", disk.brave.keys.join(), `${STORED},${SECOND}`);
  eq("and this process's burn of ITS index 1 does not land on it", disk.brave.burned.length, 0);
  ok('the exported key is still not written', !text.includes(ENV));
}

// =========================================================================
// PART 2 — the real CLI against the loopback stub
// =========================================================================

section('CLI: a key exported in the environment and nothing stored');
{
  const sc = scenario();
  let from = hits.length;
  const g = await cli(sc, ['gate', '--json'], { BRAVE_API_KEY: ENV });
  eq('gate exits 0: the exported key opens it', g.status, 0);
  eq('verdict ready', g.json && g.json.verdict, 'ready');
  eq('key_source says where the key came from', g.json && g.json.key_source, 'environment');
  eq('env_key_count counts it', g.json && g.json.env_key_count, 1);
  ok('the payload never prints the raw key', !g.stdout.includes(ENV));
  eq('one request went out: the free validation probe', who(hits.slice(from)), 'env');
  ok('with no query in it', hits.slice(from).every(h => !h.q));
  ok('keys.json holds no trace of the key', !sc.text().includes(ENV));

  const h = await cli(sc, ['gate'], { BRAVE_API_KEY: ENV });
  eq('the human form exits 0 too', h.status, 0);
  ok('and says the key came from the environment', h.stdout.includes('from $BRAVE_API_KEY(S), in memory'), h.stdout);
  ok('without printing it', !h.stdout.includes(ENV) && !h.stderr.includes(ENV));

  from = hits.length;
  const s = await cli(sc, ['search', 'env only alpha', '--max', '1', '--json', '--no-cache'], { BRAVE_API_KEY: ENV });
  eq('search runs on the exported key: exit 0', s.status, 0, s.stderr);
  ok('and returns the result', s.stdout.includes('https://example.com/env%20only%20alpha'), s.stdout.slice(0, 300));
  eq('the search request carried the exported key', who(hits.slice(from).filter(x => x.q === 'env only alpha')), 'env');
  eq("after ONE free probe, not one per state load: the bin's gate verdict carries into dispatch",
    hits.slice(from).filter(x => !x.q).length, 1);
  ok('keys.json still holds no trace of it', !sc.text().includes(ENV));
}

section('CLI: BRAVE_API_KEYS with a dead key in front');
{
  const sc = scenario();
  const from = hits.length;
  const g = await cli(sc, ['gate', '--json'], { BRAVE_API_KEYS: `${ENV_DEAD}, ${ENV}` });
  eq('gate exits 0 on the second exported key', g.status, 0);
  eq('it trusts index 1, from the environment', g.json && `${g.json.key_index}|${g.json.key_source}`, '1|environment');
  eq('both probes went out, the dead key first', who(hits.slice(from)), 'env-dead,env');
  ok('neither key reaches keys.json', !sc.text().includes(ENV_DEAD) && !sc.text().includes(ENV));
  eq('nor does either verdict', sc.disk().brave.validated.length, 0);
}

section('CLI: a stored key and an exported one — the stored key goes first');
{
  const sc = scenario({ keys: [STORED] });
  let from = hits.length;
  const g = await cli(sc, ['gate', '--json'], { BRAVE_API_KEY: ENV });
  eq('gate exits 0', g.status, 0);
  eq('it trusts the stored key', g.json && `${g.json.key_index}|${g.json.key_source}`, '0|keys.json');
  eq('while counting the exported one', g.json && g.json.env_key_count, 1);
  eq('and needs no request: the stored verdict is cached', hits.length - from, 0);

  from = hits.length;
  const s = await cli(sc, ['search', 'stored first beta', '--max', '1', '--json', '--no-cache'], { BRAVE_API_KEY: ENV });
  eq('search exits 0', s.status, 0);
  eq('its one request carried the STORED key', who(hits.slice(from)), 'stored');
  eq('keys.json keeps exactly the stored key', sc.disk().brave.keys.join(), STORED);
  ok('and nothing of the exported one', !sc.text().includes(ENV));

  const l = await cli(sc, ['keys', 'list'], { BRAVE_API_KEY: ENV });
  eq('keys list exits 0', l.status, 0);
  ok('keys list shows the exported key, masked, on its own line', l.stdout.includes(`- [env] ${masked(ENV)}`), l.stdout);
  ok('and never raw', !l.stdout.includes(ENV));
  const lj = await cli(sc, ['keys', 'list', '--json'], { BRAVE_API_KEY: ENV });
  ok('keys list --json stays the stored state: the exported key is not in it, raw or masked',
    lj.status === 0 && !lj.stdout.includes(ENV) && !lj.stdout.includes(masked(ENV).slice(0, 6)));

  const d = await cli(sc, ['gate', '--json'], { BRAVE_API_KEY: STORED });
  eq('exporting a key that is already stored adds nothing', d.json && d.json.env_key_count, 0);
}

section('CLI: the stored key dies mid-run and exported keys take over, in memory');
{
  const sc = scenario({ keys: [STORED_DEAD] });
  let from = hits.length;
  const s = await cli(sc, ['search', 'rotation gamma', '--max', '1', '--json', '--no-cache'], { BRAVE_API_KEYS: `${ENV_DEAD},${ENV}` });
  eq('the search still succeeds: exit 0', s.status, 0, s.stderr);
  eq('requests went stored → exported dead → exported live', who(hits.slice(from).filter(x => x.q)), 'stored-dead,env-dead,env');
  const disk = sc.disk();
  eq('keys.json keeps exactly the stored key', disk.brave.keys.join(), STORED_DEAD);
  eq("the stored key's burn IS persisted", disk.brave.burned.map(b => b.index).join(), '0');
  ok('no burn, cooldown or verdict on disk points at an exported key', nothingPast(disk.brave, 1), JSON.stringify(disk.brave));
  ok('neither exported key is in keys.json', !sc.text().includes(ENV_DEAD) && !sc.text().includes(ENV));
  eq('current on disk still points at a stored key', disk.brave.current, 0);

  // Nothing about an exported key outlives the process, so the next run judges
  // the dead one again. That is the price of never writing it: one free probe.
  from = hits.length;
  const g = await cli(sc, ['gate', '--json'], { BRAVE_API_KEYS: `${ENV_DEAD},${ENV}` });
  eq('the next gate opens on the live exported key', g.json && `${g.json.key_index}|${g.json.key_source}`, '2|environment');
  eq('after probing the dead one again: its burn was never written', who(hits.slice(from)), 'env-dead,env');
}

section('CLI: a key that is only in ./.env is not read (library mode only)');
{
  const sc = scenario({ dotenv: `BRAVE_API_KEY=${ENV}\nBRAVE_API_KEYS=${ENV2}\n` });
  const from = hits.length;
  const g = await cli(sc, ['gate', '--json']);
  eq('gate exits 78: the CLI does not read ./.env', g.status, 78);
  eq('verdict missing', g.json && g.json.verdict, 'missing');
  ok('the message names what WAS checked, and says ./.env is library-only',
    g.json && /Checked: .*keys\.json, then \$BRAVE_API_KEY \/ \$BRAVE_API_KEYS \(\.\/\.env only in library mode\)/.test(g.json.message || ''),
    g.json && g.json.message);
  eq('key_source is null', g.json && g.json.key_source, null);
  eq('and no request went out', hits.length - from, 0);
  const s = await cli(sc, ['search', 'dotenv delta', '--json']);
  eq('a search exits 78 too', s.status, 78);
  ok('printing the same Checked line', s.stderr.includes('(./.env only in library mode)'), s.stderr);
  const found = await discoverKeys({ cwd: sc.cwd, skipConfigFile: true });
  ok('while the library API does read that .env', found.brave.includes(ENV) && found.brave.includes(ENV2), JSON.stringify(found.brave.map(masked)));
}

section('CLI: keys add still stores a key that is also exported');
{
  const sc = scenario();
  const a = await cli(sc, ['keys', 'add', '--provider', 'brave', ENV], { BRAVE_API_KEY: ENV });
  eq('keys add exits 0', a.status, 0, a.stdout + a.stderr);
  eq('the key IS written: keys add is the command that stores keys', sc.disk().brave.keys.join(), ENV);
  const from = hits.length;
  const g = await cli(sc, ['gate', '--json'], { BRAVE_API_KEY: ENV });
  eq('the gate now reads it from keys.json, with nothing left to append',
    g.json && `${g.json.key_index}|${g.json.key_source}|${g.json.env_key_count}`, '0|keys.json|0');
  eq('on the verdict keys add cached: no request', hits.length - from, 0);
}

// ------------------------------------------------------------- summary ---

server.closeAllConnections?.();
server.close();
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  process.stdout.write('\nASSERTIONS THAT MUST HOLD AND DID NOT:\n');
  for (const f of failures) process.stdout.write(`  ✗ ${f}\n`);
  process.exit(1);
}
process.stdout.write('env-keys-ok\n');
process.exit(0);
