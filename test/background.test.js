const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackground, jsonResponse, plain } = require("./helpers/load-background.js");

const JPEG = "data:image/jpeg;base64,/9j/4AAQ";
const anthropicOk = (text) => jsonResponse(200, {
  stop_reason: "end_turn",
  content: [{ type: "thinking", thinking: "" }, { type: "text", text }],
  usage: { input_tokens: 100, output_tokens: 50 },
});

function settings(extra = {}) {
  return { bugReporterSettings: { aiProvider: "anthropic", anthropicApiKey: "sk-ant-test", enabledSections: ["summary", "environment"], ...extra } };
}

// ── buildPrompt ───────────────────────────────────────────────────────────────
test("buildPrompt puts the inspected page's environment in the ticket", () => {
  const bg = loadBackground();
  const { userPrompt } = bg.ctx.buildPrompt({
    pageUrl: "https://app.example.com/x", pageTitle: "X", audioNote: "Save fails",
    settings: { enabledSections: ["environment"] },
    screenInfo: "1512x982 (viewport: 1512x857) @2x", browserInfo: "Chrome 141", osInfo: "macOS 15.4",
  });
  assert.match(userPrompt, /\*\*Browser:\*\* Chrome 141/);
  assert.match(userPrompt, /\*\*OS:\*\* macOS 15\.4/);
  assert.match(userPrompt, /\*\*Screen:\*\* 1512x982 \(viewport: 1512x857\) @2x/);
  assert.match(userPrompt, /<notes>\nSave fails\n<\/notes>/);
});

test("buildPrompt falls back to the worker UA when page details are missing", () => {
  const bg = loadBackground();
  const { userPrompt } = bg.ctx.buildPrompt({ pageUrl: "u", pageTitle: "t", settings: { enabledSections: ["environment"] } });
  assert.match(userPrompt, /\*\*Browser:\*\* Chrome 140/);
  assert.match(userPrompt, /\*\*Screen:\*\* Unknown/);
});

// ── callAI ────────────────────────────────────────────────────────────────────
test("callAI sends the resolved model and JPEG media type, returns text and usage", async () => {
  let captured;
  const bg = loadBackground({ fetch: async (url, init) => { captured = { url, init }; return anthropicOk("## Summary\nOK"); } });
  const r = await bg.ctx.callAI({ provider: "anthropic", apiKey: "k", settings: {}, systemPrompt: "s", userPrompt: "u", screenshots: [JPEG] });
  assert.equal(r.text, "## Summary\nOK");
  assert.equal(r.model, "claude-opus-5-5");
  assert.deepEqual(plain(r.tokenUsage), { input: 100, output: 50, total: 150 });
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.messages[0].content.find((c) => c.type === "image").source.media_type, "image/jpeg");
});

test("callAI uses a model override from settings", async () => {
  let body;
  const bg = loadBackground({ fetch: async (url, init) => { body = JSON.parse(init.body); return anthropicOk("t"); } });
  await bg.ctx.callAI({ provider: "anthropic", apiKey: "k", settings: { modelOverrides: { anthropic: "claude-sonnet-5-5" } }, systemPrompt: "s", userPrompt: "u" });
  assert.equal(body.model, "claude-sonnet-5-5");
});

test("callAI reports API errors with provider and model", async () => {
  const bg = loadBackground({ fetch: async () => jsonResponse(404, { error: { message: "model not found" } }) });
  await assert.rejects(
    bg.ctx.callAI({ provider: "openai", apiKey: "k", settings: {}, systemPrompt: "s", userPrompt: "u" }),
    /OpenAI \(gpt-5\.5\): model not found/
  );
});

test("callAI reports network failures readably", async () => {
  const bg = loadBackground({ fetch: async () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(
    bg.ctx.callAI({ provider: "gemini", apiKey: "k", settings: {}, systemPrompt: "s", userPrompt: "u" }),
    /Gemini \(gemini-2\.5-flash\): network error \(Failed to fetch\)/
  );
});

test("callAI passes user cancellation through as AbortError", async () => {
  const bg = loadBackground({
    fetch: (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    }),
  });
  const controller = new AbortController();
  const p = bg.ctx.callAI({ provider: "anthropic", apiKey: "k", settings: {}, systemPrompt: "s", userPrompt: "u", signal: controller.signal });
  controller.abort();
  await assert.rejects(p, (err) => err.name === "AbortError");
});

test("callAI turns a hung request into a timeout error", async () => {
  const bg = loadBackground({
    fetch: (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    }),
  });
  await assert.rejects(
    bg.ctx.callAI({ provider: "anthropic", apiKey: "k", settings: {}, systemPrompt: "s", userPrompt: "u", timeoutMs: 20 }),
    /claude-opus-5-5\) did not respond within 0s/
  );
});

// ── generateTicket ────────────────────────────────────────────────────────────
test("generateTicket fills the Screenshots section without base64 data", async () => {
  const bg = loadBackground({
    storage: settings({ enabledSections: ["summary", "screenshots"] }),
    fetch: async () => anthropicOk("## Summary\nX\n\n## Screenshots\n[Leave as is — filled in automatically]"),
  });
  const r = await bg.ctx.generateTicket({ screenshots: [JPEG, JPEG], audioNote: "n", pageUrl: "u", pageTitle: "t" });
  assert.equal(r.text, "## Summary\nX\n\n## Screenshots\n- Screenshot 1 (attached)\n- Screenshot 2 (attached)");
  assert.doesNotMatch(r.text, /data:image|<img/);
  assert.equal(r.truncated, false);
});

test("generateTicket fails clearly without an API key", async () => {
  const bg = loadBackground({ storage: { bugReporterSettings: { aiProvider: "openai" } } });
  await assert.rejects(bg.ctx.generateTicket({ screenshots: [], audioNote: "n" }), /NO_API_KEY for openai/);
});

// ── Message handlers ──────────────────────────────────────────────────────────
test("GENERATE_TICKET stores the result and truncation flag", async () => {
  const bg = loadBackground({
    storage: settings(),
    fetch: async () => jsonResponse(200, { stop_reason: "max_tokens", content: [{ type: "text", text: "## Summary\nPart" }], usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  const res = await bg.send({ type: "GENERATE_TICKET", payload: { screenshots: [], audioNote: "n", pageUrl: "u", pageTitle: "t" } });
  assert.equal(res.ok, true);
  // Wait for the background work to finish.
  for (let i = 0; i < 50 && !bg.sent.some((m) => m.type === "GENERATION_COMPLETE"); i++) await new Promise((r) => setTimeout(r, 5));
  const done = bg.sent.find((m) => m.type === "GENERATION_COMPLETE");
  assert.equal(done.ticket, "## Summary\nPart");
  assert.equal(done.truncated, true);
  assert.equal(bg.store.bugReporterGenerationState.truncated, true);
  assert.equal(bg.store.bugReporterUsageStats.ticketCount, 1);
});

test("CHECK_GENERATION_STATUS turns a generation orphaned by a worker restart into an error", async () => {
  // State left behind by a previous worker: isGenerating, but no controller in this one.
  const bg = loadBackground({ storage: { bugReporterGenerationState: { isGenerating: true, generationId: "old", startTime: Date.now() - 5000 } } });
  const { state } = await bg.send({ type: "CHECK_GENERATION_STATUS" });
  assert.equal(state.isGenerating, false);
  assert.match(state.error, /interrupted/);
  assert.equal(bg.store.bugReporterGenerationState.isGenerating, false);
});

test("CHECK_GENERATION_STATUS leaves a live generation alone", async () => {
  const bg = loadBackground({
    storage: settings(),
    // Hangs until aborted, like a slow provider.
    fetch: (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    }),
  });
  const { generationId } = await bg.send({ type: "GENERATE_TICKET", payload: { screenshots: [], audioNote: "n" } });
  await new Promise((r) => setTimeout(r, 10));
  const { state } = await bg.send({ type: "CHECK_GENERATION_STATUS" });
  assert.equal(state.isGenerating, true);
  assert.equal(state.generationId, generationId);
  await bg.send({ type: "CANCEL_GENERATION", generationId });
});

test("TEST_API_KEY uses the same model as generation, including overrides", async () => {
  const bodies = [];
  const bg = loadBackground({ fetch: async (url, init) => { bodies.push({ url, body: JSON.parse(init.body), headers: init.headers }); return jsonResponse(200, {}); } });
  const a = await bg.send({ type: "TEST_API_KEY", provider: "anthropic", key: "k" });
  assert.deepEqual(plain(a), { ok: true, model: "claude-opus-5-5" });
  assert.equal(bodies[0].body.fallbacks, undefined);
  assert.equal(bodies[0].headers["anthropic-beta"], undefined);
  const b = await bg.send({ type: "TEST_API_KEY", provider: "gemini", key: "k", model: "gemini-3-pro" });
  assert.deepEqual(plain(b), { ok: true, model: "gemini-3-pro" });
  assert.match(bodies[1].url, /gemini-3-pro:generateContent/);
});

test("TEST_API_KEY returns provider-labelled errors", async () => {
  const bg = loadBackground({ fetch: async () => jsonResponse(401, { error: { message: "invalid x-api-key" } }) });
  const r = await bg.send({ type: "TEST_API_KEY", provider: "anthropic", key: "bad" });
  assert.deepEqual(plain(r), { ok: false, error: "Anthropic (claude-opus-5-5): invalid x-api-key" });
});

test("IMPROVE_TICKET strips legacy base64 images before sending the ticket", async () => {
  let body;
  const bg = loadBackground({ storage: settings(), fetch: async (url, init) => { body = JSON.parse(init.body); return anthropicOk("## Summary\nShorter"); } });
  const legacy = `## Summary\nLong\n\n## Screenshots\n<img src="${JPEG}" alt="Screenshot 1" width="600" />`;
  const r = await bg.send({ type: "IMPROVE_TICKET", payload: { currentTicket: legacy, feedback: "shorter", chatHistory: [], screenshots: [] } });
  assert.deepEqual(plain(r), { ok: true, ticket: "## Summary\nShorter", truncated: false });
  const prompt = body.messages[0].content.at(-1).text;
  assert.doesNotMatch(prompt, /data:image/);
  assert.match(prompt, /NEW FEEDBACK:\nshorter/);
  // Refinements now count toward token usage, without counting a ticket.
  assert.deepEqual(plain(bg.store.bugReporterUsageStats), { totalTokens: 150, ticketCount: 0 });
});

// ── REFINE_NOTE with media ────────────────────────────────────────────────────
test("REFINE_NOTE sends labelled media and tells the model how to use it", async () => {
  let body;
  const bg = loadBackground({ storage: settings(), fetch: async (url, init) => { body = JSON.parse(init.body); return anthropicOk("Clicking **Save** shows `Error 500`."); } });
  const res = await bg.send({
    type: "REFINE_NOTE",
    payload: { note: "clicking this button shows an error", images: [JPEG, JPEG], imageLabels: ["Screenshot 1", "Screen recording frame 1 of 3 (at 5s)"] }
  });
  assert.deepEqual(plain(res), { ok: true, note: "Clicking **Save** shows `Error 500`." });
  const content = body.messages[0].content;
  assert.deepEqual(content.filter((c) => c.type === "text").map((c) => c.text),
    ["Screenshot 1:", "Screen recording frame 1 of 3 (at 5s):", "REPORTER NOTES:\nclicking this button shows an error"]);
  assert.equal(content.filter((c) => c.type === "image").length, 2);
  assert.match(body.system, /Images from the report are attached/);
});

test("REFINE_NOTE without media stays text-only", async () => {
  let body;
  const bg = loadBackground({ storage: settings(), fetch: async (url, init) => { body = JSON.parse(init.body); return anthropicOk("Clean."); } });
  const res = await bg.send({ type: "REFINE_NOTE", payload: { note: "messy" } });
  assert.equal(res.ok, true);
  assert.equal(body.messages[0].content.filter((c) => c.type === "image").length, 0);
  assert.doesNotMatch(body.system, /Images from the report/);
});

// ── History ───────────────────────────────────────────────────────────────────
async function waitFor(fn, tries = 100) {
  for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error("timed out waiting");
}

test("GENERATE_TICKET records a history entry with the caller's details", async () => {
  const bg = loadBackground({ storage: settings(), fetch: async () => anthropicOk("## Summary\nCart: total is wrong") });
  await bg.send({ type: "GENERATE_TICKET", payload: {
    screenshots: [], audioNote: "n", pageUrl: "https://shop.example.com/cart", pageTitle: "Cart",
    history: { note: "total wrong", severity: "High", component: "Checkout", screenshotCount: 2, hasGif: true, thumbnail: "data:image/jpeg;base64,AA", evil: "x" }
  } });
  const done = await waitFor(() => bg.sent.find((m) => m.type === "GENERATION_COMPLETE"));
  const [entry] = plain(bg.store.bugReporterHistory);
  assert.equal(done.historyId, entry.id);
  assert.equal(bg.store.bugReporterGenerationState.historyId, entry.id);
  assert.equal(entry.summary, "Cart: total is wrong");
  assert.equal(entry.site, "shop.example.com");
  assert.equal(entry.severity, "High");
  assert.equal(entry.component, "Checkout");
  assert.equal(entry.screenshotCount, 2);
  assert.equal(entry.hasGif, true);
  assert.equal(entry.model, "claude-opus-5-5");
  assert.equal(entry.tokens, 150);
  assert.equal(entry.source, "single");
  assert.equal(entry.evil, undefined);
});

test("history is not recorded when turned off", async () => {
  const bg = loadBackground({ storage: settings({ historyEnabled: false }), fetch: async () => anthropicOk("## Summary\nX") });
  await bg.send({ type: "GENERATE_TICKET", payload: { screenshots: [], audioNote: "n" } });
  const done = await waitFor(() => bg.sent.find((m) => m.type === "GENERATION_COMPLETE"));
  assert.equal(done.historyId, null);
  assert.deepEqual(plain(bg.store.bugReporterHistory), []);
});

test("IMPROVE_TICKET updates the history entry; HISTORY_MARK_COPIED marks it", async () => {
  const replies = [anthropicOk("## Summary\nFirst"), anthropicOk("## Summary\nRefined")];
  const bg = loadBackground({ storage: settings(), fetch: async () => replies.shift() });
  await bg.send({ type: "GENERATE_TICKET", payload: { screenshots: [], audioNote: "n" } });
  const { historyId } = await waitFor(() => bg.sent.find((m) => m.type === "GENERATION_COMPLETE"));
  await bg.send({ type: "IMPROVE_TICKET", payload: { currentTicket: "## Summary\nFirst", feedback: "f", chatHistory: [], screenshots: [], historyId } });
  let [e] = plain(bg.store.bugReporterHistory);
  assert.equal(e.summary, "Refined");
  assert.equal(e.tokens, 300);
  assert.equal(e.copiedAt, null);
  assert.deepEqual(plain(await bg.send({ type: "HISTORY_MARK_COPIED", id: historyId })), { ok: true });
  await bg.send({ type: "HISTORY_MARK_COPIED", id: historyId });
  [e] = plain(bg.store.bugReporterHistory);
  assert.ok(e.copiedAt > 0);
  assert.equal(e.copyCount, 2);
  assert.deepEqual(plain(await bg.send({ type: "HISTORY_MARK_COPIED", id: "missing" })), { ok: false });
});

test("CLEAR_HISTORY empties history but keeps the all-time counter", async () => {
  const bg = loadBackground({ storage: { ...settings(), bugReporterHistory: [{ id: "x", createdAt: Date.now() }], bugReporterUsageStats: { totalTokens: 9, ticketCount: 3 } } });
  assert.deepEqual(plain(await bg.send({ type: "CLEAR_HISTORY" })), { ok: true });
  assert.deepEqual(plain(bg.store.bugReporterHistory), []);
  assert.deepEqual(plain(bg.store.bugReporterUsageStats), { totalTokens: 9, ticketCount: 3 });
});

test("concurrent history writes don't lose entries", async () => {
  const bg = loadBackground({ storage: settings() });
  const ids = await Promise.all(Array.from({ length: 8 }, (_, i) => bg.run(`addHistoryEntry({ ticket: "## Summary\\nT${i}" })`)));
  assert.equal(new Set(ids).size, 8);
  assert.equal(bg.store.bugReporterHistory.length, 8);
});

// ── Batch ─────────────────────────────────────────────────────────────────────
test("SPLIT_ISSUES asks for JSON-only output and returns parsed issues", async () => {
  let body;
  const bg = loadBackground({ storage: settings(), fetch: async (url, init) => {
    body = JSON.parse(init.body);
    return anthropicOk('{"issues":[{"title":"A broken","details":"d","duplicateOf":null},{"title":"A again","details":"","duplicateOf":1}]}');
  } });
  const res = plain(await bg.send({ type: "SPLIT_ISSUES", text: "- a broken\n- a again" }));
  assert.equal(res.ok, true);
  assert.deepEqual(res.issues.map((i) => [i.title, i.duplicateOf]), [["A broken", null], ["A again", 1]]);
  assert.match(body.system, /Reply with JSON only/);
  assert.match(body.messages[0].content.at(-1).text, /<notes>\n- a broken\n- a again\n<\/notes>/);
  assert.equal(bg.store.bugReporterUsageStats.ticketCount, 0, "splitting doesn't count as a ticket");
});

test("SPLIT_ISSUES reports unparseable replies", async () => {
  const bg = loadBackground({ storage: settings(), fetch: async () => anthropicOk("Sorry, I can't.") });
  const res = plain(await bg.send({ type: "SPLIT_ISSUES", text: "x" }));
  assert.equal(res.ok, false);
  assert.match(res.error, /wasn't a list/);
});

test("GENERATE_BATCH_TICKET returns the ticket and records a batch history entry", async () => {
  const bg = loadBackground({ storage: settings(), fetch: async () => anthropicOk("## Summary\nBatch one") });
  const res = plain(await bg.send({ type: "GENERATE_BATCH_TICKET", jobId: "j1",
    payload: { screenshots: [JPEG], audioNote: "n", pageUrl: "https://x.example.com/p", pageTitle: "P" },
    history: { note: "n", screenshotCount: 1 } }));
  assert.equal(res.ok, true);
  assert.equal(res.ticket, "## Summary\nBatch one");
  const [e] = plain(bg.store.bugReporterHistory);
  assert.equal(res.historyId, e.id);
  assert.equal(e.source, "batch");
  assert.equal(e.site, "x.example.com");
  assert.equal(bg.store.bugReporterUsageStats.ticketCount, 1);
  // A batch ticket must not touch the popup's single-generation state.
  assert.equal(bg.store.bugReporterGenerationState, undefined);
});

test("CANCEL_BATCH aborts in-flight batch tickets", async () => {
  const bg = loadBackground({ storage: settings(), fetch: (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  }) });
  const pending = bg.send({ type: "GENERATE_BATCH_TICKET", jobId: "j2", payload: { screenshots: [], audioNote: "n" } });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(plain(await bg.send({ type: "CANCEL_BATCH" })), { ok: true, cancelled: 1 });
  const res = plain(await pending);
  assert.equal(res.ok, false);
  assert.equal(res.cancelled, true);
  assert.deepEqual(plain(bg.store.bugReporterHistory || []), []);
});

// ── Cancelling refines ────────────────────────────────────────────────────────
const hangingFetch = (calls) => (url, init) => new Promise((_, reject) => {
  if (calls) calls.push(init);
  init.signal.addEventListener("abort", () => reject(init.signal.reason));
});

test("CANCEL_REQUEST stops a description refine and reports it as cancelled", async () => {
  const bg = loadBackground({ storage: settings(), fetch: hangingFetch() });
  const pending = bg.send({ type: "REFINE_NOTE", requestId: "r1", payload: { note: "messy" } });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(plain(await bg.send({ type: "CANCEL_REQUEST", requestId: "r1" })), { ok: true });
  assert.deepEqual(plain(await pending), { ok: false, cancelled: true });
  // Already finished → nothing left to cancel.
  assert.deepEqual(plain(await bg.send({ type: "CANCEL_REQUEST", requestId: "r1" })), { ok: false });
  assert.equal(bg.store.bugReporterUsageStats, undefined, "a cancelled refine records no usage");
});

test("CANCEL_REQUEST stops a chat refine and leaves the history entry untouched", async () => {
  const bg = loadBackground({
    storage: { ...settings(), bugReporterHistory: [{ id: "h1", createdAt: Date.now(), ticket: "## Summary\nOld", summary: "Old", tokens: 10 }] },
    fetch: hangingFetch()
  });
  const pending = bg.send({ type: "IMPROVE_TICKET", requestId: "c1", payload: { currentTicket: "## Summary\nOld", feedback: "shorter", chatHistory: [], screenshots: [], historyId: "h1" } });
  await new Promise((r) => setTimeout(r, 10));
  await bg.send({ type: "CANCEL_REQUEST", requestId: "c1" });
  assert.deepEqual(plain(await pending), { ok: false, cancelled: true });
  const [e] = plain(bg.store.bugReporterHistory);
  assert.equal(e.summary, "Old");
  assert.equal(e.tokens, 10);
});

test("cancelling one refine doesn't affect another", async () => {
  let n = 0;
  const bg = loadBackground({ storage: settings(), fetch: (url, init) => {
    n++;
    if (n === 1) return hangingFetch()(url, init);
    return Promise.resolve(anthropicOk("Refined"));
  } });
  const a = bg.send({ type: "REFINE_NOTE", requestId: "a", payload: { note: "one" } });
  const b = bg.send({ type: "REFINE_NOTE", requestId: "b", payload: { note: "two" } });
  await new Promise((r) => setTimeout(r, 10));
  await bg.send({ type: "CANCEL_REQUEST", requestId: "a" });
  assert.deepEqual(plain(await a), { ok: false, cancelled: true });
  assert.deepEqual(plain(await b), { ok: true, note: "Refined" });
});

test("refine without a requestId still works (not cancellable)", async () => {
  const bg = loadBackground({ storage: settings(), fetch: async () => anthropicOk("Clean.") });
  assert.deepEqual(plain(await bg.send({ type: "REFINE_NOTE", payload: { note: "x" } })), { ok: true, note: "Clean." });
});

test("a failed refine is an error, not a cancellation", async () => {
  const bg = loadBackground({ storage: settings(), fetch: async () => jsonResponse(429, { error: { message: "rate limited" } }) });
  const r = plain(await bg.send({ type: "REFINE_NOTE", requestId: "e1", payload: { note: "x" } }));
  assert.equal(r.ok, false);
  assert.equal(r.cancelled, undefined);
  assert.match(r.error, /rate limited/);
});
