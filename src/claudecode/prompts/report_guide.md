# Building the report

A YewReview report is **one self-contained HTML document that keeps working**. Someone opens it in
three years, on a phone, with no internet, and it reads exactly as it does today. Everything below
follows from that.

## The document

- `<!doctype html>`, a real `<title>` (it is the report's name in every list it appears in), and
  `<meta name="viewport" content="width=device-width, initial-scale=1">`. Without the viewport tag a
  phone renders the page at desktop width and the reader zooms.
- **One column, one reading measure.** `max-width: 70ch` with `width: 100%` and horizontal padding.
  Fluid, not fixed: it fills a phone and stops growing on a monitor.
- **The system font stack**, no web fonts. A font fetched from a CDN is a network reference, and one
  that fails to load moves every line of the document.
- **The page never scrolls sideways.** Anything naturally wider than the measure — a table, a wide
  figure, a long code block — scrolls inside its own container with `overflow-x: auto`.
- **No external references of any kind.** No CDN, no remote image, no `fetch`, no analytics, no
  embedded video. The one file the document loads is the chart library, which YewReview serves off
  this same machine at `/reports/assets/echarts.min.js`. An image you need is a `data:` URI.

## Light and dark

Style both. Declare the palette as custom properties on `:root` and override them inside
`@media (prefers-color-scheme: dark)`. Everything else in the stylesheet — and every colour you hand
to a chart — reads a variable, so the two themes are one set of rules rather than two stylesheets
that drift.

## Tables

Real `<table>` markup, wrapped in a `div` that scrolls. Right-align numbers, use tabular figures
(`font-variant-numeric: tabular-nums`) so digits line up between rows, and put units in the header
rather than in every cell. A per-cell results table is read down a column; that is what the
alignment is for.

A conditional mean carries the unconditional baseline for the same horizon beside it — a column or
the caption, but beside it. For a basket run the per-cell rows carry the cell's pooled numbers; a
member-attribution table is labelled attribution and carries no checklist column.

## Charts

Apache ECharts, loaded from the copy YewReview serves:

```html
<script src="/reports/assets/echarts.min.js"></script>
```

**Absolute, and that is not a style choice.** A published report is stored in the database and
served at `/reports/<id>`; it does not live in a directory, so there is nothing for `../assets/` to
be relative to and a relative href would resolve against whatever the URL happens to look like.
Never a CDN URL either. When the report has to be read somewhere this server is not — emailed,
archived, opened off a USB stick — publish it with `inline_assets`, which pastes the library into
the document itself and costs roughly a megabyte. Write the href exactly as above in either case:
publishing rewrites that one element, and it can only rewrite an element it recognises.

**Data is inlined, never fetched.** Put each figure's series in a `<script type="application/json">`
block and have the init code read it with `JSON.parse(el.textContent)`. The browser does not execute
that block, and it keeps arrays of numbers out of the middle of your code.

**Every chart resizes.** One `resize` listener per document calling `chart.resize()` on each
instance. A chart that renders at load width and never again is broken on the first rotation.

**Colour identifies a series. It never scores one.**

- No green for cells that cleared the checklist and red for those that did not. The checklist is not
  a verdict, and a chart that colours by outcome states one.
- **Never encode anything with opacity.** A dimmed series is not "the same series, less important" —
  it is a different colour, and two series that were meant to be distinguishable stop being so.
  Every line, bar and point is drawn at full opacity. If something needs de-emphasis, say so in the
  caption.
- Keep to a small ordered palette and reuse it in the same order in every figure of the report, so
  the third series is the same colour everywhere.
- Announce any transform — z-scored, rebased to 100, log axis — in the legend, the axis label, or
  the caption. A rebased series that does not say so is a lie about levels.

**Every figure carries a caption** naming what it is, its source, and its as-of date: "Daily close,
2019-01-02 – 2026-07-31. Source: Nasdaq daily bars, as of 2026-08-01." A figure without an as-of
date is undated evidence. A market-context figure built from `seikan describe` names it as its
source, dated to the data's last bar — not to today.

A chart always accompanies an explanation; it never replaces one.

## Attribution, in the document

A statement the report borrowed from somewhere gets two things: an `id` on the element that carries
it, and a footnote where it is used naming the source, the address it was read at, and the sentence
as that source wrote it — copied, never tightened. When the borrowed sentence sits inside a
paragraph that says other things too, wrap it in a `<span>` and put the id there: the mark has to
land on what the source actually said, not on the section it happens to appear in.

**The document is the only place this lives.** There is no citation argument to `publish_report` and
no citation table behind it — there was, and it was removed, because nothing ever fetched a cited
page or checked a quotation against one, so those rows looked like evidence and were not. What is
left is the footnote a reader can actually act on, which is what was doing the work all along. It
means the discipline is entirely yours: quote exactly, address precisely, and attribute in the
sentence's own neighbourhood.

A reader must be able to see, without leaving the document, which sentences are load-bearing and
where each one came from. A conclusion you reached yourself has no address and no sentence to quote,
so say in the document that it is your reading and what it rests on — nothing anywhere else will
mark it as yours.

## A complete minimal report

This is a working document. Pattern-match against it: the structure, the palette wiring, the inlined
data, the ECharts init, the resize and theme handlers.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NVDA — post-gap drift, 2019–2026</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --fg: #1a1a1a;
    --muted: #5c5c5c;
    --rule: #e2e2e2;
    --grid: #ececec;
    --s1: #2f6fbf;
    --s2: #b4632a;
    --s3: #4a8a5c;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a;
      --fg: #e8e8e8;
      --muted: #9aa0a8;
      --rule: #2a2e35;
      --grid: #22262c;
      --s1: #6fa8ec;
      --s2: #e08d54;
      --s3: #78b98c;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto;
    padding: 2rem 1.25rem 4rem;
    max-width: 70ch;
    width: 100%;
    background: var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 17px;
    line-height: 1.6;
  }
  h1 { font-size: 1.6rem; line-height: 1.25; margin: 0 0 .25rem; }
  h2 { font-size: 1.15rem; margin: 2.5rem 0 .75rem; }
  .dateline { color: var(--muted); font-size: .9rem; margin: 0 0 2rem; }
  figure { margin: 2rem 0; }
  .chart { width: 100%; height: 320px; }
  figcaption { color: var(--muted); font-size: .85rem; margin-top: .5rem; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; min-width: 34rem; font-size: .9rem; }
  th, td { padding: .45rem .6rem; border-bottom: 1px solid var(--rule); text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  td { font-variant-numeric: tabular-nums; }
  thead th { border-bottom: 2px solid var(--rule); font-weight: 600; }
  .notes { margin-top: 3rem; border-top: 1px solid var(--rule); padding-top: 1rem;
           font-size: .85rem; color: var(--muted); }
  .notes li { margin-bottom: .5rem; }
  sup a { text-decoration: none; }
</style>
</head>
<body>

<h1>NVDA — post-gap drift, 2019–2026</h1>
<p class="dateline">Recipe: daily equities · as of 2026-08-01</p>

<p>Four cells were declared and two cleared the checklist. Neither clearing cell supports acting on
the rule: in both, the median firing lost money while the mean was positive, which is a pool a few
large outcomes carried. The typical gap-down day was followed by nothing.</p>

<h2>What was measured</h2>

<p>Entry fires when the open is more than 3% below the prior close; the outcome is the 5- and 10-bar
forward return, long only, measured against the raw close. <span id="ref-feed-lag">Nasdaq publishes
these bars end of day and states no revision policy.</span><sup><a href="#c1">1</a></sup></p>

<figure>
  <div id="fig-drift" class="chart"></div>
  <figcaption>Cumulative return of NVDA and of the firing bars only, rebased to 100 at 2019-01-02.
  Source: Nasdaq daily bars, as of 2026-08-01.</figcaption>
</figure>

<script type="application/json" id="fig-drift-data">
{
  "dates": ["2019-01-02", "2019-01-03", "2019-01-04", "2019-01-07", "2019-01-08"],
  "series": [
    { "name": "NVDA", "values": [100, 96.1, 101.4, 103.8, 104.2] },
    { "name": "firing bars only", "values": [100, 96.1, 97.0, 97.4, 96.8] }
  ]
}
</script>

<h2>Every declared cell</h2>

<div class="scroll">
<table>
  <thead>
    <tr><th>cell</th><th>n</th><th>n_eff</th><th>mean_ret</th><th>p50</th><th>worst</th><th>checklist</th></tr>
  </thead>
  <tbody>
    <tr><td>gap 3%, h=5</td><td>61</td><td>19</td><td>+0.42%</td><td>−0.11%</td><td>−14.8%</td><td>cleared</td></tr>
    <tr><td>gap 3%, h=10</td><td>61</td><td>14</td><td>+0.55%</td><td>−0.30%</td><td>−22.1%</td><td>cleared</td></tr>
    <tr><td>gap 5%, h=5</td><td>22</td><td>9</td><td>+1.10%</td><td>+0.40%</td><td>−11.2%</td><td>support failed</td></tr>
    <tr><td>gap 5%, h=10</td><td>22</td><td>7</td><td>+0.90%</td><td>+0.15%</td><td>−18.6%</td><td>support failed</td></tr>
  </tbody>
</table>
</div>

<p>The 5% cells failed <code>support</code>, which is the correct answer: a 5% gap is rare and 22
firings is not enough to say anything. Widening the window to collect more would be searching, not
measuring.</p>

<ol class="notes">
  <li id="c1">Nasdaq data documentation, <code>nasdaq.com/solutions/data/historical</code>, read
  2026-08-01: &ldquo;End-of-day summary files are published after the close of the regular session.&rdquo;
  Not independently confirmed against a second feed.</li>
</ol>

<script src="/reports/assets/echarts.min.js"></script>
<script>
(function () {
  var charts = [];

  function palette() {
    var css = getComputedStyle(document.documentElement);
    return {
      fg: css.getPropertyValue('--fg').trim(),
      muted: css.getPropertyValue('--muted').trim(),
      grid: css.getPropertyValue('--grid').trim(),
      series: ['--s1', '--s2', '--s3'].map(function (name) {
        return css.getPropertyValue(name).trim();
      })
    };
  }

  function data(id) {
    return JSON.parse(document.getElementById(id).textContent);
  }

  function drawDrift(chart) {
    var d = data('fig-drift-data');
    var p = palette();
    chart.setOption({
      color: p.series,
      animation: false,
      grid: { left: 56, right: 16, top: 34, bottom: 32 },
      legend: { top: 0, textStyle: { color: p.muted } },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category',
        data: d.dates,
        axisLine: { lineStyle: { color: p.grid } },
        axisLabel: { color: p.muted }
      },
      yAxis: {
        type: 'value',
        scale: true,
        name: 'index (2019-01-02 = 100)',
        nameTextStyle: { color: p.muted, align: 'left' },
        splitLine: { lineStyle: { color: p.grid } },
        axisLabel: { color: p.muted }
      },
      series: d.series.map(function (s) {
        return {
          name: s.name,
          type: 'line',
          data: s.values,
          showSymbol: false,
          lineStyle: { width: 2 }
        };
      })
    });
  }

  function render() {
    charts.forEach(function (entry) { entry.draw(entry.chart); });
  }

  charts.push({ chart: echarts.init(document.getElementById('fig-drift')), draw: drawDrift });
  render();

  window.addEventListener('resize', function () {
    charts.forEach(function (entry) { entry.chart.resize(); });
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
})();
</script>

</body>
</html>
```

Four things in that example are the whole pattern, and they are what to carry into every report you
write: the chart reads its numbers out of a JSON block rather than having them pasted into the
script, every colour comes from a custom property so one palette serves both themes, `render()` is
separate from `init` so a theme change redraws instead of leaving a dark chart on a light page, and
the one borrowed sentence sits in a `<span>` with an id — `ref-feed-lag` — so a footnote can point
at the sentence rather than at the report at large.
