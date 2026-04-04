// background.js — BugReporter service worker

// ── Storage helpers ───────────────────────────────────────────────────────────
async function getApiKey() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get("geminiApiKey", (r) => {
      if (r.geminiApiKey) resolve(r.geminiApiKey);
      else reject(new Error("NO_API_KEY"));
    });
  });
}

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get("bugReporterSettings", (r) => resolve(r.bugReporterSettings || {}));
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

  // Detect browser
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

  // Detect OS
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
function buildPrompt({ pageUrl, pageTitle, audioNote, settings, screenInfo }) {
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

  // Get browser and OS info
  const { browser, os } = getBrowserInfo();

  const ctx = {
    pageUrl,
    pageTitle,
    summaryFormat,
    browserInfo: browser,
    osInfo: os,
    screenInfo: screenInfo || "Unknown"
  };

  // Only render sections the user actually enabled
  const sectionBlocks = [
    ...enabledSections
      .filter(id => SECTION_TEMPLATES[id])
      .map(id => SECTION_TEMPLATES[id](ctx)),
    ...customSections.map(name => `## ${name}\n[${name} — be brief]`),
  ];

  const systemPrompt = [
    `You are a QA engineer writing a bug report. Be CONCISE and MINIMAL.`,
    `Each section should be 1-3 lines maximum unless more is truly needed.`,
    `No filler words, no padding, no repetition between sections.`,
    domainContext ? `\nPRODUCT CONTEXT: ${domainContext}` : "",
    techStack     ? `TECH STACK: ${techStack}` : "",
    `\nAnalyze the screenshots carefully. Use present tense. No markdown code blocks in output.`,
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

// ── Gemini call ───────────────────────────────────────────────────────────────
async function callGeminiVision({ screenshots, audioNote, pageUrl, pageTitle, screenInfo }) {
  const [apiKey, settings] = await Promise.all([getApiKey(), getSettings()]);

  const imageParts = screenshots.map(b64 => ({
    inline_data: { mime_type: "image/png", data: b64.replace(/^data:image\/png;base64,/, "") }
  }));

  const contentParts = [];
  screenshots.forEach((_, i) => {
    contentParts.push({ text: `--- Screenshot ${i+1} ---` });
    contentParts.push(imageParts[i]);
  });

  const { systemPrompt, userPrompt } = buildPrompt({ pageUrl, pageTitle, audioNote, settings, screenInfo });

  const body = {
    contents: [{
      role: "user",
      parts: [{ text: systemPrompt }, ...contentParts, { text: userPrompt }]
    }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024 }
  };

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey  // Secure: API key in header, not URL
      },
      body: JSON.stringify(body)
    }
  );

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err?.error?.message || `API error ${response.status}`);
  }

  const data = await response.json();
  let text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Empty response from Gemini");

  // Check if screenshots section is enabled - if so, append embedded images
  const enabledSections = settings.enabledSections || [];
  if (enabledSections.includes("screenshots")) {
    // Build HTML img tags for rich text pasting
    const screenshotSection = screenshots.map((dataUrl, i) =>
      `<img src="${dataUrl}" alt="Screenshot ${i + 1}" width="600" />`
    ).join("\n");

    // Try to replace existing Screenshots section placeholder
    if (/## Screenshots/i.test(text)) {
      text = text.replace(
        /## Screenshots\n\[.*?\]/i,
        `## Screenshots\n${screenshotSection}`
      );
    } else {
      // If no Screenshots section exists, append it at the end
      text = text.trim() + `\n\n## Screenshots\n${screenshotSection}`;
    }
  }

  return text;
}

// ── Screenshot capture ────────────────────────────────────────────────────────
async function captureScreenshot() {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(null, { format: "png", quality: 90 }, (dataUrl) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(dataUrl);
    });
  });
}

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === "SAVE_API_KEY") {
    chrome.storage.local.set({ geminiApiKey: msg.key }, () => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "CHECK_API_KEY") {
    chrome.storage.local.get("geminiApiKey", (r) => sendResponse({ ok: !!r.geminiApiKey }));
    return true;
  }

  if (msg.type === "TEST_API_KEY") {
    // Test the API key by making a simple request
    testApiKey(msg.key)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "CAPTURE_SCREENSHOT") {
    captureScreenshot()
      .then(dataUrl => sendResponse({ ok: true, dataUrl }))
      .catch(err    => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "GENERATE_TICKET") {
    const { screenshots, audioNote, pageUrl, pageTitle, screenInfo } = msg.payload;
    callGeminiVision({ screenshots, audioNote, pageUrl, pageTitle, screenInfo })
      .then(ticket => sendResponse({ ok: true, ticket }))
      .catch(err   => sendResponse({ ok: false, error: err.message }));
    return true;
  }

});

// ── Test API key ─────────────────────────────────────────────────────────────
async function testApiKey(apiKey) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        generationConfig: { maxOutputTokens: 10 }
      })
    }
  );

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err?.error?.message || `API error ${response.status}`);
  }

  return true;
}
