#!/usr/bin/env node
// Waits quietly until a family request needs the owner, prints a Markdown report and exits 0.
// Meant to run in the background of a Claude Code session: the session is woken up when this
// process exits, handles the report, and then starts the watcher again.

import { existsSync, unlinkSync } from "node:fs";
import {
  BridgeError, DATA_NOTICE, STATE_PATH, backendStatus, call, draftPending, formatDuration, hasFreshDraft,
  intFlag, localTime, loadConfig, needsHumanReason, ownerName, parseCli, readState, renderRequest,
  requestHeadline, runMain, sleep, snapshot, writeState,
} from "./lib.mjs";

const HELP = `
Usage: node bridge/watch.mjs [--interval SECONDS] [--draft-wait SECONDS] [--once] [--history N] [--reset]

Checks the backend every few seconds. Stays silent until at least one request is waiting for the
owner (someone wrote and nobody has answered yet) and has changed since it was last reported.
Then it prints a Markdown report and exits with code 0.

When a brand-new request has no Claude draft yet, the watcher waits a little for the draft to be
written (see --draft-wait) so the report can include it. Once the wait is over it reports anyway
and says why there is no draft.

The first time it runs, every request that is currently waiting counts as news, so nothing is
missed. What was already reported is remembered in bridge/.state.json.

Options:
  --interval S     seconds between checks (default 20, minimum 5)
  --draft-wait S   seconds to wait for Claude's draft before reporting (default 90, 0 = never wait)
  --once           check once, print the report or "No news.", and exit (never waits for a draft)
  --history N      messages of history to include per request (default 10)
  --reset          forget what was already reported (bridge/.state.json) before starting
  -h, --help       show this help

Network problems are retried with increasing waits (up to 5 minutes); the watcher does not exit
for them. Configuration or token problems stop it with an error message.
`;

const OVERLAP_MS = 2 * 60 * 1000; // re-read a little history each poll so late writes are never missed
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const RECONCILE_EVERY = 6; // every Nth poll also asks for all waiting requests (catches flag-only changes)
const MAX_DETAILED = 6; // requests shown with full history in one report

const count = (r) => (Number.isFinite(Number(r?.messageCount)) ? Number(r.messageCount) : null);

// Did this request get new messages since the snapshot we reported?
function grew(request, prev) {
  const now = count(request);
  const before = count(prev);
  if (now !== null && before !== null) return now > before;
  return request.updatedAt !== prev.updatedAt;
}

// A draft that was not there (or was older) the last time we reported this request.
function draftArrived(request, prev) {
  if (!hasFreshDraft(request)) return false;
  return !prev.draftAt || String(prev.draftAt) < String(request.draftAt);
}

function isNews(request, prev) {
  if (!request.needsHuman) return false;
  return !prev || !prev.needsHuman || grew(request, prev) || draftArrived(request, prev);
}

// Hold a very fresh request back for a moment so its report can include Claude's draft.
function waitingForDraft(request, ctx) {
  if (!ctx.draftWaitMs) return false;
  if (hasFreshDraft(request)) return false;
  if (!draftPending(request, ctx.settings, ctx.stats)) return false;
  const updated = new Date(request.updatedAt).getTime();
  return Number.isFinite(updated) && Date.now() - updated < ctx.draftWaitMs;
}

async function checkOnce(ctx) {
  const state = readState();
  const base = new Date(state.since || ctx.startedAt).getTime();
  const since = new Date((Number.isFinite(base) ? base : Date.now()) - OVERLAP_MS).toISOString();

  const events = await call("admin.events", { since });
  const candidates = new Map();
  for (const r of events?.requests || []) candidates.set(r.id, r);

  if (ctx.polls % RECONCILE_EVERY === 0) {
    const needs = await call("admin.list", { filter: "needs" });
    ctx.settings = needs?.settings || ctx.settings;
    ctx.stats = needs?.stats || ctx.stats;
    for (const r of needs?.requests || []) {
      const seen = candidates.get(r.id);
      if (!seen || String(r.updatedAt) >= String(seen.updatedAt)) candidates.set(r.id, r);
    }
  }

  const news = [...candidates.values()]
    .filter((r) => isNews(r, state.notified[r.id]))
    // oldest first: they have waited longest
    .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));

  const held = news.filter((r) => waitingForDraft(r, ctx));
  const ready = news.filter((r) => !held.includes(r));

  const serverNow = events?.now || new Date().toISOString();
  // Anything held back must keep coming out of admin.events, so don't move `since` past it.
  const nextSince = held.length ? held.map((r) => String(r.updatedAt)).sort()[0] : serverNow;

  if (!ready.length) {
    state.since = nextSince;
    if (ctx.settings?.ownerName) state.ownerName = ctx.settings.ownerName;
    writeState(state);
    ctx.polls++;
    return null;
  }

  // Full history for the first few; if any call fails, the whole check is retried later.
  const detailed = await Promise.all(ready.slice(0, MAX_DETAILED).map((r) => call("admin.request", { id: r.id })));
  const report = renderReport(ready, detailed, ctx);

  // Re-read before writing: reply.mjs may have updated the file in the meantime.
  const fresh = readState();
  ready.forEach((r, i) => {
    fresh.notified[r.id] = snapshot(detailed[i]?.request || r);
  });
  fresh.since = nextSince;
  if (ctx.settings?.ownerName) fresh.ownerName = ctx.settings.ownerName;
  writeState(fresh);
  ctx.polls++;
  return report;
}

function renderReport(news, detailed, ctx) {
  const { settings, stats } = ctx;
  const owner = ownerName(settings);
  const out = [
    `# Ask Alonso Bryan: ${news.length} request${news.length === 1 ? "" : "s"} waiting for you`,
    "",
    `_Checked ${localTime(new Date().toISOString())}. Every reply is sent as ${owner}, in the owner's own voice._`,
    "",
    DATA_NOTICE,
  ];
  const health = backendStatus(settings, stats).filter((l) => l.startsWith("**Warning:**"));
  if (health.length) out.push("", ...health.flatMap((l) => [l, ""]).slice(0, -1));

  news.forEach((r, i) => {
    const detail = detailed[i];
    if (!detail) return;
    const request = detail.request || r;
    out.push("", "---", "", "**WAITING FOR YOU**", "", renderRequest(request, detail.messages, settings, stats, { last: ctx.history }));
  });

  const rest = news.slice(detailed.length);
  if (rest.length) {
    out.push("", "---", "", `## ${rest.length} more request(s)`, "");
    for (const r of rest) {
      out.push(`- **${requestHeadline(r)}** — ${needsHumanReason(r, settings, stats)}. Details: \`node bridge/request.mjs ${r.number}\``);
    }
  }

  const first = detailed[0]?.request || news[0];
  const restart = `node bridge/watch.mjs${ctx.intervalFlag ? ` --interval ${ctx.intervalFlag}` : ""}`;
  out.push(
    "",
    "---",
    "",
    "## Next steps (protocol in CLAUDE.md)",
    "",
    "1. Summarize each request for the owner **in English**: who wrote, #number, what they actually need,",
    "   how urgent it is, and anything that needs the owner personally. Claude's triage line is a starting point.",
    "2. Propose the reply **in the language the family member used**. Start from the saved draft, check it against",
    "   the rules in CLAUDE.md, and show the full text exactly as it would be sent.",
    "   If there is no up-to-date draft, write one yourself (or run `node bridge/draft.mjs <number>`).",
    "3. Ask the owner to approve, edit or skip it. Never post anything they have not approved word for word.",
    "4. After approval, write the approved text to a temporary file outside the repo and post it:",
    `   \`node bridge/reply.mjs ${first?.number ?? "<number>"} --file <file>${first?.contactEmail ? " [--email]" : ""}\``,
    "5. Confirm what was sent, then start watching again: `" + restart + "`",
  );
  return out.join("\n");
}

runMain(async () => {
  const { values } = parseCli(HELP, {
    interval: { type: "string" },
    "draft-wait": { type: "string" },
    once: { type: "boolean" },
    history: { type: "string" },
    reset: { type: "boolean" },
  });
  const intervalSeconds = intFlag(values.interval, "interval", { fallback: 20, min: 5, max: 3600 });
  const draftWaitSeconds = intFlag(values["draft-wait"], "draft-wait", { fallback: 90, min: 0, max: 600 });
  const history = intFlag(values.history, "history", { fallback: 10, min: 1, max: 500 });
  loadConfig(); // fail fast with setup instructions if bridge/.env is missing

  if (values.reset && existsSync(STATE_PATH)) unlinkSync(STATE_PATH);

  const ctx = {
    intervalFlag: values.interval !== undefined ? intervalSeconds : null,
    // A single check should report what is there right now, so it never waits for a draft.
    draftWaitMs: values.once ? 0 : draftWaitSeconds * 1000,
    history,
    polls: 0,
    settings: null,
    stats: null,
    startedAt: new Date().toISOString(),
    everSucceeded: false,
  };

  if (values.once) {
    const report = await checkOnce(ctx);
    process.stdout.write((report ?? "No news.") + "\n");
    return;
  }

  const intervalMs = intervalSeconds * 1000;
  let announced = false;
  const announce = () => {
    if (announced) return;
    announced = true;
    process.stderr.write(`Watching for new family requests every ${intervalSeconds}s…\n`);
  };

  let failures = 0;
  for (;;) {
    let report;
    try {
      report = await checkOnce(ctx);
    } catch (err) {
      // Wrong token, bad config, or a page that never worked: retrying will not help.
      const retryable = err instanceof BridgeError && (err.retryable || (err.code === "bad_response" && ctx.everSucceeded));
      if (!retryable) throw err;
      failures++;
      announce();
      const delay = Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS);
      if (failures === 1 || failures % 12 === 0) {
        process.stderr.write(`Could not check for requests (${err.message}). Retrying in ${formatDuration(delay)} and will keep trying.\n`);
      }
      await sleep(delay);
      continue;
    }
    if (failures > 0) process.stderr.write("Connection restored.\n");
    failures = 0;
    ctx.everSucceeded = true;
    announce();
    if (report) {
      process.stdout.write(report + "\n");
      return;
    }
    await sleep(intervalMs);
  }
});
