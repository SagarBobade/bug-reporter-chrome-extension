// popup.js — BugReporter extension popup controller

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  screenshots: [],
  pageUrl: "",
  pageTitle: "",
  isAuthenticated: false,
  recognition: null,
  isListening: false,
  hasRestoredResult: false,
  enabledFields: ["component", "severity"], // Default enabled
  currentGenerationId: null, // Track ongoing generation
  chatHistory: [], // Chat history with AI
  videoBlobUrl: null, // Blob URL for video download (video NOT sent to AI)
  videoRecordingEnabled: false, // Setting: whether video recording is enabled
};

const MAX_SCREENSHOTS = 6;
const STORAGE_KEY = "bugReporterSession";

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const authBadge      = $("auth-badge");
const btnCapture     = $("btn-capture");
const btnAnnotate    = $("btn-annotate");
const btnMic         = $("btn-mic");
const btnGenerate    = $("btn-generate");
const btnCopy        = $("btn-copy");
const btnRegen       = $("btn-regen");
const btnReset       = $("btn-reset");
const noteInput      = $("note-input");
const fieldComp      = $("field-component");
const fieldSev       = $("field-severity");
const screenshotGrid = $("screenshot-grid");
const shotCount      = $("shot-count");
const btnClearAll    = $("btn-clear-all");
const loadingBar     = $("loading-bar");
const loadingText    = $("loading-text");
const errorBox       = $("error-box");
const capturePanel   = $("capture-panel");
const resultPanel    = $("result-panel");
const resultTextarea = $("result-textarea");
const pageMeta       = $("page-meta");
const inputEditSection = $("input-edit-section");
const inputEditToggle  = $("input-edit-toggle");
const inputEditBody    = $("input-edit-body");
const editNote         = $("edit-note");
const editComponent    = $("edit-component");
const editSeverity     = $("edit-severity");
const btnRegenEdit     = $("btn-regenerate-edit");
const chatSection      = $("chat-section");
const chatHistory      = $("chat-history");
const chatInput        = $("chat-input");
const btnImprove       = $("btn-improve");
const videoSection     = $("video-section");
const btnRecord        = $("btn-record");
const videoPreview     = $("video-preview");
const btnDeleteVideo   = $("btn-delete-video");
const btnDownloadVideo = $("btn-download-video");
const videoInfoText    = $("video-info-text");
const resultVideo      = $("result-video");
const btnResultDownloadVideo = $("btn-result-download-video");
const noteInputWrap    = $("note-input-wrap");
const btnClearNote     = $("btn-clear-note");

// ── Persist session ───────────────────────────────────────────────────────────
function saveSession(includeResult = false) {
  const data = {
    screenshots: state.screenshots,
    note:        noteInput.value,
    component:   fieldComp.value,
    severity:    fieldSev.value,
  };

  // Optionally save the generated result
  if (includeResult && resultTextarea.value) {
    data.generatedTicket = resultTextarea.value;
    data.showingResult = true;
  }

  chrome.storage.local.set({ [STORAGE_KEY]: data });
}

// Save result separately (called after generation)
function saveResult() {
  chrome.storage.local.get(STORAGE_KEY, (result) => {
    const s = result[STORAGE_KEY] || {};
    s.generatedTicket = resultTextarea.value;
    s.showingResult = true;
    s.screenshots = state.screenshots; // Ensure screenshots are saved with result
    s.chatHistory = state.chatHistory; // Save chat history with ticket
    chrome.storage.local.set({ [STORAGE_KEY]: s });
  });
}

async function restoreSession() {
  return new Promise(resolve => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      const s = result[STORAGE_KEY];
      if (s) {
        state.screenshots = s.screenshots || [];
        noteInput.value   = s.note      || "";
        fieldComp.value   = s.component || "";
        fieldSev.value    = s.severity  || "Medium";
        state.chatHistory = s.chatHistory || [];

        // Restore generated result if exists
        if (s.showingResult && s.generatedTicket) {
          resultTextarea.value = s.generatedTicket;
          // We'll show the result panel after init completes
          state.hasRestoredResult = true;
        }
      }
      resolve();
    });
  });
}

function clearSession() {
  chrome.storage.local.remove(STORAGE_KEY);
}

// ── Load settings and configure UI fields ─────────────────────────────────────
async function loadFieldSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get("bugReporterSettings", (result) => {
      const settings = result.bugReporterSettings || {};
      const enabledFields = settings.enabledFields || ["component", "severity"];

      // Show/hide Component field
      const componentGroup = document.querySelector('.context-row .field-group:first-child');
      if (enabledFields.includes("component")) {
        if (componentGroup) componentGroup.style.display = "block";
      } else {
        if (componentGroup) componentGroup.style.display = "none";
        fieldComp.value = ""; // Clear if hidden
      }

      // Show/hide Severity field
      const severityGroup = document.querySelector('.context-row .field-group:last-child');
      if (enabledFields.includes("severity")) {
        if (severityGroup) severityGroup.style.display = "block";
        if (!fieldSev.value) fieldSev.value = "Medium"; // Default to Medium
      } else {
        if (severityGroup) severityGroup.style.display = "none";
        fieldSev.value = "Medium"; // Default when hidden
      }

      // Hide entire context row if both fields are disabled
      const contextRow = document.querySelector('.context-row');
      if (!enabledFields.includes("component") && !enabledFields.includes("severity")) {
        if (contextRow) contextRow.style.display = "none";
      } else {
        if (contextRow) contextRow.style.display = "grid";
      }

      state.enabledFields = enabledFields;

      // Video recording setting
      state.videoRecordingEnabled = settings.videoRecordingEnabled || false;
      if (videoSection) {
        videoSection.style.display = state.videoRecordingEnabled ? "block" : "none";
      }

      resolve(enabledFields);
    });
  });
}

// ── Check Generation Status (for background processing) ─────────────────────
async function checkGenerationStatus() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "CHECK_GENERATION_STATUS" }, (response) => {
      const genState = response?.state;
      if (!genState) {
        resolve();
        return;
      }

      if (genState.isGenerating) {
        // Generation is in progress - show loading UI
        state.currentGenerationId = genState.generationId;
        setLoading(true);
        loadingText.textContent = "Still generating ticket…";
        // Start polling for completion
        startGenerationPolling();
      } else if (genState.ticket && !state.hasRestoredResult) {
        // Generation completed while popup was closed - show result
        resultTextarea.value = genState.ticket;
        state.hasRestoredResult = true;
        // Clear the generation state since we've consumed the result
        chrome.runtime.sendMessage({ type: "CLEAR_GENERATION_STATE" });
        showToast("Ticket generated while popup was closed!", "success");
      } else if (genState.error && !state.hasRestoredResult) {
        // Generation failed while popup was closed
        showError("Generation failed: " + genState.error);
        chrome.runtime.sendMessage({ type: "CLEAR_GENERATION_STATE" });
      }
      resolve();
    });
  });
}

// Poll for generation completion
let pollingInterval = null;
function startGenerationPolling() {
  if (pollingInterval) return;
  pollingInterval = setInterval(() => {
    chrome.runtime.sendMessage({ type: "CHECK_GENERATION_STATUS" }, (response) => {
      const genState = response?.state;
      if (!genState || !genState.isGenerating) {
        clearInterval(pollingInterval);
        pollingInterval = null;

        if (genState?.ticket) {
          setLoading(false);
          showResult(genState.ticket);
          showToast("Ticket generated!", "success");
          chrome.runtime.sendMessage({ type: "CLEAR_GENERATION_STATE" });
        } else if (genState?.error) {
          setLoading(false);
          showError("Generation failed: " + genState.error);
          chrome.runtime.sendMessage({ type: "CLEAR_GENERATION_STATE" });
        }
      }
    });
  }, 1000);
}

// Listen for generation complete message from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "GENERATION_COMPLETE") {
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
    setLoading(false);
    if (msg.ticket) {
      showResult(msg.ticket);
      showToast("Ticket generated!", "success");
    } else if (msg.error) {
      showError("Generation failed: " + msg.error);
    }
    chrome.runtime.sendMessage({ type: "CLEAR_GENERATION_STATE" });
  }
});

// ── Check for Annotation Result ─────────────────────────────────────────────
async function checkAnnotationResult() {
  return new Promise((resolve) => {
    chrome.storage.local.get(ANNOTATION_DATA_KEY, (result) => {
      const data = result[ANNOTATION_DATA_KEY];
      if (data && data.completed && data.result) {
        // Check if this is an edit of existing screenshot
        if (typeof data.editIndex === "number" && data.editIndex < state.screenshots.length) {
          // Replace existing screenshot
          state.screenshots[data.editIndex] = data.result;
          showToast("Screenshot updated!", "success");
        } else {
          // Add as new screenshot
          if (state.screenshots.length < MAX_SCREENSHOTS) {
            state.screenshots.push(data.result);
            showToast("Annotated screenshot added!", "success");
          }
        }
        saveSession();
        renderGrid();
        updateGenerateBtn();
        // Clear annotation data
        chrome.storage.local.remove(ANNOTATION_DATA_KEY);
      }
      resolve();
    });
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      state.pageUrl   = tab.url || "";
      state.pageTitle = tab.title || "";
      const domain = new URL(tab.url).hostname.replace("www.", "");
      pageMeta.textContent = domain.length > 30 ? domain.slice(0, 28) + "…" : domain;
    }
  } catch (e) {
    pageMeta.textContent = "Unknown page";
  }

  await restoreSession();
  await loadFieldSettings();

  // Check for ongoing/completed generation
  await checkGenerationStatus();

  // Check for completed annotation
  await checkAnnotationResult();

  // Check for completed video recording (only if video recording is enabled)
  if (state.videoRecordingEnabled) {
    await checkVideoRecording();
  }

  chrome.runtime.sendMessage({ type: "CHECK_API_KEY" }, (res) => {
    if (res?.ok) {
      state.isAuthenticated = true;
      authBadge.textContent = "⬤ connected";
      authBadge.classList.add("connected");
    }
  });

  $("btn-settings").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
  });

  noteInput.addEventListener("input",  () => { updateSteps(); updateGenerateBtn(); saveSession(); updateNoteInputClear(); });
  fieldComp.addEventListener("input",  saveSession);
  fieldSev.addEventListener("change",  saveSession);

  // Clear note button
  btnClearNote.addEventListener("click", () => {
    noteInput.value = "";
    updateNoteInputClear();
    updateSteps();
    updateGenerateBtn();
    saveSession();
    noteInput.focus();
  });

  // Initial state for clear button
  updateNoteInputClear();

  setupSpeechRecognition();
  renderGrid();
  updateGenerateBtn();

  // Restore result panel if we had a generated ticket
  if (state.hasRestoredResult) {
    showRestoredResult();
  }
}

// ── Check Mic State (for restoring UI on popup reopen) ───────────────────────
async function checkMicState() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || tab.url?.startsWith("chrome://")) return;

    chrome.tabs.sendMessage(tab.id, { type: "CHECK_MIC_STATE" }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response?.listening) {
        state.isListening = true;
        btnMic.classList.add("recording");
        btnMic.textContent = "⏹️";
        btnMic.title = "Stop recording";
      }
    });
  } catch (e) { /* ignore */ }
}

// ── Speech Recognition (via content script) ──────────────────────────────────
function setupSpeechRecognition() {
  // Check if mic is already recording when popup opens
  checkMicState();

  // Listen for messages from content script
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "MIC_STATE") {
      state.isListening = msg.listening;
      if (msg.listening) {
        btnMic.classList.add("recording");
        btnMic.textContent = "⏹️";
        btnMic.title = "Stop recording";
      } else {
        btnMic.classList.remove("recording");
        btnMic.textContent = "🎙️";
        btnMic.title = "Record voice note";
      }
    }

    if (msg.type === "MIC_TRANSCRIPT") {
      noteInput.value = msg.text;
      updateSteps();
      updateGenerateBtn();
      if (msg.isFinal) {
        saveSession();
      }
    }

    if (msg.type === "MIC_ERROR") {
      state.isListening = false;
      btnMic.classList.remove("recording");
      btnMic.textContent = "🎙️";
      if (msg.error === "not-allowed") {
        showError("Mic denied. Allow microphone access on this page and try again.");
      } else if (msg.error !== "aborted") {
        showError("Speech error: " + msg.error);
      }
    }
  });

  // Mic button click handler
  btnMic.addEventListener("click", async () => {
    clearError();
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        showError("Cannot access this page for voice recording.");
        return;
      }

      // Check if it's a restricted page
      if (tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) {
        showError("Voice recording doesn't work on Chrome internal pages. Navigate to a website first.");
        return;
      }

      const messageType = state.isListening ? "STOP_MIC" : "START_MIC";
      const payload = messageType === "START_MIC"
        ? { type: messageType, existingText: noteInput.value ? noteInput.value + " " : "" }
        : { type: messageType };

      chrome.tabs.sendMessage(tab.id, payload, (response) => {
        if (chrome.runtime.lastError) {
          showError("Could not connect to page. Try refreshing the page.");
          return;
        }
        if (!response?.success && messageType === "START_MIC") {
          showError(response?.error || "Failed to start recording.");
        }
      });
    } catch (err) {
      showError("Failed to toggle mic: " + err.message);
    }
  });
}

// ── Screenshot grid ───────────────────────────────────────────────────────────
function renderGrid() {
  screenshotGrid.innerHTML = "";

  state.screenshots.forEach((src, i) => {
    const thumb = document.createElement("div");
    thumb.className = "screenshot-thumb";
    thumb.title = "Click to preview";

    // Safe DOM creation (no innerHTML with user data)
    const img = document.createElement("img");
    img.src = src;
    img.alt = `Screenshot ${i + 1}`;

    const numSpan = document.createElement("span");
    numSpan.className = "thumb-num";
    numSpan.textContent = `#${i + 1}`;

    // Edit button
    const editBtn = document.createElement("button");
    editBtn.className = "thumb-edit";
    editBtn.dataset.index = i;
    editBtn.title = "Edit";
    editBtn.textContent = "✏️";
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openScreenshotForEdit(i);
    });

    const delBtn = document.createElement("button");
    delBtn.className = "thumb-del";
    delBtn.dataset.index = i;
    delBtn.title = "Remove";
    delBtn.textContent = "✕";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const confirmed = await showConfirmDialog(
        "Delete Screenshot?",
        `Remove screenshot #${i + 1}? This cannot be undone.`,
        "Delete"
      );
      if (confirmed) removeScreenshot(i);
    });

    // Click thumbnail to preview
    thumb.addEventListener("click", () => showPreview(i));

    thumb.appendChild(img);
    thumb.appendChild(numSpan);
    thumb.appendChild(editBtn);
    thumb.appendChild(delBtn);
    screenshotGrid.appendChild(thumb);
  });

  // Show max 3 empty placeholders (to avoid scrollbar)
  const emptyCount = Math.min(3, MAX_SCREENSHOTS - state.screenshots.length);
  for (let i = 0; i < emptyCount; i++) {
    const empty = document.createElement("div");
    empty.className = "screenshot-empty";
    empty.textContent = "+";
    screenshotGrid.appendChild(empty);
  }

  shotCount.style.display = state.screenshots.length > 0 ? "inline-flex" : "none";
  shotCount.textContent = state.screenshots.length;
  btnClearAll.style.display = state.screenshots.length > 1 ? "inline-block" : "none";
  updateSteps();
}

// Open screenshot in annotation editor for editing
async function openScreenshotForEdit(index) {
  const screenshot = state.screenshots[index];
  if (!screenshot) return;

  // Get current tab ID to return to later
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Store screenshot for annotation editor along with return info
  chrome.storage.local.set({
    [ANNOTATION_DATA_KEY]: {
      screenshot: screenshot,
      completed: false,
      returnTabId: currentTab?.id || null,
      editIndex: index  // Track which screenshot we're editing
    }
  }, () => {
    // Open annotation editor in new tab
    chrome.tabs.create({
      url: chrome.runtime.getURL("annotate.html")
    });
  });
}

function removeScreenshot(index) {
  state.screenshots.splice(index, 1);
  saveSession();
  renderGrid();
  updateGenerateBtn();
}

// ── Steps ─────────────────────────────────────────────────────────────────────
function updateSteps() {
  const s1 = $("step-1"), s2 = $("step-2"), s3 = $("step-3");
  [s1, s2, s3].forEach(s => { s.className = "step"; });
  if (state.screenshots.length === 0) {
    s1.classList.add("active");
  } else if (!noteInput.value.trim()) {
    s1.classList.add("done"); s2.classList.add("active");
  } else {
    s1.classList.add("done"); s2.classList.add("done"); s3.classList.add("active");
  }
}

// ── Capture ───────────────────────────────────────────────────────────────────
const ANNOTATION_DATA_KEY = "bugReporterAnnotationData";

btnCapture.addEventListener("click", async () => {
  if (state.screenshots.length >= MAX_SCREENSHOTS) {
    showError(`Max ${MAX_SCREENSHOTS} screenshots. Remove one first.`); return;
  }
  btnCapture.disabled = true;
  btnCapture.textContent = "Capturing…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT" });
    if (res?.ok) {
      state.screenshots.push(res.dataUrl);
      saveSession(); renderGrid(); updateGenerateBtn(); clearError();
    } else {
      showError("Screenshot failed: " + (res?.error || "unknown"));
    }
  } catch (e) {
    showError("Screenshot failed: " + e.message);
  } finally {
    btnCapture.disabled = false;
    btnCapture.innerHTML = `<span>📸</span> Capture current screen <span class="shortcut">click</span>`;
  }
});

// ── Capture & Annotate ────────────────────────────────────────────────────────
btnAnnotate.addEventListener("click", async () => {
  if (state.screenshots.length >= MAX_SCREENSHOTS) {
    showError(`Max ${MAX_SCREENSHOTS} screenshots. Remove one first.`); return;
  }
  btnAnnotate.disabled = true;
  btnAnnotate.textContent = "Capturing…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT" });
    if (res?.ok) {
      // Get current tab ID to return to later
      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

      // Store screenshot for annotation editor along with return tab info
      chrome.storage.local.set({
        [ANNOTATION_DATA_KEY]: {
          screenshot: res.dataUrl,
          completed: false,
          returnTabId: currentTab?.id || null
        }
      }, () => {
        // Open annotation editor in new tab
        chrome.tabs.create({
          url: chrome.runtime.getURL("annotate.html")
        });
      });
    } else {
      showError("Screenshot failed: " + (res?.error || "unknown"));
    }
  } catch (e) {
    showError("Screenshot failed: " + e.message);
  } finally {
    btnAnnotate.disabled = false;
    btnAnnotate.innerHTML = `<span>✏️</span> Capture & Annotate <span class="shortcut">crop/mark</span>`;
  }
});

// ── Video Recording ───────────────────────────────────────────────────────────
const VIDEO_RECORDING_KEY = "bugReporterVideoRecording";

btnRecord.addEventListener("click", async () => {
  // Get current tab to inject controls into
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!currentTab || currentTab.url.startsWith("chrome://") || currentTab.url.startsWith("chrome-extension://")) {
    showError("Cannot record on this page. Navigate to a regular website first.");
    return;
  }

  // Store target tab ID for recorder to use
  chrome.storage.local.set({
    [VIDEO_RECORDING_KEY]: {
      targetTabId: currentTab.id,
      isRecording: false
    }
  }, () => {
    // Open dedicated recording page in new tab
    chrome.tabs.create({
      url: chrome.runtime.getURL("recorder.html")
    });
  });
});

// Check for completed video recording when popup opens
async function checkVideoRecording() {
  return new Promise((resolve) => {
    chrome.storage.local.get(VIDEO_RECORDING_KEY, (result) => {
      const data = result[VIDEO_RECORDING_KEY];
      if (data && data.videoBlobBase64) {
        // Restore video blob URL from base64
        const binaryStr = atob(data.videoBlobBase64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: 'video/webm' });
        state.videoBlobUrl = URL.createObjectURL(blob);

        // Show video preview (video is NOT sent to AI - only for download)
        videoPreview.style.display = "block";
        btnRecord.style.display = "none";
        videoInfoText.textContent = "🎬 Video recorded (download to attach)";

        // Add transcript to notes if available
        if (data.transcript && data.transcript.trim()) {
          const existingNotes = noteInput.value.trim();
          const transcriptText = `[Voice transcript] ${data.transcript.trim()}`;

          if (existingNotes) {
            noteInput.value = existingNotes + "\n\n" + transcriptText;
          } else {
            noteInput.value = transcriptText;
          }
          saveSession();
          updateGenerateBtn();
          showToast("Voice transcript added to notes!", "info");
        }

        showToast("Video ready for download!", "success");

        // Clear the recording data from storage (blob URL stays in memory)
        chrome.storage.local.remove(VIDEO_RECORDING_KEY);
      }
      resolve();
    });
  });
}

// Download video
btnDownloadVideo.addEventListener("click", () => {
  downloadVideo();
});

// Download video from result panel
btnResultDownloadVideo.addEventListener("click", () => {
  downloadVideo();
});

function downloadVideo() {
  if (!state.videoBlobUrl) {
    showToast("No video available to download", "error");
    return;
  }

  // Create download link
  const a = document.createElement("a");
  a.href = state.videoBlobUrl;
  a.download = `bug-recording-${Date.now()}.webm`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  showToast("Video downloaded!", "success");
}

// Delete video
btnDeleteVideo.addEventListener("click", async () => {
  const confirmed = await showConfirmDialog(
    "Delete Video?",
    "Remove the recorded video?",
    "Delete"
  );
  if (!confirmed) return;

  // Revoke blob URL to free memory
  if (state.videoBlobUrl) {
    URL.revokeObjectURL(state.videoBlobUrl);
    state.videoBlobUrl = null;
  }

  // Reset UI
  videoPreview.style.display = "none";
  btnRecord.style.display = "block";

  showToast("Video deleted", "info");
});

// ── Clear all screenshots ──────────────────────────────────────────────────
btnClearAll.addEventListener("click", async () => {
  const count = state.screenshots.length;
  if (count === 0) return;

  const confirmed = await showConfirmDialog(
    "Clear All Screenshots?",
    `Remove all ${count} screenshots? This cannot be undone.`,
    "Clear All"
  );
  if (!confirmed) return;

  state.screenshots = [];
  saveSession();
  renderGrid();
  updateGenerateBtn();
  showToast(`${count} screenshots cleared`, "info");
});

// ── Generate ──────────────────────────────────────────────────────────────────
function updateGenerateBtn() {
  const hasScreenshots = state.screenshots.length > 0;
  const hasNotes = noteInput.value.trim().length > 0;
  const canGenerate = hasScreenshots || hasNotes; // Allow either screenshots OR notes

  btnGenerate.disabled = !canGenerate;
  if (canGenerate) {
    btnGenerate.innerHTML = `<span>✨</span> Generate Ticket`;
  } else {
    btnGenerate.innerHTML = `<span>📝</span> Add screenshot or notes first`;
  }
}

btnGenerate.addEventListener("click", async () => {
  const hasScreenshots = state.screenshots.length > 0;
  const hasNotes = noteInput.value.trim().length > 0;

  if (!hasScreenshots && !hasNotes) return;
  setLoading(true); clearError();

  const fullNote = [
    noteInput.value.trim(),
    state.enabledFields.includes("component") && fieldComp.value.trim() ? `Component/Area: ${fieldComp.value.trim()}` : "",
    state.enabledFields.includes("severity") ? `Severity: ${fieldSev.value}` : ""
  ].filter(Boolean).join("\n");

  // Get screen info
  const screenInfo = `${window.screen.width}x${window.screen.height} (viewport: ${window.innerWidth}x${window.innerHeight})`;

  try {
    const res = await chrome.runtime.sendMessage({
      type: "GENERATE_TICKET",
      payload: {
        screenshots: state.screenshots,
        audioNote: fullNote,
        pageUrl: state.pageUrl,
        pageTitle: state.pageTitle,
        screenInfo
      }
    });
    if (res?.ok && res.generationId) {
      // Generation started in background - store ID and start polling
      state.currentGenerationId = res.generationId;
      loadingText.textContent = "Gemini is analyzing screenshots…";
      startGenerationPolling();
    } else if (res?.ok && res.ticket) {
      // Direct response (legacy support)
      showResult(res.ticket);
      setLoading(false);
      showToast("Ticket generated successfully!", "success");
    } else {
      setLoading(false);
      showError("Gemini error: " + (res?.error || "Check API key in Settings ⚙️"));
    }
  } catch (e) {
    setLoading(false);
    showError("Failed: " + e.message);
  }
});

// ── Result ────────────────────────────────────────────────────────────────────
function showResult(ticket) {
  resultTextarea.value = ticket;
  state.chatHistory = []; // Clear chat history for fresh generation
  displayResultPanel();

  // Save the result so it persists across popup close/reopen
  saveResult();
}

// Show result panel when restoring from saved state
function showRestoredResult() {
  displayResultPanel();
}

// Common function to display the result panel UI
function displayResultPanel() {
  capturePanel.style.display = "none";
  resultPanel.classList.add("visible");
  ["step-1","step-2","step-3"].forEach(id => $( id).className = "step done");

  // Populate edit inputs with current values
  editNote.value = noteInput.value;
  editComponent.value = fieldComp.value;
  editSeverity.value = fieldSev.value;

  // Show/hide edit fields based on settings
  const editCompGroup = $("edit-component-group");
  const editSevGroup = $("edit-severity-group");
  if (editCompGroup) editCompGroup.style.display = state.enabledFields.includes("component") ? "block" : "none";
  if (editSevGroup) editSevGroup.style.display = state.enabledFields.includes("severity") ? "block" : "none";

  // Reset expanded state
  inputEditSection.classList.remove("expanded");

  // Render chat history
  renderChatHistory();

  // Show screenshot previews if there are screenshots
  const screenshotsContainer = $("result-screenshots");
  const screenshotsGrid = $("result-screenshots-grid");
  if (state.screenshots.length > 0) {
    screenshotsGrid.innerHTML = "";
    state.screenshots.forEach((src, i) => {
      const img = document.createElement("img");
      img.src = src;
      img.alt = `Screenshot ${i + 1}`;
      img.title = `Screenshot ${i + 1} - Click to copy`;
      img.style.cssText = "max-width: 110px; height: auto; border-radius: 4px; border: 1px solid var(--border); cursor: pointer;";
      img.addEventListener("click", () => copyImageToClipboard(src, i + 1));
      screenshotsGrid.appendChild(img);
    });
    screenshotsContainer.style.display = "block";
  } else {
    screenshotsContainer.style.display = "none";
  }

  // Show video download button if video is available
  if (resultVideo) {
    resultVideo.style.display = state.videoBlobUrl ? "block" : "none";
  }
}

// Copy a single image to clipboard
async function copyImageToClipboard(dataUrl, index) {
  try {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    await navigator.clipboard.write([
      new ClipboardItem({ [blob.type]: blob })
    ]);
    showToast(`Screenshot ${index} copied!`, "success");
  } catch (err) {
    // Fallback: open image in new tab for manual copy
    showToast("Right-click the image and select 'Copy image'", "error");
  }
}

function showCopyFeedback(msg) {
  btnCopy.textContent = msg;
  btnCopy.classList.add("copied");
  setTimeout(() => { btnCopy.innerHTML = "⎘ Copy"; btnCopy.classList.remove("copied"); }, 2000);
}

btnCopy.addEventListener("click", async () => {
  try {
    // Try to copy as rich HTML with images for rich text editors
    const textContent = resultTextarea.value;

    // Create HTML version with embedded images
    let htmlContent = textContent
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/\n/g, '<br>');

    // Try to write both HTML and plain text to clipboard
    const textBlob = new Blob([textContent], { type: 'text/plain' });
    const htmlBlob = new Blob([htmlContent], { type: 'text/html' });

    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': textBlob,
        'text/html': htmlBlob
      })
    ]);

    showCopyFeedback("✓ Copied!");
    showToast("Ticket copied to clipboard!", "success");
  } catch (err) {
    // Fallback to plain text copy
    await navigator.clipboard.writeText(resultTextarea.value);
    showCopyFeedback("✓ Copied!");
    showToast("Ticket copied to clipboard!", "success");
  }
});

btnRegen.addEventListener("click", () => {
  resultPanel.classList.remove("visible");
  capturePanel.style.display = "block";
  inputEditSection.classList.remove("expanded");
  btnGenerate.click();
});

// ── Input Edit Section Toggle ─────────────────────────────────────────────────
inputEditToggle.addEventListener("click", () => {
  inputEditSection.classList.toggle("expanded");
});

// ── Regenerate from Edit Section ──────────────────────────────────────────────
btnRegenEdit.addEventListener("click", async () => {
  if (state.screenshots.length === 0) return;

  // Update main inputs from edit fields
  noteInput.value = editNote.value;
  fieldComp.value = editComponent.value;
  fieldSev.value = editSeverity.value;
  saveSession();

  // Show loading state
  btnRegenEdit.disabled = true;
  btnRegenEdit.innerHTML = `<span>⏳</span> Regenerating…`;

  const fullNote = [
    editNote.value.trim(),
    state.enabledFields.includes("component") && editComponent.value.trim() ? `Component/Area: ${editComponent.value.trim()}` : "",
    state.enabledFields.includes("severity") ? `Severity: ${editSeverity.value}` : ""
  ].filter(Boolean).join("\n");

  const screenInfo = `${window.screen.width}x${window.screen.height} (viewport: ${window.innerWidth}x${window.innerHeight})`;

  try {
    const res = await chrome.runtime.sendMessage({
      type: "GENERATE_TICKET",
      payload: {
        screenshots: state.screenshots,
        audioNote: fullNote,
        pageUrl: state.pageUrl,
        pageTitle: state.pageTitle,
        screenInfo
      }
    });
    if (res?.ok) {
      resultTextarea.value = res.ticket;
      saveResult();
      inputEditSection.classList.remove("expanded");
      showToast("Ticket regenerated!", "success");
    } else {
      showToast("Error: " + (res?.error || "Failed to regenerate"), "error");
    }
  } catch (e) {
    showToast("Error: " + e.message, "error");
  } finally {
    btnRegenEdit.disabled = false;
    btnRegenEdit.innerHTML = `<span>✨</span> Regenerate Ticket`;
  }
});

btnReset.addEventListener("click", async () => {
  const confirmed = await showConfirmDialog(
    "Start New Report?",
    "This will clear all screenshots, notes, and the generated ticket. This cannot be undone.",
    "Clear All"
  );
  if (!confirmed) return;

  state.screenshots = [];
  state.hasRestoredResult = false;
  state.chatHistory = [];
  if (state.videoBlobUrl) {
    URL.revokeObjectURL(state.videoBlobUrl);
    state.videoBlobUrl = null;
  }
  noteInput.value = ""; fieldComp.value = ""; fieldSev.value = "Medium";
  resultTextarea.value = "";
  clearSession();
  resultPanel.classList.remove("visible");
  capturePanel.style.display = "block";
  $("result-screenshots").style.display = "none";
  if (resultVideo) resultVideo.style.display = "none";
  chatHistory.innerHTML = "";

  // Reset video UI
  videoPreview.style.display = "none";
  if (state.videoRecordingEnabled && btnRecord) {
    btnRecord.style.display = "block";
  }

  renderGrid(); updateGenerateBtn(); clearError();
  showToast("Bug report cleared", "info");
});

// ── Auth badge → open settings ────────────────────────────────────────────────
authBadge.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function setLoading(on) {
  btnGenerate.disabled = on;
  loadingBar.classList.toggle("visible", on);
  loadingText.classList.toggle("visible", on);
  btnGenerate.innerHTML = on ? `<span>⏳</span> Analyzing…` : `<span>✨</span> Generate Ticket`;
}
function showError(msg) { errorBox.textContent = msg; errorBox.classList.add("visible"); }
function clearError()   { errorBox.classList.remove("visible"); errorBox.textContent = ""; }

// Update clear button visibility based on note input content
function updateNoteInputClear() {
  if (noteInput.value.trim()) {
    noteInputWrap.classList.add("has-text");
  } else {
    noteInputWrap.classList.remove("has-text");
  }
}

// ── Toast Notifications ──────────────────────────────────────────────────────
function showToast(message, type = "info", duration = 3000) {
  const container = $("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("hiding");
    setTimeout(() => toast.remove(), 200);
  }, duration);
}

// ── Confirmation Dialog ──────────────────────────────────────────────────────
let dialogResolve = null;

function showConfirmDialog(title, message, confirmText = "Confirm") {
  return new Promise((resolve) => {
    dialogResolve = resolve;
    $("dialog-title").textContent = title;
    $("dialog-message").textContent = message;
    $("dialog-confirm").textContent = confirmText;
    $("dialog-overlay").classList.add("visible");
  });
}

$("dialog-cancel").addEventListener("click", () => {
  $("dialog-overlay").classList.remove("visible");
  if (dialogResolve) dialogResolve(false);
});

$("dialog-confirm").addEventListener("click", () => {
  $("dialog-overlay").classList.remove("visible");
  if (dialogResolve) dialogResolve(true);
});

// ── Image Preview Modal ──────────────────────────────────────────────────────
let previewIndex = 0;

function showPreview(index) {
  if (state.screenshots.length === 0) return;
  previewIndex = index;
  updatePreview();
  $("preview-modal").classList.add("visible");
}

function updatePreview() {
  $("preview-image").src = state.screenshots[previewIndex];
  $("preview-counter").textContent = `${previewIndex + 1} / ${state.screenshots.length}`;
}

$("preview-modal").addEventListener("click", (e) => {
  if (e.target === $("preview-modal")) {
    $("preview-modal").classList.remove("visible");
  }
});

$("preview-close").addEventListener("click", () => {
  $("preview-modal").classList.remove("visible");
});

$("preview-prev").addEventListener("click", (e) => {
  e.stopPropagation();
  previewIndex = (previewIndex - 1 + state.screenshots.length) % state.screenshots.length;
  updatePreview();
});

$("preview-next").addEventListener("click", (e) => {
  e.stopPropagation();
  previewIndex = (previewIndex + 1) % state.screenshots.length;
  updatePreview();
});

// Keyboard navigation for preview
document.addEventListener("keydown", (e) => {
  if ($("preview-modal").classList.contains("visible")) {
    if (e.key === "Escape") $("preview-modal").classList.remove("visible");
    if (e.key === "ArrowLeft") $("preview-prev").click();
    if (e.key === "ArrowRight") $("preview-next").click();
  }
});

// ── Chat with AI ──────────────────────────────────────────────────────────────
function renderChatHistory() {
  chatHistory.innerHTML = "";
  state.chatHistory.forEach(msg => {
    const div = document.createElement("div");
    div.className = `chat-message ${msg.role}`;
    div.textContent = msg.content;
    chatHistory.appendChild(div);
  });
  // Scroll to bottom
  chatHistory.scrollTop = chatHistory.scrollHeight;
}

btnImprove.addEventListener("click", async () => {
  const feedback = chatInput.value.trim();
  if (!feedback) return;
  if (!resultTextarea.value) return;

  // Add user message to chat
  state.chatHistory.push({ role: "user", content: feedback });
  renderChatHistory();
  chatInput.value = "";

  // Show loading state
  btnImprove.disabled = true;
  btnImprove.classList.add("loading");
  btnImprove.innerHTML = "<span>⟳</span>";

  try {
    const res = await chrome.runtime.sendMessage({
      type: "IMPROVE_TICKET",
      payload: {
        currentTicket: resultTextarea.value,
        feedback,
        chatHistory: state.chatHistory,
        screenshots: state.screenshots
      }
    });

    if (res?.ok && res.ticket) {
      // Add AI response to chat
      state.chatHistory.push({ role: "ai", content: "Ticket updated ✓" });
      renderChatHistory();

      // Update ticket
      resultTextarea.value = res.ticket;
      saveResult();
      showToast("Ticket improved!", "success");
    } else {
      state.chatHistory.push({ role: "ai", content: "Error: " + (res?.error || "Failed") });
      renderChatHistory();
      showToast("Error: " + (res?.error || "Failed"), "error");
    }
  } catch (e) {
    state.chatHistory.push({ role: "ai", content: "Error: " + e.message });
    renderChatHistory();
    showToast("Error: " + e.message, "error");
  } finally {
    btnImprove.disabled = false;
    btnImprove.classList.remove("loading");
    btnImprove.innerHTML = "<span>↑</span>";
  }
});

// Allow Enter to send (Shift+Enter for newline)
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    btnImprove.click();
  }
});

init();
