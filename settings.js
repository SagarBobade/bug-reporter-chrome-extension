// settings.js — BugReporter settings page controller

const DEFAULT_SECTIONS = [
  { id: "summary",         label: "Summary",            default: true },
  { id: "environment",     label: "Environment",        default: true },
  { id: "steps",           label: "Steps to Reproduce", default: true },
  { id: "expected",        label: "Expected Behavior",  default: true },
  { id: "actual",          label: "Actual Behavior",    default: true },
  { id: "impact",          label: "Impact",             default: true },
  { id: "priority",        label: "Priority",           default: true },
  { id: "acceptance",      label: "Acceptance Criteria",default: true },
  { id: "logs",            label: "Logs / Errors",      default: false },
  { id: "screenshots",     label: "Screenshots",        default: false },
  { id: "workaround",      label: "Workaround",         default: false },
  { id: "context",         label: "Additional Context", default: true },
];

const AI_PROVIDERS = ["gemini", "openai", "anthropic", "xai"];

const $ = id => document.getElementById(id);
let customSections = [];
let isDirty = false;

// ── Load saved settings ───────────────────────────────────────────────────────
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get("bugReporterSettings", (result) => {
      resolve(result.bugReporterSettings || {});
    });
  });
}

async function init() {
  const s = await loadSettings();

  // AI Provider
  const aiProvider = s.aiProvider || "gemini";
  $("aiProvider").value = aiProvider;
  showApiKeySection(aiProvider);

  // API Keys
  if (s.geminiApiKey) $("geminiApiKey").value = s.geminiApiKey;
  if (s.openaiApiKey) $("openaiApiKey").value = s.openaiApiKey;
  if (s.anthropicApiKey) $("anthropicApiKey").value = s.anthropicApiKey;
  if (s.xaiApiKey) $("xaiApiKey").value = s.xaiApiKey;

  // Legacy: migrate old apiKey to geminiApiKey
  if (s.apiKey && !s.geminiApiKey) {
    $("geminiApiKey").value = s.apiKey;
  }

  // Domain
  if (s.domainContext) $("domainContext").value = s.domainContext;
  if (s.techStack) $("techStack").value = s.techStack;

  // Summary - migrate old fields to new consolidated field if needed
  if (s.summaryFormat) $("summaryFormat").value = s.summaryFormat;
  if (s.summaryGuidelines) {
    $("summaryGuidelines").value = s.summaryGuidelines;
  } else if (s.summaryInclude || s.summaryExclude) {
    const migrated = [];
    if (s.summaryInclude) migrated.push("Include:\n" + s.summaryInclude);
    if (s.summaryExclude) migrated.push("Avoid:\n" + s.summaryExclude);
    $("summaryGuidelines").value = migrated.join("\n\n");
  }

  // Description rules
  if (s.descriptionGuidelines) {
    $("descriptionGuidelines").value = s.descriptionGuidelines;
  } else if (s.descInclude || s.descExclude) {
    const migrated = [];
    if (s.descInclude) migrated.push("Include:\n" + s.descInclude);
    if (s.descExclude) migrated.push("Avoid:\n" + s.descExclude);
    $("descriptionGuidelines").value = migrated.join("\n\n");
  }
  if (s.extraInstructions) $("extraInstructions").value = s.extraInstructions;

  // Custom sections
  customSections = s.customSections || [];
  renderCustomSections();

  // Section checkboxes
  const enabledSections = s.enabledSections || DEFAULT_SECTIONS.filter(sec => sec.default).map(sec => sec.id);
  renderSectionsGrid(enabledSections);

  // Field checkboxes
  const enabledFields = s.enabledFields || ["component", "severity"];
  renderFieldGrid(enabledFields);

  // Video recording setting
  const videoRecordingEnabled = s.videoRecordingEnabled || false;
  renderVideoSettings(videoRecordingEnabled);

  // Webcam configuration
  const webcamEnabled = s.webcamEnabled || false;
  const webcamPosition = s.webcamPosition || "bottom-right";
  const webcamSize = s.webcamSize || 20;
  const recordingQuality = s.recordingQuality || 720;
  
  renderWebcamSettings(webcamEnabled);
  if (webcamPosition) $("webcamPosition").value = webcamPosition;
  if (webcamSize) $("webcamSize").value = webcamSize.toString();
  if (recordingQuality) $("recordingQuality").value = recordingQuality.toString();

  // Mark clean
  setDirty(false);

  // Listen for changes
  document.querySelectorAll("input, textarea, select").forEach(el => {
    el.addEventListener("input", () => setDirty(true));
    el.addEventListener("change", () => setDirty(true));
  });

  // AI Provider change handler
  $("aiProvider").addEventListener("change", (e) => {
    showApiKeySection(e.target.value);
    setDirty(true);
  });

  // Setup reveal buttons for all API keys
  document.querySelectorAll(".btn-reveal").forEach(btn => {
    btn.addEventListener("click", () => {
      const targetId = btn.dataset.target;
      const input = $(targetId);
      if (input) {
        input.type = input.type === "password" ? "text" : "password";
      }
    });
  });

  // Setup test buttons for all API keys
  document.querySelectorAll(".btn-test").forEach(btn => {
    btn.addEventListener("click", () => testApiKey(btn.dataset.provider));
  });
}

// ── Show/Hide API Key Sections ────────────────────────────────────────────────
function showApiKeySection(provider) {
  AI_PROVIDERS.forEach(p => {
    const section = $(`${p}-key-section`);
    if (section) {
      section.style.display = p === provider ? "block" : "none";
    }
  });
}

// ── Test API Key ──────────────────────────────────────────────────────────────
async function testApiKey(provider) {
  const keyInput = $(`${provider}ApiKey`);
  const apiKey = keyInput?.value.trim();
  const btn = document.querySelector(`.btn-test[data-provider="${provider}"]`);
  const result = document.querySelector(`.api-test-result[data-provider="${provider}"]`);

  if (!apiKey) {
    result.textContent = "Please enter an API key first";
    result.className = "api-test-result visible error";
    return;
  }

  // Show testing state
  btn.disabled = true;
  btn.textContent = "Testing...";
  btn.classList.add("testing");
  result.className = "api-test-result";

  try {
    const res = await chrome.runtime.sendMessage({
      type: "TEST_API_KEY",
      provider: provider,
      key: apiKey
    });
    if (res?.ok) {
      result.textContent = "✓ Connection successful!";
      result.className = "api-test-result visible success";
    } else {
      result.textContent = "✗ " + (res?.error || "Connection failed");
      result.className = "api-test-result visible error";
    }
  } catch (err) {
    result.textContent = "✗ " + err.message;
    result.className = "api-test-result visible error";
  } finally {
    btn.disabled = false;
    btn.textContent = "Test";
    btn.classList.remove("testing");
  }
}

// ── Sections grid ─────────────────────────────────────────────────────────────
function renderSectionsGrid(enabledSections) {
  const grid = $("sections-grid");
  grid.innerHTML = "";

  DEFAULT_SECTIONS.forEach(sec => {
    const checked = enabledSections.includes(sec.id);
    const div = document.createElement("div");
    div.className = "section-check" + (checked ? " checked" : "");
    div.dataset.id = sec.id;
    div.innerHTML = `
      <div class="check-box">${checked ? "✓" : ""}</div>
      <span class="check-label">${sec.label}</span>
    `;
    div.addEventListener("click", () => {
      div.classList.toggle("checked");
      const box = div.querySelector(".check-box");
      box.textContent = div.classList.contains("checked") ? "✓" : "";
      setDirty(true);
    });
    grid.appendChild(div);
  });
}

function getEnabledSections() {
  return Array.from(document.querySelectorAll(".section-check.checked"))
    .map(el => el.dataset.id)
    .filter(Boolean);
}

// ── Field configuration ───────────────────────────────────────────────────────
function renderFieldGrid(enabledFields) {
  const fieldChecks = document.querySelectorAll('.section-check[data-field]');

  fieldChecks.forEach(div => {
    const fieldId = div.dataset.field;
    const checked = enabledFields.includes(fieldId);

    div.className = "section-check" + (checked ? " checked" : "");
    const box = div.querySelector(".check-box");
    box.textContent = checked ? "✓" : "";

    if (!div._hasHandler) {
      div.addEventListener("click", () => {
        div.classList.toggle("checked");
        const box = div.querySelector(".check-box");
        box.textContent = div.classList.contains("checked") ? "✓" : "";
        setDirty(true);
      });
      div._hasHandler = true;
    }
  });
}

function getEnabledFields() {
  return Array.from(document.querySelectorAll('.section-check.checked[data-field]'))
    .map(el => el.dataset.field)
    .filter(f => f !== "videoRecording");
}

// ── Webcam Configuration ─────────────────────────────────────────────────────
function renderWebcamSettings(enabled) {
  const webcamCheck = $("webcam-enabled-check");
  const webcamConfig = $("webcam-config");
  
  if (!webcamCheck) return;

  webcamCheck.className = "section-check" + (enabled ? " checked" : "");
  const box = webcamCheck.querySelector(".check-box");
  box.textContent = enabled ? "✓" : "";
  
  // Show/hide config section
  if (webcamConfig) {
    webcamConfig.style.display = enabled ? "block" : "none";
  }

  if (!webcamCheck._hasHandler) {
    webcamCheck.addEventListener("click", () => {
      webcamCheck.classList.toggle("checked");
      const box = webcamCheck.querySelector(".check-box");
      const isChecked = webcamCheck.classList.contains("checked");
      box.textContent = isChecked ? "✓" : "";
      
      // Toggle webcam config visibility
      if (webcamConfig) {
        webcamConfig.style.display = isChecked ? "block" : "none";
      }
      
      setDirty(true);
    });
    webcamCheck._hasHandler = true;
  }
}

function isWebcamEnabled() {
  const webcamCheck = $("webcam-enabled-check");
  return webcamCheck ? webcamCheck.classList.contains("checked") : false;
}

// ── Video Recording Settings ─────────────────────────────────────────────────
function renderVideoSettings(enabled) {
  const videoCheck = document.querySelector('.section-check[data-field="videoRecording"]');
  if (!videoCheck) return;

  videoCheck.className = "section-check" + (enabled ? " checked" : "");
  const box = videoCheck.querySelector(".check-box");
  box.textContent = enabled ? "✓" : "";

  if (!videoCheck._hasHandler) {
    videoCheck.addEventListener("click", () => {
      videoCheck.classList.toggle("checked");
      const box = videoCheck.querySelector(".check-box");
      box.textContent = videoCheck.classList.contains("checked") ? "✓" : "";
      setDirty(true);
    });
    videoCheck._hasHandler = true;
  }
}

function isVideoRecordingEnabled() {
  const videoCheck = document.querySelector('.section-check[data-field="videoRecording"]');
  return videoCheck ? videoCheck.classList.contains("checked") : false;
}

// ── Custom sections ───────────────────────────────────────────────────────────
function renderCustomSections() {
  const wrap = $("custom-sections-wrap");
  wrap.querySelectorAll(".tag").forEach(t => t.remove());
  customSections.forEach((name, i) => {
    const tag = document.createElement("div");
    tag.className = "tag";
    tag.innerHTML = `${name} <button data-i="${i}">×</button>`;
    tag.querySelector("button").addEventListener("click", () => {
      customSections.splice(i, 1);
      renderCustomSections();
      setDirty(true);
    });
    wrap.insertBefore(tag, $("custom-section-input"));
  });
}

$("custom-section-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    const val = e.target.value.trim().replace(/,$/, "");
    if (val && !customSections.includes(val)) {
      customSections.push(val);
      renderCustomSections();
      e.target.value = "";
      setDirty(true);
    }
  }
  if (e.key === "Backspace" && !e.target.value && customSections.length) {
    customSections.pop();
    renderCustomSections();
    setDirty(true);
  }
});

// ── Save ──────────────────────────────────────────────────────────────────────
$("btn-save").addEventListener("click", async () => {
  const aiProvider = $("aiProvider").value;

  const settings = {
    aiProvider:           aiProvider,
    geminiApiKey:         $("geminiApiKey").value.trim(),
    openaiApiKey:         $("openaiApiKey").value.trim(),
    anthropicApiKey:      $("anthropicApiKey").value.trim(),
    xaiApiKey:            $("xaiApiKey").value.trim(),
    domainContext:        $("domainContext").value.trim(),
    techStack:            $("techStack").value.trim(),
    summaryFormat:        $("summaryFormat").value.trim(),
    summaryGuidelines:    $("summaryGuidelines").value.trim(),
    descriptionGuidelines: $("descriptionGuidelines").value.trim(),
    extraInstructions:    $("extraInstructions").value.trim(),
    enabledSections:      getEnabledSections(),
    enabledFields:        getEnabledFields(),
    customSections,
    videoRecordingEnabled: isVideoRecordingEnabled(),
    webcamEnabled:        isWebcamEnabled(),
    webcamPosition:       $("webcamPosition") ? $("webcamPosition").value : "bottom-right",
    webcamSize:           $("webcamSize") ? parseInt($("webcamSize").value) : 20,
    recordingQuality:     $("recordingQuality") ? parseInt($("recordingQuality").value) : 720,
  };

  // Save settings
  await new Promise(resolve => {
    chrome.storage.local.set({ bugReporterSettings: settings }, resolve);
  });

  setDirty(false);
  const status = $("save-status");
  status.textContent = "✓ Saved!";
  status.classList.add("saved");
  setTimeout(() => {
    status.textContent = "All changes saved";
  }, 2000);
});

// ── Dirty state ───────────────────────────────────────────────────────────────
function setDirty(dirty) {
  isDirty = dirty;
  const status = $("save-status");
  if (dirty) {
    status.textContent = "Unsaved changes";
    status.classList.remove("saved");
  } else {
    status.textContent = "All changes saved";
    status.classList.add("saved");
  }
}

// ── Export Settings ──────────────────────────────────────────────────────────
$("btn-export").addEventListener("click", () => {
  const settings = {
    aiProvider:           $("aiProvider").value,
    domainContext:        $("domainContext").value.trim(),
    techStack:            $("techStack").value.trim(),
    summaryFormat:        $("summaryFormat").value.trim(),
    summaryGuidelines:    $("summaryGuidelines").value.trim(),
    descriptionGuidelines: $("descriptionGuidelines").value.trim(),
    extraInstructions:    $("extraInstructions").value.trim(),
    enabledSections:      getEnabledSections(),
    enabledFields:        getEnabledFields(),
    customSections,
    videoRecordingEnabled: isVideoRecordingEnabled(),
    webcamEnabled:        isWebcamEnabled(),
    webcamPosition:       $("webcamPosition") ? $("webcamPosition").value : "bottom-right",
    webcamSize:           $("webcamSize") ? parseInt($("webcamSize").value) : 20,
    recordingQuality:     $("recordingQuality") ? parseInt($("recordingQuality").value) : 720,
    exportedAt: new Date().toISOString(),
    version: "1.2"
  };

  // Note: API keys are NOT exported for security reasons

  const blob = new Blob([JSON.stringify(settings, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bugreporter-settings-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast("Settings exported successfully!", "success");
});

// ── Import Settings ──────────────────────────────────────────────────────────
$("btn-import").addEventListener("click", () => {
  $("import-file").click();
});

$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const settings = JSON.parse(text);

    if (!settings.version) {
      throw new Error("Invalid settings file format");
    }

    // Apply imported settings to form
    if (settings.aiProvider) {
      $("aiProvider").value = settings.aiProvider;
      showApiKeySection(settings.aiProvider);
    }
    if (settings.domainContext) $("domainContext").value = settings.domainContext;
    if (settings.techStack) $("techStack").value = settings.techStack;
    if (settings.summaryFormat) $("summaryFormat").value = settings.summaryFormat;
    if (settings.summaryGuidelines) $("summaryGuidelines").value = settings.summaryGuidelines;
    if (settings.descriptionGuidelines) $("descriptionGuidelines").value = settings.descriptionGuidelines;
    if (settings.extraInstructions) $("extraInstructions").value = settings.extraInstructions;

    if (settings.enabledSections) {
      renderSectionsGrid(settings.enabledSections);
    }

    if (settings.enabledFields) {
      renderFieldGrid(settings.enabledFields);
    }

    if (settings.customSections) {
      customSections = settings.customSections;
      renderCustomSections();
    }

    if (typeof settings.videoRecordingEnabled === "boolean") {
      renderVideoSettings(settings.videoRecordingEnabled);
    }

    // Import webcam settings
    if (typeof settings.webcamEnabled === "boolean") {
      renderWebcamSettings(settings.webcamEnabled);
    }
    if (settings.webcamPosition && $("webcamPosition")) {
      $("webcamPosition").value = settings.webcamPosition;
    }
    if (settings.webcamSize && $("webcamSize")) {
      $("webcamSize").value = settings.webcamSize.toString();
    }
    if (settings.recordingQuality && $("recordingQuality")) {
      $("recordingQuality").value = settings.recordingQuality.toString();
    }

    setDirty(true);
    showToast("Settings imported! Click Save to apply.", "success");

  } catch (err) {
    showToast("Failed to import: " + err.message, "error");
  }

  e.target.value = "";
});

function showStatus(message, type = "info") {
  const status = $("save-status");
  status.textContent = message;
  if (type === "success") {
    status.style.color = "var(--success)";
  } else if (type === "error") {
    status.style.color = "var(--danger)";
  }
  setTimeout(() => {
    status.style.color = "";
    if (!isDirty) {
      status.textContent = "All changes saved";
    } else {
      status.textContent = "Unsaved changes";
    }
  }, 3000);
}

init();
