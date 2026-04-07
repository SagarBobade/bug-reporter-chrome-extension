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

  // API key
  if (s.apiKey) $("apiKey").value = s.apiKey;

  // Domain
  if (s.domainContext)     $("domainContext").value = s.domainContext;
  if (s.techStack)         $("techStack").value = s.techStack;

  // Summary - migrate old fields to new consolidated field if needed
  if (s.summaryFormat)     $("summaryFormat").value = s.summaryFormat;
  if (s.summaryGuidelines) {
    $("summaryGuidelines").value = s.summaryGuidelines;
  } else if (s.summaryInclude || s.summaryExclude) {
    // Migrate from old separate fields
    const migrated = [];
    if (s.summaryInclude) migrated.push("Include:\n" + s.summaryInclude);
    if (s.summaryExclude) migrated.push("Avoid:\n" + s.summaryExclude);
    $("summaryGuidelines").value = migrated.join("\n\n");
  }

  // Description rules - migrate old fields to new consolidated field if needed
  if (s.descriptionGuidelines) {
    $("descriptionGuidelines").value = s.descriptionGuidelines;
  } else if (s.descInclude || s.descExclude) {
    // Migrate from old separate fields
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
  const enabledSections = s.enabledSections || DEFAULT_SECTIONS.filter(s => s.default).map(s => s.id);
  renderSectionsGrid(enabledSections);

  // Field checkboxes
  const enabledFields = s.enabledFields || ["component", "severity"]; // Default both enabled
  renderFieldGrid(enabledFields);

  // Video recording setting (explicitly stored as videoRecordingEnabled for clarity)
  const videoRecordingEnabled = s.videoRecordingEnabled || false;  // Default disabled
  renderVideoSettings(videoRecordingEnabled);

  // Mark clean
  setDirty(false);

  // Listen for changes
  document.querySelectorAll("input, textarea, select").forEach(el => {
    el.addEventListener("input", () => setDirty(true));
  });
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

    // Add click handler if not already added
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
    .filter(f => f !== "videoRecording"); // Exclude video recording from field list
}

// ── Video Recording Settings ─────────────────────────────────────────────────
function renderVideoSettings(enabled) {
  const videoCheck = document.querySelector('.section-check[data-field="videoRecording"]');
  if (!videoCheck) return;

  videoCheck.className = "section-check" + (enabled ? " checked" : "");
  const box = videoCheck.querySelector(".check-box");
  box.textContent = enabled ? "✓" : "";

  // Add click handler if not already added
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
  // Remove existing tags
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

// ── API key reveal toggle ─────────────────────────────────────────────────────
$("btn-reveal").addEventListener("click", () => {
  const input = $("apiKey");
  input.type = input.type === "password" ? "text" : "password";
});

// ── API key test ─────────────────────────────────────────────────────────────
$("btn-test").addEventListener("click", async () => {
  const apiKey = $("apiKey").value.trim();
  const btn = $("btn-test");
  const result = $("api-test-result");

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
    const res = await chrome.runtime.sendMessage({ type: "TEST_API_KEY", key: apiKey });
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
});

// ── Save ──────────────────────────────────────────────────────────────────────
$("btn-save").addEventListener("click", async () => {
  const settings = {
    apiKey:               $("apiKey").value.trim(),
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
  };

  // Also save API key separately so background.js can find it
  await new Promise(resolve => {
    chrome.storage.local.set({
      bugReporterSettings: settings,
      geminiApiKey: settings.apiKey
    }, resolve);
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
    exportedAt: new Date().toISOString(),
    version: "1.0"
  };

  // Note: API key is NOT exported for security reasons

  const blob = new Blob([JSON.stringify(settings, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bugreporter-settings-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showStatus("Settings exported!", "success");
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

    // Validate it's a valid settings file
    if (!settings.version) {
      throw new Error("Invalid settings file format");
    }

    // Apply imported settings to form
    if (settings.domainContext) $("domainContext").value = settings.domainContext;
    if (settings.techStack) $("techStack").value = settings.techStack;
    if (settings.summaryFormat) $("summaryFormat").value = settings.summaryFormat;
    if (settings.summaryGuidelines) $("summaryGuidelines").value = settings.summaryGuidelines;
    if (settings.descriptionGuidelines) $("descriptionGuidelines").value = settings.descriptionGuidelines;
    if (settings.extraInstructions) $("extraInstructions").value = settings.extraInstructions;

    // Apply sections
    if (settings.enabledSections) {
      renderSectionsGrid(settings.enabledSections);
    }

    // Apply fields
    if (settings.enabledFields) {
      renderFieldGrid(settings.enabledFields);
    }

    // Apply custom sections
    if (settings.customSections) {
      customSections = settings.customSections;
      renderCustomSections();
    }

    // Apply video recording setting
    if (typeof settings.videoRecordingEnabled === "boolean") {
      renderVideoSettings(settings.videoRecordingEnabled);
    }

    setDirty(true);
    showStatus("Settings imported! Click Save to apply.", "success");

  } catch (err) {
    showStatus("Failed to import: " + err.message, "error");
  }

  // Reset file input
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
