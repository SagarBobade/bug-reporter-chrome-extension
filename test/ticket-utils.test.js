const test = require("node:test");
const assert = require("node:assert/strict");
const U = require("../lib/ticket-utils.js");

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
const WEBP = "data:image/webp;base64,UklGRhIAAABXRUJQ";

// ── parseDataUrl ──────────────────────────────────────────────────────────────
test("parseDataUrl keeps the real media type and strips the prefix", () => {
  assert.deepEqual(U.parseDataUrl(PNG), { mimeType: "image/png", data: "iVBORw0KGgo=" });
  assert.deepEqual(U.parseDataUrl(JPEG), { mimeType: "image/jpeg", data: "/9j/4AAQSkZJRg==" });
  assert.deepEqual(U.parseDataUrl(WEBP), { mimeType: "image/webp", data: "UklGRhIAAABXRUJQ" });
});

test("parseDataUrl handles extra parameters and upper-case types", () => {
  assert.deepEqual(U.parseDataUrl("data:IMAGE/JPEG;name=a.jpg;base64,AAAA"), { mimeType: "image/jpeg", data: "AAAA" });
});

test("parseDataUrl treats bare base64 as legacy PNG", () => {
  assert.deepEqual(U.parseDataUrl("iVBORw0KGgo="), { mimeType: "image/png", data: "iVBORw0KGgo=" });
});

test("parseDataUrl rejects non-strings", () => {
  assert.throws(() => U.parseDataUrl(null), /not a string/);
});

// ── resolveModel ──────────────────────────────────────────────────────────────
test("resolveModel falls back to defaults and honours trimmed overrides", () => {
  assert.equal(U.resolveModel("anthropic", {}), "claude-opus-5-5");
  assert.equal(U.resolveModel("openai", undefined), "gpt-5.5");
  assert.equal(U.resolveModel("gemini", { modelOverrides: { gemini: "  gemini-3-pro  " } }), "gemini-3-pro");
  assert.equal(U.resolveModel("xai", { modelOverrides: { xai: "   " } }), "grok-2-vision-1212");
  assert.equal(U.resolveModel("nope", {}), undefined);
});

// ── buildProviderRequest ──────────────────────────────────────────────────────
const base = { apiKey: "k", systemPrompt: "SYS", userPrompt: "USER" };

test("gemini request sends each image with its own media type and bare base64", () => {
  const r = U.buildProviderRequest("gemini", { ...base, model: "gemini-2.5-flash", screenshots: [PNG, JPEG] });
  const parts = r.body.contents[0].parts;
  const images = parts.filter((p) => p.inline_data).map((p) => p.inline_data);
  assert.deepEqual(images, [
    { mime_type: "image/png", data: "iVBORw0KGgo=" },
    { mime_type: "image/jpeg", data: "/9j/4AAQSkZJRg==" },
  ]);
  assert.equal(parts.at(-1).text, "USER");
  assert.deepEqual(r.body.system_instruction, { parts: [{ text: "SYS" }] });
  assert.equal(r.headers["x-goog-api-key"], "k");
  assert.match(r.url, /models\/gemini-2\.5-flash:generateContent$/);
});

test("gemini caps thinking only on 2.5 models", () => {
  const a = U.buildProviderRequest("gemini", { ...base, model: "gemini-2.5-flash" });
  assert.deepEqual(a.body.generationConfig.thinkingConfig, { thinkingBudget: 1024 });
  assert.ok(a.body.generationConfig.maxOutputTokens >= 4096);
  const b = U.buildProviderRequest("gemini", { ...base, model: "gemini-3-pro" });
  assert.equal(b.body.generationConfig.thinkingConfig, undefined);
});

test("anthropic request uses the real media type and text-only base64", () => {
  const r = U.buildProviderRequest("anthropic", { ...base, model: "claude-opus-5-5", screenshots: [JPEG] });
  const img = r.body.messages[0].content.find((c) => c.type === "image");
  assert.deepEqual(img.source, { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQSkZJRg==" });
  assert.equal(r.body.system, "SYS");
  assert.equal(r.body.model, "claude-opus-5-5");
  assert.ok(r.body.max_tokens >= 8000, "leaves room for thinking");
  assert.equal(r.body.temperature, undefined);
  assert.equal(r.headers["anthropic-version"], "2023-06-01");
});

test("anthropic refusal fallback is enabled only for the default model", () => {
  const def = U.buildProviderRequest("anthropic", { ...base, model: "claude-opus-5-5" });
  assert.equal(def.body.fallbacks, "default");
  assert.equal(def.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  const custom = U.buildProviderRequest("anthropic", { ...base, model: "claude-haiku-4-5" });
  assert.equal(custom.body.fallbacks, undefined);
  assert.equal(custom.headers["anthropic-beta"], undefined);
});

test("openai request uses max_completion_tokens, no temperature, rebuilt data URLs", () => {
  const r = U.buildProviderRequest("openai", { ...base, model: "gpt-5.5", screenshots: [WEBP] });
  assert.equal(r.body.max_tokens, undefined);
  assert.equal(r.body.temperature, undefined);
  assert.ok(r.body.max_completion_tokens > 0);
  const img = r.body.messages[1].content.find((c) => c.type === "image_url");
  assert.equal(img.image_url.url, WEBP);
  assert.equal(r.body.messages[0].content, "SYS");
  assert.equal(r.headers.Authorization, "Bearer k");
});

test("openai text-only request sends a plain string user message", () => {
  const r = U.buildProviderRequest("openai", { ...base, model: "gpt-5.5" });
  assert.equal(r.body.messages[1].content, "USER");
});

test("xai request keeps max_tokens and temperature", () => {
  const r = U.buildProviderRequest("xai", { ...base, model: "grok-2-vision-1212", screenshots: [PNG] });
  assert.ok(r.body.max_tokens > 0);
  assert.equal(r.body.temperature, 0.2);
  assert.equal(r.url, "https://api.x.ai/v1/chat/completions");
});

test("system prompt is omitted when empty", () => {
  assert.equal(U.buildProviderRequest("gemini", { ...base, systemPrompt: "", model: "gemini-2.5-flash" }).body.system_instruction, undefined);
  assert.equal(U.buildProviderRequest("anthropic", { ...base, systemPrompt: "", model: "x" }).body.system, undefined);
  assert.equal(U.buildProviderRequest("openai", { ...base, systemPrompt: "", model: "x" }).body.messages[0].role, "user");
});

test("unknown provider throws", () => {
  assert.throws(() => U.buildProviderRequest("other", { ...base, model: "m" }), /Unknown AI provider/);
});

// ── Response extraction ───────────────────────────────────────────────────────
test("gemini: joins text parts, skips thought parts, reports usage incl. thinking", () => {
  const r = U.extractGeminiResponse({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: "plan", thought: true }, { text: "## Summary\n" }, { text: "Broken" }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 7, totalTokenCount: 22 },
  });
  assert.equal(r.text, "## Summary\nBroken");
  assert.equal(r.truncated, false);
  assert.deepEqual(r.tokenUsage, { input: 10, output: 12, total: 22 });
});

test("gemini: flags truncation, explains empty output and blocks", () => {
  const cut = U.extractGeminiResponse({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "partial" }] } }] });
  assert.equal(cut.truncated, true);
  assert.throws(() => U.extractGeminiResponse({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }] }), /output tokens/);
  assert.throws(() => U.extractGeminiResponse({ candidates: [{ finishReason: "SAFETY" }] }), /SAFETY/);
  assert.throws(() => U.extractGeminiResponse({ promptFeedback: { blockReason: "OTHER" } }), /blocked.*OTHER/);
  assert.throws(() => U.extractGeminiResponse({}), /Empty response/);
});

test("anthropic: reads text blocks after thinking blocks", () => {
  const r = U.extractAnthropicResponse({
    stop_reason: "end_turn",
    content: [{ type: "thinking", thinking: "" }, { type: "text", text: "## Summary\nX" }],
    usage: { input_tokens: 3, output_tokens: 4 },
  });
  assert.equal(r.text, "## Summary\nX");
  assert.deepEqual(r.tokenUsage, { input: 3, output: 4, total: 7 });
});

test("anthropic: refusal and max_tokens are surfaced", () => {
  assert.throws(() => U.extractAnthropicResponse({ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] }), /declined.*cyber/);
  assert.throws(() => U.extractAnthropicResponse({ stop_reason: "max_tokens", content: [{ type: "thinking" }] }), /output tokens/);
  assert.equal(U.extractAnthropicResponse({ stop_reason: "max_tokens", content: [{ type: "text", text: "a" }] }).truncated, true);
});

test("openai: content, refusal and length", () => {
  const ok = U.extractOpenAIResponse({ choices: [{ finish_reason: "stop", message: { content: " hi " } }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
  assert.equal(ok.text, "hi");
  assert.deepEqual(ok.tokenUsage, { input: 1, output: 2, total: 3 });
  assert.throws(() => U.extractOpenAIResponse({ choices: [{ message: { refusal: "no" } }] }), /declined: no/);
  assert.throws(() => U.extractOpenAIResponse({ choices: [{ finish_reason: "length", message: { content: "" } }] }), /output tokens/);
  assert.equal(U.extractOpenAIResponse({ choices: [{ finish_reason: "length", message: { content: "x" } }] }).truncated, true);
});

test("extractProviderResponse dispatches by provider", () => {
  const data = { choices: [{ finish_reason: "stop", message: { content: "t" } }] };
  assert.equal(U.extractProviderResponse("xai", data).text, "t");
  assert.throws(() => U.extractProviderResponse("zzz", data), /Unknown/);
});

test("formatApiError names provider and model", () => {
  assert.equal(U.formatApiError("anthropic", "claude-opus-5-5", 404, { error: { message: "model not found" } }),
    "Anthropic (claude-opus-5-5): model not found");
  assert.equal(U.formatApiError("openai", "gpt-5.5", 500, null), "OpenAI (gpt-5.5): HTTP 500");
  assert.equal(U.formatApiError("xai", "g", 400, { error: "bad" }), "xAI (g): bad");
});

// ── Environment ───────────────────────────────────────────────────────────────
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const EDGE_UA = WIN_UA + " Edg/141.0.0.0";

test("parseBrowserInfo prefers client hints over the frozen UA", () => {
  assert.deepEqual(
    U.parseBrowserInfo(MAC_UA, { platform: "macOS", platformVersion: "15.4.1", fullVersionList: [{ brand: "Not=A?Brand", version: "24" }, { brand: "Google Chrome", version: "141.0.7390.54" }] }),
    { browser: "Chrome 141", os: "macOS 15.4" }
  );
  assert.deepEqual(U.parseBrowserInfo(WIN_UA, { platform: "Windows", platformVersion: "15.0.0", brands: [{ brand: "Google Chrome", version: "141" }] }),
    { browser: "Chrome 141", os: "Windows 11" });
  assert.equal(U.parseBrowserInfo(WIN_UA, { platform: "Windows", platformVersion: "10.0.0" }).os, "Windows 10");
  assert.equal(U.parseBrowserInfo(EDGE_UA, { platform: "Windows", fullVersionList: [{ brand: "Chromium", version: "141" }, { brand: "Microsoft Edge", version: "141.0.1" }] }).browser, "Edge 141");
});

test("parseBrowserInfo falls back to the UA string", () => {
  assert.deepEqual(U.parseBrowserInfo(MAC_UA, null), { browser: "Chrome 141", os: "macOS" });
  assert.deepEqual(U.parseBrowserInfo(WIN_UA), { browser: "Chrome 141", os: "Windows 10/11" });
  assert.equal(U.parseBrowserInfo(EDGE_UA).browser, "Edge 141");
  assert.deepEqual(U.parseBrowserInfo(""), { browser: "Unknown", os: "Unknown" });
});

test("formatScreenInfo describes the page, with DPR when not 1", () => {
  assert.equal(U.formatScreenInfo({ screenWidth: 1512, screenHeight: 982, viewportWidth: 1512, viewportHeight: 857, devicePixelRatio: 2 }),
    "1512x982 (viewport: 1512x857) @2x");
  assert.equal(U.formatScreenInfo({ screenWidth: 1920, screenHeight: 1080, devicePixelRatio: 1 }), "1920x1080");
  assert.equal(U.formatScreenInfo(null), "Unknown");
});

// ── Screenshots section ───────────────────────────────────────────────────────
test("applyScreenshotsSection replaces the placeholder in the middle of a ticket", () => {
  const t = "## Summary\nX\n\n## Screenshots\n[Leave as is]\n\n## Impact\nY";
  assert.equal(U.applyScreenshotsSection(t, 2),
    "## Summary\nX\n\n## Screenshots\n- Screenshot 1 (attached)\n- Screenshot 2 (attached)\n\n## Impact\nY");
});

test("applyScreenshotsSection handles last section, missing section and no images", () => {
  assert.equal(U.applyScreenshotsSection("## Summary\nX\n\n## Screenshots\nwhatever the model wrote", 1),
    "## Summary\nX\n\n## Screenshots\n- Screenshot 1 (attached)");
  assert.equal(U.applyScreenshotsSection("## Summary\nX\n", 1), "## Summary\nX\n\n## Screenshots\n- Screenshot 1 (attached)");
  assert.equal(U.applyScreenshotsSection("## Screenshots\n[x]", 0), "## Screenshots\nNone attached");
});

test("applyScreenshotsSection never embeds image data", () => {
  const out = U.applyScreenshotsSection("## Screenshots\n[x]", 3);
  assert.doesNotMatch(out, /data:|<img/);
});

test("stripEmbeddedImages removes legacy base64 <img> tags only", () => {
  const legacy = `## Summary\nX\n\n## Screenshots\n<img src="${PNG}" alt="Screenshot 1" width="600" />\n<img src='${JPEG}' />\n\n## Impact\nY`;
  const out = U.stripEmbeddedImages(legacy);
  assert.doesNotMatch(out, /data:image/);
  assert.match(out, /## Impact\nY/);
  assert.equal(U.stripEmbeddedImages('<img src="https://x/y.png">'), '<img src="https://x/y.png">');
  assert.equal(U.stripEmbeddedImages(""), "");
});

// ── Generation state ──────────────────────────────────────────────────────────
test("isGenerationLost detects a worker restart and over-long runs", () => {
  const now = 1_000_000;
  const running = { isGenerating: true, generationId: "1", startTime: now - 1000 };
  assert.equal(U.isGenerationLost(running, { hasController: true, now }), false);
  assert.equal(U.isGenerationLost(running, { hasController: false, now }), true);
  assert.equal(U.isGenerationLost({ ...running, startTime: now - U.GENERATION_MAX_AGE_MS - 1 }, { hasController: true, now }), true);
  assert.equal(U.isGenerationLost({ isGenerating: false }, { hasController: false, now }), false);
  assert.equal(U.isGenerationLost(null, { now }), false);
});

// ── Markdown → HTML ───────────────────────────────────────────────────────────
test("markdownToHtml renders headings, lists, checkboxes and inline marks", () => {
  const html = U.markdownToHtml("## Steps to Reproduce\n1. Click **Save**\n2. Enter `abc`\n\n- [ ] Fix\n- [x] Done\n- note");
  assert.equal(html, [
    "<h2>Steps to Reproduce</h2>",
    "<ol>", "<li>Click <strong>Save</strong></li>", "<li>Enter <code>abc</code></li>", "</ol>",
    "<br>",
    "<ul>", "<li>☐ Fix</li>", "<li>☑ Done</li>", "<li>note</li>", "</ul>",
  ].join("\n"));
});

test("markdownToHtml escapes HTML from the model", () => {
  const html = U.markdownToHtml('Actual: <script>alert("x")</script> & "q"');
  assert.equal(html, "<p>Actual: &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;q&quot;</p>");
});

test("markdownToHtml maps # and ### headings", () => {
  assert.equal(U.markdownToHtml("# Title"), "<h2>Title</h2>");
  assert.equal(U.markdownToHtml("### Sub"), "<h3>Sub</h3>");
});

// ── Image labels & media sampling ─────────────────────────────────────────────
test("buildProviderRequest labels images with imageLabels, falling back to Screenshot N", () => {
  const labels = ["Screenshot 1", "Screen recording frame 1 of 3 (at 2.5s)"];
  const g = U.buildProviderRequest("gemini", { ...base, model: "gemini-2.5-flash", screenshots: [PNG, JPEG, PNG], imageLabels: labels });
  assert.deepEqual(g.body.contents[0].parts.filter((p) => p.text && p.text.startsWith("---")).map((p) => p.text),
    ["--- Screenshot 1 ---", "--- Screen recording frame 1 of 3 (at 2.5s) ---", "--- Screenshot 3 ---"]);
  const a = U.buildProviderRequest("anthropic", { ...base, model: "x", screenshots: [JPEG], imageLabels: ["GIF recording frame 2 of 3 (at 4s)"] });
  assert.equal(a.body.messages[0].content[0].text, "GIF recording frame 2 of 3 (at 4s):");
  const o = U.buildProviderRequest("openai", { ...base, model: "x", screenshots: [JPEG], imageLabels: ["L"] });
  assert.equal(o.body.messages[1].content[0].text, "L:");
});

test("sampleFrameIndices spreads samples and stays in range", () => {
  assert.deepEqual(U.sampleFrameIndices(144, 3), [24, 72, 120]);
  assert.deepEqual(U.sampleFrameIndices(2, 3), [0, 1]);
  assert.deepEqual(U.sampleFrameIndices(1, 3), [0]);
  assert.deepEqual(U.sampleFrameIndices(0, 3), []);
  assert.deepEqual(U.sampleFrameIndices(undefined, 3), []);
});

test("sampleTimes skips the very start/end and handles unknown duration", () => {
  assert.deepEqual(U.sampleTimes(30, 3), [5, 15, 25]);
  assert.deepEqual(U.sampleTimes(Infinity, 3), [0]);
  assert.deepEqual(U.sampleTimes(0, 3), [0]);
  assert.deepEqual(U.sampleTimes(NaN, 0), []);
});

test("combineReferenceImages puts screenshots first, labels frames, and caps the total", () => {
  const r = U.combineReferenceImages({
    screenshots: ["s1", "s2"],
    gifFrames: [{ src: "g1", time: 1 }, { src: "g2", time: 6 }],
    videoFrames: [{ src: "v1", time: 5 }, { src: "v2", time: 15 }, { src: "v3", time: 25 }],
    max: 6,
  });
  assert.deepEqual(r.images, ["s1", "s2", "g1", "g2", "v1", "v2"]);
  assert.deepEqual(r.labels, [
    "Screenshot 1",
    "Screenshot 2",
    "GIF recording frame 1 of 2 (at 1s)",
    "GIF recording frame 2 of 2 (at 6s)",
    "Screen recording frame 1 of 3 (at 5s)",
    "Screen recording frame 2 of 3 (at 15s)",
  ]);
  assert.deepEqual(U.combineReferenceImages(), { images: [], labels: [] });
});
