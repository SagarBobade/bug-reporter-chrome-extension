// offscreen.js — Handles desktop capture stream → screenshot conversion

console.log("[Offscreen] Script loaded and ready");

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const messageReceivedTime = Date.now();
  console.log("[Offscreen] Received message:", msg.type, "at", messageReceivedTime);
  
  if (msg.type === "PING") {
    sendResponse({ ok: true, message: "pong" });
    return true;
  }
  
  if (msg.type === "OFFSCREEN_CAPTURE") {
    const delay = msg.timestamp ? messageReceivedTime - msg.timestamp : 0;
    console.log(`[Offscreen] Message delay: ${delay}ms (from background to offscreen)`);

    captureFrame(msg.streamId, msg.timestamp)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "OFFSCREEN_START_GIF") {
    startGifCapture(msg.streamId, msg.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "GIF_RECORDING_CONTROL" && msg.action === "stop") {
    stopGifCapture();
    return;
  }
});

async function captureFrame(streamId, originTimestamp) {
  const startTime = performance.now();
  const absoluteStartTime = Date.now();
  const totalDelay = originTimestamp ? absoluteStartTime - originTimestamp : 0;
  
  console.log("[Offscreen] captureFrame called at", absoluteStartTime);
  console.log(`[Offscreen] Total delay from streamId received to captureFrame: ${totalDelay}ms`);
  console.log("[Offscreen] StreamId:", streamId);
  
  if (!streamId) {
    throw new Error("No streamId provided");
  }
  
  let stream;
  try {
    // CRITICAL: Call getUserMedia IMMEDIATELY - streamIds expire in ~1 second
    // Try BOTH modern and legacy constraint formats
    
    const getUserMediaStart = performance.now();
    console.log(`[Offscreen] Calling getUserMedia ${getUserMediaStart - startTime}ms after captureFrame called`);
    
    // Try modern format first (without mandatory wrapper)
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: streamId,
        },
      });
      console.log("[Offscreen] Success with modern constraints format");
    } catch (modernErr) {
      console.log("[Offscreen] Modern format failed, trying legacy format:", modernErr.name);
      // Fallback to legacy format with mandatory
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: streamId,
          },
        },
      });
      console.log("[Offscreen] Success with legacy constraints format");
    }
    
    const getUserMediaEnd = performance.now();
    console.log(`[Offscreen] getUserMedia completed in ${getUserMediaEnd - getUserMediaStart}ms`);
    console.log("[Offscreen] Media stream obtained, tracks:", stream.getVideoTracks().length);
    
    if (stream.getVideoTracks().length === 0) {
      throw new Error("No video tracks in stream");
    }
  } catch (err) {
    const errorTime = performance.now();
    console.error(`[Offscreen] getUserMedia failed after ${errorTime - startTime}ms:`, {
      name: err.name,
      message: err.message,
      streamId: streamId,
      error: err
    });
    
    // Provide helpful error messages based on error type
    let errorMsg = `getUserMedia failed: ${err.name}`;
    if (err.name === "NotAllowedError") {
      errorMsg += " - Permission denied or streamId expired";
    } else if (err.name === "NotFoundError") {
      errorMsg += " - Media source not found";
    } else if (err.name === "AbortError") {
      errorMsg += " - Request aborted (streamId expired or capture was cancelled)";
    } else if (err.message) {
      errorMsg += ` - ${err.message}`;
    }
    throw new Error(errorMsg);
  }

  const video = document.createElement("video");
  video.srcObject = stream;
  video.autoplay = true;
  video.muted = true;

  try {
    // Wait for video metadata to load
    await new Promise((resolve) => {
      video.onloadedmetadata = resolve;
    });
    console.log("[Offscreen] Video metadata loaded");

    // Explicitly play the video
    await video.play();
    console.log("[Offscreen] Video playing");

    // Wait for the video to actually start playing and have frame data
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Video playback timeout after 3 seconds"));
      }, 3000);

      video.onplaying = () => {
        clearTimeout(timeout);
        // Wait one more frame to ensure the frame is rendered
        requestAnimationFrame(() => resolve());
      };
    });
    console.log("[Offscreen] Video frame ready");

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    // Validate dimensions before drawing
    if (canvas.width === 0 || canvas.height === 0) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error(`Invalid video dimensions: ${canvas.width}x${canvas.height}`);
    }
    console.log(`[Offscreen] Canvas dimensions: ${canvas.width}x${canvas.height}`);

    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0);

    // Stop all tracks immediately
    stream.getTracks().forEach((t) => t.stop());
    console.log("[Offscreen] Screenshot captured successfully");

    return canvas.toDataURL("image/png");
  } catch (err) {
    // Clean up stream if it was created
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
    console.error("[Offscreen] Capture failed:", err);
    throw err;
  }
}

// ── GIF Recording (tab capture) ──────────────────────────────────────────────
const GIF_RECORDING_KEY = "bugReporterGifRecording";
const GIF_FPS = 12;              // frames captured per second
const GIF_MAX_SECONDS = 12;      // auto-stop to keep file size reasonable at HD resolution
const GIF_MAX_WIDTH = 1280;      // 720p-wide cap — downscale only tabs larger than this
const GIF_QUALITY = 5;           // gif.js quantizer sample interval — lower = better colors, slower encode

let gifStream = null;
let gifVideoEl = null;
let gifCanvas = null;
let gifCtx = null;
let gifEncoder = null;
let gifCaptureInterval = null;
let gifTimeout = null;
let gifTabId = null;

async function startGifCapture(streamId, tabId) {
  gifTabId = tabId;

  try {
    gifStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
          // Ask for a full-HD source so a small/default tabCapture resolution isn't the
          // ceiling — we downscale to GIF_MAX_WIDTH ourselves below for file size, so
          // there's no minWidth here to avoid upscaling a genuinely small browser window.
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: GIF_FPS,
        },
      },
    });
  } catch (err) {
    console.error("[Offscreen] Failed to start tab capture for GIF:", err);
    await safeSetGifState({ isRecording: false, error: err.message });
    throw err;
  }

  gifVideoEl = document.createElement("video");
  gifVideoEl.srcObject = gifStream;
  gifVideoEl.muted = true;
  await new Promise((resolve) => { gifVideoEl.onloadedmetadata = resolve; });
  await gifVideoEl.play();

  const scale = Math.min(1, GIF_MAX_WIDTH / gifVideoEl.videoWidth);
  gifCanvas = document.createElement("canvas");
  gifCanvas.width = Math.round(gifVideoEl.videoWidth * scale) || GIF_MAX_WIDTH;
  gifCanvas.height = Math.round(gifVideoEl.videoHeight * scale) || 720;
  // willReadFrequently: the GIF encoder repeatedly reads pixel data back from this
  // canvas (frame quantization) — hinting that up front avoids Chrome's readback warning
  // and keeps each addFrame() call on the faster software-readback path.
  gifCtx = gifCanvas.getContext("2d", { willReadFrequently: true });

  gifEncoder = new GIF({
    workers: 4,
    quality: GIF_QUALITY,
    width: gifCanvas.width,
    height: gifCanvas.height,
    workerScript: chrome.runtime.getURL("lib/gif.worker.js"),
  });

  gifEncoder.on("finished", (blob) => finishGifCapture(blob));

  const startTime = Date.now();
  gifCaptureInterval = setInterval(() => {
    gifCtx.drawImage(gifVideoEl, 0, 0, gifCanvas.width, gifCanvas.height);
    gifEncoder.addFrame(gifCtx, { copy: true, delay: 1000 / GIF_FPS });
  }, 1000 / GIF_FPS);

  gifTimeout = setTimeout(() => stopGifCapture(), GIF_MAX_SECONDS * 1000);

  gifStream.getVideoTracks()[0].onended = () => stopGifCapture();

  await safeSetGifState({ isRecording: true, startTime, targetTabId: tabId });
}

function stopGifCapture() {
  if (!gifCaptureInterval) return; // already stopped/rendering

  clearInterval(gifCaptureInterval);
  gifCaptureInterval = null;
  clearTimeout(gifTimeout);
  gifTimeout = null;

  if (gifStream) {
    gifStream.getTracks().forEach((t) => t.stop());
    gifStream = null;
  }

  // Distinct from "isRecording" so a popup reopened during encoding shows an accurate
  // "rendering" status instead of stale "recording" text with no stop control to use.
  safeSetGifState({ isRecording: false, rendering: true, startTime: Date.now() });
  try { chrome.runtime.sendMessage({ type: "GIF_RECORDING_RENDERING" }); } catch (e) { /* ignore */ }

  // gif.js has no built-in timeout — if its worker never fires "finished" (a crashed
  // worker, say), the recording would otherwise be stuck in "rendering" forever with
  // no way for the user to recover except manually clearing storage.
  const renderTimeout = setTimeout(() => {
    console.error("[Offscreen] GIF render timed out");
    safeSetGifState({ isRecording: false, rendering: false, error: "GIF rendering timed out. Please try again." });
    try { chrome.runtime.sendMessage({ type: "GIF_RECORDING_ERROR", tabId: gifTabId, error: "GIF rendering timed out. Please try again." }); } catch (e) { /* ignore */ }
    if (gifVideoEl) { gifVideoEl.remove(); }
    gifVideoEl = null;
    gifCanvas = null;
    gifCtx = null;
    gifEncoder = null;
    gifTabId = null;
  }, 45000);

  gifEncoder.once("finished", () => clearTimeout(renderTimeout));
  gifEncoder.render();
}

async function finishGifCapture(blob) {
  const tabId = gifTabId;
  const base64 = await blobToBase64(blob);

  await safeSetGifState({
    isRecording: false,
    rendering: false,
    completed: true,
    gifBlobBase64: base64,
    savedAt: Date.now()
  });

  try { chrome.runtime.sendMessage({ type: "GIF_RECORDING_FINISHED", tabId }); } catch (e) { /* ignore */ }

  if (gifVideoEl) { gifVideoEl.remove(); }
  gifVideoEl = null;
  gifCanvas = null;
  gifCtx = null;
  gifEncoder = null;
  gifTabId = null;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// chrome.storage is unreliable to call directly from an offscreen document (it can be
// missing entirely in some Chrome builds even though chrome.runtime works fine there) —
// so persistence is delegated to the background service worker, which we know can
// always reach chrome.storage, via a plain runtime message instead.
function safeSetGifState(data) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "SAVE_GIF_STATE", data }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          console.warn("[Offscreen] Failed to persist GIF recording state:", chrome.runtime.lastError?.message || res?.error);
        }
        resolve();
      });
    } catch (err) {
      console.warn("[Offscreen] Failed to persist GIF recording state:", err);
      resolve();
    }
  });
}
