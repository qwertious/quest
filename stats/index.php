<?php

declare(strict_types=1);

require_once __DIR__ . '/charts.php';
require_once dirname(__DIR__) . '/xio.php';

/**
 * QSTATS: the QUEST corpus dashboard.
 *
 * This page never queries the database. It reads data/stats.json, which
 * `node stats.js` writes on a schedule. That is deliberate -- the figures here
 * come from GROUP BYs over millions of rows, which is fine once a day and
 * ruinous on every page load.
 */

$statsPath = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'stats.json';

// The charts paint on their own explicit surface, because the palette was
// validated against a known surface colour. The XIO style is dark.
$dark = true;
$ink = vizInk($dark);

$stats = null;
$loadError = '';
if (!is_file($statsPath)) {
  $loadError = 'No snapshot yet. Run "node stats.js" to generate one.';
} else {
  $raw = @file_get_contents($statsPath);
  $decoded = $raw === false ? null : json_decode($raw, true);
  if (!is_array($decoded)) {
    $loadError = 'stats.json could not be read or parsed.';
  } else {
    $stats = $decoded;
  }
}

function ageLabel(int $ms): string
{
  $sec = max(0, (int) round((microtime(true) * 1000 - $ms) / 1000));
  if ($sec < 90) return $sec . 's ago';
  if ($sec < 5400) return round($sec / 60) . ' min ago';
  if ($sec < 172800) return round($sec / 3600, 1) . ' h ago';
  return round($sec / 86400, 1) . ' days ago';
}

$corpus = $stats['corpus'] ?? null;
$queue = $stats['queue'] ?? null;
$rearchive = $stats['rearchive'] ?? null;
$domains = $stats['domains'] ?? null;
$failures = $stats['failures'] ?? null;
$shape = $stats['pageShape'] ?? null;
$crawler = $stats['crawler'] ?? null;
$history = $stats['history'] ?? [];

?>
<!doctype html>
<html lang="en">

<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>QSTATS | QUEST Corpus Dashboard</title>
  <meta name="theme-color" content="#000000" />
  <link rel="icon" href="/xio/logo.png" type="image/png" />
  <link rel="stylesheet" href="../xio.css" />
  <style>
    :root {
      --maxw: 76rem;
      --viz-surface: <?= $ink['surface'] ?>;
      --viz-primary: <?= $ink['primary'] ?>;
      --viz-secondary: <?= $ink['secondary'] ?>;
      --viz-muted: <?= $ink['muted'] ?>;
      --viz-border: <?= $ink['border'] ?>;
    }

    .statusbar {
      border: 1px solid var(--rule);
      background: var(--panel);
      padding: 0.7rem 1rem;
      margin-bottom: 1rem;
    }

    /* --- tiles ------------------------------------------------------------ */
    .tiles {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(165px, 1fr));
      gap: 0.7rem;
      margin-bottom: 1rem;
    }
    .tile {
      background: var(--viz-surface);
      border: 1px solid var(--viz-border);
      padding: 0.85rem 0.95rem;
      color: var(--viz-primary);
    }
    .tile-label {
      display: block; font-size: 0.76rem; letter-spacing: 0.04em;
      text-transform: uppercase; letter-spacing: 0.2em; font-size: 0.64rem; color: var(--viz-muted); margin-bottom: 0.3rem;
    }
    /* Proportional figures on standalone numbers -- tabular-nums would make
       these look loose at display size. */
    .tile-value { font-size: 1.55rem; font-weight: 700; line-height: 1.1; color: var(--viz-primary); }
    .tile-note { display: block; margin-top: 0.28rem; font-size: 0.78rem; color: var(--viz-secondary); }

    /* --- chart cards ------------------------------------------------------ */
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
      gap: 1rem;
      margin-bottom: 1rem;
    }
    .card {
      background: var(--viz-surface);
      border: 1px solid var(--viz-border);
      padding: 1rem 1.1rem;
      color: var(--viz-primary);
      overflow: hidden;
    }
    .card.wide { grid-column: 1 / -1; }
    .card h2 { margin: 0 0 0.15rem; font-size: 0.78rem; font-weight: 400; letter-spacing: 0.25em; text-transform: uppercase; color: var(--viz-primary); }
    .card .hint { margin: 0 0 0.85rem; font-size: 0.8rem; color: var(--viz-secondary); }

    .donut-row { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; }
    .viz-donut { width: 175px; height: 175px; flex: 0 0 auto; }
    .viz-bars, .viz-hist, .viz-lines { width: 100%; height: auto; display: block; }
    .viz-tick { font: 11px system-ui, -apple-system, "Segoe UI", sans-serif; }

    .viz-legend { list-style: none; margin: 0; padding: 0; flex: 1 1 170px; min-width: 170px; }
    .viz-legend li {
      display: flex; align-items: baseline; gap: 0.5rem;
      padding: 0.22rem 0; font-size: 0.86rem; color: var(--viz-primary);
    }
    .viz-swatch {
      width: 11px; height: 11px; flex: 0 0 auto;
      transform: translateY(1px);
    }
    .viz-legend-label { flex: 1 1 auto; color: var(--viz-secondary); }
    .viz-legend-value { font-variant-numeric: tabular-nums; font-weight: 600; }
    .viz-legend-pct { color: var(--viz-muted); font-weight: 400; font-size: 0.8rem; }
    .viz-muted { color: var(--viz-muted); }
    .viz-empty { color: var(--viz-muted); font-size: 0.9rem; margin: 0.5rem 0; }

    .viz-progress-wrap { margin-top: 0.2rem; }
    .viz-progress {
      height: 10px; overflow: hidden;
      background: color-mix(in srgb, var(--viz-muted) 22%, transparent);
    }
    .viz-progress-fill { height: 100%; }
    .viz-progress-legend {
      display: flex; justify-content: space-between; gap: 1rem;
      margin-top: 0.5rem; font-size: 0.85rem; flex-wrap: wrap;
    }
    .viz-progress-legend span { display: flex; align-items: baseline; gap: 0.4rem; }

    details.tableview { margin-top: 0.75rem; }
    details.tableview summary {
      cursor: pointer; font-size: 0.8rem; color: var(--viz-secondary);
    }
    .viz-table {
      width: 100%; border-collapse: collapse; margin-top: 0.5rem;
      font-size: 0.82rem; font-variant-numeric: tabular-nums;
    }
    .viz-table th, .viz-table td {
      text-align: left; padding: 0.25rem 0.5rem 0.25rem 0;
      border-bottom: 1px solid var(--viz-border); color: var(--viz-primary);
    }
    .viz-table th { color: var(--viz-muted); font-weight: 600; }
    .viz-table td:nth-child(2), .viz-table td:nth-child(3) { text-align: right; }

    .status-line {
      display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap;
      font-size: 0.88rem; color: var(--viz-secondary);
    }
    .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
    code { font-size: 0.9em; }
    .scroll-x { overflow-x: auto; }
  </style>
</head>

<body>
  <?= xioTopbar('stats') ?>

  <div class="container">
    <section class="hero">
      <h1>QSTATS</h1>
      <p class="sub">What QUEST has collected, and what it is still chewing through.</p>
    </section>

    <?php if ($loadError !== ''): ?>
      <section class="notice">
        <h2>No data yet</h2>
        <p class="sub"><?= vizEsc($loadError) ?></p>
        <p class="sub">Generate a snapshot with:</p>
        <pre><code>node stats.js</code></pre>
        <p class="sub">Then schedule it — daily is plenty. The dashboard only ever reads the file it writes.</p>
      </section>
    <?php else: ?>

      <?php
      $generatedAt = (int) ($stats['generatedAt'] ?? 0);
      $staleHours = $generatedAt > 0 ? (microtime(true) * 1000 - $generatedAt) / 3600000 : 999;
      ?>
      <section class="statusbar">
        <div class="status-line">
          <?php
          $running = (bool) ($crawler['running'] ?? false);
          // Status colours are reserved for state and always ship with a label,
          // never colour alone.
          $dotColor = $running ? '#8be28b' : '#4a4a4a';
          ?>
          <span class="dot" style="background:<?= $dotColor ?>"></span>
          <strong><?= $running ? 'Crawler running' : 'Crawler idle' ?></strong>
          <?php if (!empty($crawler['state'])): ?>
            <span class="viz-muted">state: <?= vizEsc((string) $crawler['state']) ?></span>
          <?php endif; ?>
          <?php if (!empty($crawler['heartbeatAt'])): ?>
            <span class="viz-muted">heartbeat <?= vizEsc(ageLabel((int) $crawler['heartbeatAt'])) ?></span>
          <?php endif; ?>
          <?php if (!empty($crawler['pagesPerMinute'])): ?>
            <span class="viz-muted"><?= vizNum($crawler['pagesPerMinute']) ?> pages/min configured</span>
          <?php endif; ?>
          <span class="viz-muted">
            snapshot <?= $generatedAt ? vizEsc(ageLabel($generatedAt)) : 'unknown' ?>
            <?= $staleHours > 36 ? ' — stale, is stats.js scheduled?' : '' ?>
          </span>
        </div>
      </section>

      <!-- ---------------------------------------------------------------- -->
      <section class="tiles">
        <div class="tile">
          <span class="tile-label">Pages archived</span>
          <span class="tile-value"><?= vizNum($corpus['archivedPages'] ?? 0) ?></span>
          <span class="tile-note"><?= vizNum($corpus['searchRows'] ?? 0) ?> in the search index</span>
        </div>
        <div class="tile">
          <span class="tile-label">HTML archived</span>
          <span class="tile-value"><?= vizNum($corpus['htmlPages'] ?? 0) ?></span>
          <span class="tile-note"><?= vizBytes($corpus['htmlStoredBytes'] ?? 0) ?> stored,
            <?= vizBytes($corpus['htmlOriginalBytes'] ?? 0) ?> raw</span>
        </div>
        <div class="tile">
          <span class="tile-label">Queue pending</span>
          <span class="tile-value"><?= vizNum($queue['byState']['pending'] ?? 0) ?></span>
          <span class="tile-note"><?= vizNum($queue['distinctQueueHosts'] ?? 0) ?> hosts</span>
        </div>
        <div class="tile">
          <span class="tile-label">Database size</span>
          <span class="tile-value"><?= vizBytes($corpus['dbBytes'] ?? 0) ?></span>
          <span class="tile-note">WAL <?= vizBytes($corpus['walBytes'] ?? 0) ?></span>
        </div>
        <div class="tile">
          <span class="tile-label">Mean page</span>
          <span class="tile-value"><?= vizNum($shape['meanChars'] ?? 0) ?></span>
          <span class="tile-note">chars of text (sampled)</span>
        </div>
        <div class="tile">
          <span class="tile-label">Domains</span>
          <span class="tile-value"><?= vizNum($domains['distinctDomains'] ?? 0) ?></span>
          <span class="tile-note"><?= vizNum($domains['hostsForHalf'] ?? 0) ?> hosts hold half the queue</span>
        </div>
      </section>

      <!-- ---------------------------------------------------------------- -->
      <div class="grid">
        <section class="card">
          <h2>Queue composition</h2>
          <p class="hint">Every URL QUEST knows about, by state.</p>
          <?php
          $stateOrder = ['pending', 'active', 'blocked', 'failed'];
          $queueSegments = [];
          foreach ($stateOrder as $state) {
            $v = (int) ($queue['byState'][$state] ?? 0);
            if ($v > 0) {
              $queueSegments[] = ['label' => $state, 'value' => $v];
            }
          }
          foreach (($queue['byState'] ?? []) as $state => $v) {
            if (!in_array($state, $stateOrder, true) && $v > 0) {
              $queueSegments[] = ['label' => $state, 'value' => (int) $v];
            }
          }
          ?>
          <div class="donut-row">
            <?= vizDonut($queueSegments, $dark) ?>
            <?= vizLegend($queueSegments, $dark) ?>
          </div>
          <details class="tableview">
            <summary>Table view</summary>
            <?= vizTable($queueSegments, 'State', 'URLs') ?>
          </details>
        </section>

        <section class="card">
          <h2>Archive coverage</h2>
          <p class="hint">Pages stored the way the current extractor wants them —
            text from v<?= (int) ($stats['extractorVersion'] ?? 0) ?> with HTML kept.</p>
          <?= vizProgress(
            (float) ($rearchive['current'] ?? 0),
            (float) ($rearchive['archived'] ?? 0),
            $dark,
            'Current',
            'Needs refetch'
          ) ?>
          <?php
          $byState = $rearchive['byState'] ?? [];
          $unreachable = (int) ($byState['blocked'] ?? 0) + (int) ($byState['failed'] ?? 0);
          ?>
          <?php if ($unreachable > 0): ?>
            <p class="hint" style="margin-top:0.7rem">
              <?= vizNum($unreachable) ?> of the remainder are blocked or failed — unreachable,
              so progress legitimately plateaus short of 100%.
            </p>
          <?php endif; ?>
          <details class="tableview">
            <summary>By extractor version</summary>
            <?php
            $versionRows = [];
            foreach (($rearchive['byVersion'] ?? []) as $v => $count) {
              $versionRows[] = ['label' => 'extractor v' . $v, 'value' => (int) $count];
            }
            ?>
            <?= vizTable($versionRows, 'Version', 'Pages') ?>
          </details>
        </section>

        <section class="card">
          <h2>Script mix</h2>
          <p class="hint">Writing system of archived text, from a
            <?= vizNum($shape['analyzed'] ?? 0) ?>-page sample.</p>
          <?php
          $scriptSegments = [];
          foreach (array_slice($shape['scripts'] ?? [], 0, 6) as $s) {
            $scriptSegments[] = ['label' => $s['name'], 'value' => (int) $s['count']];
          }
          ?>
          <div class="donut-row">
            <?= vizDonut($scriptSegments, $dark) ?>
            <?= vizLegend($scriptSegments, $dark) ?>
          </div>
          <details class="tableview">
            <summary>Table view</summary>
            <?= vizTable($scriptSegments, 'Script', 'Pages') ?>
          </details>
        </section>

        <section class="card">
          <h2>Top-level domains</h2>
          <p class="hint">Share of the queue by TLD.</p>
          <?php
          $tldSegments = [];
          foreach (($domains['tlds'] ?? []) as $t) {
            $tldSegments[] = ['label' => '.' . $t['name'], 'value' => (int) $t['count']];
          }
          ?>
          <div class="donut-row">
            <?= vizDonut($tldSegments, $dark) ?>
            <?= vizLegend($tldSegments, $dark) ?>
          </div>
          <details class="tableview">
            <summary>Table view</summary>
            <?= vizTable($tldSegments, 'TLD', 'URLs') ?>
          </details>
        </section>

        <section class="card wide">
          <h2>Biggest domains in the queue</h2>
          <p class="hint">Registrable domain, so every <code>*.wikipedia.org</code> language edition counts once.
            A tall bar here is a domain crowding out the rest of the crawl.</p>
          <div class="scroll-x">
            <?php
            $domainRows = [];
            foreach (($domains['topDomains'] ?? []) as $d) {
              $domainRows[] = [
                'label' => $d['name'],
                'value' => (int) $d['queued'],
                'note' => vizPct((float) $d['queued'], (float) ($domains['queueTotal'] ?? 0)) . ' of queue',
              ];
            }
            ?>
            <?= vizBars($domainRows, $dark) ?>
          </div>
          <details class="tableview">
            <summary>Table view</summary>
            <?= vizTable($domainRows, 'Domain', 'Queued URLs') ?>
          </details>
        </section>

        <section class="card">
          <h2>Page size distribution</h2>
          <p class="hint">Characters of extracted text, from the sample.</p>
          <div class="scroll-x">
            <?php
            $sizeBins = [];
            foreach (($shape['sizes'] ?? []) as $b) {
              $sizeBins[] = ['label' => $b['bucket'], 'value' => (int) $b['count']];
            }
            ?>
            <?= vizHistogram($sizeBins, $dark) ?>
          </div>
          <details class="tableview">
            <summary>Table view</summary>
            <?= vizTable($sizeBins, 'Size', 'Pages') ?>
          </details>
        </section>

        <section class="card">
          <h2>Why fetches fail</h2>
          <p class="hint">Last recorded reason, across <?= vizNum($failures['sampled'] ?? 0) ?> flagged URLs.</p>
          <div class="scroll-x">
            <?php
            $failRows = [];
            foreach (array_slice($failures['reasons'] ?? [], 0, 10) as $f) {
              $failRows[] = ['label' => $f['reason'], 'value' => (int) $f['count']];
            }
            ?>
            <?= vizBars($failRows, $dark, ['labelWidth' => 175]) ?>
          </div>
          <details class="tableview">
            <summary>Table view</summary>
            <?= vizTable($failRows, 'Reason', 'URLs') ?>
          </details>
        </section>

        <section class="card wide">
          <h2>Growth over time</h2>
          <p class="hint">One point per snapshot. All three series are URL counts on a single axis.</p>
          <?php
          $seriesArchived = [];
          $seriesQueue = [];
          $seriesHtml = [];
          foreach ($history as $h) {
            $seriesArchived[] = [(int) $h['at'], (int) $h['archivedPages']];
            $seriesQueue[] = [(int) $h['at'], (int) $h['queuePending']];
            $seriesHtml[] = [(int) $h['at'], (int) $h['htmlPages']];
          }
          $lineSeries = [
            ['label' => 'Queue pending', 'points' => $seriesQueue],
            ['label' => 'Pages archived', 'points' => $seriesArchived],
            ['label' => 'HTML archived', 'points' => $seriesHtml],
          ];
          ?>
          <div class="scroll-x">
            <?= vizLines($lineSeries, $dark) ?>
          </div>
          <?php
          $legendRows = [];
          foreach ($lineSeries as $s) {
            $last = end($s['points']);
            $legendRows[] = ['label' => $s['label'], 'value' => $last ? $last[1] : 0];
          }
          ?>
          <?= vizLegend($legendRows, $dark) ?>
          <?php if (count($history) >= 2): ?>
            <?php
            $first = $history[0];
            $last = $history[count($history) - 1];
            $days = max(0.01, ($last['at'] - $first['at']) / 86400000);
            $perDay = ($last['archivedPages'] - $first['archivedPages']) / $days;
            ?>
            <p class="hint" style="margin-top:0.7rem">
              Averaging <strong><?= vizNum(max(0, $perDay)) ?></strong> pages/day archived across
              <?= number_format($days, 1) ?> days of snapshots.
            </p>
          <?php endif; ?>
          <details class="tableview">
            <summary>Table view</summary>
            <div class="scroll-x">
              <table class="viz-table">
                <thead>
                  <tr><th>Snapshot</th><th>Archived</th><th>Queue</th><th>HTML</th><th>DB</th></tr>
                </thead>
                <tbody>
                  <?php foreach (array_reverse($history) as $h): ?>
                    <tr>
                      <td><?= vizEsc(gmdate('Y-m-d H:i', (int) ($h['at'] / 1000))) ?></td>
                      <td><?= vizNum($h['archivedPages']) ?></td>
                      <td><?= vizNum($h['queuePending']) ?></td>
                      <td><?= vizNum($h['htmlPages']) ?></td>
                      <td><?= vizBytes($h['dbBytes']) ?></td>
                    </tr>
                  <?php endforeach; ?>
                </tbody>
              </table>
            </div>
          </details>
        </section>
      </div>

      <?php if (!empty($stats['errors'])): ?>
        <section class="notice">
          <h2>Some metrics failed to compute</h2>
          <ul>
            <?php foreach ($stats['errors'] as $e): ?>
              <li><?= vizEsc((string) ($e['metric'] ?? '?')) ?>: <?= vizEsc((string) ($e['error'] ?? '')) ?></li>
            <?php endforeach; ?>
          </ul>
        </section>
      <?php endif; ?>

      <p class="sub">
        Snapshot generated in <?= vizNum($stats['generatedInMs'] ?? 0) ?> ms.
        Sampled figures use <?= vizNum($stats['sampleSize'] ?? 0) ?> random pages.
        Schema v<?= (int) ($stats['schemaVersion'] ?? 0) ?>,
        extractor v<?= (int) ($stats['extractorVersion'] ?? 0) ?>.
      </p>
    <?php endif; ?>
  </div>
</body>

</html>
