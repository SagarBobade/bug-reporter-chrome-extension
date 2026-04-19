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
