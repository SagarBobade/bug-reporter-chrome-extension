// lib/ticket-utils.js — pure helpers shared by the service worker (importScripts),
// the popup (<script>) and the Node unit tests (require). No chrome.* or DOM access
// here, so everything in this file can be tested with `npm test`.

(function (root) {
  "use strict";

  // ── Models ──────────────────────────────────────────────────────────────────
  // One table for every call site (generation, refine, key test). Users can
  // override a model per provider in Settings → AI Provider.
  const DEFAULT_MODELS = Object.freeze({
    gemini: "gemini-2.5-flash",
    openai: "gpt-5.5",
    anthropic: "claude-opus-5-5",
    xai: "grok-2-vision-1212",
  });

  const PROVIDER_LABELS = Object.freeze({
    gemini: "Gemini",
    openai: "OpenAI",
    anthropic: "Anthropic",
    xai: "xAI",
  });

  function resolveModel(provider, settings) {
    const override = settings && settings.modelOverrides && settings.modelOverrides[provider];
    if (typeof override === "string" && override.trim()) return override.trim();
    return DEFAULT_MODELS[provider];
  }

  function providerLabel(provider) {
    return PROVIDER_LABELS[provider] || provider || "AI";
  }

  // ── Data URLs ───────────────────────────────────────────────────────────────
  // Screenshots can be PNG (captures, annotations) or JPEG/WebP/GIF (uploads, and
  // sessions saved by older versions). Providers need the real media type and the
  // bare base64 payload, so never assume PNG.
  function parseDataUrl(dataUrl) {
    if (typeof dataUrl !== "string") throw new Error("Screenshot is not a string");
    const match = dataUrl.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s);
    if (!match) {
      // Bare base64 with no prefix — the only producer of that is legacy PNG capture.
      return { mimeType: "image/png", data: dataUrl };
    }
    return { mimeType: (match[1] || "image/png").toLowerCase(), data: match[2] };
  }

  // ── Environment ─────────────────────────────────────────────────────────────
  // `hints` is the result of navigator.userAgentData.getHighEntropyValues() from
  // the inspected page, when available. Chrome freezes the UA string (macOS is
  // always "10_15_7", Windows always "NT 10.0"), so hints win whenever present.
  function parseBrowserInfo(ua, hints) {
    ua = ua || "";
    let browser = "Unknown";
    let os = "Unknown";

    const brands = (hints && (hints.fullVersionList || hints.brands)) || [];
    const brand = (name) => brands.find((b) => b && b.brand === name);
    const major = (v) => String(v || "").split(".")[0];

    const edgeBrand = brand("Microsoft Edge");
    const chromeBrand = brand("Google Chrome");
    const operaBrand = brand("Opera");
    const braveBrand = brand("Brave");
    if (edgeBrand) browser = `Edge ${major(edgeBrand.version)}`;
    else if (operaBrand) browser = `Opera ${major(operaBrand.version)}`;
    else if (braveBrand) browser = `Brave ${major(braveBrand.version)}`;
    else if (chromeBrand) browser = `Chrome ${major(chromeBrand.version)}`;
    else if (/Edg\/(\d+)/.test(ua)) browser = `Edge ${ua.match(/Edg\/(\d+)/)[1]}`;
    else if (/OPR\/(\d+)/.test(ua)) browser = `Opera ${ua.match(/OPR\/(\d+)/)[1]}`;
    else if (/Chrome\/(\d+)/.test(ua)) browser = `Chrome ${ua.match(/Chrome\/(\d+)/)[1]}`;
    else if (/Firefox\/(\d+)/.test(ua)) browser = `Firefox ${ua.match(/Firefox\/(\d+)/)[1]}`;
    else if (/Version\/(\d+).*Safari/.test(ua)) browser = `Safari ${ua.match(/Version\/(\d+)/)[1]}`;

    const platform = hints && hints.platform;
    const pv = hints && hints.platformVersion;
    if (platform === "Windows") {
      // platformVersion major >= 13 means Windows 11 (Microsoft's documented mapping).
      const m = parseInt(major(pv), 10);
      os = !isNaN(m) && m > 0 ? (m >= 13 ? "Windows 11" : "Windows 10") : "Windows";
    } else if (platform === "macOS") {
      os = pv ? `macOS ${String(pv).split(".").slice(0, 2).join(".")}` : "macOS";
    } else if (platform === "Chrome OS" || platform === "ChromeOS") {
      os = "ChromeOS";
    } else if (platform === "Android") {
      os = pv ? `Android ${major(pv)}` : "Android";
    } else if (platform === "Linux") {
      os = "Linux";
    } else if (/Android/.test(ua)) os = "Android";
    else if (/iPhone|iPad|iOS/.test(ua)) os = "iOS";
    else if (/Windows NT 10/.test(ua)) os = "Windows 10/11";
    else if (/Windows/.test(ua)) os = "Windows";
    else if (/CrOS/.test(ua)) os = "ChromeOS";
    else if (/Mac OS X/.test(ua)) os = "macOS";
    else if (/Linux/.test(ua)) os = "Linux";

    return { browser, os };
  }

  // env: { screenWidth, screenHeight, viewportWidth, viewportHeight, devicePixelRatio }
  function formatScreenInfo(env) {
    if (!env || !env.screenWidth || !env.screenHeight) return "Unknown";
    let out = `${env.screenWidth}x${env.screenHeight}`;
    if (env.viewportWidth && env.viewportHeight) {
      out += ` (viewport: ${env.viewportWidth}x${env.viewportHeight})`;
    }
    if (env.devicePixelRatio && env.devicePixelRatio !== 1) {
      out += ` @${Math.round(env.devicePixelRatio * 100) / 100}x`;
    }
    return out;
  }

  // ── Screenshots section ─────────────────────────────────────────────────────
  // The ticket text stays plain Markdown. Images travel separately (clipboard
  // image, attachments), so the section just says what is attached.
  // Body runs up to (not including) the blank line(s) before the next heading.
  const SCREENSHOTS_SECTION_RE = /(^|\n)##\s*Screenshots[^\n]*(?:\n[\s\S]*?)?(?=\n+##\s|\s*$)/i;

  function screenshotsSectionBody(count) {
    if (!count) return "None attached";
    return Array.from({ length: count }, (_, i) => `- Screenshot ${i + 1} (attached)`).join("\n");
  }

  function applyScreenshotsSection(text, count) {
    const body = screenshotsSectionBody(count);
    const section = `## Screenshots\n${body}`;
    if (SCREENSHOTS_SECTION_RE.test(text)) {
      return text.replace(SCREENSHOTS_SECTION_RE, (m, lead) => `${lead}${section}`);
    }
    return `${text.trim()}\n\n${section}`;
  }

  // Older versions embedded base64 <img> tags in the ticket. Remove them before
  // the text is shown, copied or sent back to the model.
  function stripEmbeddedImages(text) {
    if (!text) return text;
    return text
      .replace(/<img\b[^>]*src=["']data:[^"']*["'][^>]*>\s*/gi, "")
      .replace(/\n{3,}/g, "\n\n");
  }

  // ── Provider responses ──────────────────────────────────────────────────────
  // Each returns { text, truncated, tokenUsage } or throws with a readable reason.
  function extractGeminiResponse(data) {
    const candidate = data && data.candidates && data.candidates[0];
    if (!candidate) {
      const reason = data && data.promptFeedback && data.promptFeedback.blockReason;
      throw new Error(reason ? `Request blocked by Gemini (${reason})` : "Empty response from AI");
    }
    const parts = (candidate.content && candidate.content.parts) || [];
    const text = parts
      .filter((p) => typeof p.text === "string" && !p.thought)
      .map((p) => p.text)
      .join("")
      .trim();
    const finish = candidate.finishReason;
    if (!text) {
      if (finish === "MAX_TOKENS") throw new Error("The model ran out of output tokens before writing the ticket. Try again or switch model.");
      if (finish && finish !== "STOP") throw new Error(`Gemini returned no text (${finish})`);
      throw new Error("Empty response from AI");
    }
    const u = data.usageMetadata;
    return {
      text,
      truncated: finish === "MAX_TOKENS",
      tokenUsage: u ? {
        input: u.promptTokenCount || 0,
        output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
        total: u.totalTokenCount || 0,
      } : null,
    };
  }

  function extractOpenAIResponse(data) {
    const choice = data && data.choices && data.choices[0];
    const msg = choice && choice.message;
    if (msg && msg.refusal) throw new Error(`The model declined: ${msg.refusal}`);
    const text = ((msg && msg.content) || "").trim();
    if (!text) {
      if (choice && choice.finish_reason === "length") throw new Error("The model ran out of output tokens before writing the ticket. Try again or switch model.");
      throw new Error("Empty response from AI");
    }
    const u = data.usage;
    return {
      text,
      truncated: choice.finish_reason === "length",
      tokenUsage: u ? {
        input: u.prompt_tokens || 0,
        output: u.completion_tokens || 0,
        total: u.total_tokens || 0,
      } : null,
    };
  }

  function extractAnthropicResponse(data) {
    if (data && data.stop_reason === "refusal") {
      const cat = data.stop_details && data.stop_details.category;
      throw new Error(`The model declined this request${cat ? ` (${cat})` : ""}.`);
    }
    // Current models return thinking blocks before the answer — never assume content[0].
    const text = ((data && data.content) || [])
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) {
      if (data && data.stop_reason === "max_tokens") throw new Error("The model ran out of output tokens before writing the ticket. Try again or switch model.");
      throw new Error("Empty response from AI");
    }
    const u = data.usage;
    return {
      text,
      truncated: data.stop_reason === "max_tokens",
      tokenUsage: u ? {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        total: (u.input_tokens || 0) + (u.output_tokens || 0),
      } : null,
    };
  }

  // ── Provider requests ───────────────────────────────────────────────────────
  // Builds { url, headers, body } for one call. `screenshots` are data URLs of any
  // image type. maxTokens defaults high enough to leave room for model thinking.
  const DEFAULT_MAX_TOKENS = 16000;

  function buildProviderRequest(provider, { model, apiKey, systemPrompt, userPrompt, screenshots = [], imageLabels = [], maxTokens = DEFAULT_MAX_TOKENS, jsonMode = false }) {
    const images = screenshots.map(parseDataUrl);
    // Each image is preceded by a text label so the model can tell screenshots
    // from recording frames, and refer to them by name.
    const label = (i) => imageLabels[i] || `Screenshot ${i + 1}`;

    if (provider === "gemini") {
      const parts = [];
      images.forEach((img, i) => {
        parts.push({ text: `--- ${label(i)} ---` });
        parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } });
      });
      parts.push({ text: userPrompt });
      const generationConfig = { temperature: 0.2, maxOutputTokens: Math.min(maxTokens, 8192) };
      // 2.5 models think by default and the thinking shares the output budget —
      // cap it so the ticket itself is never squeezed out.
      if (/^gemini-2\.5/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 1024 };
      if (jsonMode) generationConfig.responseMimeType = "application/json";
      const body = { contents: [{ role: "user", parts }], generationConfig };
      if (systemPrompt) body.system_instruction = { parts: [{ text: systemPrompt }] };
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body,
      };
    }

    if (provider === "openai" || provider === "xai") {
      const userContent = [];
      images.forEach((img, i) => {
        userContent.push({ type: "text", text: `${label(i)}:` });
        userContent.push({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.data}`, detail: "high" } });
      });
      userContent.push({ type: "text", text: userPrompt });
      const messages = [];
      if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
      messages.push({ role: "user", content: images.length ? userContent : userPrompt });

      const body = { model, messages };
      if (jsonMode) body.response_format = { type: "json_object" };
      if (provider === "openai") {
        // GPT-5-family models reject max_tokens and non-default temperature.
        body.max_completion_tokens = maxTokens;
      } else {
        body.max_tokens = maxTokens;
        body.temperature = 0.2;
      }
      return {
        url: provider === "openai" ? "https://api.openai.com/v1/chat/completions" : "https://api.x.ai/v1/chat/completions",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body,
      };
    }

    if (provider === "anthropic") {
      const content = [];
      images.forEach((img, i) => {
        content.push({ type: "text", text: `${label(i)}:` });
        content.push({ type: "image", source: { type: "base64", media_type: img.mimeType, data: img.data } });
      });
      content.push({ type: "text", text: userPrompt });
      const headers = {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      };
      const body = { model, max_tokens: maxTokens, messages: [{ role: "user", content }] };
      if (systemPrompt) body.system = systemPrompt;
      if (model === DEFAULT_MODELS.anthropic) {
        // Route declined requests to a fallback model instead of failing outright.
        headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
        body.fallbacks = "default";
      }
      return { url: "https://api.anthropic.com/v1/messages", headers, body };
    }

    throw new Error(`Unknown AI provider: ${provider}`);
  }

  function extractProviderResponse(provider, data) {
    if (provider === "gemini") return extractGeminiResponse(data);
    if (provider === "anthropic") return extractAnthropicResponse(data);
    if (provider === "openai" || provider === "xai") return extractOpenAIResponse(data);
    throw new Error(`Unknown AI provider: ${provider}`);
  }

  function formatApiError(provider, model, status, body) {
    const detail = (body && body.error && (body.error.message || body.error)) ||
      (body && body.message) || `HTTP ${status}`;
    const msg = typeof detail === "string" ? detail : JSON.stringify(detail);
    return `${providerLabel(provider)} (${model}): ${msg}`;
  }

  // ── Media sampling ──────────────────────────────────────────────────────────
  // Evenly spaced positions in [0, 1) at the middle of each of `count` slices —
  // e.g. 3 → 1/6, 1/2, 5/6 — so samples skip the (often blank) first and last
  // moments of a recording.
  function sampleFractions(count) {
    const n = Math.max(0, Math.floor(count));
    return Array.from({ length: n }, (_, i) => (i + 0.5) / n);
  }

  // Frame indices to sample from a GIF with `total` frames (unique, ascending).
  function sampleFrameIndices(total, count) {
    if (!(total > 0)) return [];
    const picks = sampleFractions(Math.min(count, total)).map((f) => Math.min(total - 1, Math.floor(f * total)));
    return [...new Set(picks)];
  }

  // Timestamps (seconds) to sample from a video. Unknown/zero duration → the start.
  function sampleTimes(duration, count) {
    if (!Number.isFinite(duration) || duration <= 0) return count > 0 ? [0] : [];
    return sampleFractions(count).map((f) => Math.round(f * duration * 10) / 10);
  }

  // Screenshots come first (they are what the reporter chose); recording frames
  // fill the remaining slots up to `max`. Returns { images, labels }.
  function combineReferenceImages({ screenshots = [], gifFrames = [], videoFrames = [], max = 10 } = {}) {
    const items = [
      ...screenshots.map((src, i) => ({ src, label: `Screenshot ${i + 1}` })),
      ...gifFrames.map((f, i) => ({ src: f.src, label: `GIF recording frame ${i + 1} of ${gifFrames.length} (at ${f.time}s)` })),
      ...videoFrames.map((f, i) => ({ src: f.src, label: `Screen recording frame ${i + 1} of ${videoFrames.length} (at ${f.time}s)` })),
    ].slice(0, Math.max(0, max));
    return { images: items.map((x) => x.src), labels: items.map((x) => x.label) };
  }

  // ── Generation state ────────────────────────────────────────────────────────
  // A generation is "lost" when it is marked in progress but this service worker
  // no longer holds its AbortController (Chrome restarted the worker mid-request),
  // or when it has run far longer than any request timeout allows.
  const GENERATION_MAX_AGE_MS = 4 * 60 * 1000;

  function isGenerationLost(state, { hasController, now, maxAgeMs = GENERATION_MAX_AGE_MS } = {}) {
    if (!state || !state.isGenerating) return false;
    if (!hasController) return true;
    return !!state.startTime && now - state.startTime > maxAgeMs;
  }

  // ── Markdown → HTML for rich paste ──────────────────────────────────────────
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function markdownToHtml(md) {
    const inline = (s) => escapeHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

    const html = [];
    let listType = null;
    const closeList = () => {
      if (listType) { html.push(`</${listType}>`); listType = null; }
    };
    const openList = (type) => {
      if (listType !== type) { closeList(); html.push(`<${type}>`); listType = type; }
    };

    for (const rawLine of String(md || "").split("\n")) {
      const line = rawLine.trimEnd();
      const heading = line.match(/^(#{1,4})\s+(.+)$/);
      const checkbox = line.match(/^[-*]\s+\[([ xX])\]\s*(.*)$/);
      const bullet = line.match(/^[-*]\s+(.+)$/);
      const numbered = line.match(/^\d+[.)]\s+(.+)$/);

      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
        closeList();
        html.push("<hr>");
      } else if (heading) {
        closeList();
        const level = Math.max(heading[1].length, 2); // "#" and "##" → h2, so sections sit under the tracker's own title
        html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      } else if (checkbox) {
        openList("ul");
        html.push(`<li>${checkbox[1] === " " ? "☐" : "☑"} ${inline(checkbox[2])}</li>`);
      } else if (bullet) {
        openList("ul");
        html.push(`<li>${inline(bullet[1])}</li>`);
      } else if (numbered) {
        openList("ol");
        html.push(`<li>${inline(numbered[1])}</li>`);
      } else if (line.trim() === "") {
        closeList();
        html.push("<br>");
      } else {
        closeList();
        html.push(`<p>${inline(line)}</p>`);
      }
    }
    closeList();
    return html.join("\n");
  }

  // ── Batch: issue splitting ──────────────────────────────────────────────────
  const MAX_BATCH_ISSUES = 15;

  // Parses the model's JSON list of issues. Accepts {"issues":[…]} or a bare array,
  // tolerates code fences / prose around the JSON, and normalises every field.
  // duplicateOf is a 1-based index of an EARLIER issue, else null.
  function parseIssueList(text) {
    if (typeof text !== "string" || !text.trim()) throw new Error("The AI returned no issues");
    let raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      const start = raw.search(/[\[{]/);
      const end = Math.max(raw.lastIndexOf("]"), raw.lastIndexOf("}"));
      if (start < 0 || end <= start) throw new Error("The AI reply wasn't a list of issues. Try again.");
      try { data = JSON.parse(raw.slice(start, end + 1)); }
      catch (e2) { throw new Error("The AI reply wasn't a list of issues. Try again."); }
    }
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.issues) ? data.issues : null);
    if (!list) throw new Error("The AI reply wasn't a list of issues. Try again.");

    const issues = [];
    for (const item of list) {
      if (issues.length >= MAX_BATCH_ISSUES) break;
      if (!item || typeof item !== "object") continue;
      const title = String(item.title || item.summary || "").replace(/\s+/g, " ").trim();
      const details = String(item.details || item.description || "").trim();
      if (!title && !details) continue;
      const idx = issues.length + 1;
      const dup = Number(item.duplicateOf);
      issues.push({
        title: title || details.split("\n")[0].slice(0, 120),
        details,
        duplicateOf: Number.isInteger(dup) && dup >= 1 && dup < idx ? dup : null,
      });
    }
    if (!issues.length) throw new Error("The AI found no issues in that text");
    return issues;
  }

  // Bullet lines ("- ", "* ", "• ") in a description. Numbered lines are ignored on
  // purpose: a single bug's steps to reproduce are usually numbered.
  const BULLET_RE = /^\s*[-*•]\s+\S/;
  function countBulletItems(text) {
    return String(text || "").split(/\r?\n/).filter((l) => BULLET_RE.test(l)).length;
  }

  // True when a description reads like a list of separate issues, so the popup
  // can offer the batch flow instead of merging them into one ticket.
  function looksLikeIssueList(text, min = 3) {
    return countBulletItems(text) >= min;
  }

  // The reporter note handed to ticket generation for one batch issue.
  function issueToNote(issue) {
    const title = (issue && issue.title || "").trim();
    const details = (issue && issue.details || "").trim();
    if (!details || details === title) return title;
    return `${title}\n\n${details}`;
  }

  // Rough pre-flight token estimate so a big batch doesn't surprise anyone.
  // Defaults are deliberately conservative averages, not provider-exact.
  function estimateBatchTokens(issues, { baseTokens = 1800, imageTokens = 1500, outputTokens = 700 } = {}) {
    return (issues || []).reduce((sum, it) =>
      sum + baseTokens + outputTokens + imageTokens * ((it && it.imageCount) || 0), 0);
  }

  // ── Ticket text helpers ─────────────────────────────────────────────────────
  // One-line title of a ticket: the first line under "## Summary", else the
  // first non-heading line. Markdown marks removed; capped at Jira's 255 chars.
  function extractSummary(ticket) {
    const text = String(ticket || "");
    const m = text.match(/(?:^|\n)#{1,4}\s*Summary[^\n]*\n+([^\n]+)/i);
    let line = m ? m[1] : (text.split("\n").find((l) => l.trim() && !/^#{1,6}\s/.test(l.trim())) || "");
    line = line.replace(/^[-*]\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").trim();
    return line.length > 255 ? line.slice(0, 252) + "..." : line;
  }

  function joinTickets(tickets) {
    return (tickets || []).map((t) => String(t).trim()).filter(Boolean).join("\n\n---\n\n");
  }

  // RFC 4180 CSV. `columns` = [{ key, header }]. Cells that a spreadsheet would run
  // as a formula (=, +, @) get a leading apostrophe.
  function toCsv(rows, columns) {
    const cell = (v) => {
      let s = v == null ? "" : String(v);
      if (/^[=+@]/.test(s)) s = "'" + s;
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [columns.map((c) => cell(c.header)).join(",")];
    for (const row of rows || []) lines.push(columns.map((c) => cell(row[c.key])).join(","));
    return lines.join("\r\n");
  }

  // ── History ─────────────────────────────────────────────────────────────────
  const HISTORY_MAX_ENTRIES = 200;
  const HISTORY_DEFAULT_RETENTION_DAYS = 90;
  const DAY_MS = 24 * 60 * 60 * 1000;

  function hostnameOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
  }

  // Newest first, drop entries past the retention window, cap the count.
  function pruneHistory(entries, { now, retentionDays = HISTORY_DEFAULT_RETENTION_DAYS, maxEntries = HISTORY_MAX_ENTRIES } = {}) {
    const cutoff = retentionDays > 0 ? now - retentionDays * DAY_MS : -Infinity;
    return (entries || [])
      .filter((e) => e && e.createdAt >= cutoff)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, maxEntries);
  }

  function makeHistoryEntry(fields, { now, id } = {}) {
    const f = fields || {};
    const ticket = String(f.ticket || "");
    return {
      id: id || `h${now}${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
      source: f.source === "batch" ? "batch" : "single",
      summary: extractSummary(ticket),
      ticket,
      note: String(f.note || ""),
      pageUrl: String(f.pageUrl || ""),
      pageTitle: String(f.pageTitle || ""),
      site: hostnameOf(f.pageUrl),
      severity: String(f.severity || ""),
      component: String(f.component || ""),
      provider: String(f.provider || ""),
      model: String(f.model || ""),
      tokens: (f.tokenUsage && f.tokenUsage.total) || 0,
      screenshotCount: f.screenshotCount || 0,
      hasVideo: !!f.hasVideo,
      hasGif: !!f.hasGif,
      thumbnail: typeof f.thumbnail === "string" && f.thumbnail.startsWith("data:image/") ? f.thumbnail : "",
      copiedAt: null,
      copyCount: 0,
    };
  }

  function filterHistory(entries, query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return entries || [];
    return (entries || []).filter((e) =>
      [e.summary, e.ticket, e.site, e.component, e.severity, e.pageTitle]
        .some((v) => String(v || "").toLowerCase().includes(q)));
  }

  // Aggregates for the Insights page. Day buckets use local midnight.
  function computeInsights(entries, { now, days = 14 } = {}) {
    const list = entries || [];
    const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const today = startOfDay(now);
    const count = (keyFn) => {
      const m = new Map();
      for (const e of list) { const k = keyFn(e); if (k) m.set(k, (m.get(k) || 0) + 1); }
      return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
    };
    const perDay = Array.from({ length: days }, (_, i) => {
      const d = new Date(today); d.setDate(d.getDate() - (days - 1 - i));
      return { day: d.getTime(), count: 0 };
    });
    const firstDay = perDay[0].day;
    for (const e of list) {
      const day = startOfDay(e.createdAt);
      if (day < firstDay) continue;
      const slot = perDay.find((p) => p.day === day);
      if (slot) slot.count++;
    }
    const copied = list.filter((e) => e.copiedAt).length;
    return {
      generated: list.length,
      copied,
      copyRate: list.length ? copied / list.length : 0,
      last7Days: list.filter((e) => e.createdAt >= today - 6 * DAY_MS).length,
      tokens: list.reduce((s, e) => s + (e.tokens || 0), 0),
      batch: list.filter((e) => e.source === "batch").length,
      bySite: count((e) => e.site),
      bySeverity: count((e) => e.severity),
      byComponent: count((e) => e.component),
      perDay,
    };
  }

  const api = {
    DEFAULT_MODELS,
    GENERATION_MAX_AGE_MS,
    resolveModel,
    providerLabel,
    parseDataUrl,
    parseBrowserInfo,
    formatScreenInfo,
    applyScreenshotsSection,
    stripEmbeddedImages,
    extractGeminiResponse,
    extractOpenAIResponse,
    extractAnthropicResponse,
    buildProviderRequest,
    extractProviderResponse,
    formatApiError,
    isGenerationLost,
    sampleFractions,
    sampleFrameIndices,
    sampleTimes,
    combineReferenceImages,
    escapeHtml,
    markdownToHtml,
    MAX_BATCH_ISSUES,
    parseIssueList,
    countBulletItems,
    looksLikeIssueList,
    issueToNote,
    estimateBatchTokens,
    extractSummary,
    joinTickets,
    toCsv,
    HISTORY_MAX_ENTRIES,
    HISTORY_DEFAULT_RETENTION_DAYS,
    hostnameOf,
    pruneHistory,
    makeHistoryEntry,
    filterHistory,
    computeInsights,
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TicketUtils = api;
})(typeof self !== "undefined" ? self : globalThis);
