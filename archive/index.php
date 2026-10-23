<?php

declare(strict_types=1);

require_once __DIR__ . '/lib.php';
require_once dirname(__DIR__) . '/xio.php';

/**
 * xArchive: browses the same search_index xSearch does, but every result
 * points at view.php instead of the live external URL -- clicking a result
 * shows the page text QUEST actually stored, not the website itself.
 */

$dbPath = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'quest.sqlite';
$indexPath = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'search_index.json';
$crawlStatePath = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'crawl_state.json';
$query = isset($_GET['q']) ? trim((string) $_GET['q']) : '';
$page = isset($_GET['page']) ? max(1, (int) $_GET['page']) : 1;
$perPage = min(100, max(1, (int) ($_GET['perPage'] ?? 20)));

$responseCache = [];
$cacheMetadata = [];
$maxCacheEntries = 50;
$cacheTTLSeconds = 300;
$performanceLog = [];
$requestStart = microtime(true);
$concurrencyCounter = 0;
$concurrencyLimit = 3;

static $rateLimitMap = [];
$clientIP = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$now = time();
if (!isset($rateLimitMap[$clientIP])) {
  $rateLimitMap[$clientIP] = [];
}
$rateLimitMap[$clientIP] = array_filter($rateLimitMap[$clientIP], function ($ts) use ($now) {
  return $ts > ($now - 60);
});
$requestsThisPeriod = count($rateLimitMap[$clientIP]);
$maxRequestsPerPeriod = 10;

$database = openQuestDatabase($dbPath);
$dbConnection = $database['connection'];
$dbKind = (string) $database['kind'];
$dbAvailable = $dbConnection !== null;
$rows = [];

$status = $dbAvailable
  ? []
  : fetchQuestStatusFromFallback($indexPath, $crawlStatePath, (string) $database['detail']);

if ($dbAvailable) {
  try {
    $status = fetchQuestStatusFromDb($dbConnection, $dbKind, (string) $database['detail']);
  } catch (Throwable $e) {
    closeQuestDatabase($database);
    $database = ['kind' => 'none', 'connection' => null, 'detail' => ((string) $database['detail']) . ' Database read failed: ' . $e->getMessage()];
    $dbConnection = null;
    $dbKind = 'none';
    $dbAvailable = false;
    $status = fetchQuestStatusFromFallback($indexPath, $crawlStatePath, (string) $database['detail']);
  }
}

if (!$dbAvailable) {
  $rows = readIndexRows($indexPath);
  usort($rows, static function (array $a, array $b): int {
    return ($b['timestamp'] ?? 0) <=> ($a['timestamp'] ?? 0);
  });
}

// Random stays inside the archive: it lands on view.php for the picked URL
// instead of leaving the site, matching the point of this page.
if (isset($_GET['random']) && $_GET['random'] === '1') {
  if ($dbAvailable) {
    try {
      $randomUrl = fetchRandomUrlFromDb($dbConnection, $dbKind);
      if ($randomUrl !== null) {
        header('Location: view.php?url=' . urlencode($randomUrl));
        closeQuestDatabase($database);
        exit;
      }
    } catch (Throwable $e) {
      closeQuestDatabase($database);
      $database = ['kind' => 'none', 'connection' => null, 'detail' => ((string) $database['detail']) . ' Random query failed: ' . $e->getMessage()];
      $dbConnection = null;
      $dbKind = 'none';
      $dbAvailable = false;
      $status = fetchQuestStatusFromFallback($indexPath, $crawlStatePath, (string) $database['detail']);
      $rows = readIndexRows($indexPath);
      usort($rows, static function (array $a, array $b): int {
        return ($b['timestamp'] ?? 0) <=> ($a['timestamp'] ?? 0);
      });
    }
  }

  if (!$dbAvailable) {
    $candidates = array_values(array_filter($rows, static function (array $row): bool {
      return !empty($row['url']);
    }));

    if (count($candidates) > 0) {
      $pick = $candidates[random_int(0, count($candidates) - 1)];
      header('Location: view.php?url=' . urlencode((string) $pick['url']));
      exit;
    }
  }
}

if ($dbAvailable) {
  try {
    $recent = fetchRecentRowsFromDb($dbConnection, $dbKind, 5);
  } catch (Throwable $e) {
    closeQuestDatabase($database);
    $database = ['kind' => 'none', 'connection' => null, 'detail' => ((string) $database['detail']) . ' Recent query failed: ' . $e->getMessage()];
    $dbConnection = null;
    $dbKind = 'none';
    $dbAvailable = false;
    $status = fetchQuestStatusFromFallback($indexPath, $crawlStatePath, (string) $database['detail']);
    $rows = readIndexRows($indexPath);
    usort($rows, static function (array $a, array $b): int {
      return ($b['timestamp'] ?? 0) <=> ($a['timestamp'] ?? 0);
    });
    $recent = array_slice($rows, 0, 5);
  }
} else {
  $recent = array_slice($rows, 0, 5);
}

$searchResults = [];
$pagedResults = [];
$totalResults = 0;
$totalPages = 1;
$rateLimitedError = '';

if ($query !== '') {
  if ($requestsThisPeriod >= $maxRequestsPerPeriod) {
    $rateLimitedError = 'Rate limit exceeded. Maximum 10 searches per 60 seconds. Please try again in a moment.';
  } else {
    $rateLimitMap[$clientIP][] = $now;

    if ($dbAvailable) {
      try {
        $dbSearch = fetchSearchRowsFromDb($dbConnection, $dbKind, $query, $page, $perPage);
        $pagedResults = $dbSearch['results'];
        $totalResults = $dbSearch['totalResults'];
        $totalPages = $dbSearch['totalPages'];
        $searchResults = $pagedResults;
        if ($page > $totalPages) {
          $page = $totalPages;
        }
      } catch (Throwable $e) {
        closeQuestDatabase($database);
        $database = ['kind' => 'none', 'connection' => null, 'detail' => ((string) $database['detail']) . ' Search query failed: ' . $e->getMessage()];
        $dbConnection = null;
        $dbKind = 'none';
        $dbAvailable = false;
        $status = fetchQuestStatusFromFallback($indexPath, $crawlStatePath, (string) $database['detail']);
        $rows = readIndexRows($indexPath);
        usort($rows, static function (array $a, array $b): int {
          return ($b['timestamp'] ?? 0) <=> ($a['timestamp'] ?? 0);
        });
      }
    }

    if (!$dbAvailable) {
      $qLower = strtolower($query);

      foreach ($rows as $row) {
        $score = searchScore($row, $qLower);
        if ($score > 0) {
          $row['score'] = $score;
          $searchResults[] = $row;
        }
      }

      usort($searchResults, static function (array $a, array $b): int {
        $scoreCmp = ($b['score'] ?? 0) <=> ($a['score'] ?? 0);
        if ($scoreCmp !== 0) {
          return $scoreCmp;
        }
        return ($b['timestamp'] ?? 0) <=> ($a['timestamp'] ?? 0);
      });

      $totalResults = count($searchResults);
      $totalPages = max(1, (int) ceil($totalResults / $perPage));
      if ($page > $totalPages) {
        $page = $totalPages;
      }
      $offset = ($page - 1) * $perPage;
      $pagedResults = array_slice($searchResults, $offset, $perPage);
    }
  }
}

closeQuestDatabase($database);

?>
<!doctype html>
<html lang="en">

<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>xArchive | QUEST Page Archive</title>
  <meta name="theme-color" content="#000000" />
  <link rel="icon" href="/xio/logo.png" type="image/png" />
  <link rel="stylesheet" href="../xio.css" />
</head>

<body>
  <?= xioTopbar('archive') ?>

  <div class="container">
    <section class="hero">
      <h1><a href="?">xArchive</a></h1>
      <p class="sub">Browse the page text QUEST stored, without leaving the archive.</p>
      <form method="get" action="" class="searchbox">
        <span class="prompt">&gt;</span>
        <input type="search" name="q" value="<?= h($query) ?>" placeholder="Search by title, URL, summary, or keywords"
          aria-label="Search query" />
        <button type="submit">Search</button>
      </form>
      <div class="actions">
        <form method="get" action="">
          <input type="hidden" name="random" value="1" />
          <button type="submit" class="btn">Random archived page</button>
        </form>
        <button type="button" class="btn" id="status-open">Status</button>
      </div>
    </section>

    <?php if ($query === ''): ?>
      <section class="section">
        <h2>Most Recently Indexed (Top 5)</h2>
        <?php if (count($recent) === 0): ?>
          <p class="empty">No indexed pages available yet.</p>
        <?php else: ?>
          <?php foreach ($recent as $item): ?>
            <article class="card">
              <a class="title-link" href="view.php?url=<?= urlencode((string) $item['url']) ?>">
                <p class="title"><?= h((string) $item['title']) ?></p>
              </a>
              <div class="url-row">
                <span class="url"><?= h((string) $item['url']) ?></span>
                <a class="original-link" href="<?= h((string) $item['url']) ?>" target="_blank" rel="noopener noreferrer">visit original &#8599;</a>
              </div>
              <div class="meta">Indexed: <?= h(formatTimestamp((int) $item['timestamp'])) ?></div>
              <?php if (!empty($item['summary'])): ?>
                <p class="summary"><?= h((string) $item['summary']) ?></p>
              <?php endif; ?>
            </article>
          <?php endforeach; ?>
        <?php endif; ?>
      </section>
    <?php endif; ?>

    <section class="section">
      <h2>Archive Results<?= $query !== '' ? ' for "' . h($query) . '"' : '' ?></h2>
      <?php if ($query === ''): ?>
        <p class="empty">Enter a query to search archived pages.</p>
      <?php elseif ($rateLimitedError !== ''): ?>
        <p class="error"><?= h($rateLimitedError) ?></p>
      <?php elseif (count($searchResults) === 0): ?>
        <p class="empty">No matching pages found.</p>
      <?php else: ?>
        <p class="result-count">Showing <?= count($pagedResults) ?> of <?= $totalResults ?> result(s). Page
          <?= $page ?> of <?= $totalPages ?>.
        </p>
        <?php foreach ($pagedResults as $item): ?>
          <article class="card">
            <a class="title-link" href="view.php?url=<?= urlencode((string) $item['url']) ?>">
              <p class="title"><?= h((string) $item['title']) ?></p>
            </a>
            <div class="url-row">
              <span class="url"><?= h((string) $item['url']) ?></span>
              <a class="original-link" href="<?= h((string) $item['url']) ?>" target="_blank" rel="noopener noreferrer">visit original &#8599;</a>
            </div>
            <div class="meta">Indexed: <?= h(formatTimestamp((int) $item['timestamp'])) ?> | Score:
              <?= (int) ($item['score'] ?? 0) ?>
            </div>
            <?php if (!empty($item['snippet'])): ?>
              <p class="summary"><?= h((string) $item['snippet']) ?></p>
            <?php endif; ?>
          </article>
        <?php endforeach; ?>

        <?php if ($totalPages > 1): ?>
          <nav class="pagination" aria-label="Archive result pages">
            <?php if ($page > 1): ?>
              <a class="page-link" href="?q=<?= urlencode($query) ?>&page=<?= $page - 1 ?>">Prev</a>
            <?php endif; ?>

            <?php for ($p = 1; $p <= $totalPages; $p++): ?>
              <?php if ($p === $page): ?>
                <span class="page-current"><?= $p ?></span>
              <?php else: ?>
                <a class="page-link" href="?q=<?= urlencode($query) ?>&page=<?= $p ?>"><?= $p ?></a>
              <?php endif; ?>
            <?php endfor; ?>

            <?php if ($page < $totalPages): ?>
              <a class="page-link" href="?q=<?= urlencode($query) ?>&page=<?= $page + 1 ?>">Next</a>
            <?php endif; ?>
          </nav>
        <?php endif; ?>
      <?php endif; ?>
    </section>
  </div>

  <div class="modal-backdrop" id="status-backdrop" aria-hidden="true">
    <div class="status-modal" role="dialog" aria-modal="true" aria-labelledby="status-title">
      <h2 id="status-title">xArchive Status</h2>
      <p class="sub">Same underlying database as xSearch; this reflects the crawler's current health.</p>

      <div class="status-grid">
        <div class="status-item">
          <span class="status-label">Storage Mode</span>
          <span class="status-value"><?= h((string) $status['storageMode']) ?></span>
        </div>
        <div class="status-item">
          <span class="status-label">Database Readable</span>
          <span class="status-value"><?= $status['databaseReadable'] ? 'Yes' : 'No, using JSON fallback' ?></span>
        </div>
        <div class="status-item">
          <span class="status-label">Database Detail</span>
          <span class="status-value"><?= h((string) $status['databaseDetail']) ?></span>
        </div>
        <div class="status-item">
          <span class="status-label">Indexed Pages</span>
          <span class="status-value"><?= h((string) $status['indexedPages']) ?></span>
        </div>
        <div class="status-item">
          <span class="status-label">Queue Size</span>
          <span class="status-value"><?= h((string) $status['queueCount']) ?></span>
        </div>
        <div class="status-item">
          <span class="status-label">Crawler Active</span>
          <span class="status-value"><?= $status['crawlerActive'] ? 'Yes' : 'No' ?></span>
        </div>
        <div class="status-item">
          <span class="status-label">Crawler State</span>
          <span class="status-value"><?= h((string) $status['crawlerState']) ?></span>
        </div>
        <div class="status-item">
          <span class="status-label">Last Heartbeat</span>
          <span class="status-value"><?= h((string) $status['lastHeartbeatLabel']) ?></span>
        </div>
        <div class="status-item">
          <span class="status-label">Heartbeat Age</span>
          <span class="status-value"><?= $status['heartbeatAgeSeconds'] !== null ? h((string) $status['heartbeatAgeSeconds']) . ' seconds' : 'Unavailable' ?></span>
        </div>
        <div class="status-item">
          <span class="status-label">Crawler Started</span>
          <span class="status-value"><?= h((string) $status['startedAtLabel']) ?></span>
        </div>
        <div class="status-item">
          <span class="status-label">Crawler PID</span>
          <span class="status-value"><?= h((string) $status['crawlerPid']) ?></span>
        </div>
      </div>

      <div class="status-actions">
        <button type="button" id="status-close">Close</button>
      </div>
    </div>
  </div>

  <script>
    (() => {
      const openButton = document.getElementById('status-open');
      const closeButton = document.getElementById('status-close');
      const backdrop = document.getElementById('status-backdrop');

      if (!openButton || !closeButton || !backdrop) {
        return;
      }

      const openModal = () => {
        backdrop.classList.add('is-open');
        backdrop.setAttribute('aria-hidden', 'false');
      };

      const closeModal = () => {
        backdrop.classList.remove('is-open');
        backdrop.setAttribute('aria-hidden', 'true');
      };

      openButton.addEventListener('click', openModal);
      closeButton.addEventListener('click', closeModal);
      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) {
          closeModal();
        }
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && backdrop.classList.contains('is-open')) {
          closeModal();
        }
      });
    })();
  </script>
</body>

</html>
