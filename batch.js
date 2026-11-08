// batch.js — create several tickets at once.
//
// Flow: 1) paste a rough list → split into issues (AI or one-per-line)
//       2) review: edit/merge/remove, attach screenshots, set page per issue
//       3) generate one ticket per issue (2 at a time) → copy, copy all, CSV.
//
// Everything lives in chrome.storage (BATCH_KEY), so a reload or closed tab
// doesn't lose work. Each ticket is a separate, full-quality AI request.

const BATCH_KEY = "bugReporterBatch";
const LAUNCH_KEY = "bugReporterBatchLaunch";
const SESSION_KEY = "bugReporterSession";
const CONCURRENCY = 2;
const MAX_POOL = 12;

const $ = (id) => document.getElementById(id);

let batch = null;
let hasApiKey = true;
const activeJobs = new Set();

// ── Persistence ───────────────────────────────────────────────────────────────
let saveTimer = null;
function save(immediate = false) {
  clearTimeout(saveTimer);
  const write = () => chrome.storage.local.set({ [BATCH_KEY]: batch });
  if (immediate) return write();
  saveTimer = setTimeout(write, 300);
}

function newBatch(launch, sessionShots) {
  return {
    version: 1,
    createdAt: Date.now(),
    launchedAt: launch?.at || 0,
    target: {
      tabId: launch?.targetTabId || null,
      pageUrl: launch?.pageUrl || "",
      pageTitle: launch?.pageTitle || ""
    },
    env: null,
    rawText: "",
    pool: (sessionShots || []).slice(0, MAX_POOL),
    issues: [],
    phase: "input"
  };
}

function newIssue(fields = {}) {
  return {
    id: `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    include: true,
    title: fields.title || "",
    details: fields.details || "",
    duplicateOf: null,      // id of the earlier issue this may duplicate
    shots: [],              // indexes into batch.pool
    pageUrl: "",            // empty = the batch's target page
    status: "pending",      // pending | queued | generating | done | failed | cancelled
    ticket: "",
    error: "",
    truncated: false,
    historyId: null,
    copied: false
  };
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  $("max-issues").textContent = TicketUtils.MAX_BATCH_ISSUES;
  const r = await chrome.storage.local.get([BATCH_KEY, LAUNCH_KEY, SESSION_KEY]);
  const launch = r[LAUNCH_KEY];
  const sessionShots = r[SESSION_KEY]?.screenshots || [];
  batch = r[BATCH_KEY];

  const freshLaunch = launch && launch.at > (batch?.launchedAt || 0);
  const batchHasWork = !!batch && (batch.rawText.trim() || batch.issues.length);
  if (!batch) {
    batch = newBatch(launch, sessionShots);
  } else if (freshLaunch && !batchHasWork) {
    // Opened again from the popup before any work was done: follow the new page.
    batch = newBatch(launch, sessionShots);
  } else if (freshLaunch && launch.rawText &&
             confirm("You have a batch in progress. Replace it with the issues from the popup?")) {
    batch = newBatch(launch, sessionShots);
  }
  // Text handed over from the popup ("Open as batch") is used once.
  if (freshLaunch && launch.rawText && batch.launchedAt === launch.at && !batch.rawText) {
    batch.rawText = launch.rawText;
  }
  // Either way this launch has been handled — don't ask again on reload.
  if (freshLaunch) batch.launchedAt = launch.at;

  // Requests can't survive a reload of this page — offer a retry instead.
  for (const issue of batch.issues) {
    if (issue.status === "generating" || issue.status === "queued") {
      issue.status = "failed";
      issue.error = "Interrupted because this page was closed or reloaded. Retry to generate it.";
    }
  }

  const keyCheck = await chrome.runtime.sendMessage({ type: "CHECK_API_KEY" }).catch(() => null);
  hasApiKey = !!keyCheck?.ok;
  $("key-banner").hidden = hasApiKey;

  $("raw-text").value = batch.rawText;
  save(true);
  renderAll();
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function renderAll() {
  const p = batch.phase;
  $("target-label").textContent = batch.target.pageUrl
    ? `Page: ${batch.target.pageTitle || batch.target.pageUrl} — ${batch.target.pageUrl}`
    : "";
  $("section-input").hidden = p !== "input";
  $("section-pool").hidden = p === "results";
  $("section-review").hidden = p !== "review";
  $("review-bar").hidden = p !== "review";
  $("section-results").hidden = p !== "results";

  const order = ["input", "review", "results"];
  order.forEach((name, i) => {
    const el = $(`step-${name}`);
    el.classList.toggle("active", name === p);
    el.classList.toggle("done", i < order.indexOf(p));
  });

  $("btn-split-ai").disabled = !hasApiKey;
  renderPool();
  if (p === "review") renderIssues();
  if (p === "results") renderResults();
}

function renderPool() {
  const pool = $("pool");
  pool.replaceChildren();
  if (!batch.pool.length) {
    const empty = document.createElement("span");
    empty.className = "pool-empty";
    empty.textContent = "No screenshots yet.";
    pool.appendChild(empty);
    return;
  }
  batch.pool.forEach((src, i) => {
    const item = document.createElement("div");
    item.className = "pool-item";
    const img = document.createElement("img");
    img.src = src;
    img.alt = `Screenshot ${i + 1}`;
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = `#${i + 1}`;
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "✕";
    del.title = `Remove screenshot ${i + 1}`;
    del.setAttribute("aria-label", `Remove screenshot ${i + 1}`);
    del.addEventListener("click", () => removePoolImage(i));
    item.append(img, num, del);
    pool.appendChild(item);
  });
}

function issueNumber(issueId) {
  return batch.issues.findIndex((x) => x.id === issueId) + 1;
}

function renderIssues() {
  const list = $("issue-list");
  list.replaceChildren();
  batch.issues.forEach((issue, index) => list.appendChild(buildIssueCard(issue, index)));
  updateReviewBar();
}

function buildIssueCard(issue, index) {
  const card = document.createElement("article");
  card.className = "issue" + (issue.include ? "" : " excluded");

  // Left column: include checkbox + number
  const head = document.createElement("div");
  head.className = "issue-head";
  const include = document.createElement("input");
  include.type = "checkbox";
  include.checked = issue.include;
  include.setAttribute("aria-label", `Include issue ${index + 1}`);
  include.addEventListener("change", () => {
    issue.include = include.checked;
    card.classList.toggle("excluded", !issue.include);
    save();
    updateReviewBar();
  });
  const num = document.createElement("span");
  num.className = "issue-num";
  num.textContent = `#${index + 1}`;
  head.append(include, num);

  // Right column: fields
  const body = document.createElement("div");
  body.className = "issue-body";

  const titleId = `title-${issue.id}`;
  const titleLabel = document.createElement("label");
  titleLabel.htmlFor = titleId;
  titleLabel.textContent = "Title";
  const title = document.createElement("input");
  title.type = "text";
  title.id = titleId;
  title.className = "issue-title";
  title.value = issue.title;
  title.addEventListener("input", () => { issue.title = title.value; markEdited(issue); save(); updateReviewBar(); });

  const detailsId = `details-${issue.id}`;
  const detailsLabel = document.createElement("label");
  detailsLabel.htmlFor = detailsId;
  detailsLabel.textContent = "Details";
  const details = document.createElement("textarea");
  details.id = detailsId;
  details.className = "issue-details";
  details.value = issue.details;
  details.placeholder = "What happens, where, and what you expected";
  details.addEventListener("input", () => { issue.details = details.value; markEdited(issue); save(); updateReviewBar(); });

  body.append(titleLabel, title, detailsLabel, details);

  // Possible duplicate
  const dupOf = issue.duplicateOf && batch.issues.find((x) => x.id === issue.duplicateOf);
  if (dupOf) {
    const dup = document.createElement("div");
    dup.className = "dup";
    const text = document.createElement("span");
    text.textContent = `Possible duplicate of #${issueNumber(dupOf.id)}`;
    const merge = document.createElement("button");
    merge.className = "btn btn-secondary btn-sm";
    merge.textContent = `Merge into #${issueNumber(dupOf.id)}`;
    merge.addEventListener("click", () => mergeInto(issue, dupOf));
    const keep = document.createElement("button");
    keep.className = "btn btn-ghost btn-sm";
    keep.textContent = "Keep separate";
    keep.addEventListener("click", () => { issue.duplicateOf = null; save(); renderIssues(); });
    dup.append(text, merge, keep);
    body.appendChild(dup);
  }

  // Screenshots from the pool
  if (batch.pool.length) {
    const shotsLabel = document.createElement("label");
    shotsLabel.textContent = "Screenshots";
    const chips = document.createElement("div");
    chips.className = "chips";
    batch.pool.forEach((src, i) => {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.type = "button";
      chip.setAttribute("aria-pressed", String(issue.shots.includes(i)));
      chip.title = `Attach screenshot #${i + 1}`;
      chip.setAttribute("aria-label", `Attach screenshot ${i + 1} to issue ${index + 1}`);
      const img = document.createElement("img");
      img.src = src;
      img.alt = "";
      const tag = document.createElement("span");
      tag.textContent = `#${i + 1}`;
      chip.append(img, tag);
      chip.addEventListener("click", () => {
        issue.shots = issue.shots.includes(i) ? issue.shots.filter((x) => x !== i) : [...issue.shots, i].sort((a, b) => a - b);
        chip.setAttribute("aria-pressed", String(issue.shots.includes(i)));
        markEdited(issue);
        save();
        updateReviewBar();
      });
      chips.appendChild(chip);
    });
    body.append(shotsLabel, chips);
  }

  // Page (defaults to the batch's page)
  const pageId = `page-${issue.id}`;
  const pageLabel = document.createElement("label");
  pageLabel.htmlFor = pageId;
  pageLabel.textContent = "Page URL";
  const page = document.createElement("input");
  page.type = "url";
  page.id = pageId;
  page.value = issue.pageUrl;
  page.placeholder = batch.target.pageUrl || "https://…";
  page.addEventListener("input", () => { issue.pageUrl = page.value.trim(); markEdited(issue); save(); });
  body.append(pageLabel, page);

  // Actions
  const actions = document.createElement("div");
  actions.className = "issue-actions";
  if (index > 0) {
    const up = document.createElement("button");
    up.className = "btn btn-ghost btn-sm";
    up.textContent = `Merge into #${index}`;
    up.title = "Combine this issue with the one above";
    up.addEventListener("click", () => mergeInto(issue, batch.issues[index - 1]));
    actions.appendChild(up);
  }
  const remove = document.createElement("button");
  remove.className = "btn btn-ghost btn-sm";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => {
    batch.issues = batch.issues.filter((x) => x.id !== issue.id);
    batch.issues.forEach((x) => { if (x.duplicateOf === issue.id) x.duplicateOf = null; });
    save();
    renderIssues();
  });
  actions.appendChild(remove);
  body.appendChild(actions);

  card.append(head, body);
  return card;
}

// An edited issue no longer matches its ticket, so the next Generate redoes it.
function markEdited(issue) {
  if (issue.status !== "pending") issue.status = "pending";
}

function selectedIssues() {
  return batch.issues.filter((i) => i.include && (i.title.trim() || i.details.trim()));
}

function updateReviewBar() {
  const sel = selectedIssues();
  const todo = sel.filter((i) => i.status !== "done");
  const tokens = TicketUtils.estimateBatchTokens(todo.map((i) => ({ imageCount: i.shots.length })));
  const ready = sel.length - todo.length;
  $("review-summary").textContent = !sel.length
    ? "Select at least one issue"
    : `${sel.length} of ${batch.issues.length} issues selected` +
      (ready ? ` · ${ready} already generated` : "") +
      (todo.length ? ` · roughly ${tokens.toLocaleString()} tokens` : "");
  $("btn-generate").textContent = !todo.length && sel.length
    ? "View tickets"
    : todo.length === 1 ? "Generate 1 ticket" : `Generate ${todo.length} tickets`;
  $("btn-generate").disabled = !sel.length || (!hasApiKey && todo.length > 0);
}

function renderResults() {
  const list = $("result-list");
  list.replaceChildren();
  const included = batch.issues.filter((i) => i.status !== "pending");
  included.forEach((issue) => list.appendChild(buildResultCard(issue)));
  updateProgress();
}

const STATUS_TEXT = {
  queued: "Queued",
  generating: "Generating…",
  done: "Ready",
  failed: "Failed",
  cancelled: "Cancelled"
};

function buildResultCard(issue) {
  const card = document.createElement("article");
  card.className = "result";
  card.dataset.id = issue.id;

  const head = document.createElement("div");
  head.className = "result-head";
  const title = document.createElement("span");
  title.className = "result-title";
  title.textContent = `#${issueNumber(issue.id)} ${issue.status === "done" ? TicketUtils.extractSummary(issue.ticket) || issue.title : issue.title}`;
  const pill = document.createElement("span");
  pill.className = `pill ${issue.status}`;
  pill.textContent = STATUS_TEXT[issue.status] || issue.status;
  head.append(title, pill);

  if (issue.copied) {
    const copied = document.createElement("span");
    copied.className = "pill copied";
    copied.textContent = "Copied";
    head.appendChild(copied);
  }

  if (issue.status === "done") {
    const copy = document.createElement("button");
    copy.className = "btn btn-secondary btn-sm";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => copyOne(issue));
    head.appendChild(copy);
  }
  if (issue.status === "failed" || issue.status === "cancelled" || issue.status === "done") {
    const retry = document.createElement("button");
    retry.className = "btn btn-ghost btn-sm";
    retry.textContent = issue.status === "done" ? "Regenerate" : "Retry";
    retry.addEventListener("click", () => {
      queue([issue]);
    });
    head.appendChild(retry);
  }
  card.appendChild(head);

  if (issue.status === "done") {
    const body = document.createElement("div");
    body.className = "result-body";
    // markdownToHtml escapes all model text before adding its own tags.
    body.innerHTML = TicketUtils.markdownToHtml(issue.ticket);
    card.appendChild(body);
    if (issue.truncated) {
      const warn = document.createElement("div");
      warn.className = "result-error";
      warn.textContent = "The AI hit its output limit, so this ticket may be cut off. Check the end or regenerate.";
      card.appendChild(warn);
    }
  } else if (issue.error && (issue.status === "failed" || issue.status === "cancelled")) {
    const err = document.createElement("div");
    err.className = "result-error";
    err.textContent = issue.error;
    card.appendChild(err);
  }
  return card;
}

function rerenderResult(issue) {
  if (batch.phase !== "results") return;
  const old = document.querySelector(`.result[data-id="${issue.id}"]`);
  const fresh = buildResultCard(issue);
  if (old) old.replaceWith(fresh); else $("result-list").appendChild(fresh);
  updateProgress();
}

function updateProgress() {
  const all = batch.issues.filter((i) => i.status !== "pending");
  const n = (s) => all.filter((i) => i.status === s).length;
  const working = n("queued") + n("generating");
  const parts = [`${n("done")} of ${all.length} ready`];
  if (n("failed")) parts.push(`${n("failed")} failed`);
  if (n("cancelled")) parts.push(`${n("cancelled")} cancelled`);
  $("progress").textContent = parts.join(" · ");
  $("btn-cancel").hidden = !working;
  $("btn-copy-all").disabled = !n("done");
  $("btn-export-csv").disabled = !n("done");
  $("btn-back-review").disabled = !!working;
}

// ── Pool ──────────────────────────────────────────────────────────────────────
async function addPoolImages(files) {
  const room = MAX_POOL - batch.pool.length;
  if (room <= 0) { showToast(`Up to ${MAX_POOL} screenshots per batch`, "warning"); return; }
  const images = files.filter((f) => f.type.startsWith("image/"));
  if (images.length > room) showToast(`Only ${room} more screenshot(s) fit — added the first ${room}`, "warning");
  for (const file of images.slice(0, room)) {
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      batch.pool.push(await toPngDataUrl(dataUrl));
    } catch (e) {
      showToast("Couldn't read one of the images", "error");
    }
  }
  save();
  renderAll();
}

function removePoolImage(index) {
  batch.pool.splice(index, 1);
  // Keep every issue's attachments pointing at the same images.
  for (const issue of batch.issues) {
    issue.shots = issue.shots.filter((i) => i !== index).map((i) => (i > index ? i - 1 : i));
  }
  save();
  renderAll();
}

// ── Splitting ─────────────────────────────────────────────────────────────────
async function confirmReplaceIssues() {
  if (!batch.issues.length) return true;
  return confirm("Replace the issues you already reviewed with a fresh split of this text?");
}

async function splitWithAI() {
  const text = $("raw-text").value.trim();
  if (!text) { showToast("Paste or type some issues first", "warning"); return; }
  if (!(await confirmReplaceIssues())) return;
  const btn = $("btn-split-ai");
  btn.disabled = true;
  btn.textContent = "Splitting…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "SPLIT_ISSUES", text });
    if (!res?.ok) throw new Error(res?.error || "Unknown error");
    const issues = res.issues.map((x) => newIssue(x));
    // duplicateOf comes back as a 1-based position; store the issue id instead.
    res.issues.forEach((x, i) => {
      if (x.duplicateOf) issues[i].duplicateOf = issues[x.duplicateOf - 1]?.id || null;
    });
    setIssues(issues);
    const dups = issues.filter((i) => i.duplicateOf).length;
    showToast(`Found ${issues.length} issue${issues.length === 1 ? "" : "s"}${dups ? ` (${dups} possible duplicate${dups === 1 ? "" : "s"})` : ""}`, "success");
  } catch (e) {
    showToast("Split failed: " + e.message, "error", 5000);
  } finally {
    btn.disabled = !hasApiKey;
    btn.textContent = "✨ Split with AI";
  }
}

async function splitByLine() {
  const lines = $("raw-text").value.split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
  if (!lines.length) { showToast("Paste or type some issues first", "warning"); return; }
  if (!(await confirmReplaceIssues())) return;
  if (lines.length > TicketUtils.MAX_BATCH_ISSUES) {
    showToast(`Only the first ${TicketUtils.MAX_BATCH_ISSUES} lines were used`, "warning");
  }
  setIssues(lines.slice(0, TicketUtils.MAX_BATCH_ISSUES).map((title) => newIssue({ title })));
}

function setIssues(issues) {
  batch.issues = issues;
  batch.phase = "review";
  save(true);
  renderAll();
}

function mergeInto(issue, target) {
  if (!target || target === issue) return;
  target.details = [target.details || target.title, `${issue.title}${issue.details ? "\n" + issue.details : ""}`]
    .filter(Boolean).join("\n\n");
  target.shots = [...new Set([...target.shots, ...issue.shots])].sort((a, b) => a - b);
  batch.issues = batch.issues.filter((x) => x.id !== issue.id);
  batch.issues.forEach((x) => { if (x.duplicateOf === issue.id) x.duplicateOf = target.id; });
  save();
  renderIssues();
  showToast(`Merged into #${issueNumber(target.id)}`, "success");
}

// ── Generation ────────────────────────────────────────────────────────────────
async function ensureEnvironment() {
  if (batch.env) return batch.env;
  batch.env = await getPageEnvironment(batch.target.tabId || undefined);
  save();
  return batch.env;
}

function queue(issues) {
  for (const issue of issues) {
    issue.status = "queued";
    issue.error = "";
  }
  batch.phase = "results";
  save(true);
  renderAll();
  pump();
}

function pump() {
  while (activeJobs.size < CONCURRENCY) {
    const next = batch.issues.find((i) => i.status === "queued");
    if (!next) break;
    runIssue(next);
  }
  if (!activeJobs.size && !batch.issues.some((i) => i.status === "queued")) save(true);
}

async function runIssue(issue) {
  const jobId = `${issue.id}-${Date.now()}`;
  activeJobs.add(jobId);
  issue.status = "generating";
  issue.jobId = jobId;
  rerenderResult(issue);

  try {
    const env = await ensureEnvironment();
    const shots = issue.shots.map((i) => batch.pool[i]).filter(Boolean);
    const ownPage = issue.pageUrl && issue.pageUrl !== batch.target.pageUrl;
    const note = TicketUtils.issueToNote(issue);
    const res = await chrome.runtime.sendMessage({
      type: "GENERATE_BATCH_TICKET",
      jobId,
      payload: {
        screenshots: shots,
        audioNote: note,
        pageUrl: ownPage ? issue.pageUrl : batch.target.pageUrl,
        pageTitle: ownPage ? "" : batch.target.pageTitle,
        screenInfo: env.screenInfo,
        browserInfo: env.browser,
        osInfo: env.os
      },
      history: {
        note,
        screenshotCount: shots.length,
        thumbnail: await makeThumbnail(shots[0])
      }
    });
    if (issue.jobId !== jobId) return; // cancelled and re-queued meanwhile
    if (res?.ok) {
      Object.assign(issue, { status: "done", ticket: res.ticket, truncated: !!res.truncated, historyId: res.historyId || null, copied: false, error: "" });
    } else if (res?.cancelled) {
      Object.assign(issue, { status: "cancelled", error: "" });
    } else {
      Object.assign(issue, { status: "failed", error: res?.error || "No response from the extension. Try again." });
    }
  } catch (e) {
    if (issue.jobId === jobId) Object.assign(issue, { status: "failed", error: e.message });
  } finally {
    activeJobs.delete(jobId);
    save();
    rerenderResult(issue);
    pump();
  }
}

function cancelRemaining() {
  for (const issue of batch.issues) {
    if (issue.status === "queued") issue.status = "cancelled";
  }
  chrome.runtime.sendMessage({ type: "CANCEL_BATCH" }).catch(() => {});
  save(true);
  renderResults();
}

// ── Copy / export ─────────────────────────────────────────────────────────────
function markCopied(issues) {
  for (const issue of issues) {
    issue.copied = true;
    if (issue.historyId) chrome.runtime.sendMessage({ type: "HISTORY_MARK_COPIED", id: issue.historyId }).catch(() => {});
  }
  save();
}

async function copyOne(issue) {
  const shots = issue.shots.map((i) => batch.pool[i]).filter(Boolean);
  const image = await screenshotsToClipboardImage(shots);
  const { withImage } = await copyTicketRich({ text: issue.ticket, image });
  markCopied([issue]);
  rerenderResult(issue);
  showToast(withImage ? "Ticket and screenshot copied" : "Ticket copied", "success");
}

async function copyAll() {
  const done = batch.issues.filter((i) => i.status === "done");
  if (!done.length) return;
  const text = TicketUtils.joinTickets(done.map((i) => i.ticket));
  await copyTicketRich({ text });
  markCopied(done);
  renderResults();
  showToast(`${done.length} tickets copied (screenshots aren't included — use Copy on each ticket for those)`, "success", 4500);
}

function exportCsv() {
  const done = batch.issues.filter((i) => i.status === "done");
  if (!done.length) return;
  const rows = done.map((i) => ({
    summary: TicketUtils.extractSummary(i.ticket) || i.title,
    description: i.ticket,
    pageUrl: i.pageUrl || batch.target.pageUrl
  }));
  const csv = TicketUtils.toCsv(rows, [
    { key: "summary", header: "Summary" },
    { key: "description", header: "Description" },
    { key: "pageUrl", header: "Page URL" }
  ]);
  downloadCsv(`bug-batch-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  markCopied(done);
  renderResults();
}

async function startNewBatch() {
  if (batch.issues.some((i) => i.status === "done" && !i.copied) &&
      !confirm("Some tickets haven't been copied or exported. They're still in Insights & history. Start a new batch?")) {
    return;
  }
  if (activeJobs.size) cancelRemaining();
  const r = await chrome.storage.local.get([LAUNCH_KEY, SESSION_KEY]);
  batch = newBatch(r[LAUNCH_KEY], r[SESSION_KEY]?.screenshots || []);
  $("raw-text").value = "";
  save(true);
  renderAll();
}

// ── Events ────────────────────────────────────────────────────────────────────
$("raw-text").addEventListener("input", (e) => { batch.rawText = e.target.value; save(); });
$("btn-split-ai").addEventListener("click", splitWithAI);
$("btn-split-lines").addEventListener("click", splitByLine);
$("btn-back-input").addEventListener("click", () => { batch.phase = "input"; save(); renderAll(); });
$("btn-add-issue").addEventListener("click", () => {
  if (batch.issues.length >= TicketUtils.MAX_BATCH_ISSUES) {
    showToast(`Up to ${TicketUtils.MAX_BATCH_ISSUES} issues per batch`, "warning");
    return;
  }
  batch.issues.push(newIssue());
  save();
  renderIssues();
  document.querySelector(".issue:last-child .issue-title")?.focus();
});
$("btn-generate").addEventListener("click", () => {
  const sel = selectedIssues();
  if (!sel.length) return;
  // Deselected issues drop out of the results; finished ones aren't paid for twice.
  for (const issue of batch.issues) if (!sel.includes(issue)) issue.status = "pending";
  queue(sel.filter((i) => i.status !== "done"));
});
$("btn-back-review").addEventListener("click", () => { batch.phase = "review"; save(); renderAll(); });
$("btn-cancel").addEventListener("click", cancelRemaining);
$("btn-copy-all").addEventListener("click", copyAll);
$("btn-export-csv").addEventListener("click", exportCsv);
$("btn-new-batch").addEventListener("click", startNewBatch);
$("btn-pool-add").addEventListener("click", () => $("pool-upload").click());
$("pool-upload").addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = "";
  addPoolImages(files);
});
document.addEventListener("paste", (e) => {
  if (batch.phase === "results") return;
  const files = Array.from(e.clipboardData?.files || []).filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  e.preventDefault();
  addPoolImages(files);
});
window.addEventListener("beforeunload", (e) => {
  if (activeJobs.size) { e.preventDefault(); e.returnValue = ""; }
});

init();
