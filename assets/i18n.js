// Every visible string of the family site, in Spanish and English.
//
// Spanish is neutral Latin American Spanish with "tú", written for family members who are
// not technical. English is written the same way, not as a literal translation.
// Nothing here is a template for the backend: these are only the words on the screen.
//
// Language order: an explicit choice (localStorage "ask.lang") wins, then the browser
// language, then `info.defaultLang` from the backend (see setDefaultLang), then Spanish.

import { store } from "./ui.js";

const LANG_KEY = "ask.lang";

export const LANGS = ["es", "en"];

export const STRINGS = {
  es: {
    // ---------- chrome ----------
    "site.name": "Ask Alonso Bryan",
    "a11y.skip": "Ir al contenido",
    "nav.lang.legend": "Idioma",
    "nav.lang.es": "Español",
    "nav.lang.en": "Inglés",
    "conn.offline": "Parece que no hay conexión. Lo seguimos intentando.",
    "loading": "Cargando…",
    "foot.note": "Lo que escribes aquí solo lo ve {owner}.",

    // ---------- full-page screens ----------
    "nolink.title": "Necesitas el enlace de {owner}",
    "nolink.body":
      "Para usar esta página tienes que abrir el enlace que {owner} te mandó por mensaje o por correo. " +
      "Es un enlace largo que te trae directo aquí.",
    "nolink.hint":
      "Si ya lo abriste antes en este teléfono, búscalo en el mismo mensaje y ábrelo otra vez. " +
      "Después este navegador lo recuerda.",

    "notconfigured.title": "El sitio todavía no está listo",
    "notconfigured.body":
      "Esta página ya existe, pero falta conectarla con el lugar donde se guardan las solicitudes. " +
      "Es un último paso que hace {owner}.",
    "notconfigured.hint": "Vuelve a intentarlo más tarde.",

    "error.title": "No pudimos conectar",
    "error.retry": "Reintentar",

    // ---------- home ----------
    "home.title": "Ask Alonso Bryan",
    "home.lede": "Cuéntale a {owner} lo que necesitas. La respuesta aparece aquí mismo.",
    "home.ask.title": "Pedir ayuda",
    "home.ask.sub": "Escribe qué necesitas. Toma un par de minutos.",
    "home.learn.title": "¿Quieres aprender tú?",
    "home.learn.lede": "Una guía gratis de 6 semanas para aprender Power BI y Python desde cero, con un tutor de IA.",
    "home.learn.link": "Abrir la guía",
    "home.list.title": "Mis solicitudes",
    "list.count.one": "{n} solicitud",
    "list.count.other": "{n} solicitudes",
    "list.empty.title": "Aquí van a aparecer tus solicitudes",
    "list.empty.body":
      "Todavía no has pedido nada. Cuando lo hagas, vas a poder ver la respuesta desde esta misma página.",
    "badge.new": "Nueva respuesta",

    "code.note":
      "Esta lista se guarda solo en este navegador y solo tú la ves. Si cambias de teléfono o borras los datos " +
      "del navegador, guarda antes tu código.",
    "code.copy": "Copiar mi código",
    "code.copied": "Código copiado. Guárdalo en un mensaje para ti.",
    "code.copyfail": "No pudimos copiarlo. Este es tu código: {code}",
    "code.have.summary": "Tengo un código",
    "code.have.hint":
      "¿Ya pediste ayuda desde otro teléfono o navegador? Pega aquí tu código para volver a ver esas solicitudes.",
    "code.have.label": "Tu código",
    "code.have.button": "Usar este código",
    "code.have.bad": "Ese código no parece correcto: son 32 letras (de la a a la f) y números, sin espacios.",
    "code.have.same": "Ese ya es tu código. No hay nada que cambiar.",
    "code.have.ok": "Listo. Estas son las solicitudes de ese código.",

    "notify.button": "Avisarme cuando haya respuesta",
    "notify.ok": "Listo. Te avisamos aunque estés en otra pestaña.",
    "notify.denied":
      "Tu navegador tiene los avisos bloqueados. Puedes permitirlos desde el candado que está junto a la dirección.",

    // ---------- form ----------
    "form.title": "Pedir ayuda",
    "form.back": "Volver",
    "form.optional": "(opcional)",

    "form.name.label": "¿Cómo te llamas?",
    "form.name.hint": "Para que {owner} sepa quién escribe. Lo recordamos para la próxima vez.",

    "form.category.legend": "¿Con qué necesitas ayuda?",
    "cat.tech.title": "La computadora o el celular",
    "cat.tech.sub": "Algo no funciona, va lento o no sabes cómo hacerlo.",
    "cat.docs.title": "Un trámite o un documento",
    "cat.docs.sub": "Llenar un formulario, una carta, una cita, un papel oficial.",
    "cat.school.title": "Tarea o algo de la escuela",
    "cat.school.sub": "Un trabajo, un proyecto, una presentación.",
    "cat.data.title": "Números o una hoja de cálculo",
    "cat.data.sub": "Excel, cuentas, una lista que no cuadra.",
    "cat.money.title": "Dinero o cuentas",
    "cat.money.sub": "Un cobro, un banco, una suscripción, un pago.",
    "cat.other.title": "Otra cosa",
    "cat.other.sub": "Si no sabes cuál elegir, elige esta.",

    "form.urgency.legend": "¿Para cuándo lo necesitas?",
    "urg.normal.title": "Normal",
    "urg.normal.sub": "No tengo prisa.",
    "urg.soon.title": "Esta semana",
    "urg.soon.sub": "Lo necesito en unos días.",
    "urg.urgent.title": "Urgente",
    "urg.urgent.sub": "Lo necesito hoy o mañana.",

    "form.subject.label": "¿De qué se trata?",
    "form.subject.hint": "Una frase corta. Por ejemplo: «No puedo imprimir» o «Ayuda con el formulario de la escuela».",
    "form.detail.label": "Cuéntalo con más detalle",
    "form.detail.hint":
      "¿Qué querías hacer? ¿Qué pasó? ¿Qué ya intentaste? Entre más cuentes, mejor te pueden ayudar.",
    "form.links.label": "Enlaces",
    "form.links.hint": "Si hay una página, un formulario o un archivo en internet, pega aquí la dirección.",
    "form.links.ph": "https://…",
    "form.email.label": "Tu correo",
    "form.email.hint": "Solo se usa para avisarte cuando haya respuesta. Para nada más.",

    "form.privacy":
      "Cuida tus datos: no escribas contraseñas, números de tarjeta ni números de identificación. Aquí nunca hacen falta.",
    "form.expect": "{owner} lee cada solicitud y te responde en persona, normalmente en menos de un día.",
    "form.submit": "Enviar solicitud",
    "form.sending": "Enviando…",
    "form.cancel": "Cancelar",
    "form.sent": "Solicitud enviada.",

    "form.err.name": "Escribe tu nombre.",
    "form.err.name.long": "El nombre es muy largo: máximo {max} caracteres.",
    "form.err.category": "Elige con qué necesitas ayuda. Si no sabes cuál, elige «Otra cosa».",
    "form.err.urgency": "Elige para cuándo lo necesitas.",
    "form.err.subject": "Escribe una frase corta sobre lo que necesitas.",
    "form.err.subject.long": "Esa frase es muy larga: máximo {max} caracteres (ahora tiene {now}).",
    "form.err.detail": "Cuenta un poco más de lo que pasa.",
    "form.err.detail.long": "Es muy largo: máximo {max} caracteres (ahora tiene {now}). Puedes enviarlo en dos partes.",
    "form.err.links.long": "Los enlaces son muy largos: máximo {max} caracteres.",
    "form.err.email": "Ese correo no parece correcto. Revísalo o déjalo vacío.",
    "form.err.email.long": "Ese correo es muy largo: máximo {max} caracteres.",

    // ---------- one request ----------
    "req.eyebrow": "Solicitud #{n}",
    "req.back": "Mis solicitudes",
    "req.you": "Tú",
    "req.loading": "Cargando…",
    "a11y.conversation": "Conversación",
    "a11y.number": "Número {n}.",
    "a11y.characters": " caracteres",

    "status.new": "Recibido",
    "status.working": "En proceso",
    "status.answered": "Respondido",
    "status.closed": "Cerrado",

    "req.note.new": "Recibido. {owner} lo va a leer y te responde por aquí. Puedes cerrar la página: no se pierde.",
    "req.note.working": "{owner} ya lo está viendo. La respuesta aparece aquí.",

    "req.followup.title": "¿Quieres agregar algo?",
    "req.followup.title.answered": "¿Tienes otra duda sobre esto?",
    "req.followup.title.closed": "¿Necesitas retomarlo?",
    "req.followup.label": "Tu mensaje",
    "req.followup.hint": "Sin contraseñas ni números de tarjeta.",
    "req.followup.send": "Enviar",
    "req.followup.sending": "Enviando…",
    "req.followup.sent": "Mensaje enviado.",
    "req.followup.err.empty": "Escribe tu mensaje antes de enviarlo.",
    "req.followup.err.long": "El mensaje es muy largo: máximo {max} caracteres (ahora tiene {now}).",

    "req.done.prompt": "¿Ya quedó resuelto?",
    "req.done.button": "Ya está resuelto",
    "req.done.note": "Marcaste esta solicitud como resuelta. Si escribes de nuevo, se vuelve a abrir.",
    "req.done.toast": "Listo. La marcamos como resuelta.",

    "req.missing.title": "No encontramos esta solicitud",
    "req.missing.body": "Puede que se haya borrado, o que sea de otro código. Vuelve a «Mis solicitudes».",

    // ---------- new answers ----------
    "news.one": "{owner} respondió tu solicitud #{n}: {title}",
    "news.many": "Tienes {n} respuestas nuevas.",
    "news.notify.one": "{owner} te respondió",
    "news.notify.many": "Tienes respuestas nuevas",

    // ---------- errors from the server ----------
    "err.rate_limited": "Enviaste muchos mensajes en poco tiempo. Espera un rato y vuelve a intentarlo.",
    "err.network": "No pudimos conectar. Revisa tu internet y vuelve a intentarlo.",
    "err.timeout": "El sitio tardó demasiado en responder. Espera un momento y vuelve a intentarlo.",
    "err.timeout.sending":
      "El sitio tardó demasiado en responder. Puede que sí se haya enviado: revisa «Mis solicitudes» antes de mandarlo otra vez.",
    "err.unauthorized": "Tu enlace ya no funciona. Pídele a {owner} el enlace nuevo.",
    "err.bad_request": "Revisa lo que escribiste: puede que falte algo o que sea demasiado largo.",
    "err.not_found": "No encontramos esta solicitud.",
    "err.not_configured": "El sitio todavía no está conectado del todo. Avísale a {owner}.",
    "err.default": "Algo salió mal. Vuelve a intentarlo en un momento.",
  },

  en: {
    // ---------- chrome ----------
    "site.name": "Ask Alonso Bryan",
    "a11y.skip": "Skip to content",
    "nav.lang.legend": "Language",
    "nav.lang.es": "Spanish",
    "nav.lang.en": "English",
    "conn.offline": "Looks like there is no connection. We will keep trying.",
    "loading": "Loading…",
    "foot.note": "Only {owner} sees what you write here.",

    // ---------- full-page screens ----------
    "nolink.title": "You need {owner}'s link",
    "nolink.body":
      "To use this page, open the link {owner} sent you by message or email. " +
      "It is a long link that brings you straight here.",
    "nolink.hint":
      "If you have opened it before on this phone, find it in that same message and open it again. " +
      "After that, this browser remembers it.",

    "notconfigured.title": "The site is not ready yet",
    "notconfigured.body":
      "This page exists, but it still has to be connected to the place where requests are saved. " +
      "That is one last step for {owner}.",
    "notconfigured.hint": "Try again later.",

    "error.title": "We could not connect",
    "error.retry": "Try again",

    // ---------- home ----------
    "home.title": "Ask Alonso Bryan",
    "home.lede": "Tell {owner} what you need. The answer shows up right here.",
    "home.ask.title": "Ask for help",
    "home.ask.sub": "Write what you need. It takes a couple of minutes.",
    "home.learn.title": "Want to learn it yourself?",
    "home.learn.lede": "A free 6-week guide to learning Power BI and Python from scratch, with an AI tutor.",
    "home.learn.link": "Open the guide",
    "home.list.title": "My requests",
    "list.count.one": "{n} request",
    "list.count.other": "{n} requests",
    "list.empty.title": "Your requests will show up here",
    "list.empty.body": "You have not asked for anything yet. Once you do, you can read the answer on this same page.",
    "badge.new": "New answer",

    "code.note":
      "This list is saved only in this browser, and only you can see it. If you change phones or clear your " +
      "browser data, save your code first.",
    "code.copy": "Copy my code",
    "code.copied": "Code copied. Keep it somewhere you will find it again.",
    "code.copyfail": "We could not copy it. Here is your code: {code}",
    "code.have.summary": "I have a code",
    "code.have.hint":
      "Did you already ask for help from another phone or browser? Paste your code here to see those requests again.",
    "code.have.label": "Your code",
    "code.have.button": "Use this code",
    "code.have.bad": "That code does not look right: it is 32 letters (a to f) and numbers, with no spaces.",
    "code.have.same": "That is already your code. Nothing to change.",
    "code.have.ok": "Done. These are the requests for that code.",

    "notify.button": "Let me know when there is an answer",
    "notify.ok": "Done. We will let you know even if you are in another tab.",
    "notify.denied":
      "Your browser has notifications blocked. You can allow them from the lock icon next to the address.",

    // ---------- form ----------
    "form.title": "Ask for help",
    "form.back": "Back",
    "form.optional": "(optional)",

    "form.name.label": "What is your name?",
    "form.name.hint": "So {owner} knows who is writing. We will remember it for next time.",

    "form.category.legend": "What do you need help with?",
    "cat.tech.title": "The computer or the phone",
    "cat.tech.sub": "Something is not working, it is slow, or you do not know how to do it.",
    "cat.docs.title": "A form or a document",
    "cat.docs.sub": "Filling something out, a letter, an appointment, official paperwork.",
    "cat.school.title": "Homework or school",
    "cat.school.sub": "An assignment, a project, a presentation.",
    "cat.data.title": "Numbers or a spreadsheet",
    "cat.data.sub": "Excel, totals, a list that does not add up.",
    "cat.money.title": "Money or accounts",
    "cat.money.sub": "A charge, a bank, a subscription, a payment.",
    "cat.other.title": "Something else",
    "cat.other.sub": "If you are not sure which one, pick this one.",

    "form.urgency.legend": "When do you need it?",
    "urg.normal.title": "Normal",
    "urg.normal.sub": "I am not in a hurry.",
    "urg.soon.title": "This week",
    "urg.soon.sub": "I need it in a few days.",
    "urg.urgent.title": "Urgent",
    "urg.urgent.sub": "I need it today or tomorrow.",

    "form.subject.label": "What is it about?",
    "form.subject.hint": "One short line. For example: “I cannot print” or “Help with the school form”.",
    "form.detail.label": "Tell it in more detail",
    "form.detail.hint":
      "What were you trying to do? What happened? What have you already tried? The more you tell, the better the help.",
    "form.links.label": "Links",
    "form.links.hint": "If there is a web page, a form or a file online, paste the address here.",
    "form.links.ph": "https://…",
    "form.email.label": "Your email",
    "form.email.hint": "Only used to let you know when there is an answer. Nothing else.",

    "form.privacy":
      "Keep your data safe: do not write passwords, card numbers or ID numbers. They are never needed here.",
    "form.expect": "{owner} reads every request and answers you personally, usually within a day.",
    "form.submit": "Send request",
    "form.sending": "Sending…",
    "form.cancel": "Cancel",
    "form.sent": "Request sent.",

    "form.err.name": "Write your name.",
    "form.err.name.long": "That name is too long: {max} characters at most.",
    "form.err.category": "Choose what you need help with. If you are not sure, pick “Something else”.",
    "form.err.urgency": "Choose when you need it.",
    "form.err.subject": "Write one short line about what you need.",
    "form.err.subject.long": "That line is too long: {max} characters at most (right now it has {now}).",
    "form.err.detail": "Tell us a bit more about it.",
    "form.err.detail.long":
      "That is too long: {max} characters at most (right now it has {now}). You can send it in two parts.",
    "form.err.links.long": "The links are too long: {max} characters at most.",
    "form.err.email": "That email does not look right. Check it or leave it empty.",
    "form.err.email.long": "That email is too long: {max} characters at most.",

    // ---------- one request ----------
    "req.eyebrow": "Request #{n}",
    "req.back": "My requests",
    "req.you": "You",
    "req.loading": "Loading…",
    "a11y.conversation": "Conversation",
    "a11y.number": "Number {n}.",
    "a11y.characters": " characters",

    "status.new": "Received",
    "status.working": "In progress",
    "status.answered": "Answered",
    "status.closed": "Closed",

    "req.note.new": "Received. {owner} will read it and answer here. You can close the page — nothing is lost.",
    "req.note.working": "{owner} is looking at it. The answer will show up here.",

    "req.followup.title": "Want to add something?",
    "req.followup.title.answered": "Any other questions about this?",
    "req.followup.title.closed": "Need to pick this up again?",
    "req.followup.label": "Your message",
    "req.followup.hint": "No passwords, no card numbers.",
    "req.followup.send": "Send",
    "req.followup.sending": "Sending…",
    "req.followup.sent": "Message sent.",
    "req.followup.err.empty": "Write your message before sending it.",
    "req.followup.err.long": "That message is too long: {max} characters at most (right now it has {now}).",

    "req.done.prompt": "All taken care of?",
    "req.done.button": "Mark as done",
    "req.done.note": "You marked this request as done. If you write again, it opens back up.",
    "req.done.toast": "Done. We marked it as taken care of.",

    "req.missing.title": "We could not find this request",
    "req.missing.body": "It may have been deleted, or it belongs to another code. Go back to “My requests”.",

    // ---------- new answers ----------
    "news.one": "{owner} answered your request #{n}: {title}",
    "news.many": "You have {n} new answers.",
    "news.notify.one": "{owner} answered you",
    "news.notify.many": "You have new answers",

    // ---------- errors from the server ----------
    "err.rate_limited": "You sent a lot of messages in a short time. Wait a while and try again.",
    "err.network": "We could not connect. Check your internet and try again.",
    "err.timeout": "The site took too long to answer. Wait a moment and try again.",
    "err.timeout.sending":
      "The site took too long to answer. It may have gone through anyway: check “My requests” before sending it again.",
    "err.unauthorized": "Your link does not work any more. Ask {owner} for the new one.",
    "err.bad_request": "Check what you wrote: something may be missing, or too long.",
    "err.not_found": "We could not find this request.",
    "err.not_configured": "The site is not fully connected yet. Let {owner} know.",
    "err.default": "Something went wrong. Try again in a moment.",
  },
};

// ---------- language choice ----------

function normalize(value) {
  const code = String(value || "").trim().slice(0, 2).toLowerCase();
  return LANGS.includes(code) ? code : null;
}

function fromBrowser() {
  try {
    const list = Array.isArray(navigator.languages) && navigator.languages.length
      ? navigator.languages
      : [navigator.language];
    for (const item of list) {
      const code = normalize(item);
      if (code) return code;
    }
  } catch {}
  return null;
}

let chosen = normalize(store.get(LANG_KEY)); // what this person picked, remembered
const detected = fromBrowser();
let backendDefault = "es"; // replaced by info.defaultLang

// The language the page should be in right now.
export function getLang() {
  return chosen || detected || backendDefault;
}

// True when this person picked a language themselves (so the backend default must not win).
export function hasChosenLang() {
  return chosen !== null;
}

// Remembers an explicit choice.
export function setLang(lang) {
  const code = normalize(lang);
  if (!code) return getLang();
  chosen = code;
  store.set(LANG_KEY, code);
  return code;
}

// The backend's `defaultLang`: only used when nothing else decided.
export function setDefaultLang(lang) {
  const code = normalize(lang);
  if (code) backendDefault = code;
  return getLang();
}

// t("nolink.title", {owner: "Alonso Bryan"}) — "{name}" placeholders are filled from vars.
// An unknown key returns the key itself, so a missing string is visible during development
// instead of silently rendering an empty box.
export function t(key, vars) {
  const lang = getLang();
  const table = STRINGS[lang] || STRINGS.es;
  let value = null;
  if (Object.hasOwn(table, key)) value = table[key];
  else if (Object.hasOwn(STRINGS.es, key)) value = STRINGS.es[key];
  else if (Object.hasOwn(STRINGS.en, key)) value = STRINGS.en[key];
  if (value === null || value === undefined) return String(key);
  return String(value).replace(/\{(\w+)\}/g, (match, name) => {
    const replacement = vars && Object.hasOwn(vars, name) ? vars[name] : undefined;
    return replacement === undefined || replacement === null ? "" : String(replacement);
  });
}
