// lib/dom-utils.js — browser-side helpers shared by the popup, the batch page and
// the history page (image conversion, clipboard, page environment, downloads).
// Classic script: functions are globals. Needs lib/ticket-utils.js loaded first.

// ── Images ────────────────────────────────────────────────────────────────────
// Captures are PNG, but uploads can be JPEG/WebP/GIF. The clipboard accepts only
// PNG images, so everything is normalised to PNG on the way in (upload) and on
// the way out (copy, for sessions saved before this conversion existed).
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not read image"));
    img.src = src;
  });
}

async function toPngDataUrl(dataUrl) {
  if (TicketUtils.parseDataUrl(dataUrl).mimeType === "image/png") return dataUrl;
  const img = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d").drawImage(img, 0, 0);
  return canvas.toDataURL("image/png");
}

async function dataUrlToPngBlob(dataUrl) {
  const png = await toPngDataUrl(dataUrl);
  const res = await fetch(png);
  return res.blob();
}

// Small JPEG preview for the history list (~240px wide, a few KB).
async function makeThumbnail(dataUrl, width = 240) {
  if (!dataUrl) return "";
  try {
    const img = await loadImage(dataUrl);
    const scale = Math.min(1, width / img.naturalWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.7);
  } catch (e) {
    return "";
  }
}

// Several screenshots stacked into one labelled PNG, for pasting into trackers
// that accept one image per paste.
async function createCompositeImage(screenshots) {
  const images = await Promise.all(screenshots.map(loadImage));
  const padding = 10;
  const headerHeight = 30;
  const maxWidth = Math.max(...images.map((img) => img.width));
  const totalHeight = images.reduce((sum, img) => sum + img.height, 0);

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = maxWidth + padding * 2;
  canvas.height = totalHeight + padding * (images.length + 1) + headerHeight * images.length;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let y = padding;
  images.forEach((img, index) => {
    ctx.fillStyle = "#333333";
    ctx.font = "16px Arial, sans-serif";
    ctx.fillText(`Screenshot ${index + 1}`, padding, y + 20);
    y += headerHeight;
    ctx.drawImage(img, Math.max(0, (canvas.width - img.width) / 2), y);
    y += img.height + padding;
  });

  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

// One PNG for the clipboard: the screenshot itself, or a composite of several.
async function screenshotsToClipboardImage(screenshots) {
  if (!screenshots || !screenshots.length) return null;
  try {
    return screenshots.length === 1
      ? await dataUrlToPngBlob(screenshots[0])
      : await createCompositeImage(screenshots);
  } catch (e) {
    console.warn("BugReporter: could not prepare clipboard image:", e);
    return null;
  }
}

// ── Clipboard ─────────────────────────────────────────────────────────────────
// Writes plain text + HTML (+ optional PNG) in one item. Falls back to plain text
// when the rich write is refused. Returns { rich, withImage }.
async function copyTicketRich({ text, html, image }) {
  try {
    const items = {
      "text/plain": new Blob([text], { type: "text/plain" }),
      "text/html": new Blob([html ?? TicketUtils.markdownToHtml(text)], { type: "text/html" })
    };
    if (image) items["image/png"] = image;
    await navigator.clipboard.write([new ClipboardItem(items)]);
    return { rich: true, withImage: !!image };
  } catch (e) {
    await navigator.clipboard.writeText(text);
    return { rich: false, withImage: false };
  }
}

// ── Page environment ──────────────────────────────────────────────────────────
// Reads screen/viewport/browser/OS from the inspected tab itself. Extension pages
// and the service worker can't see the page's screen, so this runs in the tab.
// Restricted pages (chrome://, Web Store) can't be scripted → "Unknown".
async function getPageEnvironment(tabId) {
  const unknown = { screenInfo: "Unknown", browser: "", os: "" };
  try {
    if (!tabId) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tab?.id;
    }
    if (!tabId) return unknown;
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        let hints = null;
        try {
          if (navigator.userAgentData?.getHighEntropyValues) {
            hints = await navigator.userAgentData.getHighEntropyValues(["platformVersion", "fullVersionList"]);
            hints = { platform: hints.platform, platformVersion: hints.platformVersion, fullVersionList: hints.fullVersionList, brands: hints.brands };
          }
        } catch (e) { /* hints are optional */ }
        return {
          ua: navigator.userAgent,
          hints,
          screenWidth: screen.width,
          screenHeight: screen.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio
        };
      }
    });
    const env = injection?.result;
    if (!env) return unknown;
    const { browser, os } = TicketUtils.parseBrowserInfo(env.ua, env.hints);
    return { screenInfo: TicketUtils.formatScreenInfo(env), browser, os };
  } catch (e) {
    console.warn("BugReporter: could not read page environment:", e);
    return unknown;
  }
}

// ── Files ─────────────────────────────────────────────────────────────────────
function downloadTextFile(filename, text, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Jira/Sheets/Excel-friendly CSV (BOM so Excel reads UTF-8).
function downloadCsv(filename, csv) {
  downloadTextFile(filename, "﻿" + csv, "text/csv;charset=utf-8");
}

function formatDateTime(ts) {
  return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
