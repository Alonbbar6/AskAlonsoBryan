#!/usr/bin/env node
// Overview of all requests: the ones waiting for the owner first, then the most recent others.

import {
  ago, backendStatus, call, categoryLabel, hasFreshDraft, intFlag, localTime, needsHumanReason,
  ownerName, parseCli, quoteTitle, runMain, urgencyLabel,
} from "./lib.mjs";

const HELP = `
Usage: node bridge/inbox.mjs [--limit N] [--all]

Shows the requests that are waiting for the owner first, then the most recently updated other
requests, plus a short backend health summary. Read-only: nothing is changed or sent.

Options:
  --limit N   how many other recent requests to list (default 10)
  --all       list every request
  -h, --help  show this help

Related: node bridge/request.mjs <number> shows one full request and its draft.
`;

function line(request, settings, stats) {
  const bits = [
    `**#${request.number}**`,
    request.requesterName || "unknown person",
    quoteTitle(request.title),
    categoryLabel(request.category),
    request.status || "unknown",
    `updated ${ago(request.updatedAt)}`,
  ];
  if (request.urgency && request.urgency !== "normal") bits.push(`urgency: ${urgencyLabel(request.urgency)}`);
  if (hasFreshDraft(request)) bits.push("draft ready");
  else if (request.draft) bits.push("draft is out of date");
  if (request.contactEmail) bits.push("gave an email address");
  if (request.unread) bits.push("has not read the answer yet");
  if (Number(request.errorCount) > 0) bits.push(`${request.errorCount} draft error(s)`);
  let text = `- ${bits.join(" · ")}`;
  if (request.needsHuman) text += `\n  Why: ${needsHumanReason(request, settings, stats)}`;
  return text;
}

runMain(async () => {
  const { values } = parseCli(HELP, { limit: { type: "string" }, all: { type: "boolean" } });
  const limit = intFlag(values.limit, "limit", { fallback: 10, min: 1, max: 1000 });

  const { requests = [], settings = {}, stats = {} } = await call("admin.list", { filter: "all" });
  const byNewest = [...requests].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  // Waiting requests: oldest first, because they have waited longest.
  const needs = byNewest.filter((r) => r.needsHuman).reverse();
  const others = byNewest.filter((r) => !r.needsHuman);
  const shownOthers = values.all ? others : others.slice(0, limit);

  const out = [
    "# Inbox: requests from the family",
    "",
    `_Checked ${localTime(new Date().toISOString())}. ${requests.length} request(s) in total. Every reply is sent as ${ownerName(settings)}._`,
    "",
    ...backendStatus(settings, stats).flatMap((l) => [l, ""]),
    `## Waiting for you (${needs.length})`,
    "",
  ];
  if (needs.length) out.push(...needs.map((r) => line(r, settings, stats)));
  else out.push("Nobody is waiting for an answer right now.");

  out.push(
    "",
    `## Other recent requests (${shownOthers.length === others.length ? others.length : `showing ${shownOthers.length} of ${others.length}`})`,
    "",
  );
  if (shownOthers.length) out.push(...shownOthers.map((r) => line(r, settings, stats)));
  else out.push("None.");
  if (shownOthers.length < others.length) out.push("", "_Use --all to list every request._");

  out.push("", "Open one request with: `node bridge/request.mjs <number>`");
  process.stdout.write(out.join("\n") + "\n");
});
