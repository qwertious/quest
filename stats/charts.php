<?php

declare(strict_types=1);

/**
 * Inline-SVG chart primitives for the QUEST stats dashboard.
 *
 * No libraries and no CDN: the dashboard has to work on a small box with no
 * outbound access, so every chart is SVG generated server-side. Each mark
 * carries a <title>, which browsers render as a native tooltip -- tooltips
 * enhance here, they never gate, because every value is also printed in the
 * legend or the table view beneath the chart.
 *
 * Palette: the categorical slots are fixed and assigned in order, never
 * cycled. Both the light and dark sets were run through the data-viz
 * validator against the surfaces below (all checks pass; light mode carries a
 * sub-3:1 contrast warning on three slots, which is why visible labels and
 * table views are mandatory rather than optional here).
 */

/** Categorical slots 1-6, in fixed order. */
function vizSeries(bool $dark): array
{
  return $dark
    ? ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300']
    : ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'];
}

function vizInk(bool $dark): array
{
  return $dark
    ? [
      'surface' => '#1a1a19',
      'primary' => '#ffffff',
      'secondary' => '#c3c2b7',
      'muted' => '#898781',
      'grid' => '#2c2c2a',
      'axis' => '#383835',
      'border' => 'rgba(255,255,255,0.10)',
    ]
    : [
      'surface' => '#fcfcfb',
      'primary' => '#0b0b0b',
      'secondary' => '#52514e',
      'muted' => '#898781',
      'grid' => '#e1e0d9',
      'axis' => '#c3c2b7',
      'border' => 'rgba(11,11,11,0.10)',
    ];
}

function vizEsc(string $v): string
{
  return htmlspecialchars($v, ENT_QUOTES, 'UTF-8');
}

function vizNum($n): string
{
  return number_format((float) $n);
}

function vizBytes($bytes): string
{
  $bytes = (float) $bytes;
  $units = ['B', 'KB', 'MB', 'GB', 'TB'];
  $i = 0;
  while ($bytes >= 1024 && $i < count($units) - 1) {
    $bytes /= 1024;
    $i++;
  }
  return round($bytes, $i === 0 ? 0 : 1) . ' ' . $units[$i];
}

function vizPct(float $part, float $whole): string
{
  return $whole > 0 ? number_format($part / $whole * 100, 1) . '%' : '0%';
}

/**
 * Donut for part-to-whole. Capped at 6 segments by the caller; a 2-segment
 * split should be a progress bar instead, not a donut.
 *
 * Segments: [['label'=>..., 'value'=>...], ...]
 */
function vizDonut(array $segments, bool $dark, int $size = 190): string
{
  $ink = vizInk($dark);
  $colors = vizSeries($dark);
  $total = 0.0;
  foreach ($segments as $s) {
    $total += (float) $s['value'];
  }
  if ($total <= 0) {
    return '<p class="viz-empty">No data yet.</p>';
  }

  $cx = $size / 2;
  $cy = $size / 2;
  $r = $size / 2 - 10;
  $inner = $r * 0.60;
  $angle = -M_PI / 2;   // start at 12 o'clock
  $gap = 0.018;         // ~2px surface gap between fills

  $paths = '';
  $i = 0;
  foreach ($segments as $s) {
    $value = (float) $s['value'];
    if ($value <= 0) {
      $i++;
      continue;
    }
    $sweep = $value / $total * 2 * M_PI;
    $a0 = $angle + ($sweep > $gap * 2 ? $gap / 2 : 0);
    $a1 = $angle + $sweep - ($sweep > $gap * 2 ? $gap / 2 : 0);
    $angle += $sweep;

    $large = ($a1 - $a0) > M_PI ? 1 : 0;
    $x0 = $cx + $r * cos($a0);
    $y0 = $cy + $r * sin($a0);
    $x1 = $cx + $r * cos($a1);
    $y1 = $cy + $r * sin($a1);
    $ix1 = $cx + $inner * cos($a1);
    $iy1 = $cy + $inner * sin($a1);
    $ix0 = $cx + $inner * cos($a0);
    $iy0 = $cy + $inner * sin($a0);

    $d = sprintf(
      'M %.2f %.2f A %.2f %.2f 0 %d 1 %.2f %.2f L %.2f %.2f A %.2f %.2f 0 %d 0 %.2f %.2f Z',
      $x0, $y0, $r, $r, $large, $x1, $y1, $ix1, $iy1, $inner, $inner, $large, $ix0, $iy0
    );
    $color = $colors[$i % count($colors)];
    $label = vizEsc((string) $s['label']) . ': ' . vizNum($value) . ' (' . vizPct($value, $total) . ')';
    $paths .= '<path d="' . $d . '" fill="' . $color . '"><title>' . $label . '</title></path>';
    $i++;
  }

  return '<svg class="viz-donut" viewBox="0 0 ' . $size . ' ' . $size . '" role="img" '
    . 'aria-label="' . vizEsc(count($segments) . '-segment breakdown') . '">' . $paths . '</svg>';
}

/**
 * Legend + value list. Always rendered beside a donut: it is what makes the
 * chart readable without relying on colour alone, and it doubles as the table
 * view for small breakdowns.
 */
function vizLegend(array $segments, bool $dark): string
{
  $colors = vizSeries($dark);
  $total = 0.0;
  foreach ($segments as $s) {
    $total += (float) $s['value'];
  }

  $out = '<ul class="viz-legend">';
  $i = 0;
  foreach ($segments as $s) {
    $color = $colors[$i % count($colors)];
    $out .= '<li>'
      . '<span class="viz-swatch" style="background:' . $color . '"></span>'
      . '<span class="viz-legend-label">' . vizEsc((string) $s['label']) . '</span>'
      . '<span class="viz-legend-value">' . vizNum($s['value'])
      . ' <span class="viz-legend-pct">' . vizPct((float) $s['value'], $total) . '</span></span>'
      . '</li>';
    $i++;
  }
  return $out . '</ul>';
}

/**
 * Horizontal bars for ranked magnitude. One colour for every bar: the length
 * already encodes the value, so tinting by rank would double-encode it.
 */
function vizBars(array $rows, bool $dark, array $opts = []): string
{
  $ink = vizInk($dark);
  $colors = vizSeries($dark);
  $color = $opts['color'] ?? $colors[0];
  $labelWidth = (int) ($opts['labelWidth'] ?? 150);
  $barH = 16;
  $gap = 10;
  $width = 560;

  $max = 0.0;
  foreach ($rows as $r) {
    $max = max($max, (float) $r['value']);
  }
  if ($max <= 0 || count($rows) === 0) {
    return '<p class="viz-empty">No data yet.</p>';
  }

  $plotW = $width - $labelWidth - 90;
  $height = count($rows) * ($barH + $gap);
  $svg = '<svg class="viz-bars" viewBox="0 0 ' . $width . ' ' . $height . '" role="img" aria-label="Ranked bar chart">';

  $y = 0;
  foreach ($rows as $r) {
    $value = (float) $r['value'];
    $w = $max > 0 ? max(2.0, $value / $max * $plotW) : 0;
    $label = (string) $r['label'];
    $short = mb_strlen($label) > 26 ? mb_substr($label, 0, 25) . '…' : $label;

    $svg .= '<text x="' . ($labelWidth - 8) . '" y="' . ($y + $barH - 3)
      . '" text-anchor="end" class="viz-tick" fill="' . $ink['secondary'] . '">' . vizEsc($short) . '</text>';
    $svg .= '<rect x="' . $labelWidth . '" y="' . $y . '" width="' . round($w, 2) . '" height="' . $barH
      . '" rx="4" fill="' . $color . '"><title>' . vizEsc($label) . ': ' . vizNum($value)
      . (isset($r['note']) ? ' — ' . vizEsc((string) $r['note']) : '') . '</title></rect>';
    $svg .= '<text x="' . ($labelWidth + $w + 8) . '" y="' . ($y + $barH - 3)
      . '" class="viz-tick" fill="' . $ink['secondary'] . '">' . vizNum($value) . '</text>';
    $y += $barH + $gap;
  }

  return $svg . '</svg>';
}

/**
 * Column histogram for ordered bins (page-size distribution). Ordered
 * categories, one colour -- the ordering lives on the x-axis, not in hue.
 */
function vizHistogram(array $bins, bool $dark): string
{
  $ink = vizInk($dark);
  $colors = vizSeries($dark);
  $width = 560;
  $plotH = 150;
  $axisBand = 26;
  $height = $plotH + $axisBand;

  $max = 0.0;
  foreach ($bins as $b) {
    $max = max($max, (float) $b['value']);
  }
  if ($max <= 0) {
    return '<p class="viz-empty">No data yet.</p>';
  }

  $n = count($bins);
  $slot = $width / $n;
  $barW = $slot - 8;   // leaves the 2px+ surface gap between neighbours

  $svg = '<svg class="viz-hist" viewBox="0 0 ' . $width . ' ' . $height . '" role="img" aria-label="Distribution histogram">';
  // Recessive hairline baseline, solid (never dashed).
  $svg .= '<line x1="0" y1="' . $plotH . '" x2="' . $width . '" y2="' . $plotH
    . '" stroke="' . $ink['axis'] . '" stroke-width="1"/>';

  $i = 0;
  foreach ($bins as $b) {
    $value = (float) $b['value'];
    $h = $max > 0 ? ($value / $max) * ($plotH - 18) : 0;
    $x = $i * $slot + 4;
    $y = $plotH - $h;
    if ($value > 0) {
      $svg .= '<rect x="' . round($x, 2) . '" y="' . round($y, 2) . '" width="' . round($barW, 2)
        . '" height="' . round($h, 2) . '" rx="4" fill="' . $colors[0] . '">'
        . '<title>' . vizEsc((string) $b['label']) . ': ' . vizNum($value) . '</title></rect>';
      $svg .= '<text x="' . round($x + $barW / 2, 2) . '" y="' . round($y - 5, 2)
        . '" text-anchor="middle" class="viz-tick" fill="' . $ink['secondary'] . '">' . vizNum($value) . '</text>';
    }
    $svg .= '<text x="' . round($x + $barW / 2, 2) . '" y="' . ($plotH + 16)
      . '" text-anchor="middle" class="viz-tick" fill="' . $ink['muted'] . '">'
      . vizEsc((string) $b['label']) . '</text>';
    $i++;
  }

  return $svg . '</svg>';
}

/**
 * Multi-series line chart on ONE axis. Every series here must share a unit --
 * a second y-scale would invent a correlation that is not in the data.
 *
 * $series: [['label'=>..., 'points'=>[[x,y],...]], ...]
 */
function vizLines(array $series, bool $dark, array $opts = []): string
{
  $ink = vizInk($dark);
  $colors = vizSeries($dark);
  $width = 560;
  $plotH = 170;
  $axisBand = 24;
  $padL = 54;
  $height = $plotH + $axisBand;

  $minX = INF;
  $maxX = -INF;
  $maxY = 0.0;
  foreach ($series as $s) {
    foreach ($s['points'] as [$x, $y]) {
      $minX = min($minX, $x);
      $maxX = max($maxX, $x);
      $maxY = max($maxY, (float) $y);
    }
  }
  if (!is_finite($minX) || $maxX <= $minX || $maxY <= 0) {
    return '<p class="viz-empty">Not enough history yet — this fills in as snapshots accumulate.</p>';
  }

  $plotW = $width - $padL - 12;
  $sx = static fn($x) => $padL + ($x - $minX) / ($maxX - $minX) * $plotW;
  $sy = static fn($y) => $plotH - ($y / $maxY) * ($plotH - 14);

  $svg = '<svg class="viz-lines" viewBox="0 0 ' . $width . ' ' . $height . '" role="img" aria-label="Growth over time">';

  // Horizontal gridlines: solid hairlines, one shade off the surface.
  for ($g = 0; $g <= 3; $g++) {
    $val = $maxY * $g / 3;
    $y = $sy($val);
    $svg .= '<line x1="' . $padL . '" y1="' . round($y, 2) . '" x2="' . $width . '" y2="' . round($y, 2)
      . '" stroke="' . $ink['grid'] . '" stroke-width="1"/>';
    $svg .= '<text x="' . ($padL - 8) . '" y="' . round($y + 4, 2) . '" text-anchor="end" class="viz-tick" fill="'
      . $ink['muted'] . '">' . vizCompact($val) . '</text>';
  }

  $i = 0;
  foreach ($series as $s) {
    $color = $colors[$i % count($colors)];
    $d = '';
    foreach ($s['points'] as $k => [$x, $y]) {
      $d .= ($k === 0 ? 'M ' : ' L ') . round($sx($x), 2) . ' ' . round($sy((float) $y), 2);
    }
    $svg .= '<path d="' . $d . '" fill="none" stroke="' . $color . '" stroke-width="2" '
      . 'stroke-linejoin="round" stroke-linecap="round"/>';

    // Direct-label the endpoint only; the axis and tooltips carry the rest.
    $last = end($s['points']);
    if ($last) {
      $lx = $sx($last[0]);
      $ly = $sy((float) $last[1]);
      $svg .= '<circle cx="' . round($lx, 2) . '" cy="' . round($ly, 2) . '" r="4" fill="' . $color
        . '" stroke="' . $ink['surface'] . '" stroke-width="2"><title>'
        . vizEsc((string) $s['label']) . ': ' . vizNum($last[1]) . '</title></circle>';
    }
    $i++;
  }

  // x-axis endpoints only, to avoid a wall of dates.
  $svg .= '<text x="' . $padL . '" y="' . ($plotH + 16) . '" class="viz-tick" fill="' . $ink['muted'] . '">'
    . vizEsc(gmdate('M j', (int) ($minX / 1000))) . '</text>';
  $svg .= '<text x="' . $width . '" y="' . ($plotH + 16) . '" text-anchor="end" class="viz-tick" fill="'
    . $ink['muted'] . '">' . vizEsc(gmdate('M j', (int) ($maxX / 1000))) . '</text>';

  return $svg . '</svg>';
}

function vizCompact($n): string
{
  $n = (float) $n;
  if ($n >= 1e9) return round($n / 1e9, 1) . 'B';
  if ($n >= 1e6) return round($n / 1e6, 1) . 'M';
  if ($n >= 1e3) return round($n / 1e3, 1) . 'k';
  return (string) round($n);
}

/**
 * Progress bar. This is the right form for a two-part split -- a 2-slice
 * donut is never the answer.
 */
function vizProgress(float $done, float $total, bool $dark, string $doneLabel, string $restLabel): string
{
  $ink = vizInk($dark);
  $colors = vizSeries($dark);
  $pct = $total > 0 ? $done / $total : 0;
  $w = max(0.0, min(1.0, $pct)) * 100;

  return '<div class="viz-progress-wrap">'
    . '<div class="viz-progress" role="img" aria-label="' . vizEsc($doneLabel . ' ' . vizPct($done, $total)) . '">'
    . '<div class="viz-progress-fill" style="width:' . round($w, 2) . '%;background:' . $colors[0] . '"></div>'
    . '</div>'
    . '<div class="viz-progress-legend">'
    . '<span><span class="viz-swatch" style="background:' . $colors[0] . '"></span>'
    . vizEsc($doneLabel) . ' <strong>' . vizNum($done) . '</strong> (' . vizPct($done, $total) . ')</span>'
    . '<span class="viz-muted">' . vizEsc($restLabel) . ' <strong>' . vizNum($total - $done) . '</strong></span>'
    . '</div></div>';
}

/** Table view twin for a breakdown -- the WCAG-clean equivalent of a chart. */
function vizTable(array $rows, string $keyHeader, string $valueHeader): string
{
  $total = 0.0;
  foreach ($rows as $r) {
    $total += (float) $r['value'];
  }
  $out = '<table class="viz-table"><thead><tr><th>' . vizEsc($keyHeader) . '</th><th>'
    . vizEsc($valueHeader) . '</th><th>share</th></tr></thead><tbody>';
  foreach ($rows as $r) {
    $out .= '<tr><td>' . vizEsc((string) $r['label']) . '</td><td>' . vizNum($r['value'])
      . '</td><td>' . vizPct((float) $r['value'], $total) . '</td></tr>';
  }
  return $out . '</tbody></table>';
}
