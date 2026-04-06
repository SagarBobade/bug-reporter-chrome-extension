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

// DOM elements
const preview = document.getElementById("preview");
const timer = document.getElementById("timer");
const btnStop = document.getElementById("btn-stop");
const btnSave = document.getElementById("btn-save");
const btnDiscard = document.getElementById("btn-discard");
const actionsRecording = document.getElementById("actions-recording");
const actionsDone = document.getElementById("actions-done");
const recordingStatus = document.getElementById("recording-status");
const subtitle = document.getElementById("subtitle");
const info = document.getElementById("info");
const recordingDot = document.getElementById("recording-dot");

// Initialize
async function init() {
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
      showCompletedState();
    };

    mediaRecorder.start(1000);
    recordingStartTime = Date.now();

    // Update storage state
    chrome.storage.local.set({
      [VIDEO_RECORDING_KEY]: {
        isRecording: true,
        startTime: recordingStartTime
      }
    });

    // Start timer
    timerInterval = setInterval(updateTimer, 1000);

    // Handle stream ending (user clicks "Stop sharing" in browser UI)
    stream.getVideoTracks()[0].onended = () => {
      stopRecording();
    };

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
    if (transcript) {
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
  subtitle.textContent = "Recording complete! Save to add to your bug report.";

  if (transcript) {
    info.innerHTML = `<strong>Voice transcript:</strong> "${transcript.substring(0, 100)}${transcript.length > 100 ? '...' : ''}"<br><br>Key frames will be extracted automatically for AI analysis.`;
  } else {
    info.textContent = "Key frames will be extracted automatically for AI analysis.";
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
}

// Save recording
btnSave.addEventListener("click", async () => {
  btnSave.disabled = true;
  btnSave.innerHTML = "<span>⏳</span> Processing...";

  const blob = new Blob(recordedChunks, { type: 'video/webm' });

  // Extract key frames
  const frames = await extractKeyFrames(blob);

  // Store frames and transcript in storage for popup to pick up
  chrome.storage.local.set({
    [VIDEO_RECORDING_KEY]: {
      isRecording: false,
      completed: true,
      frames: frames,
      transcript: transcript || "",
      savedAt: Date.now()
    }
  }, () => {
    showToast("Saved! Return to Bug Reporter popup.");
    setTimeout(() => window.close(), 1500);
  });
});

// Discard recording
btnDiscard.addEventListener("click", () => {
  chrome.storage.local.remove(VIDEO_RECORDING_KEY, () => {
    window.close();
  });
});

// Extract key frames from video
async function extractKeyFrames(blob) {
  const video = document.createElement("video");
  video.src = URL.createObjectURL(blob);
  video.muted = true;

  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = reject;
    // Timeout fallback
    setTimeout(resolve, 5000);
  });

  const duration = video.duration;

  // Check for valid duration
  if (!duration || !isFinite(duration) || duration <= 0) {
    console.warn("Invalid video duration, capturing single frame");
    // Try to capture at least one frame at position 0
    video.currentTime = 0;
    await new Promise(resolve => {
      video.onseeked = resolve;
      setTimeout(resolve, 1000); // Fallback timeout
    });

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    ctx.drawImage(video, 0, 0);

    URL.revokeObjectURL(video.src);
    return [canvas.toDataURL("image/png")];
  }

  const frameCount = Math.min(5, Math.max(1, Math.ceil(duration / 2))); // Max 5 frames, at least 1
  const interval = duration / (frameCount + 1);

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const frames = [];

  for (let i = 1; i <= frameCount; i++) {
    const time = Math.min(interval * i, duration - 0.1); // Ensure we don't exceed duration

    if (!isFinite(time) || time < 0) continue;

    video.currentTime = time;

    await new Promise(resolve => {
      video.onseeked = resolve;
      setTimeout(resolve, 1000); // Fallback timeout
    });

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    ctx.drawImage(video, 0, 0);

    frames.push(canvas.toDataURL("image/png"));
  }

  URL.revokeObjectURL(video.src);
  return frames.length > 0 ? frames : [canvas.toDataURL("image/png")]; // Return at least one frame
}

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
