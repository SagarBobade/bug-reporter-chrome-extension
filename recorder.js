// recorder.js — Screen recording page

const VIDEO_RECORDING_KEY = "bugReporterVideoRecording";

// State
let mediaRecorder = null;
let recordedChunks = [];
let recordingStartTime = null;
let timerInterval = null;
let stream = null;
let recognition = null;
let transcript = "";
let targetTabId = null;
let isPaused = false;

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
  // Get target tab ID from storage
  const data = await new Promise(resolve => {
    chrome.storage.local.get(VIDEO_RECORDING_KEY, result => resolve(result[VIDEO_RECORDING_KEY] || {}));
  });
  targetTabId = data.targetTabId;

  try {
    // Request screen capture with audio
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: "always" },
      audio: true
    });

    // Also get microphone for voice transcription
    let micStream = null;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.warn("Microphone access denied, continuing without voice transcription");
    }

    // Show preview
    preview.srcObject = stream;

    // Combine streams if mic is available
    let combinedStream = stream;
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

      // Create combined stream with video from screen and combined audio
      combinedStream = new MediaStream([
        ...stream.getVideoTracks(),
        ...dest.stream.getAudioTracks()
      ]);

      // Start speech recognition for transcription
      startSpeechRecognition();
    }

    // Start recording
    mediaRecorder = new MediaRecorder(combinedStream, {
      mimeType: 'video/webm;codecs=vp9'
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
  subtitle.textContent = "Recording complete! Download to attach to your ticket.";

  if (transcript) {
    info.innerHTML = `<strong>Voice transcript:</strong> "${transcript.substring(0, 100)}${transcript.length > 100 ? '...' : ''}"<br><br>Transcript will be added to notes. Download video for attachment.`;
  } else {
    info.textContent = "Download the video to attach it to your ticket.";
  }

  // Create blob and show in preview
  const blob = new Blob(recordedChunks, { type: 'video/webm' });
  const url = URL.createObjectURL(blob);
  preview.srcObject = null;
  preview.src = url;
  preview.controls = true;

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

  const blob = new Blob(recordedChunks, { type: 'video/webm' });

  // Convert video blob to base64 for storage (no frame extraction - video is for download only)
  const videoBlobBase64 = await blobToBase64(blob);

  // Store transcript and video blob in storage for popup to pick up
  chrome.storage.local.set({
    [VIDEO_RECORDING_KEY]: {
      isRecording: false,
      completed: true,
      transcript: transcript || "",
      videoBlobBase64: videoBlobBase64,
      savedAt: Date.now()
    }
  }, () => {
    showToast("Saved! Return to Bug Reporter popup.");
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
btnDownload.addEventListener("click", () => {
  const blob = new Blob(recordedChunks, { type: 'video/webm' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bug-recording-${Date.now()}.webm`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("Video downloaded!");
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
