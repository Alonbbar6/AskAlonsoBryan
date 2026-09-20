#!/usr/bin/env node
// Asks the backend to have Claude write a draft reply for a request. Nothing is sent to the family.

import { writeFileSync } from "node:fs";
import {
  BridgeError, MISSING_REF, ago, call, categoryLabel, fence, oneLine, ownerName, parseCli,
  quoteTitle, resolveRequest, runMain, statusLabel,
} from "./lib.mjs";

const HELP = `
Usage: node bridge/draft.mjs <number|#number|id> [--out FILE]

Asks the backend to have Claude write a draft reply for the request (backend action admin.draft).
The draft is saved on the request (visible in admin.html) and printed here. Nothing is sent to the
family member. This makes one Anthropic API call (a few cents) and can take a minute.

Use it when there is no draft yet, or when the saved draft is older than the latest family message.

Arguments:
  <number>    the request number, e.g. 7 (quote it if you use a hash: '#7')

Options:
  --out FILE  also write the raw draft text to FILE (handy for editing before reply.mjs --file)
  -h, --help  show this help

The draft is only a proposal. Post a reply only after the owner approves the exact text:
  node bridge/reply.mjs <number> --file <file> [--email]
`;

runMain(async () => {
  const { values, positionals } = parseCli(
    HELP,
    { out: { type: "string" } },
    { minPositionals: 1, maxPositionals: 1, missing: MISSING_REF },
  );
  const { request: listed, settings } = await resolveRequest(positionals[0]);

  process.stderr.write(`Asking Claude for a draft for #${listed.number}. This can take a minute...\n`);
  // Apps Script allows up to 6 minutes per request; the Claude call happens inside it.
  const { request } = await call("admin.draft", { id: listed.id }, { timeoutMs: 330000 });
  const draft = String(request?.draft ?? "").trim();
  if (!draft) {
    const reason = request?.lastError ? ` Last error: ${request.lastError}` : "";
    throw new BridgeError("server_error", `The backend did not return a draft for #${listed.number}.${reason}`);
  }
  if (values.out) writeFileSync(values.out, draft + "\n");

  const out = [
    `# Draft for #${request.number} (NOT sent)`,
    "",
    `- Request: ${request.requesterName || listed.requesterName} · ${categoryLabel(request.category)} · ${quoteTitle(request.title)} · ${statusLabel(request)}`,
    `- Written ${ago(request.draftAt || new Date().toISOString())}; saved on the request, visible in admin.html`,
    values.out ? `- Raw text also written to: ${values.out}` : null,
    request.triage ? `- Claude's triage (for you, in English): ${oneLine(request.triage, 600)}` : null,
    "",
    "## Draft text",
    "",
    fence(draft, "markdown"),
    "",
    "Show this to the owner. Only after they approve the exact text (as is or edited), post it with:",
    `\`node bridge/reply.mjs ${request.number} --file <file-with-approved-text>${request.contactEmail ? " [--email]" : ""}\``,
    `(Every reply here is sent as ${ownerName(settings)}, in the owner's own voice. There is no other voice.)`,
  ].filter((l) => l !== null);
  process.stdout.write(out.join("\n") + "\n");
});
