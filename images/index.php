<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/sitelib.php';

/**
 * xImages: search the images found on pages QUEST has crawled.
 *
 * Images are found by the words their pages use for them -- alt text,
 * captions, the page title for a page's lead image (image_store.js). Results
 * show the original image from its own site; QUEST doesn't keep copies.
 */

$query = isset($_GET['q']) ? trim((string) $_GET['q']) : '';
$page = isset($_GET['page']) ? max(1, min(50, (int) $_GET['page'])) : 1;
$perPage = 60;


$database = openQuestDatabase(questDataPath('images.sqlite'));
$results = [];
$hasMore = false;
$error = '';
$totalImages = 0;

if ($database['connection'] !== null) {
  try {
    // MAX(id) rather than COUNT(*): exact enough for a footer, and free.
    $totalImages = (int) (qOne($database, 'SELECT MAX(id) AS n FROM images')['n'] ?? 0);
    $match = ftsMatchExpression($query);
    if ($match !== '') {
      // One row per (image, page); keep each image's best-ranked page.
      $rows = qAll(
        $database,
        // Rank inside the FTS index, then join only the rows shown.
        'SELECT i.id, i.url, i.width, i.height, r.page_url, r.page_title, r.alt, r.caption
           FROM (SELECT rowid, bm25(image_fts, 4.0, 3.0, 1.0) AS rank FROM image_fts
                  WHERE image_fts MATCH ? ORDER BY rank LIMIT ? OFFSET ?) f
           JOIN image_refs r ON r.id = f.rowid
           JOIN images i ON i.id = r.image_id
          ORDER BY f.rank',
        [$match, $perPage * 2 + 1, ($page - 1) * $perPage * 2],
      );
      // One tile per picture: the same image id, or the same words on the
      // same page (one picture at several sizes or CDN addresses).
      $seen = [];
      foreach ($rows as $row) {
        $sameShot = $row['page_url'] . "\n" . $row['alt'] . "\n" . $row['caption'];
        if (isset($seen['id' . $row['id']]) || isset($seen[$sameShot]) || safeUrl((string) $row['url']) === '') {
          continue;
        }
        $seen['id' . $row['id']] = true;
        $seen[$sameShot] = true;
        $results[] = $row;
      }
      $hasMore = count($rows) > $perPage * 2 || count($results) > $perPage;
      $results = array_slice($results, 0, $perPage);
    } elseif ($query === '') {
      $results = qAll(
        $database,
        "SELECT i.id, i.url, i.width, i.height, r.page_url, r.page_title, r.alt, r.caption
           FROM image_refs r JOIN images i ON i.id = r.image_id
          WHERE r.alt != '' OR r.caption != ''
          ORDER BY r.id DESC LIMIT 40",
      );
    }
  } catch (Throwable $e) {
    $error = 'The image index could not be searched right now.';
  }
} else {
  $error = 'The image index has not been built yet.';
}
closeQuestDatabase($database);
$results = array_values(array_filter($results, static fn(array $r): bool => safeUrl((string) $r['url']) !== ''));

$pageLink = static fn(int $p): string => '?' . http_build_query(['q' => $query, 'page' => $p]);
?>
<!doctype html>
<html lang="en">

<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="referrer" content="no-referrer" />
  <title>xImages | QUEST Image Search</title>
  <meta name="theme-color" content="#000000" />
  <link rel="icon" href="/xio/logo.png" type="image/png" />
  <link rel="stylesheet" href="../xio.css" />
  <style>
    <?= sharedSiteCss() ?>

    .image-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 0.6rem; }
    .tile { margin: 0; border: 1px solid var(--rule); overflow: hidden; background: var(--panel); transition: border-color 140ms; display: flex; flex-direction: column; }
    .tile button { all: unset; cursor: zoom-in; display: block; aspect-ratio: 1; background: var(--tint); }
    .tile button:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
    .tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .tile figcaption { padding: 0.45rem 0.55rem; font-size: 0.74rem; line-height: 1.35; color: #c9c9c9; }
    .tile .words { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .tile .from { color: var(--faint); font-size: 0.68rem; margin-top: 0.2rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tile:hover { border-color: var(--rule-hi); }
    .tile.broken { display: none; }

    dialog { border: 1px solid var(--rule-hi); padding: 0; max-width: min(960px, 94vw); width: 100%; background: var(--bg); color: var(--fg); }
    dialog::backdrop { background: rgba(0, 0, 0, 0.8); }
    .viewer { display: grid; grid-template-columns: minmax(0, 3fr) minmax(220px, 2fr); }
    .viewer .picture { background: var(--panel); display: flex; align-items: center; justify-content: center; min-height: 260px; }
    .viewer .picture img { max-width: 100%; max-height: 75vh; display: block; }
    .viewer .info { padding: 1rem; display: flex; flex-direction: column; gap: 0.6rem; overflow-wrap: anywhere; }
    .viewer .info h2 { margin: 0; font-size: 1rem; }
    .viewer .info p { margin: 0; }
    .viewer .links { display: flex; flex-direction: column; gap: 0.4rem; margin-top: auto; }
    .viewer .links a { color: var(--dim); font-size: 0.8rem; }
    .viewer .links a:hover { color: var(--fg); }
    @media (max-width: 680px) {
      .image-grid { grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); }
      .viewer { grid-template-columns: 1fr; }
    }
  </style>
</head>

<body>
  <?= xioTopbar('images') ?>

  <div class="container">
    <section class="hero">
      <h1>xImages</h1>
      <p class="sub">Images from the pages QUEST has crawled, found by the words those pages use for them.</p>
      <form method="get" action="" class="searchbox" role="search">
        <input type="search" name="q" value="<?= h($query) ?>" placeholder="Search images, e.g. sunflowers" aria-label="Search images" />
        <button type="submit">Search</button>
      </form>
    </section>

    <main class="ui">
      <?php if ($error !== ''): ?>
        <p class="notice"><?= h($error) ?></p>
      <?php elseif ($query !== '' && count($results) === 0): ?>
        <p class="empty">No images found for "<?= h($query) ?>".</p>
      <?php else: ?>
        <h2><?= $query === '' ? 'Recently found' : 'Images for "' . h($query) . '"' ?></h2>
        <div class="image-grid">
          <?php foreach ($results as $i => $row):
            $words = trim((string) ($row['alt'] !== '' ? $row['alt'] : $row['caption']));
            if ($words === '') {
              $words = (string) $row['page_title'];
            }
            ?>
            <figure class="tile">
              <button type="button" data-index="<?= (int) $i ?>" aria-label="View: <?= h($words) ?>">
                <img src="<?= h((string) $row['url']) ?>" alt="<?= h($words) ?>" loading="lazy" decoding="async"
                  referrerpolicy="no-referrer" onerror="this.closest('.tile').classList.add('broken')" />
              </button>
              <figcaption>
                <div class="words"><?= h($words) ?></div>
                <div class="from"><?= h(displayHost((string) $row['page_url'])) ?></div>
              </figcaption>
            </figure>
          <?php endforeach; ?>
        </div>
        <?php if ($query !== '' && ($page > 1 || $hasMore)): ?>
          <nav class="pager" aria-label="Result pages">
            <span><?php if ($page > 1): ?><a class="button" href="<?= h($pageLink($page - 1)) ?>">&larr; Previous</a><?php endif; ?></span>
            <span><?php if ($hasMore): ?><a class="button" href="<?= h($pageLink($page + 1)) ?>">Next &rarr;</a><?php endif; ?></span>
          </nav>
        <?php endif; ?>
      <?php endif; ?>
      <p class="footer-stats">About <?= number_format($totalImages) ?> images indexed. Images load from their original sites.</p>
    </main>
  </div>

  <dialog id="viewer" class="ui" aria-label="Image details">
    <div class="viewer">
      <div class="picture"><img id="viewer-img" alt="" referrerpolicy="no-referrer" /></div>
      <div class="info">
        <h2 id="viewer-words"></h2>
        <p id="viewer-caption" class="sub"></p>
        <p>From <a id="viewer-page" target="_blank" rel="noopener noreferrer"></a></p>
        <div class="links">
          <a id="viewer-archive">Archived copy of the page</a>
          <a id="viewer-open" target="_blank" rel="noopener noreferrer">Open image &#8599;</a>
          <button type="button" id="viewer-close">Close</button>
        </div>
      </div>
    </div>
  </dialog>

  <script>
    (() => {
      const results = <?= json_encode(array_map(static fn(array $r): array => [
        'url' => (string) $r['url'],
        'alt' => (string) $r['alt'],
        'caption' => (string) $r['caption'],
        'pageUrl' => safeUrl((string) $r['page_url']),
        'pageTitle' => (string) $r['page_title'],
      ], $results), JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_UNICODE) ?>;
      const dialog = document.getElementById('viewer');
      const $ = (id) => document.getElementById(id);
      document.querySelectorAll('.tile button').forEach((button) => {
        button.addEventListener('click', () => {
          const r = results[Number(button.dataset.index)];
          if (!r) return;
          $('viewer-img').src = r.url;
          $('viewer-img').alt = r.alt || r.caption || r.pageTitle;
          $('viewer-words').textContent = r.alt || r.caption || r.pageTitle || 'Untitled image';
          $('viewer-caption').textContent = r.alt && r.caption ? r.caption : '';
          $('viewer-page').textContent = r.pageTitle || r.pageUrl;
          $('viewer-page').href = r.pageUrl;
          $('viewer-archive').href = '../archive/view.php?url=' + encodeURIComponent(r.pageUrl);
          $('viewer-open').href = r.url;
          dialog.showModal();
        });
      });
      $('viewer-close').addEventListener('click', () => dialog.close());
      dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
    })();
  </script>
</body>

</html>
