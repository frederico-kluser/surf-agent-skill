'use strict';
// Zero-network preload for the test suites: load it with
//   NODE_OPTIONS="--require test/fixtures/preload-zero-rede.cjs"
// and any real network attempt fails loudly instead of spending Brave quota.
//
// It used to live only in /tmp/surf-audit-20260830/, where the audit created
// it by hand. /tmp is wiped on reboot, so `npm test` went red for everyone who
// was not inside that sandbox. It is versioned here now, and the suites point
// at this path themselves.
//
// It serves BOTH counter interfaces the onda7 suites read:
//   onda7-regressao-superficie: globalThis.__SURF_NET_COUNTERS__ = { connects, lookups, fetches }
//   onda7-regressao-nucleo:     globalThis.__zeroRedeNetwork.counts() → { sockets, dns, fetches }
//
// net.Socket.prototype.connect and dns.lookup / dns.promises.lookup are counted
// and refused without opening anything; globalThis.fetch throws. Suites install
// their own fetch stub on top of this one, so this is only the wire guard.

const net = require('node:net');
const dns = require('node:dns');

const counters = { connects: 0, lookups: 0, fetches: 0 };

net.Socket.prototype.connect = function zeroRedeConnect() {
  counters.connects++;
  const err = new Error('[zero-rede] real network connect blocked by test/fixtures/preload-zero-rede.cjs');
  err.code = 'ENETUNREACH';
  queueMicrotask(() => this.emit('error', err));
  return this;
};

dns.lookup = function zeroRedeLookup(...args) {
  counters.lookups++;
  const err = new Error('[zero-rede] dns.lookup blocked by test/fixtures/preload-zero-rede.cjs');
  err.code = 'ENOTFOUND';
  const cb = args[args.length - 1];
  if (typeof cb === 'function') { queueMicrotask(() => cb(err)); return; }
  throw err;
};
if (dns.promises && typeof dns.promises.lookup === 'function') {
  dns.promises.lookup = async function zeroRedeLookupPromise() {
    counters.lookups++;
    const err = new Error('[zero-rede] dns.promises.lookup blocked by test/fixtures/preload-zero-rede.cjs');
    err.code = 'ENOTFOUND';
    throw err;
  };
}

globalThis.fetch = async function zeroRedeFetch() {
  counters.fetches++;
  throw new Error('[zero-rede] real fetch blocked by test/fixtures/preload-zero-rede.cjs');
};

globalThis.__SURF_NET_COUNTERS__ = counters;
globalThis.__zeroRedeNetwork = {
  counts() {
    return { sockets: counters.connects, dns: counters.lookups, fetches: counters.fetches };
  },
};
