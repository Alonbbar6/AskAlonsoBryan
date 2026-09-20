// Family site: the list of requests, the "ask for help" form and each request.
//
// Every visible string comes from assets/i18n.js through t() — there is no text in this file
// and none in index.html. The ES / EN switch in the header re-renders the page in place.
//
// What a family member writes is always rendered as plain text. Only the owner's replies go
// through ui.renderMarkdown, which sanitizes them.

import { CONFIG, isConfigured } from "./config.js";
import { call } from "./api.js";
import {
  el,
  renderMarkdown,
  timeAgo,
  fullDate,
  store,
  takeHashParam,
  setTitleBadge,
  chime,
  askNotificationPermission,
  notify,
  announce,
  toast,
  poll,
  copyText,
} from "./ui.js";
import { t, getLang, setLang, setDefaultLang, hasChosenLang, LANGS } from "./i18n.js";

const TOKEN_KEY = "ask.family"; // the family token from the link (#f=...)
const WHO_KEY = "ask.who"; // this person's 32-hex requesterId
const NAME_KEY = "ask.name"; // their name, so the form is filled in next time
const OWNER_KEY = "ask.owner"; // the owner's name, so the "no link" screen can use it

// The same limits the backend enforces (SPEC §1).
const LIMITS = { name: 60, title: 140, text: 8000, links: 2000, email: 120 };

const CATEGORIES = ["tech", "docs", "school", "data", "money", "other"];
const URGENCIES = ["normal", "soon", "urgent"];

// status -> the pill class in base.css
const STATUS_PILL = { new: "waiting", working: "answering", answered: "answered", closed: "closed" };

const VIEWS = ["loading", "nolink", "notconfigured", "error", "home", "form", "request"];

const HEX32 = /^[0-9a-f]{32}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// [input id, counter id, limit, count the trimmed value?]
const COUNTERS = [
  ["f-name", "count-name", LIMITS.name, true],
  ["f-title", "count-title", LIMITS.title, true],
  ["f-text", "count-text", LIMITS.text, true],
  ["f-links", "count-links", LIMITS.links, true],
  ["r-text", "count-r-text", LIMITS.text, true],
];

const state = {
  token: null,
  who: null,
  info: null, // {ownerName, defaultLang, now}
  view: null,
  requests: [], // latest `list` result
  seen: new Map(), // id -> messageCount at the previous poll, to spot new answers
  listLoaded: false,
  openId: null, // request shown in the request view
  openData: null, // {request, messages} as last rendered, so a language switch can re-render
  seq: 0, // bumps on every request load so stale responses are dropped
  focusTitle: false,
  failures: 0,
  poller: null,
  hiddenTimer: null,
  sending: false,
  replying: false,
};

const $ = (id) => document.getElementById(id);

// ---------- names and strings ----------

function ownerName() {
  const remembered = store.get(OWNER_KEY);
  return state.info?.ownerName || (typeof remembered === "string" && remembered) || "Alonso Bryan";
}

function myName() {
  const remembered = store.get(NAME_KEY);
  return typeof remembered === "string" ? remembered : "";
}

// t() with the variables every screen may need already filled in.
function tx(key, vars) {
  return t(key, { owner: ownerName(), ...vars });
}

function initial(name) {
  const first = [...String(name || "").trim()][0];
  return first ? first.toUpperCase() : "?";
}

// Puts a space between inline items so screen readers don't glue the words together.
function spaced(...items) {
  const out = [];
  for (const item of items.flat()) {
    if (!item) continue;
    if (out.length) out.push(" ");
    out.push(item);
  }
  return out;
}

function statusPill(status) {
  const known = Object.hasOwn(STATUS_PILL, status) ? status : "new";
  return el("span", { class: `pill pill-${STATUS_PILL[known]}` }, tx(`status.${known}`));
}

function categoryLabel(category) {
  return CATEGORIES.includes(category) ? tx(`cat.${category}.title`) : tx("cat.other.title");
}

function urgencyLabel(urgency) {
  return URGENCIES.includes(urgency) ? tx(`urg.${urgency}.title`) : tx("urg.normal.title");
}

function timeEl(iso) {
  const lang = getLang();
  return el("time", { datetime: iso, title: fullDate(iso, lang), "data-ago": iso }, timeAgo(iso, lang));
}

function refreshTimes() {
  const lang = getLang();
  for (const node of document.querySelectorAll("time[data-ago]")) {
    const iso = node.getAttribute("data-ago");
    node.textContent = timeAgo(iso, lang);
    node.setAttribute("title", fullDate(iso, lang));
  }
}

function errorMessage(err, { sending = false } = {}) {
  const code = err?.code;
  if (code === "timeout" && sending) return tx("err.timeout.sending");
  const known = [
    "rate_limited",
    "network",
    "timeout",
    "unauthorized",
    "bad_request",
    "not_found",
    "not_configured",
  ];
  return known.includes(code) ? tx(`err.${code}`) : tx("err.default");
}

// role="alert" boxes: clear first so the same message is announced again.
function showFormError(boxId, message, field) {
  const box = $(boxId);
  box.textContent = "";
  setTimeout(() => (box.textContent = message), 30);
  if (field) {
    field.setAttribute("aria-invalid", "true");
    field.focus();
  }
}

function clearFormError(boxId) {
  $(boxId).textContent = "";
}

function updateCounters() {
  for (const [inputId, counterId, limit, trim] of COUNTERS) {
    const input = $(inputId);
    const counter = $(counterId);
    if (!input || !counter) continue;
    const value = input.value;
    const count = (trim ? value.trim() : value).length;
    counter.replaceChildren(`${count} / ${limit}`, el("span", { class: "sr-only" }, tx("a11y.characters")));
    counter.classList.toggle("over", count > limit);
  }
}

// ---------- language ----------

// Fills every [data-i18n*] node in index.html. Called on boot and on every language switch.
function applyStatic() {
  for (const node of document.querySelectorAll("[data-i18n]")) {
    node.textContent = tx(node.dataset.i18n);
  }
  for (const node of document.querySelectorAll("[data-i18n-placeholder]")) {
    node.setAttribute("placeholder", tx(node.dataset.i18nPlaceholder));
  }
  for (const node of document.querySelectorAll("[data-i18n-label]")) {
    node.setAttribute("aria-label", tx(node.dataset.i18nLabel));
  }
  for (const node of document.querySelectorAll("[data-i18n-title]")) {
    node.setAttribute("title", tx(node.dataset.i18nTitle));
  }
}

// Re-renders everything that is written by JS, without asking the server again.
function applyLang() {
  const lang = getLang();
  document.documentElement.lang = lang;
  for (const button of document.querySelectorAll("[data-lang]")) {
    button.setAttribute("aria-pressed", String(button.dataset.lang === lang));
  }
  applyStatic();
  updateCounters();
  updateSubmitLabels();
  if (state.view === "error") $("error-text").textContent = tx("err.default");

  const list = $("request-list");
  delete list.dataset.signature; // force a rebuild in the new language
  renderList();

  if (state.openData) {
    renderRequest(state.openData.request, state.openData.messages, state.seq);
  }
  refreshTimes();
  updateNotifyButtons();
}

function chooseLang(lang) {
  if (!LANGS.includes(lang) || lang === getLang()) return;
  setLang(lang);
  applyLang();
}

function updateSubmitLabels() {
  $("form-submit").textContent = state.sending ? tx("form.sending") : tx("form.submit");
  $("followup-submit").textContent = state.replying ? tx("req.followup.sending") : tx("req.followup.send");
}

// ---------- identity ----------

function newWho() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function ensureWho() {
  const remembered = store.get(WHO_KEY);
  if (typeof remembered === "string" && HEX32.test(remembered)) return remembered;
  const fresh = newWho();
  store.set(WHO_KEY, fresh);
  return fresh;
}

async function copyMyCode() {
  const ok = await copyText(state.who);
  if (ok) toast(tx("code.copied"), { ms: 6000 });
  else toast(tx("code.copyfail", { code: state.who }), { tone: "error", ms: 12000 });
}

function useCode(ev) {
  ev.preventDefault();
  const field = $("f-code");
  const value = field.value.replace(/[\s-]/g, "").toLowerCase();
  if (!HEX32.test(value)) return showFormError("code-error", tx("code.have.bad"), field);
  if (value === state.who) return showFormError("code-error", tx("code.have.same"), field);

  clearFormError("code-error");
  field.removeAttribute("aria-invalid");
  field.value = "";
  state.who = value;
  store.set(WHO_KEY, value);
  store.remove(NAME_KEY); // the name comes back from this code's own requests
  $("f-name").value = "";

  state.requests = [];
  state.seen = new Map();
  state.listLoaded = false;
  leaveRequest();
  const list = $("request-list");
  list.replaceChildren();
  delete list.dataset.signature;
  setTitleBadge(0);
  renderList();
  $("code-box").open = false;
  toast(tx("code.have.ok"));
  announce(tx("code.have.ok"));
  state.poller?.refresh();
}

// ---------- views and routing ----------

function showView(name, { focus = false } = {}) {
  const changed = state.view !== name;
  for (const view of VIEWS) $(`view-${view}`).hidden = view !== name;
  state.view = name;
  if (changed) window.scrollTo(0, 0);
  if (focus) $(`view-${name}`).querySelector("h1")?.focus({ preventScroll: true });
  updateBadge();
}

// URL shapes: index.html (the list) · ?new=1 (the form) · ?r=<id> (one request)
function route({ focus = true } = {}) {
  if (!state.info) return;
  const params = new URLSearchParams(location.search);
  const id = params.get("r");
  if (id) openRequest(id, focus);
  else if (params.has("new")) openForm(focus);
  else openHome(focus);
}

function navigate(search) {
  const url = location.pathname + search;
  if (location.search === search) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  route({ focus: true });
}

// In-app links keep working as normal links (new tab, no JS), but navigate without a reload.
function onRouteClick(ev) {
  const link = ev.target.closest?.("a[data-route]");
  if (!link || !state.info) return;
  if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  ev.preventDefault();
  navigate(link.getAttribute("data-route"));
}

function leaveRequest() {
  state.openId = null;
  state.openData = null;
  state.seq++;
}

// ---------- boot ----------

function start() {
  document.documentElement.lang = getLang();
  state.who = ensureWho();

  // A fresh link (#f=...) wins over the remembered token.
  const fromLink = takeHashParam("f");
  if (fromLink) store.set(TOKEN_KEY, fromLink);
  const remembered = store.get(TOKEN_KEY);
  state.token = fromLink || (typeof remembered === "string" && remembered) || null;

  applyLang();
  if (!isConfigured()) return showView("notconfigured");
  if (!state.token) return showView("nolink");
  connect();
}

async function connect({ fromRetry = false } = {}) {
  stopPolling();
  showView("loading");
  let info;
  try {
    info = await call("info", { family: state.token });
  } catch (err) {
    if (err.code === "unauthorized") return signOut();
    $("error-text").textContent = errorMessage(err);
    showView("error");
    if (fromRetry) $("retry-btn").focus();
    return;
  }
  state.info = info || {};
  if (state.info.ownerName) store.set(OWNER_KEY, state.info.ownerName);
  // The backend default only decides when this person never picked a language themselves.
  if (!hasChosenLang() && state.info.defaultLang) setDefaultLang(state.info.defaultLang);
  applyLang();
  $("foot").hidden = false;
  route({ focus: fromRetry });
  startPolling();
}

// The family token was rejected: forget it and show the "you need the link" screen.
function signOut() {
  stopPolling();
  store.remove(TOKEN_KEY);
  state.token = null;
  state.info = null;
  state.requests = [];
  state.seen = new Map();
  state.listLoaded = false;
  leaveRequest();
  const list = $("request-list");
  list.replaceChildren();
  delete list.dataset.signature;
  $("foot").hidden = true;
  $("conn").hidden = true;
  setTitleBadge(0);
  showView("nolink", { focus: true });
}

function onHashChange() {
  const token = takeHashParam("f");
  if (!token || token === state.token) return;
  store.set(TOKEN_KEY, token);
  state.token = token;
  if (isConfigured()) connect();
}

// ---------- polling and new-answer alerts ----------

function startPolling() {
  stopPolling();
  state.poller = poll(refresh, CONFIG.pollSeconds);
  // ui.poll pauses while the tab is hidden. If notifications were allowed, still check once a
  // minute so the notification can reach them in another tab.
  state.hiddenTimer = setInterval(() => {
    const allowed = "Notification" in window && Notification.permission === "granted";
    if (allowed && document.visibilityState === "hidden") state.poller?.refresh();
  }, 60000);
}

function stopPolling() {
  state.poller?.stop();
  state.poller = null;
  clearInterval(state.hiddenTimer);
  state.hiddenTimer = null;
}

async function refresh() {
  const token = state.token;
  const who = state.who;
  if (!token || !who || !state.info) return;
  let result;
  try {
    result = await call("list", { family: token, who });
  } catch (err) {
    if (token !== state.token || who !== state.who) return;
    if (err.code === "unauthorized") return signOut();
    state.failures++;
    if (state.failures >= 2) $("conn").hidden = false;
    return;
  }
  if (token !== state.token || who !== state.who) return;
  state.failures = 0;
  $("conn").hidden = true;

  const requests = Array.isArray(result?.requests) ? result.requests : [];
  const news = state.listLoaded ? findNews(requests) : [];
  state.seen = new Map(requests.map((r) => [r.id, Number(r.messageCount) || 0]));
  state.requests = requests;
  state.listLoaded = true;

  // Coming back from another device with a pasted code: take the name from their own requests.
  if (!myName() && requests[0]?.requesterName) {
    store.set(NAME_KEY, String(requests[0].requesterName));
    if (!$("f-name").value) $("f-name").value = myName();
  }

  if (state.view === "home") renderList();
  if (state.view === "request") syncOpenRequest();
  refreshTimes();
  updateBadge();
  if (news.length) announceNews(news);
}

// Requests whose newest message is an answer we had not seen at the previous poll.
function findNews(requests) {
  return requests.filter((r) => {
    if (r.lastFrom !== "alon") return false;
    if (!state.seen.has(r.id)) return Boolean(r.unread);
    return (Number(r.messageCount) || 0) > state.seen.get(r.id);
  });
}

function announceNews(news) {
  chime();
  const first = news[0];
  const message =
    news.length === 1
      ? tx("news.one", { n: first.number, title: first.title })
      : tx("news.many", { n: news.length });
  notify(
    news.length === 1 ? tx("news.notify.one") : tx("news.notify.many"),
    news.map((r) => `#${r.number} · ${r.title}`).join("\n"),
  );
  const viewingIt = state.view === "request" && news.some((r) => r.id === state.openId);
  if (!viewingIt && document.visibilityState === "visible") {
    toast(message, { ms: 6000 }); // the toast is a role="status" region, so it is announced too
  } else {
    announce(message);
  }
}

function updateBadge() {
  const viewingId = state.view === "request" && document.visibilityState === "visible" ? state.openId : null;
  setTitleBadge(state.requests.filter((r) => r.unread && r.id !== viewingId).length);
}

function updateNotifyButtons() {
  const canAsk = "Notification" in window && Notification.permission !== "granted";
  $("notify-btn").hidden = !canAsk || !state.listLoaded || !state.requests.length;
  const status = state.openData?.request?.status;
  $("notify-btn-request").hidden = !canAsk || !(status === "new" || status === "working");
}

async function enableNotifications(ev) {
  const button = ev.currentTarget; // read before awaiting: currentTarget is cleared afterwards
  const result = await askNotificationPermission();
  if (result === "granted") toast(tx("notify.ok"), { ms: 5000 });
  else if (result === "denied") toast(tx("notify.denied"), { ms: 8000 });
  updateNotifyButtons();
  // If the button disappeared, keep keyboard focus somewhere sensible.
  if (button.hidden) $(`view-${state.view}`).querySelector("h1")?.focus({ preventScroll: true });
}

// ---------- home ----------

function openHome(focus) {
  leaveRequest();
  showView("home", { focus });
  renderList();
  updateNotifyButtons();
}

function renderList() {
  const host = $("request-list");
  if (!state.listLoaded) {
    if (!host.firstChild) {
      host.replaceChildren(
        el("div", { class: "list-loading", "aria-hidden": "true" },
          el("div", { class: "skeleton" }), el("div", { class: "skeleton" }), el("div", { class: "skeleton" })),
      );
    }
    return;
  }
  // Only rebuild when something visible changed, so keyboard focus isn't lost every poll.
  const signature = JSON.stringify([
    getLang(),
    state.requests.map((r) => [r.id, r.number, r.title, r.category, r.urgency, r.status, r.unread, r.updatedAt]),
  ]);
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature;

  const count = state.requests.length;
  $("list-count").textContent = count ? tx(count === 1 ? "list.count.one" : "list.count.other", { n: count }) : "";
  if (!count) {
    host.replaceChildren(
      el("div", { class: "empty" },
        el("p", { class: "empty-title" }, tx("list.empty.title")),
        el("p", { class: "hint" }, tx("list.empty.body"))),
    );
    return;
  }
  const focusedId = document.activeElement?.closest?.("[data-request-id]")?.getAttribute("data-request-id");
  host.replaceChildren(el("ul", { class: "rows" }, state.requests.map(requestRow)));
  if (focusedId) {
    for (const link of host.querySelectorAll("[data-request-id]")) {
      if (link.getAttribute("data-request-id") === focusedId) link.focus();
    }
  }
}

function requestRow(r) {
  const href = `?r=${encodeURIComponent(r.id)}`;
  return el("li", {},
    el("a", { class: r.unread ? "row is-unread" : "row", href, "data-route": href, "data-request-id": r.id },
      el("span", { class: "row-num num", "aria-hidden": "true" }, `#${r.number}`),
      el("span", { class: "row-main" },
        el("span", { class: "row-title" },
          spaced(
            el("span", { class: "sr-only" }, tx("a11y.number", { n: r.number })),
            r.title,
            r.unread && el("span", { class: "badge-new" }, tx("badge.new")),
          )),
        el("span", { class: "row-meta" },
          spaced(
            statusPill(r.status),
            el("span", { class: "tag" }, categoryLabel(r.category)),
            r.urgency && r.urgency !== "normal" && el("span", { class: "tag tag-urgent" }, urgencyLabel(r.urgency)),
            timeEl(r.updatedAt),
          )))));
}

// ---------- the form ----------

function openForm(focus) {
  leaveRequest();
  clearFormError("form-error");
  if (!$("f-name").value) $("f-name").value = myName();
  updateCounters();
  showView("form", { focus });
}

function selectedValue(name) {
  const checked = document.querySelector(`input[name="${name}"]:checked`);
  return checked ? checked.value : "";
}

function setSending(sending) {
  state.sending = sending;
  $("form-submit").disabled = sending;
  $("ask-form").setAttribute("aria-busy", String(sending));
  updateSubmitLabels();
}

async function submitForm(ev) {
  ev.preventDefault();
  if (state.sending) return;

  const nameEl = $("f-name");
  const titleEl = $("f-title");
  const textEl = $("f-text");
  const linksEl = $("f-links");
  const emailEl = $("f-email");

  const name = nameEl.value.trim();
  const category = selectedValue("category");
  const urgency = selectedValue("urgency");
  const title = titleEl.value.trim();
  const text = textEl.value.trim();
  const links = linksEl.value.trim();
  const contactEmail = emailEl.value.trim();

  let problem = null;
  if (!name) problem = [nameEl, tx("form.err.name")];
  else if (name.length > LIMITS.name) problem = [nameEl, tx("form.err.name.long", { max: LIMITS.name })];
  else if (!CATEGORIES.includes(category)) problem = [$("cat-tech"), tx("form.err.category")];
  else if (!URGENCIES.includes(urgency)) problem = [$("urg-normal"), tx("form.err.urgency")];
  else if (!title) problem = [titleEl, tx("form.err.subject")];
  else if (title.length > LIMITS.title)
    problem = [titleEl, tx("form.err.subject.long", { max: LIMITS.title, now: title.length })];
  else if (!text) problem = [textEl, tx("form.err.detail")];
  else if (text.length > LIMITS.text)
    problem = [textEl, tx("form.err.detail.long", { max: LIMITS.text, now: text.length })];
  else if (links.length > LIMITS.links) problem = [linksEl, tx("form.err.links.long", { max: LIMITS.links })];
  else if (contactEmail && contactEmail.length > LIMITS.email)
    problem = [emailEl, tx("form.err.email.long", { max: LIMITS.email })];
  else if (contactEmail && !EMAIL.test(contactEmail)) problem = [emailEl, tx("form.err.email")];
  if (problem) return showFormError("form-error", problem[1], problem[0]);

  clearFormError("form-error");
  setSending(true);
  try {
    // links and contactEmail are optional: only send them when they were filled in.
    const params = { family: state.token, who: state.who, name, category, urgency, title, text };
    if (links) params.links = links;
    if (contactEmail) params.contactEmail = contactEmail;
    const result = await call("create", params);
    store.set(NAME_KEY, name);
    resetForm();
    announce(tx("form.sent"));
    const id = result?.request?.id;
    // Replace the form entry so "back" goes to the list, not to an empty form.
    if (id) history.replaceState(null, "", `${location.pathname}?r=${encodeURIComponent(id)}`);
    else history.replaceState(null, "", location.pathname);
    route({ focus: true });
    state.poller?.refresh();
  } catch (err) {
    if (err?.code === "unauthorized") return signOut();
    showFormError("form-error", errorMessage(err, { sending: true }));
  } finally {
    setSending(false);
  }
}

function resetForm() {
  const form = $("ask-form");
  form.reset();
  for (const field of form.querySelectorAll("[aria-invalid]")) field.removeAttribute("aria-invalid");
  $("f-name").value = myName();
  clearFormError("form-error");
  updateCounters();
}

// ---------- one request ----------

function openRequest(id, focus) {
  if (state.openId !== id) {
    state.openId = id;
    state.openData = null;
    resetRequestView(id);
  }
  state.focusTitle = focus;
  showView("request");
  loadRequest(id);
}

function resetRequestView(id) {
  const listed = state.requests.find((r) => r.id === id);
  if (listed) {
    renderRequestHead(listed);
  } else {
    $("request-num").textContent = "";
    $("request-title").textContent = tx("req.loading");
    $("request-meta").replaceChildren();
  }
  $("messages").replaceChildren(
    el("li", { class: "skeleton", "aria-hidden": "true" }),
    el("li", { class: "skeleton", "aria-hidden": "true" }),
  );
  const status = $("request-status");
  status.replaceChildren();
  delete status.dataset.key;
  clearFormError("request-error");
  $("request-retry").hidden = true;
  $("done-row").hidden = true;
  $("done-note").hidden = true;
  $("notify-btn-request").hidden = true;

  // Keep a half-written follow-up only when it belongs to this same request.
  const followup = $("followup-form");
  followup.hidden = true;
  if (followup.dataset.requestId !== id) {
    followup.reset();
    followup.dataset.requestId = id;
    clearFormError("followup-error");
    updateCounters();
  }
}

async function loadRequest(id, { quiet = false } = {}) {
  const seq = ++state.seq;
  let data;
  try {
    data = await call("request", { family: state.token, who: state.who, id });
  } catch (err) {
    if (seq !== state.seq || state.openId !== id) return;
    if (err.code === "unauthorized") return signOut();
    if (err.code === "not_found") return renderMissing();
    if (!quiet || !state.openData) {
      $("messages").replaceChildren();
      showFormError("request-error", errorMessage(err));
      $("request-retry").hidden = false;
    }
    return;
  }
  if (seq !== state.seq || state.openId !== id) return;
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const shown = await renderRequest(data.request, messages, seq);
  if (!shown) return;

  // Opening it marked it as read on the server; mirror that locally.
  const listed = state.requests.find((r) => r.id === id);
  if (listed) listed.unread = false;
  updateBadge();
  if (state.focusTitle) {
    state.focusTitle = false;
    $("request-title").focus({ preventScroll: true });
  }
}

// Reload the open request when the list shows it changed (only while it is on screen,
// because loading it marks the answer as read).
function syncOpenRequest() {
  const open = state.openData?.request;
  if (!state.openId || !open || document.visibilityState !== "visible") return;
  const listed = state.requests.find((r) => r.id === state.openId);
  if (!listed) return;
  if (listed.status !== open.status || Number(listed.messageCount) !== Number(open.messageCount)) {
    loadRequest(state.openId, { quiet: true });
  }
}

async function renderRequest(request, messages, seq) {
  if (!request) return false;
  let items;
  try {
    items = await Promise.all(messages.map(messageItem));
  } catch {
    items = messages.map((m) => el("li", { class: "msg msg-alon" }, el("p", { class: "plain" }, m.text || "")));
  }
  if (seq !== state.seq || state.openId !== request.id) return false;

  const messageCount = typeof request.messageCount === "number" ? request.messageCount : messages.length;
  state.openData = { request: { ...request, messageCount }, messages };
  renderRequestHead(request);
  $("messages").replaceChildren(...items);
  clearFormError("request-error");
  $("request-retry").hidden = true;
  renderRequestStatus(request);

  const closed = request.status === "closed";
  $("done-row").hidden = closed;
  $("done-note").hidden = !closed;
  $("followup-title").textContent = closed
    ? tx("req.followup.title.closed")
    : request.status === "answered"
      ? tx("req.followup.title.answered")
      : tx("req.followup.title");
  $("followup-form").hidden = false;
  updateNotifyButtons();
  return true;
}

function renderRequestHead(r) {
  $("request-num").textContent = tx("req.eyebrow", { n: r.number });
  $("request-title").textContent = r.title || "";
  $("request-meta").replaceChildren(
    ...spaced(
      statusPill(r.status),
      el("span", { class: "tag" }, categoryLabel(r.category)),
      r.urgency && r.urgency !== "normal" && el("span", { class: "tag tag-urgent" }, urgencyLabel(r.urgency)),
      r.createdAt && timeEl(r.createdAt),
    ),
  );
}

function renderMissing() {
  state.openData = null;
  $("request-num").textContent = "";
  $("request-title").textContent = tx("req.missing.title");
  $("request-meta").replaceChildren();
  $("messages").replaceChildren();
  $("request-status").replaceChildren();
  $("done-row").hidden = true;
  $("done-note").hidden = true;
  $("followup-form").hidden = true;
  $("notify-btn-request").hidden = true;
  $("request-retry").hidden = true;
  showFormError("request-error", tx("req.missing.body"));
}

async function messageItem(m) {
  const fromOwner = m.from === "alon";
  const who = fromOwner ? "alon" : "family";
  const name = fromOwner ? ownerName() : tx("req.you");
  const badge = initial(fromOwner ? ownerName() : myName() || name);

  const body = el("div", { class: "msg-body" });
  if (fromOwner) {
    // Only the owner's replies are markdown, and renderMarkdown sanitizes them.
    body.append(el("div", { class: "md" }, await renderMarkdown(m.text || "")));
  } else if (m.text) {
    body.append(el("p", { class: "plain" }, m.text));
  }

  return el("li", { class: `msg msg-${who}` },
    el("div", { class: "msg-head" },
      spaced(
        el("span", { class: `avatar avatar-${who}`, "aria-hidden": "true" }, badge),
        el("span", { class: "msg-author" }, name),
        timeEl(m.createdAt),
      )),
    body);
}

// Live region under the conversation: a calm line about what happens next.
function renderRequestStatus(request) {
  const box = $("request-status");
  const key = `${request.status}:${getLang()}`;
  if (box.dataset.key === key) return; // unchanged, don't announce it again
  box.dataset.key = key;
  box.classList.toggle("is-working", request.status === "working");
  if (request.status === "new") box.replaceChildren(el("span", {}, tx("req.note.new")));
  else if (request.status === "working") {
    box.replaceChildren(
      el("span", { class: "dots", "aria-hidden": "true" }, el("span"), el("span"), el("span")),
      el("span", {}, tx("req.note.working")),
    );
  } else box.replaceChildren();
}

async function submitFollowup(ev) {
  ev.preventDefault();
  if (state.replying || !state.openId) return;
  const id = state.openId;
  const textEl = $("r-text");
  const text = textEl.value.trim();

  if (!text) return showFormError("followup-error", tx("req.followup.err.empty"), textEl);
  if (text.length > LIMITS.text) {
    return showFormError(
      "followup-error",
      tx("req.followup.err.long", { max: LIMITS.text, now: text.length }),
      textEl,
    );
  }

  clearFormError("followup-error");
  state.replying = true;
  $("followup-submit").disabled = true;
  updateSubmitLabels();
  try {
    await call("send", { family: state.token, who: state.who, id, text });
    const form = $("followup-form");
    form.reset();
    for (const field of form.querySelectorAll("[aria-invalid]")) field.removeAttribute("aria-invalid");
    updateCounters();
    announce(tx("req.followup.sent"));
    if (state.openId === id) await loadRequest(id, { quiet: true });
    state.poller?.refresh();
  } catch (err) {
    if (err?.code === "unauthorized") return signOut();
    showFormError("followup-error", errorMessage(err, { sending: true }));
  } finally {
    state.replying = false;
    $("followup-submit").disabled = false;
    updateSubmitLabels();
  }
}

async function markAsDone() {
  const id = state.openId;
  if (!id) return;
  const button = $("done-btn");
  button.disabled = true;
  try {
    await call("close", { family: state.token, who: state.who, id });
    await loadRequest(id, { quiet: true });
    toast(tx("req.done.toast"));
    if (!$("done-note").hidden) $("done-note").focus();
    state.poller?.refresh();
  } catch (err) {
    if (err?.code === "unauthorized") return signOut();
    toast(errorMessage(err), { tone: "error", ms: 6000 });
  } finally {
    button.disabled = false;
  }
}

// ---------- wiring ----------

function bindEvents() {
  document.addEventListener("click", onRouteClick);
  window.addEventListener("popstate", () => route({ focus: true }));
  window.addEventListener("hashchange", onHashChange);
  document.addEventListener("visibilitychange", updateBadge);

  for (const button of document.querySelectorAll("[data-lang]")) {
    button.addEventListener("click", () => chooseLang(button.dataset.lang));
  }

  $("retry-btn").addEventListener("click", () => connect({ fromRetry: true }));
  $("copy-code").addEventListener("click", copyMyCode);
  $("code-form").addEventListener("submit", useCode);
  $("f-code").addEventListener("input", (ev) => {
    ev.target.removeAttribute("aria-invalid");
    clearFormError("code-error");
  });

  const form = $("ask-form");
  form.addEventListener("submit", submitForm);
  form.addEventListener("input", (ev) => {
    if (ev.target.getAttribute?.("aria-invalid")) {
      ev.target.removeAttribute("aria-invalid");
      clearFormError("form-error");
    }
    updateCounters();
  });
  // Picking a category or an urgency clears the red marks left by a failed submit,
  // including the one on a radio button other than the one they just chose.
  form.addEventListener("change", () => {
    for (const field of form.querySelectorAll("[aria-invalid]")) field.removeAttribute("aria-invalid");
    clearFormError("form-error");
  });

  const followup = $("followup-form");
  followup.addEventListener("submit", submitFollowup);
  followup.addEventListener("input", (ev) => {
    if (ev.target.getAttribute?.("aria-invalid")) {
      ev.target.removeAttribute("aria-invalid");
      clearFormError("followup-error");
    }
    updateCounters();
  });

  $("done-btn").addEventListener("click", markAsDone);
  $("request-retry").addEventListener("click", () => {
    if (state.openId) loadRequest(state.openId);
  });
  for (const button of document.querySelectorAll(".js-notify")) button.addEventListener("click", enableNotifications);
}

bindEvents();
start();
