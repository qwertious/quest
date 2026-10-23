<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/sitelib.php';

/**
 * EXYRA: search the URLs QUEST has flagged for scrutiny testing -- traps,
 * tarpits, bombs, prompt-injection bait -- with the evidence for each and a
 * suspicion rating. Reads data/exyra.sqlite (exyra.js).
 *
 * Suspect URLs are shown as text, never as links: some of them are
 * decompression bombs or bait, and a click is exactly what they want.
 *
 *   ?q=text&cat=category&min=50&sort=suspicion|recent   the list
 *   ?url=...                                            one suspect in full
 */

const PER_PAGE = 50;

$query = isset($_GET['q']) ? trim((string) $_GET['q']) : '';
$category = isset($_GET['cat']) ? preg_replace('/[^a-z-]/', '', (string) $_GET['cat']) : '';
$minPercent = isset($_GET['min']) ? max(0, min(100, (int) $_GET['min'])) : 0;
$sort = ($_GET['sort'] ?? '') === 'recent' ? 'recent' : 'suspicion';
$page = isset($_GET['page']) ? max(1, min(200, (int) $_GET['page'])) : 1;
$detailUrl = isset($_GET['url']) ? trim((string) $_GET['url']) : '';


$database = openQuestDatabase(questDataPath('exyra.sqlite'));
$categories = [];
$categoryCounts = [];
$total = 0;
$suspects = [];
$signalsByUrl = [];
$detail = null;
$sameSite = [];
$hasMore = false;
$error = '';
$lastExport = '';
$withholdAt = 90;

if ($database['connection'] !== null) {
  try {
    $categories = json_decode((string) (qOne($database, "SELECT value FROM meta WHERE key = 'categories'")['value'] ?? '{}'), true) ?: [];
    $lastExport = (string) (qOne($database, "SELECT value FROM meta WHERE key = 'last_export'")['value'] ?? '');
    $withholdAt = max(1, min(100, (int) (qOne($database, "SELECT value FROM meta WHERE key = 'withhold_at'")['value'] ?? 90)));
    $total = (int) (qOne($database, 'SELECT COUNT(*) AS n FROM suspects')['n'] ?? 0);
    foreach (qAll($database, 'SELECT category, COUNT(*) AS n FROM signals GROUP BY category ORDER BY n DESC') as $row) {
      $categoryCounts[$row['category']] = (int) $row['n'];
    }

    if ($detailUrl !== '') {
      $detail = qOne($database, 'SELECT * FROM suspects WHERE url = ?', [$detailUrl]);
      if ($detail !== null) {
        $signalsByUrl[$detailUrl] = qAll($database, 'SELECT * FROM signals WHERE url = ? ORDER BY first_seen', [$detailUrl]);
        $sameSite = qAll(
          $database,
          'SELECT url, suspicion, categories FROM suspects WHERE site = ? AND url != ? ORDER BY suspicion DESC LIMIT 20',
          [(string) $detail['site'], $detailUrl],
        );
      }
    } else {
      $where = ['suspicion >= ?'];
      $params = [$minPercent / 100 - 0.0001];
      if ($query !== '') {
        $where[] = "url LIKE ? ESCAPE '\\'";
        $params[] = '%' . addcslashes($query, '%_\\') . '%';
      }
      if ($category !== '' && isset($categories[$category])) {
        $where[] = 'url IN (SELECT url FROM signals WHERE category = ?)';
        $params[] = $category;
      }
      $order = $sort === 'recent' ? 'last_seen DESC' : 'suspicion DESC, score DESC, last_seen DESC';
      $params[] = PER_PAGE + 1;
      $params[] = ($page - 1) * PER_PAGE;
      $suspects = qAll(
        $database,
        'SELECT * FROM suspects WHERE ' . implode(' AND ', $where) . " ORDER BY $order LIMIT ? OFFSET ?",
        $params,
      );
      $hasMore = count($suspects) > PER_PAGE;
      $suspects = array_slice($suspects, 0, PER_PAGE);
      if (count($suspects) > 0) {
        $urls = array_column($suspects, 'url');
        $marks = implode(',', array_fill(0, count($urls), '?'));
        foreach (qAll($database, "SELECT * FROM signals WHERE url IN ($marks) ORDER BY first_seen", $urls) as $signal) {
          $signalsByUrl[$signal['url']][] = $signal;
        }
      }
    }
  } catch (Throwable $e) {
    $error = 'The Exyra list could not be read right now.';
  }
} else {
  $error = 'No Exyra suspects yet. The crawler records them as it finds them.';
}
closeQuestDatabase($database);

function categoryLabel(string $key): string
{
  $label = ucfirst(str_replace('-', ' ', $key));
  return preg_replace(['/\bai\b/i', '/\burl\b/i'], ['AI', 'URL'], $label) ?? $label;
}

function percentOf(array $row): int
{
  return (int) round(((float) $row['suspicion']) * 100);
}

function levelOf(int $percent): string
{
  return $percent >= 70 ? 'high' : ($percent >= 35 ? 'mid' : 'low');
}

function listLink(array $overrides): string
{
  global $query, $category, $minPercent, $sort;
  $params = array_merge(['q' => $query, 'cat' => $category, 'min' => $minPercent ?: null, 'sort' => $sort === 'recent' ? 'recent' : null], $overrides);
  return '?' . http_build_query(array_filter($params, static fn($v) => $v !== null && $v !== '' && $v !== 0));
}

/** One suspect: rating, URL as text, why it is listed. */
function renderSuspect(array $row, array $signals, array $categories, bool $full): string
{
  global $withholdAt;
  $percent = percentOf($row);
  $html = '<article class="suspect">';
  $html .= '<div class="rating ' . levelOf($percent) . '" title="Suspicion rating"><span class="pct">' . $percent . '%</span>'
    . '<span class="meter"><span style="width:' . $percent . '%"></span></span>';
  if ($percent >= $withholdAt) {
    $html .= '<span class="withheld" title="Rated ' . $withholdAt . '% or higher: QUEST does not crawl this URL.">not crawled</span>';
  }
  $html .= '</div>';
  $html .= '<div class="body">';
  $html .= '<div class="url-line"><code class="url">' . h((string) $row['url']) . '</code>'
    . '<button type="button" class="copy" data-url="' . h((string) $row['url']) . '">Copy</button></div>';
  $html .= '<div class="meta">' . h((string) $row['site']) . ' &middot; first flagged ' . h(timeAgo((int) $row['first_seen']))
    . ' &middot; seen ' . (int) $row['hits'] . '&times;';
  if (!$full) {
    $html .= ' &middot; <a href="?url=' . urlencode((string) $row['url']) . '">details</a>';
  }
  $html .= '</div><ul class="reasons">';
  $shown = $full ? $signals : array_slice($signals, 0, 4);
  foreach ($shown as $signal) {
    $info = $categories[$signal['category']] ?? ['description' => '', 'confidence' => 0];
    $html .= '<li><span class="chip">' . h(categoryLabel((string) $signal['category'])) . '</span> '
      . '<span class="why">' . h((string) $info['description']) . '</span>';
    if ((string) $signal['detail'] !== '') {
      $html .= '<div class="evidence">' . h((string) $signal['detail']) . '</div>';
    }
    if ($full) {
      $html .= '<div class="source">from ' . h((string) $signal['source']) . ', ' . h(timeAgo((int) $signal['first_seen']))
        . ' &middot; on its own: ' . (int) round(((float) $info['confidence']) * 100) . '%</div>';
    }
    $html .= '</li>';
  }
  if (!$full && count($signals) > count($shown)) {
    $html .= '<li class="more"><a href="?url=' . urlencode((string) $row['url']) . '">+' . (count($signals) - count($shown)) . ' more</a></li>';
  }
  $html .= '</ul>';
  if ($full && (string) $row['referrer'] !== '') {
    $html .= '<div class="meta">Found via <code>' . h((string) $row['referrer']) . '</code></div>';
  }
  return $html . '</div></article>';
}
?>
<!doctype html>
<html lang="en">

<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="referrer" content="no-referrer" />
  <meta name="robots" content="noindex, nofollow" />
  <title><?= $detail !== null ? 'Suspect | ' : '' ?>EXYRA | QUEST Scrutiny List</title>
  <meta name="theme-color" content="#000000" />
  <link rel="icon" href="/xio/logo.png" type="image/png" />
  <link rel="stylesheet" href="../xio.css" />
  <style>
    <?= sharedSiteCss() ?>

    .warning { border-left: 2px solid var(--bad); background: var(--panel); color: var(--dim); padding: 0.6rem 1rem; margin: 0 0 1rem; font-size: 0.8rem; }
    .filters { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: end; margin-top: 0.7rem; }
    .filters { margin-top: 1.4rem; }
    .filters label { display: grid; gap: 0.3rem; font-size: 0.64rem; letter-spacing: 0.2em; text-transform: uppercase; color: var(--faint); }
    .filters button { align-self: end; padding-top: 0.6rem; padding-bottom: 0.6rem; }
    .filters select, .filters input { min-width: 0; color: var(--fg); font-size: 0.85rem; letter-spacing: normal; text-transform: none; }
    .chips { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0 0 1rem; }
    .chips a { color: var(--dim); border: 1px solid var(--rule-hi); padding: 0.15rem 0.6rem; font-size: 0.72rem; transition: background 140ms, color 140ms, border-color 140ms; }
    .chips a:hover { color: var(--fg); border-color: var(--fg); }
    .chips a[aria-current="true"] { background: var(--fg); border-color: var(--fg); color: var(--bg); }
    .chips .n { color: var(--faint); }
    .chips a[aria-current="true"] .n { color: #555; }

    .suspect { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 0.9rem; padding: 1rem 0; border-bottom: 1px solid var(--rule); }
    .rating { display: flex; flex-direction: column; gap: 0.3rem; align-items: stretch; }
    .rating .pct { font-size: 1.35rem; font-weight: 800; text-align: center; font-variant-numeric: tabular-nums; }
    .rating .meter { height: 3px; background: var(--rule); overflow: hidden; display: block; }
    .rating .meter span { display: block; height: 100%; }
    .rating.high .pct { color: var(--bad); } .rating.high .meter span { background: var(--bad); }
    .rating.mid .pct { color: var(--warn); } .rating.mid .meter span { background: var(--warn); }
    .rating.low .pct { color: var(--dim); } .rating.low .meter span { background: var(--dim); }
    .rating .withheld { font-size: 0.68rem; font-weight: 700; text-align: center; letter-spacing: 0.1em; text-transform: uppercase; border: 1px solid currentColor; padding: 0 0.2rem; color: var(--bad); }
    .url-line { display: flex; gap: 0.5rem; align-items: flex-start; }
    .url { font-size: 0.9rem; overflow-wrap: anywhere; flex: 1; }
    .copy { padding: 0.15rem 0.55rem; font-size: 0.64rem; }
    .suspect .meta { color: var(--faint); font-size: 0.72rem; margin-top: 0.25rem; }
    .suspect .meta a { color: var(--dim); }
    .suspect .meta a:hover { color: var(--fg); }
    .reasons { list-style: none; margin: 0.5rem 0 0; padding: 0; display: grid; gap: 0.45rem; }
    .reasons .chip { display: inline-block; font-size: 0.64rem; letter-spacing: 0.1em; text-transform: uppercase; border: 1px solid var(--rule-hi); color: var(--dim); padding: 0.05rem 0.45rem; }
    .reasons .why { font-family: var(--read); font-size: 0.88rem; color: #c9c9c9; }
    .reasons .evidence { font-size: 0.72rem; color: var(--faint); margin-top: 0.15rem; overflow-wrap: anywhere; }
    .reasons .source { font-size: 0.7rem; color: var(--faint); }
    .reasons .more a { font-size: 0.75rem; color: var(--dim); }
    .reasons .more a:hover { color: var(--fg); }
    .same-site h3 { font-size: 0.72rem; font-weight: 400; letter-spacing: 0.25em; text-transform: uppercase; color: var(--dim); margin: 1.4rem 0 0.5rem; }
    .same-site li { font-size: 0.85rem; margin: 0.2rem 0; overflow-wrap: anywhere; }
    .same-site a { color: var(--dim); }
    .same-site a:hover { color: var(--fg); }
    @media (max-width: 560px) { .suspect { grid-template-columns: 56px minmax(0, 1fr); } .rating .pct { font-size: 1.05rem; } }
  </style>
</head>

<body>
  <?= xioTopbar('exyra') ?>

  <div class="container">
    <section class="hero">
      <h1>EXYRA</h1>
      <p class="sub">URLs QUEST flagged for scrutiny testing: traps, tarpits, bombs, prompt-injection bait, and anything else that behaves unlike a web page.</p>
      <form method="get" action="./" class="filters" role="search">
        <label style="flex: 1 1 260px">Search URL or site
          <input type="search" name="q" value="<?= h($query) ?>" placeholder="e.g. dustri.org or /trap" />
        </label>
        <label>Category
          <select name="cat">
            <option value="">Any</option>
            <?php foreach ($categories as $key => $info): ?>
              <option value="<?= h($key) ?>" <?= $category === $key ? 'selected' : '' ?>><?= h(categoryLabel($key)) ?></option>
            <?php endforeach; ?>
          </select>
        </label>
        <label>At least
          <select name="min">
            <?php foreach ([0, 10, 25, 50, 75, 90] as $m): ?>
              <option value="<?= $m ?>" <?= $minPercent === $m ? 'selected' : '' ?>><?= $m ?>%</option>
            <?php endforeach; ?>
          </select>
        </label>
        <label>Sort
          <select name="sort">
            <option value="suspicion">Most suspicious</option>
            <option value="recent" <?= $sort === 'recent' ? 'selected' : '' ?>>Most recent</option>
          </select>
        </label>
        <button type="submit">Search</button>
      </form>
    </section>

    <main class="ui">
      <p class="warning"><strong>Handle every URL here as live.</strong> Some are decompression bombs or bait. They are shown as text on purpose &mdash; probe them with byte and time caps (e.g. <code>curl --max-filesize 2000000 --max-time 15</code>, never <code>--compressed</code>), or not at all.</p>

      <?php if ($error !== ''): ?>
        <p class="notice"><?= h($error) ?></p>
      <?php elseif ($detailUrl !== ''): ?>
        <p><a href="<?= h(listLink([])) ?>">&larr; Back to the list</a></p>
        <?php if ($detail === null): ?>
          <p class="notice">That URL isn't on the Exyra list.</p>
        <?php else: ?>
          <?= renderSuspect($detail, $signalsByUrl[$detailUrl] ?? [], $categories, true) ?>
          <?php if (count($sameSite) > 0): ?>
            <section class="same-site">
              <h3>Other suspects on <?= h((string) $detail['site']) ?></h3>
              <ul>
                <?php foreach ($sameSite as $other): ?>
                  <li><strong><?= percentOf($other) ?>%</strong> <a href="?url=<?= urlencode((string) $other['url']) ?>"><code><?= h((string) $other['url']) ?></code></a> &middot; <?= h(str_replace(',', ', ', (string) $other['categories'])) ?></li>
                <?php endforeach; ?>
              </ul>
            </section>
          <?php endif; ?>
        <?php endif; ?>
      <?php else: ?>
        <nav class="chips" aria-label="Categories">
          <a href="<?= h(listLink(['cat' => null, 'page' => null])) ?>" <?= $category === '' ? 'aria-current="true"' : '' ?>>All <span class="n"><?= number_format($total) ?></span></a>
          <?php foreach ($categoryCounts as $key => $count): ?>
            <a href="<?= h(listLink(['cat' => $key, 'page' => null])) ?>" <?= $category === $key ? 'aria-current="true"' : '' ?>
              title="<?= h((string) ($categories[$key]['description'] ?? '')) ?>"><?= h(categoryLabel((string) $key)) ?> <span class="n"><?= number_format($count) ?></span></a>
          <?php endforeach; ?>
        </nav>

        <?php if (count($suspects) === 0): ?>
          <p class="empty">No suspects match.</p>
        <?php endif; ?>
        <?php foreach ($suspects as $row): ?>
          <?= renderSuspect($row, $signalsByUrl[$row['url']] ?? [], $categories, false) ?>
        <?php endforeach; ?>

        <?php if ($page > 1 || $hasMore): ?>
          <nav class="pager" aria-label="More suspects">
            <span><?php if ($page > 1): ?><a class="button" href="<?= h(listLink(['page' => $page - 1])) ?>">&larr; Previous</a><?php endif; ?></span>
            <span><?php if ($hasMore): ?><a class="button" href="<?= h(listLink(['page' => $page + 1])) ?>">Next &rarr;</a><?php endif; ?></span>
          </nav>
        <?php endif; ?>
      <?php endif; ?>

      <p class="footer-stats">
        <?= number_format($total) ?> suspects. Suspicion combines how telling each kind of evidence is on its own
        (shown on each suspect's page) &mdash; a heuristic rating, not a probability.
        Being listed doesn't remove anything from QUEST: only entries rated <?= (int) $withholdAt ?>% or higher
        are withheld from the crawl; everything below is still crawled, archived and searchable.
        <?= $lastExport !== '' ? 'exyra.json/.txt last exported ' . h($lastExport) . '.' : '' ?>
      </p>
    </main>
  </div>

  <script>
    document.querySelectorAll('.copy').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(button.dataset.url);
          button.textContent = 'Copied';
        } catch {
          button.textContent = 'Copy failed';
        }
        setTimeout(() => { button.textContent = 'Copy'; }, 1500);
      });
    });
  </script>
</body>

</html>
