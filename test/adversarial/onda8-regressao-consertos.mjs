#!/usr/bin/env node
// ONDA-8 REGRESSION suite — the auditoria fixes, one section each. Every
// assertion here pins a defect that WAS live (the audit's C1..C7,
// BASE-02/03/11/12) against the fix that landed, in the style of the other
// suites: HOME in a throwaway directory, zero network (subprocess probes run
// through test/fixtures/preload-mock-net.cjs, in-process fetch is stubbed),
// and no Brave/OpenRouter credit spent.
//
//   C1  cold start — concurrent first writes to keys.json must not erase
//       each other (6 `keys add --skip-validate` on an empty HOME used to
//       end with 1 of 6 keys on disk).
//   C2  `surf remove brave <i>` must reindex validated/cooldowns/burned and
//       shift `current` EXACTLY like `keys remove` (same seeded state, both
//       commands, one diff).
//   C3  `surf validate brave` must PERSIST the positive verdict it just
//       proved: a cached ok:false verdict kept the gate at 78
//       (BraveKeyInvalid) even after "✓ valid".
//   C4  a fetch timeout must report "Brave request exceeded <N>ms", never
//       "Brave network error: undefined" (abort with a real AbortError).
//   C7  snapshotForPersist (openrouter) must keep `validated`, or every
//       surf-ai save wipes the cached verdicts off keys.json.
//   BASE-02  `--search-mode normal` must send the SAME count as omitting the
//       flag (the tier's perSearchMax); slow keeps 20, fast keeps 5.
//   BASE-03  resolveHome() throws with HOME/USERPROFILE absent; harnessDirs()
//       never falls back to the passwd home.
//   BASE-12  ~/.dsh/skills is the 5th harness dir and installSkill/
//       uninstallSkill treat it like the other four.
//
// Run: node ./test/adversarial/onda8-regressao-consertos.mjs

import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..', '..');
const BIN = (n) => path.join(ROOT, 'bin', n);
const PRELOAD = path.resolve(path.dirname(SELF), '..', 'fixtures', 'preload-mock-net.cjs');

// ---------------------------------------------------------------- harness ---
if (!process.env.SURF_R8_CHILD) {
  // An exported key must not reach the child. The CLI and surf-ai use
  // BRAVE_API_KEY(S) / OPENROUTER_API_KEY(S) behind the stored keys, so a key
  // sitting in the developer's shell would change what this suite sees.
  const env = { ...process.env };
  for (const k of ['BRAVE_API_KEY', 'BRAVE_API_KEYS', 'OPENROUTER_API_KEY', 'OPENROUTER_API_KEYS']) delete env[k];
  const home = mkdtempSync(path.join(tmpdir(), 'surf-r8-'));
  mkdirSync(path.join(home, '.config', 'surf'), { recursive: true });
  mkdirSync(path.join(home, '.cache', 'surf'), { recursive: true });
  // A pre-validated fake Brave key: the preflight gate resolves from the
  // cache and the orchestrator sections never dial out.
  writeFileSync(path.join(home, '.config', 'surf', 'keys.json'), JSON.stringify({
    schema_version: 1,
    brave: {
      keys: ['brv-r8-seeded-key-0001'], current: 0, burned: [], cooldowns: [],
      validated: [{ index: 0, at: new Date().toISOString(), ok: true, status: 200, reason: null }],
    },
    openrouter: { keys: ['sk-or-v1-r8-seeded-0001'], current: 0, burned: [], cooldowns: [], validated: [] },
  }, null, 2));
  const r = spawnSync(process.execPath, [SELF], {
    stdio: 'inherit',
    env: {
      ...env,
      HOME: home,
      USERPROFILE: home,
      SURF_R8_CHILD: '1',
      SURF_QUIET: '1',
      SURF_BRAVE_API_BASE: 'https://brave.invalid/res/v1',
      SURF_OPENROUTER_BASE: 'https://openrouter.invalid/api/v1',
      SURF_NO_RATE_LIMIT: '1',
      SURF_NO_TIMEOUT: '1',
    },
  });
  try { rmSync(home, { recursive: true, force: true }); } catch {}
  process.exit(r.status === null ? 1 : r.status);
}

const HOME = homedir();
if (!String(HOME).startsWith(tmpdir())) {
  process.stderr.write(`REFUSING TO RUN — HOME=${HOME} is not under ${tmpdir()}\n`);
  process.exit(1);
}
// Belt and braces for the whole suite: nothing here may reach the real APIs.
for (const k of ['BRAVE_API_KEY', 'BRAVE_API_KEYS', 'OPENROUTER_API_KEY', 'OPENROUTER_API_KEYS']) {
  delete process.env[k];
}

const out = (s) => process.stdout.write(s);
let passed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; out(`  ✓ ${name}\n`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); out(`  ✗ ${name}${detail ? ' — ' + detail : ''}\n`); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t) { out(`\n${t}\n`); }
function withTimeout(p, ms, label) {
  let t;
  return Promise.race([
    p,
    new Promise((_, rej) => {
      t = setTimeout(() => rej(Object.assign(new Error(`TIMEOUT ${ms}ms: ${label}`), { code: 'TestTimeout' })), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

// A lab HOME for the subprocess probes: empty (no keys.json) unless seeded.
let labN = 0;
function labHome(label) {
  const d = mkdtempSync(path.join(tmpdir(), `surf-r8-${label}-`));
  mkdirSync(path.join(d, '.config', 'surf'), { recursive: true });
  mkdirSync(path.join(d, '.cache', 'surf'), { recursive: true });
  return d;
}
function seedKeys(home, brave) {
  writeFileSync(path.join(home, '.config', 'surf', 'keys.json'), JSON.stringify({
    schema_version: 1,
    last_ok_provider: null,
    brave: { keys: [], current: 0, burned: [], cooldowns: [], validated: [], ...brave },
    openrouter: { keys: [], current: 0, burned: [], cooldowns: [], validated: [] },
  }, null, 2));
}
function readKeys(home) {
  return JSON.parse(readFileSync(path.join(home, '.config', 'surf', 'keys.json'), 'utf8'));
}
/** Spawn a repo bin against a lab HOME. `mock` = a scripted fetch response
 *  file; without it the preload is a pure blocker, so any accidental network
 *  attempt fails loudly instead of spending a credit. */
function runBin(binName, args, home, { mockFile, input } = {}) {
  const nodeOptions = [process.env.NODE_OPTIONS, `--require ${JSON.stringify(PRELOAD)}`]
    .filter(Boolean).join(' ');
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    SURF_QUIET: '1',
    SURF_NO_RATE_LIMIT: '1',
    SURF_NO_TIMEOUT: '1',
    SURF_BRAVE_API_BASE: 'https://brave.invalid/res/v1',
    SURF_OPENROUTER_BASE: 'https://openrouter.invalid/api/v1',
    NODE_OPTIONS: nodeOptions,
  };
  if (mockFile) env.SURF_TEST_MOCK_FILE = mockFile;
  for (const k of ['BRAVE_API_KEY', 'BRAVE_API_KEYS', 'OPENROUTER_API_KEY', 'OPENROUTER_API_KEYS']) delete env[k];
  return spawnSync(process.execPath, [BIN(binName), ...args], { encoding: 'utf8', env, input, timeout: 60_000 });
}
const MASK = (s) => (typeof s === 'string' ? s.replace(/BSA-[a-z0-9-]+/g, 'BSA-…').replace(/brv-[a-z0-9-]+/g, 'brv-…') : s);

// ===========================================================================
// C4 — the timeout is a real AbortError and the message names the deadline
// ===========================================================================

section('C4: a fetch timeout reports "Brave request exceeded <N>ms" (never "network error: undefined")');
{
  const brave = await import('../../src/lib/providers/brave.mjs');
  let seenSignal = null;
  globalThis.fetch = (url, init = {}) => new Promise((_, rej) => {
    seenSignal = init.signal;
    // Never resolves: the adapter's own deadline is the only way out, exactly
    // like a dead endpoint behind a slow link.
    init.signal.addEventListener('abort', () => rej(init.signal.reason));
  });
  const TIMEOUT = 80;
  let caught = null;
  try {
    await withTimeout(
      brave.braveProvider.search({ query: 'timeout probe question' }, { key: 'brv-timeout-probe-0001', version: '8', timeout: TIMEOUT }),
      5_000, 'C4 timeout probe');
  } catch (e) { caught = e; }
  ok('the search rejects on its own deadline', caught !== null, 'the promise never settled');
  eq('the message names the deadline', caught && caught.message, `Brave request exceeded ${TIMEOUT}ms`);
  eq('and keeps the network kind (retry policy unchanged)', caught && caught.kind, 'network');
  ok('the message is never "network error: undefined"', !/undefined/.test(String(caught && caught.message)), MASK(String(caught && caught.message)));
  ok('the abort reason is a real Error named AbortError (e.name is reachable)',
    !!seenSignal && seenSignal.reason instanceof Error && seenSignal.reason.name === 'AbortError',
    seenSignal ? `reason: ${typeof seenSignal.reason}` : 'no signal seen');
  // Restore the ordinary stub for the in-process sections below.
  globalThis.fetch = async () => { throw new Error('R8 SUITE: unexpected network access'); };
}

// ===========================================================================
// C7 — snapshotForPersist keeps the openrouter validated cache
// ===========================================================================

section('C7: snapshotForPersist (openrouter) preserves validated');
{
  const { snapshotForPersist } = await import('../../src/lib/ai/openrouter.mjs');
  const { saveStateAtomic, loadState } = await import('../../src/lib/state.mjs');
  const st = {
    _inMemory: true,
    brave: { keys: ['brv-c7-000000000000001'], current: 0, burned: [], cooldowns: [], validated: [] },
    openrouter: {
      keys: ['sk-or-v1-c7-stored-00000001', 'sk-or-v1-c7-envkey-00000002'],
      current: 1,
      burned: [{ index: 1, at: new Date().toISOString(), reason: 'env key gone' }],
      cooldowns: [],
      validated: [
        { index: 0, at: new Date().toISOString(), ok: true, status: 200, reason: null },
        { index: 1, at: new Date().toISOString(), ok: false, status: 401, reason: 'env key verdict' },
      ],
      _storedKeyCount: 1, // only the FIRST key is stored; the tail came from the env
    },
  };
  const snap = snapshotForPersist(st);
  eq('a stored key\'s verdict survives the snapshot', (snap.openrouter.validated || []).length, 1);
  eq('and it is the stored key\'s entry', snap.openrouter.validated[0] && snap.openrouter.validated[0].index, 0);
  ok('an env-key verdict is still stripped (its key never reaches disk)',
    !(snap.openrouter.validated || []).some(v => v.index === 1));
  ok('the env key itself is still stripped too', snap.openrouter.keys.length === 1);

  // The full round trip a surf-ai run performs: persist() → keys.json.
  await saveStateAtomic(snap);
  const again = await loadState();
  eq('validated survives a surf-ai save on disk', (again.openrouter.validated || []).length, 1);
  eq('and keeps its verdict', again.openrouter.validated[0] && again.openrouter.validated[0].ok, true);
  eq('and the stored key is still there', again.openrouter.keys.length, 1);
  // This write went through the suite's own HOME, which the orchestrator
  // section below seeds with a validated Brave key. Put that seed back so the
  // sections stay independent.
  writeFileSync(path.join(HOME, '.config', 'surf', 'keys.json'), JSON.stringify({
    schema_version: 1,
    brave: {
      keys: ['brv-r8-seeded-key-0001'], current: 0, burned: [], cooldowns: [],
      validated: [{ index: 0, at: new Date().toISOString(), ok: true, status: 200, reason: null }],
    },
    openrouter: { keys: ['sk-or-v1-r8-seeded-0001'], current: 0, burned: [], cooldowns: [], validated: [] },
  }, null, 2));
}

// ===========================================================================
// BASE-12 — ~/.dsh/skills is the 5th harness dir, handled like the others
// ===========================================================================

section('BASE-12: ~/.dsh/skills is a harness dir the installer manages');
{
  const hi = await import('../../src/lib/harness-install.mjs');
  const dirs = hi.harnessDirs();
  eq('five harness dirs are resolved', dirs.length, 5);
  eq('the 5th is ~/.dsh/skills', dirs[4], path.join(HOME, '.dsh', 'skills'));
  eq('the boot snapshot agrees with harnessDirs()', hi.HARNESS_DIRS[4], dirs[4]);
  ok('the order of the other four is unchanged',
    JSON.stringify(dirs.slice(0, 4).map(d => d.slice(HOME.length + 1))) === JSON.stringify([
      path.join('.agents', 'skills'), path.join('.claude', 'skills'),
      path.join('.codex', 'skills'), path.join('.pi', 'agent', 'skills'),
    ]));

  const fake = path.join(mkdtempSync(path.join(tmpdir(), 'surf-r8-pkg-')), 'pkg');
  mkdirSync(path.join(fake, 'skills', 'surf-plan-agent-skill'), { recursive: true });
  mkdirSync(path.join(fake, 'skills', 'surf-search-agent-skill'), { recursive: true });
  writeFileSync(path.join(fake, 'SKILL.md'), '# root skill\n');
  writeFileSync(path.join(fake, 'skills', 'surf-plan-agent-skill', 'SKILL.md'), '# plan skill\n');
  writeFileSync(path.join(fake, 'skills', 'surf-search-agent-skill', 'SKILL.md'), '# search skill\n');

  const installed = await hi.installSkill(fake);
  eq('three skills into five harness dirs', installed.filter(r => r.action === 'symlinked').length, 15);
  eq('the .dsh dir received the root link', readlinkSync(path.join(HOME, '.dsh', 'skills', 'surf-research-agent-skill')), fake);
  eq('...and the subdir skills', readlinkSync(path.join(HOME, '.dsh', 'skills', 'surf-plan-agent-skill')), path.join(fake, 'skills', 'surf-plan-agent-skill'));

  const un = await hi.uninstallSkill(fake);
  eq('uninstall removes all fifteen of our links', un.filter(r => r.removed).length, 15);
  ok('the .dsh links are gone', !existsSync(path.join(HOME, '.dsh', 'skills', 'surf-research-agent-skill'))
    && !existsSync(path.join(HOME, '.dsh', 'skills', 'surf-plan-agent-skill')));
}

// ===========================================================================
// BASE-02 — `--search-mode normal` is wire-identical to omitting the flag
// ===========================================================================

section('BASE-02: --search-mode normal sends the tier count; slow keeps 20; fast keeps 5');
{
  // The harness mirrors loop-frontier.mjs: OpenRouter is a scripted chat stub,
  // Brave answers a canned result list, and the run's knobs come from opts.
  const jsonResponse = (status, body) => ({
    ok: status >= 200 && status < 300, status, headers: new Map(), text: async () => JSON.stringify(body),
  });
  const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h).toString(36); };
  const braveHit = (query, i) => ({
    url: `https://example.com/${hash(query)}/${i}`,
    title: `Result ${i} for ${query}`,
    description: `Body text for ${query} number ${i}. `.repeat(6),
    extra_snippets: [`Extra excerpt ${i}.`],
    page_age: '2026-07-01T00:00:00',
    age: 'July 1, 2026',
  });
  let orScript = [];
  let braveCalls = [];
  const orChat = (content) => () => jsonResponse(200, {
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { total_tokens: 100, cost: 0.0001 },
    model: 'deepseek/deepseek-v4-pro',
  });
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('openrouter') && u.endsWith('/key')) {
      return jsonResponse(200, { data: { label: 'r8', limit: null, usage: 0, is_free_tier: false } });
    }
    if (u.includes('openrouter') && u.includes('/chat/completions')) {
      // Safety net so an under-provisioned script never triggers OpenRouter's
      // retry ladder (which would add seconds of backoff and prove nothing) —
      // the same guard loop-frontier.mjs runs behind.
      const next = orScript.shift() || orDefault;
      if (!next) throw new Error('r8 stub exhausted');
      return next(JSON.parse(init.body || '{}'));
    }
    if (u.includes('brave')) {
      const params = new URL(u).searchParams;
      braveCalls.push({ count: params.get('count'), q: params.get('q') });
      return jsonResponse(200, {
        query: { original: params.get('q') || '', more_results_available: false },
        web: { results: [braveHit(params.get('q') || '', 1), braveHit(params.get('q') || '', 2)] },
      });
    }
    throw new Error(`unexpected fetch to ${u}`);
  };
  const ANALYSIS_DONE = JSON.stringify({
    resolved: true, confidence: 'high', coverage: [], open_points: [],
    next_queries: [], branches_to_close: [], saturation: false, stop_reason: 'criteria met',
  });
  const PLAN_1Q = JSON.stringify({
    restated_objective: 'objective',
    sub_questions: [{ id: 'sq1', question: 'core', why: 'core' }],
    queries: [{ id: 'q1', q: 'r8 seed question alpha', sub: 'sq1', category: 'official-docs', priority: 0.9 }],
    success_criteria: ['a primary source confirms it'],
  });
  const autoReply = (body) => {
    const name = body.response_format && body.response_format.json_schema && body.response_format.json_schema.name;
    if (name === 'surf_ai_plan') return orChat(PLAN_1Q)(body);
    if (name === 'surf_ai_analysis') return orChat(ANALYSIS_DONE)(body);
    return orChat('# Answer\nauto-generated stub answer [1].')(body);
  };
  const orDefault = autoReply;
  const { runSurfAi } = await import('../../src/lib/ai/orchestrator.mjs');
  const run = async (label, opts) => {
    braveCalls = [];
    orScript = [orChat(PLAN_1Q), orChat('# Answer\nDone [1].')];
    await withTimeout(runSurfAi({ question: `r8 ${label}` }, { mode: 'normal', ...opts, flags: { 'no-cache': true } }), 25_000, label);
    return braveCalls[0] || {};
  };
  const omitted = await run('omitted', {});
  eq('omitting --search-mode sends the tier default count', omitted.count, '5');
  const normal = await run('search-mode normal', { searchMode: 'normal' });
  eq('--search-mode normal sends the SAME count as omitting it', normal.count, omitted.count);
  const slow = await run('search-mode slow', { searchMode: 'slow' });
  eq('--search-mode slow keeps the adapter\'s 20', slow.count, '20');
  const fast = await run('search-mode fast', { searchMode: 'fast' });
  eq('--search-mode fast keeps the adapter\'s 5', fast.count, '5');
  const maxWins = await run('search-mode + max', { searchMode: 'slow', max: 3 });
  eq('an explicit --max still beats --search-mode', maxWins.count, '3');
  globalThis.fetch = async () => { throw new Error('R8 SUITE: unexpected network access'); };
}

// ===========================================================================
// BASE-03 — resolveHome() refuses to guess; harnessDirs() never hits passwd
// ===========================================================================

section('BASE-03: resolveHome() throws with HOME and USERPROFILE absent');
{
  const hi = await import('../../src/lib/harness-install.mjs');
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  let resolveErr = null;
  try { hi.resolveHome(); } catch (e) { resolveErr = e; }
  ok('resolveHome() throws when HOME and USERPROFILE are absent', resolveErr !== null);
  ok('...and the message names HOME (misconfiguration fails loud)', resolveErr && /HOME/.test(resolveErr.message), resolveErr && resolveErr.message);
  let dirsErr = null;
  try { hi.harnessDirs(); } catch (e) { dirsErr = e; }
  ok('harnessDirs() does not fall back to the passwd home either', dirsErr !== null);
  ok('...with the same refusal', dirsErr && /HOME/.test(dirsErr.message), dirsErr && dirsErr.message);
  process.env.HOME = savedHome;
  if (savedProfile) process.env.USERPROFILE = savedProfile;

  // Grandchild with a scrubbed environment: the module must IMPORT fine (the
  // boot-time constant keeps the passwd fallback so a bare import never
  // throws), but both write paths must refuse.
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const m = await import(${JSON.stringify(new URL('../../src/lib/harness-install.mjs', import.meta.url).href)});
    const res = { imported: true, bootDirs: m.HARNESS_DIRS.length };
    try { m.harnessDirs(); res.threw = false; } catch (e) { res.threw = true; res.msg = String(e.message); }
    process.stdout.write(JSON.stringify(res));
  `], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  let v = null;
  try { v = JSON.parse(String(probe.stdout).trim()); } catch { v = null; }
  ok('the module still imports with HOME unset (the boot snapshot stays import-safe)', !!(v && v.imported), MASK(String(probe.stderr).slice(0, 200)));
  ok('with HOME unset harnessDirs() refuses instead of resolving the real home', !!(v && v.threw), v ? String(v.msg) : 'no output');
  ok('...and names HOME in the refusal', !!(v && /HOME/.test(String(v.msg))), v ? String(v.msg) : 'no output');
  eq('the boot snapshot still lists five dirs (import-time shape unchanged)', v && v.bootDirs, 5);
}

// ===========================================================================
// C1 — the cold start: concurrent first writes must not erase each other
// ===========================================================================

section('C1: 6 concurrent `keys add --skip-validate` on an EMPTY HOME all land in keys.json');
{
  const home = labHome('c1');
  const KEYS = Array.from({ length: 6 }, (_, i) => `BSA-c1-${String(i).padStart(4, '0')}-00000000000000`);
  const nodeOptions = [process.env.NODE_OPTIONS, `--require ${JSON.stringify(PRELOAD)}`].filter(Boolean).join(' ');
  const mkEnv = () => {
    const env = {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home,
      SURF_QUIET: '1', SURF_NO_RATE_LIMIT: '1', SURF_NO_TIMEOUT: '1',
      SURF_BRAVE_API_BASE: 'https://brave.invalid/res/v1', NODE_OPTIONS: nodeOptions,
    };
    for (const k of ['BRAVE_API_KEY', 'BRAVE_API_KEYS', 'OPENROUTER_API_KEY', 'OPENROUTER_API_KEYS']) delete env[k];
    return env;
  };
  const t0 = Date.now();
  // All six start at once: the race window is the first save, not the spawn.
  const kids = KEYS.map((key) => spawn(process.execPath, [
    BIN('surf-research-skill.mjs'), 'keys', 'add', '--provider', 'brave', '--skip-validate', key,
  ], { env: mkEnv(), stdio: ['ignore', 'pipe', 'pipe'] }));
  const done = await Promise.all(kids.map((k) => new Promise((resolve) => {
    let o = '', e = '';
    k.stdout.on('data', (d) => { o += d; });
    k.stderr.on('data', (d) => { e += d; });
    k.on('close', (code) => resolve({ code, o, e }));
    k.on('error', (err) => resolve({ code: -1, o: '', e: String(err) }));
  })));
  const ms = Date.now() - t0;
  ok('all six adds exited 0 and each reported 1/1 added',
    done.every((d) => d.code === 0 && /1\/1 key\(s\) added to brave\./.test(d.o)),
    done.map((d, i) => `#${i} rc=${d.code} ${MASK(String(d.e).slice(0, 80))}`).join(' | ').slice(0, 400));
  const finalState = readKeys(home);
  eq('ALL six keys are in keys.json (was 1/6 on the blind cold start)', finalState.brave.keys.length, 6);
  ok('and they are exactly the six requested (no dupes, none missing)',
    JSON.stringify([...finalState.brave.keys].sort()) === JSON.stringify([...KEYS].sort()));
  for (const f of done) if (f.code !== 0) out(`      stderr: ${MASK(String(f.e).slice(0, 200))}\n`);
  rmSync(home, { recursive: true, force: true });
  out(`      (wall ${ms}ms for 6 concurrent adds)\n`);
}

// ===========================================================================
// C2 — `surf remove` and `keys remove` leave the SAME bookkeeping behind
// ===========================================================================

section('C2: `surf remove brave <i>` reindexes exactly like `keys remove` (same seeded state)');
{
  // 3 keys, current at 2, burn on #1, cooldown on #2, one verdict per index —
  // every list has something to shift, and `current` sits ABOVE the removal.
  // Verdict timestamps are FRESH: the 7-day validation TTL prunes an expired
  // entry on load, and a pruned seed would test nothing.
  const now = new Date().toISOString();
  const seed = () => ({
    keys: ['BSA-c2-aaa-0000000000000001', 'BSA-c2-bbb-0000000000000002', 'BSA-c2-ccc-0000000000000003'],
    current: 2,
    burned: [{ index: 1, at: now, reason: '422' }],
    cooldowns: [{ index: 2, until: '2099-01-01T00:00:00.000Z' }],
    validated: [
      { index: 0, at: now, ok: true, status: 200, reason: null },
      { index: 1, at: now, ok: false, status: 401, reason: 'invalid token' },
      { index: 2, at: now, ok: true, status: 200, reason: null },
    ],
  });
  const pair = async (idx, expect) => {
    const surfHome = labHome('c2-surf');
    const keysHome = labHome('c2-keys');
    seedKeys(surfHome, seed());
    seedKeys(keysHome, seed());
    const a = runBin('surf.mjs', ['remove', 'brave', String(idx)], surfHome);
    const b = runBin('surf-research-skill.mjs', ['keys', 'remove', '--provider', 'brave', String(idx)], keysHome);
    ok(`remove #${idx}: both commands succeeded`,
      a.status === 0 && b.status === 0,
      `surf rc=${a.status} (${String(a.stderr).slice(0, 120)}) keys rc=${b.status} (${String(b.stderr).slice(0, 120)})`);
    const sa = readKeys(surfHome).brave;
    const sb = readKeys(keysHome).brave;
    ok(`remove #${idx}: both commands leave the SAME bookkeeping`,
      JSON.stringify(sa) === JSON.stringify(sb),
      'the two brave sections differ — comparing shapes only (counts follow)');
    eq(`remove #${idx}: two keys remain`, sa.keys.length, 2);
    eq(`remove #${idx}: current shifts instead of resetting to 0`, sa.current, expect.current);
    eq(`remove #${idx}: the burn follows its key`, sa.burned.map(x => x.index).join(','), expect.burned);
    eq(`remove #${idx}: the cooldown follows its key`, sa.cooldowns.map(x => x.index).join(','), expect.cooldowns);
    eq(`remove #${idx}: every verdict follows its key (ok flags)`,
      sa.validated.map(x => x.ok).join(','), expect.validatedOk);
    ok(`remove #${idx}: no verdict is orphaned past the last key`,
      sa.validated.every(x => x.index >= 0 && x.index < sa.keys.length));
    rmSync(surfHome, { recursive: true, force: true });
    rmSync(keysHome, { recursive: true, force: true });
  };
  // Removing #0 (below current): current 2 → 1; verdicts/burn/cooldown shift −1.
  await pair(0, { current: 1, burned: '0', cooldowns: '1', validatedOk: 'false,true' });
  // Removing #2 (AT current): current runs off the end → 0.
  await pair(2, { current: 0, burned: '1', cooldowns: '', validatedOk: 'true,false' });
}

// ===========================================================================
// C3 — `surf validate brave` persists the verdict it just proved
// ===========================================================================

section('C3: `surf validate brave` with a cached ok:false verdict unlocks the gate');
{
  const home = labHome('c3');
  seedKeys(home, {
    keys: ['BSA-c3-seeded-0000000000000001'],
    current: 0,
    validated: [{ index: 0, at: new Date().toISOString(), ok: false, status: 401, reason: 'stale cached verdict' }],
  });
  const mock = path.join(home, 'mock-brave.json');
  // A q-less probe answered 422 VALIDATION is Brave proving the key is GOOD —
  // the same body the real API sends, and the same one the in-process suites stub.
  writeFileSync(mock, JSON.stringify([{ status: 422, body: { error: { code: 'VALIDATION', meta: { errors: [{ loc: ['query', 'q'], msg: 'query is required' }] } } } }]));

  const before = runBin('surf-research-skill.mjs', ['gate'], home);
  eq('before: the gate is 78 (BraveKeyInvalid) off the stale cache', before.status, 78);
  ok('...with the stable code', /BraveKeyInvalid/.test(String(before.stderr)), String(before.stderr).slice(0, 120));

  const v = runBin('surf.mjs', ['validate', 'brave'], home, { mockFile: mock });
  eq('`surf validate brave` succeeds against the mock', v.status, 0, String(v.stderr).slice(0, 200));
  ok('...and reports the key as valid', /✓ valid/.test(String(v.stdout)), String(v.stdout).slice(0, 120));

  const after = readKeys(home).brave;
  ok('the positive verdict was PERSISTED to keys.json', (after.validated || []).some(x => x.ok === true),
    `validated ok flags: ${(after.validated || []).map(x => x.ok).join(',')}`);
  eq('...for the right key', (after.validated || []).find(x => x.ok === true)?.index, 0);

  const gate = runBin('surf-research-skill.mjs', ['gate'], home);
  eq('after: the gate exits 0 (was 78 BraveKeyInvalid forever)', gate.status, 0);
  ok('...as a READY gate', /✓ Brave gate OK/.test(String(gate.stdout)), String(gate.stdout).slice(0, 120));
  rmSync(home, { recursive: true, force: true });
}

// --------------------------------------------------------------- summary ---

section('summary');
out(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) out(`  ✗ ${f}\n`);
  process.exit(1);
}
out('onda8-regressao-consertos-ok\n');
