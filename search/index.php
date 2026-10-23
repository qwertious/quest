<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/xio.php';

$dbPath = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'quest.sqlite';
$indexPath = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'search_index.json';
$crawlStatePath = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'crawl_state.json';
$query = isset($_GET['q']) ? trim((string) $_GET['q']) : '';
$page = isset($_GET['page']) ? max(1, (int) $_GET['page']) : 1;
$perPage = min(100, max(1, (int) ($_GET['perPage'] ?? 20)));  // LIMIT 20 default, hard max 100

// Global cache for search results (LRU, max 50 entries, 5min TTL)
$responseCache = [];
$cacheMetadata = [];
$maxCacheEntries = 50;
$cacheTTLSeconds = 300;
$performanceLog = [];  // Query performance tracking
$requestStart = microtime(true);
$concurrencyCounter = 0;
$concurrencyLimit = 3;  // Max concurrent search queries

// Rate limiting per IP (max 10 searches per 60 seconds)
static $rateLimitMap = [];
$clientIP = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$now = time();
if (!isset($rateLimitMap[$clientIP])) {
  $rateLimitMap[$clientIP] = [];
}
// Cleanup old entries (>60 seconds)
$rateLimitMap[$clientIP] = array_filter($rateLimitMap[$clientIP], function($ts) use ($now) {
  return $ts > ($now - 60);
});
$requestsThisPeriod = count($rateLimitMap[$clientIP]);
$maxRequestsPerPeriod = 10;

function h(string $value): string
{
  return htmlspecialchars($value, ENT_QUOTES, 'UTF-8');
}

// Initialize SQLite PRAGMAS for performance
function initializeSQLitePragmas($connection, string $kind): void
{
  if ($kind === 'sqlite3') {
    try {
      $connection->exec('PRAGMA journal_mode=WAL');
      $connection->exec('PRAGMA synchronous=NORMAL');
      $connection->exec('PRAGMA temp_store=MEMORY');
      $connection->exec('PRAGMA cache_size=-20000');  // ~20MB cache for weak hardware
      $connection->exec('PRAGMA mmap_size=30000000');  // Memory-mapped I/O
      $connection->exec('PRAGMA query_only=ON');
      $connection->exec('PRAGMA busy_timeout=5000');
    } catch (Throwable $e) {
      // Silently ignore pragma failures
    }
  } elseif ($kind === 'pdo') {
    try {
      $connection->exec('PRAGMA journal_mode=WAL');
      $connection->exec('PRAGMA synchronous=NORMAL');
      $connection->exec('PRAGMA temp_store=MEMORY');
      $connection->exec('PRAGMA cache_size=-20000');
      $connection->exec('PRAGMA mmap_size=30000000');
      $connection->exec('PRAGMA query_only=ON');
      $connection->exec('PRAGMA busy_timeout=5000');
    } catch (Throwable $e) {
      // Silently ignore pragma failures
    }
  }
}

// Performance logging for slow queries
function logQueryPerformance(string $action, float $startTime, int $resultCount = 0): void
{
  global $performanceLog;
  $elapsed = (microtime(true) - $startTime) * 1000;  // Convert to ms
  if ($elapsed > 100) {  // Log only slow queries (>100ms)
    $performanceLog[] = [
      'action' => $action,
      'ms' => round($elapsed, 2),
      'results' => $resultCount,
    ];
  }
}

// LRU Cache: Get cached search result
function getCachedSearch(string $query, int $page, int $perPage): ?array
{
  global $responseCache, $cacheMetadata, $cacheTTLSeconds;
  $now = time();
  $cacheKey = md5($query . '|' . $page . '|' . $perPage);
  
  if (isset($responseCache[$cacheKey])) {
    if ($cacheMetadata[$cacheKey]['expires'] > $now) {
      $cacheMetadata[$cacheKey]['accessed'] = $now;
      return $responseCache[$cacheKey];
    } else {
      unset($responseCache[$cacheKey], $cacheMetadata[$cacheKey]);
    }
  }
  return null;
}

// LRU Cache: Store search result
function setCachedSearch(string $query, int $page, int $perPage, array $result): void
{
  global $responseCache, $cacheMetadata, $maxCacheEntries, $cacheTTLSeconds;
  $now = time();
  $cacheKey = md5($query . '|' . $page . '|' . $perPage);
  
  // Evict oldest entry if cache is full
  if (count($responseCache) >= $maxCacheEntries) {
    $oldestKey = null;
    $oldestTime = PHP_INT_MAX;
    foreach ($cacheMetadata as $k => $meta) {
      if ($meta['accessed'] < $oldestTime) {
        $oldestTime = $meta['accessed'];
        $oldestKey = $k;
      }
    }
    if ($oldestKey !== null) {
      unset($responseCache[$oldestKey], $cacheMetadata[$oldestKey]);
    }
  }
  
  $responseCache[$cacheKey] = $result;
  $cacheMetadata[$cacheKey] = [
    'accessed' => $now,
    'expires' => $now + $cacheTTLSeconds,
  ];
}

function openQuestDatabase(string $dbPath): array
{
  $reasons = [];

  if (!is_file($dbPath)) {
    return [
      'kind' => 'none',
      'connection' => null,
      'detail' => 'Database file not found.',
    ];
  }

  if (class_exists('SQLite3')) {
    try {
      $sqlite = new SQLite3($dbPath, SQLITE3_OPEN_READONLY);
      initializeSQLitePragmas($sqlite, 'sqlite3');
      return [
        'kind' => 'sqlite3',
        'connection' => $sqlite,
        'detail' => 'Using SQLite3 extension.',
      ];
    } catch (Throwable $e) {
      $reasons[] = 'SQLite3 open failed: ' . $e->getMessage();
    }
  } else {
    $reasons[] = 'SQLite3 extension is not available.';
  }

  if (class_exists('PDO')) {
    if (in_array('sqlite', PDO::getAvailableDrivers(), true)) {
      try {
        $pdo = new PDO('sqlite:' . $dbPath);
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        initializeSQLitePragmas($pdo, 'pdo');
        return [
          'kind' => 'pdo',
          'connection' => $pdo,
          'detail' => 'Using PDO SQLite driver.',
        ];
      } catch (Throwable $e) {
        $reasons[] = 'PDO SQLite open failed: ' . $e->getMessage();
      }
    } else {
      $reasons[] = 'PDO SQLite driver is not enabled.';
    }
  } else {
    $reasons[] = 'PDO is not available.';
  }

  return [
    'kind' => 'none',
    'connection' => null,
    'detail' => implode(' ', $reasons),
  ];
}

function formatTimestamp(int $timestamp): string
{
  if ($timestamp <= 0) {
    return 'Unknown time';
  }

  return gmdate('Y-m-d H:i:s', (int) floor($timestamp / 1000)) . ' UTC';
}

function closeQuestDatabase(array $database): void
{
  $connection = $database['connection'] ?? null;
  $kind = (string) ($database['kind'] ?? 'none');

  if ($kind === 'sqlite3' && $connection instanceof SQLite3) {
    $connection->close();
  }
}

function sqlite3Quote(string $value): string
{
  return "'" . SQLite3::escapeString($value) . "'";
}

function decodeKeywords(mixed $value): array
{
  if (is_array($value)) {
    return array_values(array_map('strval', $value));
  }

  if (!is_string($value) || trim($value) === '') {
    return [];
  }

  $decoded = json_decode($value, true);
  if (!is_array($decoded)) {
    return [];
  }

  return array_values(array_map('strval', $decoded));
}

function readIndexRows(string $path): array
{
  if (!is_file($path)) {
    return [];
  }

  $raw = @file_get_contents($path);
  if ($raw === false) {
    return [];
  }

  $decoded = json_decode($raw, true);
  if (!is_array($decoded)) {
    return [];
  }

  $rows = [];
  foreach ($decoded as $row) {
    if (!is_array($row)) {
      continue;
    }

    $rows[] = [
      'url' => isset($row['url']) ? (string) $row['url'] : '',
      'title' => isset($row['title']) ? (string) $row['title'] : 'Untitled',
      'summary' => isset($row['summary']) ? (string) $row['summary'] : '',
      'keywords' => decodeKeywords($row['keywords'] ?? []),
      'timestamp' => isset($row['timestamp']) ? (int) $row['timestamp'] : 0,
    ];
  }

  return $rows;
}

function countNeedleInFile(string $path, string $needle): int
{
  if (!is_file($path)) {
    return 0;
  }

  $handle = @fopen($path, 'rb');
  if ($handle === false) {
    return 0;
  }

  $count = 0;
  $carry = '';
  $needleLength = strlen($needle);
  $carryLength = max(0, $needleLength - 1);

  while (!feof($handle)) {
    $chunk = fread($handle, 1024 * 1024);
    if ($chunk === false || $chunk === '') {
      continue;
    }

    $buffer = $carry . $chunk;
    $count += substr_count($buffer, $needle);
    $carry = $carryLength > 0 ? substr($buffer, -$carryLength) : '';
  }

  fclose($handle);
  return $count;
}

function countIndexedRowsFromJson(string $path): int
{
  return countNeedleInFile($path, '"url":');
}

function countQueuedUrlsFromCrawlState(string $path): int
{
  return countNeedleInFile($path, '"http');
}

function readJsonObjectFile(string $path): array
{
  if (!is_file($path)) {
    return [];
  }

  $raw = @file_get_contents($path);
  if ($raw === false) {
    return [];
  }

  $decoded = json_decode($raw, true);
  return is_array($decoded) ? $decoded : [];
}

function searchScore(array $row, string $queryLower): int
{
  if ($queryLower === '') {
    return 0;
  }

  $score = 0;
  $title = strtolower((string) ($row['title'] ?? ''));
  $url = strtolower((string) ($row['url'] ?? ''));
  $summary = strtolower((string) ($row['summary'] ?? ''));
  $keywords = strtolower(implode(' ', (array) ($row['keywords'] ?? [])));

  if ($title !== '' && strpos($title, $queryLower) !== false) {
    $score += 12;
  }

  if ($keywords !== '' && strpos($keywords, $queryLower) !== false) {
    $score += 10;
  }

  if ($summary !== '' && strpos($summary, $queryLower) !== false) {
    $score += 8;
  }

  if ($url !== '' && strpos($url, $queryLower) !== false) {
    $score += 6;
  }

  foreach (preg_split('/\s+/', $queryLower) as $token) {
    $t = trim((string) $token);
    if ($t === '' || strlen($t) < 2) {
      continue;
    }

    if (strpos($title, $t) !== false) {
      $score += 4;
    }
    if (strpos($keywords, $t) !== false) {
      $score += 3;
    }
    if (strpos($summary, $t) !== false) {
      $score += 2;
    }
    if (strpos($url, $t) !== false) {
      $score += 1;
    }
  }

  return $score;
}

function fetchRecentRowsFromDb($connection, string $dbKind, int $limit): array
{
  $rows = [];
  $queryStart = microtime(true);

  if ($dbKind === 'pdo') {
    $stmt = $connection->prepare('SELECT url, title, summary, timestamp FROM search_index ORDER BY timestamp DESC LIMIT :limit');
    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->execute();

    foreach ($stmt->fetchAll() as $row) {
      $summary = (string) ($row['summary'] ?? '');
      $snippet = strlen($summary) > 150 ? substr($summary, 0, 150) . '…' : $summary;
      $rows[] = [
        'url' => (string) ($row['url'] ?? ''),
        'title' => (string) ($row['title'] ?? 'Untitled'),
        'snippet' => $snippet,
        'timestamp' => (int) ($row['timestamp'] ?? 0),
      ];
    }

    logQueryPerformance('recent_rows', $queryStart, count($rows));
    return $rows;
  }

  $limit = max(1, (int) $limit);
  $result = $connection->query("SELECT url, title, summary, timestamp FROM search_index ORDER BY timestamp DESC LIMIT {$limit}");
  if (!$result) {
    throw new RuntimeException('SQLite3 could not execute recent rows query.');
  }
  while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
    $summary = (string) ($row['summary'] ?? '');
    $snippet = strlen($summary) > 150 ? substr($summary, 0, 150) . '…' : $summary;
    $rows[] = [
      'url' => (string) ($row['url'] ?? ''),
      'title' => (string) ($row['title'] ?? 'Untitled'),
      'snippet' => $snippet,
      'timestamp' => (int) ($row['timestamp'] ?? 0),
    ];
  }

  $result->finalize();
  logQueryPerformance('recent_rows', $queryStart, count($rows));
  return $rows;
}

function fetchRandomUrlFromDb($connection, string $dbKind): ?string
{
  $queryStart = microtime(true);

  // ORDER BY RANDOM() sorts the whole table to return one row. Instead, jump to
  // a random rowid and take the next row at or after it. rowids can have gaps
  // (deleted rows), so fall back to the first row when the pick lands past the
  // end -- still two index seeks rather than a full scan and sort.
  $sql = 'SELECT url FROM search_index'
    . ' WHERE rowid >= (ABS(RANDOM()) % MAX((SELECT MAX(rowid) FROM search_index), 1))'
    . " AND url <> '' ORDER BY rowid LIMIT 1";
  $fallbackSql = "SELECT url FROM search_index WHERE url <> '' ORDER BY rowid LIMIT 1";

  if ($dbKind === 'pdo') {
    $row = $connection->query($sql)->fetch();
    if (!$row || empty($row['url'])) {
      $row = $connection->query($fallbackSql)->fetch();
    }
    if (!$row || empty($row['url'])) {
      return null;
    }

    logQueryPerformance('random_url', $queryStart, 1);
    return (string) $row['url'];
  }

  $result = $connection->query($sql);
  if (!$result) {
    throw new RuntimeException('SQLite3 could not execute random URL query.');
  }
  $row = $result->fetchArray(SQLITE3_ASSOC);
  $result->finalize();

  if (!$row || empty($row['url'])) {
    $result = $connection->query($fallbackSql);
    if (!$result) {
      throw new RuntimeException('SQLite3 could not execute random URL fallback query.');
    }
    $row = $result->fetchArray(SQLITE3_ASSOC);
    $result->finalize();
  }

  if (!$row || empty($row['url'])) {
    return null;
  }

  logQueryPerformance('random_url', $queryStart, 1);
  return (string) $row['url'];
}

function fetchCountFromDb($connection, string $dbKind, string $tableName): int
{
  $sql = 'SELECT COUNT(*) AS count FROM ' . $tableName;
  if ($dbKind === 'pdo') {
    return (int) (($connection->query($sql)->fetch()['count'] ?? 0));
  }

  $result = $connection->query($sql);
  if (!$result) {
    throw new RuntimeException('SQLite3 count query failed for table ' . $tableName . '.');
  }
  $row = $result ? $result->fetchArray(SQLITE3_ASSOC) : false;
  $result->finalize();
  return (int) (($row['count'] ?? 0));
}

function fetchCrawlerMetaFromDb($connection, string $dbKind): array
{
  $meta = [];
  // The crawler keeps these up to date, including the row counts, so the web
  // layer never has to run COUNT(*) on a multi-hundred-megabyte table.
  $sql = "SELECT key, value FROM meta WHERE key IN ("
    . "'crawler_state', 'crawler_last_heartbeat', 'crawler_started_at', 'crawler_pid', "
    . "'stat_search_index', 'stat_raw_pages', 'stat_queue_pending', 'stat_counts_updated_at')";

  if ($dbKind === 'pdo') {
    $stmt = $connection->prepare($sql);
    $stmt->execute();
    foreach ($stmt->fetchAll() as $row) {
      $meta[(string) $row['key']] = (string) $row['value'];
    }
    return $meta;
  }

  $result = $connection->query($sql);
  if (!$result) {
    throw new RuntimeException('SQLite3 meta query failed.');
  }
  while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
    $meta[(string) $row['key']] = (string) $row['value'];
  }

  $result->finalize();

  return $meta;
}

function fetchQuestStatusFromDb($connection, string $dbKind, string $detail): array
{
  try {
    $meta = fetchCrawlerMetaFromDb($connection, $dbKind);

    // Prefer the counts the crawler cached in meta. Running COUNT(*) against
    // search_index, crawl_queue and raw_pages on every page load was the single
    // most expensive thing this page did. Only fall back to a live count if the
    // crawler has never populated them.
    $indexedPages = isset($meta['stat_search_index'])
      ? (int) $meta['stat_search_index']
      : fetchCountFromDb($connection, $dbKind, 'search_index');
    $queueCount = isset($meta['stat_queue_pending'])
      ? (int) $meta['stat_queue_pending']
      : fetchCountFromDb($connection, $dbKind, 'crawl_queue');
    $rawCount = isset($meta['stat_raw_pages'])
      ? (int) $meta['stat_raw_pages']
      : fetchCountFromDb($connection, $dbKind, 'raw_pages');

    $heartbeatMs = isset($meta['crawler_last_heartbeat']) ? (int) $meta['crawler_last_heartbeat'] : 0;
    $state = $meta['crawler_state'] ?? 'unknown';
    $heartbeatAgeMs = $heartbeatMs > 0 ? max(0, (int) round(microtime(true) * 1000) - $heartbeatMs) : PHP_INT_MAX;
    $isActive = $state === 'active' && $heartbeatAgeMs <= 180000;

    return [
      'storageMode' => 'SQLite database',
      'databaseReadable' => true,
      'databaseDetail' => $detail,
      'indexedPages' => $indexedPages,
      'rawPages' => $rawCount,
      'queueCount' => $queueCount,
      'crawlerActive' => $isActive,
      'crawlerState' => $state,
      'lastHeartbeatLabel' => $heartbeatMs > 0 ? formatTimestamp($heartbeatMs) : 'Unknown',
      'startedAtLabel' => isset($meta['crawler_started_at']) ? formatTimestamp((int) $meta['crawler_started_at']) : 'Unknown',
      'heartbeatAgeSeconds' => $heartbeatAgeMs === PHP_INT_MAX ? null : (int) floor($heartbeatAgeMs / 1000),
      'crawlerPid' => $meta['crawler_pid'] ?? 'Unknown',
    ];
  } catch (Throwable $e) {
    return [
      'storageMode' => 'SQLite database (status unavailable)',
      'databaseReadable' => false,
      'databaseDetail' => $detail . ' Status query failed: ' . $e->getMessage(),
      'indexedPages' => 0,
      'rawPages' => null,
      'queueCount' => 0,
      'crawlerActive' => false,
      'crawlerState' => 'status-unavailable',
      'lastHeartbeatLabel' => 'Unavailable',
      'startedAtLabel' => 'Unavailable',
      'heartbeatAgeSeconds' => null,
      'crawlerPid' => 'Unavailable',
    ];
  }
}

function fetchQuestStatusFromFallback(string $indexPath, string $crawlStatePath, string $detail): array
{
  $indexedPages = countIndexedRowsFromJson($indexPath);
  $queueCount = countQueuedUrlsFromCrawlState($crawlStatePath);

  return [
    'storageMode' => 'JSON fallback',
    'databaseReadable' => false,
    'databaseDetail' => $detail,
    'indexedPages' => $indexedPages,
    'rawPages' => null,
    'queueCount' => $queueCount,
    'crawlerActive' => false,
    'crawlerState' => 'unknown',
    'lastHeartbeatLabel' => 'Unavailable in fallback mode',
    'startedAtLabel' => 'Unavailable in fallback mode',
    'heartbeatAgeSeconds' => null,
    'crawlerPid' => 'Unavailable in fallback mode',
  ];
}

/**
 * Is the FTS5 index present? Built and maintained by the crawler; absent on
 * older databases or SQLite builds without FTS5 compiled in.
 */
function questFtsAvailable($connection, string $dbKind): bool
{
  static $available = null;
  if ($available !== null) {
    return $available;
  }

  $sql = "SELECT name FROM sqlite_master WHERE type='table' AND name='search_fts'";
  try {
    if ($dbKind === 'pdo') {
      $available = (bool) $connection->query($sql)->fetch();
    } else {
      $result = $connection->query($sql);
      $available = $result ? (bool) $result->fetchArray(SQLITE3_ASSOC) : false;
      if ($result) {
        $result->finalize();
      }
    }
  } catch (Throwable $e) {
    $available = false;
  }

  return $available;
}

/**
 * Turn user input into a safe FTS5 MATCH expression.
 *
 * FTS5 treats characters like -, ^, *, ", : and the words AND/OR/NOT/NEAR as
 * operators, so a raw query string can both error out and change the meaning of
 * the search. Keep only letters, digits and underscores, then quote each token
 * as a literal. Tokens are OR-ed to match the permissive behaviour of the
 * previous LIKE query; bm25 does the ranking.
 */
function buildFtsMatchExpression(string $queryLower): string
{
  if (!preg_match_all('/[\p{L}\p{N}_]+/u', $queryLower, $matches)) {
    return '';
  }

  $tokens = [];
  foreach ($matches[0] as $token) {
    if ($token !== '') {
      $tokens[] = '"' . $token . '"';
    }
  }

  return implode(' OR ', array_unique($tokens));
}

/**
 * FTS5 search path. Replaces two full table scans (one for COUNT, one for the
 * rows) with index lookups. Returns null when FTS cannot serve the query, so
 * the caller falls back to the original LIKE implementation.
 */
function fetchSearchRowsFromFts($connection, string $dbKind, string $queryLower, int $page, int $perPage): ?array
{
  $match = buildFtsMatchExpression($queryLower);
  if ($match === '') {
    return null;
  }

  $queryStart = microtime(true);

  // Column order in the virtual table is title, summary, keywords_json, url.
  // bm25 returns more-negative values for better matches, so order ascending.
  $rankExpr = 'bm25(search_fts, 12.0, 8.0, 10.0, 6.0)';
  $countSql = 'SELECT COUNT(*) AS count FROM (SELECT rowid FROM search_fts WHERE search_fts MATCH ? LIMIT 1000)';
  // Rank inside the FTS index first, then fetch only the rows shown. Joining
  // before ranking read every matching search_index row from disk -- tens of
  // thousands for a common word, minutes on the server's disk.
  $rowsSql =
    'SELECT s.url AS url, s.title AS title, s.summary AS summary, s.timestamp AS timestamp, r.rank AS rank '
    . 'FROM (SELECT rowid, ' . $rankExpr . ' AS rank FROM search_fts WHERE search_fts MATCH ? '
    . 'ORDER BY rank LIMIT ? OFFSET ?) r '
    . 'JOIN search_index s ON s.rowid = r.rowid ORDER BY r.rank';

  $shape = static function (array $row): array {
    $summary = (string) ($row['summary'] ?? '');
    $snippet = strlen($summary) > 150 ? substr($summary, 0, 150) . '…' : $summary;
    return [
      'url' => (string) ($row['url'] ?? ''),
      'title' => (string) ($row['title'] ?? 'Untitled'),
      'snippet' => $snippet,
      'timestamp' => (int) ($row['timestamp'] ?? 0),
      // Present a positive, human-facing relevance number.
      'score' => (int) round(-1 * (float) ($row['rank'] ?? 0)),
    ];
  };

  if ($dbKind === 'pdo') {
    $countStmt = $connection->prepare($countSql);
    $countStmt->bindValue(1, $match, PDO::PARAM_STR);
    $countStmt->execute();
    $totalResults = (int) ($countStmt->fetch()['count'] ?? 0);
    $totalPages = max(1, (int) ceil($totalResults / $perPage));
    $page = min($page, $totalPages);

    $stmt = $connection->prepare($rowsSql);
    $stmt->bindValue(1, $match, PDO::PARAM_STR);
    $stmt->bindValue(2, $perPage, PDO::PARAM_INT);
    $stmt->bindValue(3, ($page - 1) * $perPage, PDO::PARAM_INT);
    $stmt->execute();

    $rows = [];
    foreach ($stmt->fetchAll() as $row) {
      $rows[] = $shape($row);
    }

    logQueryPerformance('search_fts', $queryStart, count($rows));
    return ['results' => $rows, 'totalResults' => $totalResults, 'totalPages' => $totalPages];
  }

  $countStmt = $connection->prepare($countSql);
  if (!$countStmt) {
    return null;
  }
  $countStmt->bindValue(1, $match, SQLITE3_TEXT);
  $countResult = $countStmt->execute();
  if (!$countResult) {
    return null;
  }
  $totalResults = (int) (($countResult->fetchArray(SQLITE3_ASSOC)['count']) ?? 0);
  $countResult->finalize();

  $totalPages = max(1, (int) ceil($totalResults / $perPage));
  $page = min($page, $totalPages);

  $stmt = $connection->prepare($rowsSql);
  if (!$stmt) {
    return null;
  }
  $stmt->bindValue(1, $match, SQLITE3_TEXT);
  $stmt->bindValue(2, $perPage, SQLITE3_INTEGER);
  $stmt->bindValue(3, ($page - 1) * $perPage, SQLITE3_INTEGER);
  $result = $stmt->execute();
  if (!$result) {
    return null;
  }

  $rows = [];
  while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
    $rows[] = $shape($row);
  }
  $result->finalize();

  logQueryPerformance('search_fts', $queryStart, count($rows));
  return ['results' => $rows, 'totalResults' => $totalResults, 'totalPages' => $totalPages];
}

function fetchSearchRowsFromDb($connection, string $dbKind, string $query, int $page, int $perPage): array
{
  global $concurrencyCounter, $concurrencyLimit;
  $queryStart = microtime(true);

  $queryLower = strtolower(trim($query));
  if ($queryLower === '') {
    return [
      'results' => [],
      'totalResults' => 0,
      'totalPages' => 1,
    ];
  }

  // Check cache first
  $cached = getCachedSearch($query, $page, $perPage);
  if ($cached !== null) {
    return $cached;
  }

  // Concurrency limit check
  $concurrencyCounter++;
  if ($concurrencyCounter > $concurrencyLimit) {
    $concurrencyCounter--;
    throw new RuntimeException('Too many concurrent searches. Please try again.');
  }

  try {
    // Fast path: FTS5 index lookup. Any problem here (no FTS5, malformed match
    // expression, stale index) falls through to the LIKE scan below, which is
    // slow but always correct.
    if (questFtsAvailable($connection, $dbKind)) {
      try {
        $ftsResult = fetchSearchRowsFromFts($connection, $dbKind, $queryLower, $page, $perPage);
        if ($ftsResult !== null) {
          setCachedSearch($query, $page, $perPage, $ftsResult);
          return $ftsResult;
        }
      } catch (Throwable $e) {
        // Fall through to the LIKE implementation.
      }
    }

    $tokens = array_values(array_filter(preg_split('/\s+/', $queryLower) ?: [], static function (string $token): bool {
      return strlen(trim($token)) >= 2;
    }));

    $scoreParts = [];
    $scoreParams = [];
    $whereParts = [];
    $whereParams = [];

    $fullPattern = '%' . $queryLower . '%';
    foreach ([['lower(title)', 12], ['lower(keywords_json)', 10], ['lower(summary)', 8], ['lower(url)', 6]] as [$field, $weight]) {
      $scoreParts[] = "CASE WHEN {$field} LIKE ? THEN {$weight} ELSE 0 END";
      $scoreParams[] = $fullPattern;
      $whereParts[] = "{$field} LIKE ?";
      $whereParams[] = $fullPattern;
    }

    foreach ($tokens as $token) {
      $pattern = '%' . $token . '%';
      foreach ([['lower(title)', 4], ['lower(keywords_json)', 3], ['lower(summary)', 2], ['lower(url)', 1]] as [$field, $weight]) {
        $scoreParts[] = "CASE WHEN {$field} LIKE ? THEN {$weight} ELSE 0 END";
        $scoreParams[] = $pattern;
        $whereParts[] = "{$field} LIKE ?";
        $whereParams[] = $pattern;
      }
    }

    $scoreExpr = implode(' + ', $scoreParts);
    $whereExpr = implode(' OR ', $whereParts);

    if ($dbKind === 'pdo') {
      $countStmt = $connection->prepare("SELECT COUNT(*) AS count FROM search_index WHERE {$whereExpr}");
      foreach ($whereParams as $index => $value) {
        $countStmt->bindValue($index + 1, $value, PDO::PARAM_STR);
      }
      $countStmt->execute();
      $totalResults = (int) ($countStmt->fetch()['count'] ?? 0);
      $totalResults = min($totalResults, 1000);  // Hard cap on result estimation
      $totalPages = max(1, (int) ceil($totalResults / $perPage));
      $page = min($page, $totalPages);
      $offset = ($page - 1) * $perPage;

      $sql = "SELECT url, title, summary, timestamp, ({$scoreExpr}) AS score FROM search_index WHERE {$whereExpr} ORDER BY score DESC, timestamp DESC LIMIT ? OFFSET ?";
      $stmt = $connection->prepare($sql);
      $bindIndex = 1;
      foreach ($scoreParams as $value) {
        $stmt->bindValue($bindIndex, $value, PDO::PARAM_STR);
        $bindIndex += 1;
      }
      foreach ($whereParams as $value) {
        $stmt->bindValue($bindIndex, $value, PDO::PARAM_STR);
        $bindIndex += 1;
      }
      $stmt->bindValue($bindIndex, $perPage, PDO::PARAM_INT);
      $stmt->bindValue($bindIndex + 1, $offset, PDO::PARAM_INT);
      $stmt->execute();

      $rows = [];
      foreach ($stmt->fetchAll() as $row) {
        $summary = (string) ($row['summary'] ?? '');
        $snippet = strlen($summary) > 150 ? substr($summary, 0, 150) . '…' : $summary;
        $rows[] = [
          'url' => (string) ($row['url'] ?? ''),
          'title' => (string) ($row['title'] ?? 'Untitled'),
          'snippet' => $snippet,
          'timestamp' => (int) ($row['timestamp'] ?? 0),
          'score' => (int) ($row['score'] ?? 0),
        ];
      }

      $result = [
        'results' => $rows,
        'totalResults' => $totalResults,
        'totalPages' => $totalPages,
      ];
      logQueryPerformance('search', $queryStart, count($rows));
      setCachedSearch($query, $page, $perPage, $result);
      return $result;
    }

    $scoreParts = [];
    $whereParts = [];

    $fullPatternLiteral = sqlite3Quote($fullPattern);
    foreach ([['lower(title)', 12], ['lower(keywords_json)', 10], ['lower(summary)', 8], ['lower(url)', 6]] as [$field, $weight]) {
      $scoreParts[] = "CASE WHEN {$field} LIKE {$fullPatternLiteral} THEN {$weight} ELSE 0 END";
      $whereParts[] = "{$field} LIKE {$fullPatternLiteral}";
    }

    foreach ($tokens as $token) {
      $patternLiteral = sqlite3Quote('%' . $token . '%');
      foreach ([['lower(title)', 4], ['lower(keywords_json)', 3], ['lower(summary)', 2], ['lower(url)', 1]] as [$field, $weight]) {
        $scoreParts[] = "CASE WHEN {$field} LIKE {$patternLiteral} THEN {$weight} ELSE 0 END";
        $whereParts[] = "{$field} LIKE {$patternLiteral}";
      }
    }

    $scoreExpr = implode(' + ', $scoreParts);
    $whereExpr = implode(' OR ', $whereParts);
    $countResult = $connection->query("SELECT COUNT(*) AS count FROM search_index WHERE {$whereExpr}");
    if (!$countResult) {
      throw new RuntimeException('SQLite3 could not execute search count query.');
    }
    $countRow = $countResult ? $countResult->fetchArray(SQLITE3_ASSOC) : false;
    $countResult->finalize();
    $totalResults = (int) ($countRow['count'] ?? 0);
    $totalResults = min($totalResults, 1000);  // Hard cap on result estimation
    $totalPages = max(1, (int) ceil($totalResults / $perPage));
    $page = min($page, $totalPages);
    $offset = ($page - 1) * $perPage;

    $limit = max(1, (int) $perPage);
    $offset = max(0, (int) $offset);
    $result = $connection->query("SELECT url, title, summary, timestamp, ({$scoreExpr}) AS score FROM search_index WHERE {$whereExpr} ORDER BY score DESC, timestamp DESC LIMIT {$limit} OFFSET {$offset}");
    if (!$result) {
      throw new RuntimeException('SQLite3 could not execute search results query.');
    }

    $rows = [];
    while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
      $summary = (string) ($row['summary'] ?? '');
      $snippet = strlen($summary) > 150 ? substr($summary, 0, 150) . '…' : $summary;
      $rows[] = [
        'url' => (string) ($row['url'] ?? ''),
        'title' => (string) ($row['title'] ?? 'Untitled'),
        'snippet' => $snippet,
        'timestamp' => (int) ($row['timestamp'] ?? 0),
        'score' => (int) ($row['score'] ?? 0),
      ];
    }

    $result->finalize();

    $finalResult = [
      'results' => $rows,
      'totalResults' => $totalResults,
      'totalPages' => $totalPages,
    ];
    logQueryPerformance('search', $queryStart, count($rows));
    setCachedSearch($query, $page, $perPage, $finalResult);
    return $finalResult;
  } finally {
    $concurrencyCounter--;
  }
}

$database = openQuestDatabase($dbPath);
$dbConnection = $database['connection'];
$dbKind = (string) $database['kind'];
$dbAvailable = $dbConnection !== null;
$rows = [];

// fetchQuestStatusFromFallback() byte-scans search_index.json and
// crawl_state.json end to end, so it must only run when the database is
// genuinely unavailable -- never as a default that the DB path overwrites.
$status = $dbAvailable
  ? []
  : fetchQuestStatusFromFallback($indexPath, $crawlStatePath, (string) $database['detail']);

if ($dbAvailable) {
  try {
    $status = fetchQuestStatusFromDb($dbConnection, $dbKind, (string) $database['detail']);
  } catch (Throwable $e) {
    closeQuestDatabase($database);
    $database = [
      'kind' => 'none',
      'connection' => null,
      'detail' => ((string) $database['detail']) . ' Database read failed: ' . $e->getMessage(),
    ];
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

if (isset($_GET['random']) && $_GET['random'] === '1') {
  if ($dbAvailable) {
    try {
      $randomUrl = fetchRandomUrlFromDb($dbConnection, $dbKind);
      if ($randomUrl !== null) {
        header('Location: ' . $randomUrl);
        closeQuestDatabase($database);
        exit;
      }
    } catch (Throwable $e) {
      closeQuestDatabase($database);
      $database = [
        'kind' => 'none',
        'connection' => null,
        'detail' => ((string) $database['detail']) . ' Random query failed: ' . $e->getMessage(),
      ];
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
      header('Location: ' . (string) $pick['url']);
      exit;
    }
  }
}

if ($dbAvailable) {
  try {
    $recent = fetchRecentRowsFromDb($dbConnection, $dbKind, 5);
  } catch (Throwable $e) {
    closeQuestDatabase($database);
    $database = [
      'kind' => 'none',
      'connection' => null,
      'detail' => ((string) $database['detail']) . ' Recent query failed: ' . $e->getMessage(),
    ];
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
  // Apply rate limiting
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
        $database = [
          'kind' => 'none',
          'connection' => null,
          'detail' => ((string) $database['detail']) . ' Search query failed: ' . $e->getMessage(),
        ];
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
  <title><?= $query !== '' ? h($query) . ' | ' : '' ?>xSearch | XIO</title>
  <meta name="theme-color" content="#000000" />
  <link rel="icon" href="/xio/logo.png" type="image/png" />
  <link rel="stylesheet" href="../xio.css" />
</head>

<body>
  <?= xioTopbar('search') ?>

  <div class="container">
    <section class="hero center">
      <?= xioMark('mark mark-big') ?>
      <h1><a href="?">xSearch</a></h1>
      <p class="kicker">An XIO project</p>
      <p class="sub">Search the web through QUEST's independent index.</p>
      <form method="get" action="" class="searchbox">
        <span class="prompt">&gt;</span>
        <input type="search" name="q" value="<?= h($query) ?>" placeholder="Search by title, URL, summary, or keywords"
          aria-label="Search query" />
        <button type="submit">Search</button>
      </form>
      <div class="actions">
        <form method="get" action="">
          <input type="hidden" name="random" value="1" />
          <button type="submit" class="btn">Random webpage</button>
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
              <p class="title"><?= h((string) $item['title']) ?></p>
              <a class="url" href="<?= h((string) $item['url']) ?>"><?= h((string) $item['url']) ?></a>
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
      <h2>Search Results<?= $query !== '' ? ' for "' . h($query) . '"' : '' ?></h2>
      <?php if ($query === ''): ?>
        <p class="empty">Enter a query to search indexed pages.</p>
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
            <p class="title"><?= h((string) $item['title']) ?></p>
            <a class="url" href="<?= h((string) $item['url']) ?>"><?= h((string) $item['url']) ?></a>
            <div class="meta">Indexed: <?= h(formatTimestamp((int) $item['timestamp'])) ?> | Score:
              <?= (int) ($item['score'] ?? 0) ?>
            </div>
            <?php if (!empty($item['snippet'])): ?>
              <p class="summary"><?= h((string) $item['snippet']) ?></p>
            <?php endif; ?>
          </article>
        <?php endforeach; ?>

        <?php if ($totalPages > 1): ?>
          <nav class="pagination" aria-label="Search result pages">
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
      <h2 id="status-title">xSearch Status</h2>
      <p class="sub">Current storage and crawler health information.</p>

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
          <span
            class="status-value"><?= $status['heartbeatAgeSeconds'] !== null ? h((string) $status['heartbeatAgeSeconds']) . ' seconds' : 'Unavailable' ?></span>
        </div>
        <div class="status-item">
          <span class="status-label">Crawler Started</span>
          <span class="status-value"><?= h((string) $status['startedAtLabel']) ?></span>
        </div>
        <div class="status-item">
          <span class="status-label">Crawler PID</span>
          <span class="status-value"><?= h((string) $status['crawlerPid']) ?></span>
        </div>
        <!-- <div class="status-item">
          <span class="status-label">Raw Pages Stored</span>
          <span class="status-value"><?= $status['rawPages'] !== null ? h((string) $status['rawPages']) : 'Unavailable in fallback mode' ?></span>
        </div> -->
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