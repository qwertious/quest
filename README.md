# QUEST

Qwertious Unified Extraction and Scanning Tool — a steady-rate web crawler that
builds two caches in a single SQLite database, plus the PHP search page that
reads them.

Four sites read what it collects:

| Site | Path | Reads |
|---|---|---|
| xSearch | `search/` | `data/quest.sqlite` (search index) |
| xArchive | `archive/` | `data/quest.sqlite` (stored pages) |
| xImages | `images/` | `data/images.sqlite` (see [Image search](#image-search-ximages)) |
| xWire | `xwire/` | `data/feeds.sqlite` (see [xWire](#xwire)) |

## What is stored

| Table | Holds |
|---|---|
| `raw_html` | **The original HTML exactly as fetched**, gzipped |
| `raw_pages` | Text extracted from that HTML, gzipped, tagged with the extractor version |
| `search_index` | URL, title, summary, keywords, timestamp |
| `search_fts` | FTS5 mirror of `search_index`, maintained by trigger |

`raw_html` is the source of truth; everything else is derived from it. Keeping
it is what makes an extraction change cost a local re-extract pass instead of
another full crawl.

Compression is transparent: `getRawPage(url)` and `getRawHtml(url)` return
plain text regardless of how they are stored on disk.

### Extraction

Text extraction preserves document structure: block elements become paragraph
breaks, inline elements are separated by a space, and `<pre>` blocks keep their
indentation verbatim.

This matters more than it sounds. The original implementation used cheerio's
`.text()`, which concatenates text nodes with *nothing* between them, so
`<a>Home</a><a>About</a>` came out as `HomeAbout`. Every element boundary
silently deleted a word break, and collapsing all whitespace destroyed every
line break in the document. Any archive built before extractor v2 has that
damage baked in and needs re-fetching -- see **Re-archiving** below.

`EXTRACTOR_VERSION` in [extract.js](extract.js) is stamped onto every page.
Bump it whenever extraction output changes, then run `--reextract`.

## Running it

```bash
export QUEST_CONTACT=https://example.org/crawler   # required: see below
node quest.js
```

**`QUEST_CONTACT` is required.** Every request QUEST makes names a contact, so a
site owner with a problem can reach whoever is crawling them:
`Quest/1.0 (+https://example.org/crawler; educational scraper)`. Set it to a
page about your crawler or an email address (`crawler@example.org` becomes
`+mailto:crawler@example.org`). There is no default, on purpose: you are
responsible for how your copy crawls, and nobody else's address should end up
on your traffic. `quest.js`, `feeds.js` and `run.sh` refuse to start without
it. Put the same contact in the "Questions or Concerns" section of
`index.html`, which ships with a placeholder.

That is the normal mode: run forever, fetch at a constant rate, stop only when
you tell it to. It is safe to leave running indefinitely — memory stays flat
because the crawl frontier lives in the database rather than in RAM.

```bash
node quest.js --once              # work through what is due, then exit
node quest.js --max-pages=500     # stop after 500 pages
node quest.js https://seed.url    # add seed URLs (repeatable)
node quest.js --rebuild-fts       # force a full FTS index rebuild
```

Seeds are only inserted if they are new. URLs already in the frontier keep
whatever schedule they had.

### Keeping it running

On the server, start it through the wrapper instead (in tmux):

```bash
./run.sh            # the crawler
./run.sh feeds.js   # the xWire feed reader, in its own tmux window
```

`run.sh` restarts the script 60s after any exit it didn't ask for -- a crash,
an out-of-memory kill, the crawler's own memory brake -- so one bad night
doesn't leave it stopped for days. Ctrl-C still stops it for good: a
deliberate stop exits with code 130, and that's the one exit the wrapper
respects. Press Ctrl-C during the 60s wait to cancel a restart.

### Rate

One knob controls the load:

```bash
QUEST_PAGES_PER_MINUTE=60 node quest.js
```

Pages are spaced evenly, so the default 60/min means one page per second,
regardless of how many workers are running or how slow individual sites are.
Raising `QUEST_CONCURRENCY` lets slow fetches overlap; it does **not** raise
the rate.

This is a global rate, not a per-site one. No individual site sees anything
like it: `QUEST_PER_HOST_DELAY_MS` keeps requests to one site at least 5s
apart, and `QUEST_DAILY_DOMAIN_BUDGET` caps each site at 50 pages per UTC day.

A *site* is the registrable domain, not the hostname (see `site.js`): every
Tumblr blog, Wikipedia language and Stack Exchange community shares one site
and one turn. Scheduling per hostname let thousands of `*.tumblr.com` blogs
each take their own turn on the same servers, until Tumblr blocked the
crawler's IP outright. robots.txt is still fetched and obeyed per hostname.

At 60/min, roughly:

| | |
|---|---|
| Pages | 86,400/day, ~2.6M/month |
| Inbound bandwidth | ~27–66 GB/month (10–25 KB/page on the wire, gzipped) |
| Disk growth, steady state | ~7–13 GB/month, depending on how many fetches are new pages vs. re-crawls |

Check those against your host's bandwidth and disk allowance before raising it
further.

## Configuration

All environment variables. Apart from `QUEST_CONTACT` (see **Running it**),
all optional.

| Variable | Default | Meaning |
|---|---|---|
| `QUEST_PAGES_PER_MINUTE` | `60` | Steady crawl rate (one page per second) |
| `QUEST_CONCURRENCY` | `4` | Fetches in flight at once |
| `QUEST_PER_HOST_DELAY_MS` | `5000` | Minimum gap between hits on one site (registrable domain) |
| `QUEST_DAILY_DOMAIN_BUDGET` | `50` | Pages per site per UTC day |
| `QUEST_REINDEX_AFTER_DAYS` | `30` | How long before a page is re-crawled |
| `QUEST_MAX_DEPTH` | `0` | Link depth limit (`0` = unlimited) |
| `QUEST_MAX_QUEUE_ROWS` | `2000000` | Stop accepting new discoveries past this |
| `QUEST_COMPRESS_CONTENT` | `true` | gzip archived page text |
| `QUEST_STORE_HTML` | `true` | Keep the original HTML. Turning this off means future extraction changes need a full re-crawl |
| `QUEST_MAX_STORED_HTML_BYTES` | `2097152` | Pages larger than this get text archived but no HTML (skipped, never truncated) |
| `QUEST_FOLLOW_EXTERNAL_LINKS` | `true` | Leave the seed hosts |
| `QUEST_MAX_ATTEMPTS` | `3` | Retries before a URL is marked failed |
| `QUEST_REQUEST_TIMEOUT_MS` | `12000` | Idle timeout -- fires if a connection goes fully silent |
| `QUEST_HARD_TIMEOUT_MS` | `24000` | Hard ceiling on total request time, active even if the server keeps trickling bytes |
| `QUEST_FORCE_IPV4` | `false` | Force outbound connections over IPv4 -- see **Diagnosing near-universal timeouts** below |
| `QUEST_ROBOTS_HARD_TIMEOUT_MS` | `10000` | Wall-clock cap on a robots.txt fetch, DNS and connect included |
| `QUEST_ROBOTS_UNREACHABLE_TTL_MS` | `3600000` | How long a host with an unreachable robots.txt is parked before retrying |
| `UV_THREADPOOL_SIZE` | `16` | Node's I/O threadpool, which DNS lookups run on. quest.js raises it from Node's default of 4 |
| `QUEST_MAX_LINKS_PER_PAGE` | `500` | Links taken from one page before the rest are ignored |
| `QUEST_MEMORY_PAUSE_MB` | `450` | Stop claiming new work above this RSS; resumes once it drops back down |
| `QUEST_MEMORY_STOP_MB` | `700` | Exit cleanly above this RSS rather than wait for the OS to kill the process |
| `QUEST_MEMORY_CHECK_EVERY_MS` | `5000` | How often the two thresholds above are checked |
| `QUEST_STATUS_EVERY_MS` | `60000` | Status line interval |
| `QUEST_CHECKPOINT_EVERY_MS` | `120000` | WAL checkpoint interval (non-blocking PASSIVE; a full TRUNCATE runs at exit) |
| `QUEST_REARCHIVE_RECOUNT_MS` | `900000` | How often the re-archive backlog is recounted from the database; in between it counts down in memory |
| `QUEST_SLOW_JOB_MS` | `1000` | Log a `slow:` line when a housekeeping job holds the process longer than this |
| `QUEST_DB_PATH` | `data/quest.sqlite` | Database location |

`blacklist.json` in this directory is re-read on every startup and synced into
the database, so edits take effect on the next run.

### Running on a small box

The defaults above assume a machine with memory to spare. On something like a
2GB server that is also running the website itself, tune all three memory- and
load-related knobs down together, and cap V8's own heap so it can't eat the
headroom you just cleared:

```bash
QUEST_CONCURRENCY=2 QUEST_PAGES_PER_MINUTE=30 \
QUEST_MEMORY_PAUSE_MB=250 QUEST_MEMORY_STOP_MB=450 \
node --max-old-space-size=400 quest.js
```

Note that storing HTML roughly triples the write volume per page (fetch, gzip,
insert), so if the box has slow or IOPS-limited disk, that is the thing most
likely to bite before memory does.

If the process keeps hitting `QUEST_MEMORY_STOP_MB` and exiting, that is the
circuit breaker doing its job, not a bug -- it means the box does not have
enough headroom for the current settings, and the fix is to lower
`QUEST_CONCURRENCY`/`QUEST_PAGES_PER_MINUTE` further or free up memory
elsewhere on the machine, not to raise the threshold and let it OOM instead.

### Diagnosing near-universal timeouts

If a run is failing almost every fetch **regardless of target host** --
unrelated domains, different companies, all failing the same way -- the
problem is on this machine's network, not a lot of websites happening to be
down at once. Don't guess at the cause; measure it:

```bash
node netcheck.js
```

A fetch passes through four layers -- DNS, TCP connect, TLS handshake, first
response byte -- and each breaking points somewhere different. `netcheck.js`
times each one separately, over IPv4 and IPv6 separately, against large
reference sites, a direct-IP connection that needs no DNS, and a sample of
hosts from the crawl queue's own failure list. It ends with a verdict:

| Verdict | Means | Next step |
|---|---|---|
| DNS lookups are slow / failing | Every request waits on the resolver first | Fix the nameservers in `/etc/resolv.conf` |
| Connections open, then TLS stalls | Small packets get through, large ones don't | MTU / path-MTU blackhole or a filtering middlebox: try `ip link set dev eth0 mtu 1400`, then ask the provider |
| Outbound connections are being dropped | TCP handshakes never complete | Local firewall, or provider-side filtering |
| IPv6 hangs, IPv4 works | Requests wait out a timeout on IPv6 first | `QUEST_FORCE_IPV4=true` |
| IPv6 is not routed here, but fails instantly | Harmless -- Node falls back to IPv4 by itself | Nothing |
| Connection-tracking table / OpenVZ limits | The kernel or container is refusing new sockets | Raise the limit or lower `QUEST_CONCURRENCY` |
| Machine healthy; the failing hosts are the problem | The queue is full of dead or crawler-hostile hosts | Nothing local -- consider `--prune-failed` |

It is read-only and makes a few dozen requests. `--quick` skips the queue
sample; `--hosts=a.com,b.org` probes specific hosts as well.

### What the crawler's own log tells you

Every status line is followed by a breakdown of where the last interval's
time went, and which layer failures came from:

```
  per attempt (41 this interval): robots.txt 7.9s, rate wait 12ms, fetch 3.1s, store 18ms
  claims: 44, avg 3.2ms, slowest 11ms
  event loop: longest stall 18ms, p99 12ms
  failures by layer this interval: stall 33, dns 4, refused 2
  3 site(s) parked for 60 min as refusing connections this interval
```

If an attempt averages far longer than the timeouts allow, the missing time is
visible here.

**`event loop: longest stall`** is the most important number. Database work
is synchronous: while a query runs, *nothing else in the process runs* -- no
network I/O, no timers, not even Ctrl-C. A multi-second stall makes healthy
fetches look like timeouts (the timer fires the moment the loop wakes up), and
if `netcheck.js` says the network is fine while the crawler says everything
times out, this is why. Healthy is tens of milliseconds. If it is in seconds,
look for a `slow: <job> took Nms` line naming the culprit, and a rising
`claims ... slowest` means the scheduler query itself is the problem.

The periodic counts and WAL checkpoint run on a background thread with their
own database connection (`background.js`), so they can be slow without
stalling anything; a `background: <job> took Nms` line is informational. If
the thread can't start, they run inline and a slow one is logged as `slow:`.

Ctrl-C once stops gracefully, finishing in-flight pages; press it again to
stop immediately. Either way nothing is lost -- claims left open are released
on the next start. Failure layers: `dns` (never resolved), `connect` (TCP handshake
never completed), `stall` (connected, then silence), `hard-timeout` (the
wall-clock cap fired), `refused`, `reset`, `tls`, `http5xx`, `http429`.

### robots.txt and unreachable hosts

robots.txt is handled per RFC 9309: a 4xx means the site has none, so crawl
freely; a 5xx, a 429 or a network error means *unreachable*, which requires
assuming everything is disallowed. So when a host's robots.txt can't be
reached, the crawler does not fetch its pages. It records one failed attempt
and caches the verdict for that hostname for an hour; the hostname's other
URLs wait it out with their retry budget intact.

If the failure looks like the *site* refusing the crawler -- connections reset
or stalled, timeouts, 429s, connects that never complete -- **the whole site is
parked for an hour**, so it isn't probed again through its next hostname, and
the next. A DNS, TLS or 5xx failure is about one hostname, so the rest of the
site carries on. Each robots.txt fetch is capped at
`QUEST_ROBOTS_HARD_TIMEOUT_MS` (10s) including DNS and connect.

## Maintenance

```bash
node maintain.js --status          # cache sizes, queue state, WAL size
node maintain.js --checkpoint      # fold the WAL back into the database
node maintain.js --compress        # gzip page text already stored as plain
node maintain.js --vacuum          # reclaim free pages (slow, needs disk space)
node maintain.js --rebuild-fts     # rebuild the search index from scratch
node maintain.js --prune-failed    # drop dead queue rows
node maintain.js --import-legacy   # load the old JSON/NDJSON dumps
node maintain.js --export-exyra [basePath]   # Exyra suspects, see below
node maintain.js --exyra-history   # Exyra signals from past failures and queued URLs
node maintain.js --scan-exyra      # Exyra signals from stored HTML
node maintain.js --exyra-status    # Exyra counts and strongest suspects
node maintain.js --reextract       # re-run extraction over stored HTML (no network)
node maintain.js --rearchive       # queue stale pages for an immediate refetch
node maintain.js --rearchive-status  # how far along a re-archive pass is
node maintain.js --index-media     # build the image index and feed list from stored HTML
node maintain.js --media-status    # image, feed and post counts
```

Everything except `--vacuum` is safe to run while the crawler is going.

## The dashboard

`stats/index.php` (QSTATS) shows what the corpus looks like: queue composition,
archive coverage, the biggest domains, page-size distribution, script mix, why
fetches fail, and growth over time.

**It never queries the database.** It reads `data/stats.json`, which `stats.js`
writes:

```bash
node stats.js
```

That separation is the whole design. The figures are `GROUP BY`s over millions
of rows — fine once a day, ruinous on every page load. Run it on a schedule:

```bash
# crontab -e  — 04:15 daily
15 4 * * * cd /path/to/quest && /usr/bin/node stats.js >> /var/log/quest-stats.log 2>&1
```

Or as a systemd timer, if the crawler is already a unit:

```ini
# /etc/systemd/system/quest-stats.service
[Unit]
Description=QUEST stats snapshot
[Service]
Type=oneshot
WorkingDirectory=/path/to/quest
ExecStart=/usr/bin/node stats.js
```

```ini
# /etc/systemd/system/quest-stats.timer
[Unit]
Description=Daily QUEST stats snapshot
[Timer]
OnCalendar=*-*-* 04:15:00
Persistent=true
[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now quest-stats.timer
```

Each run also appends to a `stats_history` table, which is where the growth
chart and the pages/day figure come from — so the time series only gets useful
after a few days of snapshots. The page says so rather than drawing a
misleading single-point line.

Safe to run while the crawler is going. It takes seconds on a small archive;
budget a minute or two once the queue is in the millions. Tuning:

| Variable | Default | Meaning |
|---|---|---|
| `QUEST_STATS_PATH` | `data/stats.json` | Where the snapshot is written |
| `QUEST_STATS_SAMPLE` | `3000` | Pages sampled for size/script figures |
| `QUEST_STATS_HISTORY` | `400` | Snapshots kept in the growth chart |

Page-size and script figures are **sampled**, not exact — measuring them
properly would mean decompressing the entire archive on every run. The
dashboard labels which numbers are sampled.

## Re-archiving

"Keep the queue and the search index, but re-fetch the HTML side."

A page counts as **current** when its text came from the current
`EXTRACTOR_VERSION` *and* its HTML was kept. Anything else is stale. The
crawler checks this on every claim, so a stale page is re-fetched even if it
was indexed recently — the 30-day freshness window does not apply to it.

```bash
node maintain.js --rearchive-status   # what needs doing
node maintain.js --reextract          # fix what can be fixed locally, first
node maintain.js --rearchive          # queue the rest for refetch
```

Always try `--reextract` first: any page whose HTML is already stored is fixed
locally in seconds, with no network traffic and no load on anyone's server.
`--rearchive` is only for pages that genuinely have to be fetched again.

`--rearchive` moves the *fetch schedule* and nothing else. The crawl queue, the
frontier, the search index, and the archived text all stay exactly as they are;
stale pages simply become due now instead of on their normal 30-day cycle.
Pages that are already current keep their existing schedule and are not touched.
It is safe to re-run — pages already queued are left alone.

Progress shows up in three places: the crawler's periodic status line, the
`re-archive:` line in `maintain.js --status`, and the full breakdown from
`--rearchive-status`.

### Disk cost

HTML is by far the biggest thing here. On an archive of ~700k pages, expect
roughly **3–5 GB** of stored (gzipped) HTML on top of the existing ~2 GB of
text — HTML is typically 3–5× the size of the text extracted from it, and
gzips about 5–6×. Check free space before starting a re-archive, and use
`QUEST_MAX_STORED_HTML_BYTES` to skip pathologically large pages.

If disk becomes a problem you can drop the HTML and keep everything else:

```sql
DELETE FROM raw_html;   -- then: node maintain.js --vacuum
```

The cost of doing that is that the next extraction change needs a full
re-crawl again.

### Exyra: suspects for scrutiny testing

Anything that behaves unlike an ordinary web page is recorded in
`data/exyra.sqlite` as an Exyra suspect, with the evidence, and shown on the
EXYRA site (`exyra/`). Being listed records suspicion for sandboxed scrutiny
testing; it is not a verdict.

**Listing never removes anything from QUEST.** Only a suspect rated 90% or
higher (`QUEST_EXYRA_WITHHOLD_PERCENT`) is withheld from the crawl -- not
queued, and blocked if it already was. Everything below that line is still
crawled, archived and searchable, including links the page hides from readers
and URLs shaped like traps. (A response over the size cap, or one that isn't
text at all, still fails on the first attempt: there is nothing to archive.)

**How the rating works.** Each category has a rough confidence for the case
where it is the only evidence; a suspect's rating combines them as
`1 - product(1 - p)`. It is deliberately modest -- a name, a word or a hidden
menu proves little -- so a single weak signal stays low, and 90% takes either
something conclusive on its own or several independent signals:

| Category | Alone | What put it there |
|---|---|---|
| `manual` | 95% | Added by hand (`--exyra-add`) |
| `decompression-bomb` | 90% | Inflated 100:1 or more (the size cap is hit after a few KB on the wire) |
| `known-tarpit-software` | 90% | Names Nepenthes or Iocaine in its generator tag or comments, or is a Cloudflare AI Labyrinth *decoy* page |
| `hidden-prompt-injection` | 45% | Text hidden from readers that addresses AI systems ("If you are an AI ...", "ignore previous instructions") -- some docs sites hide benign hints for AI agents this way |
| `hidden-text` | 40% | Hidden text stuffed with spam words (casino, pills, ...) |
| `robots-bait` | 40% | A path robots.txt forbids that is named like a trap -- a whole segment: `/trap/`, `/honeypot/`, `/tarpit/`, ... |
| `content-mismatch` | 40% | Labelled HTML (or a feed), but binary or NUL bytes |
| `tarpit` | 35% | Still dripping data at the hard timeout |
| `hidden-link-target` | 20% | Reached through a link hidden from readers |
| `spider-trap-url` | 20% | Repeating path segments, extreme depth or length, far-future calendar years |
| `redirect-loop` | 20% | Too many redirects |
| `link-flood` | 15% | Over the link cap, or 300+ links with under 1.5 words each |
| `oversized-response` | 15% | Over the size cap for its type |
| `robots-anomaly` | 15% | robots.txt that is HTML, binary or over 512 KB |
| `hidden-links-planted` | 10% | A page carrying hidden links that aren't also offered visibly |
| `prompt-injection` | 10% | *Visible* text addressed to AI readers ("AI agents must ignore ...") |
| `bot-wall`, `refuses-crawler`, `stall` | 5% | Challenge pages; resets and 429s toward the crawler; silence after connecting |
| `ai-blocking`, `ai-opt-out` | 2% | robots.txt names AI crawlers, or `Content-Signal: ai-train=no`; also noted on sites serving AI Labyrinth decoys |

The AI words alone never count: "AI companies should be regulated" and
"vector instructions for AI acceleration" are ordinary sentences. Text about
prompt injection (an article, a comment joking "ignore all previous
instructions") only counts when the page *hides* it from readers.

"Hidden" means the `hidden` attribute or an inline style (`display:none`,
`visibility:hidden`, zero size or opacity, far off-screen) on the link or
around it. Menus collapsed by CSS classes, `aria-hidden` icon links,
`<noscript>` and cookie dialogs are ordinary and don't count. Cloudflare AI
Labyrinth decoys (`/cdn-cgi/content?id=...`) are the trap; the page carrying
them is an ordinary page on a site that turned the feature on.

**Where the evidence comes from:**

- the crawler and feed reader, as they go (pages, robots.txt, failures)
- `node maintain.js --exyra-history` -- failure notes from every past run and
  the shape of every queued URL
- `node maintain.js --scan-exyra` -- page signals from the stored HTML
  (`--scan-exyra --index-media` does both jobs in one pass; add `--pause=3000`
  on a busy server)
- `node maintain.js --exyra-add URL --note "why"` -- by hand

**Keeping it honest:**

- `--exyra-recheck` re-judges stored evidence against the current rules (using
  the text each signal kept, so no page rescan) and withdraws what no longer
  qualifies -- run it after tightening a detector.
- `--exyra-drop CATEGORY [--source S]` withdraws a whole category.
- `--exyra-requeue` puts back any hidden-link or trap-shaped URL below the
  withhold line that the crawler skipped before it stopped skipping them.
- Ratings are recomputed automatically the first time a changed rating table
  is opened.

The crawler rewrites `exyra.json` (everything, with each suspect's signals)
and `exyra.txt` (`rating%<TAB>score<TAB>categories<TAB>url`, most suspicious
first) in the project root a minute after starting and then every
`QUEST_EXYRA_EXPORT_EVERY_MS` (3 hours). `node maintain.js --export-exyra
[base]` does it on demand (`--export-honeypots` is the old name), and
`--exyra-status` shows counts and the most suspicious suspects.

**Handle every listed URL as live**: probe with byte and time caps, or not
at all.

## Image search (xImages)

Every page the crawler saves also has its images indexed into
`data/images.sqlite`, by the words the page uses for them: `alt` text, the
`title` attribute, a `<figcaption>`, and -- for the page's declared lead
image (`og:image`) -- the page title.

What gets left out, on purpose:

- images with no meaningful words at all (`alt="image"`, no caption): there is
  nothing to find them by
- anything stated smaller than 100px, tracking pixels and spacers, SVGs
  (nearly always logos and interface), inline `data:` images
- more than 40 images from one page

Lazy-loaded images (`data-src`) and `srcset` resolve to the real, largest
file. The same picture on ten pages is one image found by all ten pages'
words, and each result links to the page it came from and to its archived
copy.

**QUEST doesn't store image files.** Results load from their original sites
(with no referrer). Storing thumbnails would be the obvious next step, but on
this server's disk it is the expensive part.

To fill the index from the HTML already archived (no network, resumable,
safe while the crawler runs):

```bash
node maintain.js --index-media
```

It reads every stored page once, so on a slow disk it takes hours (add
`--pause=3000` to rest 3s between batches and leave the disk to the website); Ctrl-C stops it after the current batch
and rerunning continues from there. Turn indexing during the crawl off with
`QUEST_INDEX_MEDIA=false`.

## xWire

A timeline of posts from every feed the crawler finds. Two halves:

1. **Discovery, in the crawler.** Each page's `<link rel="alternate">` feeds
   (RSS, Atom, RSS 1.0, JSON Feed) are recorded in `data/feeds.sqlite`, plus
   feed-shaped links (`/feed/`, `rss.xml`, ...) as candidates. Comment feeds
   are skipped. `--index-media` does the same over stored HTML.
2. **Fetching, in `feeds.js`** (`./run.sh feeds.js`). It works through the
   feeds as they come due:
   - a steady `FEEDS_PER_MINUTE` (20), and one request per site per
     `FEED_SITE_GAP_MS` (30s) -- sites as the crawler defines them
   - robots.txt obeyed, with the crawler's own rules (`robots.js`)
   - conditional requests: an unchanged feed costs a 304 and no body
   - each feed checked about as often as it posts -- half its typical gap
     between posts, between 30 minutes and a day
   - failures back off (1h, 2h, 4h ... a day) and a feed that fails 10 times
     in a row is dropped; a feed-shaped link that turns out to be an ordinary
     page is marked `invalid` after one look
   - up to 300 posts kept per feed

The site (`xwire/`) shows the latest posts with at most three per source per
page, so one busy news feed can't fill the timeline; a page per source;
search over titles, summaries and authors; and a "Discover" list of active
sources. Mastodon accounts, YouTube channels, podcasts, blogs and news sites
all arrive through the same formats.

| Setting | Default | |
|---|---|---|
| `FEEDS_PER_MINUTE` | `20` | Global fetch rate |
| `FEEDS_CONCURRENCY` | `3` | Fetches in flight |
| `FEED_SITE_GAP_MS` | `30000` | Minimum gap between requests to one site |
| `FEED_TIMEOUT_MS` / `FEED_HARD_TIMEOUT_MS` | `15000` / `30000` | Idle and wall-clock caps per fetch |
| `FEED_MAX_BYTES` | `3 MB` | Bigger feeds are skipped |

## xVine packs

`xvine_export.py` packs QUEST's archived pages into a ZIM file for
[xVine](../xvine/), XIO's offline Internet, which lists it in its catalog
under **QUEST web archive**. Each page becomes a clean reader view built from
`raw_pages`: the title, the original address, the date it was archived, and
the text. It never includes the original HTML, because an offline copy must
not pull scripts, trackers or images from the live web. Per-site listing
pages and a main page are added for browsing, and the pack carries a Xapian
full-text index, so xVine searches it in place on desktop and phones.

Running it on a server (from the QUEST folder):

```bash
python3 -m venv ~/xvine-export-venv && ~/xvine-export-venv/bin/pip install libzim   # once
cd /path/to/quest
tmux new -s xvine-export
nice -n 19 ionice -c3 ~/xvine-export-venv/bin/python xvine_export.py               # full pack
nice -n 19 ionice -c3 ~/xvine-export-venv/bin/python xvine_export.py --flavour sample --max-pages 20000
```

| Output | Contents |
|---|---|
| `xvine/quest_web_<flavour>_<date>.zim` | The pack, plus a `.json` sidecar with its size, page count and SHA-256 |
| `xvine/catalog.json` | Lists the newest pack of each flavour. xVine reads it from `https://plus.qwertious.org/quest/xvine/catalog.json` (override with xVine's `--quest-catalog` option) |
| `xvine/icon.png` | The catalog icon |

Older packs beyond `--keep` (default 2) per flavour are deleted.

The database is read with `mode=ro` in short chunked transactions, so the
crawler keeps writing and checkpointing. De-duplication (the same page under
`http`/`https`, or with a trailing slash) and the site lists use a temporary
SQLite file, not RAM. `--workers` (default 1) sets how many threads libzim
compresses and indexes with.

The packs are gigabytes, so `.stignore` on the Windows working copy keeps
`quest/xvine/*.zim` from syncing down. Only `catalog.json` and `icon.png`
travel.

Pages archived before extractor v2 (see **Re-archiving**) have their line
breaks fused, and read as one long paragraph. Re-archiving fixes them in the
next pack.

## How the frontier works

`crawl_queue` is a schedule, not a to-do list. Every known URL stays in it with
a `next_eligible_at` timestamp and a state:

- `pending` — waiting for its turn (this includes pages booked for a re-crawl)
- `active` — claimed by a worker right now
- `blocked` — excluded by robots.txt or the blacklist
- `failed` — gave up after `QUEST_MAX_ATTEMPTS`

A worker first picks a host -- the one that has been claimable (off cooldown,
with a URL due) the longest -- then that host's earliest-due URL, in one small
transaction. On success the row is rescheduled 30 days out; on failure it is
backed off (5 min, 30 min, 4 h). Nothing ever rewrites the whole queue.

Each host row carries `next_due_at`, the due time of its earliest pending URL,
kept exact by triggers on `crawl_queue`. That makes picking a host one index
seek no matter how many hosts are finished and booked weeks out; before it,
every claim walked past all of them (~0.4s per claim at 700k pages). The
`claims: ... avg` figure in the status block should stay well under 1ms.
Upgrading an existing database fills the column in once at startup.

If the process is killed, rows left `active` are returned to `pending` on the
next startup, so no work is lost.

## Requirements

Node 22 or newer. Uses `better-sqlite3` if it is installed, otherwise the
built-in `node:sqlite` module — no native build step required either way.

```bash
npm install
```

installs `axios` and `cheerio`, which are required.

**If this folder is synced between machines (Syncthing etc.)**, exclude two
things from the sync, in `.stignore`:

```
node_modules
data
```

`node_modules` holds compiled binaries for one OS (a Linux `better-sqlite3`
build is "not a valid Win32 application" on Windows), so run `npm install` on
each machine instead. `data` holds the live database: syncing a SQLite file
while it is being written produces corrupt copies. Back it up with
`node maintain.js --checkpoint` followed by a file copy, or `sqlite3
data/quest.sqlite ".backup backup.sqlite"`.

## Tests

```bash
npm test
```

Runs the crawler, maintenance commands and network diagnostic end to end
against throwaway databases in the OS temp directory and fake web servers on
loopback ports. It never touches `data/` and never reaches the internet, so it
is safe to run on the live server after deploying -- which is exactly when it
is worth running. Takes about a minute.

## License

Copyright (C) 2026 Qwertious

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. It is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.

In short: use it, change it and share it freely, commercially or not. If you
share it or a modified version, keep this credit, say what you changed, and
release your version under the GPL too, with its source code.
