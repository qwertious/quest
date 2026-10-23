<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/sitelib.php';

/**
 * xWire: a timeline of posts from every feed QUEST's crawler has found --
 * RSS, Atom, RSS 1.0 and JSON Feed, which covers blogs, news, podcasts,
 * YouTube channels and Mastodon accounts. Fetched by feeds.js into
 * data/feeds.sqlite.
 *
 *   ?               latest posts, at most a few per source per page
 *   ?q=words        search posts
 *   ?feed=ID        one source's page
 *   ?view=discover  the most active sources
 */

const PER_PAGE = 30;
const MAX_PER_SOURCE = 3;

$query = isset($_GET['q']) ? trim((string) $_GET['q']) : '';
$feedId = isset($_GET['feed']) ? max(0, (int) $_GET['feed']) : 0;
$view = ($_GET['view'] ?? '') === 'discover' ? 'discover' : 'timeline';
$page = isset($_GET['page']) ? max(1, min(100, (int) $_GET['page'])) : 1;
// Timeline cursor: "<published_at>_<id>" of the last post shown.
$before = isset($_GET['before']) && preg_match('/^(\d+)_(\d+)$/', (string) $_GET['before'], $m)
  ? [(int) $m[1], (int) $m[2]] : null;


$database = openQuestDatabase(questDataPath('feeds.sqlite'));
$posts = [];
$feed = null;
$sources = [];
$activeSources = [];
$stats = ['active' => 0, 'posts' => 0, 'heartbeat' => 0, 'state' => ''];
$nextLink = '';
$prevLink = '';
$hiddenBySource = [];
$error = '';

$postColumns = 'p.id, p.url, p.title, p.summary, p.image_url, p.author, p.published_at,
  f.id AS feed_id, f.title AS feed_title, f.icon_url, f.home_url, f.site, f.url AS feed_url';

if ($database['connection'] !== null) {
  try {
    $stats['active'] = (int) (qOne($database, "SELECT COUNT(*) AS n FROM feeds WHERE state = 'active'")['n'] ?? 0);
    $stats['posts'] = (int) (qOne($database, 'SELECT MAX(id) AS n FROM posts')['n'] ?? 0);
    $stats['heartbeat'] = (int) (qOne($database, "SELECT value FROM meta WHERE key = 'feeds_heartbeat'")['value'] ?? 0);
    $stats['state'] = (string) (qOne($database, "SELECT value FROM meta WHERE key = 'feeds_state'")['value'] ?? '');
    $activeSources = qAll(
      $database,
      "SELECT id, title, icon_url, site, home_url, post_count, last_post_at FROM feeds
        WHERE state = 'active' AND post_count > 0 ORDER BY last_post_at DESC LIMIT 8",
    );

    if ($feedId > 0) {
      $feed = qOne($database, 'SELECT * FROM feeds WHERE id = ?', [$feedId]);
      if ($feed !== null) {
        $posts = qAll(
          $database,
          "SELECT $postColumns FROM posts p JOIN feeds f ON f.id = p.feed_id
            WHERE p.feed_id = ? ORDER BY p.published_at DESC, p.id DESC LIMIT ? OFFSET ?",
          [$feedId, PER_PAGE + 1, ($page - 1) * PER_PAGE],
        );
      }
    } elseif ($query !== '') {
      $match = ftsMatchExpression($query);
      if ($match !== '') {
        $posts = qAll(
          $database,
          // Rank inside the FTS index, then join only the posts shown.
          "SELECT $postColumns FROM (SELECT rowid, bm25(posts_fts, 3.0, 1.0, 1.0) AS rank FROM posts_fts
              WHERE posts_fts MATCH ? ORDER BY rank LIMIT ? OFFSET ?) s
            JOIN posts p ON p.id = s.rowid JOIN feeds f ON f.id = p.feed_id
            ORDER BY s.rank, p.published_at DESC",
          [$match, PER_PAGE + 1, ($page - 1) * PER_PAGE],
        );
      }
    } elseif ($view === 'discover') {
      $sources = qAll(
        $database,
        "SELECT id, title, description, icon_url, site, home_url, url, post_count, last_post_at FROM feeds
          WHERE state = 'active' AND post_count > 0 ORDER BY last_post_at DESC LIMIT ? OFFSET ?",
        [PER_PAGE + 1, ($page - 1) * PER_PAGE],
      );
    } else {
      // Read a few pages' worth and keep at most MAX_PER_SOURCE per source,
      // so one prolific feed can't fill the timeline.
      $now = (int) floor(microtime(true) * 1000);
      [$beforeTime, $beforeId] = $before ?? [$now + 3600000, PHP_INT_MAX];
      $rows = qAll(
        $database,
        "SELECT $postColumns FROM posts p JOIN feeds f ON f.id = p.feed_id
          WHERE p.published_at < ? OR (p.published_at = ? AND p.id < ?)
          ORDER BY p.published_at DESC, p.id DESC LIMIT ?",
        [$beforeTime, $beforeTime, $beforeId, PER_PAGE * 4],
      );
      $perSource = [];
      $last = null;
      foreach ($rows as $row) {
        $last = $row;
        $source = (int) $row['feed_id'];
        $perSource[$source] = ($perSource[$source] ?? 0) + 1;
        if ($perSource[$source] > MAX_PER_SOURCE) {
          $hiddenBySource[$source] = ($hiddenBySource[$source] ?? 0) + 1;
          continue;
        }
        $posts[] = $row;
        if (count($posts) === PER_PAGE) {
          break;
        }
      }
      if ($last !== null && count($rows) >= PER_PAGE) {
        $nextLink = '?' . http_build_query(['before' => $last['published_at'] . '_' . $last['id']]);
      }
    }
  } catch (Throwable $e) {
    $error = 'xWire could not read its posts right now.';
  }
} else {
  $error = 'No feeds have been collected yet. They appear as the crawler finds them and the feed reader (feeds.js) fetches them.';
}
closeQuestDatabase($database);

// Offset-paged views: a next page exists if we got one row more than shown.
if ($before === null && ($feedId > 0 || $query !== '' || $view === 'discover')) {
  $base = array_filter(['q' => $query, 'feed' => $feedId ?: null, 'view' => $view === 'discover' ? 'discover' : null]);
  $hasMore = count($posts) > PER_PAGE || count($sources) > PER_PAGE;
  $posts = array_slice($posts, 0, PER_PAGE);
  $sources = array_slice($sources, 0, PER_PAGE);
  if ($hasMore) {
    $nextLink = '?' . http_build_query($base + ['page' => $page + 1]);
  }
  if ($page > 1) {
    $prevLink = '?' . http_build_query($base + ['page' => $page - 1]);
  }
}

/** Initial-letter avatar color from the site name, stable across visits. */
function avatarHue(string $site): int
{
  return (int) (crc32($site) % 360);
}

function avatar(string $iconUrl, string $title, string $site, string $class = 'avatar'): string
{
  $letter = mb_strtoupper(mb_substr(trim($title) !== '' ? trim($title) : $site, 0, 1));
  $fallback = '<span class="' . $class . ' initial" style="--hue:' . avatarHue($site) . '" aria-hidden="true">' . h($letter) . '</span>';
  if (safeUrl($iconUrl) === '') {
    return $fallback;
  }
  return '<span class="' . $class . '-wrap"><img class="' . $class . '" src="' . h($iconUrl) . '" alt="" loading="lazy" referrerpolicy="no-referrer"'
    . ' onerror="this.replaceWith(this.nextElementSibling.content.cloneNode(true))" />'
    . '<template>' . $fallback . '</template></span>';
}

$heartbeatAge = $stats['heartbeat'] > 0 ? (int) floor((microtime(true) * 1000 - $stats['heartbeat']) / 1000) : null;
$readerLive = $heartbeatAge !== null && $heartbeatAge < 120 && $stats['state'] === 'active';
?>
<!doctype html>
<html lang="en">

<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="referrer" content="no-referrer" />
  <title><?= $feed !== null ? h((string) ($feed['title'] ?: $feed['site'])) . ' | ' : '' ?>xWire</title>
  <meta name="theme-color" content="#000000" />
  <link rel="icon" href="/xio/logo.png" type="image/png" />
  <link rel="stylesheet" href="../xio.css" />
  <style>
    <?= sharedSiteCss() ?>

    .layout { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 1.25rem; align-items: start; }
    .tabs { display: flex; gap: 0.4rem; margin: 0 0 0.9rem; }
    .tabs a { color: var(--dim); padding: 0.4rem 0.85rem; border: 1px solid var(--rule-hi); font-size: 0.72rem; letter-spacing: 0.14em; text-transform: uppercase; transition: background 140ms, color 140ms, border-color 140ms; }
    .tabs a:hover { color: var(--fg); border-color: var(--fg); }
    .tabs a[aria-current="page"] { background: var(--fg); border-color: var(--fg); color: var(--bg); }

    .post { display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 0.75rem; padding: 1rem 0; border-bottom: 1px solid var(--rule); }
    .avatar, .avatar-wrap { width: 44px; height: 44px; border-radius: 50%; display: block; }
    .avatar { object-fit: cover; background: var(--panel-hi); }
    .initial, .avatar-lg.initial { display: flex; align-items: center; justify-content: center; font-weight: 700; color: var(--fg);
      background: var(--panel-hi); border: 1px solid var(--rule-hi); }
    .byline { display: flex; flex-wrap: wrap; gap: 0 0.45rem; align-items: baseline; font-size: 0.92rem; }
    .byline .who { font-weight: 700; color: var(--fg); }
    .byline .who:hover { text-decoration: underline; }
    .byline .meta { color: var(--faint); font-size: 0.74rem; margin: 0; }
    .post h3 { margin: 0.25rem 0 0.2rem; font-size: 1.02rem; line-height: 1.35; }
    .post h3 a { color: var(--fg); }
    .post h3 a:hover { text-decoration: underline; text-underline-offset: 3px; }
    .post .summary { margin: 0.2rem 0 0; overflow-wrap: anywhere; }
    .post .media { margin-top: 0.6rem; overflow: hidden; border: 1px solid var(--rule); max-height: 420px; }
    .post .media img { width: 100%; max-height: 420px; object-fit: cover; display: block; }
    .post .actions { display: flex; gap: 1rem; margin-top: 0.5rem; font-size: 0.72rem; }
    .post .actions a { color: var(--dim); }
    .post .actions a:hover { color: var(--fg); }
    .more-from { font-size: 0.72rem; color: var(--faint); margin-top: 0.35rem; }
    .more-from a { color: inherit; }

    .profile { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 1rem; align-items: center; padding: 1rem; border: 1px solid var(--rule-hi); background: var(--panel); margin-bottom: 0.5rem; }
    .avatar-lg, .avatar-lg-wrap { width: 72px; height: 72px; border-radius: 50%; display: flex; font-size: 1.8rem; }
    img.avatar-lg { object-fit: cover; }
    .profile h2 { margin: 0; font-size: 1.25rem; overflow-wrap: anywhere; }
    .profile p { margin: 0.3rem 0 0; }
    .profile .links { display: flex; gap: 1rem; flex-wrap: wrap; margin-top: 0.4rem; font-size: 0.88rem; }
    .profile .links a { color: var(--dim); }
    .profile .links a:hover { color: var(--fg); }

    aside .box { border: 1px solid var(--rule); background: var(--panel); padding: 0.9rem 1rem; margin-bottom: 1rem; }
    .source { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 0.6rem; align-items: center; padding: 0.35rem 0; color: inherit; text-decoration: none; }
    .source .avatar, .source .avatar-wrap { width: 32px; height: 32px; font-size: 0.85rem; }
    .source .name { font-weight: 600; font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .source .meta { color: var(--faint); font-size: 0.7rem; margin: 0; }
    .reader { font-size: 0.78rem; color: var(--dim); line-height: 1.6; }
    .dot { display: inline-block; width: 0.55rem; height: 0.55rem; border-radius: 50%; margin-right: 0.35rem; background: var(--faint); }
    .dot.live { background: var(--good); }
    .discover .source { grid-template-columns: 44px minmax(0, 1fr); padding: 0.8rem 0; border-bottom: 1px solid var(--rule); }
    .discover .source .avatar, .discover .source .avatar-wrap { width: 44px; height: 44px; }
    .discover .desc { color: var(--dim); font-family: var(--read); font-size: 0.86rem; margin-top: 0.15rem; }

    @media (max-width: 860px) {
      .layout { grid-template-columns: 1fr; }
      aside { order: 2; }
    }
  </style>
</head>

<body>
  <?= xioTopbar('xwire') ?>

  <div class="container">
    <section class="hero">
      <h1>xWire</h1>
      <p class="sub">Posts from every feed QUEST has found across the web &mdash; blogs, news, podcasts, channels and more.</p>
      <form method="get" action="" class="searchbox" role="search">
        <input type="search" name="q" value="<?= h($query) ?>" placeholder="Search posts" aria-label="Search posts" />
        <button type="submit">Search</button>
      </form>
    </section>

    <div class="layout ui">
      <main>
        <?php if ($feed === null && $query === ''): ?>
          <nav class="tabs" aria-label="xWire views">
            <a href="./" <?= $view === 'timeline' ? 'aria-current="page"' : '' ?>>Latest</a>
            <a href="?view=discover" <?= $view === 'discover' ? 'aria-current="page"' : '' ?>>Discover</a>
          </nav>
        <?php endif; ?>

        <?php if ($error !== ''): ?>
          <p class="notice"><?= h($error) ?></p>
        <?php endif; ?>

        <?php if ($feedId > 0 && $feed === null && $error === ''): ?>
          <p class="notice">That source doesn't exist. <a href="./">Back to the timeline</a>.</p>
        <?php endif; ?>

        <?php if ($feed !== null):
          $feedTitle = (string) ($feed['title'] !== '' ? $feed['title'] : $feed['site']); ?>
          <section class="profile" aria-label="Source">
            <?= avatar((string) $feed['icon_url'], $feedTitle, (string) $feed['site'], 'avatar-lg') ?>
            <div>
              <h2><?= h($feedTitle) ?></h2>
              <?php if ($feed['description'] !== ''): ?><p><?= h((string) $feed['description']) ?></p><?php endif; ?>
              <div class="links">
                <?php if (safeUrl((string) $feed['home_url']) !== ''): ?>
                  <a href="<?= h((string) $feed['home_url']) ?>" target="_blank" rel="noopener noreferrer"><?= h(displayHost((string) $feed['home_url'])) ?> &#8599;</a>
                <?php endif; ?>
                <a href="<?= h(safeUrl((string) $feed['url'])) ?>" target="_blank" rel="noopener noreferrer">Feed</a>
                <span class="meta"><?= number_format((int) $feed['post_count']) ?> posts</span>
                <a href="./">&larr; Timeline</a>
              </div>
            </div>
          </section>
        <?php endif; ?>

        <?php if ($query !== ''): ?>
          <h2>Posts matching "<?= h($query) ?>"</h2>
          <?php if (count($posts) === 0 && $error === ''): ?><p class="empty">Nothing found.</p><?php endif; ?>
        <?php endif; ?>

        <?php if ($view === 'discover' && $feed === null && $query === ''): ?>
          <section class="discover" aria-label="Sources">
            <?php if (count($sources) === 0 && $error === ''): ?><p class="empty">No active sources yet.</p><?php endif; ?>
            <?php foreach ($sources as $s):
              $name = (string) ($s['title'] !== '' ? $s['title'] : $s['site']); ?>
              <a class="source" href="?feed=<?= (int) $s['id'] ?>">
                <?= avatar((string) $s['icon_url'], $name, (string) $s['site']) ?>
                <span>
                  <span class="name"><?= h($name) ?></span>
                  <span class="meta"><?= h(displayHost((string) ($s['home_url'] ?: $s['url']))) ?> &middot; <?= number_format((int) $s['post_count']) ?> posts &middot; last <?= h(timeAgo((int) $s['last_post_at'])) ?></span>
                  <?php if ($s['description'] !== ''): ?><span class="desc" style="display:block"><?= h(mb_strimwidth((string) $s['description'], 0, 160, '…')) ?></span><?php endif; ?>
                </span>
              </a>
            <?php endforeach; ?>
          </section>
        <?php else: ?>
          <?php if ($feed === null && $query === '' && count($posts) === 0 && $error === ''): ?>
            <p class="empty">No posts yet.</p>
          <?php endif; ?>
          <?php
          $shownPerSource = [];
          foreach ($posts as $post):
            $source = (int) $post['feed_id'];
            $shownPerSource[$source] = ($shownPerSource[$source] ?? 0) + 1;
            $name = (string) ($post['feed_title'] !== '' ? $post['feed_title'] : $post['site']);
            $postUrl = safeUrl((string) $post['url']);
            $image = safeUrl((string) $post['image_url']);
            ?>
            <article class="post">
              <a href="?feed=<?= $source ?>" aria-label="<?= h($name) ?>"><?= avatar((string) $post['icon_url'], $name, (string) $post['site']) ?></a>
              <div>
                <div class="byline">
                  <a class="who" href="?feed=<?= $source ?>"><?= h($name) ?></a>
                  <?php if ($post['author'] !== '' && $post['author'] !== $name): ?><span class="meta">by <?= h((string) $post['author']) ?></span><?php endif; ?>
                  <span class="meta">&middot; <time datetime="<?= gmdate('c', intdiv((int) $post['published_at'], 1000)) ?>"><?= h(timeAgo((int) $post['published_at'])) ?></time></span>
                </div>
                <?php if ($post['title'] !== ''): ?>
                  <h3><?php if ($postUrl !== ''): ?><a href="<?= h($postUrl) ?>" target="_blank" rel="noopener noreferrer"><?= h((string) $post['title']) ?></a><?php else: ?><?= h((string) $post['title']) ?><?php endif; ?></h3>
                <?php endif; ?>
                <?php if ($post['summary'] !== '' && $post['summary'] !== $post['title']): ?>
                  <p class="summary"><?= h((string) $post['summary']) ?></p>
                <?php endif; ?>
                <?php if ($image !== ''): ?>
                  <div class="media"><img src="<?= h($image) ?>" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentElement.remove()" /></div>
                <?php endif; ?>
                <div class="actions">
                  <?php if ($postUrl !== ''): ?>
                    <a href="<?= h($postUrl) ?>" target="_blank" rel="noopener noreferrer">Open &#8599;</a>
                    <a href="../archive/view.php?url=<?= urlencode($postUrl) ?>">Archived copy</a>
                  <?php endif; ?>
                </div>
                <?php if (isset($hiddenBySource[$source]) && $shownPerSource[$source] === MAX_PER_SOURCE): ?>
                  <div class="more-from"><a href="?feed=<?= $source ?>">More from <?= h($name) ?> &rarr;</a></div>
                <?php endif; ?>
              </div>
            </article>
          <?php endforeach; ?>
        <?php endif; ?>

        <?php if ($nextLink !== '' || $prevLink !== ''): ?>
          <nav class="pager" aria-label="More posts">
            <span><?php if ($prevLink !== ''): ?><a class="button" href="<?= h($prevLink) ?>">&larr; Newer</a><?php elseif ($before !== null): ?><a class="button" href="./">&larr; Latest</a><?php endif; ?></span>
            <span><?php if ($nextLink !== ''): ?><a class="button" href="<?= h($nextLink) ?>">Older &rarr;</a><?php endif; ?></span>
          </nav>
        <?php endif; ?>
      </main>

      <aside>
        <div class="box">
          <h2>Recently active</h2>
          <?php if (count($activeSources) === 0): ?><p class="empty" style="margin:0">Nothing yet.</p><?php endif; ?>
          <?php foreach ($activeSources as $s):
            $name = (string) ($s['title'] !== '' ? $s['title'] : $s['site']); ?>
            <a class="source" href="?feed=<?= (int) $s['id'] ?>">
              <?= avatar((string) $s['icon_url'], $name, (string) $s['site']) ?>
              <span>
                <span class="name" style="display:block"><?= h($name) ?></span>
                <span class="meta"><?= h(timeAgo((int) $s['last_post_at'])) ?></span>
              </span>
            </a>
          <?php endforeach; ?>
          <p style="margin:0.6rem 0 0;font-size:0.85rem"><a href="?view=discover" style="color:inherit">All sources &rarr;</a></p>
        </div>
        <div class="box reader">
          <h2>Feed reader</h2>
          <div><span class="dot<?= $readerLive ? ' live' : '' ?>"></span><?= $readerLive ? 'Running' : ($stats['heartbeat'] > 0 ? 'Stopped' : 'Not started') ?></div>
          <div><?= number_format($stats['active']) ?> active sources</div>
          <div>About <?= number_format($stats['posts']) ?> posts collected</div>
        </div>
      </aside>
    </div>
  </div>
</body>

</html>
