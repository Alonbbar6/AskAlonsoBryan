// Tests for backend/Code.gs running inside the fake Apps Script environment (dev/fakes.mjs).
// Run from the repo root: node --test   (or: node --test dev/*.test.mjs)

import { test } from "node:test";
import assert from "node:assert/strict";
import { createAppsScriptEnv, coerceCellInput, fakeAnswer, looksSpanish } from "./fakes.mjs";

const START = "2026-09-16T15:00:00.000Z"; // 10:00 in America/Bogota
const SITE = "https://example.github.io/ask/";
const OWNER = "owner@example.com";
const HOUR = 3600 * 1000;

// SPEC §1: the family shape carries nothing internal.
const FAMILY_KEYS = [
  "category", "createdAt", "id", "lastFrom", "messageCount", "number",
  "requesterName", "status", "title", "unread", "updatedAt", "urgency",
].sort();
const ADMIN_KEYS = [
  ...FAMILY_KEYS,
  "contactEmail", "draft", "draftAt", "errorCount", "lastError", "links", "needsHuman", "requesterId", "triage",
].sort();
const HIDDEN_FROM_FAMILY = ["draft", "draftAt", "triage", "requesterId", "contactEmail", "links", "errorCount", "lastError", "needsHuman"];
const MESSAGE_KEYS = ["createdAt", "from", "id", "requestId", "text", "via"];
const SETTINGS_KEYS = ["autoDraft", "dailyCap", "defaultLang", "emailReplies", "notifyEmail", "notifyOn", "ownerName", "siteUrl"].sort();
const STATS_KEYS = ["apiKeyConfigured", "dailyCap", "draftsToday", "familyToken", "lastError", "lastTickAt", "needsCount"].sort();
const REQUEST_HEADERS = [
  "id", "number", "requesterId", "requesterName", "category", "urgency", "title", "status", "links",
  "contactEmail", "createdAt", "updatedAt", "lastFrom", "unread", "draft", "draftAt", "triage",
  "errorCount", "lastError",
];
const MESSAGE_HEADERS = ["id", "requestId", "from", "text", "createdAt", "via"];

// Two dev people; `who` is 32 hex (SPEC §1).
const WHO_A = "0123456789abcdef0123456789abcdef";
const WHO_B = "fedcba9876543210fedcba9876543210";
const WHO_C = "aaaaaaaabbbbbbbbccccccccdddddddd";
const WHO_D = "11112222333344445555666677778888";
const NAME_A = "Tía Rosa";
const NAME_B = "Bryan Jr";

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function makeEnv({ settings = {}, apiKey = "sk-test-key", claudeMode = "ok" } = {}) {
  const env = createAppsScriptEnv({ start: START, claudeMode });
  const props = env.state.properties;
  if (apiKey) props.ANTHROPIC_API_KEY = apiKey;
  props.SETTINGS = JSON.stringify({
    ownerName: "Alonso Bryan",
    siteUrl: SITE,
    notifyEmail: OWNER,
    ...settings,
  });
  env.run("setup"); // generates FAMILY_TOKEN and ADMIN_TOKEN
  env.family = props.FAMILY_TOKEN;
  env.adminToken = props.ADMIN_TOKEN;
  env.logs = () => env.state.logs.map((l) => l.text).join("\n");
  return env;
}

// Wraps a scenario: fresh environment, then checks that Code.gs broke no platform rule.
function scenario(name, fn, options) {
  test(name, async () => {
    const env = makeEnv(options);
    await fn(env);
    for (const err of env.state.claude.hookErrors) throw err;
    assert.deepEqual(env.state.violations, [], "platform rule violations");
  });
}

function ok(res) {
  assert.equal(res.ok, true, "expected ok, got " + JSON.stringify(res.error));
  return res.result;
}

function failCode(res) {
  assert.equal(res.ok, false, "expected an error, got " + JSON.stringify(res.result));
  assert.equal(typeof res.error.message, "string");
  assert.ok(res.error.message.length > 0);
  assert.equal("result" in res, false);
  return res.error.code;
}

const family = (env, action, params = {}) => env.call(action, { family: env.family, ...params });
const admin = (env, action, params = {}) => env.call("admin." + action, { admin: env.adminToken, ...params });

function createRequest(env, params = {}) {
  const body = {
    who: WHO_A, name: NAME_A, category: "tech", urgency: "normal",
    title: "La impresora no imprime",
    text: "Hola, la impresora dejó de imprimir desde ayer y no sé qué hacer.",
    ...params,
  };
  return ok(family(env, "create", body)).request;
}

const claudeRequests = (env) => env.state.claude.requests;

function lastClaude(env) {
  const list = claudeRequests(env);
  assert.ok(list.length > 0, "expected a Claude request");
  return list[list.length - 1];
}

function textOf(content) {
  return typeof content === "string" ? content : content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

const notifications = (env) => env.state.sentEmails.filter((m) => m.to === OWNER);
const replies = (env) => env.state.sentEmails.filter((m) => m.to !== OWNER);

function stamps(env, key) {
  const entry = env.state.cache.get(key);
  if (!entry || entry.expires <= env.clock.peek()) return [];
  return JSON.parse(entry.value);
}

// ---------------------------------------------------------------------------------------------
// The harness itself
// ---------------------------------------------------------------------------------------------

test("fake Sheets coerces written strings like Google Sheets (a naive writer would fail)", () => {
  assert.equal(coerceCellInput("00123"), 123);
  assert.equal(coerceCellInput("+1"), 1);
  assert.equal(coerceCellInput("TRUE"), true);
  assert.equal(coerceCellInput("-x"), "#ERROR!");
  assert.equal(coerceCellInput("=SUM(A1)"), 0);
  assert.equal(Object.prototype.toString.call(coerceCellInput("2026-01-05")), "[object Date]");
  assert.equal(coerceCellInput("'00123"), "00123");
  assert.equal(coerceCellInput("''quoted"), "'quoted");
  assert.equal(coerceCellInput("hola"), "hola");
  assert.throws(() => coerceCellInput("x".repeat(50001)), /50000/);
});

test("fake Claude answers with a TRIAGE line and a draft in the family member's language", () => {
  const spanish = fakeAnswer("[Solicitud #1 · tech · urgencia normal · de Tía Rosa · título: Impresora]\n\nHola, necesito ayuda con la impresora de la casa, por favor.");
  assert.match(spanish, /^TRIAGE: /);
  assert.equal(spanish.split("\n")[1], "", "a blank line separates the triage from the draft");
  assert.match(spanish, /\n1\. Abre el archivo/);
  assert.doesNotMatch(spanish.split("\n")[0], /Solicitud #1/, "the context header is not quoted back");

  const english = fakeAnswer("[Solicitud #2 · school · urgencia soon · de Bryan Jr · título: Essay]\n\nHi, I need help with my homework, can you please take a look at this file?");
  assert.match(english, /^TRIAGE: /);
  assert.match(english, /\n1\. Open the file/);
  assert.equal(looksSpanish("Hola, necesito ayuda por favor con mi computadora"), true);
  assert.equal(looksSpanish("Hi, I need help with my computer please, can you look?"), false);

  const noMarker = fakeAnswer("Hola, necesito ayuda", { triage: false });
  assert.doesNotMatch(noMarker, /TRIAGE/);
});

test("fake Claude rejects malformed requests with HTTP 400", () => {
  const env = createAppsScriptEnv({ start: START, loadCode: false });
  const { UrlFetchApp } = env.services;
  const base = {
    method: "post",
    contentType: "application/json",
    headers: { "x-api-key": "k", "anthropic-version": "2023-06-01", "anthropic-beta": "server-side-fallback-2026-07-01" },
    muteHttpExceptions: true,
  };
  const send = (body, overrides = {}) => {
    const res = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", { ...base, ...overrides, payload: JSON.stringify(body) });
    return { status: res.getResponseCode(), body: JSON.parse(res.getContentText()) };
  };
  const good = { model: "claude-opus-5", max_tokens: 8000, fallbacks: "default", output_config: { effort: "low" }, system: "s", messages: [{ role: "user", content: "hola" }] };
  assert.equal(send(good).status, 200);
  assert.equal(send(good).body.content[0].type, "thinking");
  assert.equal(send({ ...good, messages: [] }).status, 400);
  assert.equal(send({ ...good, messages: [{ role: "assistant", content: "x" }] }).status, 400);
  assert.equal(send({ ...good, messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }] }).status, 400);
  assert.equal(send({ ...good, messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] }).status, 400, "must end with a user turn");
  assert.equal(send({ ...good, messages: [{ role: "user", content: "   " }] }).status, 400);
  assert.equal(send({ ...good, messages: [{ role: "user", content: [{ type: "image", source: {} }] }] }).status, 400, "this backend never sends images");
  assert.equal(send({ ...good, max_tokens: undefined }).status, 400);
  assert.equal(send({ ...good, model: "claude-imaginary" }).status, 404);
  assert.equal(send({ ...good, nonsense: 1 }).status, 400);
  assert.equal(send(good, { headers: { "x-api-key": "k", "anthropic-version": "2023-06-01" } }).status, 400, "fallbacks needs the beta header");
  assert.equal(send(good, { headers: { "anthropic-version": "2023-06-01", "anthropic-beta": "server-side-fallback-2026-07-01" } }).status, 401);
  assert.equal(send(good, { contentType: "text/plain" }).status, 400);
  assert.throws(() => UrlFetchApp.fetch("https://example.com/", { muteHttpExceptions: true }), /Address unavailable/);
  env.setClaudeMode("fail");
  assert.equal(send(good).status, 500);
  assert.throws(() => UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", { ...base, muteHttpExceptions: false, payload: JSON.stringify(good) }), /returned code 500/);
  env.setClaudeMode("refusal");
  const refusal = send(good);
  assert.equal(refusal.body.stop_reason, "refusal");
  assert.deepEqual(refusal.body.content, []);
});

// ---------------------------------------------------------------------------------------------
// HTTP basics and auth (SPEC §1)
// ---------------------------------------------------------------------------------------------

scenario("GET ping answers pong; other GETs are bad_request", (env) => {
  const pong = ok(env.get({ action: "ping" }));
  assert.equal(pong.pong, true);
  assert.match(pong.now, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(failCode(env.get({})), "bad_request");
  assert.equal(failCode(env.get({ action: "list", family: env.family })), "bad_request");
});

scenario("family and admin tokens are checked on every action", (env) => {
  const wrongFamily = env.family.slice(0, -1) + (env.family.endsWith("a") ? "b" : "a");
  for (const action of ["info", "list", "request", "create", "send", "close"]) {
    assert.equal(failCode(env.call(action, { who: WHO_A, id: "r_x" })), "unauthorized", action + " without family");
    assert.equal(failCode(env.call(action, { family: wrongFamily, who: WHO_A, id: "r_x" })), "unauthorized", action + " wrong family");
    assert.equal(failCode(env.call(action, { family: env.adminToken, who: WHO_A, id: "r_x" })), "unauthorized", action + " admin token as family");
    assert.equal(failCode(env.call(action, { family: env.family.slice(0, 10), who: WHO_A, id: "r_x" })), "unauthorized", action + " prefix of family");
    assert.equal(failCode(env.call(action, { family: "", who: WHO_A, id: "r_x" })), "unauthorized", action + " empty family");
    assert.equal(failCode(env.call(action, { family: 12345, who: WHO_A, id: "r_x" })), "unauthorized", action + " non-string family");
  }
  for (const action of ["list", "request", "reply", "draft", "close", "delete", "settings", "events", "stats"]) {
    assert.equal(failCode(env.call("admin." + action, { id: "r_x" })), "unauthorized", action + " without admin");
    assert.equal(failCode(env.call("admin." + action, { admin: env.family, id: "r_x" })), "unauthorized", action + " family as admin");
    assert.equal(failCode(env.call("admin." + action, { admin: "", id: "r_x" })), "unauthorized", action + " empty admin");
  }
  // Family errors are Spanish and name the owner; admin errors are English.
  assert.match(env.call("list", {}).error.message, /Alonso Bryan/);
  assert.match(env.call("admin.list", {}).error.message, /admin token/i);

  // Malformed bodies and unknown actions.
  const raw = env.context.doPost({ parameter: {}, postData: { contents: "not json", type: "text/plain" } });
  assert.equal(JSON.parse(raw.getContent()).error.code, "bad_request");
  assert.equal(JSON.parse(env.context.doPost({ parameter: {} }).getContent()).error.code, "bad_request");
  assert.equal(failCode(env.call("nope", { family: env.family })), "bad_request");
  assert.equal(failCode(env.call("admin.nope", { admin: env.adminToken })), "bad_request");
  assert.equal(failCode(env.call("toString", { family: env.family })), "bad_request", "inherited properties are not actions");
  assert.equal(failCode(env.call("constructor", { admin: env.adminToken })), "bad_request");
  assert.equal(claudeRequests(env).length, 0);
});

scenario("who must be exactly 32 hex characters; upper case is the same person", (env) => {
  const badWho = (who) => {
    for (const action of ["list", "request", "create", "send", "close"]) {
      const res = family(env, action, { who, id: "r_x", name: NAME_A, category: "tech", urgency: "normal", title: "t", text: "x" });
      assert.equal(failCode(res), "bad_request", action + " with who=" + JSON.stringify(who));
    }
  };
  badWho(undefined);
  badWho("");
  badWho("0123456789abcdef0123456789abcde"); // 31
  badWho("0123456789abcdef0123456789abcdef0"); // 33
  badWho("0123456789abcdef0123456789abcdeg"); // not hex
  badWho("0123456789abcdef-123456789abcdef");
  badWho(" 0123456789abcdef0123456789abcdef");
  badWho(12345678901234567890123456789012);
  badWho(["0123456789abcdef0123456789abcdef"]);
  assert.equal(ok(family(env, "list", { who: WHO_A })).requests.length, 0, "nothing was created by the bad calls");

  // A valid upper-case code is accepted and normalized to the same person.
  const upper = ok(family(env, "create", {
    who: WHO_A.toUpperCase(), name: NAME_A, category: "tech", urgency: "normal", title: "Mayúsculas", text: "Hola",
  })).request;
  assert.equal(ok(family(env, "list", { who: WHO_A })).requests.length, 1);
  assert.equal(ok(family(env, "request", { who: WHO_A.toUpperCase(), id: upper.id })).request.id, upper.id);
  assert.equal(env.sheetRecords("Requests")[0].requesterId, WHO_A, "stored in lower case");
});

scenario("info reports the owner name, the default language and the time", (env) => {
  const info = ok(family(env, "info"));
  assert.deepEqual(Object.keys(info).sort(), ["defaultLang", "now", "ownerName"]);
  assert.equal(info.ownerName, "Alonso Bryan");
  assert.equal(info.defaultLang, "es");
  assert.match(info.now, /Z$/);
  ok(admin(env, "settings", { set: { ownerName: "Alonso B.", defaultLang: "en" } }));
  assert.equal(ok(family(env, "info")).ownerName, "Alonso B.");
  assert.equal(ok(family(env, "info")).defaultLang, "en");
});

// ---------------------------------------------------------------------------------------------
// who isolation (SPEC §1: each family member sees only their own requests)
// ---------------------------------------------------------------------------------------------

scenario("person B cannot read, follow up on or close person A's request", (env) => {
  const a = createRequest(env, { title: "De Rosa", contactEmail: "rosa@example.com" });
  env.clock.advance(1000);
  const b = createRequest(env, { who: WHO_B, name: NAME_B, title: "De Bryan" });

  // The list never leaks another person's row.
  assert.deepEqual(ok(family(env, "list", { who: WHO_A })).requests.map((r) => r.id), [a.id]);
  assert.deepEqual(ok(family(env, "list", { who: WHO_B })).requests.map((r) => r.id), [b.id]);
  assert.deepEqual(ok(family(env, "list", { who: WHO_C })).requests, []);

  // Reading, following up and closing all answer exactly like a request that does not exist.
  const missing = family(env, "request", { who: WHO_B, id: "r_does_not_exist" });
  const foreign = family(env, "request", { who: WHO_B, id: a.id });
  assert.equal(failCode(missing), "not_found");
  assert.equal(failCode(foreign), "not_found");
  assert.deepEqual(foreign.error, missing.error, "the same answer for foreign and unknown ids");
  assert.equal(failCode(family(env, "send", { who: WHO_B, id: a.id, text: "Hola" })), "not_found");
  assert.equal(failCode(family(env, "close", { who: WHO_B, id: a.id })), "not_found");
  assert.equal(failCode(family(env, "request", { who: WHO_C, id: a.id })), "not_found");

  // Nothing of A's changed.
  const detail = ok(admin(env, "request", { id: a.id }));
  assert.equal(detail.request.status, "new");
  assert.equal(detail.messages.length, 1);
  assert.equal(detail.request.requesterId, WHO_A);

  // A can still do all three.
  assert.equal(ok(family(env, "request", { who: WHO_A, id: a.id })).request.id, a.id);
  env.clock.advance(1000);
  assert.equal(ok(family(env, "send", { who: WHO_A, id: a.id, text: "Ya lo intenté" })).request.messageCount, 2);
  assert.equal(ok(family(env, "close", { who: WHO_A, id: a.id })).request.status, "closed");
});

scenario("the family shape never carries draft, triage, requesterId, contactEmail, links or errors", (env) => {
  const created = createRequest(env, { contactEmail: "rosa@example.com", links: "https://example.com/a" });
  env.run("tick"); // a draft exists from here on
  assert.ok(ok(admin(env, "request", { id: created.id })).request.draft);

  const shapes = [
    created,
    ok(family(env, "list", { who: WHO_A })).requests[0],
    ok(family(env, "request", { who: WHO_A, id: created.id })).request,
    ok(family(env, "send", { who: WHO_A, id: created.id, text: "Otra cosa" })).request,
    ok(family(env, "close", { who: WHO_A, id: created.id })).request,
  ];
  for (const shape of shapes) {
    assert.deepEqual(Object.keys(shape).sort(), FAMILY_KEYS);
    for (const hidden of HIDDEN_FROM_FAMILY) assert.equal(hidden in shape, false, hidden + " must not reach the family");
    assert.equal(JSON.stringify(shape).includes(WHO_A), false, "the requesterId is never echoed back");
  }
  const messages = ok(family(env, "request", { who: WHO_A, id: created.id })).messages;
  for (const m of messages) assert.deepEqual(Object.keys(m).sort(), MESSAGE_KEYS.slice().sort());
});

// ---------------------------------------------------------------------------------------------
// Validation, numbering, round-trips, shapes
// ---------------------------------------------------------------------------------------------

scenario("create validates every field", (env) => {
  const base = { who: WHO_A, name: NAME_A, category: "tech", urgency: "normal", title: "Título", text: "Texto" };
  const bad = (params) => assert.equal(failCode(family(env, "create", { ...base, ...params })), "bad_request", JSON.stringify(params).slice(0, 90));
  bad({ name: "" });
  bad({ name: "   " });
  bad({ name: undefined });
  bad({ name: 42 });
  bad({ name: "n".repeat(61) });
  bad({ category: "otro-tipo" });
  bad({ category: undefined });
  bad({ category: "TECH" });
  bad({ urgency: "ya" });
  bad({ urgency: undefined });
  bad({ title: "" });
  bad({ title: "  \n " });
  bad({ title: undefined });
  bad({ title: 42 });
  bad({ title: "x".repeat(141) });
  bad({ text: "" });
  bad({ text: " \n\t " });
  bad({ text: undefined });
  bad({ text: "x".repeat(8001) });
  bad({ links: "x".repeat(2001) });
  bad({ links: 5 });
  bad({ contactEmail: "rosa@" });
  bad({ contactEmail: "no-es-correo" });
  bad({ contactEmail: "a@b.c".repeat(40) });
  bad({ contactEmail: 5 });
  assert.equal(ok(family(env, "list", { who: WHO_A })).requests.length, 0, "nothing stored by invalid creates");

  const trimmed = createRequest(env, { name: "  Tía   Rosa  ", title: "   Hola  " });
  assert.equal(trimmed.title, "Hola");
  assert.equal(trimmed.requesterName, "Tía Rosa");
  const longest = createRequest(env, { name: "n".repeat(60), title: "t".repeat(140), text: "x".repeat(8000), links: "l".repeat(2000) });
  assert.equal(longest.title.length, 140);
  assert.equal(longest.status, "new");
  assert.equal(longest.lastFrom, "family");
  assert.equal(longest.unread, false);
  assert.equal(longest.messageCount, 1);
  const detail = ok(family(env, "request", { who: WHO_A, id: longest.id }));
  assert.equal(detail.messages[0].text.length, 8000, "8000 characters survive the round trip");
  assert.equal(detail.messages[0].via, "site");
  assert.equal(ok(admin(env, "request", { id: longest.id })).request.links.length, 2000);

  // Optional fields default to empty, and the email is normalized.
  const plain = createRequest(env, { title: "Sin extras" });
  const adminView = ok(admin(env, "request", { id: plain.id })).request;
  assert.equal(adminView.links, "");
  assert.equal(adminView.contactEmail, "");
  const mailed = createRequest(env, { title: "Con correo", contactEmail: "  Rosa@Example.COM " });
  assert.equal(ok(admin(env, "request", { id: mailed.id })).request.contactEmail, "rosa@example.com");

  // send and close validate too.
  assert.equal(failCode(family(env, "send", { who: WHO_A, id: plain.id, text: "" })), "bad_request");
  assert.equal(failCode(family(env, "send", { who: WHO_A, id: plain.id, text: "x".repeat(8001) })), "bad_request");
  assert.equal(failCode(family(env, "send", { who: WHO_A, text: "hola" })), "bad_request");
  assert.equal(failCode(family(env, "request", { who: WHO_A })), "bad_request");
  assert.equal(failCode(family(env, "close", { who: WHO_A, id: 7 })), "bad_request");
  assert.equal(ok(family(env, "send", { who: WHO_A, id: plain.id, text: "y".repeat(8000) })).request.messageCount, 2);
});

scenario("request numbers are sequential across different people and never reused", (env) => {
  const a = createRequest(env, { title: "A" });
  const b = createRequest(env, { who: WHO_B, name: NAME_B, title: "B" });
  const c = createRequest(env, { who: WHO_C, name: "Prima Ana", title: "C" });
  const d = createRequest(env, { title: "D" });
  assert.deepEqual([a.number, b.number, c.number, d.number], [1, 2, 3, 4]);
  assert.equal(ok(admin(env, "delete", { id: d.id })).deleted, true);
  assert.equal(createRequest(env, { who: WHO_B, name: NAME_B, title: "E" }).number, 5);
  assert.equal(new Set([a.id, b.id, c.id]).size, 3);
  assert.equal(env.state.properties.COUNTER, "5");
});

scenario("tricky strings round-trip exactly through the Sheet", (env) => {
  const tricky = [
    "=SUM(A1)", "+1", "-x", "@x", "00123", "2026-01-05", "TRUE", "false", "'quoted", "''doble", "1,000", "$2.99",
    "12%", "10:30", "1e5", "#N/A", '=HYPERLINK("http://x")', "😀 emoji 🐍 ñandú", "línea 1\nlínea 2\n\n  - viñeta\n\tfin",
    "- empieza con guion", '<b>html</b> & "comillas"',
  ];
  const long = "=" + "x".repeat(7999);
  const created = [];
  // One person per string, so the 20-per-hour personal limit never gets in the way.
  const whoFor = (i) => i.toString(16).padStart(2, "0").repeat(16);
  tricky.forEach((s, i) => {
    const title = s.replace(/[\r\n\t]+/g, " ").trim();
    const who = whoFor(i);
    const r = createRequest(env, { who, title, text: s, links: s.slice(0, 200) });
    created.push({ s, title, id: r.id, who });
    assert.equal(r.title, title);
  });
  const bigWho = whoFor(tricky.length);
  const big = createRequest(env, { who: bigWho, title: "8000", text: long });
  created.push({ s: long, title: "8000", id: big.id, who: bigWho });

  for (const c of created) {
    const res = ok(family(env, "request", { who: c.who, id: c.id }));
    assert.equal(res.request.title, c.title);
    assert.equal(res.messages[0].text, c.s, "text " + JSON.stringify(c.s).slice(0, 40));
    assert.equal(ok(family(env, "list", { who: c.who })).requests[0].title, c.title);
  }
  const adminList = ok(admin(env, "list")).requests;
  for (const c of created.slice(0, tricky.length)) {
    assert.equal(adminList.find((r) => r.id === c.id).links, c.s.slice(0, 200), "links " + JSON.stringify(c.s).slice(0, 40));
  }

  // Follow-ups and owner replies round-trip too.
  const target = created[0];
  ok(family(env, "send", { who: target.who, id: target.id, text: "00123" }));
  ok(admin(env, "reply", { id: target.id, text: "- uno\n- =dos" }));
  const msgs = ok(family(env, "request", { who: target.who, id: target.id })).messages;
  assert.equal(msgs[1].text, "00123");
  assert.equal(msgs[2].text, "- uno\n- =dos");

  // Stored cell types: numbers and booleans are real values, text is text.
  const row = env.sheetRecords("Requests").find((r) => r.id === target.id);
  assert.equal(typeof row.number, "number");
  assert.equal(typeof row.unread, "boolean");
  assert.equal(typeof row.errorCount, "number");
  assert.equal(typeof row.createdAt, "string");
  assert.equal(row.title, "=SUM(A1)");
  assert.equal(row.requesterId, target.who);
});

scenario("list, request and admin shapes match SPEC", (env) => {
  const r1 = createRequest(env, { title: "Primero" });
  env.clock.advance(1000);
  const r2 = createRequest(env, { title: "Segundo", urgency: "urgent", category: "money" });

  const list = ok(family(env, "list", { who: WHO_A })).requests;
  assert.deepEqual(list.map((r) => r.id), [r2.id, r1.id], "newest first by updatedAt");
  for (const r of list) assert.deepEqual(Object.keys(r).sort(), FAMILY_KEYS);
  env.clock.advance(1000);
  ok(family(env, "send", { who: WHO_A, id: r1.id, text: "Otra cosa" }));
  assert.equal(ok(family(env, "list", { who: WHO_A })).requests[0].id, r1.id, "a follow-up moves it to the top");

  const detail = ok(family(env, "request", { who: WHO_A, id: r1.id }));
  assert.deepEqual(Object.keys(detail.request).sort(), FAMILY_KEYS);
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.request.messageCount, 2);
  for (const m of detail.messages) {
    assert.deepEqual(Object.keys(m).sort(), MESSAGE_KEYS.slice().sort());
    assert.equal(m.requestId, r1.id);
    assert.equal(m.from, "family");
    assert.equal(m.via, "site");
  }
  assert.ok(detail.messages[0].createdAt < detail.messages[1].createdAt, "messages ascending");
  assert.equal(failCode(family(env, "request", { who: WHO_A, id: "r_missing" })), "not_found");

  const adminList = ok(admin(env, "list"));
  assert.deepEqual(Object.keys(adminList.settings).sort(), SETTINGS_KEYS);
  assert.deepEqual(Object.keys(adminList.stats).sort(), STATS_KEYS);
  assert.equal(adminList.stats.familyToken, env.family);
  assert.equal(adminList.stats.apiKeyConfigured, true);
  assert.equal(adminList.stats.needsCount, 2);
  assert.equal(adminList.stats.dailyCap, 40);
  assert.equal(adminList.stats.draftsToday, 0);
  for (const r of adminList.requests) {
    assert.deepEqual(Object.keys(r).sort(), ADMIN_KEYS);
    assert.equal(r.draft, null);
    assert.equal(r.draftAt, null);
    assert.equal(r.triage, null);
    assert.equal(r.lastError, null);
    assert.equal(r.errorCount, 0);
    assert.equal(r.needsHuman, true, "someone is waiting on the owner");
  }
  assert.deepEqual(ok(admin(env, "list", { filter: "needs" })).requests.map((r) => r.id).sort(), [r1.id, r2.id].sort());
  assert.deepEqual(ok(admin(env, "list", { filter: "all" })).requests.length, 2);
  assert.equal(failCode(admin(env, "list", { filter: "weird" })), "bad_request");
  assert.deepEqual(Object.keys(ok(admin(env, "request", { id: r1.id })).request).sort(), ADMIN_KEYS);
  assert.equal(failCode(admin(env, "request", { id: "r_missing" })), "not_found");
  assert.equal(failCode(admin(env, "request", {})), "bad_request");
  assert.deepEqual(Object.keys(ok(admin(env, "stats")).stats).sort(), STATS_KEYS);
});

scenario("opening a request marks the owner's reply as read", (env) => {
  const r = createRequest(env);
  ok(admin(env, "reply", { id: r.id, text: "Ya lo reviso" }));
  assert.equal(ok(family(env, "list", { who: WHO_A })).requests[0].unread, true);
  const opened = ok(family(env, "request", { who: WHO_A, id: r.id }));
  assert.equal(opened.request.unread, false);
  assert.equal(ok(family(env, "list", { who: WHO_A })).requests[0].unread, false);
  assert.equal(env.sheetRecords("Requests")[0].unread, false);
});

// ---------------------------------------------------------------------------------------------
// Rate limits (SPEC §1)
// ---------------------------------------------------------------------------------------------

scenario("20 create+send per person per hour and 60 for the site; a rejection charges neither window", (env) => {
  const create = (who, name, i) => family(env, "create", { who, name, category: "tech", urgency: "normal", title: name + " " + i, text: "Hola" });

  for (let i = 0; i < 19; i++) ok(create(WHO_A, NAME_A, i));
  const mine = ok(create(WHO_A, NAME_A, 19)).request; // 20th
  assert.equal(stamps(env, "rate:who:" + WHO_A).length, 20);
  assert.equal(stamps(env, "rate:site").length, 20);

  const limited = create(WHO_A, NAME_A, 20);
  assert.equal(failCode(limited), "rate_limited");
  assert.match(limited.error.message, /Espera/);
  assert.equal(stamps(env, "rate:site").length, 20, "a person-limited call does not charge the site window");
  assert.equal(failCode(family(env, "send", { who: WHO_A, id: mine.id, text: "otra" })), "rate_limited", "send counts in the same window");
  assert.equal(ok(family(env, "list", { who: WHO_A })).requests.length, 20, "reads are never limited");
  ok(family(env, "request", { who: WHO_A, id: mine.id }));
  ok(family(env, "close", { who: WHO_A, id: mine.id }));

  // Two more people fill the site window.
  for (let i = 0; i < 20; i++) ok(create(WHO_B, NAME_B, i));
  for (let i = 0; i < 20; i++) ok(create(WHO_C, "Prima Ana", i));
  assert.equal(stamps(env, "rate:site").length, 60);

  // A fresh person is blocked by the site window, and their own window stays empty.
  assert.equal(failCode(create(WHO_D, "Primo Luis", 0)), "rate_limited");
  assert.deepEqual(stamps(env, "rate:who:" + WHO_D), [], "a site-limited call does not charge the person window");
  assert.equal(ok(admin(env, "list")).requests.length, 60, "nothing was stored by the rejected calls");

  // An hour later both windows are free again.
  env.clock.advance(61 * 60 * 1000);
  ok(create(WHO_D, "Primo Luis", 0));
  ok(create(WHO_A, NAME_A, 21));
}, { settings: { notifyEmail: "", autoDraft: false } });

// ---------------------------------------------------------------------------------------------
// Drafting (SPEC §3) — Claude drafts, nothing is ever sent to the family
// ---------------------------------------------------------------------------------------------

scenario("tick drafts a waiting request: new becomes working, draft and triage are stored", (env) => {
  const r = createRequest(env, { links: "https://example.com/manual.pdf" });
  assert.equal(notifications(env).length, 0, "the owner email waits for the draft");
  env.run("tick");

  const req = lastClaude(env);
  assert.equal(req.status, 200, "the fake API accepted the request: " + req.error);
  assert.equal(claudeRequests(env).length, 1);
  assert.equal(req.headers["x-api-key"], "[redacted]");
  assert.equal(req.headers["anthropic-version"], "2023-06-01");
  assert.equal(req.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  assert.equal(req.body.model, "claude-opus-5");
  assert.equal(req.body.max_tokens, 8000);
  assert.equal(req.body.fallbacks, "default");
  assert.deepEqual(req.body.output_config, { effort: "low" });
  assert.match(req.body.system, /^You help Alonso Bryan answer requests from his family:?/);
  assert.match(req.body.system, /Start the line with the literal word TRIAGE:/);
  assert.doesNotMatch(req.body.system, /\{ownerName\}/);
  assert.equal(req.body.messages.length, 1);
  assert.equal(req.body.messages[0].role, "user");
  const first = textOf(req.body.messages[0].content);
  assert.ok(first.startsWith("[Solicitud #1 · tech · urgencia normal · de Tía Rosa · título: La impresora no imprime]\nEnlaces: https://example.com/manual.pdf\n\nHola, la impresora"), first);

  const detail = ok(admin(env, "request", { id: r.id }));
  assert.equal(detail.request.status, "working", "a draft means the owner is on it");
  assert.equal(detail.request.lastFrom, "family");
  assert.equal(detail.request.unread, false);
  assert.equal(detail.request.errorCount, 0);
  assert.equal(detail.request.needsHuman, true);
  assert.match(detail.request.triage, /^They need help with/);
  assert.doesNotMatch(detail.request.draft, /TRIAGE/, "the triage line is stripped out of the draft");
  assert.match(detail.request.draft, /\n1\. Abre el archivo/);
  assert.ok(detail.request.draftAt >= detail.request.createdAt);
  assert.equal(detail.messages.length, 1, "a draft is not a message");

  // The family sees the new status and no draft at all.
  const fam = ok(family(env, "request", { who: WHO_A, id: r.id }));
  assert.equal(fam.request.status, "working");
  assert.equal(fam.messages.length, 1);
  assert.equal(JSON.stringify(fam).includes("TRIAGE"), false);
  assert.equal(JSON.stringify(fam).includes(detail.request.draft.slice(0, 30)), false);

  // Exactly one owner email, with the triage line, the request and the draft.
  const sent = notifications(env);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, OWNER);
  assert.equal(sent[0].subject, "[Ask] #1 · Tía Rosa · La impresora no imprime");
  assert.equal(sent[0].name, "Ask Alonso Bryan");
  assert.ok(sent[0].body.includes(detail.request.triage), "the triage line is in the email");
  assert.ok(sent[0].body.includes(detail.request.draft), "the draft is in the email");
  assert.ok(sent[0].body.includes("la impresora dejó de imprimir"), "the request text is in the email");
  assert.ok(sent[0].body.includes("Request #1 · tech · urgency normal · from Tía Rosa"));
  assert.ok(sent[0].htmlBody.includes(SITE + "admin.html"));

  // Nothing more happens on later ticks.
  env.run("tick");
  env.run("tick");
  assert.equal(claudeRequests(env).length, 1);
  assert.equal(notifications(env).length, 1, "one email per family message, never per retry");
  assert.equal(ok(admin(env, "stats")).stats.draftsToday, 1);
  assert.ok(ok(admin(env, "stats")).stats.lastTickAt);
  assert.equal(env.state.cache.has("tick:lease"), false, "the tick lease is released");
  assert.equal(env.state.cache.has("draft:" + r.id), false, "the draft lease is released");
});

scenario("a draft without the TRIAGE marker becomes the whole draft with no triage line", (env) => {
  const r = createRequest(env);
  env.run("tick");
  const detail = ok(admin(env, "request", { id: r.id })).request;
  assert.equal(detail.triage, null, "no marker means no triage line (SPEC §4)");
  assert.match(detail.draft, /^Claro que sí/);
  assert.equal(detail.status, "working");
  const sent = notifications(env);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].body.includes(detail.draft));
}, { claudeMode: "notriage" });

scenario("the draft answers in the language the family member used", (env) => {
  const es = createRequest(env, { title: "Impresora", text: "Hola, necesito ayuda con la impresora de la casa por favor." });
  const en = createRequest(env, {
    who: WHO_B, name: NAME_B, category: "school", urgency: "soon", title: "Essay outline",
    text: "Hi, I need help with my homework, can you please take a look at this file and tell me what to fix?",
  });
  env.run("tick");
  assert.match(ok(admin(env, "request", { id: es.id })).request.draft, /Claro que sí/);
  assert.match(ok(admin(env, "request", { id: en.id })).request.draft, /^Sure, I had a look/);
  for (const id of [es.id, en.id]) {
    assert.match(ok(admin(env, "request", { id })).request.triage, /^They need help/, "the triage line is always English");
  }
});

scenario("a follow-up after a draft makes it stale and the request needs the owner again", (env) => {
  const r = createRequest(env, { text: "Primera duda" });
  env.run("tick");
  const first = ok(admin(env, "request", { id: r.id })).request;
  assert.ok(first.draft);
  assert.equal(first.status, "working");

  env.clock.advance(60000);
  const after = ok(family(env, "send", { who: WHO_A, id: r.id, text: "Se me olvidó: es una HP LaserJet." })).request;
  assert.equal(after.status, "working", "the owner is already on it, so the family sees no flicker");
  assert.equal(after.lastFrom, "family");

  const stale = ok(admin(env, "request", { id: r.id })).request;
  assert.equal(stale.draft, first.draft, "the old draft stays visible for the owner");
  assert.ok(stale.draftAt < stale.updatedAt, "draftAt is older than the last family message");
  assert.equal(stale.needsHuman, true);

  env.run("tick");
  assert.equal(claudeRequests(env).length, 2);
  const fresh = ok(admin(env, "request", { id: r.id })).request;
  assert.ok(fresh.draftAt > stale.draftAt);
  assert.match(textOf(lastClaude(env).body.messages[0].content), /HP LaserJet\.$/, "the follow-up is in the prompt");
  assert.equal(notifications(env).length, 2, "one email per family message");
  env.run("tick");
  assert.equal(claudeRequests(env).length, 2, "a current draft is not redone");
});

scenario("a family follow-up during the Claude call is never overwritten by the late draft", (env) => {
  const r = createRequest(env, { text: "Primera duda" });
  env.state.claude.onRequest = () => {
    env.state.claude.onRequest = null;
    const busy = ok(admin(env, "request", { id: r.id })).request;
    assert.equal(busy.draft, null, "nothing is stored before the call comes back");
    assert.ok(env.state.cache.has("draft:" + r.id), "the in-flight draft holds a lease");
    ok(family(env, "send", { who: WHO_A, id: r.id, text: "Perdón, otra cosa" }));
  };
  env.run("tick");

  const after = ok(admin(env, "request", { id: r.id }));
  assert.equal(claudeRequests(env).length, 1);
  assert.equal(after.request.draft, null, "the stale draft is discarded, not written over the new message");
  assert.equal(after.request.draftAt, null);
  assert.equal(after.request.triage, null);
  assert.equal(after.request.status, "new", "a discarded draft changes nothing");
  assert.equal(after.request.errorCount, 0);
  assert.equal(after.messages.length, 2);
  assert.equal(after.messages[1].text, "Perdón, otra cosa");
  assert.equal(notifications(env).length, 0, "no email for a draft that was thrown away");

  env.run("tick");
  assert.equal(claudeRequests(env).length, 2);
  const fresh = ok(admin(env, "request", { id: r.id })).request;
  assert.ok(fresh.draft);
  assert.equal(fresh.status, "working");
  assert.match(textOf(lastClaude(env).body.messages[0].content), /Perdón, otra cosa$/);
  assert.equal(notifications(env).length, 1);
});

scenario("an owner reply during the Claude call wins over the late draft", (env) => {
  const r = createRequest(env, { text: "Pregunta" });
  env.state.claude.onRequest = () => {
    env.state.claude.onRequest = null;
    ok(admin(env, "reply", { id: r.id, text: "Yo te respondo" }));
  };
  env.run("tick");
  const after = ok(admin(env, "request", { id: r.id }));
  assert.equal(after.request.status, "answered");
  assert.equal(after.request.lastFrom, "alon");
  assert.deepEqual(after.messages.map((m) => m.from), ["family", "alon"]);
  assert.equal(after.request.draft, null, "the reply cleared the draft and the late one did not resurrect it");
  env.run("tick");
  assert.equal(claudeRequests(env).length, 1, "an answered request is not drafted again");
});

scenario("a request closed during the Claude call does not get the late draft", (env) => {
  const r = createRequest(env, { text: "Pregunta" });
  env.state.claude.onRequest = () => {
    env.state.claude.onRequest = null;
    ok(family(env, "close", { who: WHO_A, id: r.id }));
  };
  env.run("tick");
  const after = ok(admin(env, "request", { id: r.id })).request;
  assert.equal(after.status, "closed");
  assert.equal(after.draft, null);
  assert.equal(after.triage, null);
  assert.equal(after.needsHuman, false);
  assert.equal(notifications(env).length, 0, "no owner email about a request the family just closed");
});

scenario("tick drafts the oldest waiting requests first, at most 5 per run", (env) => {
  const ids = [];
  for (let i = 0; i < 7; i++) {
    ids.push(createRequest(env, { title: "Pedido " + i, text: "Necesito ayuda número " + i }).id);
    env.clock.advance(1000);
  }
  env.run("tick");
  assert.equal(claudeRequests(env).length, 5);
  const drafted = ok(admin(env, "list")).requests.filter((r) => r.draft).map((r) => r.id);
  assert.deepEqual(drafted.slice().sort(), ids.slice(0, 5).sort());
  assert.equal(notifications(env).length, 5);
  env.run("tick");
  assert.equal(claudeRequests(env).length, 7);
  assert.equal(ok(admin(env, "list")).requests.filter((r) => r.draft).length, 7);
  assert.equal(ok(admin(env, "stats")).stats.draftsToday, 7);
});

scenario("closed requests and requests waiting on the family are never drafted", (env) => {
  const closed = createRequest(env, { title: "Cerrado" });
  ok(family(env, "close", { who: WHO_A, id: closed.id }));
  const answered = createRequest(env, { title: "Respondido" });
  ok(admin(env, "reply", { id: answered.id, text: "Listo" }));
  env.run("tick");
  assert.equal(claudeRequests(env).length, 0);
  assert.equal(ok(admin(env, "request", { id: closed.id })).request.needsHuman, false);
  assert.equal(ok(admin(env, "request", { id: answered.id })).request.needsHuman, false);
});

scenario("autoDraft off leaves the drafting to the owner and notifies right away", (env) => {
  const r = createRequest(env);
  env.run("tick");
  assert.equal(claudeRequests(env).length, 0);
  const sent = notifications(env);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /\(needs you\)$/);
  assert.ok(sent[0].body.includes("No draft is coming"));
  assert.equal(ok(admin(env, "request", { id: r.id })).request.needsHuman, true);
  // The owner can still ask for one by hand.
  assert.ok(ok(admin(env, "draft", { id: r.id })).request.draft);
}, { settings: { autoDraft: false } });

scenario("without an API key nothing is called and the owner hears about it right away", (env) => {
  const r = createRequest(env);
  env.run("tick");
  assert.equal(claudeRequests(env).length, 0);
  assert.equal(notifications(env).length, 1);
  assert.ok(notifications(env)[0].body.includes("No draft is coming"));
  assert.equal(ok(admin(env, "stats")).stats.apiKeyConfigured, false);
  assert.equal(failCode(admin(env, "draft", { id: r.id })), "not_configured");
}, { apiKey: null });

scenario("notifyOn none silences the arrival and draft emails but not a repeated failure", (env) => {
  const r = createRequest(env);
  env.run("tick");
  assert.ok(ok(admin(env, "request", { id: r.id })).request.draft);
  assert.equal(notifications(env).length, 0, "notifyOn none: no draft email");

  env.clock.advance(1000);
  env.setClaudeMode("fail");
  ok(family(env, "send", { who: WHO_A, id: r.id, text: "Sigue igual" }));
  env.run("tick");
  env.run("tick");
  env.run("tick");
  const detail = ok(admin(env, "request", { id: r.id })).request;
  assert.equal(detail.errorCount, 3);
  const sent = notifications(env);
  assert.equal(sent.length, 1, "errors reach the owner even with notifyOn none");
  assert.match(sent[0].subject, /\(draft failed\)$/);
}, { settings: { notifyOn: "none" } });

// ---------------------------------------------------------------------------------------------
// Cap and failures
// ---------------------------------------------------------------------------------------------

scenario("the daily cap stops drafts and sends a single cap email per day", (env) => {
  assert.equal(ok(admin(env, "settings", { set: { dailyCap: 2 } })).settings.dailyCap, 2);
  const a = createRequest(env, { title: "A" });
  env.clock.advance(1000);
  const b = createRequest(env, { title: "B" });
  env.clock.advance(1000);
  const c = createRequest(env, { title: "C" });

  env.run("tick");
  assert.equal(claudeRequests(env).length, 2);
  assert.ok(ok(admin(env, "request", { id: a.id })).request.draft);
  assert.ok(ok(admin(env, "request", { id: b.id })).request.draft);
  assert.equal(ok(admin(env, "request", { id: c.id })).request.draft, null);
  assert.equal(ok(admin(env, "request", { id: c.id })).request.status, "new");

  const capMails = () => notifications(env).filter((m) => /Daily limit reached/.test(m.subject));
  assert.equal(capMails().length, 1);
  assert.match(capMails()[0].subject, /\(2 Claude calls\)/);
  env.run("tick");
  env.run("tick");
  assert.equal(capMails().length, 1, "at most one cap email per day");
  assert.equal(claudeRequests(env).length, 2);
  assert.equal(failCode(admin(env, "draft", { id: c.id })), "rate_limited", "the owner's own button is capped too");

  const list = ok(admin(env, "list", { filter: "needs" }));
  assert.equal(list.requests.length, 3);
  assert.equal(list.stats.draftsToday, 2);
  assert.equal(list.stats.dailyCap, 2);

  // The counter resets on the next calendar day in the script time zone.
  env.clock.advance(24 * HOUR);
  env.run("tick");
  assert.ok(ok(admin(env, "request", { id: c.id })).request.draft);
  assert.equal(ok(admin(env, "stats")).stats.draftsToday, 1);
  assert.equal(JSON.parse(env.state.properties.AUTO_CALLS).date, "2026-09-17");
});

scenario("dailyCap 0 turns Claude off without a cap email", (env) => {
  const r = createRequest(env);
  env.run("tick");
  assert.equal(claudeRequests(env).length, 0);
  assert.equal(notifications(env).filter((m) => /Daily limit/.test(m.subject)).length, 0);
  assert.equal(notifications(env).length, 1, "the arrival email goes out instead");
  assert.ok(notifications(env)[0].body.includes("No draft is coming"));
  assert.equal(ok(admin(env, "request", { id: r.id })).request.needsHuman, true);
}, { settings: { dailyCap: 0 } });

scenario("Claude failures raise errorCount without bumping updatedAt; three stop the retries", (env) => {
  env.setClaudeMode("fail");
  const r = createRequest(env, { title: "Falla" });
  const before = ok(admin(env, "request", { id: r.id })).request;

  env.run("tick");
  assert.equal(claudeRequests(env).length, 2, "one retry on HTTP 500");
  assert.ok(env.state.counters.sleepMs >= 3000);
  let detail = ok(admin(env, "request", { id: r.id })).request;
  assert.equal(detail.errorCount, 1);
  assert.match(detail.lastError, /500/);
  assert.equal(detail.updatedAt, before.updatedAt, "a failed draft does not bump updatedAt");
  assert.equal(detail.status, "new");
  assert.equal(detail.draft, null);
  assert.equal(detail.needsHuman, true);
  assert.match(ok(admin(env, "stats")).stats.lastError, /#1/);
  assert.equal(notifications(env).length, 0, "silent while it is still retrying");

  env.run("tick");
  assert.equal(ok(admin(env, "request", { id: r.id })).request.errorCount, 2);
  assert.equal(notifications(env).length, 0);

  env.run("tick");
  detail = ok(admin(env, "request", { id: r.id })).request;
  assert.equal(detail.errorCount, 3);
  assert.equal(detail.needsHuman, true, "the owner still has to answer it");
  assert.equal(detail.updatedAt, before.updatedAt);
  const sent = notifications(env);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /^\[Ask\] #1 · Tía Rosa · Falla \(draft failed\)$/);
  assert.ok(sent[0].body.includes("will not retry"));
  assert.ok(sent[0].body.includes("la impresora dejó de imprimir"));

  env.setClaudeMode("ok");
  env.run("tick");
  assert.equal(claudeRequests(env).length, 6, "no more automatic attempts after 3 errors");
  assert.equal(notifications(env).length, 1);
  assert.equal(ok(admin(env, "stats")).stats.draftsToday, 3);
  // The owner can still force one by hand, and a manual failure does not raise errorCount.
  assert.ok(ok(admin(env, "draft", { id: r.id })).request.draft);
  assert.equal(ok(admin(env, "request", { id: r.id })).request.errorCount, 0, "a good draft clears the errors");
});

scenario("a refusal is stored as an error and no draft is saved", (env) => {
  env.setClaudeMode("refusal");
  const r = createRequest(env);
  env.run("tick");
  assert.equal(claudeRequests(env).length, 1, "refusals are not retried");
  let detail = ok(admin(env, "request", { id: r.id })).request;
  assert.equal(detail.lastError, "refusal");
  assert.equal(detail.errorCount, 1);
  assert.equal(detail.draft, null);
  assert.equal(detail.status, "new");
  assert.equal(ok(family(env, "request", { who: WHO_A, id: r.id })).messages.length, 1);

  env.setClaudeMode("ok");
  env.run("tick");
  detail = ok(admin(env, "request", { id: r.id })).request;
  assert.ok(detail.draft);
  assert.equal(detail.errorCount, 0);
  assert.equal(detail.lastError, null);
  assert.equal(detail.status, "working");
});

// ---------------------------------------------------------------------------------------------
// The owner answers (SPEC §5)
// ---------------------------------------------------------------------------------------------

scenario("admin.reply appends as the owner, clears the draft and emails the requester when asked", (env) => {
  const r = createRequest(env, { contactEmail: "Rosa@Example.com" });
  env.run("tick");
  const drafted = ok(admin(env, "request", { id: r.id })).request;
  assert.ok(drafted.draft && drafted.triage && drafted.draftAt);
  env.clock.advance(1000);

  const text = "Listo, **ya quedó**. Revisa `config.pdf`.\n\n1. Uno\n2. Dos";
  const res = ok(admin(env, "reply", { id: r.id, text, email: true }));
  assert.equal(res.emailed, true);
  assert.equal(res.request.status, "answered");
  assert.equal(res.request.lastFrom, "alon");
  assert.equal(res.request.unread, true);
  assert.equal(res.request.draft, null, "the draft was about the message just answered");
  assert.equal(res.request.draftAt, null);
  assert.equal(res.request.triage, null);
  assert.equal(res.request.needsHuman, false);
  assert.equal(res.request.messageCount, 2);

  const msgs = ok(admin(env, "request", { id: r.id })).messages;
  assert.equal(msgs[1].from, "alon");
  assert.equal(msgs[1].via, "admin");
  assert.equal(msgs[1].text, text);
  assert.equal(ok(family(env, "request", { who: WHO_A, id: r.id })).messages[1].from, "alon");

  const mail = replies(env);
  assert.equal(mail.length, 1);
  assert.equal(mail[0].to, "rosa@example.com");
  assert.equal(mail[0].name, "Alonso Bryan");
  assert.equal(mail[0].subject, "Re: La impresora no imprime");
  assert.ok(mail[0].body.startsWith(text), mail[0].body);
  const link = SITE + "#f=" + env.family;
  assert.ok(mail[0].body.includes(link), "the plain body links back to the site");
  assert.ok(mail[0].htmlBody.includes('<a href="' + link + '">'));
  assert.ok(mail[0].htmlBody.includes("<strong>ya quedó</strong>"));
  assert.ok(mail[0].htmlBody.includes("<ol><li>Uno</li><li>Dos</li></ol>"));
  assert.ok(mail[0].htmlBody.includes(">config.pdf</code>"));

  // via, and the validation of the reply itself.
  assert.equal(ok(admin(env, "reply", { id: r.id, text: "Desde el puente", via: "bridge", email: false })).request.lastFrom, "alon");
  assert.equal(ok(admin(env, "request", { id: r.id })).messages[2].via, "bridge");
  assert.equal(replies(env).length, 1, "email:false does not send");
  assert.equal(failCode(admin(env, "reply", { id: r.id, text: "x", via: "site" })), "bad_request");
  assert.equal(failCode(admin(env, "reply", { id: r.id, text: "" })), "bad_request");
  assert.equal(failCode(admin(env, "reply", { id: r.id, text: "x".repeat(8001) })), "bad_request");
  assert.equal(failCode(admin(env, "reply", { id: r.id })), "bad_request");
  assert.equal(failCode(admin(env, "reply", { id: "r_missing", text: "x" })), "not_found");
});

scenario("a reply is not emailed when the requester left no address", (env) => {
  const r = createRequest(env, { title: "Sin correo" });
  const res = ok(admin(env, "reply", { id: r.id, text: "Listo", email: true }));
  assert.equal(res.emailed, false);
  assert.deepEqual(replies(env), []);
  assert.equal(res.request.status, "answered");
});

scenario("the emailed answer escapes HTML in the owner's own text", (env) => {
  const r = createRequest(env, { contactEmail: "rosa@example.com" });
  const nasty = "<script>alert(1)</script>\n\n**ojo** con `x<y`\n\n<img src=x onerror=alert(1)>";
  assert.equal(ok(admin(env, "reply", { id: r.id, text: nasty, email: true })).emailed, true);
  const html = replies(env)[0].htmlBody;
  assert.ok(!html.includes("<script>"), "no raw script tag reaches the email");
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("<strong>ojo</strong>"));
  assert.match(html, /<code[^>]*>x&lt;y<\/code>/);
});

scenario("markdown to HTML escapes before formatting", (env) => {
  const html = env.context.markdownToHtml_(
    "<script>alert(1)</script>\n\n**negrita** y `x<y`\n\n```\nprint('<b>')\n```\n\n- uno\n- dos\n\n1. a\n2. b\n\n# Título\n\n<img src=x onerror=alert(1)>"
  );
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("<strong>negrita</strong>"));
  assert.match(html, /<code[^>]*>x&lt;y<\/code>/);
  assert.match(html, /<pre[^>]*><code>print\(&#39;&lt;b&gt;&#39;\)<\/code><\/pre>/);
  assert.ok(html.includes("<ul><li>uno</li><li>dos</li></ul>"));
  assert.ok(html.includes("<ol><li>a</li><li>b</li></ol>"));
  assert.ok(html.includes("<p><strong>Título</strong></p>"));
});

scenario("admin.draft writes a draft on demand and reports why it cannot", (env) => {
  const r = createRequest(env);
  const res = ok(admin(env, "draft", { id: r.id }));
  assert.match(res.request.draft, /Claro que sí/);
  assert.match(res.request.triage, /^They need help/);
  assert.equal(res.request.status, "working");
  assert.equal(ok(admin(env, "stats")).stats.draftsToday, 1, "a manual draft counts against the daily cap");
  assert.equal(notifications(env).length, 0, "the owner is already looking at the console");

  // It also works once the owner has answered (the request must still end with a family turn).
  ok(admin(env, "reply", { id: r.id, text: "Ya te ayudo" }));
  const again = ok(admin(env, "draft", { id: r.id }));
  assert.ok(again.request.draft);
  assert.deepEqual(lastClaude(env).body.messages.map((m) => m.role), ["user"]);

  env.setClaudeMode("fail");
  assert.equal(failCode(admin(env, "draft", { id: r.id })), "server_error");
  assert.equal(ok(admin(env, "request", { id: r.id })).request.errorCount, 0, "a button press is not a retry loop");
  assert.equal(failCode(admin(env, "draft", { id: "r_missing" })), "not_found");
  assert.equal(failCode(admin(env, "draft", {})), "bad_request");
});

// ---------------------------------------------------------------------------------------------
// Close and reopen
// ---------------------------------------------------------------------------------------------

scenario("close by the family and by the owner; a follow-up reopens the right way", (env) => {
  const r = createRequest(env);
  const closed = ok(family(env, "close", { who: WHO_A, id: r.id })).request;
  assert.equal(closed.status, "closed");
  assert.equal(ok(family(env, "list", { who: WHO_A })).requests[0].status, "closed");
  env.run("tick");
  assert.equal(claudeRequests(env).length, 0, "closed requests are never drafted");

  env.clock.advance(1000);
  const reopened = ok(family(env, "send", { who: WHO_A, id: r.id, text: "Perdón, sigue igual" })).request;
  assert.equal(reopened.status, "new", "a closed request reopens as new");
  assert.equal(reopened.lastFrom, "family");

  ok(admin(env, "reply", { id: r.id, text: "Ya lo vemos" }));
  assert.equal(ok(admin(env, "request", { id: r.id })).request.status, "answered");
  env.clock.advance(1000);
  assert.equal(ok(family(env, "send", { who: WHO_A, id: r.id, text: "Gracias" })).request.status, "new", "answered reopens as new");

  env.run("tick");
  assert.equal(ok(admin(env, "request", { id: r.id })).request.status, "working");
  env.clock.advance(1000);
  assert.equal(ok(family(env, "send", { who: WHO_A, id: r.id, text: "Otra cosa" })).request.status, "working", "working stays working");

  const byOwner = ok(admin(env, "close", { id: r.id })).request;
  assert.equal(byOwner.status, "closed");
  assert.equal(byOwner.needsHuman, false);
  assert.equal(failCode(admin(env, "close", { id: "r_missing" })), "not_found");
  assert.equal(failCode(family(env, "close", { who: WHO_A, id: "r_missing" })), "not_found");
});

// ---------------------------------------------------------------------------------------------
// Admin: events, delete, settings, setup
// ---------------------------------------------------------------------------------------------

scenario("admin.events returns requests updated after since, oldest first", (env) => {
  const r1 = createRequest(env, { title: "Uno" });
  env.clock.advance(1000);
  const since = env.clock.iso();
  env.clock.advance(1000);
  const r2 = createRequest(env, { title: "Dos" });
  env.clock.advance(1000);

  let events = ok(admin(env, "events", { since }));
  assert.deepEqual(events.requests.map((r) => r.id), [r2.id]);
  assert.deepEqual(Object.keys(events.requests[0]).sort(), ADMIN_KEYS);
  assert.match(events.now, /Z$/);
  assert.equal(ok(admin(env, "events", { since: events.now })).requests.length, 0);

  env.clock.advance(1000);
  ok(admin(env, "reply", { id: r1.id, text: "Respuesta" }));
  events = ok(admin(env, "events", { since }));
  assert.deepEqual(events.requests.map((r) => r.id), [r2.id, r1.id], "oldest first");
  assert.equal(ok(admin(env, "events", { since: "2000-01-01T00:00:00Z" })).requests.length, 2);
  assert.equal(failCode(admin(env, "events", { since: "ayer" })), "bad_request");
  assert.equal(failCode(admin(env, "events", {})), "bad_request");
  assert.equal(failCode(admin(env, "events", { since: 12345 })), "bad_request");
});

scenario("admin.delete removes the request and its messages only", (env) => {
  const keep = createRequest(env, { title: "Se queda" });
  const gone = createRequest(env, { who: WHO_B, name: NAME_B, title: "Se va" });
  ok(family(env, "send", { who: WHO_B, id: gone.id, text: "segundo" }));
  ok(family(env, "send", { who: WHO_A, id: keep.id, text: "segundo" }));
  ok(family(env, "send", { who: WHO_B, id: gone.id, text: "tercero" }));
  assert.equal(env.sheetRecords("Messages").length, 5);

  assert.deepEqual(ok(admin(env, "delete", { id: gone.id })), { deleted: true });
  const remaining = env.sheetRecords("Messages");
  assert.equal(remaining.length, 2);
  assert.ok(remaining.every((m) => m.requestId === keep.id));
  assert.deepEqual(ok(admin(env, "list")).requests.map((r) => r.id), [keep.id]);
  assert.deepEqual(ok(family(env, "list", { who: WHO_B })).requests, []);
  assert.equal(failCode(family(env, "request", { who: WHO_B, id: gone.id })), "not_found");
  assert.equal(failCode(admin(env, "delete", { id: gone.id })), "not_found");
  assert.equal(failCode(admin(env, "delete", {})), "bad_request");
  assert.equal(ok(family(env, "request", { who: WHO_A, id: keep.id })).messages.length, 2);
});

scenario("admin.settings merges and validates every field", (env) => {
  const current = ok(admin(env, "settings")).settings;
  assert.deepEqual(Object.keys(current).sort(), SETTINGS_KEYS);
  assert.equal(current.ownerName, "Alonso Bryan");
  assert.equal(current.dailyCap, 40);
  assert.equal(current.autoDraft, true);
  assert.equal(current.defaultLang, "es");

  const bad = (set) => assert.equal(failCode(admin(env, "settings", { set })), "bad_request", JSON.stringify(set));
  bad({ dailyCap: -1 });
  bad({ dailyCap: 1.5 });
  bad({ dailyCap: "abc" });
  bad({ dailyCap: 1001 });
  bad({ dailyCap: null });
  bad({ notifyOn: "sometimes" });
  bad({ notifyOn: true });
  bad({ notifyEmail: "owner@" });
  bad({ notifyEmail: "a b@c.d" });
  bad({ notifyEmail: 5 });
  bad({ defaultLang: "fr" });
  bad({ defaultLang: "ES" });
  bad({ ownerName: "" });
  bad({ ownerName: "x".repeat(41) });
  bad({ ownerName: 5 });
  bad({ autoDraft: "yes" });
  bad({ emailReplies: 1 });
  bad({ siteUrl: "javascript:alert(1)" });
  bad({ siteUrl: "example.com" });
  bad({ ownerName: "Ana", dailyCap: -5 });
  assert.equal(failCode(admin(env, "settings", { set: "ownerName=Ana" })), "bad_request");
  assert.equal(failCode(admin(env, "settings", { set: ["ownerName"] })), "bad_request");
  assert.equal(ok(admin(env, "settings")).settings.ownerName, "Alonso Bryan", "a rejected patch changes nothing");
  assert.equal(ok(admin(env, "settings")).settings.dailyCap, 40);

  const updated = ok(admin(env, "settings", {
    set: {
      ownerName: "  Alonso   B.  ", siteUrl: "https://x.github.io/ask/#f=abc", dailyCap: "12",
      notifyEmail: "  Owner@Example.COM ", notifyOn: "none", defaultLang: "en", emailReplies: false,
      autoDraft: false, unknownKey: 1,
    },
  })).settings;
  assert.equal(updated.ownerName, "Alonso B.");
  assert.equal(updated.siteUrl, "https://x.github.io/ask/");
  assert.equal(updated.dailyCap, 12);
  assert.equal(updated.notifyEmail, "owner@example.com");
  assert.equal(updated.notifyOn, "none");
  assert.equal(updated.defaultLang, "en");
  assert.equal(updated.emailReplies, false);
  assert.equal(updated.autoDraft, false);
  assert.equal("unknownKey" in updated, false);
  assert.equal(ok(admin(env, "settings", { set: null })).settings.ownerName, "Alonso B.", "reading does not change anything");
  assert.equal(ok(admin(env, "settings", { set: { siteUrl: "" } })).settings.siteUrl, "", "the site URL may be cleared");
  assert.equal(ok(admin(env, "settings", { set: { notifyEmail: "" } })).settings.notifyEmail, "");

  // The new owner name reaches Claude and the family site.
  ok(admin(env, "settings", { set: { autoDraft: true } }));
  const r = createRequest(env);
  env.run("tick");
  assert.match(lastClaude(env).body.system, /^You help Alonso B\. answer/);
  assert.equal(ok(family(env, "info")).ownerName, "Alonso B.");
  assert.ok(ok(admin(env, "request", { id: r.id })).request.draft);
});

scenario("setup is idempotent: headers, tokens, exactly one tick trigger", (env) => {
  const props = { ...env.state.properties };
  assert.match(props.FAMILY_TOKEN, /^[0-9a-f]{64}$/);
  assert.match(props.ADMIN_TOKEN, /^[0-9a-f]{64}$/);
  assert.notEqual(props.FAMILY_TOKEN, props.ADMIN_TOKEN);
  assert.deepEqual(env.sheetValues("Requests")[0], REQUEST_HEADERS);
  assert.deepEqual(env.sheetValues("Messages")[0], MESSAGE_HEADERS);
  assert.equal(env.state.triggers.length, 1);

  const r = createRequest(env);
  env.clock.advance(HOUR);
  env.run("setup");
  env.run("setup");
  assert.equal(env.state.triggers.length, 1);
  assert.equal(env.state.triggers[0].getHandlerFunction(), "tick");
  assert.equal(env.state.triggers[0].everyMinutes, 1);
  for (const key of ["FAMILY_TOKEN", "ADMIN_TOKEN"]) assert.equal(env.state.properties[key], props[key], key);
  assert.equal(env.state.properties.COUNTER, "1");
  assert.equal(env.sheetValues("Requests").length, 2, "data kept");
  assert.equal(ok(family(env, "request", { who: WHO_A, id: r.id })).messages.length, 1);
  assert.equal(createRequest(env, { title: "Después" }).number, 2);

  // Duplicate triggers are removed.
  env.services.ScriptApp.newTrigger("tick").timeBased().everyMinutes(1).create();
  env.services.ScriptApp.newTrigger("tick").timeBased().everyMinutes(5).create();
  env.run("setup");
  assert.equal(env.state.triggers.filter((t) => t.getHandlerFunction() === "tick").length, 1);

  assert.ok(env.logs().includes(SITE + "#f=" + props.FAMILY_TOKEN), "the family link is logged for the owner");
  assert.ok(env.logs().includes(props.ADMIN_TOKEN));
  assert.doesNotMatch(env.logs(), /sk-test-key/, "never logs the API key");
});

scenario("columns the owner adds by hand survive writes", (env) => {
  const sheet = env.services.SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Requests");
  const r = createRequest(env);
  const lock = env.services.LockService.getScriptLock();
  lock.waitLock(1000);
  sheet.getRange(1, REQUEST_HEADERS.length + 1, 1, 1).setValues([["nota"]]);
  sheet.getRange(2, REQUEST_HEADERS.length + 1, 1, 1).setValues([["'00042"]]);
  lock.releaseLock();
  ok(family(env, "send", { who: WHO_A, id: r.id, text: "más" }));
  env.run("tick");
  ok(admin(env, "reply", { id: r.id, text: "listo" }));
  const row = env.sheetRecords("Requests")[0];
  assert.equal(row.nota, "00042");
  assert.equal(row.status, "answered");
});
