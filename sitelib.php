<?php

declare(strict_types=1);

/**
 * Helpers shared by xImages (images/) and xWire (xwire/), on top of the
 * archive's helpers (h(), openQuestDatabase()).
 *
 * Both sites read their own database file, written by the Node side:
 *   data/images.sqlite  image_store.js (crawler, maintain.js --index-media)
 *   data/feeds.sqlite   feed_store.js (crawler discovers, feeds.js fetches)
 */

require_once __DIR__ . '/archive/lib.php';
require_once __DIR__ . '/xio.php';

function questDataPath(string $file): string
{
  return __DIR__ . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . $file;
}

/** Run a query with positional (?) parameters on either driver; rows as arrays. */
function qAll(array $database, string $sql, array $params = []): array
{
  $connection = $database['connection'];
  if ($connection === null) {
    return [];
  }
  if ($database['kind'] === 'sqlite3') {
    $statement = $connection->prepare($sql);
    if ($statement === false) {
      throw new RuntimeException('Query failed: ' . $connection->lastErrorMsg());
    }
    foreach (array_values($params) as $i => $value) {
      $type = is_int($value) ? SQLITE3_INTEGER : (is_float($value) ? SQLITE3_FLOAT : SQLITE3_TEXT);
      $statement->bindValue($i + 1, $value, $type);
    }
    $result = $statement->execute();
    $rows = [];
    while ($result && ($row = $result->fetchArray(SQLITE3_ASSOC)) !== false) {
      $rows[] = $row;
    }
    return $rows;
  }
  $statement = $connection->prepare($sql);
  $statement->execute(array_values($params));
  return $statement->fetchAll(PDO::FETCH_ASSOC);
}

function qOne(array $database, string $sql, array $params = []): ?array
{
  $rows = qAll($database, $sql, $params);
  return $rows[0] ?? null;
}

/**
 * Words from a search box -> an FTS5 MATCH expression: every word required,
 * the last one as a prefix so results appear while a word is half-typed.
 * Quoting each term keeps FTS5 operators in user input from doing anything.
 */
function ftsMatchExpression(string $query): string
{
  preg_match_all('/[\p{L}\p{N}]+/u', mb_strtolower($query), $matches);
  $terms = array_slice($matches[0], 0, 8);
  if (count($terms) === 0) {
    return '';
  }
  $quoted = array_map(static fn(string $t): string => '"' . $t . '"', $terms);
  $quoted[count($quoted) - 1] .= '*';
  return implode(' ', $quoted);
}

/** "3 min ago", "2 days ago", or a date for anything older than a month. */
function timeAgo(int $epochMs): string
{
  $seconds = max(0, (int) floor((microtime(true) * 1000 - $epochMs) / 1000));
  if ($seconds < 60) {
    return 'just now';
  }
  $units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['min', 60]];
  if ($seconds >= 2592000) {
    return gmdate('j M Y', intdiv($epochMs, 1000));
  }
  foreach ($units as [$name, $size]) {
    if ($seconds >= $size) {
      $n = intdiv($seconds, $size);
      return $n . ' ' . $name . ($n === 1 || $name === 'min' ? '' : 's') . ' ago';
    }
  }
  return 'just now';
}

/** Host part of a URL for display, without "www.". */
function displayHost(string $url): string
{
  $host = (string) parse_url($url, PHP_URL_HOST);
  return preg_replace('/^www\./', '', $host) ?? $host;
}

/** Only http(s) URLs ever reach an href or src. */
function safeUrl(string $url): string
{
  return preg_match('#^https?://#i', $url) ? $url : '';
}

/**
 * CSS shared by xImages, xWire and EXYRA, on top of ../xio.css. Inside .ui
 * bare blocks start neutral, so grids and posts never inherit paragraph or
 * section spacing they didn't ask for. Zero specificity: any class wins.
 */
function sharedSiteCss(): string
{
  return <<<'CSS'
    :where(.ui, .ui div, .ui section, .ui article, .ui main, .ui aside, .ui figure, .ui header, .ui nav, .ui p) {
      margin: 0; padding: 0; border: 0; border-radius: 0; min-height: 0;
      background: none; box-shadow: none; backdrop-filter: none;
    }
CSS;
}
