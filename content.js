// content.js — runs in page context (has mic access)

let recognition = null;
let isListening = false;
let finalTranscript = "";
let userStopped = false; // true only when STOP_MIC was explicitly requested
let isStarting = false;  // guards the async settings read between START_MIC and recognition.start()
let cancelPendingStart = false; // STOP_MIC arrived during that read

const DEFAULT_VOICE_LANGUAGE = "en-US";

// Recognition locale from Settings → Voice Language (read on every start so a
// changed setting applies without reloading the page).
async function getVoiceLanguage() {
  try {
    const r = await chrome.storage.local.get("bugReporterSettings");
    return r.bugReporterSettings?.voiceLanguage || DEFAULT_VOICE_LANGUAGE;
  } catch (e) {
    return DEFAULT_VOICE_LANGUAGE;
  }
}

// Errors Chrome throws routinely (silence gaps, brief network blips) — recoverable,
// recognition.onend will fire right after and we restart it rather than surfacing an error.
const RECOVERABLE_ERRORS = new Set(["no-speech", "network", "aborted"]);

// Chrome's SpeechRecognition stops itself after a few seconds of silence even with
// continuous:true — this is expected behavior, not a bug in our config, so we restart
// it transparently instead of leaving the mic looking "on" while it's actually dead.
function restartRecognition() {
  if (!recognition || userStopped) return;
  setTimeout(() => {
    if (userStopped) return;
    try {
      recognition.start();
    } catch (err) {
      // Already running or transiently unable to start — treat as a real stop.
      isListening = false;
      chrome.runtime.sendMessage({ type: "MIC_STATE", listening: false });
    }
  }, 300);
}

// Light cleanup: capitalize first letter, collapse repeated spaces the API sometimes emits.
function cleanTranscript(text) {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function startRecognition(SR, lang, msg, sendResponse) {
  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = lang;

  finalTranscript = msg.existingText || "";
  userStopped = false;

  recognition.onstart = () => {
    isListening = true;
    chrome.runtime.sendMessage({ type: "MIC_STATE", listening: true });
  };

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += t + " ";
      } else {
        // Fast speech yields several interim segments at once — keep them all,
        // not just the last, or unconfirmed words vanish and reappear each update.
        interim += t;
      }
    }
    // Send transcript update to popup
    chrome.runtime.sendMessage({
      type: "MIC_TRANSCRIPT",
      text: cleanTranscript(finalTranscript + interim),
      isFinal: false
    });
  };

  recognition.onend = () => {
    isListening = false;

    if (!userStopped) {
      // Chrome auto-stopped (silence gap) — resume without bothering the user.
      restartRecognition();
      return;
    }

    chrome.runtime.sendMessage({
      type: "MIC_TRANSCRIPT",
      text: cleanTranscript(finalTranscript),
      isFinal: true
    });
    chrome.runtime.sendMessage({ type: "MIC_STATE", listening: false });
  };

  recognition.onerror = (e) => {
    if (RECOVERABLE_ERRORS.has(e.error) && !userStopped) {
      // onend fires right after onerror — let it decide whether to restart.
      return;
    }
    isListening = false;
    userStopped = true;
    chrome.runtime.sendMessage({
      type: "MIC_ERROR",
      error: e.error
    });
    chrome.runtime.sendMessage({ type: "MIC_STATE", listening: false });
  };

  try {
    recognition.start();
    sendResponse({ success: true });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GET_PAGE_META") {
    sendResponse({
      url: window.location.href,
      title: document.title
    });
  }

  if (msg.type === "START_MIC") {
    if (isListening || isStarting) {
      sendResponse({ success: true, alreadyListening: true });
      return;
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      sendResponse({ success: false, error: "Speech recognition not supported" });
      return;
    }

    isStarting = true;
    cancelPendingStart = false;
    getVoiceLanguage().then((lang) => {
      isStarting = false;
      if (cancelPendingStart) {
        cancelPendingStart = false;
        sendResponse({ success: true, cancelled: true });
        chrome.runtime.sendMessage({ type: "MIC_STATE", listening: false });
        return;
      }
      startRecognition(SR, lang, msg, sendResponse);
    });
    return true; // async sendResponse
  }

  if (msg.type === "STOP_MIC") {
    userStopped = true;
    if (isStarting) cancelPendingStart = true;
    if (recognition && isListening) {
      recognition.stop();
    }
    sendResponse({ success: true });
  }

  if (msg.type === "SYNC_TRANSCRIPT") {
    if (isListening) {
      finalTranscript = msg.text || "";
    }
    sendResponse({ success: true });
  }

  if (msg.type === "CHECK_MIC_STATE") {
    sendResponse({ listening: isListening });
  }
});
