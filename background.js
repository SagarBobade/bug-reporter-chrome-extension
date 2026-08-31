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
async function recordUsage(tokenUsage) {
  if (!tokenUsage?.total) return;
  return new Promise((resolve) => {
    chrome.storage.local.get(USAGE_STATS_KEY, (r) => {
      const stats = r[USAGE_STATS_KEY] || { totalTokens: 0, ticketCount: 0 };
      stats.totalTokens += tokenUsage.total;
      stats.ticketCount += 1;
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

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

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
          try {
            chrome.runtime.sendMessage({ type: "GENERATION_COMPLETE", generationId, ticket, tokenUsage });
          } catch (e) { /* popup closed */ }
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
          try {
            chrome.runtime.sendMessage({ type: "GENERATION_COMPLETE", generationId, error: wasCancelled ? null : err.message, cancelled: wasCancelled });
          } catch (e) { /* popup closed */ }
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

});
