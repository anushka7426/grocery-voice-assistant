import { Scanner } from "./scanner.js";
import { lookup, saveCustom, allKnown } from "./lookup.js";
import { summary, answer, parseIntent } from "./describe.js";
import { speak, stopSpeaking, beep, buzz, bindLive, getSettings, setRate, setScreenReaderMode } from "./speech.js";
import { isIndian } from "./gtin.js";

const $ = (id) => document.getElementById(id);
const status = $("status");
const video = $("video");

let scanner = null;
let current = null;          // { code, product } of the last product we identified
let lastMiss = null;         // barcode that wasn't found (for "teach")
let recent = { code: "", t: 0 };
let hintTimers = [];
let busy = false;

bindLive($("transcript"));
const setStatus = (t) => { status.textContent = t; };
const digits = (c) => c.split("").join(" ");

// ------------------------------------------------------------ guidance
function clearHints() { hintTimers.forEach(clearTimeout); hintTimers = []; }
function armHints() {
  clearHints();
  hintTimers.push(setTimeout(() => {
    speak("Still looking. Slowly turn the pack. The barcode is usually on the back or the bottom. Hold it about 20 centimetres from the camera.");
  }, 9000));
  hintTimers.push(setTimeout(() => {
    speak("I can't find a barcode. Say or tap read label to hear the printed text instead.");
    armHintsLater();
  }, 24000));
}
function armHintsLater() { hintTimers.push(setTimeout(armHints, 20000)); }

// ------------------------------------------------------------ main flow
async function start() {
  $("start").hidden = true;
  $("main").hidden = false;
  beep("tick");
  await speak("Starting the camera.");
  scanner = new Scanner(video, {
    onLock: handleCode,
    onLight: () => speak("It is dark, so I turned the light on.", { append: true }),
  });
  try {
    await scanner.start();
  } catch (e) {
    const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
    const msg = denied
      ? "I need camera permission. Please allow the camera for this website in your browser settings, then tap Retry."
      : "I could not start the camera. Please close other apps that use the camera, then tap Retry.";
    setStatus(msg); $("retry").hidden = false; speak(msg);
    return;
  }
  $("retry").hidden = true;
  setStatus("Scanning. Point the back of the pack at the camera.");
  keepAwake();
  await speak("Ready. Point the barcode at the camera and hold steady. Say or tap read label if there is no barcode.");
  armHints();
  setTimeout(() => import("./ocr.js").then((m) => navigator.onLine && m.warmUp()), 4000);
}

async function handleCode(code) {
  const now = Date.now();
  if (code === recent.code && now - recent.t < 8000) { scanner.resume(); return; } // same pack still in view
  recent = { code, t: now };
  busy = true; clearHints();
  beep("ok"); buzz(120);
  setStatus(`Barcode ${code}. Looking up…`);
  speak("Got it. Looking up.");
  const res = await lookup(code);
  if (res.status === "found") {
    current = { code, product: res.product };
    lastMiss = null;
    const text = summary(res.product);
    setStatus(`${res.product.name} — ${res.product.source}`);
    $("followups").hidden = false; $("teach").hidden = true;
    await speak(text);
  } else {
    lastMiss = code;
    $("teach").hidden = false;
    const india = isIndian(code) ? "It is an Indian barcode. " : "";
    const brand = res.hint ? `The maker prefix suggests ${res.hint}, but I can't be sure of the product. ` : "";
    const why = res.status === "offline"
      ? "There is no internet and this product is not saved on the phone. "
      : "This product is not in my database. ";
    const msg = `Barcode ${digits(code)}. ${india}${why}${brand}Say or tap read label to read the printed text, or teach this product.`;
    setStatus(`Barcode ${code} not found.`);
    beep("fail"); buzz([80, 60, 80]);
    await speak(msg);
  }
  busy = false;
  scanner.resume();          // hands-free: keep scanning for the next item
  armHints();
}

async function readLabel() {
  if (!scanner || busy) return;
  busy = true; clearHints(); scanner.pause();
  setStatus("Reading the label. Hold steady.");
  await speak("Reading the label. Hold steady.");
  try {
    const ocr = await import("./ocr.js");
    const shot = scanner.snapshot();
    const { text } = await ocr.readLabel(shot);
    if (!text.trim()) {
      beep("fail");
      await speak("I could not read any text. Try more light, hold the front of the pack steady, and try again.");
    } else {
      const f = ocr.extractFacts(text);
      const parts = [];
      if (f.mrp) parts.push(`M R P ${f.mrp} rupees`);
      if (f.net) parts.push(`Net quantity ${f.net}`);
      if (f.bestBefore) parts.push(f.bestBefore);
      const guess = ocr.matchKnown(text, await allKnown());
      if (guess) parts.push(`The text looks like ${guess.brand ? guess.brand + " " : ""}${guess.name}. This is only a guess, please confirm`);
      const body = text.replace(/\n/g, ". ").slice(0, 450);
      beep("ok");
      setStatus("Label text read.");
      $("transcript").dataset.ocr = text;
      await speak(`${parts.length ? parts.join(". ") + ". " : ""}Text I could read: ${body}. Text reading can make mistakes.`);
    }
  } catch {
    await speak("The text reader is not available right now. Please try again when you have a signal.");
  }
  busy = false;
  scanner.resume();
  armHints();
}

// ------------------------------------------------------------ follow-ups
async function ask(intent) {
  if (!current) { await speak("Scan a product first."); return; }
  const a = answer(intent, current.product);
  if (a) await speak(a);
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
function listen(onText) {
  stopSpeaking(); scanner?.pause();
  const r = new SR();
  r.lang = "en-IN"; r.interimResults = false; r.maxAlternatives = 3;
  let got = false;
  beep("tick");
  r.onresult = (e) => { got = true; onText(Array.from(e.results[0]).map((x) => x.transcript)); };
  r.onerror = () => { got = true; speak("I could not hear you. Please try again."); };
  r.onend = () => { if (!got) speak("I did not hear anything."); scanner?.resume(); };
  r.start();
}
function askByVoice() {
  if (!SR) { speak("Voice questions are not supported in this browser. Use the buttons."); return; }
  listen(async (alts) => {
    const said = alts[0];
    if (/read (the )?label|read text/i.test(said)) { readLabel(); return; }
    if (/scan|next/i.test(said)) { scanner.resume(); return speak("Scanning."); }
    const intent = alts.map(parseIntent).find(Boolean);
    if (intent) await ask(intent);
    else await speak(`I heard ${said}. You can ask about ingredients, allergens, nutrition, vegetarian, size, or say read label.`);
  });
}

// ------------------------------------------------------------ teach a product
function teach() {
  if (!lastMiss) { speak("There is no unknown product to save. Scan one first."); return; }
  scanner.pause(); clearHints();
  $("teachCode").textContent = lastMiss;
  $("dlg").showModal();
  $("teachName").focus();
  speak("Type or say the product name. A sighted helper can also fill this in.");
}
$("dictate").onclick = () => {
  if (!SR) return speak("Dictation is not supported here. Please type the name.");
  stopSpeaking();
  const r = new SR(); r.lang = "en-IN";
  r.onresult = (e) => { $("teachName").value = e.results[0][0].transcript; };
  r.start();
};
$("teachForm").onsubmit = async (e) => {
  const name = $("teachName").value.trim();
  if (e.submitter?.value === "cancel" || !name) { $("dlg").close(); scanner.resume(); return; }
  e.preventDefault();
  await saveCustom(lastMiss, {
    name, brand: $("teachBrand").value.trim(), quantity: $("teachQty").value.trim(),
    ingredients: "", allergens: null, nutrition: null, diet: "unknown",
  });
  current = { code: lastMiss, product: { name, brand: $("teachBrand").value.trim(), quantity: $("teachQty").value.trim(), allergens: null, nutrition: null, diet: "unknown", source: "saved on this phone" } };
  $("dlg").close(); $("teachForm").reset(); $("teach").hidden = true; lastMiss = null;
  await speak(`Saved ${name}. I will recognise it next time, even without internet.`);
  scanner.resume(); armHints();
};

// ------------------------------------------------------------ misc controls
async function keepAwake() {
  try { await navigator.wakeLock?.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && scanner?.stream) keepAwake();
});

$("go").onclick = start;
$("retry").onclick = start;
$("again").onclick = () => { scanner.resume(); busy = false; speak("Scanning."); armHints(); };
$("repeat").onclick = () => ask("repeat");
$("ing").onclick = () => ask("ingredients");
$("all").onclick = () => ask("allergens");
$("nut").onclick = () => ask("nutrition");
$("veg").onclick = () => ask("diet");
$("label").onclick = readLabel;
$("mic").onclick = askByVoice;
$("teach").onclick = teach;
$("stop").onclick = () => { stopSpeaking(); };
$("light").onclick = async () => {
  const ok = await scanner.setTorch(!scanner.torchOn);
  speak(ok ? (scanner.torchOn ? "Light on." : "Light off.") : "This phone does not allow the light to be controlled from here.");
};
$("slower").onclick = () => speak(`Speed ${setRate(getSettings().rate - 0.15).toFixed(2)}. This is the new speaking speed.`);
$("faster").onclick = () => speak(`Speed ${setRate(getSettings().rate + 0.15).toFixed(2)}. This is the new speaking speed.`);
$("sr").checked = getSettings().screenReaderMode;
$("sr").onchange = (e) => {
  setScreenReaderMode(e.target.checked);
  $("transcript").setAttribute("aria-live", e.target.checked ? "assertive" : "off");
};
$("transcript").setAttribute("aria-live", getSettings().screenReaderMode ? "assertive" : "off");
if (!SR) $("mic").hidden = true;

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
