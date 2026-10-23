"use strict";

/**
 * QUEST network diagnostic. Run it on the machine the crawler runs on:
 *
 *   node netcheck.js              full check, including hosts from the queue
 *   node netcheck.js --quick      reference hosts only, skip the database
 *   node netcheck.js --hosts a.com,b.org   probe specific hosts too
 *
 * A fetch passes through four layers -- DNS, TCP connect, TLS handshake, first
 * response byte -- and each one breaking points at a different cause. This
 * times every layer separately, over IPv4 and IPv6 separately, so the output
 * says *where* things stop instead of just "timeout".
 *
 * Read-only: the database is opened read-only and nothing is written. It makes
 * a few dozen requests in total, to large reference sites plus a small sample
 * of hosts from the crawl queue.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dns = require("node:dns");
const net = require("node:net");
const tls = require("node:tls");

const TCP_TIMEOUT_MS = 6000;
const TLS_TIMEOUT_MS = 8000;
const BYTE_TIMEOUT_MS = 8000;
const DNS_TIMEOUT_MS = 10000;
const SLOW_DNS_MS = 1000;

// Chosen for contrast, not just popularity: github.com publishes no IPv6
// address, the others are dual-stack, and 1.1.1.1 needs no DNS at all.
const REFERENCE_HOSTS = [
  "example.com",
  "www.google.com",
  "www.cloudflare.com",
  "en.wikipedia.org",
  "github.com",
];

const DATA_DIR = process.env.QUEST_DATA_DIR || path.join(__dirname, "data");
const DB_PATH = process.env.QUEST_DB_PATH || path.join(DATA_DIR, "quest.sqlite");

// ------------------------------------------------------------------ helpers

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { code: "TIMEOUT" })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

const ms = (n) => (n === null || n === undefined ? "-" : `${Math.round(n)}ms`);
const pad = (s, n) => String(s).padEnd(n);

// ------------------------------------------------------------------- probes

/** Open a TCP connection to an address and close it. */
function probeTcp(address, port, family, timeoutMs = TCP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host: address, port, family });
    const finish = (result) => {
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.destroy();
      resolve({ ...result, ms: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish({ ok: true }));
    socket.once("timeout", () => finish({ ok: false, error: "connect timed out" }));
    socket.once("error", (e) => finish({ ok: false, error: e.code || e.message }));
  });
}

/**
 * TLS handshake, then one HTTP request, timing each stage. A handshake that
 * never completes after a successful TCP connect is the signature this whole
 * tool exists to catch: it means packets flow one way and stall the other.
 */
function probeTlsAndByte(address, servername, family, opts = {}) {
  const tlsTimeout = opts.tlsTimeoutMs ?? TLS_TIMEOUT_MS;
  const byteTimeout = opts.byteTimeoutMs ?? BYTE_TIMEOUT_MS;
  const port = opts.port ?? 443;

  return new Promise((resolve) => {
    const started = Date.now();
    let stage = "tls";
    let tlsMs = null;
    let timer;

    const socket = tls.connect({
      host: address,
      port,
      family,
      servername: net.isIP(servername) ? undefined : servername,
      // The question is whether the handshake completes, not whether the
      // certificate is valid -- a cert error still proves packets flowed.
      rejectUnauthorized: false,
      ALPNProtocols: ["http/1.1"],
    });

    const finish = (result) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.destroy();
      resolve({ tlsMs, byteMs: stage === "done" ? Date.now() - started - tlsMs : null, ...result });
    };

    timer = setTimeout(() => finish({ ok: false, stage: "tls", error: "handshake stalled" }), tlsTimeout);

    socket.once("secureConnect", () => {
      tlsMs = Date.now() - started;
      stage = "byte";
      clearTimeout(timer);
      timer = setTimeout(() => finish({ ok: false, stage: "byte", error: "no response" }), byteTimeout);
      socket.write(
        `GET / HTTP/1.1\r\nHost: ${servername}\r\nUser-Agent: QUEST-netcheck\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.once("data", () => {
      stage = "done";
      finish({ ok: true, stage: "done" });
    });
    socket.once("error", (e) => finish({ ok: false, stage, error: e.code || e.message }));
  });
}

/** Plain HTTP on port 80, to separate "TLS is broken" from "everything is". */
function probeHttp(address, hostname, family) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host: address, port: 80, family });
    let connected = false;
    const timer = setTimeout(() => finish({ ok: false, error: connected ? "no response" : "connect timed out" }), TCP_TIMEOUT_MS + BYTE_TIMEOUT_MS);
    function finish(result) {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.destroy();
      resolve({ ...result, ms: Date.now() - started });
    }
    socket.once("connect", () => {
      connected = true;
      socket.write(`GET / HTTP/1.1\r\nHost: ${hostname}\r\nUser-Agent: QUEST-netcheck\r\nConnection: close\r\n\r\n`);
    });
    socket.once("data", () => finish({ ok: true }));
    socket.once("error", (e) => finish({ ok: false, error: e.code || e.message }));
  });
}

async function timeDns(label, fn) {
  const started = Date.now();
  try {
    const value = await withTimeout(fn(), DNS_TIMEOUT_MS, label);
    return { ok: true, ms: Date.now() - started, value };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: e.code || e.message };
  }
}

/** Resolve a host every way the crawler might, and probe each family. */
async function probeHost(hostname, { stages = true } = {}) {
  const result = { hostname, dns: {}, families: {} };

  result.dns.lookup = await timeDns("dns.lookup", () =>
    dns.promises.lookup(hostname, { all: true }).then((rows) => rows.map((r) => `${r.address}`)),
  );
  result.dns.a = await timeDns("resolve4", () => dns.promises.resolve4(hostname));
  result.dns.aaaa = await timeDns("resolve6", () => dns.promises.resolve6(hostname));

  if (!stages) return result;

  for (const [family, record] of [[4, result.dns.a], [6, result.dns.aaaa]]) {
    if (!record.ok || !record.value?.length) {
      result.families[family] = { skipped: record.ok ? "no address" : `dns: ${record.error}` };
      continue;
    }
    const address = record.value[0];
    const tcp = await probeTcp(address, 443, family);
    const probe = { address, tcp };
    if (tcp.ok) {
      probe.tls = await probeTlsAndByte(address, hostname, family);
    }
    result.families[family] = probe;
  }
  return result;
}

/** The layer a probe stopped at: "ok", "tcp", "tls", "byte", or "skipped". */
function layerOf(familyResult) {
  if (!familyResult || familyResult.skipped) return "skipped";
  if (!familyResult.tcp.ok) return "tcp";
  if (!familyResult.tls) return "tcp";
  if (familyResult.tls.ok) return "ok";
  return familyResult.tls.stage === "byte" ? "byte" : "tls";
}

// -------------------------------------------------------------- environment

function inspectEnvironment() {
  const env = {
    node: process.version,
    platform: `${process.platform} ${os.release()} ${process.arch}`,
    threadpool: process.env.UV_THREADPOOL_SIZE || "4 (default)",
    autoSelectFamily: typeof net.getDefaultAutoSelectFamily === "function" ? net.getDefaultAutoSelectFamily() : "n/a",
    forceIpv4: process.env.QUEST_FORCE_IPV4 || "unset",
    linux: process.platform === "linux",
  };

  const resolv = readText("/etc/resolv.conf");
  env.nameservers = resolv
    ? resolv.split("\n").filter((l) => /^\s*nameserver\s/.test(l)).map((l) => l.trim().split(/\s+/)[1])
    : null;
  env.resolvOptions = resolv ? resolv.split("\n").filter((l) => /^\s*options\s/.test(l)).map((l) => l.trim()) : null;

  env.mtu = {};
  try {
    for (const iface of fs.readdirSync("/sys/class/net")) {
      const mtu = readText(`/sys/class/net/${iface}/mtu`);
      if (mtu) env.mtu[iface] = Number(mtu.trim());
    }
  } catch {
    env.mtu = null;
  }

  const ctCount = readText("/proc/sys/net/netfilter/nf_conntrack_count");
  const ctMax = readText("/proc/sys/net/netfilter/nf_conntrack_max");
  env.conntrack = ctCount && ctMax ? { count: Number(ctCount), max: Number(ctMax) } : null;

  // OpenVZ containers (common on budget VPS) enforce per-container limits on
  // sockets and buffers; a non-zero failcnt means one has been hit.
  // Rows are "[uid:] resource held maxheld barrier limit failcnt"; only the
  // first row carries the uid, so count columns from the end.
  const beancounters = readText("/proc/user_beancounters");
  env.beancounterFailures = beancounters
    ? beancounters
        .split("\n")
        .slice(2)
        .map((l) => l.trim().split(/\s+/))
        .filter((cols) => cols.length >= 6 && Number(cols[cols.length - 1]) > 0)
        .map((cols) => ({ resource: cols[cols.length - 6], failcnt: Number(cols[cols.length - 1]) }))
    : null;

  const synRetries = readText("/proc/sys/net/ipv4/tcp_syn_retries");
  env.synRetries = synRetries ? Number(synRetries) : null;

  env.hasGlobalIpv6 = Object.values(os.networkInterfaces())
    .flat()
    .some((a) => a && a.family === "IPv6" && !a.internal && !a.address.startsWith("fe80"));

  return env;
}

// ----------------------------------------------------------- queue sampling

/** Read-only look at which hosts are failing and which succeeded, if possible. */
function sampleQueue(dbPath, limit = 8) {
  if (!fs.existsSync(dbPath)) return { available: false, reason: `no database at ${dbPath}` };
  let db;
  try {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    return { available: false, reason: `could not open read-only: ${e.message}` };
  }

  try {
    const hostOf = (u) => {
      try {
        return new URL(u).hostname;
      } catch {
        return null;
      }
    };

    const failedRows = db
      .prepare(
        "SELECT url, last_note FROM crawl_queue WHERE last_note != '' AND (last_note LIKE '%timeout%' OR last_note LIKE '%unreachable%') LIMIT 400",
      )
      .all();
    const failedHosts = [...new Set(failedRows.map((r) => hostOf(r.url)).filter(Boolean))];

    const recent = db.prepare("SELECT url FROM search_index ORDER BY timestamp DESC LIMIT 500").all();
    const okHosts = [...new Set(recent.map((r) => hostOf(r.url)).filter(Boolean))];
    const schemes = { http: 0, https: 0 };
    for (const r of recent) {
      if (r.url.startsWith("https:")) schemes.https += 1;
      else if (r.url.startsWith("http:")) schemes.http += 1;
    }

    // Spread the sample rather than taking the first N, which tend to cluster.
    const pick = (arr, n) => {
      if (arr.length <= n) return arr;
      const step = arr.length / n;
      return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]);
    };

    return {
      available: true,
      failedHosts: pick(failedHosts, limit),
      failedTotal: failedRows.length,
      okHosts: pick(okHosts, Math.ceil(limit / 2)),
      recentSchemes: schemes,
    };
  } catch (e) {
    return { available: false, reason: e.message };
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------ verdict

/**
 * Turn measurements into findings, most likely cause first. Pure function of
 * its input so the reasoning can be tested without a network.
 */
function diagnose({ env, reference, sampled = [], httpCheck = null }) {
  const findings = [];
  const add = (severity, title, detail, action) => findings.push({ severity, title, detail, action });

  const all = [...reference, ...sampled];
  const median = (xs) => {
    const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : null;
  };

  // --- DNS
  const lookupTimes = reference.filter((h) => h.dns.lookup.ok).map((h) => h.dns.lookup.ms);
  const lookupFailures = reference.filter((h) => !h.dns.lookup.ok).length;
  const lookupMedian = median(lookupTimes);
  if (lookupFailures >= Math.ceil(reference.length / 2)) {
    add(
      "critical",
      "DNS lookups are failing",
      `${lookupFailures}/${reference.length} reference hosts could not be resolved.`,
      "Check /etc/resolv.conf. Point it at a working resolver (e.g. 1.1.1.1 and 8.8.8.8) and re-run.",
    );
  } else if (lookupMedian !== null && lookupMedian > SLOW_DNS_MS) {
    add(
      "critical",
      "DNS lookups are slow",
      `Median lookup took ${ms(lookupMedian)} for well-known hosts that should resolve in well under 100ms. ` +
        "Every crawl request pays this before any timeout starts counting, and slow lookups also tie up Node's threadpool.",
      "Check the nameservers in /etc/resolv.conf -- a dead first nameserver makes every lookup wait for it to time out. " +
        "Replace or reorder them, or run a local caching resolver (systemd-resolved, unbound, dnsmasq).",
    );
  }

  // --- per-family layer breakdown across every probed host
  const layers = { 4: {}, 6: {} };
  for (const h of all) {
    for (const fam of [4, 6]) {
      const layer = layerOf(h.families[fam]);
      layers[fam][layer] = (layers[fam][layer] || 0) + 1;
    }
  }
  const tried = (fam) => Object.entries(layers[fam]).filter(([k]) => k !== "skipped").reduce((a, [, v]) => a + v, 0);
  const share = (fam, layer) => (tried(fam) ? (layers[fam][layer] || 0) / tried(fam) : 0);

  const v4Ok = share(4, "ok");
  const v6Ok = share(6, "ok");
  const v4TlsStall = share(4, "tls") + share(4, "byte");
  const v4TcpFail = share(4, "tcp");

  if (tried(4) > 0 && v4TlsStall >= 0.5) {
    add(
      "critical",
      "Connections open, then TLS stalls (IPv4)",
      `${Math.round(v4TlsStall * 100)}% of IPv4 hosts completed the TCP handshake but never finished TLS or never answered. ` +
        "Small packets get through and large ones do not. That is the signature of an MTU / path-MTU blackhole " +
        "(common on VPS and tunnelled networks), or of a middlebox that filters or throttles this traffic.",
      `Try a smaller MTU on the outbound interface and re-run, e.g.  sudo ip link set dev ${firstIface(env)} mtu 1400  ` +
        "(temporary; reverts on reboot). If that fixes it, make it permanent and tell the provider. " +
        "If it does not, the provider is the next call: ask whether outbound traffic from this VPS is being filtered.",
    );
  }

  if (tried(4) > 0 && v4TcpFail >= 0.5) {
    add(
      "critical",
      "Outbound connections are being dropped (IPv4)",
      `${Math.round(v4TcpFail * 100)}% of IPv4 hosts never completed a TCP handshake -- including major sites that are certainly up.`,
      "Check the local firewall (sudo iptables -L OUTPUT -n -v / sudo nft list ruleset), then ask the provider " +
        "whether outbound connections have been restricted -- providers sometimes do this automatically to boxes that " +
        "open connections to many unrelated hosts.",
    );
  }

  if (tried(6) > 0 && v6Ok < 0.5 && v4Ok >= 0.5) {
    // How IPv6 fails matters more than whether it does. An instant refusal
    // (ENETUNREACH: "no route") costs nothing -- Node tries IPv4 right away.
    // A connection that *hangs* costs a full timeout on every request.
    const v6FailTimes = all
      .map((h) => h.families[6])
      .filter((f) => f && !f.skipped && f.tcp && !f.tcp.ok)
      .map((f) => f.tcp.ms);
    const v6Hangs = (median(v6FailTimes) ?? 0) >= 2000 || share(6, "tls") + share(6, "byte") >= 0.5;
    if (v6Hangs) {
      add(
        "high",
        "IPv6 hangs, IPv4 works",
        `IPv6 succeeded for ${Math.round(v6Ok * 100)}% of dual-stack hosts and failed slowly (median ${ms(median(v6FailTimes))}), ` +
          "so any request that tries IPv6 first waits out a timeout before anything else happens.",
        "Run the crawler with QUEST_FORCE_IPV4=true.",
      );
    } else {
      add(
        "info",
        "IPv6 is not routed here, but it fails instantly",
        `IPv6 connects are refused immediately (median ${ms(median(v6FailTimes))}), and Node falls back to IPv4 on its own, ` +
          "so this costs nothing and is not the cause of any slowdown.",
        null,
      );
    }
  }

  if (httpCheck && httpCheck.ok && tried(4) > 0 && v4Ok < 0.5) {
    add(
      "info",
      "Plain HTTP works where HTTPS does not",
      "The HTTP (port 80) check succeeded while most HTTPS checks failed -- consistent with the TLS-stall finding above: " +
        "short plain-HTTP responses fit in small packets, TLS handshakes do not.",
      null,
    );
  }

  // --- system limits
  if (env.conntrack && env.conntrack.max > 0 && env.conntrack.count / env.conntrack.max > 0.9) {
    add(
      "critical",
      "Connection-tracking table is nearly full",
      `nf_conntrack is at ${env.conntrack.count}/${env.conntrack.max}. When it fills, the kernel silently drops new connections.`,
      "Raise it (sudo sysctl -w net.netfilter.nf_conntrack_max=262144) or lower QUEST_CONCURRENCY. Check dmesg for 'table full'.",
    );
  }
  if (env.beancounterFailures && env.beancounterFailures.length > 0) {
    add(
      "critical",
      "Container resource limits are being hit (OpenVZ)",
      `Non-zero failcnt: ${env.beancounterFailures.map((b) => `${b.resource}=${b.failcnt}`).join(", ")}.`,
      "These are limits the provider sets on the container. Lower QUEST_CONCURRENCY, or ask the provider to raise them.",
    );
  }
  // --- the network is fine, the targets are not
  const refOk = reference.filter((h) => [4, 6].some((f) => layerOf(h.families[f]) === "ok")).length;
  const sampledOk = sampled.filter((h) => [4, 6].some((f) => layerOf(h.families[f]) === "ok")).length;
  if (reference.length > 0 && refOk === reference.length && sampled.length > 0 && sampledOk / sampled.length < 0.5) {
    add(
      "info",
      "This machine's network is healthy; the failing hosts are the problem",
      `Every reference host worked, but only ${sampledOk}/${sampled.length} hosts sampled from the failure list did. ` +
        "Those hosts are genuinely slow, down, or blocking crawlers -- the failure rate reflects the queue, not this box.",
      "Nothing to fix locally. Consider pruning long-dead hosts: node maintain.js --prune-failed.",
    );
  }

  if (!findings.some((f) => f.severity === "critical" || f.severity === "high")) {
    add("ok", "No network problem detected", "DNS, TCP, TLS and responses all behaved normally.", null);
  }

  const order = { critical: 0, high: 1, ok: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { findings, layers };
}

function firstIface(env) {
  const names = Object.keys(env.mtu || {}).filter((n) => n !== "lo");
  return names[0] || "eth0";
}

// --------------------------------------------------------------------- main

function printHost(h) {
  const d = h.dns;
  const fmtDns = (r) => (r.ok ? `${ms(r.ms)}${Array.isArray(r.value) ? ` (${r.value.length})` : ""}` : `FAIL ${r.error}`);
  console.log(`  ${h.hostname}`);
  console.log(`    dns   lookup ${fmtDns(d.lookup)}   A ${fmtDns(d.a)}   AAAA ${fmtDns(d.aaaa)}`);
  for (const fam of [4, 6]) {
    const f = h.families[fam];
    if (!f) continue;
    if (f.skipped) {
      console.log(`    ipv${fam}  skipped (${f.skipped})`);
      continue;
    }
    const tcp = f.tcp.ok ? `tcp ${ms(f.tcp.ms)}` : `tcp FAIL ${f.tcp.error} after ${ms(f.tcp.ms)}`;
    let rest = "";
    if (f.tls) {
      if (f.tls.ok) rest = `  tls ${ms(f.tls.tlsMs)}  first byte ${ms(f.tls.byteMs)}  -> ok`;
      else if (f.tls.stage === "tls") rest = `  tls STALLED (${f.tls.error})`;
      else rest = `  tls ${ms(f.tls.tlsMs)}  first byte STALLED (${f.tls.error})`;
    }
    console.log(`    ipv${fam}  ${pad(f.address, 40)} ${tcp}${rest}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const quick = args.includes("--quick");
  const extraHostsArg = args.find((a) => a.startsWith("--hosts="));
  const extraHosts = extraHostsArg ? extraHostsArg.split("=")[1].split(",").filter(Boolean) : [];

  console.log("QUEST network check\n");

  const env = inspectEnvironment();
  console.log("environment");
  console.log(`  node ${env.node} on ${env.platform}`);
  console.log(`  autoSelectFamily ${env.autoSelectFamily}, QUEST_FORCE_IPV4 ${env.forceIpv4}`);
  console.log(`  global IPv6 address on an interface: ${env.hasGlobalIpv6 ? "yes" : "no"}`);
  if (env.nameservers) console.log(`  nameservers: ${env.nameservers.join(", ") || "(none!)"}  ${env.resolvOptions.join(" ")}`);
  if (env.mtu) console.log(`  mtu: ${Object.entries(env.mtu).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  if (env.conntrack) console.log(`  conntrack: ${env.conntrack.count}/${env.conntrack.max}`);
  if (env.beancounterFailures) console.log(`  openvz limits hit: ${env.beancounterFailures.length ? env.beancounterFailures.map((b) => b.resource).join(", ") : "none"}`);
  if (env.synRetries !== null) console.log(`  tcp_syn_retries: ${env.synRetries}`);
  if (!env.linux) console.log("  (not Linux: system-limit checks skipped)");

  console.log("\nreference hosts");
  const reference = [];
  for (const host of REFERENCE_HOSTS) {
    const r = await probeHost(host);
    reference.push(r);
    printHost(r);
  }

  console.log("\ndirect to 1.1.1.1 (no DNS involved)");
  const directTcp = await probeTcp("1.1.1.1", 443, 4);
  const directTls = directTcp.ok ? await probeTlsAndByte("1.1.1.1", "one.one.one.one", 4) : null;
  console.log(
    `  tcp ${directTcp.ok ? ms(directTcp.ms) : "FAIL " + directTcp.error}` +
      (directTls ? `  tls ${directTls.ok ? ms(directTls.tlsMs) + "  -> ok" : "STALLED (" + directTls.error + ")"}` : ""),
  );

  console.log("\nplain HTTP (port 80)");
  const exampleA = reference.find((h) => h.hostname === "example.com")?.dns.a;
  let httpCheck = null;
  if (exampleA?.ok && exampleA.value.length) {
    httpCheck = await probeHttp(exampleA.value[0], "example.com", 4);
    console.log(`  example.com  ${httpCheck.ok ? "ok " + ms(httpCheck.ms) : "FAIL " + httpCheck.error}`);
  } else {
    console.log("  skipped: example.com did not resolve");
  }

  const sampled = [];
  if (!quick) {
    const sample = sampleQueue(DB_PATH);
    if (!sample.available) {
      console.log(`\nqueue sample skipped: ${sample.reason}`);
    } else {
      console.log(`\nhosts from the failure list (${sample.failedTotal} recent timeouts/unreachables sampled)`);
      for (const host of sample.failedHosts) {
        const r = await probeHost(host);
        sampled.push(r);
        printHost(r);
      }
      console.log("\nhosts that recently succeeded");
      for (const host of sample.okHosts) {
        printHost(await probeHost(host));
      }
      const { http, https } = sample.recentSchemes;
      console.log(`\n  recent successes: ${https} https, ${http} plain http`);
      if (http + https > 20 && https / (http + https) < 0.2) {
        console.log("  -> almost everything that succeeds is plain HTTP, which points at TLS specifically.");
      }
    }
  }

  for (const host of extraHosts) {
    console.log(`\nrequested host`);
    const r = await probeHost(host);
    sampled.push(r);
    printHost(r);
  }

  const { findings } = diagnose({ env, reference, sampled, httpCheck });
  console.log("\n" + "=".repeat(72));
  console.log("VERDICT");
  console.log("=".repeat(72));
  for (const f of findings) {
    console.log(`\n[${f.severity.toUpperCase()}] ${f.title}`);
    console.log(wrap(f.detail, "  "));
    if (f.action) console.log(wrap("-> " + f.action, "  "));
  }
  console.log("");
}

function wrap(text, indent) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).length > 76) {
      lines.push(indent + line.trim());
      line = w;
    } else {
      line += " " + w;
    }
  }
  if (line.trim()) lines.push(indent + line.trim());
  return lines.join("\n");
}

module.exports = { probeTcp, probeTlsAndByte, probeHttp, diagnose, layerOf, inspectEnvironment };

if (require.main === module) {
  main().catch((e) => {
    console.error(`netcheck failed: ${e.stack || e.message}`);
    process.exitCode = 1;
  });
}
