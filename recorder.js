// recorder.js — Screen recording page

const VIDEO_RECORDING_KEY = "bugReporterVideoRecording";

// State
let mediaRecorder = null;
let recordedChunks = [];
let recordingStartTime = null;
let timerInterval = null;
let stream = null;
let webcamStream = null;
let compositeCanvas = null;
let compositeInterval = null;
let recognition = null;
let transcript = "";
let targetTabId = null;
let isPaused = false;
let recordingMimeType = "video/webm";
let recordingExtension = "webm";

// MP4 (H.264) MediaRecorder support varies by Chrome version/platform — prefer it when
// available so recordings are directly usable without a separate conversion step, but
// fall back to WebM (universally supported) rather than silently mislabeling the file.
function pickRecordingMimeType() {
  const candidates = [
    { mimeType: "video/mp4;codecs=avc1", extension: "mp4" },
    { mimeType: "video/mp4", extension: "mp4" },
    { mimeType: "video/webm;codecs=vp9", extension: "webm" },
    { mimeType: "video/webm", extension: "webm" }
  ];
  for (const candidate of candidates) {
    if (window.MediaRecorder?.isTypeSupported?.(candidate.mimeType)) {
      return candidate;
    }
  }
  return { mimeType: "video/webm", extension: "webm" };
}

// DOM elements
const preview = document.getElementById("preview");
const timer = document.getElementById("timer");
const btnStop = document.getElementById("btn-stop");
const btnSave = document.getElementById("btn-save");
const btnDownload = document.getElementById("btn-download");
const btnDiscard = document.getElementById("btn-discard");
const actionsRecording = document.getElementById("actions-recording");
const actionsDone = document.getElementById("actions-done");
const recordingStatus = document.getElementById("recording-status");
const subtitle = document.getElementById("subtitle");
const info = document.getElementById("info");
const recordingDot = document.getElementById("recording-dot");

// Initialize
async function init() {
  // Get target tab ID and settings from storage
  const [videoData, settingsData] = await Promise.all([
    new Promise(resolve => {
      chrome.storage.local.get(VIDEO_RECORDING_KEY, result => resolve(result[VIDEO_RECORDING_KEY] || {}));
    }),
    new Promise(resolve => {
      chrome.storage.local.get("bugReporterSettings", result => resolve(result.bugReporterSettings || {}));
    })
  ]);
  
  targetTabId = videoData.targetTabId;
  const captureDelay = videoData.captureDelay || 0;
  
  const webcamEnabled = settingsData.webcamEnabled || false;
  const webcamPosition = settingsData.webcamPosition || "bottom-right";
  const webcamSize = settingsData.webcamSize || 20;
  const recordingQuality = settingsData.recordingQuality || 720;

  try {
    // First, request screen capture - this shows the selection dialog
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { 
        cursor: "always",
        width: { ideal: recordingQuality * 16/9 },
        height: { ideal: recordingQuality }
      },
      audio: true
    });

    // After user selects screen/tab, apply delay if configured
    if (captureDelay > 0) {
      // Show countdown overlay on the selected screen
      await showCountdownOnSelectedScreen(captureDelay);
    }

    // Request webcam if enabled
    if (webcamEnabled) {
      try {
        webcamStream = await navigator.mediaDevices.getUserMedia({ 
          video: { 
            width: { ideal: 320 }, 
            height: { ideal: 240 } 
          } 
        });
      } catch (e) {
        console.warn("Webcam not available:", e);
        showToast("Webcam unavailable, recording without it", "warning");
      }
    }

    // Also get microphone for voice transcription
    let micStream = null;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.warn("Microphone access denied, continuing without voice transcription");
    }

    // Create composite stream if webcam is enabled
    let videoStream = stream;
    if (webcamEnabled && webcamStream) {
      videoStream = await createCompositeStream(stream, webcamStream, webcamPosition, webcamSize);
    } else {
      // Show regular preview
      preview.srcObject = stream;
    }

    // Combine audio streams if mic is available
    let combinedStream = videoStream;
    if (micStream) {
      const audioContext = new AudioContext();
      const dest = audioContext.createMediaStreamDestination();

      // Add screen audio if available
      if (stream.getAudioTracks().length > 0) {
        const screenAudio = audioContext.createMediaStreamSource(stream);
        screenAudio.connect(dest);
      }

      // Add mic audio
      const micAudio = audioContext.createMediaStreamSource(micStream);
      micAudio.connect(dest);

      // Create combined stream with video and combined audio
      combinedStream = new MediaStream([
        ...videoStream.getVideoTracks(),
        ...dest.stream.getAudioTracks()
      ]);

      // Start speech recognition for transcription
      startSpeechRecognition();
    }

    // Start recording
    const picked = pickRecordingMimeType();
    recordingMimeType = picked.mimeType;
    recordingExtension = picked.extension;
    mediaRecorder = new MediaRecorder(combinedStream, {
      mimeType: recordingMimeType
    });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        recordedChunks.push(e.data);
      }
    };

    mediaRecorder.onstop = () => {
      if (recognition) {
        recognition.stop();
      }
      if (compositeInterval) {
        clearInterval(compositeInterval);
      }
      if (webcamStream) {
        webcamStream.getTracks().forEach(track => track.stop());
      }
      // Clean up hidden video elements used for compositing
      document.querySelectorAll("video[style*='display: none']").forEach(v => v.remove());
      removeFloatingControls();
      showCompletedState();
    };

    mediaRecorder.start(1000);
    recordingStartTime = Date.now();

    // Update storage state
    chrome.storage.local.set({
      [VIDEO_RECORDING_KEY]: {
        isRecording: true,
        startTime: recordingStartTime,
        targetTabId: targetTabId
      }
    });

    // Start timer
    timerInterval = setInterval(updateTimer, 1000);

    // Inject floating controls into target tab
    injectFloatingControls();

    // Handle stream ending (user clicks "Stop sharing" in browser UI)
    stream.getVideoTracks()[0].onended = () => {
      stopRecording();
    };

    // Listen for control messages from floating chip
    chrome.runtime.onMessage.addListener(handleControlMessage);

  } catch (e) {
    if (e.name === "NotAllowedError") {
      // User cancelled
      window.close();
    } else {
      alert("Failed to start recording: " + e.message);
      window.close();
    }
  }
}

// Show countdown overlay on the selected screen
async function showCountdownOnSelectedScreen(delay) {
  try {
    // Check if we're recording a tab or the entire screen
    const videoTrack = stream.getVideoTracks()[0];
    const settings = videoTrack.getSettings();
    
    // If recording a specific tab, inject countdown there
    if (settings.displaySurface === 'browser' && targetTabId) {
      await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        func: showRecordingCountdown,
        args: [delay]
      });
      
      // Wait for countdown to complete
      await new Promise(resolve => setTimeout(resolve, (delay + 1) * 1000));
    } else {
      // For desktop/window recording, show countdown on recorder page
      recordingStatus.textContent = `Recording starts in ${delay} seconds...`;
      subtitle.textContent = "Get ready! Position your screen as needed.";
      
      for (let i = delay; i > 0; i--) {
        recordingStatus.textContent = `Recording starts in ${i} second${i > 1 ? 's' : ''}...`;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      recordingStatus.textContent = "Recording...";
    }
  } catch (error) {
    console.warn('Could not inject countdown, using fallback:', error);
    
    // Fallback countdown on recorder page
    for (let i = delay; i > 0; i--) {
      recordingStatus.textContent = `Recording starts in ${i} second${i > 1 ? 's' : ''}...`;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

// Function to inject countdown overlay on target page
function showRecordingCountdown(delay) {
  // Create countdown overlay
  const overlay = document.createElement('div');
  overlay.id = 'bug-reporter-countdown';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.8);
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: white;
    backdrop-filter: blur(4px);
  `;
  
  const content = document.createElement('div');
  content.style.cssText = `
    text-align: center;
    padding: 40px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 20px;
    border: 2px solid rgba(255, 255, 255, 0.2);
  `;
  
  const title = document.createElement('h2');
  title.textContent = 'Recording will start in';
  title.style.cssText = `
    font-size: 24px;
    margin-bottom: 20px;
    font-weight: 600;
  `;
  
  const counter = document.createElement('div');
  counter.style.cssText = `
    font-size: 72px;
    font-weight: bold;
    margin: 20px 0;
    color: #4f46e5;
    text-shadow: 0 0 20px rgba(79, 70, 229, 0.5);
  `;
  
  const subtitle = document.createElement('p');
  subtitle.textContent = 'Get ready! Position your screen as needed.';
  subtitle.style.cssText = `
    font-size: 16px;
    opacity: 0.8;
    margin-top: 20px;
  `;
  
  content.appendChild(title);
  content.appendChild(counter);
  content.appendChild(subtitle);
  overlay.appendChild(content);
  document.body.appendChild(overlay);
  
  // Animate countdown
  let remaining = delay;
  counter.textContent = remaining;
  
  const countdownInterval = setInterval(() => {
    remaining--;
    if (remaining > 0) {
      counter.textContent = remaining;
      // Add pulse animation
      counter.style.transform = 'scale(1.2)';
      setTimeout(() => {
        counter.style.transform = 'scale(1)';
      }, 150);
    } else {
      counter.textContent = 'Recording...';
      counter.style.color = '#10b981';
      title.textContent = 'Recording Started!';
      subtitle.textContent = 'This overlay will disappear in a moment.';
      
      // Remove overlay after brief "Recording..." message
      setTimeout(() => {
        overlay.remove();
      }, 1500);
      
      clearInterval(countdownInterval);
    }
  }, 1000);
}

// Create composite stream with webcam overlay
async function createCompositeStream(screenStream, webcamStream, position, sizePercent) {
  // Create canvas for compositing
  compositeCanvas = document.createElement("canvas");
  const ctx = compositeCanvas.getContext("2d");
  
  // Create video elements and append to DOM (required for rendering)
  const screenVideo = document.createElement("video");
  screenVideo.srcObject = screenStream;
  screenVideo.muted = true;
  screenVideo.playsInline = true;
  screenVideo.style.display = "none";
  document.body.appendChild(screenVideo);
  
  const webcamVideo = document.createElement("video");
  webcamVideo.srcObject = webcamStream;
  webcamVideo.muted = true;
  webcamVideo.playsInline = true;
  webcamVideo.style.display = "none";
  document.body.appendChild(webcamVideo);
  
  // Wait for metadata to load
  await Promise.all([
    new Promise(resolve => { screenVideo.onloadedmetadata = resolve; }),
    new Promise(resolve => { webcamVideo.onloadedmetadata = resolve; })
  ]);
  
  // Explicitly start playing both videos
  await Promise.all([
    screenVideo.play(),
    webcamVideo.play()
  ]);
  
  // Wait for actual video frames to be available
  await new Promise(resolve => {
    const checkReady = () => {
      if (screenVideo.readyState >= 2 && webcamVideo.readyState >= 2) {
        resolve();
      } else {
        requestAnimationFrame(checkReady);
      }
    };
    checkReady();
  });
  
  // Set canvas size to screen video size
  compositeCanvas.width = screenVideo.videoWidth;
  compositeCanvas.height = screenVideo.videoHeight;
  
  console.log(`Composite canvas: ${compositeCanvas.width}x${compositeCanvas.height}`);
  console.log(`Webcam video: ${webcamVideo.videoWidth}x${webcamVideo.videoHeight}`);
  
  // Calculate webcam dimensions
  const webcamWidth = Math.floor(compositeCanvas.width * (sizePercent / 100));
  const webcamHeight = Math.floor(webcamWidth * 3/4);
  
  // Calculate position based on settings
  let webcamX, webcamY;
  const margin = 20;
  if (position === "bottom-right") {
    webcamX = compositeCanvas.width - webcamWidth - margin;
    webcamY = compositeCanvas.height - webcamHeight - margin;
  } else if (position === "bottom-left") {
    webcamX = margin;
    webcamY = compositeCanvas.height - webcamHeight - margin;
  } else if (position === "top-right") {
    webcamX = compositeCanvas.width - webcamWidth - margin;
    webcamY = margin;
  } else { // top-left
    webcamX = margin;
    webcamY = margin;
  }
  
  // Composite frames at 30fps
  compositeInterval = setInterval(() => {
    // Draw screen video
    ctx.drawImage(screenVideo, 0, 0, compositeCanvas.width, compositeCanvas.height);
    
    // Draw webcam with rounded corners and border
    ctx.save();
    
    // Draw webcam border
    ctx.strokeStyle = "#4f46e5";
    ctx.lineWidth = 3;
    ctx.shadowColor = "rgba(79, 70, 229, 0.5)";
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.roundRect(webcamX - 2, webcamY - 2, webcamWidth + 4, webcamHeight + 4, 8);
    ctx.stroke();
    ctx.shadowBlur = 0;
    
    // Clip to rounded rect for webcam video
    ctx.beginPath();
    ctx.roundRect(webcamX, webcamY, webcamWidth, webcamHeight, 6);
    ctx.clip();
    
    // Draw webcam video
    ctx.drawImage(webcamVideo, webcamX, webcamY, webcamWidth, webcamHeight);
    ctx.restore();
  }, 1000/30);
  
  // Show composite in preview
  preview.srcObject = compositeCanvas.captureStream(30);
  
  // Return composite stream
  return compositeCanvas.captureStream(30);
}

// Inject floating controls into target tab
async function injectFloatingControls() {
  if (!targetTabId) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      files: ["recording-controls.js"]
    });
  } catch (e) {
    console.warn("Could not inject recording controls:", e);
  }
}

// Remove floating controls from target tab
async function removeFloatingControls() {
  if (!targetTabId) return;

  try {
    await chrome.tabs.sendMessage(targetTabId, { type: "REMOVE_RECORDING_CONTROLS" });
  } catch (e) {
    // Tab might be closed
  }
}

// Handle control messages from floating chip
function handleControlMessage(msg, sender, sendResponse) {
  if (msg.type !== "RECORDING_CONTROL") return;

  switch (msg.action) {
    case "pause":
      if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.pause();
        isPaused = true;
        recordingDot.style.animation = "none";
        recordingDot.style.background = "#fbbf24";
        subtitle.textContent = "Recording paused";
      }
      break;

    case "resume":
      if (mediaRecorder && mediaRecorder.state === "paused") {
        mediaRecorder.resume();
        isPaused = false;
        recordingDot.style.animation = "";
        recordingDot.style.background = "";
        subtitle.textContent = "Recording in progress. Speak to describe the bug!";
      }
      break;

    case "stop":
      stopRecording();
      break;

    case "restart":
      restartRecording();
      break;
  }
}

// Restart recording
function restartRecording() {
  recordedChunks = [];
  transcript = "";
  recordingStartTime = Date.now();
  isPaused = false;

  if (mediaRecorder && mediaRecorder.state === "paused") {
    mediaRecorder.resume();
  }

  recordingDot.style.animation = "";
  recordingDot.style.background = "";
  subtitle.textContent = "Recording restarted. Speak to describe the bug!";
}

// Speech recognition for voice transcription
function startSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    console.warn("Speech recognition not supported");
    return;
  }

  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";

  let finalTranscript = "";

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += t + " ";
      } else {
        interim = t;
      }
    }
    transcript = (finalTranscript + interim).trim();

    // Update subtitle to show transcription is working
    if (transcript && !isPaused) {
      subtitle.textContent = "Recording... Voice detected!";
    }
  };

  recognition.onerror = (e) => {
    if (e.error !== "aborted" && e.error !== "no-speech") {
      console.warn("Speech recognition error:", e.error);
    }
  };

  recognition.onend = () => {
    // Restart if still recording
    if (mediaRecorder && mediaRecorder.state === "recording") {
      try {
        recognition.start();
      } catch (e) { /* ignore */ }
    }
  };

  try {
    recognition.start();
  } catch (e) {
    console.warn("Could not start speech recognition:", e);
  }
}

function updateTimer() {
  if (isPaused) return;
  const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
  const minutes = Math.floor(elapsed / 60).toString().padStart(2, "0");
  const seconds = (elapsed % 60).toString().padStart(2, "0");
  timer.textContent = `${minutes}:${seconds}`;
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
  }
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function showCompletedState() {
  // Update UI
  actionsRecording.classList.add("hidden");
  actionsDone.classList.remove("hidden");
  recordingStatus.classList.add("completed");
  subtitle.textContent = "Recording complete! Review and trim if needed.";

  if (transcript) {
    info.innerHTML = `<strong>Voice transcript:</strong> "${transcript.substring(0, 100)}${transcript.length > 100 ? '...' : ''}"<br><br>Transcript will be added to notes. Download video for attachment.`;
  } else {
    info.textContent = "Review your recording. Use trimming controls to cut unwanted parts.";
  }

  // Create blob and show in preview
  const blob = new Blob(recordedChunks, { type: recordingMimeType });

  const url = URL.createObjectURL(blob);
  preview.srcObject = null;
  preview.src = url;
  preview.controls = true;
  
  // Show trimming UI immediately (even before video loads)
  createTrimUI();
  
  // Multiple event listeners to catch when video is ready
  let trimmingInitialized = false;
  
  const initTrimming = () => {
    if (trimmingInitialized) return;
    
    if (isFinite(preview.duration) && preview.duration > 0) {
      trimmingInitialized = true;
      
      // Clear any error messages immediately
      const statusEl = document.getElementById('trim-status');
      if (statusEl) {
        statusEl.textContent = 'Initializing trimming...';
        statusEl.style.color = '#10b981';
      }
      
      initVideoTrimming();
    }
  };
  
  // Try multiple events
  preview.addEventListener('loadedmetadata', initTrimming);
  preview.addEventListener('loadeddata', initTrimming);
  preview.addEventListener('canplay', initTrimming);
  
  // Fallback polling mechanism
  let attempts = 0;
  const pollForDuration = setInterval(() => {
    attempts++;
    
    if (isFinite(preview.duration) && preview.duration > 0) {
      clearInterval(pollForDuration);
      // Clear error message before initializing
      const statusEl = document.getElementById('trim-status');
      if (statusEl) {
        statusEl.textContent = 'Video loaded successfully!';
        statusEl.style.color = '#10b981';
      }
      initTrimming();
    } else if (attempts >= 10) {
      clearInterval(pollForDuration);
      // Update status to show error
      const statusEl = document.getElementById('trim-status');
      if (statusEl) {
        statusEl.textContent = 'Please wait while video metadata loads...';
        statusEl.style.color = '#ef4444';
      }
    }
  }, 500);
  
  // Error handling
  preview.addEventListener('error', (e) => {
    console.error('Video error:', e);
    clearInterval(pollForDuration);
  });

  // Update storage
  chrome.storage.local.set({
    [VIDEO_RECORDING_KEY]: {
      isRecording: false,
      completed: true
    }
  });

  // Focus this tab (recorder tab) to show the recorded video
  focusRecorderTab();
}

// Focus the recorder tab
async function focusRecorderTab() {
  try {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // Get this tab (recorder.html)
    const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL("recorder.html") });
    if (tabs.length > 0) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      await chrome.windows.update(tabs[0].windowId, { focused: true });
    }
  } catch (e) {
    console.warn("Could not focus recorder tab:", e);
  }
}

// Save recording
btnSave.addEventListener("click", async () => {
  btnSave.disabled = true;
  btnSave.innerHTML = "<span>⏳</span> Saving...";

  let blob = new Blob(recordedChunks, { type: recordingMimeType });

  // If trim metadata exists, create trimmed video
  if (window.trimMetadata) {
    btnSave.innerHTML = "<span>⏳</span> Creating trimmed video...";
    try {
      blob = await createTrimmedVideoBlob();
      console.log('Created trimmed video blob:', blob.size, 'bytes');
    } catch (error) {
      console.error('Failed to create trimmed video, using original:', error);
      showToast('Trim creation failed, saving original video');
      blob = new Blob(recordedChunks, { type: recordingMimeType });
    }
  }

  // Convert video blob to base64 for storage
  const videoBlobBase64 = await blobToBase64(blob);

  // Include trim metadata if available
  const saveData = {
    isRecording: false,
    completed: true,
    transcript: transcript || "",
    videoBlobBase64: videoBlobBase64,
    videoMimeType: recordingMimeType,
    videoExtension: recordingExtension,
    savedAt: Date.now()
  };

  // Add trim metadata if video was trimmed
  if (window.trimMetadata) {
    saveData.trimMetadata = window.trimMetadata;
  }

  // Store transcript and video blob in storage for popup to pick up
  chrome.storage.local.set({
    [VIDEO_RECORDING_KEY]: saveData
  }, () => {
    const message = window.trimMetadata ? 
      `Saved trimmed video (${formatTime(window.trimMetadata.duration)})!` : 
      "Saved! Return to Bug Reporter popup.";
    showToast(message);
    setTimeout(() => window.close(), 1500);
  });
});

// Convert blob to base64
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      // Remove data URL prefix to get raw base64
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Discard recording
btnDiscard.addEventListener("click", () => {
  removeFloatingControls();
  chrome.storage.local.remove(VIDEO_RECORDING_KEY, () => {
    window.close();
  });
});

// Download recording
btnDownload.addEventListener("click", async () => {
  btnDownload.disabled = true;
  btnDownload.innerHTML = "<span>⏳</span> Preparing...";
  
  let blob = new Blob(recordedChunks, { type: recordingMimeType });
  let filename = `bug-recording-${Date.now()}.${recordingExtension}`;

  // If trim metadata exists, create trimmed video
  if (window.trimMetadata) {
    btnDownload.innerHTML = "<span>⏳</span> Creating trimmed video...";
    try {
      blob = await createTrimmedVideoBlob();
      filename = `bug-recording-trimmed-${Date.now()}.${recordingExtension}`;
      console.log('Created trimmed video for download:', blob.size, 'bytes');
    } catch (error) {
      console.error('Failed to create trimmed video, downloading original:', error);
      showToast('Trim creation failed, downloading original video');
    }
  }
  
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  const message = window.trimMetadata ? 
    `Trimmed video downloaded (${formatTime(window.trimMetadata.duration)})!` : 
    "Video downloaded!";
  showToast(message);
  
  btnDownload.disabled = false;
  btnDownload.innerHTML = "<span>⬇</span> Download";
});

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);
}

// Stop button
btnStop.addEventListener("click", stopRecording);

// Handle page close
window.addEventListener("beforeunload", () => {
  removeFloatingControls();
  if (mediaRecorder && mediaRecorder.state === "recording") {
    chrome.storage.local.set({
      [VIDEO_RECORDING_KEY]: {
        isRecording: false,
        cancelled: true
      }
    });
  }
});

// Start
init();

// ── Video Trimming Functionality ─────────────────────────────────────────────
let trimState = {
  startTime: 0,
  endTime: 0,
  duration: 0,
  isDragging: false,
  dragType: null // 'start', 'end', or null
};

// Initialize video trimming after recording is complete
function initVideoTrimming() {
  // Video metadata should already be loaded when this is called
  // Set up initial trim state
  const duration = preview.duration;
  if (!isFinite(duration) || duration <= 0) {
    console.warn('Video duration invalid in initVideoTrimming:', duration);
    return;
  }
  
  trimState.duration = duration;
  trimState.startTime = 0;
  trimState.endTime = duration;
  
  // Update the UI
  updateTrimDisplay();
  updateTrimStatus();
  
  // Force clear any error messages that might be showing
  const statusEl = document.getElementById('trim-status');
  if (statusEl && statusEl.textContent.includes('Unable to load')) {
    statusEl.textContent = `Ready to trim! Video duration: ${formatTime(trimState.duration)}`;
    statusEl.style.color = '#10b981';
  }
  
  // Enable controls
  const resetBtn = document.getElementById('trim-reset-btn');
  const applyBtn = document.getElementById('trim-apply-btn');
  if (resetBtn) resetBtn.disabled = false;
  if (applyBtn) applyBtn.disabled = false;
}

// Update trim status message
function updateTrimStatus() {
  const statusEl = document.getElementById('trim-status');
  if (!statusEl) {
    console.warn('Trim status element not found');
    return;
  }
  
  // Always update status based on current state
  if (!isFinite(trimState.duration) || trimState.duration <= 0) {
    // Only show waiting message if we're not in an error state
    if (!statusEl.textContent.includes('Unable to load')) {
      statusEl.textContent = 'Waiting for video to load...';
      statusEl.style.color = '#fbbf24';
    }
    console.log('Trim status: waiting for video');
  } else {
    // Video is ready - clear any previous messages
    statusEl.textContent = `Ready to trim! Video duration: ${formatTime(trimState.duration)}`;
    statusEl.style.color = '#10b981';
    statusEl.style.fontWeight = 'normal';
    console.log('Trim status: ready, duration:', trimState.duration);
  }
}

// Create trimming UI elements
function createTrimUI() {
  // Check if already exists to prevent duplicates
  if (document.querySelector('.trim-section')) {
    return;
  }
  
  const trimSection = document.createElement('div');
  trimSection.className = 'trim-section';
  trimSection.innerHTML = `
    <div class="trim-header">
      <span class="trim-title">Trim Video</span>
      <span class="trim-info">
        <span>Start: <span id="trim-start-display">0:00</span></span>
        <span>End: <span id="trim-end-display">0:00</span></span>
        <span>Duration: <span id="trim-duration-display">0:00</span></span>
      </span>
    </div>
    <div class="trim-timeline-container">
      <div class="trim-timeline" id="trim-timeline">
        <div class="timeline-track"></div>
        <div class="trim-selection" id="trim-selection"></div>
        <div class="trim-handle start" id="trim-start-handle" data-type="start">⟨</div>
        <div class="trim-handle end" id="trim-end-handle" data-type="end">⟩</div>
      </div>
    </div>
    <div class="trim-actions">
      <button class="trim-btn reset" id="trim-reset-btn">Reset</button>
      <button class="trim-btn apply" id="trim-apply-btn">Apply Trim</button>
    </div>
    <div id="trim-status" style="text-align: center; margin-top: 8px; font-size: 12px; color: #94a3b8;">
      Loading video metadata...
    </div>
  `;
  
  // Add styles only once
  if (!document.querySelector('#trim-styles')) {
    const style = document.createElement('style');
    style.id = 'trim-styles';
    style.textContent = `
      .trim-section {
        margin: 16px 0;
        padding: 16px;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.1);
      }
      .trim-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
      }
      .trim-title {
        font-size: 14px;
        font-weight: 600;
        color: #f1f5f9;
      }
      .trim-info {
        display: flex;
        gap: 16px;
        font-size: 12px;
        color: #94a3b8;
      }
      .trim-timeline-container {
        margin: 12px 0;
      }
      .trim-timeline {
        position: relative;
        height: 40px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 4px;
        cursor: pointer;
      }
      .timeline-track {
        position: absolute;
        top: 50%;
        left: 0;
        right: 0;
        height: 4px;
        background: rgba(255, 255, 255, 0.2);
        transform: translateY(-50%);
        border-radius: 2px;
      }
      .trim-selection {
        position: absolute;
        top: 50%;
        height: 8px;
        background: #4f46e5;
        transform: translateY(-50%);
        border-radius: 4px;
        pointer-events: none;
      }
      .trim-handle {
        position: absolute;
        top: 50%;
        width: 20px;
        height: 20px;
        background: #4f46e5;
        border: 2px solid #fff;
        border-radius: 50%;
        transform: translate(-50%, -50%);
        cursor: ew-resize;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        color: #fff;
        user-select: none;
        z-index: 10;
      }
      .trim-handle:hover {
        background: #4338ca;
        transform: translate(-50%, -50%) scale(1.1);
      }
      .trim-handle.dragging {
        background: #6366f1;
        transform: translate(-50%, -50%) scale(1.2);
      }
      .trim-actions {
        display: flex;
        gap: 8px;
        justify-content: center;
      }
      .trim-btn {
        padding: 6px 12px;
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.1);
        color: #f1f5f9;
        cursor: pointer;
        font-size: 12px;
        transition: all 0.2s;
      }
      .trim-btn:hover {
        background: rgba(255, 255, 255, 0.2);
      }
      .trim-btn.apply {
        background: #4f46e5;
        border-color: #4f46e5;
      }
      .trim-btn.apply:hover {
        background: #4338ca;
      }
      .trim-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    `;
    
    document.head.appendChild(style);
  }
  
  // Insert after the preview video
  preview.parentNode.insertBefore(trimSection, preview.nextSibling);
  
  // Set up event listeners
  setupTrimEventListeners();
  
  // Update status
  updateTrimStatus();
}

// Set up trimming event listeners
function setupTrimEventListeners() {
  const timeline = document.getElementById('trim-timeline');
  const startHandle = document.getElementById('trim-start-handle');
  const endHandle = document.getElementById('trim-end-handle');
  const resetBtn = document.getElementById('trim-reset-btn');
  const applyBtn = document.getElementById('trim-apply-btn');
  
  // Timeline click to set playback position
  timeline.addEventListener('click', (e) => {
    if (trimState.isDragging) return;
    if (!isFinite(trimState.duration) || trimState.duration <= 0) return;
    
    const rect = timeline.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const time = Math.max(trimState.startTime, Math.min(trimState.endTime, percent * trimState.duration));
    
    // Ensure time is finite before setting
    if (isFinite(time) && time >= 0) {
      preview.currentTime = time;
    }
  });
  
  // Handle dragging
  let dragStart = { x: 0, handleType: null };
  
  function startDrag(e, handleType) {
    e.preventDefault();
    e.stopPropagation();
    
    trimState.isDragging = true;
    trimState.dragType = handleType;
    dragStart.x = e.clientX;
    
    const handle = handleType === 'start' ? startHandle : endHandle;
    handle.classList.add('dragging');
    
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', stopDrag);
  }
  
  function drag(e) {
    if (!trimState.isDragging) return;
    if (!isFinite(trimState.duration) || trimState.duration <= 0) return;
    
    const timeline = document.getElementById('trim-timeline');
    const rect = timeline.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const time = percent * trimState.duration;
    
    // Ensure calculated time is valid
    if (!isFinite(time)) return;
    
    if (trimState.dragType === 'start') {
      trimState.startTime = Math.max(0, Math.min(time, trimState.endTime - 0.1));
    } else {
      trimState.endTime = Math.min(trimState.duration, Math.max(time, trimState.startTime + 0.1));
    }
    
    updateTrimDisplay();
  }
  
  function stopDrag() {
    if (!trimState.isDragging) return;
    
    trimState.isDragging = false;
    trimState.dragType = null;
    
    startHandle.classList.remove('dragging');
    endHandle.classList.remove('dragging');
    
    document.removeEventListener('mousemove', drag);
    document.removeEventListener('mouseup', stopDrag);
  }
  
  startHandle.addEventListener('mousedown', (e) => startDrag(e, 'start'));
  endHandle.addEventListener('mousedown', (e) => startDrag(e, 'end'));
  
  // Reset button
  resetBtn.addEventListener('click', () => {
    if (!isFinite(trimState.duration) || trimState.duration <= 0) {
      showToast('Video not ready for trimming');
      return;
    }
    
    // Reset trim state
    trimState.startTime = 0;
    trimState.endTime = trimState.duration;
    updateTrimDisplay();
    
    // Clear trim metadata
    window.trimMetadata = null;
    
    // Reset visual state
    const trimSection = document.querySelector('.trim-section');
    if (trimSection) {
      trimSection.style.borderColor = 'rgba(255, 255, 255, 0.1)';
      trimSection.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
    }
    
    // Reset status
    updateTrimStatus();
    
    // Reset apply button
    const applyBtn = document.getElementById('trim-apply-btn');
    if (applyBtn) {
      applyBtn.textContent = 'Apply Trim';
      applyBtn.style.backgroundColor = '#4f46e5';
      applyBtn.style.borderColor = '#4f46e5';
      applyBtn.disabled = false;
    }
    
    // Reset info styling
    const infoElement = document.getElementById('info');
    if (infoElement) {
      infoElement.style.background = '';
      infoElement.style.border = '';
      infoElement.style.borderRadius = '';
      infoElement.style.padding = '';
      
      // Remove trim info from text
      const currentText = infoElement.textContent || infoElement.innerHTML;
      if (currentText.includes('🎬 TRIM APPLIED:')) {
        infoElement.textContent = currentText.replace(/\n\n🎬 TRIM APPLIED:.*?\nOriginal video preserved.*?\./s, '');
      }
    }
    
    // Remove video loop handler
    if (preview && preview.trimHandler) {
      preview.removeEventListener('timeupdate', preview.trimHandler);
      preview.trimHandler = null;
    }
    
    showToast('Trim reset to full duration');
  });
  
  // Apply button
  applyBtn.addEventListener('click', () => {
    console.log('Apply trim button clicked');
    console.log('Trim state:', trimState);
    
    if (!isFinite(trimState.duration) || trimState.duration <= 0) {
      console.warn('Video not ready for trimming, duration:', trimState.duration);
      showToast('Video not ready for trimming');
      return;
    }
    
    console.log('Calling applyTrim function');
    applyTrim();
  });
  
  // Initially disable buttons until video is ready
  resetBtn.disabled = true;
  applyBtn.disabled = true;
}

// Update trim display
function updateTrimDisplay() {
  if (!isFinite(trimState.duration) || trimState.duration <= 0) return;
  
  const startPercent = (trimState.startTime / trimState.duration) * 100;
  const endPercent = (trimState.endTime / trimState.duration) * 100;
  
  // Ensure percentages are valid
  if (!isFinite(startPercent) || !isFinite(endPercent)) return;
  
  const startHandle = document.getElementById('trim-start-handle');
  const endHandle = document.getElementById('trim-end-handle');
  const selection = document.getElementById('trim-selection');
  
  if (startHandle) startHandle.style.left = startPercent + '%';
  if (endHandle) endHandle.style.left = endPercent + '%';
  if (selection) {
    selection.style.left = startPercent + '%';
    selection.style.width = (endPercent - startPercent) + '%';
  }
  
  // Update time displays
  const startDisplay = document.getElementById('trim-start-display');
  const endDisplay = document.getElementById('trim-end-display');
  const durationDisplay = document.getElementById('trim-duration-display');
  
  if (startDisplay) startDisplay.textContent = formatTime(trimState.startTime);
  if (endDisplay) endDisplay.textContent = formatTime(trimState.endTime);
  if (durationDisplay) durationDisplay.textContent = formatTime(trimState.endTime - trimState.startTime);
}

// Format time helper
function formatTime(seconds) {
  // Handle non-finite values
  if (!isFinite(seconds) || seconds < 0) {
    return '0:00';
  }
  
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Apply trim (create new trimmed blob)
async function applyTrim() {
  console.log('applyTrim function called');
  console.log('Current trim state:', {
    startTime: trimState.startTime,
    endTime: trimState.endTime,
    duration: trimState.duration
  });
  
  if (trimState.startTime >= trimState.endTime) {
    console.warn('Invalid trim selection');
    showToast('Invalid trim selection');
    return;
  }
  
  if (trimState.startTime === 0 && trimState.endTime === trimState.duration) {
    console.log('No trimming needed');
    showToast('No trimming needed - using full video');
    return;
  }
  
  const applyBtn = document.getElementById('trim-apply-btn');
  if (!applyBtn) {
    console.error('Apply button not found');
    return;
  }
  
  console.log('Starting trim process');
  applyBtn.textContent = 'Processing...';
  applyBtn.disabled = true;
  
  try {
    // Store trim metadata instead of re-encoding
    // This preserves original quality and audio
    const trimMetadata = {
      startTime: trimState.startTime,
      endTime: trimState.endTime,
      duration: trimState.endTime - trimState.startTime,
      originalDuration: trimState.duration
    };
    
    console.log('Trim metadata created:', trimMetadata);
    
    // Update the video player to show trimmed section
    if (preview && isFinite(trimState.startTime)) {
      preview.currentTime = trimState.startTime;
    }
    
    // Store trim info globally for later use
    window.trimMetadata = trimMetadata;
    console.log('Trim metadata stored globally');
    
    // Visual feedback
    const trimmedDurationText = formatTime(trimMetadata.duration);
    const successMessage = `✅ Trim Applied! Duration: ${trimmedDurationText}`;
    console.log('Success message:', successMessage);
    showToast(successMessage);
    
    // Update trim section to show applied state
    const trimSection = document.querySelector('.trim-section');
    if (trimSection) {
      trimSection.style.borderColor = '#10b981';
      trimSection.style.backgroundColor = 'rgba(16, 185, 129, 0.1)';
    }
    
    // Update status to show trim applied
    const statusEl = document.getElementById('trim-status');
    if (statusEl) {
      statusEl.textContent = `✅ Trim Applied: ${formatTime(trimState.startTime)} to ${formatTime(trimState.endTime)} (${trimmedDurationText})`;
      statusEl.style.color = '#10b981';
      statusEl.style.fontWeight = 'bold';
    }
    
    // Update apply button to show completed state
    const applyBtn = document.getElementById('trim-apply-btn');
    if (applyBtn) {
      applyBtn.textContent = '✅ Trim Applied';
      applyBtn.style.backgroundColor = '#10b981';
      applyBtn.style.borderColor = '#10b981';
    }
    
    // Update the video player to show trimmed section and loop it
    if (preview && isFinite(trimState.startTime)) {
      preview.currentTime = trimState.startTime;
      
      // Add loop functionality for trimmed section
      const handleTimeUpdate = () => {
        if (preview.currentTime >= trimState.endTime) {
          preview.currentTime = trimState.startTime;
        }
      };
      
      // Remove any existing listener first
      preview.removeEventListener('timeupdate', handleTimeUpdate);
      preview.addEventListener('timeupdate', handleTimeUpdate);
      
      // Store the handler for cleanup
      preview.trimHandler = handleTimeUpdate;
    }
    
    // Update the info text with more prominent styling
    const infoElement = document.getElementById('info');
    if (infoElement) {
      const currentText = infoElement.textContent || infoElement.innerHTML;
      const trimInfo = `\n\n🎬 TRIM APPLIED: ${formatTime(trimState.startTime)} → ${formatTime(trimState.endTime)} (${trimmedDurationText})\nOriginal video preserved with trim metadata for download.`;
      if (currentText.includes('Trim applied:') || currentText.includes('TRIM APPLIED:')) {
        infoElement.textContent = currentText.replace(/\n\n(🎬 )?TRIM APPLIED:.*?\nOriginal video preserved.*?\./s, trimInfo);
      } else {
        infoElement.textContent = currentText + trimInfo;
      }
      
      // Style the info text to make trim info stand out
      infoElement.style.background = 'rgba(16, 185, 129, 0.1)';
      infoElement.style.border = '1px solid #10b981';
      infoElement.style.borderRadius = '4px';
      infoElement.style.padding = '8px';
      
      console.log('Info text updated with enhanced styling');
    } else {
      console.warn('Info element not found');
    }
    
  } catch (error) {
    console.error('Trim processing failed:', error);
    showToast('Trim processing failed. Please try again.');
  } finally {
    // Don't restore button - keep it in applied state
    console.log('Trim application completed');
  }
}

// Create actual trimmed video blob
async function createTrimmedVideoBlob() {
  if (!window.trimMetadata) {
    throw new Error('No trim metadata available');
  }
  
  const { startTime, endTime } = window.trimMetadata;
  console.log(`Creating trimmed video: ${startTime}s to ${endTime}s`);
  
  return new Promise((resolve, reject) => {
    try {
      // Create a temporary video element for the source
      const sourceVideo = document.createElement('video');
      sourceVideo.src = preview.src;
      sourceVideo.crossOrigin = 'anonymous';
      sourceVideo.muted = false; // Keep audio
      
      sourceVideo.addEventListener('loadedmetadata', async () => {
        try {
          console.log('Source video loaded for trimming');
          
          // Set up canvas for video capture
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          
          canvas.width = sourceVideo.videoWidth || 640;
          canvas.height = sourceVideo.videoHeight || 480;
          
          console.log(`Trimming canvas: ${canvas.width}x${canvas.height}`);
          
          // Create MediaRecorder for the trimmed content
          const canvasStream = canvas.captureStream(30);
          
          // Try to capture audio from the original video
          let finalStream = canvasStream;
          
          try {
            // Create an audio context to handle audio trimming
            const audioContext = new AudioContext();
            
            // Create a media element source from our video
            const audioSource = audioContext.createMediaElementSource(sourceVideo);
            const dest = audioContext.createMediaStreamDestination();
            audioSource.connect(dest);
            
            // Combine video and audio streams
            finalStream = new MediaStream([
              ...canvasStream.getVideoTracks(),
              ...dest.stream.getAudioTracks()
            ]);
            
            console.log('Audio track added to trimmed video');
          } catch (audioError) {
            console.warn('Could not add audio track:', audioError);
            finalStream = canvasStream;
          }
          
          const trimMime = pickRecordingMimeType();
          const mediaRecorder = new MediaRecorder(finalStream, {
            mimeType: trimMime.mimeType,
            videoBitsPerSecond: 2500000,
            audioBitsPerSecond: 128000
          });

          const chunks = [];
          mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
              chunks.push(e.data);
              console.log('Chunk recorded:', e.data.size, 'bytes');
            }
          };

          mediaRecorder.onstop = () => {
            const trimmedBlob = new Blob(chunks, { type: trimMime.mimeType });
            console.log('Trimmed video created:', trimmedBlob.size, 'bytes');
            
            // Cleanup
            sourceVideo.remove();
            canvas.remove();
            
            resolve(trimmedBlob);
          };
          
          mediaRecorder.onerror = (e) => {
            console.error('MediaRecorder error:', e);
            sourceVideo.remove();
            canvas.remove();
            reject(new Error('MediaRecorder failed'));
          };
          
          // Set up video capture loop
          const captureFrame = () => {
            if (sourceVideo.currentTime >= endTime || sourceVideo.ended) {
              console.log('Trimming complete, stopping recording');
              mediaRecorder.stop();
              sourceVideo.pause();
              return;
            }
            
            // Draw current frame to canvas
            ctx.drawImage(sourceVideo, 0, 0, canvas.width, canvas.height);
            requestAnimationFrame(captureFrame);
          };
          
          // Start the trimming process
          console.log('Setting video time to start position:', startTime);
          sourceVideo.currentTime = startTime;
          
          sourceVideo.addEventListener('seeked', () => {
            console.log('Video seeked to start time, beginning capture');
            sourceVideo.play();
            mediaRecorder.start(100); // Capture every 100ms
            captureFrame();
          }, { once: true });
          
          // Safety timeout
          const maxDuration = (endTime - startTime + 2) * 1000; // Add 2 second buffer
          setTimeout(() => {
            if (mediaRecorder.state === 'recording') {
              console.log('Timeout reached, stopping recording');
              mediaRecorder.stop();
              sourceVideo.pause();
            }
          }, maxDuration);
          
        } catch (error) {
          console.error('Error in trimming process:', error);
          sourceVideo.remove();
          reject(error);
        }
      });
      
      sourceVideo.addEventListener('error', (e) => {
        console.error('Source video loading error:', e);
        sourceVideo.remove();
        reject(new Error('Failed to load source video'));
      });
      
      // Add to DOM (required for some browsers)
      sourceVideo.style.display = 'none';
      document.body.appendChild(sourceVideo);
      
    } catch (error) {
      console.error('Failed to create trimmed video:', error);
      reject(error);
    }
  });
}
