#!/usr/bin/env node
// Posts an owner-approved reply to a request (backend action admin.reply, via "bridge").
// Every reply on this site is from the owner, so there is no --as flag.
// The approval itself happens in the Claude Code conversation; this script only posts
// and prints exactly what was sent.

import { readFileSync } from "node:fs";
import {
  BridgeError, MISSING_REF, call, categoryLabel, fence, fromLabel, ownerName, parseCli, quoteTitle,
  rememberRequest, resolveRequest, runMain, statusLabel, when,
} from "./lib.mjs";

const HELP = `
Usage: node bridge/reply.mjs <number|#number|id> (--text "..." | --file FILE) [--email]

Posts the owner's reply to the request. It appears on the family member's page right away.
Every reply is sent as the owner (there is no other voice, so there is no --as flag).
Only run this after the owner has approved this exact text in the conversation.

Arguments:
  <number>      the request number, e.g. 7 (quote it if you use a hash: '#7')

Options:
  --text TEXT   the reply text (fine for one line; use --file for anything longer)
  --file FILE   read the reply text from a UTF-8 file ("-" reads standard input)
  --email       also email the reply (needs an address from that person, and emailReplies on)
  --dry-run     show exactly what would be posted, without posting
  --force       post even if the request's last message already has this exact text
  -h, --help    show this help
`;

function readReplyText(values) {
  if (values.text !== undefined && values.file !== undefined) {
    throw new BridgeError("usage", "Use either --text or --file, not both.");
  }
  if (values.text === undefined && values.file === undefined) {
    throw new BridgeError("usage", 'Missing the reply: pass --file FILE (recommended) or --text "...".');
  }
  let raw = values.text;
  if (values.file !== undefined) {
    try {
      raw = readFileSync(values.file === "-" ? 0 : values.file, "utf8");
    } catch (err) {
      throw new BridgeError("usage", `Could not read ${values.file === "-" ? "standard input" : values.file}: ${err.message}`);
    }
  }
  const text = String(raw).replace(/^﻿/, "").replace(/\r\n/g, "\n").trim();
  if (!text) throw new BridgeError("usage", "The reply text is empty. Nothing was posted.");
  return text;
}

runMain(async () => {
  const { values, positionals } = parseCli(
    HELP,
    {
      text: { type: "string" },
      file: { type: "string" },
      email: { type: "boolean" },
      "dry-run": { type: "boolean" },
      force: { type: "boolean" },
    },
    { minPositionals: 1, maxPositionals: 1, missing: MISSING_REF },
  );
  const text = readReplyText(values);
  const wantEmail = Boolean(values.email);

  const { request: listed, settings } = await resolveRequest(positionals[0]);
  const owner = ownerName(settings);
  const who = listed.requesterName || "the family member";

  if (wantEmail && !listed.contactEmail) {
    throw new BridgeError(
      "usage",
      `${who} did not leave an email address on request #${listed.number}, so the reply cannot be emailed. Nothing was posted. Run again without --email to post it on the site.`,
    );
  }
  if (wantEmail && settings.emailReplies === false) {
    throw new BridgeError(
      "usage",
      `Email replies are turned off in Settings (emailReplies), so --email would do nothing. Nothing was posted. Either run again without --email, or turn emailReplies on in admin.html > Settings.`,
    );
  }

  // Safety net for retries (for example after a timeout): refuse to post the same text twice in a row.
  const { messages = [] } = await call("admin.request", { id: listed.id });
  const lastMessage = messages[messages.length - 1];
  if (!values.force && lastMessage && lastMessage.from === "alon" && String(lastMessage.text).trim() === text) {
    throw new BridgeError(
      "duplicate",
      `The last message in #${listed.number} (${when(lastMessage.createdAt)}) already has exactly this text from ${owner}, so it looks posted already. Nothing was posted. Check with: node bridge/request.mjs ${listed.number} (use --force only if a repeat is really intended).`,
    );
  }

  const notes = [];
  if (listed.lastFrom && listed.lastFrom !== "family") {
    notes.push(`Before this reply, the last message was already from ${fromLabel(listed.lastFrom, settings, listed)}.`);
  }
  if (listed.contactEmail && !wantEmail) {
    notes.push(`${who} left an email address, but --email was not given: the reply is on the site only (no email is sent).`);
  }
  if (listed.status === "closed") {
    notes.push("This request was closed; replying reopens the conversation for them.");
  }

  if (values["dry-run"]) {
    const out = [
      `# Dry run: nothing was posted to #${listed.number}`,
      "",
      `- Would appear to ${who} as: ${owner}`,
      `- Request: ${categoryLabel(listed.category)} · ${quoteTitle(listed.title)} · ${statusLabel(listed)}`,
      `- Would be delivered: on the site${wantEmail ? ` and by email to ${listed.contactEmail}` : " only"}`,
      ...notes.map((note) => `- Note: ${note}`),
      "",
      "## Exact text that would be sent",
      "",
      fence(text, "markdown"),
    ];
    process.stdout.write(out.join("\n") + "\n");
    return;
  }

  let result;
  try {
    result = await call("admin.reply", { id: listed.id, text, email: wantEmail, via: "bridge" }, { timeoutMs: 120000 });
  } catch (err) {
    if (err instanceof BridgeError && (err.code === "timeout" || err.code === "network")) {
      err.message += ` The reply MAY have been posted anyway. Check with node bridge/request.mjs ${listed.number} before trying again.`;
    }
    throw err;
  }
  const request = result?.request || listed;
  rememberRequest(request); // so the watcher does not report our own reply back

  const out = [
    `# Reply posted to #${request.number}`,
    "",
    `- Appears to ${request.requesterName || who} as: ${owner}`,
    `- Request: ${categoryLabel(request.category)} · ${quoteTitle(request.title)}`,
    `- Delivered: on the site${wantEmail ? ` + email requested to ${listed.contactEmail} from the owner's Gmail` : " only (no email)"}`,
    `- Status now: ${statusLabel(request)}`,
    ...notes.map((note) => `- Note: ${note}`),
    "",
    "## Exact text sent",
    "",
    fence(text, "markdown"),
  ];
  process.stdout.write(out.join("\n") + "\n");
});
