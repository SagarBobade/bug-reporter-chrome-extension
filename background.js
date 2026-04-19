// background.js — BugReporter service worker

// ── Generation State Storage Key ─────────────────────────────────────────────
const GENERATION_STATE_KEY = "bugReporterGenerationState";

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
  summary:     (ctx) => `## Summary\n[${ctx.summaryFormat || "ComponentName: what broke and where — one line"}]`,
  environment: (ctx) => `## Environment
- **Browser:** ${ctx.browserInfo || "Chrome"}
- **OS:** ${ctx.osInfo || "Unknown"}
- **Screen:** ${ctx.screenInfo || "Unknown"}
- **Page:** ${ctx.pageTitle}
- **URL:** ${ctx.pageUrl}`,
  steps:       ()    => `## Steps to Reproduce\n1. \n2. \n3. `,
  expected:    ()    => `## Expected Behavior\n[One sentence]`,
  actual:      ()    => `## Actual Behavior\n[One sentence, reference UI elements visible in screenshots]`,
  impact:      ()    => `## Impact\n[Who is affected and severity]`,
  priority:    ()    => `## Priority\n[P1/P2/P3/P4 — one-line reason]`,
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
    ? `\nAnalyze the screenshots carefully. Use present tense. No markdown code blocks in output.`
    : `\nUse the provided notes/context to understand the bug. Use present tense. No markdown code blocks in output.`;

  const systemPrompt = [
    `You are a QA engineer writing a bug report. Be CONCISE and MINIMAL.`,
    `Each section should be 1-3 lines maximum unless more is truly needed.`,
    `No filler words, no padding, no repetition between sections.`,
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
async function callGemini({ apiKey, systemPrompt, userPrompt, screenshots }) {
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
      })
    }
  );

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err?.error?.message || `Gemini API error ${response.status}`);
  }

  const data = await response.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text;
}

// ── OpenAI API ────────────────────────────────────────────────────────────────
async function callOpenAI({ apiKey, systemPrompt, userPrompt, screenshots }) {
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
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err?.error?.message || `OpenAI API error ${response.status}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content;
}

// ── Anthropic API ─────────────────────────────────────────────────────────────
async function callAnthropic({ apiKey, systemPrompt, userPrompt, screenshots }) {
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
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err?.error?.message || `Anthropic API error ${response.status}`);
  }

  const data = await response.json();
  return data?.content?.[0]?.text;
}

// ── xAI Grok API ──────────────────────────────────────────────────────────────
async function callXAI({ apiKey, systemPrompt, userPrompt, screenshots }) {
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
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err?.error?.message || `xAI API error ${response.status}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content;
}

// ── Universal AI Call ─────────────────────────────────────────────────────────
async function callAI({ provider, apiKey, systemPrompt, userPrompt, screenshots }) {
  const providers = {
    gemini: callGemini,
    openai: callOpenAI,
    anthropic: callAnthropic,
    xai: callXAI
  };

  const callFn = providers[provider];
  if (!callFn) throw new Error(`Unknown AI provider: ${provider}`);

  return await callFn({ apiKey, systemPrompt, userPrompt, screenshots });
}

// ── Generate Ticket ───────────────────────────────────────────────────────────
async function generateTicket({ screenshots, audioNote, pageUrl, pageTitle, screenInfo }) {
  const { provider, key, settings } = await getCurrentProviderAndKey();

  const hasScreenshots = screenshots && screenshots.length > 0;
  const { systemPrompt, userPrompt } = buildPrompt({ pageUrl, pageTitle, audioNote, settings, screenInfo, hasScreenshots });

  let text = await callAI({
    provider,
    apiKey: key,
    systemPrompt,
    userPrompt,
    screenshots: hasScreenshots ? screenshots : []
  });

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

  return text;
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

  const text = await callAI({
    provider,
    apiKey: key,
    systemPrompt,
    userPrompt,
    screenshots: screenshots || []
  });

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

    setGenerationState({
      isGenerating: true,
      generationId,
      startTime: Date.now(),
      payload: msg.payload
    }).then(() => {
      generateTicket({ screenshots, audioNote, pageUrl, pageTitle, screenInfo })
        .then(async (ticket) => {
          await setGenerationState({
            isGenerating: false,
            generationId,
            completedAt: Date.now(),
            ticket,
            error: null
          });
          try {
            chrome.runtime.sendMessage({ type: "GENERATION_COMPLETE", generationId, ticket });
          } catch (e) { /* popup closed */ }
        })
        .catch(async (err) => {
          await setGenerationState({
            isGenerating: false,
            generationId,
            completedAt: Date.now(),
            ticket: null,
            error: err.message
          });
          try {
            chrome.runtime.sendMessage({ type: "GENERATION_COMPLETE", generationId, error: err.message });
          } catch (e) { /* popup closed */ }
        });
    });

    sendResponse({ ok: true, generationId, generating: true });
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

  if (msg.type === "IMPROVE_TICKET") {
    const { currentTicket, feedback, chatHistory, screenshots } = msg.payload;
    improveTicket({ currentTicket, feedback, chatHistory, screenshots })
      .then(ticket => sendResponse({ ok: true, ticket }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

});
