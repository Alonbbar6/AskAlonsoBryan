// Local dev server: serves the static site and runs the real backend/Code.gs on fake Apps Script
// services (dev/fakes.mjs). No Google or Anthropic accounts are needed.
//
//   node dev/server.mjs            -> http://localhost:8788
//
// Port 8788 so this can run next to the tutor-zoila project (8787).
//
// Environment:
//   PORT                  port (default 8788)
//   HOST                  interface to bind (default 127.0.0.1)
//   DEV_TICK_SECONDS      run tick() this often, like the minute trigger (default 10, 0 = off)
//   FAKE_CLAUDE_MODE      ok | fail | refusal | slow | notriage (default slow)
//   FAKE_CLAUDE_DELAY_MS  delay for slow mode (default 1500)
//   DEV_VERBOSE=1         print every Logger/console line from Code.gs
//
// Dev endpoints (local only, JSON):
//   POST /dev/tick    run tick() now
//   POST /dev/claude  {mode, delayMs?}
//   POST /dev/reset   wipe all data (tokens and settings are seeded again)
//   POST /dev/seed    create a couple of sample requests for eyeballing the UI
//   GET  /dev/state   sent emails, notifications, properties, requests, Claude call count
//
// Code.gs is synchronous (fake Claude "slow" mode really blocks), so it runs in a worker thread:
// static files keep loading while a backend call is busy. Backend calls run one at a time, except
// while a slow fake Claude call is waiting: then other requests are served in between (like
// parallel Apps Script executions), so pages can see a request move to "working".

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Worker, isMainThread, parentPort, workerData, receiveMessageOnPort } from "node:worker_threads";
import { createAppsScriptEnv, CLAUDE_MODES, REPO_ROOT } from "./fakes.mjs";

const DEV_FAMILY_TOKEN = "dev-family-0123456789abcdef0123456789abcdef";
const DEV_ADMIN_TOKEN = "dev-admin-0123456789abcdef0123456789abcdef";
const DEV_PEOPLE = [
  { who: "0123456789abcdef0123456789abcdef", name: "Tía Rosa" },
  { who: "fedcba9876543210fedcba9876543210", name: "Bryan Jr" },
];

if (isMainThread) {
  startMain();
} else {
  startBackendWorker(workerData);
}

// =============================================================================================
// Main thread: HTTP server
// =============================================================================================

function startMain() {
  const port = Number(process.env.PORT) || 8788;
  const host = process.env.HOST || "127.0.0.1";
  const tickSeconds = process.env.DEV_TICK_SECONDS === undefined ? 10 : Number(process.env.DEV_TICK_SECONDS);
  const origin = "http://localhost:" + port;

  const worker = new Worker(new URL(import.meta.url), {
    workerData: {
      siteUrl: origin + "/",
      claudeMode: process.env.FAKE_CLAUDE_MODE || "slow",
      claudeDelayMs: Number(process.env.FAKE_CLAUDE_DELAY_MS) || 1500,
      verbose: process.env.DEV_VERBOSE === "1",
    },
  });

  // Request/response over the worker message channel.
  let nextId = 0;
  const pending = new Map();
  worker.on("message", (msg) => {
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.ok) return waiter.resolve(msg.result);
    const err = new Error(msg.error);
    err.statusCode = msg.statusCode;
    waiter.reject(err);
  });
  worker.on("error", (err) => {
    console.error("Backend worker crashed:", err);
    process.exit(1);
  });
  const backend = (op, args = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, op, args });
    });

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error("Request failed:", req.method, req.url, err);
      if (!res.headersSent) sendJson(res, 500, { error: String(err.message || err) });
      else res.end();
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url, origin);
    if (url.pathname === "/api") return handleApi(req, res, url);
    if (url.pathname === "/dev" || url.pathname.startsWith("/dev/")) {
      const dev = await handleDev(req, res, url);
      if (dev !== false) return;
    }
    return serveStatic(req, res, url);
  }

  // ----- /api -> doGet / doPost ------------------------------------------------------------

  async function handleApi(req, res, url) {
    const query = Object.fromEntries(url.searchParams);
    if (req.method === "GET") {
      const out = await backend("api", { method: "GET", query });
      return sendBackendOutput(res, out);
    }
    if (req.method === "POST") {
      const body = await readBody(req, 1024 * 1024);
      const contentType = String(req.headers["content-type"] || "").split(";")[0].trim();
      const out = await backend("api", { method: "POST", query, body, contentType });
      return sendBackendOutput(res, out);
    }
    // Apps Script web apps cannot answer CORS preflight (OPTIONS); fail the same way here so a
    // frontend that triggers a preflight breaks locally too.
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, POST" });
    res.end("Method not allowed. Apps Script web apps only answer GET and POST (no CORS preflight).");
  }

  function sendBackendOutput(res, out) {
    const types = { JSON: "application/json; charset=utf-8", TEXT: "text/plain; charset=utf-8" };
    res.writeHead(200, {
      "Content-Type": types[out.mimeType] || "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
    res.end(out.content);
  }

  // ----- /dev/* ---------------------------------------------------------------------------

  async function handleDev(req, res, url) {
    const routes = {
      "POST /dev/tick": async () => sendJson(res, 200, await backend("tick")),
      "POST /dev/claude": async () => {
        const input = (await readJson(req)) || {};
        return sendJson(res, 200, await backend("claude", input));
      },
      "POST /dev/reset": async () => sendJson(res, 200, await backend("reset")),
      "POST /dev/seed": async () => sendJson(res, 200, await backend("seed", (await readJson(req)) || {})),
      "GET /dev/state": async () => sendJson(res, 200, await backend("state")),
    };
    const route = routes[req.method + " " + url.pathname];
    if (!route) return false; // e.g. GET /dev/fakes.mjs is a static file
    if (!isLoopback(req.socket.remoteAddress)) return sendJson(res, 403, { error: "Dev endpoints are local only." });
    try {
      await route();
    } catch (err) {
      sendJson(res, err.statusCode || 500, { error: String(err.message || err) });
    }
  }

  // ----- static files ---------------------------------------------------------------------

  const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".gs": "text/plain; charset=utf-8",
    ".woff2": "font/woff2",
  };

  async function serveStatic(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
      return res.end("Method not allowed");
    }
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return notFound(res);
    }
    if (pathname === "/") pathname = "/index.html";
    const segments = pathname.split("/").filter(Boolean);
    // No dotfiles or dot-directories (.claude, bridge/.env, bridge/.state.json, .git...).
    if (pathname.includes("\0") || segments.some((s) => s.startsWith(".") || s.includes("\\"))) return notFound(res);

    const root = await fs.promises.realpath(REPO_ROOT);
    let filePath;
    try {
      filePath = await fs.promises.realpath(path.join(root, ...segments));
    } catch {
      return notFound(res);
    }
    if (!filePath.startsWith(root + path.sep)) return notFound(res); // traversal or symlink escape
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return notFound(res);

    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath).pipe(res);
  }

  function notFound(res) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }

  // ----- tick loop, start, stop -----------------------------------------------------------

  let tickRunning = false;
  if (tickSeconds > 0) {
    setInterval(() => {
      if (tickRunning) return; // never queue more than one tick
      tickRunning = true;
      backend("tick")
        .catch((err) => console.error("tick failed:", err.message))
        .finally(() => {
          tickRunning = false;
        });
    }, tickSeconds * 1000).unref();
  }

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error("Port " + port + " is already in use. Stop the other server or run: PORT=8789 node dev/server.mjs");
    } else {
      console.error("Server error:", err);
    }
    process.exit(1);
  });

  backend("info").then((info) => {
    server.listen(port, host, () => {
      console.log("Ask " + info.ownerName + " dev server running at " + origin + "  (fake Google services, fake Claude)");
      console.log("");
      console.log("  Family link:   " + origin + "/index.html#f=" + info.familyToken);
      console.log("  Admin page:    " + origin + "/admin.html#admin=" + info.adminToken);
      console.log("");
      console.log("  Dev person codes (paste into the family page's \"I have a code\" field):");
      info.people.forEach((p) => console.log("    " + p.name + ": " + p.who));
      console.log("");
      console.log("  Fake Claude: " + info.claudeMode + (info.claudeMode === "slow" ? " (" + info.claudeDelayMs + " ms)" : "") +
        " · tick every " + (tickSeconds > 0 ? tickSeconds + " s" : "(off)") +
        " · daily cap " + info.dailyCap + " · notify " + info.notifyEmail);
      console.log("  Dev endpoints: POST /dev/tick /dev/claude /dev/reset /dev/seed · GET /dev/state");
      console.log("  Example: curl -s -X POST " + origin + "/dev/seed && curl -s -X POST " + origin + "/dev/tick");
    });
  });

  const stop = () => {
    server.close();
    worker.terminate().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value, null, 2));
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error("Request body too large");
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const text = await readBody(req, 1024 * 1024);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error("Body is not valid JSON");
    err.statusCode = 400;
    throw err;
  }
}

function badInput(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

// =============================================================================================
// Worker thread: the fake Apps Script project
// =============================================================================================

function startBackendWorker(config) {
  // Ops that must not run in the middle of another call (reset replaces the whole environment).
  const NOT_NESTED = new Set(["reset"]);
  const deferred = [];
  config = { ...config, waitDuringClaude: serveWhileWaiting };
  let env = createDevEnv(config);
  let logCursor = 0;

  parentPort.on("message", (msg) => {
    handleMessage(msg);
    while (deferred.length) handleMessage(deferred.shift());
  });

  function handleMessage({ id, op, args }) {
    let reply;
    try {
      reply = { id, ok: true, result: runOp(op, args || {}) };
    } catch (err) {
      const statusCode = (err && err.statusCode) || 500;
      if (statusCode >= 500) console.error("Backend op " + op + " failed:", err);
      reply = { id, ok: false, error: String((err && err.message) || err), statusCode };
    }
    flushLogs();
    parentPort.postMessage(reply);
  }

  // Called by the fake Claude instead of a plain blocking wait. Code.gs never holds the script
  // lock during the Claude call, so other executions may run meanwhile, as on real Apps Script.
  function serveWhileWaiting(ms) {
    const until = Date.now() + ms;
    for (;;) {
      const left = until - Date.now();
      if (left <= 0) return;
      const received = receiveMessageOnPort(parentPort);
      if (!received) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(left, 10));
      } else if (NOT_NESTED.has(received.message.op)) {
        deferred.push(received.message);
      } else {
        handleMessage(received.message);
      }
    }
  }

  function settings() {
    try {
      return JSON.parse(env.state.properties.SETTINGS || "{}");
    } catch {
      return {};
    }
  }

  function runOp(op, args) {
    switch (op) {
      case "info": {
        const s = settings();
        return {
          familyToken: env.state.properties.FAMILY_TOKEN,
          adminToken: env.state.properties.ADMIN_TOKEN,
          people: DEV_PEOPLE,
          ownerName: s.ownerName || "Alonso Bryan",
          notifyEmail: s.notifyEmail || "(none)",
          dailyCap: s.dailyCap,
          claudeMode: env.state.claude.mode,
          claudeDelayMs: env.state.claude.delayMs,
        };
      }
      case "api":
        return runApi(args);
      case "tick": {
        const started = Date.now();
        const before = env.state.claude.requests.length;
        env.run("tick");
        return { ran: true, durationMs: Date.now() - started, claudeCalls: env.state.claude.requests.length - before };
      }
      case "claude":
        if (args.mode !== undefined && !CLAUDE_MODES.includes(args.mode)) {
          throw badInput("mode must be one of " + CLAUDE_MODES.join(", "));
        }
        if (args.delayMs !== undefined && !(Number(args.delayMs) >= 0 && Number(args.delayMs) <= 300000)) {
          throw badInput("delayMs must be a number from 0 to 300000");
        }
        if (args.mode !== undefined) env.setClaudeMode(args.mode, { delayMs: args.delayMs });
        else if (args.delayMs !== undefined) env.state.claude.delayMs = Number(args.delayMs);
        return { mode: env.state.claude.mode, delayMs: env.state.claude.delayMs };
      case "reset": {
        const { mode, delayMs } = env.state.claude;
        env = createDevEnv({ ...config, claudeMode: mode, claudeDelayMs: delayMs });
        logCursor = 0;
        return { reset: true };
      }
      case "seed":
        return seed();
      case "state":
        return describeState();
      default:
        throw new Error("Unknown backend op " + op);
    }
  }

  // A couple of sample requests (one per dev person) so the UI has something to show.
  function seed() {
    const family = env.state.properties.FAMILY_TOKEN;
    const samples = [
      {
        who: DEV_PEOPLE[0].who,
        name: DEV_PEOPLE[0].name,
        category: "tech",
        urgency: "soon",
        title: "La impresora no imprime",
        text: "Hola, la impresora dejó de imprimir desde ayer. Aparece una luz naranja y no sé qué hacer. ¿Me puedes ayudar?",
        contactEmail: "tia.rosa@example.com",
      },
      {
        who: DEV_PEOPLE[1].who,
        name: DEV_PEOPLE[1].name,
        category: "school",
        urgency: "urgent",
        title: "Help with my history essay outline",
        text: "Hi, I need to hand in an outline for my history essay tomorrow and I am stuck on how to structure it. Can you take a look?",
        links: "https://docs.example.com/my-essay",
      },
    ];
    const created = [];
    const errors = [];
    samples.forEach((s) => {
      const res = env.call("create", { family, ...s });
      if (res.ok) created.push({ id: res.result.request.id, number: res.result.request.number, title: res.result.request.title, who: s.who });
      else errors.push(res.error);
    });
    return { created, errors };
  }

  // Builds the event object Apps Script passes to doGet/doPost.
  function runApi({ method, query, body, contentType }) {
    const parameters = {};
    Object.keys(query).forEach((k) => {
      parameters[k] = [query[k]];
    });
    const e = {
      parameter: query,
      parameters,
      queryString: new URLSearchParams(query).toString(),
      contextPath: "",
      pathInfo: "",
      contentLength: method === "POST" ? Buffer.byteLength(body) : -1,
    };
    if (method === "POST") {
      e.postData = { contents: body, type: contentType || "text/plain", length: Buffer.byteLength(body), name: "postData" };
    }
    const output = method === "POST" ? env.context.doPost(e) : env.context.doGet(e);
    return { content: output.getContent(), mimeType: output.getMimeType() };
  }

  function describeState() {
    const props = env.state.properties;
    const s = settings();
    const messages = env.sheetRecords("Messages");
    const counts = {};
    messages.forEach((m) => {
      counts[m.requestId] = (counts[m.requestId] || 0) + 1;
    });
    const requests = env.state.claude.requests;
    const notifyTo = String(s.notifyEmail || "").toLowerCase();
    const mails = env.state.sentEmails;
    const people = Object.fromEntries(DEV_PEOPLE.map((p) => [p.who, p.name]));
    return {
      now: new Date().toISOString(),
      settings: s,
      properties: {
        COUNTER: props.COUNTER || null,
        AUTO_CALLS: props.AUTO_CALLS ? JSON.parse(props.AUTO_CALLS) : null,
        LAST_TICK_AT: props.LAST_TICK_AT || null,
        LAST_ERROR: props.LAST_ERROR || null,
        apiKeyConfigured: Boolean(props.ANTHROPIC_API_KEY),
      },
      claude: {
        mode: env.state.claude.mode,
        delayMs: env.state.claude.delayMs,
        requests: requests.length,
        recent: requests.slice(-5).map((r) => ({ at: r.at, mode: r.mode, status: r.status, error: r.error })),
      },
      claudeRequests: requests.length,
      // Owner notifications go to notifyEmail; everything else is an answer emailed to a requester.
      notifications: mails.filter((m) => notifyTo && m.to === notifyTo),
      sentEmails: mails.filter((m) => !notifyTo || m.to !== notifyTo),
      triggers: env.state.triggers.map((t) => ({ handler: t.getHandlerFunction(), everyMinutes: t.everyMinutes })),
      requests: env.sheetRecords("Requests").map((r) => ({
        id: r.id,
        number: r.number,
        requester: people[String(r.requesterId)] || String(r.requesterId).slice(0, 8) + "…",
        category: r.category,
        urgency: r.urgency,
        title: r.title,
        status: r.status,
        lastFrom: r.lastFrom,
        unread: r.unread,
        updatedAt: r.updatedAt,
        messageCount: counts[r.id] || 0,
        hasDraft: Boolean(r.draft),
        draftAt: r.draftAt || null,
        triage: r.triage || null,
        errorCount: r.errorCount,
        lastError: r.lastError || null,
      })),
      violations: env.state.violations,
    };
  }

  // Code.gs errors are always shown; everything else only with DEV_VERBOSE=1.
  function flushLogs() {
    const logs = env.state.logs;
    for (; logCursor < logs.length; logCursor++) {
      const entry = logs[logCursor];
      if (entry.level === "error") console.error("[Code.gs] " + entry.text);
      else if (config.verbose) console.log("[Code.gs " + entry.level + "] " + entry.text);
    }
  }
}

// Fresh fake project with deterministic dev tokens and settings, then setup() like the owner would.
function createDevEnv(config) {
  const env = createAppsScriptEnv({
    claudeMode: config.claudeMode,
    claudeDelayMs: config.claudeDelayMs,
    sleep: "real",
    waitDuringClaude: config.waitDuringClaude,
  });
  const props = env.state.properties;
  props.FAMILY_TOKEN = DEV_FAMILY_TOKEN;
  props.ADMIN_TOKEN = DEV_ADMIN_TOKEN;
  props.ANTHROPIC_API_KEY = "sk-dev-fake";
  props.SETTINGS = JSON.stringify({
    ownerName: "Alonso Bryan",
    siteUrl: config.siteUrl,
    notifyEmail: "owner@example.com",
    dailyCap: 40,
  });
  env.run("setup");
  env.state.logs.length = 0; // setup() prints the tokens; the server prints its own links instead
  return env;
}
