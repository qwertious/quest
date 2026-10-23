"use strict";

/**
 * netcheck: the probes against local fake servers, and the verdict logic
 * against synthetic measurements for every failure mode it claims to spot.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { startBlackhole, refusedPort, QUEST_DIR } = require("./helpers");
const { probeTcp, probeTlsAndByte, diagnose, layerOf } = require(path.join(QUEST_DIR, "netcheck"));

describe("probes", () => {
  test("a refused port fails fast at the TCP layer", async () => {
    const r = await probeTcp("127.0.0.1", await refusedPort(), 4, 3000);
    assert.strictEqual(r.ok, false);
    assert.match(String(r.error), /ECONNREFUSED/);
    assert.ok(r.ms < 2000, `took ${r.ms}ms`);
  });

  test("a host that accepts and never speaks passes TCP, stalls at TLS", async () => {
    const bh = await startBlackhole();
    const tcp = await probeTcp("127.0.0.1", bh.port, 4, 3000);
    assert.strictEqual(tcp.ok, true);

    const started = Date.now();
    const tls = await probeTlsAndByte("127.0.0.1", "localhost", 4, { port: bh.port, tlsTimeoutMs: 600 });
    assert.strictEqual(tls.ok, false);
    assert.strictEqual(tls.stage, "tls");
    assert.ok(Date.now() - started < 3000, "the stall was not bounded by the timeout");
    await bh.close();
  });
});

// ---- synthetic measurements --------------------------------------------------

const okDns = (ms = 15) => ({
  lookup: { ok: true, ms, value: ["1.2.3.4"] },
  a: { ok: true, ms, value: ["1.2.3.4"] },
  aaaa: { ok: true, ms, value: ["2001:db8::1"] },
});

const fam = {
  ok: () => ({ address: "x", tcp: { ok: true, ms: 20 }, tls: { ok: true, stage: "done", tlsMs: 40, byteMs: 30 } }),
  tlsStall: () => ({ address: "x", tcp: { ok: true, ms: 20 }, tls: { ok: false, stage: "tls", error: "handshake stalled" } }),
  tcpHang: () => ({ address: "x", tcp: { ok: false, ms: 6000, error: "connect timed out" } }),
  tcpInstant: () => ({ address: "x", tcp: { ok: false, ms: 1, error: "ENETUNREACH" } }),
};

const host = (name, v4, v6, dns = okDns()) => ({ hostname: name, dns, families: { 4: v4, 6: v6 } });

const healthyEnv = { mtu: { eth0: 1500 }, conntrack: null, beancounterFailures: null };
const titles = (r) => r.findings.map((f) => `${f.severity}:${f.title}`);
const has = (r, severity, pattern) =>
  r.findings.some((f) => f.severity === severity && pattern.test(f.title));

describe("verdict", () => {
  test("everything healthy -> ok, nothing alarming", () => {
    const reference = [1, 2, 3, 4].map((i) => host(`h${i}`, fam.ok(), fam.ok()));
    const r = diagnose({ env: healthyEnv, reference });
    assert.ok(has(r, "ok", /No network problem/), titles(r).join(" | "));
    assert.ok(!r.findings.some((f) => f.severity === "critical" || f.severity === "high"));
  });

  test("TCP connects but TLS never completes -> MTU / middlebox", () => {
    const reference = [1, 2, 3, 4].map((i) => host(`h${i}`, fam.tlsStall(), fam.tlsStall()));
    const r = diagnose({ env: healthyEnv, reference });
    assert.ok(has(r, "critical", /TLS stalls/), titles(r).join(" | "));
    assert.match(r.findings[0].action, /mtu 1400/, "should suggest the MTU experiment");
    assert.match(r.findings[0].action, /eth0/, "should name the real interface");
  });

  test("TCP never completes on IPv4 -> outbound blocked", () => {
    const reference = [1, 2, 3, 4].map((i) => host(`h${i}`, fam.tcpHang(), fam.tcpHang()));
    const r = diagnose({ env: healthyEnv, reference });
    assert.ok(has(r, "critical", /Outbound connections are being dropped/), titles(r).join(" | "));
  });

  test("IPv6 hangs while IPv4 works -> force IPv4", () => {
    const reference = [1, 2, 3, 4].map((i) => host(`h${i}`, fam.ok(), fam.tcpHang()));
    const r = diagnose({ env: healthyEnv, reference });
    assert.ok(has(r, "high", /IPv6 hangs/), titles(r).join(" | "));
    assert.match(r.findings.find((f) => /IPv6 hangs/.test(f.title)).action, /QUEST_FORCE_IPV4=true/);
  });

  test("IPv6 refused instantly -> harmless, NOT a recommendation to change anything", () => {
    const reference = [1, 2, 3, 4].map((i) => host(`h${i}`, fam.ok(), fam.tcpInstant()));
    const r = diagnose({ env: healthyEnv, reference });
    assert.ok(has(r, "info", /fails instantly/), titles(r).join(" | "));
    assert.ok(has(r, "ok", /No network problem/));
    assert.ok(!r.findings.some((f) => f.severity === "high"), "over-alarmed on harmless IPv6");
  });

  test("slow DNS is caught even when every connection works", () => {
    const reference = [1, 2, 3, 4].map((i) => host(`h${i}`, fam.ok(), fam.ok(), okDns(4000)));
    const r = diagnose({ env: healthyEnv, reference });
    assert.ok(has(r, "critical", /DNS lookups are slow/), titles(r).join(" | "));
  });

  test("failing DNS is caught", () => {
    const badDns = { lookup: { ok: false, ms: 10000, error: "TIMEOUT" }, a: { ok: false }, aaaa: { ok: false } };
    const reference = [1, 2, 3, 4].map((i) => ({
      hostname: `h${i}`,
      dns: badDns,
      families: { 4: { skipped: "dns" }, 6: { skipped: "dns" } },
    }));
    const r = diagnose({ env: healthyEnv, reference });
    assert.ok(has(r, "critical", /DNS lookups are failing/), titles(r).join(" | "));
  });

  test("a full conntrack table is flagged", () => {
    const reference = [host("h1", fam.ok(), fam.ok())];
    const r = diagnose({ env: { ...healthyEnv, conntrack: { count: 65000, max: 65536 } }, reference });
    assert.ok(has(r, "critical", /Connection-tracking table/), titles(r).join(" | "));
  });

  test("OpenVZ limit failures are flagged by name", () => {
    const reference = [host("h1", fam.ok(), fam.ok())];
    const env = { ...healthyEnv, beancounterFailures: [{ resource: "numtcpsock", failcnt: 812 }] };
    const r = diagnose({ env, reference });
    const f = r.findings.find((x) => /OpenVZ/.test(x.title));
    assert.ok(f && f.severity === "critical");
    assert.match(f.detail, /numtcpsock=812/);
  });

  test("healthy box, dead targets -> says the queue is the problem, not the machine", () => {
    const reference = [1, 2, 3, 4].map((i) => host(`h${i}`, fam.ok(), fam.ok()));
    const sampled = [1, 2, 3, 4].map((i) => host(`dead${i}`, fam.tcpHang(), { skipped: "no address" }));
    const r = diagnose({ env: healthyEnv, reference, sampled });
    assert.ok(has(r, "info", /failing hosts are the problem/), titles(r).join(" | "));
  });

  test("layerOf reads the stage a probe stopped at", () => {
    assert.strictEqual(layerOf(fam.ok()), "ok");
    assert.strictEqual(layerOf(fam.tlsStall()), "tls");
    assert.strictEqual(layerOf(fam.tcpHang()), "tcp");
    assert.strictEqual(layerOf({ skipped: "no address" }), "skipped");
  });
});
