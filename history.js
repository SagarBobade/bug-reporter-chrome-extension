// history.js — Insights & history page. Reads the local ticket log written by the
// service worker (bugReporterHistory) and the all-time usage counter. Entries are
// read-only here; the only writes are "mark copied", "use as note" and "clear".

const HISTORY_KEY = "bugReporterHistory";
const USAGE_KEY = "bugReporterUsageStats";
const SESSION_KEY = "bugReporterSession";
const RANK_LIMIT = 5;

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

let entries = [];
let usage = { totalTokens: 0, ticketCount: 0 };
let settings = {};
let query = "";
const openIds = new Set(); // expanded entries survive live re-renders

async function load() {
  const r = await chrome.storage.local.get([HISTORY_KEY, USAGE_KEY, "bugReporterSettings"]);
  entries = (r[HISTORY_KEY] || []).slice().sort((a, b) => b.createdAt - a.createdAt);
  usage = r[USAGE_KEY] || usage;
  settings = r.bugReporterSettings || {};
  render();
}

function render() {
  const insights = TicketUtils.computeInsights(entries, { now: Date.now(), days: 14 });
  const retention = settings.historyRetentionDays ?? TicketUtils.HISTORY_DEFAULT_RETENTION_DAYS;
  $("retention-note").textContent =
    `Tickets generated with BugReporter, stored only in this browser. Keeps the newest ${TicketUtils.HISTORY_MAX_ENTRIES}` +
    (retention > 0 ? `, up to ${retention} days old.` : ".");
  $("disabled-banner").hidden = settings.historyEnabled !== false;
  $("btn-clear").disabled = !entries.length;
  $("btn-export").disabled = !entries.length;

  renderTiles(insights);
  renderChart(insights.perDay);
  renderRank($("rank-site"), insights.bySite, "No sites yet");
  renderRank($("rank-severity"), insights.bySeverity, "Severity wasn't set on any ticket");
  renderRank($("rank-component"), insights.byComponent, "Component wasn't set on any ticket");
  renderRank($("rank-source"), [
    ["Single report", insights.generated - insights.batch],
    ["Batch", insights.batch]
  ].filter(([, n]) => n > 0), "No tickets yet");
  renderList();
}

// ── Tiles ─────────────────────────────────────────────────────────────────────
function renderTiles(ins) {
  $("t-generated").textContent = nf.format(ins.generated);
  $("t-generated-sub").textContent = usage.ticketCount > ins.generated
    ? `${nf.format(usage.ticketCount)} all time`
    : "in history";
  $("t-copied").textContent = ins.generated ? `${Math.round(ins.copyRate * 100)}%` : "—";
  $("t-copied-sub").textContent = `${nf.format(ins.copied)} of ${nf.format(ins.generated)} tickets`;
  $("t-week").textContent = nf.format(ins.last7Days);
  $("t-week-sub").textContent = "tickets generated";
  $("t-tokens").textContent = ins.tokens >= 10000 ? compact.format(ins.tokens) : nf.format(ins.tokens);
  $("t-tokens-sub").textContent = usage.totalTokens > ins.tokens
    ? `${compact.format(usage.totalTokens)} all time, incl. refinements`
    : "for tickets in history";
}

// ── Column chart ──────────────────────────────────────────────────────────────
function niceMax(n) {
  if (n <= 4) return Math.max(1, n);
  const step = Math.pow(10, Math.floor(Math.log10(n)));
  return Math.ceil(n / step) * step;
}

function dayLabel(ts, opts) {
  return new Date(ts).toLocaleDateString(undefined, opts);
}

function renderChart(perDay) {
  const plot = $("plot");
  const xl = $("xlabels");
  plot.replaceChildren();
  xl.replaceChildren();
  const max = niceMax(Math.max(0, ...perDay.map((d) => d.count)));
  const peak = Math.max(...perDay.map((d) => d.count));

  // Recessive gridlines + ticks at 0, half, max
  [0, 0.5, 1].forEach((f) => {
    const value = Math.round(max * f * 10) / 10;
    if (f === 0.5 && !Number.isInteger(value)) return;
    const y = `${(1 - f) * 100}%`;
    if (f > 0) {
      const line = document.createElement("div");
      line.className = "gridline";
      line.style.top = y;
      plot.appendChild(line);
    }
    const tick = document.createElement("div");
    tick.className = "tick";
    tick.style.top = y;
    tick.textContent = nf.format(value);
    plot.appendChild(tick);
  });

  let peakLabelled = false;
  perDay.forEach((d) => {
    const col = document.createElement("button");
    col.className = "col";
    col.type = "button";
    const full = dayLabel(d.day, { weekday: "short", month: "short", day: "numeric" });
    col.setAttribute("aria-label", `${full}: ${d.count} ticket${d.count === 1 ? "" : "s"}`);
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = `${(d.count / max) * 100}%`;
    col.appendChild(bar);
    // Label only the peak (the one value the eye looks for); the rest live in the
    // tooltip and the table view.
    if (peak > 0 && d.count === peak && !peakLabelled) {
      const lbl = document.createElement("span");
      lbl.className = "peak";
      lbl.style.bottom = `${(d.count / max) * 100}%`;
      lbl.textContent = String(d.count);
      col.appendChild(lbl);
      peakLabelled = true;
    }
    const show = () => showTip(col, full, d.count);
    col.addEventListener("pointerenter", show);
    col.addEventListener("focus", show);
    col.addEventListener("pointerleave", hideTip);
    col.addEventListener("blur", hideTip);
    plot.appendChild(col);

    const x = document.createElement("span");
    x.textContent = dayLabel(d.day, { month: "numeric", day: "numeric" });
    xl.appendChild(x);
  });

  const tbody = $("chart-table").querySelector("tbody");
  tbody.replaceChildren();
  perDay.slice().reverse().forEach((d) => {
    const tr = document.createElement("tr");
    const a = document.createElement("td");
    a.textContent = dayLabel(d.day, { weekday: "short", month: "short", day: "numeric" });
    const b = document.createElement("td");
    b.className = "num";
    b.textContent = nf.format(d.count);
    tr.append(a, b);
    tbody.appendChild(tr);
  });
}

function showTip(col, label, count) {
  const tip = $("chart-tip");
  tip.replaceChildren();
  const strong = document.createElement("strong");
  strong.textContent = `${count} ticket${count === 1 ? "" : "s"}`;
  tip.append(strong, document.createTextNode(label));
  const chart = $("chart").getBoundingClientRect();
  const r = col.getBoundingClientRect();
  const bar = col.querySelector(".bar").getBoundingClientRect();
  tip.hidden = false;
  const half = tip.offsetWidth / 2;
  const x = Math.min(Math.max(r.left + r.width / 2 - chart.left, half), chart.width - half);
  tip.style.left = `${x}px`;
  tip.style.top = `${Math.min(bar.top, r.bottom - 4) - chart.top - 6}px`;
}

function hideTip() {
  $("chart-tip").hidden = true;
}

$("btn-chart-table").addEventListener("click", () => {
  const table = $("chart-table");
  table.hidden = !table.hidden;
  $("chart").hidden = !table.hidden;
  $("btn-chart-table").textContent = table.hidden ? "Show as table" : "Show as chart";
  $("btn-chart-table").setAttribute("aria-expanded", String(!table.hidden));
});

// ── Ranked bars ───────────────────────────────────────────────────────────────
// Top N plus one "Other" row, so a long tail never becomes a long list.
function renderRank(ul, pairs, emptyText) {
  ul.replaceChildren();
  if (!pairs.length) {
    const li = document.createElement("li");
    li.className = "empty-note";
    li.textContent = emptyText;
    ul.appendChild(li);
    return;
  }
  let rows = pairs.slice(0, RANK_LIMIT);
  const rest = pairs.slice(RANK_LIMIT).reduce((s, [, n]) => s + n, 0);
  if (rest) rows = [...rows, [`Other (${pairs.length - RANK_LIMIT})`, rest]];
  const max = Math.max(...rows.map(([, n]) => n));
  for (const [name, n] of rows) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = "name";
    label.textContent = name;
    label.title = name;
    const val = document.createElement("span");
    val.className = "val";
    val.textContent = nf.format(n);
    const track = document.createElement("div");
    track.className = "track";
    track.setAttribute("aria-hidden", "true");
    const fill = document.createElement("div");
    fill.className = "fill";
    fill.style.width = `${(n / max) * 100}%`;
    track.appendChild(fill);
    li.append(label, val, track);
    ul.appendChild(li);
  }
}

// ── History list ──────────────────────────────────────────────────────────────
function renderList() {
  const list = $("list");
  const empty = $("empty");
  list.replaceChildren();
  const shown = TicketUtils.filterHistory(entries, query);
  if (!shown.length) {
    empty.hidden = false;
    empty.textContent = entries.length
      ? "No tickets match your search."
      : "No tickets yet. Generate one from the extension popup and it will show up here.";
    return;
  }
  empty.hidden = true;
  for (const e of shown) list.appendChild(buildEntry(e));
}

function tag(text, cls = "") {
  const t = document.createElement("span");
  t.className = `tag ${cls}`.trim();
  t.textContent = text;
  return t;
}

function buildEntry(e) {
  const details = document.createElement("details");
  details.className = "entry";

  const summary = document.createElement("summary");
  if (e.thumbnail) {
    const img = document.createElement("img");
    img.className = "thumb";
    img.src = e.thumbnail;
    img.alt = "";
    summary.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "thumb";
    ph.setAttribute("aria-hidden", "true");
    summary.appendChild(ph);
  }
  const text = document.createElement("div");
  text.style.minWidth = "0";
  const title = document.createElement("div");
  title.className = "entry-title";
  title.textContent = e.summary || "(no summary)";
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.append(document.createTextNode(formatDateTime(e.createdAt)));
  if (e.site) meta.append(document.createTextNode(`· ${e.site}`));
  if (e.severity) meta.appendChild(tag(e.severity));
  if (e.component) meta.appendChild(tag(e.component));
  if (e.source === "batch") meta.appendChild(tag("Batch"));
  const media = [
    e.screenshotCount ? `${e.screenshotCount} screenshot${e.screenshotCount === 1 ? "" : "s"}` : "",
    e.hasVideo ? "video" : "",
    e.hasGif ? "GIF" : ""
  ].filter(Boolean).join(", ");
  if (media) meta.appendChild(tag(media));
  if (e.copiedAt) meta.appendChild(tag("Copied", "copied"));
  text.append(title, meta);
  summary.appendChild(text);
  details.appendChild(summary);

  // Body is built on first open — tickets can be long and lists up to 200.
  details.addEventListener("toggle", () => {
    if (details.open) openIds.add(e.id); else openIds.delete(e.id);
    if (!details.open || details.querySelector(".entry-body")) return;
    const body = document.createElement("div");
    body.className = "entry-body";
    const ticket = document.createElement("div");
    ticket.className = "ticket";
    ticket.innerHTML = TicketUtils.markdownToHtml(e.ticket); // escapes all ticket text
    body.appendChild(ticket);

    if (e.note && e.note.trim()) {
      const note = document.createElement("div");
      note.className = "note-block";
      note.textContent = `Your original description:\n${e.note}`;
      body.appendChild(note);
    }

    const actions = document.createElement("div");
    actions.className = "entry-actions";
    const copy = document.createElement("button");
    copy.className = "btn btn-secondary btn-sm";
    copy.textContent = "Copy ticket";
    copy.addEventListener("click", () => copyEntry(e));
    actions.appendChild(copy);
    if (/^https?:\/\//i.test(e.pageUrl)) {
      const open = document.createElement("a");
      open.className = "btn btn-ghost btn-sm";
      open.href = e.pageUrl;
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      open.textContent = "Open page";
      actions.appendChild(open);
    }
    const reuse = document.createElement("button");
    reuse.className = "btn btn-ghost btn-sm";
    reuse.textContent = "Use as new report";
    reuse.title = "Puts this description into the popup so you can report a similar bug";
    reuse.addEventListener("click", () => reuseEntry(e));
    actions.appendChild(reuse);
    const meta2 = document.createElement("span");
    meta2.className = "meta";
    meta2.style.marginLeft = "auto";
    meta2.textContent = [e.model, e.tokens ? `${nf.format(e.tokens)} tokens` : ""].filter(Boolean).join(" · ");
    actions.appendChild(meta2);
    body.appendChild(actions);
    details.appendChild(body);
  });
  if (openIds.has(e.id)) details.open = true;
  return details;
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function copyEntry(e) {
  await copyTicketRich({ text: e.ticket });
  await chrome.runtime.sendMessage({ type: "HISTORY_MARK_COPIED", id: e.id }).catch(() => {});
  showToast("Ticket copied (screenshots aren't stored in history)", "success");
}

async function reuseEntry(e) {
  const r = await chrome.storage.local.get(SESSION_KEY);
  const session = r[SESSION_KEY] || { screenshots: [], note: "", component: "", severity: "Medium" };
  const busy = (session.note || "").trim() || (session.screenshots || []).length || session.showingResult;
  if (busy && !confirm("Your current report in the popup isn't empty. Replace its description with this one? Screenshots stay.")) return;
  session.note = (e.note && e.note.trim()) || [e.summary, ""].join("\n");
  if (e.component) session.component = e.component;
  if (e.severity) session.severity = e.severity;
  // Back to the capture step with this description.
  delete session.generatedTicket;
  delete session.showingResult;
  delete session.chatHistory;
  delete session.historyId;
  await chrome.storage.local.set({ [SESSION_KEY]: session });
  showToast("Description added — open the extension to continue the report", "success", 4000);
}

$("btn-clear").addEventListener("click", async () => {
  if (!confirm(`Delete all ${entries.length} tickets from history? This can't be undone. The all-time counters stay.`)) return;
  const res = await chrome.runtime.sendMessage({ type: "CLEAR_HISTORY" }).catch((err) => ({ ok: false, error: err.message }));
  if (res?.ok) showToast("History cleared", "success");
  else showToast("Couldn't clear history: " + (res?.error || "unknown error"), "error");
});

$("btn-export").addEventListener("click", () => {
  const rows = TicketUtils.filterHistory(entries, query).map((e) => ({
    created: new Date(e.createdAt).toISOString(),
    summary: e.summary,
    description: e.ticket,
    severity: e.severity,
    component: e.component,
    pageUrl: e.pageUrl,
    source: e.source,
    copied: e.copiedAt ? "yes" : "no",
    model: e.model,
    tokens: e.tokens
  }));
  const csv = TicketUtils.toCsv(rows, [
    { key: "summary", header: "Summary" },
    { key: "description", header: "Description" },
    { key: "severity", header: "Severity" },
    { key: "component", header: "Component" },
    { key: "pageUrl", header: "Page URL" },
    { key: "created", header: "Created" },
    { key: "source", header: "Source" },
    { key: "copied", header: "Copied" },
    { key: "model", header: "Model" },
    { key: "tokens", header: "Tokens" }
  ]);
  downloadCsv(`bug-history-${new Date().toISOString().slice(0, 10)}.csv`, csv);
});

let searchTimer = null;
$("search").addEventListener("input", (ev) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { query = ev.target.value; renderList(); }, 150);
});

// Live: new tickets (from the popup or a batch) appear without a reload.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[HISTORY_KEY] || changes[USAGE_KEY] || changes.bugReporterSettings) load();
});

load();
