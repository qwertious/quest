<?php

declare(strict_types=1);

/**
 * The XIO top bar every QUEST site shares. Styles live in xio.css; pages
 * link it as "../xio.css". $current is the key of the site being shown.
 */
function xioTopbar(string $current): string
{
  $sites = [
    'search' => ['../search/', 'xSearch'],
    'archive' => ['../archive/', 'xArchive'],
    'images' => ['../images/', 'xImages'],
    'xwire' => ['../xwire/', 'xWire'],
    'exyra' => ['../exyra/', 'EXYRA'],
    'stats' => ['../stats/', 'QSTATS'],
  ];
  $links = '';
  foreach ($sites as $key => [$href, $label]) {
    $links .= '<a href="' . $href . '"' . ($key === $current ? ' aria-current="page"' : '') . '>' . $label . '</a>';
  }
  return '<header class="topbar">'
    . '<a class="brand" href="/xio/" aria-label="XIO projects">' . xioMark('mark') . '<span>XIO</span></a>'
    . '<nav class="topnav" aria-label="QUEST sites">' . $links . '</nav>'
    . '</header>';
}

/** The XIO logo mark: a circle crossed by three lines. */
function xioMark(string $class): string
{
  return '<svg class="' . $class . '" viewBox="0 0 100 100" aria-hidden="true">'
    . '<circle cx="50" cy="50" r="38" />'
    . '<line x1="50" y1="12" x2="50" y2="88" />'
    . '<line x1="23.1" y1="23.1" x2="76.9" y2="76.9" />'
    . '<line x1="76.9" y1="23.1" x2="23.1" y2="76.9" />'
    . '</svg>';
}
