// gif-recording-controls.js — Floating GIF recording controls injected into the page being recorded

(function() {
  // Prevent multiple injections
  if (window.__bugReporterGifRecordingControls) return;
  window.__bugReporterGifRecordingControls = true;

  let recordingTime = 0;
  let timerInterval = null;

  const chip = document.createElement("div");
  chip.id = "bugreporter-gif-recording-chip";
  chip.innerHTML = `
    <style>
      #bugreporter-gif-recording-chip {
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
      #bugreporter-gif-recording-chip .rec-indicator {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #bugreporter-gif-recording-chip .rec-dot {
        width: 10px;
        height: 10px;
        background: #7c3aed;
        border-radius: 50%;
        animation: bugreporter-gif-pulse 1.5s infinite;
      }
      @keyframes bugreporter-gif-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }
      #bugreporter-gif-recording-chip .rec-timer {
        font-family: 'SF Mono', Monaco, monospace;
        font-size: 14px;
        font-weight: 600;
        min-width: 78px;
      }
      #bugreporter-gif-recording-chip .rec-btn {
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
        background: #f87171;
        color: #fff;
      }
      #bugreporter-gif-recording-chip .rec-btn:hover {
        transform: scale(1.1);
      }
      #bugreporter-gif-recording-chip .rec-divider {
        width: 1px;
        height: 20px;
        background: #2a2a33;
      }
      #bugreporter-gif-recording-chip .rec-label {
        font-size: 10px;
        color: #6b6b7a;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
    </style>
    <div class="rec-indicator">
      <div class="rec-dot"></div>
      <span class="rec-label">GIF</span>
    </div>
    <span class="rec-timer" id="bugreporter-gif-rec-timer">00:00 / 00:12</span>
    <div class="rec-divider"></div>
    <button class="rec-btn" id="bugreporter-gif-btn-stop" title="Stop">⏹</button>
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

  function updateTimer() {
    recordingTime++;
    const minutes = Math.floor(recordingTime / 60).toString().padStart(2, "0");
    const seconds = (recordingTime % 60).toString().padStart(2, "0");
    const el = document.getElementById("bugreporter-gif-rec-timer");
    if (el) el.textContent = `${minutes}:${seconds} / 00:12`;
  }

  timerInterval = setInterval(updateTimer, 1000);

  const btnStop = document.getElementById("bugreporter-gif-btn-stop");
  btnStop.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "GIF_RECORDING_CONTROL", action: "stop" });
    removeChip();
  });

  function removeChip() {
    if (timerInterval) clearInterval(timerInterval);
    chip.remove();
    window.__bugReporterGifRecordingControls = false;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "REMOVE_GIF_RECORDING_CONTROLS") {
      removeChip();
    }
  });
})();
