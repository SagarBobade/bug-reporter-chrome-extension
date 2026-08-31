// annotate.js — Screenshot annotation editor

const ANNOTATION_DATA_KEY = "bugReporterAnnotationData";

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  originalImage: null,
  currentTool: "draw",
  color: "#ff6b35",
  fontSize: 48, // Maximum font size by default
  lineWidth: 12, // Derived from fontSize
  isDrawing: false,
  startX: 0,
  startY: 0,
  history: [],
  historyIndex: -1,
  cropStart: null,
  cropEnd: null,
  zoom: 1,
  clipboard: null,
  // New state for interactive annotations
  annotations: [],
  selectedAnnotation: null,
  resizeHandle: null,
  isDragging: false,
  dragOffset: { x: 0, y: 0 },
  currentStroke: [], // For freehand drawing
};

// ── Geometry helpers ─────────────────────────────────────────────────────────
function pointInTriangle(px, py, p1, p2, p3) {
  const sign = (ax, ay, bx, by, cx, cy) => (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
  const d1 = sign(px, py, p1.x, p1.y, p2.x, p2.y);
  const d2 = sign(px, py, p2.x, p2.y, p3.x, p3.y);
  const d3 = sign(px, py, p3.x, p3.y, p1.x, p1.y);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

// ── Annotation Classes ──────────────────────────────────────────────────────
class Annotation {
  constructor(type, x, y, color, lineWidth) {
    this.type = type;
    this.x = x;
    this.y = y;
    this.color = color;
    this.lineWidth = lineWidth;
    this.selected = false;
    this.id = Date.now() + Math.random();
  }

  getBounds() {
    return { x: this.x, y: this.y, width: 0, height: 0 };
  }

  isPointInside(x, y) {
    const bounds = this.getBounds();
    return x >= bounds.x && x <= bounds.x + bounds.width &&
           y >= bounds.y && y <= bounds.y + bounds.height;
  }

  draw(ctx) {
    // Override in subclasses
  }

  drawSelection(ctx) {
    if (!this.selected) return;
    const bounds = this.getBounds();
    
    // Selection outline
    ctx.strokeStyle = "#4f46e5";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.strokeRect(bounds.x - 5, bounds.y - 5, bounds.width + 10, bounds.height + 10);
    ctx.setLineDash([]);

    // Resize handles
    const handles = this.getResizeHandles();
    handles.forEach(handle => {
      ctx.fillStyle = "#4f46e5";
      ctx.fillRect(handle.x - 4, handle.y - 4, 8, 8);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.strokeRect(handle.x - 4, handle.y - 4, 8, 8);
    });
  }

  getResizeHandles() {
    const bounds = this.getBounds();
    return [
      { x: bounds.x, y: bounds.y, type: 'nw' }, // northwest
      { x: bounds.x + bounds.width, y: bounds.y, type: 'ne' }, // northeast  
      { x: bounds.x, y: bounds.y + bounds.height, type: 'sw' }, // southwest
      { x: bounds.x + bounds.width, y: bounds.y + bounds.height, type: 'se' }, // southeast
    ];
  }

  getResizeHandleAt(x, y) {
    if (!this.selected) return null;
    const handles = this.getResizeHandles();
    // Tolerance is in canvas (full-resolution) coordinates, but the canvas is
    // usually displayed scaled down to fit the viewport — a fixed pixel
    // tolerance here would shrink to just 1-2 screen pixels on a large
    // screenshot, making handles nearly impossible to actually click (a miss
    // falls through to "start drawing a new shape" instead of resizing).
    // Scale the tolerance so it's a consistent ~10 screen pixels regardless
    // of the screenshot's resolution/zoom.
    const tolerance = 10 / (state.displayScale || 1);
    for (let handle of handles) {
      if (Math.hypot(x - handle.x, y - handle.y) <= tolerance) {
        return handle;
      }
    }
    return null;
  }
}

class RectAnnotation extends Annotation {
  constructor(x, y, width, height, color, lineWidth) {
    super('rect', x, y, color, lineWidth);
    this.width = width;
    this.height = height;
  }

  getBounds() {
    return { 
      x: Math.min(this.x, this.x + this.width),
      y: Math.min(this.y, this.y + this.height),
      width: Math.abs(this.width), 
      height: Math.abs(this.height) 
    };
  }

  draw(ctx) {
    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.lineWidth;
    ctx.strokeRect(this.x, this.y, this.width, this.height);
  }

  resize(handle, deltaX, deltaY) {
    if (handle.type === 'se') {
      this.width += deltaX;
      this.height += deltaY;
    } else if (handle.type === 'nw') {
      this.x += deltaX;
      this.y += deltaY; 
      this.width -= deltaX;
      this.height -= deltaY;
    } else if (handle.type === 'ne') {
      this.y += deltaY;
      this.width += deltaX;
      this.height -= deltaY;
    } else if (handle.type === 'sw') {
      this.x += deltaX;
      this.width -= deltaX;
      this.height += deltaY;
    }
  }
}

class ArrowAnnotation extends Annotation {
  constructor(x1, y1, x2, y2, color, lineWidth) {
    super('arrow', x1, y1, color, lineWidth);
    this.x2 = x2;
    this.y2 = y2;
  }

  getBounds() {
    return {
      x: Math.min(this.x, this.x2),
      y: Math.min(this.y, this.y2),
      width: Math.abs(this.x2 - this.x),
      height: Math.abs(this.y2 - this.y)
    };
  }

  // Hit-test the actual line (within a tolerance) plus the visible arrowhead
  // triangle — not the bounding box (clicking anywhere in the empty space
  // around a diagonal arrow shouldn't select it), but also not JUST the thin
  // shaft (the arrowhead is visually wide; a click anywhere on it should
  // still count as "clicking the arrow", not fall through to drawing a new one).
  isPointInside(x, y) {
    const dx = this.x2 - this.x, dy = this.y2 - this.y;
    const lengthSq = dx * dx + dy * dy;
    let t = lengthSq === 0 ? 0 : ((x - this.x) * dx + (y - this.y) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    const closestX = this.x + t * dx, closestY = this.y + t * dy;
    const shaftDistance = Math.hypot(x - closestX, y - closestY);
    const shaftTolerance = Math.max(10, this.lineWidth);
    if (shaftDistance <= shaftTolerance) return true;

    const headLength = Math.max(8, this.lineWidth * 3);
    const angle = Math.atan2(dy, dx);
    const headP1 = { x: this.x2, y: this.y2 };
    const headP2 = {
      x: this.x2 - headLength * Math.cos(angle - Math.PI / 6),
      y: this.y2 - headLength * Math.sin(angle - Math.PI / 6)
    };
    const headP3 = {
      x: this.x2 - headLength * Math.cos(angle + Math.PI / 6),
      y: this.y2 - headLength * Math.sin(angle + Math.PI / 6)
    };
    return pointInTriangle(x, y, headP1, headP2, headP3);
  }

  drawPass(ctx, strokeStyle, fillStyle, lineWidth) {
    const headLength = Math.max(8, lineWidth * 3);
    const angle = Math.atan2(this.y2 - this.y, this.x2 - this.x);

    ctx.strokeStyle = strokeStyle;
    ctx.fillStyle = fillStyle;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";

    ctx.beginPath();
    ctx.moveTo(this.x, this.y);
    ctx.lineTo(this.x2, this.y2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(this.x2, this.y2);
    ctx.lineTo(
      this.x2 - headLength * Math.cos(angle - Math.PI / 6),
      this.y2 - headLength * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      this.x2 - headLength * Math.cos(angle + Math.PI / 6),
      this.y2 - headLength * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
  }

  draw(ctx) {
    // Dark halo pass first so the arrow stays legible over any background
    // color (light or dark screenshots), then the real colored arrow on top —
    // the same trick tools like Skitch/CleanShot use.
    this.drawPass(ctx, "rgba(0,0,0,0.35)", "rgba(0,0,0,0.35)", this.lineWidth + 4);
    this.drawPass(ctx, this.color, this.color, this.lineWidth);
  }

  // Two draggable endpoints (start/end) instead of the generic 4-corner
  // bounding-box handles — matches how Figma/PowerPoint let you drag either
  // end of a line directly, and is far more intuitive than corner-resize
  // semantics for a line shape.
  getResizeHandles() {
    return [
      { x: this.x, y: this.y, type: 'start' },
      { x: this.x2, y: this.y2, type: 'end' }
    ];
  }

  drawSelection(ctx) {
    if (!this.selected) return;
    this.getResizeHandles().forEach(handle => {
      ctx.beginPath();
      ctx.arc(handle.x, handle.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = "#4f46e5";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }

  resize(handle, deltaX, deltaY) {
    if (handle.type === 'end') {
      this.x2 += deltaX;
      this.y2 += deltaY;
    } else if (handle.type === 'start') {
      this.x += deltaX;
      this.y += deltaY;
    }
  }
}

class DrawingAnnotation extends Annotation {
  constructor(color, lineWidth) {
    super('drawing', 0, 0, color, lineWidth);
    this.strokes = [];
    this.bounds = null;
  }

  addPoint(x, y) {
    this.strokes.push({ x, y });
    this.updateBounds();
  }

  updateBounds() {
    if (this.strokes.length === 0) return;
    
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    this.strokes.forEach(point => {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    });
    
    const padding = Math.max(5, this.lineWidth);
    this.bounds = { x: minX - padding, y: minY - padding, width: maxX - minX + padding * 2, height: maxY - minY + padding * 2 };
  }

  getBounds() {
    return this.bounds || { x: 0, y: 0, width: 0, height: 0 };
  }

  draw(ctx) {
    if (this.strokes.length < 2) return;
    
    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    
    ctx.beginPath();
    ctx.moveTo(this.strokes[0].x, this.strokes[0].y);
    for (let i = 1; i < this.strokes.length; i++) {
      ctx.lineTo(this.strokes[i].x, this.strokes[i].y);
    }
    ctx.stroke();
  }

  move(deltaX, deltaY) {
    this.strokes.forEach(stroke => {
      stroke.x += deltaX;
      stroke.y += deltaY;
    });
    this.updateBounds();
  }
}

class TextAnnotation extends Annotation {
  constructor(x, y, text, color, fontSize) {
    super('text', x, y, color, 1); // lineWidth not used for text
    this.text = text;
    this.fontSize = fontSize;
  }

  getBounds() {
    // Estimate text dimensions
    const width = this.text.length * this.fontSize * 0.6;
    const height = this.fontSize * 1.2;
    return { x: this.x, y: this.y - height + this.fontSize * 0.2, width, height };
  }

  isPointInside(x, y) {
    const bounds = this.getBounds();
    return x >= bounds.x && x <= bounds.x + bounds.width &&
           y >= bounds.y && y <= bounds.y + bounds.height;
  }

  draw(ctx) {
    if (this.editing) return; // being edited via the inline input overlay right now
    ctx.font = `${this.fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
    // Dark outline pass first so the text stays legible over any background —
    // plain fillText alone can vanish against a similarly-colored screenshot area.
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.lineWidth = Math.max(3, this.fontSize * 0.08);
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.strokeText(this.text, this.x, this.y);
    ctx.fillStyle = this.color;
    ctx.fillText(this.text, this.x, this.y);
  }

  move(deltaX, deltaY) {
    this.x += deltaX;
    this.y += deltaY;
  }

  // Single handle at the bottom-right scales font size on drag — lets you
  // resize text after placing it instead of only being able to move it.
  resize(handle, deltaX, deltaY) {
    if (handle.type === 'font') {
      this.fontSize = Math.round(Math.max(12, Math.min(160, this.fontSize + deltaX * 0.5)));
    }
  }

  getResizeHandles() {
    const bounds = this.getBounds();
    return [{ x: bounds.x + bounds.width, y: bounds.y + bounds.height, type: 'font' }];
  }
}

// ── DOM refs ─────────────────────────────────────────────────────────────────
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const canvasWrapper = document.querySelector(".canvas-wrapper");
const colorPicker = document.getElementById("color-picker");
const cropOverlay = document.getElementById("crop-overlay");
const cropSelection = document.getElementById("crop-selection");
const instructions = document.getElementById("instructions");

// ── Base layer ───────────────────────────────────────────────────────────────
// Holds the "baked" pixels — the original screenshot plus every committed
// annotation (freehand strokes, highlights, and any shape/text once committed).
// redrawCanvas() always repaints from this layer, then draws the still-editable
// (uncommitted) annotations on top. Keeping this as an offscreen canvas (rather
// than reloading an Image via dataURL/onload) means every commit updates it
// synchronously — no async race where a fast second stroke could start before
// the previous one was baked in, which is what caused strokes to vanish.
const baseCanvas = document.createElement("canvas");
const baseCtx = baseCanvas.getContext("2d");

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

    // Draw original image at full resolution — both on the visible canvas and
    // the base layer that redraws/history are built from.
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    baseCanvas.width = canvas.width;
    baseCanvas.height = canvas.height;
    baseCtx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // Initialize empty annotations array and save initial state
    state.annotations = [];
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

async function saveAnnotationResult(dataUrl, editIndex, fromResultPanel) {
  return new Promise((resolve) => {
    chrome.storage.local.set({
      [ANNOTATION_DATA_KEY]: {
        result: dataUrl,
        completed: true,
        editIndex,
        fromResultPanel
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
// Each entry captures the full state needed to restore this exact point: the
// baked pixel layer (as a dataURL), the canvas dimensions (these can change —
// e.g. after a crop), and the still-editable vector annotations on top of it.
function saveHistory() {
  // Remove any redo history beyond current point
  state.history = state.history.slice(0, state.historyIndex + 1);
  const historyData = {
    baseImage: baseCanvas.toDataURL("image/png"),
    width: canvas.width,
    height: canvas.height,
    annotations: JSON.parse(JSON.stringify(state.annotations))
  };
  state.history.push(JSON.stringify(historyData));
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

function restoreAnnotationsFromHistory(historyData) {
  state.annotations = historyData.annotations.map(data => {
    let annotation;
    if (data.type === 'rect') {
      annotation = new RectAnnotation(data.x, data.y, data.width, data.height, data.color, data.lineWidth);
    } else if (data.type === 'arrow') {
      annotation = new ArrowAnnotation(data.x, data.y, data.x2, data.y2, data.color, data.lineWidth);
    } else if (data.type === 'drawing') {
      annotation = new DrawingAnnotation(data.color, data.lineWidth);
      annotation.strokes = data.strokes;
      annotation.updateBounds();
    } else if (data.type === 'text') {
      annotation = new TextAnnotation(data.x, data.y, data.text, data.color, data.fontSize);
    }
    if (annotation) {
      annotation.id = data.id;
    }
    return annotation;
  }).filter(Boolean);
}

function loadHistoryState() {
  const historyData = JSON.parse(state.history[state.historyIndex]);

  const img = new Image();
  img.onload = () => {
    // Resize both layers to match this history entry (dimensions can differ
    // across a crop) before repainting the base layer from it.
    canvas.width = historyData.width;
    canvas.height = historyData.height;
    baseCanvas.width = historyData.width;
    baseCanvas.height = historyData.height;
    baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
    baseCtx.drawImage(img, 0, 0);

    const displayScale = state.displayScale || 1;
    const displayWidth = Math.round(historyData.width * displayScale) + "px";
    const displayHeight = Math.round(historyData.height * displayScale) + "px";
    canvas.style.width = displayWidth;
    canvas.style.height = displayHeight;
    canvasWrapper.style.width = displayWidth;
    canvasWrapper.style.height = displayHeight;

    restoreAnnotationsFromHistory(historyData);
    clearSelection();
    redrawCanvas();
  };
  img.src = historyData.baseImage;
}

function redrawCanvas() {
  if (!baseCanvas.width) return;

  // Clear and repaint from the baked layer
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(baseCanvas, 0, 0);

  // Draw all still-editable annotations
  state.annotations.forEach(annotation => {
    annotation.draw(ctx);
  });

  // Draw selections
  state.annotations.forEach(annotation => {
    annotation.drawSelection(ctx);
  });
}

function commitAnnotationToCanvas(annotation) {
  // Draw the annotation permanently — onto both the visible canvas and the
  // base layer, synchronously, so it's immediately part of every future
  // redraw (no async reload race that could make it vanish).
  annotation.draw(ctx);
  annotation.draw(baseCtx);
  // Remove from interactive annotations array since it's now part of the canvas
  const index = state.annotations.indexOf(annotation);
  if (index > -1) {
    state.annotations.splice(index, 1);
  }
  // Save the current state to history
  saveHistory();
  // Clear selection
  clearSelection();
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

  // Undo/Redo buttons
  document.getElementById("btn-undo").addEventListener("click", undo);
  document.getElementById("btn-redo").addEventListener("click", redo);

  // Clear button
  document.getElementById("btn-clear").addEventListener("click", () => {
    // Clear all annotations and reset to the true original screenshot —
    // restoring its original dimensions too, in case a crop had shrunk the canvas.
    state.annotations = [];
    clearSelection();
    if (state.originalImage) {
      canvas.width = state.originalImage.width;
      canvas.height = state.originalImage.height;
      baseCanvas.width = state.originalImage.width;
      baseCanvas.height = state.originalImage.height;

      const displayScale = state.displayScale || 1;
      const displayWidth = Math.round(canvas.width * displayScale) + "px";
      const displayHeight = Math.round(canvas.height * displayScale) + "px";
      canvas.style.width = displayWidth;
      canvas.style.height = displayHeight;
      canvasWrapper.style.width = displayWidth;
      canvasWrapper.style.height = displayHeight;

      baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
      baseCtx.drawImage(state.originalImage, 0, 0, canvas.width, canvas.height);
      redrawCanvas();
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

// ── Annotation Management ───────────────────────────────────────────────────
function clearSelection() {
  state.annotations.forEach(annotation => annotation.selected = false);
  state.selectedAnnotation = null;
  state.resizeHandle = null;
  updateInstructions();
  updateCursor();
}

function selectAnnotation(annotation) {
  clearSelection();
  annotation.selected = true;
  state.selectedAnnotation = annotation;
  updateInstructions();
  redrawCanvas();
}

function getAnnotationAt(x, y) {
  // Check from top to bottom (reverse order)
  for (let i = state.annotations.length - 1; i >= 0; i--) {
    const annotation = state.annotations[i];
    if (annotation.isPointInside(x, y)) {
      return annotation;
    }
  }
  return null;
}

function updateCursor() {
  if (state.resizeHandle) {
    const cursors = {
      'nw': 'nw-resize',
      'ne': 'ne-resize',
      'sw': 'sw-resize',
      'se': 'se-resize',
      'start': 'crosshair',
      'end': 'crosshair',
      'font': 'nwse-resize'
    };
    canvas.style.cursor = cursors[state.resizeHandle.type] || 'default';
  } else if (state.selectedAnnotation && !state.isDrawing) {
    canvas.style.cursor = 'move';
  } else if (state.currentTool === 'text') {
    canvas.style.cursor = 'text';
  } else {
    canvas.style.cursor = 'crosshair';
  }
}

function updateInstructions() {
  const toolInstructions = {
    draw: "Click and drag to draw freehand lines",
    line: "Click and drag to draw a straight line",
    arrow: "Click and drag to draw an arrow (hold Shift to snap to 45°). Click an arrow to select it, then drag either end to reposition it.",
    rect: "Click and drag to draw a rectangle. Click rectangles to select, move, or resize them.",
    circle: "Click and drag to draw a circle",
    highlight: "Click and drag to highlight an area (semi-transparent)",
    blur: "Click and drag to blur/pixelate an area for privacy",
    text: "Click to place text, then type your text. Double-click existing text to edit it. Drag the bottom-right handle to resize.",
    crop: "Click and drag to select area to crop"
  };
  
  let instruction = toolInstructions[state.currentTool] || "";
  if (state.selectedAnnotation) {
    if (state.selectedAnnotation.type === 'text') {
      instruction += " • Press Enter to commit • Delete to remove • Drag to move • Drag corner to resize • Double-click to edit text";
    } else if (state.selectedAnnotation.type === 'arrow') {
      instruction += " • Press Enter to commit • Delete to remove • Drag to move • Drag either end to reposition it";
    } else {
      instruction += " • Press Enter to commit • Delete to remove • Drag to move • Drag corners to resize";
    }
  }
  
  instructions.textContent = instruction;
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
  canvas.addEventListener("dblclick", (e) => {
    if (isTextInputActive()) return;
    const coords = getCanvasCoords(e);
    const annotation = getAnnotationAt(coords.x, coords.y);
    if (annotation && annotation.type === "text") {
      e.preventDefault();
      openTextEditor({ x: annotation.x, y: annotation.y, existing: annotation });
    }
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
  
  // Check if clicking on a resize handle first
  if (state.selectedAnnotation) {
    const handle = state.selectedAnnotation.getResizeHandleAt(coords.x, coords.y);
    if (handle) {
      state.resizeHandle = handle;
      state.isDrawing = true;
      state.startX = coords.x;
      state.startY = coords.y;
      return;
    }
  }
  
  // Check if clicking on an existing annotation
  const clickedAnnotation = getAnnotationAt(coords.x, coords.y);
  
  if (clickedAnnotation) {
    // Select and prepare for dragging existing annotation
    selectAnnotation(clickedAnnotation);
    state.isDragging = true;
    state.dragOffset = {
      x: coords.x - (clickedAnnotation.type === 'text' ? clickedAnnotation.x : clickedAnnotation.x),
      y: coords.y - (clickedAnnotation.type === 'text' ? clickedAnnotation.y : clickedAnnotation.y)
    };
    return;
  }
  
  // Clear selection if not clicking on annotation
  if (state.selectedAnnotation) {
    clearSelection();
    redrawCanvas();
  }
  
  // Only start drawing new shapes with specific tools
  if (state.currentTool !== 'draw' && state.currentTool !== 'highlight' && 
      state.currentTool !== 'rect' && state.currentTool !== 'arrow' && 
      state.currentTool !== 'text') {
    return;
  }

  state.isDrawing = true;
  state.startX = coords.x;
  state.startY = coords.y;

  if (state.currentTool === "draw" || state.currentTool === "highlight") {
    // Start new drawing annotation
    const highlightLineWidth = state.currentTool === "highlight" ? Math.max(8, state.lineWidth * 3) : state.lineWidth;
    const drawingAnnotation = new DrawingAnnotation(
      state.currentTool === "highlight" ? state.color + "60" : state.color,
      highlightLineWidth
    );
    drawingAnnotation.addPoint(coords.x, coords.y);
    state.annotations.push(drawingAnnotation);
    state.currentStroke = drawingAnnotation;
  }

  if (state.currentTool === "text") {
    e.preventDefault();
    e.stopPropagation();
    openTextEditor({ x: coords.x, y: coords.y });
    state.isDrawing = false;
  }
}

// Shared inline text-input overlay, used both for placing new text and for
// double-click-to-edit on an existing TextAnnotation.
function openTextEditor({ x, y, existing }) {
  const fontSize = existing ? existing.fontSize : state.fontSize;
  const color = existing ? existing.color : state.color;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "annotation-text-input";
  if (existing) input.value = existing.text;

  // Position in display (CSS) coordinates
  const displayScale = state.displayScale || 1;
  input.style.position = "absolute";
  input.style.left = (x / (canvas.width / canvas.getBoundingClientRect().width)) + "px";
  input.style.top = ((y - fontSize) / (canvas.height / canvas.getBoundingClientRect().height)) + "px";
  input.style.font = `${fontSize * displayScale}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
  input.style.color = color;
  input.style.background = "rgba(0,0,0,0.8)";
  input.style.border = "2px solid " + color;
  input.style.borderRadius = "4px";
  input.style.padding = "4px 8px";
  input.style.outline = "none";
  input.style.zIndex = "1000";
  input.style.minWidth = "200px";

  // Hide the existing annotation while its text is being edited so it isn't
  // drawn twice (once baked in the redraw, once live in the input overlay).
  if (existing) existing.editing = true;
  redrawCanvas();

  canvasWrapper.appendChild(input);
  input.focus();
  input.select();

  const commitText = () => {
    if (input._committed) return;
    input._committed = true;
    const text = input.value.trim();

    if (existing) {
      existing.editing = false;
      if (text) {
        existing.text = text;
      } else {
        const index = state.annotations.indexOf(existing);
        if (index > -1) state.annotations.splice(index, 1);
      }
      redrawCanvas();
      saveHistory();
    } else if (text) {
      const textAnnotation = new TextAnnotation(x, y, text, color, fontSize);
      state.annotations.push(textAnnotation);
      selectAnnotation(textAnnotation);
      redrawCanvas();
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
      if (existing) existing.editing = false;
      redrawCanvas();
      input.remove();
    }
  });

  input.addEventListener("blur", commitText);
}

function handleMouseMove(e) {
  const coords = getCanvasCoords(e);
  
  if (!state.isDrawing && !state.isDragging) {
    // Update cursor based on what's under mouse
    if (state.selectedAnnotation) {
      const handle = state.selectedAnnotation.getResizeHandleAt(coords.x, coords.y);
      if (handle) {
        state.resizeHandle = handle;
        updateCursor();
        return;
      } else {
        state.resizeHandle = null;
      }
    }
    
    const annotation = getAnnotationAt(coords.x, coords.y);
    if (annotation) {
      canvas.style.cursor = 'pointer';
    } else {
      updateCursor();
    }
    return;
  }

  if (state.resizeHandle && state.selectedAnnotation) {
    // Handle resizing
    const deltaX = coords.x - state.startX;
    const deltaY = coords.y - state.startY;
    state.selectedAnnotation.resize(state.resizeHandle, deltaX, deltaY);
    state.startX = coords.x;
    state.startY = coords.y;
    redrawCanvas();
    return;
  }

  if (state.isDragging && state.selectedAnnotation) {
    // Handle dragging
    const newX = coords.x - state.dragOffset.x;
    const newY = coords.y - state.dragOffset.y;
    
    if (state.selectedAnnotation.type === 'drawing') {
      const deltaX = newX - state.selectedAnnotation.getBounds().x;
      const deltaY = newY - state.selectedAnnotation.getBounds().y;
      state.selectedAnnotation.move(deltaX, deltaY);
    } else if (state.selectedAnnotation.type === 'text') {
      state.selectedAnnotation.x = newX;
      state.selectedAnnotation.y = newY;
    } else {
      state.selectedAnnotation.x = newX;
      state.selectedAnnotation.y = newY;
    }
    redrawCanvas();
    return;
  }

  if (!state.isDrawing) return;

  if (state.currentTool === "draw" || state.currentTool === "highlight") {
    if (state.currentStroke) {
      const prevPoint = state.currentStroke.strokes[state.currentStroke.strokes.length - 1];
      state.currentStroke.addPoint(coords.x, coords.y);
      // Draw just the new segment instead of a full clear+redraw — cheaper,
      // and doesn't touch the base layer until the stroke is actually committed.
      if (prevPoint) {
        ctx.strokeStyle = state.currentStroke.color;
        ctx.lineWidth = state.currentStroke.lineWidth;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(prevPoint.x, prevPoint.y);
        ctx.lineTo(coords.x, coords.y);
        ctx.stroke();
      }
    }
    return;
  }

  if (state.currentTool === "rect" || state.currentTool === "arrow") {
    // Live preview while dragging out a new shape — previously the shape was
    // invisible until mouseup, so you were drawing "blind."
    redrawCanvas();
    let endX = coords.x, endY = coords.y;
    if (state.currentTool === "arrow" && e.shiftKey) {
      ({ x: endX, y: endY } = snapArrowAngle(state.startX, state.startY, coords.x, coords.y));
    }
    if (state.currentTool === "rect") {
      const preview = new RectAnnotation(state.startX, state.startY, endX - state.startX, endY - state.startY, state.color, state.lineWidth);
      preview.draw(ctx);
    } else {
      const preview = new ArrowAnnotation(state.startX, state.startY, endX, endY, state.color, state.lineWidth);
      preview.draw(ctx);
    }
  }
}

// Hold Shift while drawing an arrow to snap it to 45° increments — common in
// mainstream annotation tools (Figma, PowerPoint) for pointing precisely.
function snapArrowAngle(startX, startY, x, y) {
  const dx = x - startX, dy = y - startY;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return { x, y };
  const snapIncrement = Math.PI / 4; // 45°
  const angle = Math.round(Math.atan2(dy, dx) / snapIncrement) * snapIncrement;
  return {
    x: startX + Math.cos(angle) * distance,
    y: startY + Math.sin(angle) * distance
  };
}

function handleMouseUp(e) {
  if (state.isDragging) {
    state.isDragging = false;
    redrawCanvas(); // Update the visual state
    saveHistory(); // Save after moving annotation
    return;
  }

  if (state.resizeHandle) {
    state.resizeHandle = null;
    redrawCanvas(); // Update the visual state
    saveHistory(); // Save after resizing annotation
    updateCursor();
    return;
  }

  if (!state.isDrawing) return;
  state.isDrawing = false;

  const coords = getCanvasCoords(e);

  if (state.currentTool === "rect") {
    const width = coords.x - state.startX;
    const height = coords.y - state.startY;
    if (Math.abs(width) > 5 || Math.abs(height) > 5) {
      const rectAnnotation = new RectAnnotation(state.startX, state.startY, width, height, state.color, state.lineWidth);
      state.annotations.push(rectAnnotation);
      selectAnnotation(rectAnnotation);
      redrawCanvas();
      saveHistory();
    }
  } else if (state.currentTool === "arrow") {
    let endX = coords.x, endY = coords.y;
    if (e.shiftKey) {
      ({ x: endX, y: endY } = snapArrowAngle(state.startX, state.startY, coords.x, coords.y));
    }
    // A plain click with no real drag has nothing to point at — skip it
    // instead of leaving a zero-length arrow (just an arrowhead triangle).
    const dragDistance = Math.hypot(endX - state.startX, endY - state.startY);
    if (dragDistance > 5) {
      const arrowAnnotation = new ArrowAnnotation(state.startX, state.startY, endX, endY, state.color, state.lineWidth);
      state.annotations.push(arrowAnnotation);
      selectAnnotation(arrowAnnotation);
      redrawCanvas();
      saveHistory();
    } else {
      redrawCanvas();
    }
  } else if (state.currentTool === "draw" || state.currentTool === "highlight") {
    if (state.currentStroke && state.currentStroke.strokes.length > 1) {
      // Commit drawing immediately to canvas since it can't be edited
      commitAnnotationToCanvas(state.currentStroke);
    }
    state.currentStroke = null;
  }

  updateCursor();
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

    // Draw cropped image onto both the visible canvas and the base layer,
    // synchronously — no async reload needed, so there's no window where a
    // fast follow-up action could run against stale (pre-crop) dimensions.
    ctx.putImageData(imageData, 0, 0);
    baseCanvas.width = canvasWidth;
    baseCanvas.height = canvasHeight;
    baseCtx.putImageData(imageData, 0, 0);

    // Any uncommitted annotations were positioned relative to the old,
    // uncropped canvas — their coordinates no longer make sense, so drop them.
    state.annotations = [];
    clearSelection();

    saveHistory();
    redrawCanvas();
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
    if (isTextInputActive()) return;

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
    // Delete or Backspace to remove selected annotation
    if ((e.key === "Delete" || e.key === "Backspace") && state.selectedAnnotation) {
      e.preventDefault();
      const index = state.annotations.indexOf(state.selectedAnnotation);
      if (index > -1) {
        state.annotations.splice(index, 1);
        clearSelection();
        redrawCanvas();
        saveHistory();
      }
    }
    // Enter to commit selected annotation to canvas
    if (e.key === "Enter" && state.selectedAnnotation) {
      e.preventDefault();
      commitAnnotationToCanvas(state.selectedAnnotation);
    }
    // Escape to clear selection or discard
    if (e.key === "Escape") {
      if (state.selectedAnnotation) {
        clearSelection();
        redrawCanvas();
      } else {
        clearAnnotationData().then(() => window.close());
      }
    }
    // Ctrl/Cmd+Enter to save
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      saveAndClose();
    }
  });
}

// ── Save and Close ───────────────────────────────────────────────────────────
async function saveAndClose() {
  // Clear selection before saving
  clearSelection();
  redrawCanvas();
  
  const dataUrl = canvas.toDataURL("image/png");

  // Get return tab ID and edit tracking info before updating storage
  const data = await getAnnotationData();
  const returnTabId = data?.returnTabId;

  await saveAnnotationResult(dataUrl, data?.editIndex, data?.fromResultPanel);
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
