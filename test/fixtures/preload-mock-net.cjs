'use strict';
// Zero-network fetch mock for SUBPROCESS probes (bin/surf.mjs,
// bin/surf-research-skill.mjs), installed before the app loads:
//
//   NODE_OPTIONS="--require <repo>/test/fixtures/preload-mock-net.cjs"
//
//   · $SURF_TEST_MOCK_FILE set → every fetch is answered from that JSON file:
//     an array of { status, body | raw } consumed in order; the LAST entry
//     repeats once the script runs out. `body` is serialised as JSON; `raw`
//     is sent as-is (a text/plain body).
//   · otherwise → BLOCKER: any fetch throws. A probe that was supposed to
//     stay offline then fails loudly instead of spending a Brave credit.
//
// The response is the same shape the in-process suites stub — { ok, status,
// headers: Map, text() } — the only surface brave.mjs and openrouter.mjs use.
// api.search.brave.com and openrouter.ai are NEVER reached from here.

const fs = require('node:fs');

const scriptFile = process.env.SURF_TEST_MOCK_FILE;
let script = [];
if (scriptFile) {
  try {
    script = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
    if (!Array.isArray(script) || !script.length) script = [];
  } catch (e) {
    process.stderr.write(`[preload-mock-net] unreadable mock script ${scriptFile}: ${e.message}\n`);
  }
}
let served = 0;

globalThis.fetch = async (url) => {
  const entry = script.length ? script[Math.min(served, script.length - 1)] : null;
  served++;
  if (!entry) {
    throw new Error(`[preload-mock-net] network is forbidden in this test (fetch to ${String(url).slice(0, 80)}; no SURF_TEST_MOCK_FILE)`);
  }
  const status = Number.isInteger(entry.status) ? entry.status : 200;
  const text = entry.raw != null ? String(entry.raw) : JSON.stringify(entry.body ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(Object.entries(entry.headers || {})),
    text: async () => text,
  };
};
