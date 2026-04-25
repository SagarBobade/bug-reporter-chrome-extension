// annotate.js — Screenshot annotation editor

const ANNOTATION_DATA_KEY = "bugReporterAnnotationData";

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  originalImage: null,
  currentTool: "draw",
  color: "#ff6b35",
  lineWidth: 4,
  isDrawing: false,
  startX: 0,
  startY: 0,
  history: [],
  historyIndex: -1,
  cropStart: null,
  cropEnd: null,
};

// ── DOM refs ─────────────────────────────────────────────────────────────────
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const canvasWrapper = document.querySelector(".canvas-wrapper");
const colorPicker = document.getElementById("color-picker");
const sizeSlider = document.getElementById("size-slider");
const sizeValue = document.getElementById("size-value");
const cropOverlay = document.getElementById("crop-overlay");
const cropSelection = document.getElementById("crop-selection");
const instructions = document.getElementById("instructions");

// ── Initialize ───────────────────────────────────────────────────────────────
async function init() {
  // Get screenshot data from storage
  const data = await getAnnotationData();
  if (!data || !data.screenshot) {
    showToast("No screenshot data found", "error");
    return;
  }

  // Load the image
  const img = new Image();
  img.onload = () => {
    state.originalImage = img;

    // Set canvas size to full image resolution for HD quality
    // Display scaled down with CSS to fit viewport
    const maxWidth = window.innerWidth - 80;
    const maxHeight = window.innerHeight - 200;
    let displayScale = 1;

    if (img.width > maxWidth) displayScale = Math.min(displayScale, maxWidth / img.width);
    if (img.height > maxHeight) displayScale = Math.min(displayScale, maxHeight / img.height);

    // Canvas internal resolution = full image size (HD quality)
    canvas.width = img.width;
    canvas.height = img.height;

    // CSS display size = scaled to fit viewport
    state.displayScale = displayScale;
    const displayWidth = Math.round(img.width * displayScale);
    const displayHeight = Math.round(img.height * displayScale);
    canvas.style.width = displayWidth + "px";
    canvas.style.height = displayHeight + "px";

    // Lock wrapper size to prevent layout shifts from canvas intrinsic size
    canvasWrapper.style.width = displayWidth + "px";
    canvasWrapper.style.height = displayHeight + "px";

    // Draw original image at full resolution
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // Save initial state
    saveHistory();
  };
  img.src = data.screenshot;

  // Set up event listeners
  setupToolbar();
  setupCanvas();
  setupKeyboard();
}

// ── Storage ──────────────────────────────────────────────────────────────────
async function getAnnotationData() {
  return new Promise((resolve) => {
    chrome.storage.local.get(ANNOTATION_DATA_KEY, (result) => {
      resolve(result[ANNOTATION_DATA_KEY] || null);
    });
  });
}

async function saveAnnotationResult(dataUrl) {
  return new Promise((resolve) => {
    chrome.storage.local.set({
      [ANNOTATION_DATA_KEY]: {
        result: dataUrl,
        completed: true
      }
    }, resolve);
  });
}

async function clearAnnotationData() {
  return new Promise((resolve) => {
    chrome.storage.local.remove(ANNOTATION_DATA_KEY, resolve);
  });
}

// ── History (Undo/Redo) ──────────────────────────────────────────────────────
function saveHistory() {
  // Remove any redo history beyond current point
  state.history = state.history.slice(0, state.historyIndex + 1);
  // Save current canvas state
  state.history.push(canvas.toDataURL());
  state.historyIndex = state.history.length - 1;

  // Limit history size
  if (state.history.length > 30) {
    state.history.shift();
    state.historyIndex--;
  }
}

function undo() {
  if (state.historyIndex > 0) {
    state.historyIndex--;
    loadHistoryState();
  }
}

function redo() {
  if (state.historyIndex < state.history.length - 1) {
    state.historyIndex++;
    loadHistoryState();
  }
}

function loadHistoryState() {
  const img = new Image();
  img.onload = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
  };
  img.src = state.history[state.historyIndex];
}

// ── Toolbar Setup ────────────────────────────────────────────────────────────
function setupToolbar() {
  // Tool buttons
  document.querySelectorAll(".tool-btn[data-tool]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tool-btn[data-tool]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.currentTool = btn.dataset.tool;
      updateInstructions();

      // Show/hide crop overlay
      if (state.currentTool === "crop") {
        cropOverlay.classList.add("active");
      } else {
        cropOverlay.classList.remove("active");
      }
    });
  });

  // Color picker
  colorPicker.addEventListener("input", (e) => {
    state.color = e.target.value;
  });

  // Size slider
  sizeSlider.addEventListener("input", (e) => {
    state.lineWidth = parseInt(e.target.value);
    sizeValue.textContent = state.lineWidth;
  });

  // Undo/Redo buttons
  document.getElementById("btn-undo").addEventListener("click", undo);
  document.getElementById("btn-redo").addEventListener("click", redo);

  // Clear button
  document.getElementById("btn-clear").addEventListener("click", () => {
    if (state.originalImage) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(state.originalImage, 0, 0, canvas.width, canvas.height);
      saveHistory();
    }
  });

  // Save button
  document.getElementById("btn-save").addEventListener("click", saveAndClose);

  // Discard button
  document.getElementById("btn-discard").addEventListener("click", async () => {
    await clearAnnotationData();
    window.close();
  });
}

function updateInstructions() {
  const toolInstructions = {
    draw: "Click and drag to draw freehand lines",
    arrow: "Click and drag to draw an arrow",
    rect: "Click and drag to draw a rectangle",
    highlight: "Click and drag to highlight an area (semi-transparent)",
    text: "Click to place text, then type your text",
    crop: "Click and drag to select area to crop"
  };
  instructions.textContent = toolInstructions[state.currentTool] || "";
}

// ── Canvas Setup ─────────────────────────────────────────────────────────────
function isTextInputActive() {
  return document.activeElement && document.activeElement.tagName === "INPUT" && document.activeElement.classList.contains("annotation-text-input");
}

function setupCanvas() {
  canvas.addEventListener("mousedown", (e) => {
    if (isTextInputActive()) return;
    handleMouseDown(e);
  });
  canvas.addEventListener("mousemove", (e) => {
    if (isTextInputActive()) return;
    handleMouseMove(e);
  });
  canvas.addEventListener("mouseup", (e) => {
    if (isTextInputActive()) return;
    handleMouseUp(e);
  });
  canvas.addEventListener("mouseleave", (e) => {
    if (isTextInputActive()) return;
    handleMouseUp(e);
  });

  // Crop overlay events
  cropOverlay.addEventListener("mousedown", handleCropStart);
  cropOverlay.addEventListener("mousemove", handleCropMove);
  cropOverlay.addEventListener("mouseup", handleCropEnd);
}

function getCanvasCoords(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY
  };
}

function handleMouseDown(e) {
  const coords = getCanvasCoords(e);
  state.isDrawing = true;
  state.startX = coords.x;
  state.startY = coords.y;

  if (state.currentTool === "draw" || state.currentTool === "highlight") {
    ctx.beginPath();
    ctx.moveTo(coords.x, coords.y);
  }

  if (state.currentTool === "text") {
    e.preventDefault();
    e.stopPropagation();

    // Create inline text input overlay
    const input = document.createElement("input");
    input.type = "text";
    input.className = "annotation-text-input";
    // Position in display (CSS) coordinates
    const displayScale = state.displayScale || 1;
    input.style.position = "absolute";
    input.style.left = (coords.x / (canvas.width / canvas.getBoundingClientRect().width)) + "px";
    input.style.top = ((coords.y - state.lineWidth * 4) / (canvas.height / canvas.getBoundingClientRect().height)) + "px";
    const fontSize = state.lineWidth * 4;
    input.style.font = `${fontSize * displayScale}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
    input.style.color = state.color;
    input.style.background = "rgba(0,0,0,0.8)";
    input.style.border = "2px solid " + state.color;
    input.style.borderRadius = "4px";
    input.style.padding = "4px 8px";
    input.style.outline = "none";
    input.style.zIndex = "1000";
    input.style.minWidth = "200px";
    
    canvasWrapper.appendChild(input);
    input.focus();
    
    const commitText = () => {
      if (input._committed) return;
      input._committed = true;
      const text = input.value.trim();
      if (text) {
        ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
        ctx.fillStyle = state.color;
        ctx.fillText(text, coords.x, coords.y);
        saveHistory();
      }
      input.remove();
    };
    
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        commitText();
      } else if (e.key === "Escape") {
        e.preventDefault();
        input._committed = true;
        input.remove();
      }
    });
    
    input.addEventListener("blur", commitText);
    
    state.isDrawing = false;
  }
}

function handleMouseMove(e) {
  if (!state.isDrawing) return;

  const coords = getCanvasCoords(e);

  if (state.currentTool === "draw") {
    ctx.lineTo(coords.x, coords.y);
    ctx.strokeStyle = state.color;
    ctx.lineWidth = state.lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  } else if (state.currentTool === "highlight") {
    ctx.lineTo(coords.x, coords.y);
    ctx.strokeStyle = state.color + "60"; // Semi-transparent
    ctx.lineWidth = state.lineWidth * 5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }
}

function handleMouseUp(e) {
  if (!state.isDrawing) return;
  state.isDrawing = false;

  const coords = getCanvasCoords(e);

  if (state.currentTool === "rect") {
    ctx.strokeStyle = state.color;
    ctx.lineWidth = state.lineWidth;
    ctx.strokeRect(
      state.startX,
      state.startY,
      coords.x - state.startX,
      coords.y - state.startY
    );
    saveHistory();
  } else if (state.currentTool === "arrow") {
    drawArrow(state.startX, state.startY, coords.x, coords.y);
    saveHistory();
  } else if (state.currentTool === "draw" || state.currentTool === "highlight") {
    saveHistory();
  }
}

function drawArrow(fromX, fromY, toX, toY) {
  const headLength = state.lineWidth * 4;
  const angle = Math.atan2(toY - fromY, toX - fromX);

  ctx.strokeStyle = state.color;
  ctx.fillStyle = state.color;
  ctx.lineWidth = state.lineWidth;
  ctx.lineCap = "round";

  // Line
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(toX, toY);
  ctx.stroke();

  // Arrowhead
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(
    toX - headLength * Math.cos(angle - Math.PI / 6),
    toY - headLength * Math.sin(angle - Math.PI / 6)
  );
  ctx.lineTo(
    toX - headLength * Math.cos(angle + Math.PI / 6),
    toY - headLength * Math.sin(angle + Math.PI / 6)
  );
  ctx.closePath();
  ctx.fill();
}

// ── Crop Handling ────────────────────────────────────────────────────────────
function handleCropStart(e) {
  const rect = canvas.getBoundingClientRect();
  const offsetX = cropOverlay.getBoundingClientRect().left;
  const offsetY = cropOverlay.getBoundingClientRect().top;

  state.cropStart = {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top
  };
  state.isDrawing = true;

  cropSelection.style.left = state.cropStart.x + "px";
  cropSelection.style.top = state.cropStart.y + "px";
  cropSelection.style.width = "0";
  cropSelection.style.height = "0";
  cropSelection.style.display = "block";
}

function handleCropMove(e) {
  if (!state.isDrawing || !state.cropStart) return;

  const rect = canvas.getBoundingClientRect();
  const currentX = e.clientX - rect.left;
  const currentY = e.clientY - rect.top;

  const left = Math.min(state.cropStart.x, currentX);
  const top = Math.min(state.cropStart.y, currentY);
  const width = Math.abs(currentX - state.cropStart.x);
  const height = Math.abs(currentY - state.cropStart.y);

  cropSelection.style.left = left + "px";
  cropSelection.style.top = top + "px";
  cropSelection.style.width = width + "px";
  cropSelection.style.height = height + "px";
}

function handleCropEnd(e) {
  if (!state.isDrawing || !state.cropStart) return;
  state.isDrawing = false;

  const rect = canvas.getBoundingClientRect();
  const endX = e.clientX - rect.left;
  const endY = e.clientY - rect.top;

  const left = Math.min(state.cropStart.x, endX);
  const top = Math.min(state.cropStart.y, endY);
  const width = Math.abs(endX - state.cropStart.x);
  const height = Math.abs(endY - state.cropStart.y);

  if (width > 10 && height > 10) {
    // Scale display coords to canvas (full resolution) coords
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const canvasLeft = Math.round(left * scaleX);
    const canvasTop = Math.round(top * scaleY);
    const canvasWidth = Math.round(width * scaleX);
    const canvasHeight = Math.round(height * scaleY);

    // Get the cropped area at full resolution
    const imageData = ctx.getImageData(canvasLeft, canvasTop, canvasWidth, canvasHeight);

    // Resize canvas to crop size
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    // Update CSS display size
    const displayScale = state.displayScale || 1;
    const cropDisplayW = Math.round(canvasWidth * displayScale) + "px";
    const cropDisplayH = Math.round(canvasHeight * displayScale) + "px";
    canvas.style.width = cropDisplayW;
    canvas.style.height = cropDisplayH;
    canvasWrapper.style.width = cropDisplayW;
    canvasWrapper.style.height = cropDisplayH;

    // Draw cropped image
    ctx.putImageData(imageData, 0, 0);

    saveHistory();
    showToast("Area cropped!");
  }

  // Reset crop state
  cropSelection.style.display = "none";
  cropOverlay.classList.remove("active");
  state.cropStart = null;

  // Switch back to draw tool
  document.querySelector('[data-tool="draw"]').click();
}

// ── Keyboard Shortcuts ───────────────────────────────────────────────────────
function setupKeyboard() {
  document.addEventListener("keydown", (e) => {
    // Ctrl+Z or Cmd+Z for undo
    if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    }
    // Ctrl+Y or Cmd+Shift+Z for redo
    if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
      e.preventDefault();
      redo();
    }
    // Escape to discard
    if (e.key === "Escape" && !isTextInputActive()) {
      clearAnnotationData().then(() => window.close());
    }
    // Enter to save
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      saveAndClose();
    }
  });
}

// ── Save and Close ───────────────────────────────────────────────────────────
async function saveAndClose() {
  const dataUrl = canvas.toDataURL("image/png");

  // Get return tab ID before updating storage
  const data = await getAnnotationData();
  const returnTabId = data?.returnTabId;

  await saveAnnotationResult(dataUrl);
  showToast("Saved! Returning to popup...");

  setTimeout(async () => {
    // Focus on the original tab if available
    if (returnTabId) {
      try {
        await chrome.tabs.update(returnTabId, { active: true });
      } catch (e) {
        // Tab might be closed, that's okay
      }
    }
    // Close this annotation tab
    window.close();
  }, 500);
}

// ── Toast ────────────────────────────────────────────────────────────────────
function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("hiding");
    setTimeout(() => toast.remove(), 200);
  }, 2000);
}

// ── Start ────────────────────────────────────────────────────────────────────
init();
