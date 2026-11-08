const test = require("node:test");
const assert = require("node:assert/strict");
const U = require("../lib/ticket-utils.js");

// ── parseIssueList ────────────────────────────────────────────────────────────
test("parseIssueList reads {issues:[…]} and normalises fields", () => {
  const out = U.parseIssueList(JSON.stringify({ issues: [
    { title: "  Save   button does nothing ", details: "Profile page, empty phone", duplicateOf: null },
    { title: "Save is broken", details: "", duplicateOf: 1 },
  ] }));
  assert.deepEqual(out, [
    { title: "Save button does nothing", details: "Profile page, empty phone", duplicateOf: null },
    { title: "Save is broken", details: "", duplicateOf: 1 },
  ]);
});

test("parseIssueList tolerates fences, prose and a bare array", () => {
  assert.equal(U.parseIssueList('```json\n[{"title":"A"}]\n```')[0].title, "A");
  assert.equal(U.parseIssueList('Here you go:\n{"issues":[{"title":"B"}]}\nThanks')[0].title, "B");
});

test("parseIssueList drops invalid duplicateOf (self, forward, junk) and empty items", () => {
  const out = U.parseIssueList(JSON.stringify([
    { title: "A", duplicateOf: 1 },        // self
    { title: "B", duplicateOf: 3 },        // forward
    { title: "", details: "" },            // empty → skipped
    { title: "C", duplicateOf: "x" },
    { summary: "D via summary", description: "d", duplicateOf: 2 },
  ]));
  assert.deepEqual(out.map((i) => [i.title, i.duplicateOf]), [["A", null], ["B", null], ["C", null], ["D via summary", 2]]);
});

test("parseIssueList uses the details' first line when the title is missing", () => {
  assert.equal(U.parseIssueList('[{"details":"Line one\\nLine two"}]')[0].title, "Line one");
});

test("parseIssueList caps the batch size", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ title: `T${i}` }));
  assert.equal(U.parseIssueList(JSON.stringify(many)).length, U.MAX_BATCH_ISSUES);
});

test("parseIssueList rejects non-lists with a readable error", () => {
  assert.throws(() => U.parseIssueList(""), /no issues/);
  assert.throws(() => U.parseIssueList("I could not do that."), /wasn't a list/);
  assert.throws(() => U.parseIssueList('{"foo": 1}'), /wasn't a list/);
  assert.throws(() => U.parseIssueList("[]"), /found no issues/);
});

test("issueToNote joins title and details without repeating", () => {
  assert.equal(U.issueToNote({ title: "T", details: "D" }), "T\n\nD");
  assert.equal(U.issueToNote({ title: "T", details: "" }), "T");
  assert.equal(U.issueToNote({ title: "T", details: "T" }), "T");
});

test("estimateBatchTokens scales with issues and images", () => {
  assert.equal(U.estimateBatchTokens([]), 0);
  assert.equal(U.estimateBatchTokens([{ imageCount: 0 }, { imageCount: 2 }]), 2 * (1800 + 700) + 2 * 1500);
});

// ── Ticket helpers ────────────────────────────────────────────────────────────
test("extractSummary takes the line under ## Summary, without Markdown", () => {
  assert.equal(U.extractSummary("## Summary\nProfile: **Save** button ignores `phone`\n\n## Steps\n1. x"),
    "Profile: Save button ignores phone");
  assert.equal(U.extractSummary("No headings here\nsecond"), "No headings here");
  assert.equal(U.extractSummary(""), "");
  assert.equal(U.extractSummary("## Summary\n" + "x".repeat(300)).length, 255);
});

test("joinTickets separates tickets with a rule", () => {
  assert.equal(U.joinTickets(["A\n", "", " B"]), "A\n\n---\n\nB");
});

test("toCsv quotes, escapes and defuses formulas", () => {
  const csv = U.toCsv(
    [{ a: 'He said "hi"', b: "line1\nline2" }, { a: "=SUM(A1)", b: "-bullet" }, { a: null, b: 3 }],
    [{ key: "a", header: "A" }, { key: "b", header: "B, too" }]
  );
  assert.equal(csv, 'A,"B, too"\r\n"He said ""hi""","line1\nline2"\r\n\'=SUM(A1),-bullet\r\n,3');
});

test("markdownToHtml renders --- as a rule", () => {
  assert.equal(U.markdownToHtml("A\n---\nB"), "<p>A</p>\n<hr>\n<p>B</p>");
});

// ── History ───────────────────────────────────────────────────────────────────
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 10, 9, 15, 0, 0).getTime(); // local time

test("makeHistoryEntry derives summary/site and whitelists the thumbnail", () => {
  const e = U.makeHistoryEntry({
    ticket: "## Summary\nCart: total is wrong\n\n## Steps\n1. a",
    pageUrl: "https://www.shop.example.com/cart?x=1",
    tokenUsage: { total: 1234 },
    thumbnail: "javascript:alert(1)",
    source: "weird",
  }, { now: NOW, id: "h1" });
  assert.equal(e.id, "h1");
  assert.equal(e.summary, "Cart: total is wrong");
  assert.equal(e.site, "shop.example.com");
  assert.equal(e.tokens, 1234);
  assert.equal(e.thumbnail, "");
  assert.equal(e.source, "single");
  assert.equal(e.copiedAt, null);
  assert.equal(U.makeHistoryEntry({ thumbnail: "data:image/jpeg;base64,AA", source: "batch" }, { now: NOW }).thumbnail, "data:image/jpeg;base64,AA");
});

test("hostnameOf handles junk", () => {
  assert.equal(U.hostnameOf("not a url"), "");
  assert.equal(U.hostnameOf("chrome://extensions"), "extensions");
});

test("pruneHistory sorts newest first, drops old entries, caps the count", () => {
  const entries = [
    { id: "old", createdAt: NOW - 100 * DAY },
    { id: "a", createdAt: NOW - 1 * DAY },
    { id: "b", createdAt: NOW - 2 * DAY },
    { id: "c", createdAt: NOW },
  ];
  assert.deepEqual(U.pruneHistory(entries, { now: NOW, retentionDays: 90 }).map((e) => e.id), ["c", "a", "b"]);
  assert.deepEqual(U.pruneHistory(entries, { now: NOW, retentionDays: 0 }).map((e) => e.id), ["c", "a", "b", "old"]);
  assert.deepEqual(U.pruneHistory(entries, { now: NOW, retentionDays: 0, maxEntries: 2 }).map((e) => e.id), ["c", "a"]);
  assert.deepEqual(U.pruneHistory(null, { now: NOW }), []);
});

test("filterHistory searches summary, ticket, site and component", () => {
  const list = [
    { summary: "Cart total wrong", ticket: "", site: "shop.example.com", component: "Checkout" },
    { summary: "Login button", ticket: "error 500 shown", site: "auth.example.com", component: "" },
  ];
  assert.equal(U.filterHistory(list, "  CART ").length, 1);
  assert.equal(U.filterHistory(list, "500")[0].summary, "Login button");
  assert.equal(U.filterHistory(list, "checkout").length, 1);
  assert.equal(U.filterHistory(list, "").length, 2);
});

test("computeInsights counts, rates, rankings and per-day buckets", () => {
  const entries = [
    { createdAt: NOW, site: "a.com", severity: "High", component: "Cart", tokens: 100, copiedAt: NOW, source: "single" },
    { createdAt: NOW - DAY, site: "a.com", severity: "Low", component: "", tokens: 50, copiedAt: null, source: "batch" },
    { createdAt: NOW - DAY, site: "b.com", severity: "High", component: "Cart", tokens: 25, copiedAt: null, source: "batch" },
    { createdAt: NOW - 10 * DAY, site: "b.com", severity: "", component: "Login", tokens: 0, copiedAt: NOW, source: "single" },
    { createdAt: NOW - 30 * DAY, site: "c.com", severity: "", component: "", tokens: 0, copiedAt: null, source: "single" },
  ];
  const r = U.computeInsights(entries, { now: NOW, days: 14 });
  assert.equal(r.generated, 5);
  assert.equal(r.copied, 2);
  assert.equal(r.copyRate, 0.4);
  assert.equal(r.last7Days, 3);
  assert.equal(r.tokens, 175);
  assert.equal(r.batch, 2);
  assert.deepEqual(r.bySite, [["a.com", 2], ["b.com", 2], ["c.com", 1]]);
  assert.deepEqual(r.bySeverity, [["High", 2], ["Low", 1]]);
  assert.deepEqual(r.byComponent, [["Cart", 2], ["Login", 1]]);
  assert.equal(r.perDay.length, 14);
  assert.deepEqual(r.perDay.slice(-2).map((d) => d.count), [2, 1]);
  assert.equal(r.perDay[3].count, 1); // 10 days ago
  assert.equal(r.perDay.reduce((s, d) => s + d.count, 0), 4); // 30-day-old entry is outside the window
});

test("computeInsights on an empty history", () => {
  const r = U.computeInsights([], { now: NOW });
  assert.equal(r.generated, 0);
  assert.equal(r.copyRate, 0);
  assert.ok(r.perDay.every((d) => d.count === 0));
});

// ── JSON mode ─────────────────────────────────────────────────────────────────
test("jsonMode asks Gemini/OpenAI/xAI for JSON and leaves Anthropic alone", () => {
  const base = { apiKey: "k", systemPrompt: "S", userPrompt: "U", jsonMode: true };
  assert.equal(U.buildProviderRequest("gemini", { ...base, model: "gemini-2.5-flash" }).body.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(U.buildProviderRequest("openai", { ...base, model: "gpt-5.5" }).body.response_format, { type: "json_object" });
  assert.deepEqual(U.buildProviderRequest("xai", { ...base, model: "g" }).body.response_format, { type: "json_object" });
  const a = U.buildProviderRequest("anthropic", { ...base, model: "claude-opus-5-5" }).body;
  assert.equal(a.response_format, undefined);
  assert.equal(U.buildProviderRequest("openai", { ...base, jsonMode: false, model: "gpt-5.5" }).body.response_format, undefined);
});

// ── List detection (popup → batch hand-off) ───────────────────────────────────
test("looksLikeIssueList fires on 3+ bullet lines only", () => {
  const sample1 = `- Save button on Profile page does nothing when the Phone field is empty
- Date picker on Bookings shows yesterday's date in Safari
- Typo on Checkout page: "Procced to payment"
- Search results don't update after clearing the search box
- Logout link in the user menu is cut off on screens narrower than 400px`;
  assert.equal(U.countBulletItems(sample1), 5);
  assert.equal(U.looksLikeIssueList(sample1), true);
  assert.equal(U.looksLikeIssueList("* one\r\n• two\r\n  - three"), true);
  // A single bug with numbered steps is not a list of issues.
  assert.equal(U.looksLikeIssueList("Save fails.\n1. Open profile\n2. Clear phone\n3. Click Save"), false);
  assert.equal(U.looksLikeIssueList("- only\n- two bullets"), false);
  assert.equal(U.looksLikeIssueList("-5 degrees shown\n--- divider ---\n-"), false);
  assert.equal(U.looksLikeIssueList(""), false);
});
