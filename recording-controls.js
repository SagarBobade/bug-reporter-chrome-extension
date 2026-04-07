// recording-controls.js — Floating recording controls injected into the page being recorded

(function() {
  // Prevent multiple injections
  if (window.__bugReporterRecordingControls) return;
  window.__bugReporterRecordingControls = true;

  // State
  let isPaused = false;
  let recordingTime = 0;
  let timerInterval = null;

  // Create floating chip
  const chip = document.createElement("div");
  chip.id = "bugreporter-recording-chip";
  chip.innerHTML = `
    <style>
      #bugreporter-recording-chip {
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        background: #141418;
        border: 1px solid #2a2a33;
        border-radius: 30px;
        padding: 8px 16px;
        display: flex;
        align-items: center;
        gap: 12px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        color: #f0f0f5;
        box-shadow: 0 4px 20px rgba(0,0,0,0.4);
        user-select: none;
        cursor: move;
      }
      #bugreporter-recording-chip .rec-indicator {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #bugreporter-recording-chip .rec-dot {
        width: 10px;
        height: 10px;
        background: #f87171;
        border-radius: 50%;
        animation: bugreporter-pulse 1.5s infinite;
      }
      #bugreporter-recording-chip .rec-dot.paused {
        background: #fbbf24;
        animation: none;
      }
      @keyframes bugreporter-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }
      #bugreporter-recording-chip .rec-timer {
        font-family: 'SF Mono', Monaco, monospace;
        font-size: 14px;
        font-weight: 600;
        min-width: 48px;
      }
      #bugreporter-recording-chip .rec-btn {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        transition: all 0.2s;
      }
      #bugreporter-recording-chip .rec-btn:hover {
        transform: scale(1.1);
      }
      #bugreporter-recording-chip .rec-btn.pause {
        background: #fbbf24;
        color: #000;
      }
      #bugreporter-recording-chip .rec-btn.play {
        background: #4ade80;
        color: #000;
      }
      #bugreporter-recording-chip .rec-btn.stop {
        background: #f87171;
        color: #fff;
      }
      #bugreporter-recording-chip .rec-btn.restart {
        background: #6b6b7a;
        color: #fff;
      }
      #bugreporter-recording-chip .rec-divider {
        width: 1px;
        height: 20px;
        background: #2a2a33;
      }
      #bugreporter-recording-chip .rec-label {
        font-size: 10px;
        color: #6b6b7a;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
    </style>
    <div class="rec-indicator">
      <div class="rec-dot" id="bugreporter-rec-dot"></div>
      <span class="rec-label">REC</span>
    </div>
    <span class="rec-timer" id="bugreporter-rec-timer">00:00</span>
    <div class="rec-divider"></div>
    <button class="rec-btn pause" id="bugreporter-btn-pause" title="Pause">⏸</button>
    <button class="rec-btn stop" id="bugreporter-btn-stop" title="Stop">⏹</button>
    <button class="rec-btn restart" id="bugreporter-btn-restart" title="Restart">↺</button>
  `;

  document.body.appendChild(chip);

  // Make chip draggable
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  chip.addEventListener("mousedown", (e) => {
    if (e.target.classList.contains("rec-btn")) return;
    isDragging = true;
    const rect = chip.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    chip.style.cursor = "grabbing";
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    chip.style.left = (e.clientX - dragOffsetX) + "px";
    chip.style.bottom = "auto";
    chip.style.top = (e.clientY - dragOffsetY) + "px";
    chip.style.transform = "none";
  });

  document.addEventListener("mouseup", () => {
    isDragging = false;
    chip.style.cursor = "move";
  });

  // Timer
  function updateTimer() {
    if (!isPaused) {
      recordingTime++;
    }
    const minutes = Math.floor(recordingTime / 60).toString().padStart(2, "0");
    const seconds = (recordingTime % 60).toString().padStart(2, "0");
    document.getElementById("bugreporter-rec-timer").textContent = `${minutes}:${seconds}`;
  }

  timerInterval = setInterval(updateTimer, 1000);

  // Button handlers
  const btnPause = document.getElementById("bugreporter-btn-pause");
  const btnStop = document.getElementById("bugreporter-btn-stop");
  const btnRestart = document.getElementById("bugreporter-btn-restart");
  const recDot = document.getElementById("bugreporter-rec-dot");

  btnPause.addEventListener("click", () => {
    isPaused = !isPaused;
    if (isPaused) {
      btnPause.textContent = "▶";
      btnPause.classList.remove("pause");
      btnPause.classList.add("play");
      btnPause.title = "Resume";
      recDot.classList.add("paused");
    } else {
      btnPause.textContent = "⏸";
      btnPause.classList.remove("play");
      btnPause.classList.add("pause");
      btnPause.title = "Pause";
      recDot.classList.remove("paused");
    }
    // Notify recorder
    chrome.runtime.sendMessage({ type: "RECORDING_CONTROL", action: isPaused ? "pause" : "resume" });
  });

  btnStop.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "RECORDING_CONTROL", action: "stop" });
    removeChip();
  });

  btnRestart.addEventListener("click", () => {
    recordingTime = 0;
    isPaused = false;
    btnPause.textContent = "⏸";
    btnPause.classList.remove("play");
    btnPause.classList.add("pause");
    recDot.classList.remove("paused");
    chrome.runtime.sendMessage({ type: "RECORDING_CONTROL", action: "restart" });
  });

  function removeChip() {
    if (timerInterval) clearInterval(timerInterval);
    chip.remove();
    window.__bugReporterRecordingControls = false;
  }

  // Listen for messages to remove chip
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "REMOVE_RECORDING_CONTROLS") {
      removeChip();
    }
  });
})();
