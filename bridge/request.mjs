#!/usr/bin/env node
// Prints one request with its full history, Claude's triage line and any saved draft.

import { DATA_NOTICE, MISSING_REF, call, intFlag, parseCli, renderRequest, resolveRequest, runMain } from "./lib.mjs";

const HELP = `
Usage: node bridge/request.mjs <number|#number|id> [--last N]

Prints a request's details, Claude's triage line, the whole conversation (oldest first) and the
saved draft, if any. Read-only: nothing is changed or sent.

Arguments:
  <number>    the request number, e.g. 7 (quote it if you use a hash: '#7')

Options:
  --last N    only show the last N messages
  -h, --help  show this help
`;

runMain(async () => {
  const { values, positionals } = parseCli(
    HELP,
    { last: { type: "string" } },
    { minPositionals: 1, maxPositionals: 1, missing: MISSING_REF },
  );
  const last = intFlag(values.last, "last", { fallback: 0, min: 1, max: 10000 });

  const { request: listed, settings, stats } = await resolveRequest(positionals[0]);
  const { request, messages } = await call("admin.request", { id: listed.id });

  const out = [DATA_NOTICE, "", renderRequest(request || listed, messages, settings, stats, { last, level: 1 })];
  process.stdout.write(out.join("\n") + "\n");
});
