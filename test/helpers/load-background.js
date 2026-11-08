// Loads background.js into an isolated VM context with a minimal fake `chrome`,
// so service-worker logic (prompt building, AI calls, message handlers) can be
// tested in Node without a browser.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "..");

function createChromeStub(initialStorage = {}) {
  const store = JSON.parse(JSON.stringify(initialStorage));
  const listeners = { message: [], installed: [], command: [] };
  const sent = [];

  const pick = (keys) => {
    if (keys == null) return { ...store };
    const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    for (const k of list) if (k in store) out[k] = store[k];
    return out;
  };

  // chrome.storage.local supports both callback and promise styles.
  const local = {
    get(keys, cb) { const r = pick(keys); if (cb) { cb(r); return undefined; } return Promise.resolve(r); },
    set(items, cb) { Object.assign(store, JSON.parse(JSON.stringify(items))); if (cb) { cb(); return undefined; } return Promise.resolve(); },
    remove(keys, cb) { for (const k of [].concat(keys)) delete store[k]; if (cb) { cb(); return undefined; } return Promise.resolve(); },
  };

  const chrome = {
    storage: { local },
    runtime: {
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      sendMessage: (msg) => { sent.push(msg); return Promise.resolve(); },
      getPlatformInfo: (cb) => cb && cb({}),
      getURL: (p) => `chrome-extension://test/${p}`,
      getContexts: async () => [],
      lastError: undefined,
    },
    commands: { onCommand: { addListener: (fn) => listeners.command.push(fn) } },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      getBadgeText: async () => "",
    },
    tabs: { sendMessage: async () => ({}), query: async () => [], get: async () => ({}) },
  };

  return { chrome, store, listeners, sent };
}

function loadBackground({ storage = {}, fetch } = {}) {
  const stub = createChromeStub(storage);
  const context = vm.createContext({
    chrome: stub.chrome,
    fetch: fetch || (async () => { throw new Error("fetch not mocked"); }),
    console: { log() {}, warn() {}, error() {} },
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" },
    DOMException,
    URL,
  });
  context.self = context;
  context.importScripts = (...files) => {
    for (const f of files) {
      const code = fs.readFileSync(path.join(ROOT, f), "utf8");
      vm.runInContext(code, context, { filename: f });
    }
  };
  // Hide CommonJS so lib/ticket-utils.js registers on self like it does in Chrome.
  const code = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
  vm.runInContext(code, context, { filename: "background.js" });

  // Sends a runtime message to the background listener and resolves its response.
  function send(msg) {
    return new Promise((resolve) => {
      let async = false;
      for (const fn of stub.listeners.message) {
        const r = fn(msg, {}, resolve);
        if (r === true) async = true;
      }
      if (!async) resolve(undefined);
    });
  }

  return {
    ctx: context,
    run: (src) => vm.runInContext(src, context),
    store: stub.store,
    sent: stub.sent,
    send,
  };
}

// Minimal fetch Response stand-in.
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// Values created inside the VM have that realm's Object prototype, which
// deepStrictEqual treats as different — copy them into this realm first.
const plain = (v) => JSON.parse(JSON.stringify(v));

module.exports = { loadBackground, jsonResponse, plain, ROOT };
