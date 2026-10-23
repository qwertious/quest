#!/usr/bin/env python3
"""Export QUEST's archived pages as a ZIM pack for xVine.

    python3 xvine_export.py [--flavour full|sample] [--max-pages N] [--out xvine]

Writes <out>/quest_web_<flavour>_<date>.zim (with a Xapian full-text index,
so xVine searches it in place, phones included), a sidecar .json, and
<out>/catalog.json listing every pack in the folder. xVine's catalog reads
that JSON (default https://qwertious.org/quest/xvine/catalog.json).

Pages are rendered as clean reader views from raw_pages (the extracted text),
never the original HTML: an offline copy must not pull scripts, trackers or
images from the live web.

Built for a busy, small server:
  - the database is opened read-only, in short chunked transactions, so the
    crawler keeps writing and the WAL keeps checkpointing;
  - de-duplication and the per-site listings live in a temporary SQLite file,
    not in RAM;
  - run it under `nice -n 19 ionice -c3` (see README).

Needs python-libzim:  python3 -m venv ~/xvine-export-venv && ~/xvine-export-venv/bin/pip install libzim
"""
import argparse
import datetime
import glob
import gzip
import hashlib
import html
import json
import os
import re
import sqlite3
import struct
import sys
import tempfile
import time
import uuid
import zlib
from urllib.parse import urlsplit

from libzim.writer import Creator, Hint, IndexData, Item, StringProvider

HERE = os.path.dirname(os.path.abspath(__file__))
NAME = 'quest_web'
CHUNK = 2000
SITE_LIST_LIMIT = 1000  # pages listed on each site's index page
TOP_SITES = 400  # sites listed on the main page

CSS = """
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1b1b;--dim:#666;--rule:#ddd;--link:#1a4fd6}
@media (prefers-color-scheme:dark){:root{--bg:#101114;--fg:#e8e8e8;--dim:#9a9a9a;--rule:#2a2a2a;--link:#8ab4ff}}
html{background:var(--bg)}body{margin:0 auto;max-width:46rem;padding:1.5rem 1.1rem 4rem;color:var(--fg);
font:17px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--link)}h1{font-size:1.7rem;line-height:1.25;margin:.2rem 0 .6rem}
.src{font:13px/1.5 ui-monospace,Consolas,monospace;color:var(--dim);border-bottom:1px solid var(--rule);
padding-bottom:.8rem;margin-bottom:1.2rem;word-break:break-all}.src a{color:var(--dim)}
.sum{color:var(--dim);font-style:italic}p{margin:0 0 1rem}pre{white-space:pre-wrap;font-size:.9em}
footer{margin-top:2.5rem;border-top:1px solid var(--rule);padding-top:.8rem;font-size:13px;color:var(--dim)}
ul.list{padding-left:1.1rem}ul.list li{margin:.15rem 0}.n{color:var(--dim);font-size:.85em}
.content h1{font-size:1.6rem}.content h2{font-size:1.3rem;margin:1.6rem 0 .5rem}.content h3{font-size:1.1rem;margin:1.3rem 0 .4rem}
.content h4,.content h5,.content h6{font-size:1rem;margin:1.1rem 0 .3rem}
.content ul,.content ol{padding-left:1.4rem}.content li{margin:.2rem 0}
.content table{border-collapse:collapse;margin:1rem 0;display:block;overflow-x:auto;max-width:100%;font-size:.92em}
.content th,.content td{border:1px solid var(--rule);padding:.3rem .55rem;text-align:left;vertical-align:top}
.content th{background:color-mix(in srgb,var(--rule) 45%,transparent)}
.content pre{background:color-mix(in srgb,var(--rule) 40%,transparent);padding:.7rem .9rem;overflow-x:auto;border-radius:3px}
.content code{font-family:ui-monospace,Consolas,monospace;font-size:.9em}
.content blockquote{margin:1rem 0;padding:.2rem 1rem;border-left:3px solid var(--rule);color:var(--dim)}
.content hr{border:0;border-top:1px solid var(--rule);margin:1.5rem 0}
.content .img{color:var(--dim);font-size:.85em;font-style:italic}
.content details{margin:.6rem 0}.content summary{cursor:pointer}
.content{overflow-wrap:anywhere}.content pre,.content table{max-width:100%}
"""


# --------------------------------------------------------------------- pages

def page_path(url):
    """Stable archive path for a URL: host + path (+ query), scheme dropped."""
    p = urlsplit(url)
    host = (p.hostname or '').lower()
    if not host:
        return None
    path = p.path.rstrip('/')
    if p.query:
        path += '?' + p.query
    full = host + path
    return full if len(full.encode('utf-8')) < 900 else None


def rel_root(path):
    return '../' * path.count('/')


def decode_text(content):
    if content is None:
        return ''
    if isinstance(content, (bytes, bytearray)):
        b = bytes(content)
        if b[:2] == b'\x1f\x8b':
            b = gzip.decompress(b)
        return b.decode('utf-8', 'replace')
    return str(content)


def paragraphs(text):
    """QUEST's extractor keeps block structure: blank lines split paragraphs."""
    out = []
    for block in re.split(r'\n\s*\n', text.strip()):
        block = block.strip()
        if not block:
            continue
        if '\n' in block and sum(1 for ln in block.split('\n') if ln.startswith(('  ', '\t'))) > 1:
            out.append('<pre>' + html.escape(block) + '</pre>')
        else:
            out.append('<p>' + html.escape(block).replace('\n', '<br>') + '</p>')
    return '\n'.join(out)


def _norm(s):
    return re.sub(r'\W+', ' ', s).strip().lower()


def lead_block(text):
    """First block that reads like prose rather than a menu: long, with
    sentences. Used as the page description (search snippets) when QUEST has
    no better summary."""
    for block in text.split('\n'):
        b = block.strip()
        if len(b) >= 120 and b.count(' ') >= 15 and re.search(r'[a-z0-9][.!?]["”’)]?(\s|$)', b):
            return b[:400]
    return ''


def render_page(path, url, title, text, summary, ts):
    root = rel_root(path)
    # QUEST's stored summary is often just the opening of the text; only a
    # genuinely different one (e.g. a meta description) is worth showing.
    if summary and _norm(text).startswith(_norm(summary)[:80]):
        summary = ''
    description = summary or lead_block(text)
    host = path.split('/', 1)[0]
    when = datetime.datetime.utcfromtimestamp(ts / 1000).strftime('%Y-%m-%d') if ts else 'unknown date'
    return (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>' + html.escape(title) + '</title>'
        + ('<meta name="description" content="' + html.escape(description, quote=True) + '">' if description else '') +
        '<link rel="stylesheet" href="' + root + '_quest/style.css"></head><body>'
        '<h1>' + html.escape(title) + '</h1>'
        '<div class="src"><a href="' + html.escape(url, quote=True) + '">' + html.escape(url) + '</a><br>'
        'Archived by QUEST on ' + when + ' &middot; <a href="' + root + '_sites/' + html.escape(host, quote=True) + '">'
        'more from ' + html.escape(host) + '</a></div>'
        + (('<p class="sum">' + html.escape(summary) + '</p>') if summary else '')
        + paragraphs(text) +
        '<footer>Text snapshot from QUEST, XIO\'s independent web index. Images, scripts and '
        'layout of the original page are not included.</footer></body></html>'
    )


# ------------------------------------------------------------ HTML mode
#
# --html: build pages from the stored original HTML, sanitised down to
# structure (headings, lists, tables, code, quotes, links). Nothing that runs
# or loads anything survives: no scripts, styles, frames, forms, media, or
# attributes beyond a few structural ones. Images become their alt text.

from html.parser import HTMLParser  # noqa: E402
from urllib.parse import quote, urljoin  # noqa: E402

KEEP = {
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'pre', 'code',
    'blockquote', 'a', 'em', 'strong', 'b', 'i', 'u', 's', 'sub', 'sup', 'br', 'hr',
    'figure', 'figcaption', 'abbr', 'cite', 'q', 'small', 'mark', 'del', 'ins',
    'kbd', 'samp', 'var', 'time', 'details', 'summary',
}
# Layout containers: dropped, their contents kept (block ones leave a break).
UNWRAP_BLOCK = {'div', 'section', 'article', 'main', 'center', 'address', 'hgroup', 'body', 'html'}
# Whole subtrees removed.
DROP = {
    'script', 'style', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
    'form', 'input', 'button', 'select', 'textarea', 'option', 'label', 'fieldset', 'svg', 'math',
    'canvas', 'video', 'audio', 'picture', 'source', 'track', 'map', 'template', 'dialog', 'head',
    'title', 'meta', 'link', 'base',
}
CHROME = {'nav', 'header', 'footer', 'aside'}  # site chrome around the content
BLOCKS = {'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'dl', 'table', 'pre', 'blockquote',
          'hr', 'figure', 'details'}
VOID = {'br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr', 'param'}
BOILERPLATE = re.compile(
    r'(^|[\s_-])(cookie|consent|gdpr|banner|newsletter|subscribe|share|sharing|social|breadcrumbs?|navbar|'
    r'nav-?menu|site-?menu|menu-?bar|sidebar|advert|ads?|promo|popup|modal|related|comments?|skip-?link)([\s_-]|$)', re.I)
SAFE_ID = re.compile(r'^[A-Za-z][\w.:-]{0,60}$')


class Sanitizer(HTMLParser):
    """One pass over a page's HTML, emitting only safe structure.

    `scope` limits output to the inside of the first <main> (or [role=main],
    else <article>) when the page has one; otherwise the whole body minus
    nav/header/footer/aside. `link(href)` maps a link to an archive-relative
    href, an external URL, or None (drop the link, keep its text)."""

    def __init__(self, scope, link):
        super().__init__(convert_charrefs=True)
        self.scope = scope  # 'main', 'role-main', 'article' or None
        self.link = link
        self.out = []
        self.open = []  # emitted tags still open
        self.skip = 0  # depth inside a dropped subtree
        self.skip_tag = []
        self.inside = 0 if scope else 1  # >0 while within the chosen scope
        self.scope_tag = None  # tag of the chosen element; nesting counted by name,
        self.scope_nest = 0  # which survives unclosed <p>/<li> in sloppy HTML
        self.scope_done = False

    def _drop_start(self, tag):
        self.skip += 1
        self.skip_tag.append(tag)

    def _close_until(self, tags, stop):
        """HTML's implied end tags: if one of `tags` is open (and no `stop`
        container lies between), close back to it."""
        for i in range(len(self.open) - 1, -1, -1):
            t = self.open[i]
            if t in stop:
                return
            if t in tags:
                while len(self.open) > i:
                    x = self.open.pop()
                    if x is not None:
                        self.out.append('</%s>' % x)
                return

    def _implied_closes(self, tag):
        if tag == 'li':
            self._close_until({'li'}, {'ul', 'ol'})
        elif tag in ('dt', 'dd'):
            self._close_until({'dt', 'dd'}, {'dl'})
        elif tag in ('td', 'th'):
            self._close_until({'td', 'th'}, {'tr', 'table'})
        elif tag == 'tr':
            self._close_until({'tr'}, {'table', 'thead', 'tbody', 'tfoot'})
        elif tag in ('thead', 'tbody', 'tfoot'):
            self._close_until({'thead', 'tbody', 'tfoot', 'tr'}, {'table'})
        if tag in BLOCKS:
            self._close_until({'p'}, {'li', 'td', 'th', 'blockquote', 'dd', 'figure', 'details', 'caption'})

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        void = tag in VOID
        if self.skip:
            if not void and tag == self.skip_tag[-1]:
                self.skip += 1
                self.skip_tag.append(tag)
            return
        if self.scope and not self.inside:
            hit = (self.scope == 'main' and tag == 'main') or \
                  (self.scope == 'role-main' and (a.get('role') or '').lower() == 'main') or \
                  (self.scope == 'article' and tag == 'article')
            if hit and not self.scope_done and not void:
                self.inside = 1
                self.scope_tag = tag
                self.scope_nest = 1
            return
        if not self.inside:
            return
        cls = ' '.join(filter(None, [a.get('class'), a.get('id'), a.get('role')]))
        if tag in DROP or (tag in CHROME and not self.scope) or (not void and cls and BOILERPLATE.search(cls)) \
                or a.get('hidden') is not None or (a.get('aria-hidden') or '').lower() == 'true':
            if not void:
                self._drop_start(tag)
            return
        if tag == self.scope_tag and not void:
            self.scope_nest += 1
        if tag == 'img':
            alt = (a.get('alt') or '').strip()
            if alt:
                self.out.append('<span class="img">[image: %s]</span>' % html.escape(alt))
            return
        if tag in UNWRAP_BLOCK or tag in CHROME:
            self._implied_closes('div')
            self.out.append('\n')
            return
        if tag not in KEEP:
            return  # unknown/inline wrappers (span, font…): drop the tag, keep the text
        self._implied_closes(tag)
        attr = ''
        if tag == 'a':
            href = self.link(a.get('href') or '')
            if not href:
                self.open.append(None)  # text kept, no link
                return
            attr = ' href="%s"' % html.escape(href, quote=True)
        elif tag in ('td', 'th'):
            for k in ('colspan', 'rowspan'):
                v = a.get(k)
                if v and v.isdigit() and int(v) < 100:
                    attr += ' %s="%s"' % (k, v)
        elif tag == 'ol' and (a.get('start') or '').isdigit():
            attr = ' start="%s"' % a['start']
        elif tag in ('abbr', 'time'):
            v = a.get('title') if tag == 'abbr' else a.get('datetime')
            if v:
                attr = ' %s="%s"' % ('title' if tag == 'abbr' else 'datetime', html.escape(v[:200], quote=True))
        if tag[0] == 'h' and len(tag) == 2 and SAFE_ID.match(a.get('id') or ''):
            attr += ' id="%s"' % a['id']
        self.out.append('<%s%s>' % (tag, attr))
        if not void:
            self.open.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if self.skip:
            if tag == self.skip_tag[-1]:
                self.skip -= 1
                self.skip_tag.pop()
            return
        if not self.inside:
            return
        if tag == self.scope_tag:
            self.scope_nest -= 1
            if self.scope_nest == 0:
                self.inside = 0  # left the chosen <main>/<article>: ignore the rest
                self.scope_done = True
                return
        if tag in UNWRAP_BLOCK or tag in CHROME:
            self.out.append('\n')
            return
        if tag in KEEP and tag in self.open or (tag == 'a' and None in self.open):
            # close everything opened since this tag (tolerates sloppy nesting)
            while self.open:
                t = self.open.pop()
                if t is not None:
                    self.out.append('</%s>' % t)
                if t == tag or (t is None and tag == 'a'):
                    break

    def handle_data(self, data):
        if self.skip or not self.inside:
            return
        self.out.append(html.escape(data, quote=False))

    def result(self):
        while self.open:
            t = self.open.pop()
            if t is not None:
                self.out.append('</%s>' % t)
        s = ''.join(self.out)
        # collapse whitespace everywhere except inside <pre>
        parts = re.split(r'(<pre>.*?</pre>)', s, flags=re.S)
        for k in range(0, len(parts), 2):
            parts[k] = re.sub(r'\s*\n\s*', '\n', re.sub(r'[ \t\r\f\v]+', ' ', parts[k]))
        s = ''.join(parts)
        # empty leftovers (<p> </p>, <li></li> from stripped widgets)
        for _ in range(3):
            s = re.sub(r'<(p|li|ul|ol|div|span|strong|em|b|i|h[1-6]|blockquote|figure|td|tr|table|dl|dd|dt)(\s[^>]*)?>\s*</\1>', '', s)
        return s.strip()


class KnownPaths:
    """`path in known`: is that page in the pack? Backed by the work DB."""

    def __init__(self, work):
        self.work = work
        self.cache = {}

    def __contains__(self, path):
        hit = self.cache.get(path)
        if hit is None:
            hit = self.work.execute('SELECT 1 FROM known WHERE path = ?', (path,)).fetchone() is not None
            if len(self.cache) > 200000:
                self.cache.clear()
            self.cache[path] = hit
        return hit


def choose_scope(doc):
    head = doc[:400000].lower()
    if '<main' in head:
        return 'main'
    if re.search(r'role\s*=\s*["\']?main', head):
        return 'role-main'
    if head.count('<article') == 1:
        return 'article'
    return None


def html_to_body(doc, page_url, page_path_, known):
    """Sanitised content HTML for a page, or '' if too little survives."""
    def link(href):
        href = href.strip()
        if not href or href.lower().startswith(('javascript:', 'data:', 'vbscript:', 'mailto:', 'tel:')):
            return None
        if href.startswith('#'):
            return href if SAFE_ID.match(href[1:]) else None
        target = urljoin(page_url, href)
        if not target.lower().startswith(('http://', 'https://')):
            return None
        frag = ''
        if '#' in target:
            target, f = target.split('#', 1)
            frag = '#' + f if SAFE_ID.match(f) else ''
        tp = page_path(target)
        if tp and tp in known:
            if tp == page_path_:
                return frag or None
            # archive-relative: from this page's folder to the target
            return rel_root(page_path_) + quote(tp, safe="/:@!$&'()*+,;=-._~") + frag
        return target + frag  # xVine holds external links behind "Open online"

    def run(scope):
        s = Sanitizer(scope, link)
        try:
            s.feed(doc)
            s.close()
        except Exception:
            return ''
        return s.result()

    scope = choose_scope(doc)
    body = run(scope)
    if scope and len(re.sub(r'<[^>]+>', '', body)) < 200:
        body = run(None)  # the <main>/<article> was a shell: use the whole body
    return body if len(re.sub(r'<[^>]+>', '', body)) >= 120 else ''


def render_html_page(path, url, title, body, description, ts):
    root = rel_root(path)
    host = path.split('/', 1)[0]
    when = datetime.datetime.utcfromtimestamp(ts / 1000).strftime('%Y-%m-%d') if ts else 'unknown date'
    has_h1 = re.search(r'<h1[\s>]', body[:4000]) is not None
    return (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>' + html.escape(title) + '</title>'
        + ('<meta name="description" content="' + html.escape(description, quote=True) + '">' if description else '') +
        '<link rel="stylesheet" href="' + root + '_quest/style.css"></head><body class="orig">'
        '<div class="src"><a href="' + html.escape(url, quote=True) + '">' + html.escape(url) + '</a><br>'
        'Archived by QUEST on ' + when + ' &middot; <a href="' + root + '_sites/' + html.escape(host, quote=True) + '">'
        'more from ' + html.escape(host) + '</a></div>'
        + ('' if has_h1 else '<h1>' + html.escape(title) + '</h1>')
        + '<div class="content">' + body + '</div>'
        '<footer>Snapshot from QUEST, XIO\'s independent web index: the page\'s own structure and links, '
        'without its images, scripts or styling.</footer></body></html>'
    )


class NoIndex(IndexData):
    """Listing pages are navigation, not content: keep them out of search."""

    def has_indexdata(self):
        return False

    def get_title(self):
        return ''

    def get_content(self):
        return ''

    def get_keywords(self):
        return ''

    def get_wordcount(self):
        return 0

    def get_geoposition(self):
        return None


class HtmlItem(Item):
    def __init__(self, path, title, body, front):
        super().__init__()
        self._p, self._t, self._b, self._f = path, title, body, front

    def get_path(self):
        return self._p

    def get_title(self):
        return self._t

    def get_mimetype(self):
        return 'text/html'

    def get_contentprovider(self):
        return StringProvider(self._b)

    def get_hints(self):
        return {Hint.FRONT_ARTICLE: self._f}


class ListingItem(HtmlItem):
    # Defining get_indexdata at all overrides libzim's HTML indexing, so only
    # listing pages do it (and decline). Content pages use the default.
    def get_indexdata(self):
        return NoIndex()


class CssItem(HtmlItem):
    def get_mimetype(self):
        return 'text/css'

    def get_hints(self):
        return {Hint.FRONT_ARTICLE: False}


# ---------------------------------------------------------------------- icon

def icon_png(size=48):
    """QUEST mark (a ring with a search tail), white on black, as PNG bytes."""
    ss = 4
    n = size * ss
    c, r_out, r_in = n * 0.43, n * 0.30, n * 0.20
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            hit = 0
            for sy in range(ss):
                for sx in range(ss):
                    px, py = x * ss + sx + 0.5, y * ss + sy + 0.5
                    d = ((px - c) ** 2 + (py - c) ** 2) ** 0.5
                    ring = r_in <= d <= r_out
                    # tail: thick line from the ring towards the bottom-right corner
                    t = ((px - c) + (py - c)) / 2
                    off = abs((px - c) - (py - c)) / 1.414
                    tail = r_out * 0.62 <= t <= n * 0.50 and off <= n * 0.055
                    hit += ring or tail
            v = int(242 * hit / (ss * ss))
            row += bytes([v, v, v])
        rows.append(bytes(row))
    raw = zlib.compress(b''.join(rows), 9)

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', raw) + chunk(b'IEND', b''))


# ------------------------------------------------------------------- catalog

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def write_catalog(out_dir, keep):
    """catalog.json = every pack's sidecar; prune old packs beyond `keep` per flavour."""
    metas = []
    for side in glob.glob(os.path.join(out_dir, NAME + '_*.zim.json')):
        try:
            m = json.load(open(side, encoding='utf-8'))
        except ValueError:
            continue
        if os.path.exists(os.path.join(out_dir, m['file'])):
            metas.append(m)
    by_flavour = {}
    for m in sorted(metas, key=lambda m: m['date'], reverse=True):
        by_flavour.setdefault(m['flavour'], []).append(m)
    entries = []
    for fl, ms in by_flavour.items():
        entries.append(ms[0])  # only the newest of each flavour is offered
        for old in ms[keep:]:
            for f in (old['file'], old['file'] + '.json'):
                try:
                    os.remove(os.path.join(out_dir, f))
                except OSError:
                    pass
    cat = {
        'format': 'xvine-catalog/1',
        'publisher': 'XIO',
        'title': 'QUEST web archive',
        'generated': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'entries': sorted(entries, key=lambda m: m['size']),
    }
    tmp = os.path.join(out_dir, 'catalog.json.part')
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(cat, f, indent=1)
    os.replace(tmp, os.path.join(out_dir, 'catalog.json'))
    with open(os.path.join(out_dir, 'icon.png'), 'wb') as f:
        f.write(icon_png(48))


# ---------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--db', default=os.path.join(HERE, 'data', 'quest.sqlite'))
    ap.add_argument('--out', default=os.path.join(HERE, 'xvine'))
    ap.add_argument('--flavour', default='full')
    ap.add_argument('--max-pages', type=int, default=0, help='stop after this many pages (0 = all)')
    ap.add_argument('--min-chars', type=int, default=280, help='skip pages with less text than this')
    ap.add_argument('--workers', type=int, default=1, help='libzim worker threads (keep low on a shared box)')
    ap.add_argument('--keep', type=int, default=2, help='packs kept per flavour (newest is offered)')
    ap.add_argument('--language', default='eng', help='stemming language for the full-text index')
    ap.add_argument('--immutable', action='store_true', help='open a copied database ignoring its WAL')
    ap.add_argument('--html', action='store_true',
                    help='build pages from the stored original HTML (sanitised) where QUEST has it, text elsewhere')
    a = ap.parse_args()

    os.makedirs(a.out, exist_ok=True)
    today = datetime.date.today().isoformat()
    fname = '%s_%s_%s.zim' % (NAME, a.flavour, today)
    final = os.path.join(a.out, fname)
    part = final + '.part'
    for stale in (part,):
        if os.path.exists(stale):
            os.remove(stale)

    mode = 'immutable=1' if a.immutable else 'mode=ro'
    db = sqlite3.connect('file:%s?%s' % (os.path.abspath(a.db).replace('\\', '/'), mode), uri=True, timeout=60)
    work_dir = tempfile.mkdtemp(prefix='xvine-export-')
    work = sqlite3.connect(os.path.join(work_dir, 'work.sqlite'))
    work.executescript('''
        PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
        CREATE TABLE seen (path TEXT PRIMARY KEY) WITHOUT ROWID;
        CREATE TABLE pages (host TEXT, title TEXT, path TEXT);
        CREATE TABLE known (path TEXT PRIMARY KEY) WITHOUT ROWID;
    ''')

    t0 = time.time()
    count = 0
    html_pages = 0
    skipped = 0
    last_rowid = 0
    known = KnownPaths(work)
    if a.html:
        # Pass 1: which pages will be in the pack, so links between them can
        # stay inside it. Cheap: no page bodies are read (length() only).
        print('html mode: listing archived pages...', flush=True)
        after = 0
        while True:
            rows = db.execute('SELECT rowid, url, length(content) FROM raw_pages WHERE rowid > ? ORDER BY rowid LIMIT ?',
                              (after, CHUNK * 5)).fetchall()
            if not rows:
                break
            for rowid, url, n in rows:
                after = rowid
                p = page_path(url or '') if (n or 0) >= 100 else None
                if p:
                    work.execute('INSERT OR IGNORE INTO known VALUES (?)', (p,))
            work.commit()
            if a.max_pages and work.execute('SELECT COUNT(*) FROM known').fetchone()[0] >= a.max_pages * 1.2:
                break
        print('  %d linkable pages' % work.execute('SELECT COUNT(*) FROM known').fetchone()[0], flush=True)
    print('exporting %s -> %s' % (a.db, final), flush=True)
    with Creator(part).config_indexing(True, a.language).config_clustersize(2 * 1024 * 1024) \
            .config_nbworkers(max(1, a.workers)) as zc:
        zc.set_mainpath('index')
        zc.add_item(CssItem('_quest/style.css', 'style', CSS, False))
        done = False
        while not done:
            rows = db.execute(
                'SELECT r.rowid, r.url, r.title, r.content, r.timestamp, s.summary, '
                + ('h.html, h.html_encoding ' if a.html else 'NULL, NULL ') +
                'FROM raw_pages r LEFT JOIN search_index s ON s.url = r.url '
                + ('LEFT JOIN raw_html h ON h.url = r.url ' if a.html else '') +
                'WHERE r.rowid > ? ORDER BY r.rowid LIMIT ?', (last_rowid, CHUNK)).fetchall()
            if not rows:
                break
            for rowid, url, title, content, ts, summary, raw_html, raw_enc in rows:
                last_rowid = rowid
                path = page_path(url or '')
                if not path:
                    skipped += 1
                    continue
                try:
                    text = decode_text(content)
                except Exception:
                    skipped += 1
                    continue
                if len(text) < a.min_chars:
                    skipped += 1
                    continue
                if work.execute('INSERT OR IGNORE INTO seen VALUES (?)', (path,)).rowcount == 0:
                    skipped += 1  # same page under another scheme / trailing slash
                    continue
                title = (title or '').strip() or path
                page = None
                if raw_html is not None:
                    try:
                        doc = gzip.decompress(raw_html).decode('utf-8', 'replace') if raw_enc == 'gzip' else decode_text(raw_html)
                        body = html_to_body(doc, url, path, known)
                    except Exception:
                        body = ''
                    if body:
                        summ = (summary or '').strip()
                        if summ and _norm(text).startswith(_norm(summ)[:80]):
                            summ = ''
                        page = render_html_page(path, url, title, body, summ or lead_block(text), ts)
                        html_pages += 1
                if page is None:
                    page = render_page(path, url, title, text, (summary or '').strip(), ts)
                zc.add_item(HtmlItem(path, title, page, True))
                work.execute('INSERT INTO pages VALUES (?, ?, ?)', (path.split('/', 1)[0], title, path))
                count += 1
                if a.max_pages and count >= a.max_pages:
                    done = True
                    break
            work.commit()
            el = time.time() - t0
            print('  %d pages (%d skipped%s) in %.0fs, %.0f/s, rowid %d' % (
                count, skipped, ', %d from HTML' % html_pages if a.html else '', el, count / max(el, 1), last_rowid), flush=True)

        # Per-site listings and the main page.
        print('building site pages...', flush=True)
        work.execute('CREATE INDEX pages_host ON pages(host)')
        sites = work.execute('SELECT host, COUNT(*) n FROM pages GROUP BY host ORDER BY n DESC').fetchall()
        for host, n in sites:
            items = work.execute('SELECT title, path FROM pages WHERE host = ? ORDER BY title LIMIT ?', (host, SITE_LIST_LIMIT)).fetchall()
            spath = '_sites/' + host
            root = rel_root(spath)
            body = ''.join('<li><a href="%s%s">%s</a></li>' % (root, html.escape(quote(p, safe="/:@!$&'()*+,;=-._~"), quote=True), html.escape(t))
                           for t, p in items)
            more = '<p class="n">Showing %d of %d pages. Search xVine to find the rest.</p>' % (len(items), n) if n > len(items) else ''
            zc.add_item(ListingItem(spath, host, (
                '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
                '<title>' + html.escape(host) + '</title><link rel="stylesheet" href="' + root + '_quest/style.css">'
                '<h1>' + html.escape(host) + '</h1><p class="n">' + str(n) + ' archived pages</p>' + more +
                '<ul class="list">' + body + '</ul>'), False))
        top = ''.join('<li><a href="_sites/%s">%s</a> <span class="n">%d</span></li>' % (html.escape(h, quote=True), html.escape(h), n)
                      for h, n in sites[:TOP_SITES])
        zc.add_item(ListingItem('index', 'QUEST web archive', (
            '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>QUEST web archive</title><link rel="stylesheet" href="_quest/style.css">'
            '<h1>QUEST web archive</h1><p>Text snapshots of %s pages from %s sites, collected by QUEST, '
            'XIO\'s independent crawler, as of %s. Use xVine\'s search to find anything in here.</p>'
            '<h2>Most-archived sites</h2><ul class="list">%s</ul>' % (format(count, ','), format(len(sites), ','), today, top)), False))

        zc.add_metadata('Name', NAME)
        zc.add_metadata('Title', 'QUEST web archive' + ('' if a.flavour == 'full' else ' (%s)' % a.flavour))
        zc.add_metadata('Description', 'Text snapshots of web pages collected by QUEST, XIO\'s crawler')
        zc.add_metadata('Language', a.language)
        zc.add_metadata('Creator', 'QUEST')
        zc.add_metadata('Publisher', 'XIO')
        zc.add_metadata('Date', today)
        zc.add_metadata('Flavour', a.flavour)
        zc.add_metadata('Tags', '_category:quest;_pictures:no;_videos:no;_ftindex:yes')
        zc.add_illustration(48, icon_png(48))
        print('finalising (compressing clusters and writing the index)...', flush=True)

    os.replace(part, final)
    # libzim's index scratch files (left behind on some platforms).
    for left in glob.glob(part + '_*'):
        try:
            if os.path.isdir(left):
                for f in os.listdir(left):
                    os.remove(os.path.join(left, f))
                os.rmdir(left)
            else:
                os.remove(left)
        except OSError:
            pass
    size = os.path.getsize(final)
    meta = {
        'id': str(uuid.uuid5(uuid.NAMESPACE_URL, 'xvine:' + fname)),
        'name': NAME,
        'flavour': a.flavour,
        'title': 'QUEST web archive' + ('' if a.flavour == 'full' else ' (%s)' % a.flavour),
        'summary': 'Text snapshots of %s pages from %s sites, crawled by QUEST.' % (format(count, ','), format(len(sites), ',')),
        'language': a.language,
        'category': 'quest',
        'articleCount': count,
        'siteCount': len(sites),
        'size': size,
        'date': today,
        'file': fname,
        'sha256': sha256_file(final),
    }
    with open(final + '.json', 'w', encoding='utf-8') as f:
        json.dump(meta, f, indent=1)
    write_catalog(a.out, a.keep)
    work.close()
    try:
        os.remove(os.path.join(work_dir, 'work.sqlite'))
        os.rmdir(work_dir)
    except OSError:
        pass
    print('done: %s, %d pages, %.1f MB, %.0f min' % (final, count, size / 1048576, (time.time() - t0) / 60), flush=True)


if __name__ == '__main__':
    sys.exit(main())
