// Owner console (admin.html). English UI. Every answer is sent as the owner, and
// nothing Claude writes reaches the family until the owner presses Send.
import { CONFIG, isConfigured } from "./config.js";
import { call, ApiError } from "./api.js";
import {
  el, renderMarkdown, timeAgo, fullDate, store, takeHashParam, setTitleBadge,
  chime, askNotificationPermission, notify, announce, toast, poll, copyText,
} from "./ui.js";

// ---------- constants ----------

const KEYS = {
  token: "ask.admin.token",
  filter: "ask.admin.filter",
  person: "ask.admin.person",
  notify: "ask.admin.notify",
  compose: "ask.admin.compose", // unsent answer text per request id
};

const TICK_STALE_MS = 3 * 60 * 1000;

const STATUS_LABELS = { new: "Received", working: "In progress", answered: "Answered", closed: "Closed" };
const URGENCY_LABELS = { normal: "Normal", soon: "This week", urgent: "Urgent" };
const CATEGORY_LABELS = {
  tech: "Tech", docs: "Forms & docs", school: "School", data: "Data", money: "Money", other: "Other",
};

// Person is handled separately: it also needs the chosen name.
const FILTERS = {
  needs: (r) => Boolean(r.needsHuman),
  all: () => true,
  urgent: (r) => r.urgency === "urgent" && r.status !== "closed",
  person: (r) => normalizeName(r.requesterName) === state.person,
};
const EMPTY_TEXT = {
  needs: "Nothing needs you right now.",
  all: "No requests yet. Anything the family sends shows up here.",
  urgent: "Nothing urgent is open.",
  person: "No requests from this person.",
};

const $ = (id) => document.getElementById(id);
const isUnauthorized = (err) => err instanceof ApiError && err.code === "unauthorized";
const isNarrow = () => matchMedia("(max-width: 879px)").matches;
const normalizeName = (name) => String(name ?? "").trim();
const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());

// ---------- state ----------

const state = {
  token: null,
  poller: null,
  timers: [],
  loaded: false,
  requests: [],
  settings: {},
  stats: null,
  lastSyncAt: 0,
  offline: false,
  filter: "needs",
  person: "", // requesterName selected in the "By person" filter
  listKey: "",
  selectedId: null,
  detail: null, // { request, messages }
  historyKey: "",
  seenNeeds: new Map(), // id -> updatedAt for requests that need the owner
  baselined: false,
  drafting: new Set(), // request ids with a Claude draft in flight
  sending: false,
  settingsBase: null,
  seq: { refresh: 0, detail: 0, history: 0, preview: 0 },
};

const ownerName = () => normalizeName(state.settings.ownerName) || "Alonso Bryan";

// ---------- boot / screens / auth ----------

function boot() {
  wireEvents();
  // Take the token out of the visible URL first, even if the backend is not configured yet.
  const fromHash = takeHashParam("admin");
  if (fromHash) store.set(KEYS.token, fromHash.trim());
  if (!isConfigured()) {
    showScreen("not-configured");
    return;
  }
  const token = store.get(KEYS.token);
  if (typeof token === "string" && token) startConsole(token);
  else showSignIn();
}

function showScreen(name) {
  for (const screen of ["boot", "not-configured", "signin", "console"]) {
    $(`screen-${screen}`).hidden = screen !== name;
  }
}

function showSignIn(message = "", tone = "info") {
  showScreen("signin");
  setSignInMessage(message, tone);
  $("signin-token").value = "";
  $("signin-token").focus();
}

function setSignInMessage(message, tone = "info") {
  const box = $("signin-msg");
  box.textContent = message;
  box.hidden = !message;
  box.className = `notice ${tone === "error" ? "notice-warn" : "notice-info"}`;
}

async function onSignIn(event) {
  event.preventDefault();
  const input = $("signin-token");
  const token = input.value.trim();
  if (!token) {
    setSignInMessage("Paste your admin token first.", "error");
    input.focus();
    return;
  }
  const button = $("signin-submit");
  setBusy(button, true, "Checking…");
  try {
    const result = await call("admin.list", { admin: token, filter: "all" }, { timeoutMs: 25000 });
    store.set(KEYS.token, token);
    startConsole(token, result);
  } catch (err) {
    setSignInMessage(
      isUnauthorized(err) ? "That token was not accepted. Check it and try again." : `Could not check the token: ${err.message}`,
      "error",
    );
    input.focus();
    input.select();
  } finally {
    setBusy(button, false);
  }
}

function startConsole(token, initialResult) {
  stopConsole();
  state.token = token;
  const savedFilter = store.get(KEYS.filter);
  state.filter = FILTERS[savedFilter] ? savedFilter : "needs";
  state.person = normalizeName(store.get(KEYS.person, ""));
  showScreen("console");
  updateShortcutHint();
  renderNotifyButton();
  renderFilters();
  renderList(true);
  if (initialResult) applyList(initialResult);
  state.poller = poll(refreshAll, CONFIG.pollSeconds);
  state.timers.push(setInterval(updateClock, 1000));
  state.timers.push(setInterval(() => updateRelativeTimes($("screen-console")), 15000));
}

// Clears everything tied to the signed-in session.
function stopConsole() {
  state.poller?.stop();
  state.poller = null;
  state.timers.forEach(clearInterval);
  state.timers = [];
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  Object.assign(state, {
    token: null, loaded: false, requests: [], settings: {}, stats: null, lastSyncAt: 0, offline: false,
    listKey: "", selectedId: null, detail: null, historyKey: "", seenNeeds: new Map(), baselined: false,
    sending: false, settingsBase: null,
  });
  state.drafting.clear();
  for (const key of Object.keys(state.seq)) state.seq[key]++; // invalidate in-flight responses
  setTitleBadge(0);
}

function signOut() {
  stopConsole();
  store.remove(KEYS.token);
  store.remove(KEYS.compose);
  showSignIn("Signed out. The token was removed from this browser.");
}

function handleUnauthorized() {
  stopConsole();
  store.remove(KEYS.token);
  showSignIn("Your admin token was not accepted (it may have changed). Please sign in again.", "error");
}

// Every admin call goes through here so an expired token always returns to sign-in.
async function adminCall(action, params = {}, opts) {
  const token = state.token;
  if (!token) throw new ApiError("unauthorized", "Signed out.");
  try {
    return await call(action, { ...params, admin: token }, opts);
  } catch (err) {
    if (isUnauthorized(err) && state.token === token) handleUnauthorized();
    throw err;
  }
}

// ---------- data refresh ----------

async function refreshAll() {
  if (!state.token) return;
  const seq = ++state.seq.refresh;
  let result;
  try {
    result = await adminCall("admin.list", { filter: "all" }, { timeoutMs: 25000 });
  } catch (err) {
    if (seq === state.seq.refresh && !isUnauthorized(err)) setOffline(err);
    return;
  }
  if (seq !== state.seq.refresh || !state.token) return; // a newer refresh already started
  setOffline(null);
  applyList(result);
}

function applyList(result) {
  state.requests = Array.isArray(result?.requests) ? result.requests : [];
  state.settings = result?.settings || {};
  state.stats = result?.stats || null;
  state.lastSyncAt = Date.now();
  state.loaded = true;
  detectNeeds();
  renderHeader();
  renderStrip();
  renderFilters();
  renderList();
  renderDetailEmpty();
  syncSelectedRequest();
}

function setOffline(err) {
  state.offline = Boolean(err);
  $("conn-banner").hidden = !err;
  if (err) {
    const what = ["network", "timeout"].includes(err.code) ? "Can't reach the backend" : "The backend returned an error";
    $("conn-text").textContent = `${what}: ${err.message} Retrying every ${CONFIG.pollSeconds}s.`;
  }
  updateClock();
}

// Replace one request in the list with a fresher copy (e.g. from an action result).
// `own` = the change came from this console, so it must not trigger a "needs you" alert.
function mergeRequest(request, { own = false } = {}) {
  if (!request?.id) return;
  const index = state.requests.findIndex((r) => r.id === request.id);
  if (index >= 0) state.requests[index] = request;
  else state.requests.push(request);
  if (own) {
    if (request.needsHuman) state.seenNeeds.set(request.id, request.updatedAt);
    else state.seenNeeds.delete(request.id);
  }
  if (state.detail?.request.id === request.id) state.detail.request = request;
  renderFilters();
  renderList();
  renderDetailEmpty();
  setTitleBadge(state.requests.filter((r) => r.needsHuman).length);
}

// Alert when a request newly needs the owner (unseen id, or updatedAt changed while it needs them).
function detectNeeds() {
  const needs = state.requests.filter((r) => r.needsHuman);
  const fresh = state.baselined ? needs.filter((r) => state.seenNeeds.get(r.id) !== r.updatedAt) : [];
  state.seenNeeds = new Map(needs.map((r) => [r.id, r.updatedAt]));
  state.baselined = true; // the first load only sets the baseline, no alert
  setTitleBadge(needs.length);
  if (!fresh.length) return;

  const one = fresh.length === 1 ? fresh[0] : null;
  const title = one
    ? `#${one.number} from ${normalizeName(one.requesterName) || "the family"} needs you`
    : `${fresh.length} requests need you`;
  const body = fresh.map((r) => `#${r.number} ${r.title}`).join(" · ");
  chime();
  announce(`${title}: ${body}`);
  if (store.get(KEYS.notify, false)) notify(title, body);
}

// ---------- header + status strip ----------

function renderHeader() {
  $("console-sub").textContent = `Owner console · ${ownerName()}`;
  const hasSiteUrl = Boolean(normalizeName(state.settings.siteUrl));
  $("link-warn").hidden = !state.loaded || hasSiteUrl;
  $("link-hint").textContent = state.loaded && !hasSiteUrl
    ? "Set the Site URL in Settings first: the link is built from it."
    : "One link for the whole family. Share it only with them.";
  $("link-hint").classList.toggle("warn", state.loaded && !hasSiteUrl);
}

function setPill(node, tone, text) {
  node.hidden = !tone;
  if (!tone) return;
  node.className = `pill pill-xs pill-${tone}`;
  node.textContent = text;
}

function renderStrip() {
  const s = state.stats;
  if (!s) return;

  const used = Number(s.draftsToday) || 0;
  const cap = Number(s.dailyCap ?? state.settings.dailyCap) || 0;
  $("drafts-today").textContent = String(used);
  $("drafts-cap").textContent = String(cap);
  const bar = $("drafts-bar");
  bar.style.width = `${cap > 0 ? Math.min(100, (used / cap) * 100) : 100}%`;
  bar.classList.toggle("is-full", used >= cap);
  bar.classList.toggle("is-high", used < cap && used >= cap * 0.8);
  if (cap === 0) setPill($("drafts-pill"), "muted", "Drafting off");
  else if (used >= cap) setPill($("drafts-pill"), "alert", "Cap reached");
  else setPill($("drafts-pill"), null);

  const keyOk = Boolean(s.apiKeyConfigured);
  $("key-text").textContent = keyOk ? "Configured" : "Not configured";
  setPill($("key-pill"), keyOk ? "good" : "alert", keyOk ? "OK" : "Missing");
  $("key-hint").hidden = keyOk;

  const needs = needsCount();
  $("needs-text").textContent = String(needs);
  setPill($("needs-pill"), needs > 0 ? "alert" : "good", needs > 0 ? "Answer them" : "All caught up");
  $("needs-hint").textContent = needs > 0
    ? `${needs === 1 ? "Someone is" : `${needs} people are`} waiting for your answer.`
    : "Nobody is waiting.";

  const lastError = formatError(s.lastError);
  $("stat-error").hidden = !lastError;
  $("error-text").textContent = lastError;

  updateClock();
}

// Prefer the backend's own count; fall back to the list we hold.
function needsCount() {
  const fromStats = Number(state.stats?.needsCount);
  if (Number.isFinite(fromStats) && state.stats && "needsCount" in state.stats) return fromStats;
  return state.requests.filter((r) => r.needsHuman).length;
}

// Runs every second: backend heartbeat and "updated Xs ago".
function updateClock() {
  const s = state.stats;
  if (s) {
    const at = Date.parse(s.lastTickAt || "");
    const age = Number.isFinite(at) ? Date.now() - at : null;
    const stale = age === null || age > TICK_STALE_MS;
    const text = $("tick-text");
    text.textContent = age === null ? "Never ran" : `Last ran ${agoShort(age)}`;
    text.title = age === null ? "" : fullDate(s.lastTickAt, "en");
    setPill($("tick-pill"), stale ? "alert" : "good", stale ? (age === null ? "Not running" : "Stalled") : "Running");
    $("tick-hint").hidden = !stale;
  }
  const sync = $("sync-status");
  if (state.offline) sync.textContent = "Offline, retrying";
  else sync.textContent = state.lastSyncAt ? `Updated ${agoShort(Date.now() - state.lastSyncAt)}` : "";
}

function agoShort(ms) {
  const sec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 172800) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// lastError is normally a string; accept {at, message} too.
function formatError(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  const when = value.at ? `${fullDate(value.at, "en")}\n` : "";
  return when + (value.message || JSON.stringify(value));
}

function updateRelativeTimes(root) {
  for (const node of root.querySelectorAll("[data-rel]")) {
    node.textContent = timeAgo(node.dataset.rel, "en");
  }
}

// ---------- inbox ----------

// needsHuman first, then most recently updated.
function compareRequests(a, b) {
  if (Boolean(a.needsHuman) !== Boolean(b.needsHuman)) return a.needsHuman ? -1 : 1;
  return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
}

// Every requesterName in the list, most-waited-on first, with counts.
function people() {
  const byName = new Map();
  for (const r of state.requests) {
    const name = normalizeName(r.requesterName) || "(no name)";
    const entry = byName.get(name) || { name, total: 0, needs: 0, updatedAt: 0 };
    entry.total += 1;
    if (r.needsHuman) entry.needs += 1;
    entry.updatedAt = Math.max(entry.updatedAt, Date.parse(r.updatedAt) || 0);
    byName.set(name, entry);
  }
  return [...byName.values()].sort((a, b) => b.needs - a.needs || b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

function renderFilters() {
  const list = people();
  for (const name of Object.keys(FILTERS)) {
    $(`filter-${name}`).setAttribute("aria-pressed", String(state.filter === name));
  }
  if (state.loaded) {
    $("count-needs").textContent = String(state.requests.filter(FILTERS.needs).length);
    $("count-all").textContent = String(state.requests.length);
    $("count-urgent").textContent = String(state.requests.filter(FILTERS.urgent).length);
    $("count-person").textContent = String(list.length);
  } else {
    for (const name of Object.keys(FILTERS)) $(`count-${name}`).textContent = "–";
  }
  $("filter-needs").classList.toggle("has-needs", state.requests.some((r) => r.needsHuman));
  $("filter-urgent").classList.toggle("has-urgent", state.requests.some(FILTERS.urgent));
  renderPersonSelect(list);
}

function renderPersonSelect(list = people()) {
  const wrap = $("person-wrap");
  const select = $("person-select");
  wrap.hidden = state.filter !== "person";
  if (state.filter !== "person") return;

  if (list.length && !list.some((p) => p.name === state.person)) {
    state.person = list[0].name;
    store.set(KEYS.person, state.person);
  }
  const key = JSON.stringify(list.map((p) => [p.name, p.total, p.needs]));
  if (select.dataset.key !== key) {
    select.dataset.key = key;
    select.replaceChildren(...(list.length
      ? list.map((p) => el("option", { value: p.name, text: `${p.name} · ${p.total}${p.needs ? ` · ${p.needs} waiting` : ""}` }))
      : [el("option", { value: "", text: "Nobody has written yet" })]));
  }
  select.value = state.person;
  select.disabled = list.length === 0;
}

function setFilter(name) {
  if (!FILTERS[name]) return;
  state.filter = name;
  store.set(KEYS.filter, name);
  renderFilters();
  renderList(true);
}

function renderList(force = false) {
  const list = $("request-list");
  $("list-loading").hidden = state.loaded;
  if (!state.loaded) {
    list.replaceChildren();
    $("list-empty").hidden = true;
    return;
  }

  const items = state.requests.filter(FILTERS[state.filter]).sort(compareRequests);
  const key = JSON.stringify([
    state.filter,
    state.person,
    items.map((r) => [
      r.id, r.number, r.title, r.requesterName, r.updatedAt, r.status, r.category, r.urgency,
      r.needsHuman, Boolean(r.draft), r.errorCount,
    ]),
  ]);
  if (force || key !== state.listKey) {
    state.listKey = key;
    const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    list.replaceChildren(...items.map(requestRow));
    markSelectedRow(focusedId);
  } else {
    updateRelativeTimes(list);
  }

  const empty = items.length === 0;
  $("list-empty").hidden = !empty;
  if (empty) {
    $("list-empty-text").textContent = state.filter === "person" && state.person
      ? `No requests from ${state.person}.`
      : EMPTY_TEXT[state.filter];
    $("btn-show-all").hidden = state.filter === "all" || state.requests.length === 0;
  }
}

function requestRow(r) {
  const errors = Number(r.errorCount) || 0;
  return el("li", {},
    el("button", {
      type: "button",
      class: "request-row",
      tabindex: "-1",
      dataset: { id: r.id },
      onclick: () => selectRequest(r.id, { focusDetail: isNarrow() }),
    },
      el("span", { class: "row-num num", text: `#${r.number}` }),
      el("span", { class: "row-title", text: r.title || "(no title)" }),
      el("time", { class: "row-time", datetime: r.updatedAt, title: fullDate(r.updatedAt, "en"), dataset: { rel: r.updatedAt }, text: timeAgo(r.updatedAt, "en") }),
      el("span", { class: "row-meta" },
        el("span", { class: "row-who", text: normalizeName(r.requesterName) || "(no name)" }),
        statusPill(r.status),
        r.needsHuman ? el("span", { class: "pill pill-alert pill-xs", text: "Needs you" }) : null,
        urgencyPill(r.urgency),
        categoryPill(r.category),
        r.draft ? el("span", { class: "tag tag-info", text: "Draft ready" }) : null,
        errors > 0 ? el("span", { class: "tag tag-warn", text: `${errors} draft error${errors === 1 ? "" : "s"}` }) : null,
      ),
    ),
  );
}

function statusPill(status) {
  const known = Object.prototype.hasOwnProperty.call(STATUS_LABELS, status);
  return el("span", { class: `pill pill-xs pill-status-${known ? status : "closed"}`, text: known ? STATUS_LABELS[status] : String(status ?? "—") });
}

function urgencyPill(urgency) {
  const known = Object.prototype.hasOwnProperty.call(URGENCY_LABELS, urgency);
  return el("span", { class: `pill pill-xs pill-urgency-${known ? urgency : "normal"}`, text: known ? URGENCY_LABELS[urgency] : String(urgency ?? "—") });
}

function categoryPill(category) {
  const known = Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, category);
  return el("span", { class: "pill pill-xs pill-cat", text: known ? CATEGORY_LABELS[category] : String(category ?? "—") });
}

// Roving tabindex: one row is tabbable, arrow keys move between rows.
function markSelectedRow(focusId = null) {
  const rows = [...$("request-list").querySelectorAll(".request-row")];
  for (const row of rows) {
    if (row.dataset.id === state.selectedId) row.setAttribute("aria-current", "true");
    else row.removeAttribute("aria-current");
    row.tabIndex = -1;
  }
  const active = rows.find((r) => r.dataset.id === (focusId || state.selectedId)) || rows[0];
  if (active) active.tabIndex = 0;
  if (focusId && active?.dataset.id === focusId) active.focus();
}

function onListKeydown(event) {
  const rows = [...$("request-list").querySelectorAll(".request-row")];
  const index = rows.indexOf(document.activeElement);
  if (index < 0) return;
  const targets = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: rows.length - 1 };
  if (!(event.key in targets)) return;
  event.preventDefault();
  const next = rows[Math.max(0, Math.min(rows.length - 1, targets[event.key]))];
  rows.forEach((r) => (r.tabIndex = -1));
  next.tabIndex = 0;
  next.focus();
}

// ---------- request detail ----------

function setView(view) {
  $("console-grid").dataset.view = view;
}

function renderDetailEmpty() {
  if (state.selectedId) return;
  const needs = state.requests.filter((r) => r.needsHuman).sort(compareRequests);
  const next = needs[0];
  $("detail-empty-title").textContent = !state.loaded
    ? "Select a request"
    : needs.length ? `${needs.length} request${needs.length === 1 ? "" : "s"} waiting for you` : "All caught up";
  $("detail-empty-text").textContent = needs.length
    ? "Pick a request in the list, or open the one that has waited longest."
    : "Nobody is waiting. Pick any request to read it.";
  const button = $("btn-open-next");
  button.hidden = !next;
  if (next) {
    button.textContent = `Open #${next.number}: ${next.title}`;
    button.dataset.id = next.id;
  }
}

function showDetailPart(part) {
  for (const name of ["empty", "loading", "error", "request"]) $(`detail-${name}`).hidden = name !== part;
}

async function selectRequest(id, { focusDetail = false } = {}) {
  const listRequest = state.requests.find((r) => r.id === id);
  if (state.selectedId !== id) {
    state.selectedId = id;
    state.detail = null;
    state.historyKey = "";
    $("history").replaceChildren();
    showDetailPart("loading");
    if (listRequest) resetComposerFor(listRequest);
  }
  setView("detail");
  markSelectedRow();
  const detail = $("detail");
  if (!isNarrow() && detail.getBoundingClientRect().top < 0) detail.scrollIntoView({ block: "start" });
  if (isNarrow()) window.scrollTo(0, 0);

  await loadDetail(id, { quiet: Boolean(state.detail) });
  if (focusDetail && state.selectedId === id && !$("detail-request").hidden) $("detail-title").focus();
}

function deselect() {
  state.selectedId = null;
  state.detail = null;
  state.historyKey = "";
  $("history").replaceChildren();
  showDetailPart("empty");
  setView("list");
  markSelectedRow();
  renderDetailEmpty();
}

async function loadDetail(id, { quiet = false } = {}) {
  const seq = ++state.seq.detail;
  try {
    const result = await adminCall("admin.request", { id }, { timeoutMs: 25000 });
    if (seq !== state.seq.detail || state.selectedId !== id) return;
    if (!result?.request?.id) throw new ApiError("bad_response", "The backend did not return the request.");
    const firstLoad = !state.detail;
    state.detail = { request: result.request, messages: Array.isArray(result.messages) ? result.messages : [] };
    mergeRequest(result.request);
    if (firstLoad) resetComposerFor(result.request);
    await renderDetail();
  } catch (err) {
    if (seq !== state.seq.detail || state.selectedId !== id || isUnauthorized(err)) return;
    if (err.code === "not_found") {
      state.requests = state.requests.filter((r) => r.id !== id);
      deselect();
      toast("That request no longer exists.", { tone: "error" });
      refreshAll();
      return;
    }
    if (quiet && state.detail) return; // keep showing what we have; the banner covers connection issues
    $("detail-error-text").textContent = `Could not load the request: ${err.message}`;
    showDetailPart("error");
  }
}

// Called after each list refresh: reload the open request only when it changed.
function syncSelectedRequest() {
  const id = state.selectedId;
  if (!id || !state.detail) return;
  const fresh = state.requests.find((r) => r.id === id);
  if (!fresh) {
    deselect();
    toast("The open request was deleted.");
    return;
  }
  const d = state.detail.request;
  if (d.updatedAt !== fresh.updatedAt || d.status !== fresh.status || d.draftAt !== fresh.draftAt || d.errorCount !== fresh.errorCount) {
    loadDetail(id, { quiet: true });
  }
}

async function renderDetail() {
  const d = state.detail;
  if (!d) return;
  const r = d.request;
  showDetailPart("request");
  renderTriage(r);
  $("detail-num").textContent = `#${r.number}`;
  $("detail-title-text").textContent = r.title || "(no title)";
  // replaceChildren would print null as text, so empty slots are filtered out.
  $("detail-pills").replaceChildren(...[
    statusPill(r.status),
    r.needsHuman ? el("span", { class: "pill pill-alert pill-xs", text: "Needs you" }) : null,
    urgencyPill(r.urgency),
    categoryPill(r.category),
    el("span", { class: "hint" },
      `${d.messages.length} message${d.messages.length === 1 ? "" : "s"} · started `,
      el("time", { datetime: r.createdAt, title: fullDate(r.createdAt, "en"), dataset: { rel: r.createdAt }, text: timeAgo(r.createdAt, "en") }),
    ),
  ].filter(Boolean));
  renderMeta(r);
  renderNotes(r);
  renderComposerState(r);
  await renderHistory(d);
}

// Claude's one-sentence read of the request. Admin only: never shown to the family.
function renderTriage(r) {
  const block = $("triage-block");
  const hasDraft = Boolean(r.draft);
  const triage = normalizeName(r.triage);
  block.dataset.state = triage ? "triage" : hasDraft ? "plain" : "none";
  $("triage-text").textContent = triage
    || (hasDraft ? "Claude wrote a draft but no triage line for this one." : "No draft yet. Use “Draft with Claude” to get a read on this and a first answer.");

  const age = $("triage-age");
  const at = $("triage-draft-at");
  age.hidden = !r.draftAt;
  if (r.draftAt) {
    at.dateTime = r.draftAt;
    at.title = fullDate(r.draftAt, "en");
    at.dataset.rel = r.draftAt;
    at.textContent = timeAgo(r.draftAt, "en");
  } else {
    delete at.dataset.rel;
    at.textContent = "";
  }
  $("triage-age-stale").hidden = !isDraftStale(r);
}

function renderMeta(r) {
  const email = normalizeName(r.contactEmail);
  const links = String(r.links ?? "").trim();
  const rows = [
    ["From", el("span", { text: normalizeName(r.requesterName) || "(no name)" })],
    ["Email", email
      ? (looksLikeEmail(email) ? el("a", { href: `mailto:${email}`, text: email }) : el("span", { text: email }))
      : el("span", { class: "muted-value", text: "none given" })],
  ];
  if (links) rows.push(["Links", el("span", { class: "meta-links" }, ...linkify(links))]);
  $("detail-meta").replaceChildren(...rows.flatMap(([label, value]) => [
    el("dt", { text: label }),
    el("dd", {}, value),
  ]));
}

// Family text is never HTML. Only well-formed http(s) runs become links.
function linkify(text) {
  const parts = String(text).split(/(https?:\/\/[^\s<>"')\]]+)/g);
  return parts.filter((part) => part !== "").map((part) => (
    /^https?:\/\//.test(part)
      ? el("a", { href: part, target: "_blank", rel: "noopener noreferrer nofollow", text: part })
      : document.createTextNode(part)
  ));
}

function renderNotes(r) {
  const notes = [];
  if (r.needsHuman) notes.push(note("warn", "Waiting for you.", needsReason(r)));
  if (r.lastError) {
    const count = Number(r.errorCount) || 0;
    notes.push(el("div", { class: "notice notice-warn" },
      el("strong", { text: `Drafting failed${count ? ` ${count}×` : ""}.` }),
      count >= 3 ? " The backend stopped retrying; write the answer yourself or try “Draft with Claude”." : "",
      el("pre", { class: "note-pre", text: formatError(r.lastError) }),
    ));
  }
  if (r.urgency === "urgent" && r.status !== "closed") {
    notes.push(note("info", "Marked urgent.", "They said this can't wait."));
  }
  $("detail-notes").replaceChildren(...notes);
}

function note(tone, strong, text) {
  return el("div", { class: `notice notice-${tone}` }, el("strong", { text: strong }), " ", text);
}

// Why the backend flagged it (mirrors the needsHuman rule in SPEC §1) plus anything blocking a draft.
function needsReason(r) {
  const who = normalizeName(r.requesterName) || "Someone";
  const reasons = [`${who} wrote last and has not had an answer.`];
  if ((Number(r.errorCount) || 0) >= 3) reasons.push("Automatic drafting stopped after repeated failures.");
  if (state.settings.autoDraft === false) reasons.push("Automatic drafts are off.");
  const s = state.stats;
  if (s && Number(s.dailyCap) > 0 && Number(s.draftsToday) >= Number(s.dailyCap)) reasons.push("The daily draft cap is reached.");
  return reasons.join(" ");
}

async function renderHistory({ request, messages }) {
  const key = [request.id, messages.map((m) => m.id).join(","), ownerName(), normalizeName(request.requesterName)].join("|");
  if (key === state.historyKey) {
    updateRelativeTimes($("history"));
    return;
  }
  const seq = ++state.seq.history;
  const items = await Promise.all(messages.map((m) => messageItem(m, request)));
  if (seq !== state.seq.history) return;
  state.historyKey = key;
  $("history").replaceChildren(...items);
  $("history-empty").hidden = messages.length > 0;
  renderComposerState(request); // the stale-draft check needs the messages
}

async function messageItem(m, request) {
  const fromFamily = m.from === "family";
  const author = fromFamily ? (normalizeName(request.requesterName) || "Family") : ownerName();
  const body = el("div", { class: "msg-body" });
  if (fromFamily) {
    if (m.text) body.append(el("p", { class: "plain", text: m.text })); // never HTML
  } else {
    const md = el("div", { class: "md" });
    md.append(await renderMarkdown(m.text || ""));
    body.append(md);
  }
  return el("li", { class: `msg msg-${fromFamily ? "family" : "alon"}` },
    el("div", { class: "msg-head" },
      el("span", { class: "msg-author", text: author }),
      m.via ? el("span", { class: "msg-via", text: `via ${m.via}` }) : null,
      el("time", { class: "msg-time", datetime: m.createdAt, title: fullDate(m.createdAt, "en"), dataset: { rel: m.createdAt }, text: timeAgo(m.createdAt, "en") }),
    ),
    body,
  );
}

// ---------- composer ----------

function composeTexts() {
  const value = store.get(KEYS.compose, {});
  return value && typeof value === "object" ? value : {};
}

function saveComposerText() {
  const id = state.selectedId;
  if (!id) return;
  const all = composeTexts();
  const text = $("reply-text").value;
  if (text.trim()) all[id] = text;
  else delete all[id];
  store.set(KEYS.compose, all);
}

function clearComposerText(id) {
  const all = composeTexts();
  delete all[id];
  store.set(KEYS.compose, all);
}

// The last thing the family wrote in the open request, if its messages are loaded.
function lastFamilyMessageAt(r) {
  if (state.detail?.request.id !== r.id) return null;
  const last = state.detail.messages.filter((m) => m.from === "family").at(-1);
  const at = last ? Date.parse(last.createdAt) : NaN;
  return Number.isFinite(at) ? at : null;
}

// A draft written before their latest message may not answer it.
function isDraftStale(r) {
  if (!r?.draftAt) return false;
  const draftAt = Date.parse(r.draftAt);
  const familyAt = lastFamilyMessageAt(r);
  return Number.isFinite(draftAt) && familyAt !== null && draftAt < familyAt;
}

// Defaults when a request is opened: saved text, email checkbox from settings.
function resetComposerFor(r) {
  $("reply-text").value = composeTexts()[r.id] || "";
  setComposerTab("write", { focus: false });
  showComposerError("");
  $("reply-email").checked = Boolean(normalizeName(r.contactEmail)) && state.settings.emailReplies !== false;
  renderComposerState(r);
}

// Parts of the composer that follow the request data (safe to call on every refresh).
function renderComposerState(r) {
  const email = normalizeName(r.contactEmail);
  const box = $("reply-email");
  box.disabled = !email;
  if (!email) box.checked = false;
  $("reply-email-label").classList.toggle("is-disabled", !email);
  $("reply-email-hint").textContent = email
    ? `Also sent to ${email}.`
    : "They didn't leave an address, so there is nowhere to email it.";

  const hasDraft = Boolean(r.draft);
  $("draft-bar").hidden = !hasDraft;
  if (hasDraft) {
    const at = $("draft-at");
    at.dateTime = r.draftAt || "";
    at.title = r.draftAt ? fullDate(r.draftAt, "en") : "";
    if (r.draftAt) at.dataset.rel = r.draftAt;
    else delete at.dataset.rel;
    at.textContent = r.draftAt ? `written ${timeAgo(r.draftAt, "en")}` : "written earlier";
    $("draft-stale").hidden = !isDraftStale(r);
  }
  $("triage-age-stale").hidden = !isDraftStale(r);

  $("btn-close-request").disabled = r.status === "closed";
  setBusy($("btn-draft"), state.drafting.has(r.id), "Drafting…");
}

function showComposerError(message) {
  $("composer-error").textContent = message;
  if (message) $("reply-text").setAttribute("aria-invalid", "true");
  else $("reply-text").removeAttribute("aria-invalid");
}

function setComposerTab(name, { focus = true } = {}) {
  const write = name === "write";
  for (const [tab, selected] of [["tab-write", write], ["tab-preview", !write]]) {
    $(tab).setAttribute("aria-selected", String(selected));
    $(tab).tabIndex = selected ? 0 : -1;
  }
  $("panel-write").hidden = !write;
  $("panel-preview").hidden = write;
  if (!write) renderPreview();
  if (focus) $(write ? "tab-write" : "tab-preview").focus();
}

async function renderPreview() {
  const box = $("reply-preview");
  const text = $("reply-text").value;
  const seq = ++state.seq.preview;
  if (!text.trim()) {
    box.replaceChildren(el("p", { class: "hint", text: "Nothing to preview yet." }));
    return;
  }
  const frag = await renderMarkdown(text);
  if (seq === state.seq.preview) box.replaceChildren(frag);
}

function onTabKeydown(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const toPreview = event.key === "End" || (event.key !== "Home" && event.currentTarget.id === "tab-write");
  setComposerTab(toPreview ? "preview" : "write");
}

async function sendReply(event) {
  event?.preventDefault();
  const r = state.detail?.request;
  if (!r || state.sending) return;
  const textarea = $("reply-text");
  const text = textarea.value.trim();
  if (!text) {
    showComposerError("Write an answer before sending.");
    setComposerTab("write", { focus: false });
    textarea.focus();
    return;
  }
  showComposerError("");
  const email = Boolean(normalizeName(r.contactEmail)) && $("reply-email").checked;
  const params = { id: r.id, text, email, via: "admin" };

  state.sending = true;
  setBusy($("btn-send"), true, "Sending…");
  try {
    const result = await adminCall("admin.reply", params, { timeoutMs: 60000 });
    const request = result?.request;
    clearComposerText(r.id);
    // Clear the box only if it still holds what was sent (the owner may have switched requests).
    if (state.selectedId === r.id && textarea.value.trim() === text) {
      textarea.value = "";
      setComposerTab("write", { focus: false });
    }
    if (request) mergeRequest(request, { own: true });
    toast(`Answer sent on #${request?.number ?? r.number}${email ? ", and emailed to them" : ""}.`);
    refreshAll();
    if (state.selectedId === r.id) loadDetail(r.id, { quiet: true });
  } catch (err) {
    if (!isUnauthorized(err)) {
      showComposerError(`Not sent: ${err.message}`);
      toast("The answer was not sent.", { tone: "error" });
    }
  } finally {
    state.sending = false;
    setBusy($("btn-send"), false);
  }
}

async function draftWithClaude() {
  const r = state.detail?.request;
  if (!r || state.drafting.has(r.id)) return;
  state.drafting.add(r.id);
  renderComposerState(r);
  announce("Asking Claude for a draft. This can take a minute.");

  let request = null;
  try {
    const result = await adminCall("admin.draft", { id: r.id }, { timeoutMs: 180000 });
    request = result?.request || null;
  } catch (err) {
    if (!isUnauthorized(err)) toast(`Draft failed: ${err.message}`, { tone: "error", ms: 6000 });
  } finally {
    state.drafting.delete(r.id);
    if (state.detail) renderComposerState(state.detail.request);
  }
  if (!request || !state.token) return;

  mergeRequest(request, { own: true });
  if (!request.draft) {
    toast("Claude did not return a draft. Try again.", { tone: "error" });
    return;
  }
  if (state.selectedId === request.id) {
    if (state.detail) state.detail.request = request;
    renderTriage(request);
    renderComposerState(request);
    await insertDraft(request);
  } else {
    toast(`The draft for #${request.number} is ready.`);
  }
}

// Put the stored draft into the answer box, asking first if it is stale or would replace other text.
async function insertDraft(request = state.detail?.request) {
  if (!request?.draft) return;
  const textarea = $("reply-text");
  const current = textarea.value.trim();
  const replaces = Boolean(current) && current !== request.draft.trim();
  const stale = isDraftStale(request);
  if (replaces || stale) {
    const who = normalizeName(request.requesterName) || "they";
    const body = [
      stale ? `This draft was written before ${who} wrote again, so it may not answer their latest message.` : "",
      replaces ? "The answer box already has text, and inserting the draft replaces it." : "",
    ].filter(Boolean).join(" ");
    const ok = await confirmDialog({
      title: stale ? "Insert this older draft?" : "Replace your text?",
      body,
      confirmLabel: "Insert draft",
      cancelLabel: replaces ? "Keep my text" : "Cancel",
    });
    if (!ok || state.selectedId !== request.id) return;
  }
  textarea.value = request.draft;
  saveComposerText();
  showComposerError("");
  setComposerTab("write", { focus: false });
  textarea.focus();
  textarea.setSelectionRange(0, 0);
  textarea.scrollTop = 0;
  toast("Draft inserted. Read it before sending — it goes out as you.", { ms: 5000 });
}

// ---------- request actions ----------

async function closeRequest() {
  const r = state.detail?.request;
  if (!r) return;
  const button = $("btn-close-request");
  setBusy(button, true, "Closing…");
  try {
    const result = await adminCall("admin.close", { id: r.id });
    if (result?.request) mergeRequest(result.request, { own: true });
    if (state.selectedId === r.id) await renderDetail();
    toast(`#${r.number} closed.`);
    refreshAll();
  } catch (err) {
    if (!isUnauthorized(err)) toast(`Could not close: ${err.message}`, { tone: "error" });
  } finally {
    setBusy(button, false);
    button.disabled = state.detail?.request.status === "closed";
  }
}

async function deleteRequest() {
  const r = state.detail?.request;
  if (!r) return;
  const who = normalizeName(r.requesterName) || "they";
  const ok = await confirmDialog({
    title: `Delete #${r.number}?`,
    body: `“${r.title}”, its messages and Claude's draft are removed from the sheet, and ${who} will no longer see it. This cannot be undone.`,
    confirmLabel: "Delete request",
    danger: true,
  });
  if (!ok || !state.token) return;
  const button = $("btn-delete-request");
  setBusy(button, true, "Deleting…");
  try {
    await adminCall("admin.delete", { id: r.id });
    state.requests = state.requests.filter((x) => x.id !== r.id);
    state.seenNeeds.delete(r.id);
    clearComposerText(r.id);
    if (state.selectedId === r.id) deselect();
    renderFilters();
    renderList(true);
    toast(`#${r.number} deleted.`);
    ($("request-list").querySelector('.request-row[tabindex="0"]') || $("inbox-heading")).focus?.();
    refreshAll();
  } catch (err) {
    if (!isUnauthorized(err)) toast(`Could not delete: ${err.message}`, { tone: "error" });
  } finally {
    setBusy(button, false);
  }
}

// ---------- dialogs ----------

let confirmOpen = false;
function confirmDialog({ title, body, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
  const dialog = $("confirm-dialog");
  if (typeof dialog.showModal !== "function") return Promise.resolve(window.confirm(`${title}\n\n${body}`));
  if (confirmOpen) return Promise.resolve(false);
  confirmOpen = true;
  $("confirm-title").textContent = title;
  $("confirm-body").textContent = body;
  const okButton = $("confirm-ok");
  okButton.textContent = confirmLabel;
  okButton.className = `btn btn-sm ${danger ? "btn-danger-solid" : "btn-primary"}`;
  const cancelButton = $("confirm-cancel");
  cancelButton.textContent = cancelLabel;
  const opener = document.activeElement;
  dialog.returnValue = "";
  return new Promise((resolve) => {
    // Settle on the button click itself; the close event covers Escape.
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      confirmOpen = false;
      okButton.removeEventListener("click", onOk);
      cancelButton.removeEventListener("click", onCancel);
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      if (opener?.isConnected) opener.focus();
      resolve(answer);
    };
    const onOk = (event) => {
      event.preventDefault();
      finish(true);
    };
    const onCancel = (event) => {
      event.preventDefault();
      finish(false);
    };
    const onClose = () => finish(dialog.returnValue === "ok");
    okButton.addEventListener("click", onOk);
    cancelButton.addEventListener("click", onCancel);
    dialog.addEventListener("close", onClose);
    dialog.showModal();
    // Destructive actions start on Cancel.
    (danger ? cancelButton : okButton).focus();
  });
}

// ---------- settings ----------

const SETTING_SWITCHES = ["autoDraft", "emailReplies"];

let settingsOpener = null;
function openSettings({ focusId = "set-ownerName", notice = "" } = {}) {
  const dialog = $("settings-dialog");
  if (dialog.open) return;
  settingsOpener = document.activeElement;
  state.settingsBase = JSON.parse(JSON.stringify(state.settings || {}));
  fillSettingsForm(state.settingsBase);
  showSettingsError("");
  $("settings-notice").textContent = notice;
  $("settings-notice").hidden = !notice;
  dialog.showModal();
  $(focusId)?.focus();
}

function fillSettingsForm(s) {
  $("set-ownerName").value = s.ownerName ?? "";
  $("set-siteUrl").value = s.siteUrl ?? "";
  $("set-defaultLang").value = ["es", "en"].includes(s.defaultLang) ? s.defaultLang : "es";
  for (const key of SETTING_SWITCHES) $(`set-${key}`).checked = Boolean(s[key]);
  $("set-dailyCap").value = s.dailyCap ?? "";
  $("set-notifyEmail").value = s.notifyEmail ?? "";
  $("set-notifyOn").value = ["new", "none"].includes(s.notifyOn) ? s.notifyOn : "new";
  for (const node of $("settings-form").querySelectorAll("[aria-invalid]")) node.removeAttribute("aria-invalid");
}

function collectSettings() {
  const value = (key) => $(`set-${key}`).value.trim();
  const errors = [];

  const values = {
    ownerName: value("ownerName"),
    siteUrl: value("siteUrl"),
    defaultLang: $("set-defaultLang").value,
    notifyEmail: value("notifyEmail"),
    notifyOn: $("set-notifyOn").value,
    dailyCap: Number(value("dailyCap")),
  };
  for (const key of SETTING_SWITCHES) values[key] = $(`set-${key}`).checked;

  if (!values.ownerName) errors.push(["ownerName", "Your name can't be empty."]);
  if (values.ownerName.length > 60) errors.push(["ownerName", "Your name can be at most 60 characters."]);
  if (values.siteUrl && !/^https?:\/\/\S+$/i.test(values.siteUrl)) errors.push(["siteUrl", "Site URL must start with https://"]);
  if (values.notifyEmail && !looksLikeEmail(values.notifyEmail)) errors.push(["notifyEmail", "The notification email doesn't look like an email address."]);
  if (value("dailyCap") === "" || !Number.isInteger(values.dailyCap) || values.dailyCap < 0 || values.dailyCap > 500) {
    errors.push(["dailyCap", "Daily cap must be a whole number from 0 to 500."]);
  }
  return { values, errors };
}

// `message` is shown exactly as the API wrote it.
function showSettingsError(message) {
  $("settings-error-text").textContent = message;
  $("settings-error").hidden = !message;
}

async function saveSettings(event) {
  event.preventDefault();
  const { values, errors } = collectSettings();
  for (const node of $("settings-form").querySelectorAll("[aria-invalid]")) node.removeAttribute("aria-invalid");
  if (errors.length) {
    for (const [key] of errors) $(`set-${key}`).setAttribute("aria-invalid", "true");
    $("settings-error-title").textContent = "Check these first.";
    showSettingsError(errors.map(([, msg]) => msg).join(" "));
    $(`set-${errors[0][0]}`).focus();
    return;
  }

  // Send only what changed, so edits made elsewhere (e.g. the bridge) are not overwritten.
  const set = {};
  for (const [key, val] of Object.entries(values)) {
    if (JSON.stringify(val) !== JSON.stringify(state.settingsBase?.[key])) set[key] = val;
  }
  if (!Object.keys(set).length) {
    $("settings-dialog").close();
    toast("No changes to save.");
    return;
  }

  const button = $("settings-save");
  setBusy(button, true, "Saving…");
  showSettingsError("");
  try {
    const { settings } = await adminCall("admin.settings", { set });
    state.settings = settings || { ...state.settings, ...set };
    $("settings-dialog").close();
    toast("Settings saved.");
    rerenderForSettings();
    refreshAll();
  } catch (err) {
    if (!isUnauthorized(err)) {
      $("settings-error-title").textContent = "Not saved.";
      showSettingsError(err.message); // verbatim, exactly what the backend said
    }
  } finally {
    setBusy(button, false);
  }
}

function rerenderForSettings() {
  renderHeader();
  renderStrip();
  renderList(true);
  if (state.detail) {
    state.historyKey = "";
    renderDetail();
  }
}

// ---------- header actions ----------

async function copyFamilyLink() {
  const siteUrl = normalizeName(state.settings.siteUrl);
  const familyToken = state.stats?.familyToken;
  if (!state.loaded) {
    toast("Still loading. Try again in a moment.");
    return;
  }
  if (!siteUrl) {
    openSettings({ focusId: "set-siteUrl", notice: "Set the Site URL first: the family link is built from it." });
    return;
  }
  if (!familyToken) {
    toast("There is no family token yet. Run setup() in the Apps Script editor.", { tone: "error", ms: 6000 });
    return;
  }
  const ok = await copyText(`${siteUrl}#f=${familyToken}`);
  toast(
    ok ? "Family link copied. Share it only with the family — anyone with it can write to you." : "Could not copy the link. Your browser blocked the clipboard.",
    { tone: ok ? "info" : "error", ms: 5000 },
  );
}

function desktopNotifyOn() {
  return "Notification" in window && Notification.permission === "granted" && store.get(KEYS.notify, false) === true;
}

function renderNotifyButton() {
  const button = $("btn-notify");
  if (!("Notification" in window)) {
    button.hidden = true;
    return;
  }
  const denied = Notification.permission === "denied";
  button.textContent = desktopNotifyOn() ? "Turn off desktop notifications" : "Enable desktop notifications";
  button.disabled = denied && !desktopNotifyOn();
  button.title = denied ? "Notifications are blocked for this site in your browser settings." : "";
}

async function toggleNotifications() {
  if (desktopNotifyOn()) {
    store.set(KEYS.notify, false);
    toast("Desktop notifications off.");
  } else {
    const permission = await askNotificationPermission();
    if (permission === "granted") {
      store.set(KEYS.notify, true);
      toast("Desktop notifications on. They appear when a request needs you and this tab is in the background.", { ms: 5000 });
    } else if (permission === "denied") {
      toast("Notifications are blocked for this site in your browser settings.", { tone: "error" });
    } else {
      toast("Notifications were not enabled.");
    }
  }
  renderNotifyButton();
}

// ---------- helpers ----------

function setBusy(button, busy, busyLabel) {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy;
  if (busy) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
  button.textContent = busy && busyLabel ? busyLabel : button.dataset.label;
}

function updateShortcutHint() {
  const mac = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || "");
  $("send-shortcut").textContent = mac ? "⌘+Enter" : "Ctrl+Enter";
}

// ---------- events ----------

function wireEvents() {
  $("signin-form").addEventListener("submit", onSignIn);
  $("signin-show").addEventListener("change", (e) => {
    $("signin-token").type = e.target.checked ? "text" : "password";
  });

  $("btn-signout").addEventListener("click", signOut);
  $("btn-settings").addEventListener("click", () => openSettings());
  $("btn-copy-link").addEventListener("click", copyFamilyLink);
  $("btn-notify").addEventListener("click", toggleNotifications);
  $("btn-refresh").addEventListener("click", async () => {
    await refreshAll();
    if (state.selectedId) loadDetail(state.selectedId, { quiet: true });
  });

  for (const button of document.querySelectorAll(".filter")) {
    button.addEventListener("click", () => setFilter(button.dataset.filter));
  }
  $("person-select").addEventListener("change", (e) => {
    state.person = normalizeName(e.target.value);
    store.set(KEYS.person, state.person);
    renderList(true);
  });
  $("btn-show-all").addEventListener("click", () => setFilter("all"));
  $("request-list").addEventListener("keydown", onListKeydown);
  $("btn-open-next").addEventListener("click", (e) => {
    if (e.currentTarget.dataset.id) selectRequest(e.currentTarget.dataset.id, { focusDetail: true });
  });

  $("btn-back").addEventListener("click", () => {
    setView("list");
    markSelectedRow();
    const row = $("request-list").querySelector('.request-row[tabindex="0"]');
    (row || $("inbox-heading")).focus?.();
  });
  $("btn-detail-retry").addEventListener("click", () => {
    if (!state.selectedId) return;
    showDetailPart("loading");
    loadDetail(state.selectedId);
  });

  // Composer
  $("composer").addEventListener("submit", sendReply);
  const textarea = $("reply-text");
  textarea.addEventListener("input", () => {
    saveComposerText();
    if (textarea.value.trim()) showComposerError("");
  });
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendReply();
    }
  });
  for (const id of ["tab-write", "tab-preview"]) {
    $(id).addEventListener("click", () => setComposerTab(id === "tab-write" ? "write" : "preview", { focus: false }));
    $(id).addEventListener("keydown", onTabKeydown);
  }
  $("btn-draft").addEventListener("click", draftWithClaude);
  $("btn-insert-draft").addEventListener("click", () => insertDraft());
  $("btn-close-request").addEventListener("click", closeRequest);
  $("btn-delete-request").addEventListener("click", deleteRequest);

  // Settings
  $("settings-form").addEventListener("submit", saveSettings);
  $("settings-close").addEventListener("click", () => $("settings-dialog").close());
  $("settings-cancel").addEventListener("click", () => $("settings-dialog").close());
  $("settings-dialog").addEventListener("close", () => {
    if ($("screen-console").hidden) return;
    (settingsOpener?.isConnected ? settingsOpener : $("btn-settings")).focus();
  });
}

boot();
