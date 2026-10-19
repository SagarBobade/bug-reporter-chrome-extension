// background.js — BugReporter service worker

// ── Installation Handler: Auto-apply default settings ────────────────────────
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    console.log('BugReporter: First installation detected, loading default settings...');
    await initializeDefaultSettings();
  }
});

async function initializeDefaultSettings() {
  try {
    // Check if settings already exist (shouldn't on first install, but safety check)
    const existing = await new Promise(resolve => {
      chrome.storage.local.get('bugReporterSettings', result => resolve(result.bugReporterSettings));
    });

    // If settings already exist, don't overwrite
    if (existing && Object.keys(existing).length > 0) {
      console.log('BugReporter: Settings already exist, skipping default initialization');
      return;
    }

    // Fetch default settings from setting-data.json
    const url = chrome.runtime.getURL('setting-data.json');
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch setting-data.json: ${response.status}`);
    }

    const defaultSettings = await response.json();

    // Remove exportedAt and version fields (not needed in storage)
    delete defaultSettings.exportedAt;
    delete defaultSettings.version;

    // Ensure API keys are empty (security - users must add their own)
    defaultSettings.geminiApiKey = '';
    defaultSettings.openaiApiKey = '';
    defaultSettings.anthropicApiKey = '';
    defaultSettings.xaiApiKey = '';

    // Save to storage
    await new Promise(resolve => {
      chrome.storage.local.set({ bugReporterSettings: defaultSettings }, resolve);
    });

    console.log('BugReporter: Default settings applied successfully');
    console.log('BugReporter: User needs to add API key in settings');

  } catch (error) {
    console.error('BugReporter: Failed to load default settings:', error);
    console.log('BugReporter: Extension will work with empty settings');
    // Extension continues to work normally even if defaults fail to load
  }
}

// ── Generation State Storage Key ─────────────────────────────────────────────
const GENERATION_STATE_KEY = "bugReporterGenerationState";
const USAGE_STATS_KEY = "bugReporterUsageStats";

// ── Session usage tracking ────────────────────────────────────────────────────
// countTicket=false adds the tokens without counting a ticket (e.g. note refinement).
async function recordUsage(tokenUsage, { countTicket = true } = {}) {
  if (!tokenUsage?.total) return;
  return new Promise((resolve) => {
    chrome.storage.local.get(USAGE_STATS_KEY, (r) => {
      const stats = r[USAGE_STATS_KEY] || { totalTokens: 0, ticketCount: 0 };
      stats.totalTokens += tokenUsage.total;
      if (countTicket) stats.ticketCount += 1;
      chrome.storage.local.set({ [USAGE_STATS_KEY]: stats }, resolve);
    });
  });
}

async function getUsageStats() {
  return new Promise((resolve) => {
    chrome.storage.local.get(USAGE_STATS_KEY, (r) => resolve(r[USAGE_STATS_KEY] || { totalTokens: 0, ticketCount: 0 }));
  });
}

// ── Storage helpers ───────────────────────────────────────────────────────────
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get("bugReporterSettings", (r) => resolve(r.bugReporterSettings || {}));
  });
}

async function getApiKeyForProvider(provider) {
  const settings = await getSettings();
  const keyMap = {
    gemini: settings.geminiApiKey,
    openai: settings.openaiApiKey,
    anthropic: settings.anthropicApiKey,
    xai: settings.xaiApiKey
  };
  const key = keyMap[provider];
  if (!key) throw new Error(`NO_API_KEY for ${provider}`);
  return key;
}

async function getCurrentProviderAndKey() {
  const settings = await getSettings();
  const provider = settings.aiProvider || "gemini";
  const key = await getApiKeyForProvider(provider);
  return { provider, key, settings };
}

// ── Generation State Management ───────────────────────────────────────────────
async function setGenerationState(state) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [GENERATION_STATE_KEY]: state }, resolve);
  });
}

async function getGenerationState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(GENERATION_STATE_KEY, (r) => resolve(r[GENERATION_STATE_KEY] || null));
  });
}

async function clearGenerationState() {
  return new Promise((resolve) => {
    chrome.storage.local.remove(GENERATION_STATE_KEY, resolve);
  });
}

// ── Section templates ─────────────────────────────────────────────────────────
const SECTION_TEMPLATES = {
  summary:     (ctx) => `## Summary\n[${ctx.summaryFormat || "Component/Page – what's broken, when it happens. One line, no filler ('There is an issue where...'), name the exact UI element."}]`,
  environment: (ctx) => `## Environment
- **Browser:** ${ctx.browserInfo || "Chrome"}
- **OS:** ${ctx.osInfo || "Unknown"}
- **Screen:** ${ctx.screenInfo || "Unknown"}
- **Page:** ${ctx.pageTitle}
- **URL:** ${ctx.pageUrl}`,
  steps:       ()    => `## Steps to Reproduce\n1. [Starting state/page — assume browser is already open]\n2. [One user action, imperative mood: "Click...", "Enter...", "Navigate to..."]\n3. [Next single action — never combine two actions in one step]\n4. [Final action — the one that triggers the bug]`,
  expected:    ()    => `## Expected Behavior\n[One sentence, same subject as Actual Behavior so the two are directly comparable]`,
  actual:      ()    => `## Actual Behavior\n[One sentence, mirrors Expected Behavior's subject, reference the exact UI element visible in screenshots]`,
  impact:      ()    => `## Impact\n[Who is affected (all users / specific role / specific browser) and how — no severity label here, that belongs in Priority]`,
  priority:    ()    => `## Priority\n[P1/P2/P3/P4 — one-line reason grounded in the Impact above, not a restatement of the bug]`,
  acceptance:  ()    => `## Acceptance Criteria\n- [ ] \n- [ ] \n- [ ] `,
  logs:        ()    => `## Logs / Errors\n[Error messages or codes visible in screenshots, or "None visible"]`,
  screenshots: ()    => `## Screenshots\n[Attached above]`,
  workaround:  ()    => `## Workaround\n[Known workaround or "None"]`,
  context:     ()    => `## Additional Context\n[Any other relevant observations]`,
};

// ── Get browser/device info ──────────────────────────────────────────────────
function getBrowserInfo() {
  const ua = navigator.userAgent;
  let browser = "Unknown";
  let os = "Unknown";

  if (ua.includes("Chrome") && !ua.includes("Edg")) {
    const match = ua.match(/Chrome\/(\d+)/);
    browser = `Chrome ${match ? match[1] : ""}`;
  } else if (ua.includes("Edg")) {
    const match = ua.match(/Edg\/(\d+)/);
    browser = `Edge ${match ? match[1] : ""}`;
  } else if (ua.includes("Firefox")) {
    const match = ua.match(/Firefox\/(\d+)/);
    browser = `Firefox ${match ? match[1] : ""}`;
  } else if (ua.includes("Safari") && !ua.includes("Chrome")) {
    const match = ua.match(/Version\/(\d+)/);
    browser = `Safari ${match ? match[1] : ""}`;
  }

  if (ua.includes("Windows NT 10")) os = "Windows 10/11";
  else if (ua.includes("Windows")) os = "Windows";
  else if (ua.includes("Mac OS X")) {
    const match = ua.match(/Mac OS X (\d+[._]\d+)/);
    os = `macOS ${match ? match[1].replace("_", ".") : ""}`;
  } else if (ua.includes("Linux")) os = "Linux";
  else if (ua.includes("Android")) os = "Android";
  else if (ua.includes("iOS") || ua.includes("iPhone") || ua.includes("iPad")) os = "iOS";

  return { browser, os };
}

// ── Build prompt ──────────────────────────────────────────────────────────────
function buildPrompt({ pageUrl, pageTitle, audioNote, settings, screenInfo, hasScreenshots = true }) {
  const {
    domainContext          = "",
    techStack              = "",
    summaryFormat          = "",
    summaryGuidelines      = "",
    descriptionGuidelines  = "",
    extraInstructions      = "",
    enabledSections        = ["summary","environment","steps","expected","actual","impact","priority","acceptance","context"],
    customSections         = [],
    useMarkdownFormatting  = true,
  } = settings;

  const { browser, os } = getBrowserInfo();

  const ctx = {
    pageUrl,
    pageTitle,
    summaryFormat,
    browserInfo: browser,
    osInfo: os,
    screenInfo: screenInfo || "Unknown"
  };

  const sectionBlocks = [
    ...enabledSections
      .filter(id => SECTION_TEMPLATES[id])
      .map(id => SECTION_TEMPLATES[id](ctx)),
    ...customSections.map(name => `## ${name}\n[${name} — be brief]`),
  ];

  const screenshotInstruction = hasScreenshots
    ? `\nAnalyze the screenshots carefully. No fenced code blocks (triple backticks) in output.`
    : `\nUse the provided notes/context to understand the bug. No fenced code blocks (triple backticks) in output.`;

  const systemPrompt = [
    `You are a senior QA engineer writing a bug report following standard bug-tracking conventions (Jira/Linear style). Be CONCISE and MINIMAL.`,
    `Each section should be 1-3 lines maximum unless more is truly needed.`,
    `No filler words ("There is an issue where...", "It seems that...", "The user is unable to..."), no padding, no repetition between sections — state each fact once, in the section it belongs to.`,
    `Steps to Reproduce: numbered, imperative mood ("Click", "Enter", "Navigate to" — never "The user clicks"), exactly one user action per step, starting from a known state, ending on the step that triggers the bug.`,
    `Summary and Actual Behavior must name the exact UI element (button, field, modal, label) visible in the screenshots — never a vague description like "something is broken".`,
    `Use consistent present tense throughout every section.`,
    useMarkdownFormatting
      ? "For exact values, use Markdown instead of quotation marks: `backticks` for exact strings, error codes, or field values; **bold** for UI element/button names. Never wrap them in double quotes."
      : "",
    domainContext ? `\nPRODUCT CONTEXT: ${domainContext}` : "",
    techStack     ? `TECH STACK: ${techStack}` : "",
    screenshotInstruction,
  ].filter(Boolean).join("\n");

  const rules = [];
  if (summaryGuidelines) rules.push(`SUMMARY GUIDELINES:\n${summaryGuidelines}`);
  if (descriptionGuidelines) rules.push(`DESCRIPTION GUIDELINES:\n${descriptionGuidelines}`);
  if (extraInstructions) rules.push(`EXTRA: ${extraInstructions}`);

  const userPrompt = [
    audioNote ? `REPORTER NOTES: "${audioNote}"\n` : "",
    rules.length ? `RULES:\n${rules.join("\n\n")}\n` : "",
    `Generate the bug report with ONLY these sections — no extras, no commentary:\n`,
    sectionBlocks.join("\n\n"),
    `\n\nKeep it short. Every word must earn its place.`,
  ].filter(Boolean).join("\n");

  return { systemPrompt, userPrompt };
}

// ══════════════════════════════════════════════════════════════════════════════
// AI Provider API Calls
// ══════════════════════════════════════════════════════════════════════════════

// ── Gemini API ────────────────────────────────────────────────────────────────
async function callGemini({ apiKey, systemPrompt, userPrompt, screenshots, signal }) {
  const contentParts = [{ text: systemPrompt }];

  if (screenshots && screenshots.length > 0) {
    screenshots.forEach((b64, i) => {
      contentParts.push({ text: `--- Screenshot ${i+1} ---` });
      contentParts.push({
        inline_data: { mime_type: "image/png", data: b64.replace(/^data:image\/png;base64,/, "") }
      });
    });
  }

  contentParts.push({ text: userPrompt });

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: contentParts }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
      }),
      signal
    }
  );

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err?.error?.message || `Gemini API error ${response.status}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  const tokenUsage = data?.usageMetadata ? {
    input: data.usageMetadata.promptTokenCount || 0,
    output: data.usageMetadata.candidatesTokenCount || 0,
    total: data.usageMetadata.totalTokenCount || 0
  } : null;
  return { text, tokenUsage };
}

// ── OpenAI API ────────────────────────────────────────────────────────────────
async function callOpenAI({ apiKey, systemPrompt, userPrompt, screenshots, signal }) {
  const messages = [
    { role: "system", content: systemPrompt }
  ];

  // Build user message with images
  const userContent = [];

  if (screenshots && screenshots.length > 0) {
    screenshots.forEach((b64, i) => {
      userContent.push({ type: "text", text: `Screenshot ${i+1}:` });
      userContent.push({
        type: "image_url",
        image_url: { url: b64, detail: "high" }
      });
    });
  }

  userContent.push({ type: "text", text: userPrompt });

  messages.push({ role: "user", content: userContent });

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: messages,
      max_tokens: 2048,
      temperature: 0.2
    }),
    signal
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err?.error?.message || `OpenAI API error ${response.status}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  const tokenUsage = data?.usage ? {
    input: data.usage.prompt_tokens || 0,
    output: data.usage.completion_tokens || 0,
    total: data.usage.total_tokens || 0
  } : null;
  return { text, tokenUsage };
}

// ── Anthropic API ─────────────────────────────────────────────────────────────
async function callAnthropic({ apiKey, systemPrompt, userPrompt, screenshots, signal }) {
  const content = [];

  if (screenshots && screenshots.length > 0) {
    screenshots.forEach((b64, i) => {
      content.push({ type: "text", text: `Screenshot ${i+1}:` });
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: b64.replace(/^data:image\/png;base64,/, "")
        }
      });
    });
  }

  content.push({ type: "text", text: userPrompt });

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: content }]
    }),
    signal
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err?.error?.message || `Anthropic API error ${response.status}`);
  }

  const data = await response.json();
  const text = data?.content?.[0]?.text;
  const tokenUsage = data?.usage ? {
    input: data.usage.input_tokens || 0,
    output: data.usage.output_tokens || 0,
    total: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0)
  } : null;
  return { text, tokenUsage };
}

// ── xAI Grok API ──────────────────────────────────────────────────────────────
async function callXAI({ apiKey, systemPrompt, userPrompt, screenshots, signal }) {
  const messages = [
    { role: "system", content: systemPrompt }
  ];

  // Build user message with images (xAI uses OpenAI-compatible format)
  const userContent = [];

  if (screenshots && screenshots.length > 0) {
    screenshots.forEach((b64, i) => {
      userContent.push({ type: "text", text: `Screenshot ${i+1}:` });
      userContent.push({
        type: "image_url",
        image_url: { url: b64, detail: "high" }
      });
    });
  }

  userContent.push({ type: "text", text: userPrompt });

  messages.push({ role: "user", content: userContent });

  const response = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "grok-2-vision-1212",
      messages: messages,
      max_tokens: 2048,
      temperature: 0.2
    }),
    signal
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err?.error?.message || `xAI API error ${response.status}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  const tokenUsage = data?.usage ? {
    input: data.usage.prompt_tokens || 0,
    output: data.usage.completion_tokens || 0,
    total: data.usage.total_tokens || 0
  } : null;
  return { text, tokenUsage };
}

// ── Universal AI Call ─────────────────────────────────────────────────────────
async function callAI({ provider, apiKey, systemPrompt, userPrompt, screenshots, signal }) {
  const providers = {
    gemini: callGemini,
    openai: callOpenAI,
    anthropic: callAnthropic,
    xai: callXAI
  };

  const callFn = providers[provider];
  if (!callFn) throw new Error(`Unknown AI provider: ${provider}`);

  return await callFn({ apiKey, systemPrompt, userPrompt, screenshots, signal });
}

// ── Generation cancellation ───────────────────────────────────────────────────
const activeGenerationControllers = new Map(); // generationId -> AbortController

function cancelGeneration(generationId) {
  const controller = activeGenerationControllers.get(generationId);
  if (controller) {
    controller.abort();
    activeGenerationControllers.delete(generationId);
    return true;
  }
  return false;
}

// ── Generate Ticket ───────────────────────────────────────────────────────────
async function generateTicket({ screenshots, audioNote, pageUrl, pageTitle, screenInfo, signal }) {
  const { provider, key, settings } = await getCurrentProviderAndKey();

  const hasScreenshots = screenshots && screenshots.length > 0;
  const { systemPrompt, userPrompt } = buildPrompt({ pageUrl, pageTitle, audioNote, settings, screenInfo, hasScreenshots });

  let result = await callAI({
    provider,
    apiKey: key,
    systemPrompt,
    userPrompt,
    screenshots: hasScreenshots ? screenshots : [],
    signal
  });

  let text = result?.text || result; // Handle both new {text, tokenUsage} and legacy string format
  const tokenUsage = result?.tokenUsage || null;

  if (!text) throw new Error("Empty response from AI");

  // Check if screenshots section is enabled and we have screenshots
  const enabledSections = settings.enabledSections || [];
  if (enabledSections.includes("screenshots") && hasScreenshots) {
    const screenshotSection = screenshots.map((dataUrl, i) =>
      `<img src="${dataUrl}" alt="Screenshot ${i + 1}" width="600" />`
    ).join("\n");

    if (/## Screenshots/i.test(text)) {
      text = text.replace(/## Screenshots\n\[.*?\]/i, `## Screenshots\n${screenshotSection}`);
    } else {
      text = text.trim() + `\n\n## Screenshots\n${screenshotSection}`;
    }
  }

  return { text, tokenUsage };
}

// ── Screenshot capture ────────────────────────────────────────────────────────
async function captureScreenshot() {
  const dataUrl = await chrome.tabs.captureVisibleTab(null, {
    format: "png",
    quality: 100,
  });
  return dataUrl;
}

// ── GIF Recording (tab capture via offscreen document) ───────────────────────
// Records the current tab directly (no screen-picker, no dedicated tab) by
// handing a tabCapture stream id to a persistent offscreen document — the
// popup closes as soon as recording starts so the user can interact with the
// page, and the offscreen document keeps encoding after the popup is gone.
//
// chrome.storage is unreliable to call directly from inside the offscreen
// document itself (observed missing entirely, persistently, even on a freshly
// created document) — so all storage for the GIF flow happens here in the
// service worker instead, via the SAVE_GIF_STATE message the offscreen
// document sends whenever it needs to persist state.
const GIF_RECORDING_KEY = "bugReporterGifRecording";

async function ensureOffscreenDocument() {
  const hasDoc = await chrome.offscreen.hasDocument();
  if (hasDoc) {
    try { await chrome.offscreen.closeDocument(); } catch (e) { /* already gone */ }
  }
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL("offscreen.html"),
    reasons: ["USER_MEDIA"],
    justification: "Capture the current tab's frames to build an animated GIF for the bug report."
  });
}

// Wraps sendMessage in a Promise that resolves the response (or rejects on failure)
// instead of firing blind — an unanswered fire-and-forget message is how a dead
// offscreen document's failure turns into a silent no-op instead of a visible error.
function sendMessageToOffscreen(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!res || !res.ok) {
        reject(new Error(res?.error || "GIF recorder did not start"));
        return;
      }
      resolve(res);
    });
  });
}

async function startGifRecording(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab || !tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) {
    throw new Error("Cannot record on this page. Navigate to a regular website first.");
  }

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreenDocument();
  await sendMessageToOffscreen({ type: "OFFSCREEN_START_GIF", streamId, tabId });

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["gif-recording-controls.js"]
    });
  } catch (e) {
    console.warn("Could not inject GIF recording controls:", e);
  }
}

// ── Test API Key ──────────────────────────────────────────────────────────────
async function testApiKey(provider, apiKey) {
  const testPrompt = "Hello";

  switch (provider) {
    case "gemini":
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: testPrompt }] }],
            generationConfig: { maxOutputTokens: 10 }
          })
        }
      );
      if (!geminiRes.ok) {
        const err = await geminiRes.json();
        throw new Error(err?.error?.message || `API error ${geminiRes.status}`);
      }
      return true;

    case "openai":
      const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: testPrompt }],
          max_tokens: 10
        })
      });
      if (!openaiRes.ok) {
        const err = await openaiRes.json();
        throw new Error(err?.error?.message || `API error ${openaiRes.status}`);
      }
      return true;

    case "anthropic":
      const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 10,
          messages: [{ role: "user", content: testPrompt }]
        })
      });
      if (!anthropicRes.ok) {
        const err = await anthropicRes.json();
        throw new Error(err?.error?.message || `API error ${anthropicRes.status}`);
      }
      return true;

    case "xai":
      const xaiRes = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "grok-2-vision-1212",
          messages: [{ role: "user", content: testPrompt }],
          max_tokens: 10
        })
      });
      if (!xaiRes.ok) {
        const err = await xaiRes.json();
        throw new Error(err?.error?.message || `API error ${xaiRes.status}`);
      }
      return true;

    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// ── Improve Ticket via Chat ───────────────────────────────────────────────────
async function improveTicket({ currentTicket, feedback, chatHistory, screenshots }) {
  const { provider, key } = await getCurrentProviderAndKey();

  const historyContext = chatHistory
    .map(msg => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`)
    .join("\n");

  const systemPrompt = `You are a QA engineer helping to improve a bug report ticket based on user feedback.
You will receive the current ticket and user's feedback. Make the requested changes while keeping the same format and structure.
Be concise. Only change what the user asks for. Return ONLY the improved ticket text, no explanations.`;

  const userPrompt = `CURRENT TICKET:
${currentTicket}

${historyContext ? `PREVIOUS FEEDBACK:\n${historyContext}\n` : ""}
NEW FEEDBACK:
${feedback}

Please improve the ticket based on this feedback. Return only the updated ticket.`;

  const result = await callAI({
    provider,
    apiKey: key,
    systemPrompt,
    userPrompt,
    screenshots: screenshots || []
  });

  const text = result?.text || result;
  if (!text) throw new Error("Empty response from AI");
  return text;
}

// ── Refine reporter note ──────────────────────────────────────────────────────
// Cleans up the raw description (typed or dictated) before ticket generation so the
// reporter can review it. Text only — screenshots would make it slower and costlier.
async function refineNote({ note }) {
  const { provider, key, settings } = await getCurrentProviderAndKey();
  const { domainContext = "", techStack = "" } = settings;

  const systemPrompt = [
    `You clean up a reporter's rough bug notes (often voice-dictated) before they are turned into a bug ticket.`,
    `Fix grammar, punctuation and obvious speech-to-text mistakes (use the product context to correct misheard product terms).`,
    `Organise the content into short plain-text lines in this order, only including parts the notes actually cover: what happened, steps taken, what was expected.`,
    `Keep EVERY fact, value, name and number from the notes. Never invent details, steps or causes. Do not add headings, Markdown or commentary.`,
    `Keep it about as long as the original or shorter. Return ONLY the refined notes.`,
    domainContext ? `\nPRODUCT CONTEXT: ${domainContext}` : "",
    techStack     ? `TECH STACK: ${techStack}` : "",
  ].filter(Boolean).join("\n");

  const result = await callAI({
    provider,
    apiKey: key,
    systemPrompt,
    userPrompt: `REPORTER NOTES:\n${note}`,
    screenshots: []
  });

  const text = (result?.text || "").trim();
  if (!text) throw new Error("Empty response from AI");
  await recordUsage(result.tokenUsage, { countTicket: false });
  return text;
}

// ── Keyboard shortcuts (manifest "commands") ─────────────────────────────────
// Shortcuts usually fire while the popup is closed, so results are written straight
// into the popup's persisted session (picked up on next open). If the popup *is*
// open, it owns the session in memory — hand the result to it instead, otherwise its
// next saveSession() would overwrite what we wrote. The toolbar badge gives feedback.
const SESSION_KEY = "bugReporterSession";
const MAX_SCREENSHOTS = 6;

function isRestrictedUrl(url) {
  return !url || url.startsWith("chrome://") || url.startsWith("chrome-extension://");
}

async function isPopupOpen() {
  if (!chrome.runtime.getContexts) return false;
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["POPUP"] });
    return contexts.length > 0;
  } catch (e) {
    return false;
  }
}

async function getSession() {
  const r = await chrome.storage.local.get(SESSION_KEY);
  return r[SESSION_KEY] || { screenshots: [], note: "", component: "", severity: "Medium" };
}

async function flashBadge(text, color, ms = 1500) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  setTimeout(async () => {
    // Don't wipe the persistent mic "REC" badge if recording started meanwhile
    const current = await chrome.action.getBadgeText({});
    if (current === text) chrome.action.setBadgeText({ text: "" });
  }, ms);
}

async function shortcutCaptureScreenshot(tab) {
  if (isRestrictedUrl(tab?.url)) {
    await flashBadge("!", "#ef4444");
    return;
  }

  const dataUrl = await captureScreenshot();

  if (await isPopupOpen()) {
    chrome.runtime.sendMessage({ type: "SHORTCUT_SCREENSHOT", dataUrl }).catch(() => {});
    return;
  }

  const session = await getSession();
  session.screenshots = session.screenshots || [];
  if (session.screenshots.length >= MAX_SCREENSHOTS) {
    await flashBadge("MAX", "#f59e0b");
    return;
  }
  session.screenshots.push(dataUrl);
  await chrome.storage.local.set({ [SESSION_KEY]: session });
  await flashBadge(String(session.screenshots.length), "#10b981");
}

// Sends a message to the tab's content script, injecting content.js first if the tab
// was opened before the extension was installed/reloaded (no receiver exists yet).
async function sendToContentScript(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

async function shortcutToggleMic(tab) {
  if (!tab?.id || isRestrictedUrl(tab.url)) {
    await flashBadge("!", "#ef4444");
    return;
  }

  const micState = await sendToContentScript(tab.id, { type: "CHECK_MIC_STATE" });
  if (micState?.listening) {
    await chrome.tabs.sendMessage(tab.id, { type: "STOP_MIC" });
    return;
  }

  const session = await getSession();
  const existingText = session.note ? session.note + " " : "";
  const res = await chrome.tabs.sendMessage(tab.id, { type: "START_MIC", existingText });
  if (!res?.success) await flashBadge("!", "#ef4444");
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  try {
    if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (command === "capture-screenshot") await shortcutCaptureScreenshot(tab);
    if (command === "toggle-mic") await shortcutToggleMic(tab);
  } catch (err) {
    console.error(`BugReporter: shortcut "${command}" failed:`, err);
    await flashBadge("!", "#ef4444");
  }
});

// Mic badge + transcript persistence. MIC_STATE false is only sent on a real stop
// (content.js silently restarts recognition across silence gaps without reporting it).
// Transcript updates arrive rapidly (interim results), and each save is an async
// read-modify-write — chain them so an older update can never land after a newer one.
let transcriptWriteChain = Promise.resolve();
function persistTranscript(text) {
  transcriptWriteChain = transcriptWriteChain.then(async () => {
    if (await isPopupOpen()) return; // popup writes the note itself
    const session = await getSession();
    session.note = text;
    await chrome.storage.local.set({ [SESSION_KEY]: session });
  }).catch(err => console.warn("BugReporter: transcript save failed:", err));
  return transcriptWriteChain;
}

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === "MIC_STATE") {
    if (msg.listening) {
      chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
      chrome.action.setBadgeText({ text: "REC" });
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
    return false;
  }

  if (msg.type === "MIC_ERROR") {
    chrome.action.setBadgeText({ text: "" });
    return false;
  }

  if (msg.type === "MIC_TRANSCRIPT") {
    persistTranscript(msg.text);
    return false;
  }

  if (msg.type === "CHECK_API_KEY") {
    getSettings().then(settings => {
      const provider = settings.aiProvider || "gemini";
      const keyMap = {
        gemini: settings.geminiApiKey,
        openai: settings.openaiApiKey,
        anthropic: settings.anthropicApiKey,
        xai: settings.xaiApiKey
      };
      sendResponse({ ok: !!keyMap[provider], provider });
    });
    return true;
  }

  if (msg.type === "TEST_API_KEY") {
    const provider = msg.provider || "gemini";
    testApiKey(provider, msg.key)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "CAPTURE_SCREENSHOT") {
    captureScreenshot()
      .then(dataUrl => sendResponse({ ok: true, dataUrl }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "GENERATE_TICKET") {
    const { screenshots, audioNote, pageUrl, pageTitle, screenInfo } = msg.payload;
    const generationId = Date.now().toString();
    const controller = new AbortController();
    activeGenerationControllers.set(generationId, controller);

    setGenerationState({
      isGenerating: true,
      generationId,
      startTime: Date.now(),
      payload: msg.payload
    }).then(() => {
      generateTicket({ screenshots, audioNote, pageUrl, pageTitle, screenInfo, signal: controller.signal })
        .then(async (result) => {
          activeGenerationControllers.delete(generationId);
          const ticket = result?.text || result;
          const tokenUsage = result?.tokenUsage || null;
          await recordUsage(tokenUsage);
          await setGenerationState({
            isGenerating: false,
            generationId,
            completedAt: Date.now(),
            ticket,
            tokenUsage,
            error: null
          });
          // Rejects (async) when the popup is closed — the result is already in
          // storage for the next open, so there's nothing to handle.
          chrome.runtime.sendMessage({ type: "GENERATION_COMPLETE", generationId, ticket, tokenUsage }).catch(() => {});
        })
        .catch(async (err) => {
          activeGenerationControllers.delete(generationId);
          const wasCancelled = err.name === "AbortError";
          await setGenerationState({
            isGenerating: false,
            generationId,
            completedAt: Date.now(),
            ticket: null,
            error: wasCancelled ? null : err.message,
            cancelled: wasCancelled
          });
          chrome.runtime.sendMessage({ type: "GENERATION_COMPLETE", generationId, error: wasCancelled ? null : err.message, cancelled: wasCancelled }).catch(() => {});
        });
    });

    sendResponse({ ok: true, generationId, generating: true });
    return true;
  }

  if (msg.type === "CANCEL_GENERATION") {
    const cancelled = cancelGeneration(msg.generationId);
    clearGenerationState().then(() => sendResponse({ ok: cancelled }));
    return true;
  }

  if (msg.type === "CHECK_GENERATION_STATUS") {
    getGenerationState().then(state => {
      sendResponse({ state });
    });
    return true;
  }

  if (msg.type === "CLEAR_GENERATION_STATE") {
    clearGenerationState().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "GET_USAGE_STATS") {
    getUsageStats().then(stats => sendResponse({ stats }));
    return true;
  }

  if (msg.type === "IMPROVE_TICKET") {
    const { currentTicket, feedback, chatHistory, screenshots } = msg.payload;
    improveTicket({ currentTicket, feedback, chatHistory, screenshots })
      .then(ticket => sendResponse({ ok: true, ticket }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "REFINE_NOTE") {
    refineNote({ note: msg.payload.note })
      .then(note => sendResponse({ ok: true, note }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "START_GIF_RECORDING") {
    startGifRecording(msg.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "GIF_RECORDING_FINISHED" || msg.type === "GIF_RECORDING_ERROR") {
    if (msg.tabId) {
      chrome.tabs.sendMessage(msg.tabId, { type: "REMOVE_GIF_RECORDING_CONTROLS" }).catch(() => { /* tab may be closed */ });
    }
    return false;
  }

  // The offscreen document delegates its GIF-recording storage writes here, since
  // chrome.storage isn't reliably available from inside an offscreen document.
  if (msg.type === "SAVE_GIF_STATE") {
    chrome.storage.local.set({ [GIF_RECORDING_KEY]: msg.data })
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

});
