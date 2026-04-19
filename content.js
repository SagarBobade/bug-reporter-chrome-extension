// content.js — runs in page context (has mic access)

let recognition = null;
let isListening = false;
let finalTranscript = "";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GET_PAGE_META") {
    sendResponse({
      url: window.location.href,
      title: document.title
    });
  }

  if (msg.type === "START_MIC") {
    if (isListening) {
      sendResponse({ success: true, alreadyListening: true });
      return;
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      sendResponse({ success: false, error: "Speech recognition not supported" });
      return;
    }

    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    finalTranscript = msg.existingText || "";

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
          interim = t;
        }
      }
      // Send transcript update to popup
      chrome.runtime.sendMessage({
        type: "MIC_TRANSCRIPT",
        text: finalTranscript + interim,
        isFinal: false
      });
    };

    recognition.onend = () => {
      isListening = false;
      chrome.runtime.sendMessage({
        type: "MIC_TRANSCRIPT",
        text: finalTranscript.trim(),
        isFinal: true
      });
      chrome.runtime.sendMessage({ type: "MIC_STATE", listening: false });
    };

    recognition.onerror = (e) => {
      isListening = false;
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

    return true;
  }

  if (msg.type === "STOP_MIC") {
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
