<?php

declare(strict_types=1);

require_once __DIR__ . '/lib.php';
require_once dirname(__DIR__) . '/xio.php';

/**
 * Shows the page text QUEST actually stored for one URL -- the archived
 * snapshot, not the live site. raw_pages.content is cleaned body text with
 * all whitespace (including newlines) collapsed by quest.js before it is
 * saved, so it has no real paragraph structure; splitIntoParagraphs() below
 * is a display-only grouping, not a recovery of the original formatting.
 */

$dbPath = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'quest.sqlite';
$url = isset($_GET['url']) ? trim((string) $_GET['url']) : '';

$performanceLog = [];

$database = openQuestDatabase($dbPath);
$dbConnection = $database['connection'];
$dbKind = (string) $database['kind'];
$dbAvailable = $dbConnection !== null;

$status = [];
if ($dbAvailable) {
  try {
    $status = fetchQuestStatusFromDb($dbConnection, $dbKind, (string) $database['detail']);
  } catch (Throwable $e) {
    // Status is secondary here; the archived-page lookup below is what matters.
  }
}

$archivedPage = null;
$lookupError = '';

if ($url === '') {
  $lookupError = 'No URL specified.';
} elseif (!$dbAvailable) {
  $lookupError = 'The archive database is not reachable right now: ' . (string) $database['detail'];
} else {
  try {
    $row = fetchRawPageFromDb($dbConnection, $dbKind, $url);
    if ($row !== null) {
      $content = decodeArchivedContent((string) $row['content'], (string) ($row['content_encoding'] ?? 'utf8'));
      $archivedPage = [
        'title' => (string) ($row['title'] ?? 'Untitled'),
        'timestamp' => (int) ($row['timestamp'] ?? 0),
        'paragraphs' => splitIntoParagraphs($content),
      ];
    }
  } catch (Throwable $e) {
    $lookupError = 'Lookup failed: ' . $e->getMessage();
  }
}

closeQuestDatabase($database);

?>
<!doctype html>
<html lang="en">

<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title><?= $archivedPage ? h($archivedPage['title']) . ' | xArchive' : 'xArchive' ?></title>
  <meta name="theme-color" content="#000000" />
  <link rel="icon" href="/xio/logo.png" type="image/png" />
  <link rel="stylesheet" href="../xio.css" />
  <style>
    :root {
      --maxw: 52rem;
    }

    .page-title {
      margin: 0 0 0.5rem;
      font-size: clamp(1.15rem, 2vw, 1.5rem);
    }

    .meta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.3rem 1rem;
      align-items: baseline;
      color: var(--dim);
      font-size: 0.78rem;
      margin-bottom: 0.3rem;
    }

    .meta-row a {
      color: var(--dim);
    }

    .meta-row a:hover {
      color: var(--fg);
    }

    .url-display {
      word-break: break-all;
      font-size: 0.75rem;
      color: var(--faint);
      margin-bottom: 1rem;
      padding-bottom: 0.9rem;
      border-bottom: 1px solid var(--rule);
    }

    .archive-note {
      font-size: 0.72rem;
      color: var(--faint);
      margin: -0.4rem 0 1.4rem;
    }

    .archived-content p {
      font-family: var(--read);
      font-size: 1rem;
      line-height: 1.7;
      color: #d6d6d6;
      margin: 0 0 1rem;
    }

    .archived-content p.empty {
      font-family: var(--mono);
    }

    .archived-content p:last-child {
      margin-bottom: 0;
    }
  </style>
</head>

<body>
  <?= xioTopbar('archive') ?>

  <div class="container">
    <section class="hero">
      <h1><a href="index.php">xArchive</a></h1>
      <p class="sub">Stored page text, served from the archive.</p>
      <div class="actions">
        <a class="btn" href="index.php">&larr; Archive search</a>
        <?php if (!empty($status)): ?>
          <button type="button" class="btn" id="status-open">Status</button>
        <?php endif; ?>
      </div>
    </section>

    <section class="section">
      <?php if ($archivedPage !== null): ?>
        <h2 class="page-title"><?= h($archivedPage['title']) ?></h2>
        <div class="meta-row">
          <span>Archived: <?= h(formatTimestamp($archivedPage['timestamp'])) ?></span>
          <a href="<?= h($url) ?>" target="_blank" rel="noopener noreferrer">View live page &#8599;</a>
        </div>
        <div class="url-display"><?= h($url) ?></div>
        <p class="archive-note">Stored text only -- layout, images, and scripts from the original page are not preserved.</p>
        <div class="archived-content">
          <?php if (count($archivedPage['paragraphs']) === 0): ?>
            <p class="empty">No text content was captured for this page.</p>
          <?php else: ?>
            <?php foreach ($archivedPage['paragraphs'] as $paragraph): ?>
              <p><?= h($paragraph) ?></p>
            <?php endforeach; ?>
          <?php endif; ?>
        </div>
      <?php else: ?>
        <h2>Not Archived</h2>
        <p class="empty">
          <?= $lookupError !== '' ? h($lookupError) : 'QUEST does not have a stored copy of this page yet.' ?>
        </p>
        <?php if ($url !== ''): ?>
          <p><a href="<?= h($url) ?>" target="_blank" rel="noopener noreferrer">Try the live page instead &#8599;</a></p>
        <?php endif; ?>
      <?php endif; ?>
    </section>
  </div>

  <?php if (!empty($status)): ?>
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
  <?php endif; ?>
</body>

</html>
