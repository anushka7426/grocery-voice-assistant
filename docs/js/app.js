import { Scanner } from "./scanner.js";
import { lookup, lookupLocal, saveCustom, deleteCustom, listCustom, allKnown } from "./lookup.js";
import * as photos from "./photos.js";
import { summary, answer, parseIntent } from "./describe.js";
import { speak, stopSpeaking, beep, buzz, bindLive, getSettings, setRate, setScreenReaderMode } from "./speech.js";
import { isIndian } from "./gtin.js";
import { ShelfScanner, internalCode } from "./shelf.js";

const $ = (id) => document.getElementById(id);
const status = $("status");
const video = $("video");

let scanner = null;
let current = null;          // { code, product } of the last product we identified
let lastMiss = null;         // barcode that wasn't found (for "teach")
let recent = { code: "", t: 0 };
let hintTimers = [];
let busy = false;
let shelf = null;            // ShelfScanner while shelf mode is on
let shelfTeach = null;       // { code, crops } while the form for a shelf-taught product is open
let pendingSave = null;      // { code, name, brand, quantity } from the last front-of-pack read

bindLive($("transcript"));
const setStatus = (t) => { status.textContent = t; };
const showPhotoButton = () => { $("photos").hidden = !(current || lastMiss); };
const digits = (c) => c.split("").join(" ");

// ------------------------------------------------------------ guidance
function clearHints() { hintTimers.forEach(clearTimeout); hintTimers = []; }
function armHints() {
  clearHints();
  hintTimers.push(setTimeout(() => {
    speak("Still looking. Slowly turn the pack. The barcode is usually on the back or the bottom. Hold it about 20 centimetres from the camera.");
  }, 9000));
  hintTimers.push(setTimeout(() => {
    if (busy) return;
    speak("I can't find a barcode, so I will try to read the label.").then(readLabel);
  }, 24000));
}

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
  setTimeout(() => import("./ppocr.js").then((m) => navigator.onLine && m.warmUp()), 4000);
  setTimeout(() => import("./vision.js").then((m) => navigator.onLine && m.warmUp()), 9000);
  setTimeout(() => import("./classifier.js").then((m) => m.warmUp()), 12000);
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
    lastMiss = null; showPhotoButton();
    const text = summary(res.product);
    setStatus(`${res.product.name} — ${res.product.source}`);
    $("followups").hidden = false; $("teach").hidden = true; $("edit").hidden = false;
    await speak(text);
  } else {
    lastMiss = code; showPhotoButton();
    $("teach").hidden = false;
    const india = isIndian(code) ? "It is an Indian barcode. " : "";
    const brand = res.hint ? `The maker prefix suggests ${res.hint}, but I can't be sure of the product. ` : "";
    const why = res.status === "offline"
      ? "There is no internet and this product is not saved on the phone. "
      : "This product is not in my database. ";
    const msg = `${india}${why}${brand}Now turn the pack so the front faces the camera and hold it steady. I will read it in 4 seconds.`;
    setStatus(`Barcode ${code} not found. Show the front of the pack.`);
    beep("fail"); buzz([80, 60, 80]);
    await speak(msg);
    busy = false;
    await readFront({ code, wait: 4 });
    return;
  }
  busy = false;
  scanner.resume();          // hands-free: keep scanning for the next item
  armHints();
}

// Read the FRONT of the pack: text reader (PaddleOCR) -> brand/type/title, plus the
// camera model as a cross-check. `code` is set when we arrive here from an unknown barcode.
async function readFront({ code = null, wait = 0 } = {}) {
  if (!scanner || busy) return;
  busy = true; clearHints(); scanner.pause();
  $("save").hidden = true; pendingSave = null;
  try {
    if (wait) {                                        // time to turn the pack around
      for (let i = wait; i > 0; i--) { beep("tick"); await new Promise((r) => setTimeout(r, 1000)); }
      beep("ok");
    }
    setStatus("Reading the pack. Hold steady.");
    await speak("Reading. Hold steady.");
    const ocr = await import("./ocr.js");
    const id = await import("./identify.js");

    // up to two looks, 1 second apart; keep the one with more readable text
    let best = null;
    for (let i = 0; i < 2; i++) {
      const shot = scanner.snapshot();
      let r = { lines: [], text: "" };
      try { r = await ocr.readLabel(shot); } catch { /* reader unavailable */ }
      const score = r.lines.reduce((n, l) => n + l.text.length * l.conf, 0);
      if (!best || score > best.score) best = { ...r, shot, score };
      if (score > 120) break;                          // plenty of text already
      if (i === 0) await new Promise((r2) => setTimeout(r2, 1000));
    }
    const { text, lines, shot } = best;
    const who = id.identify(lines);
    const facts = ocr.extractFacts(text);
    const parts = [];

    if (who.brand || who.title) {
      const what = [who.brand, who.title].filter(Boolean).join(", ");
      const kind = who.categories.length ? `, ${who.categories.join(" and ")}` : "";
      parts.push(`This looks like ${what}${kind}`);
    } else if (who.categories.length) {
      parts.push(`This looks like a pack of ${who.categories.join(" and ")}`);
    }
    if (facts.mrp) parts.push(`Price printed ${facts.mrp} rupees`);
    if (facts.net) parts.push(`Net quantity ${facts.net}`);
    if (facts.bestBefore) parts.push(facts.bestBefore);

    const known = ocr.matchKnown(text, await allKnown());
    if (known) parts.push(`This matches ${known.brand ? known.brand + " " : ""}${known.name} in my list`);

    const mine = await recogniseMine(shot);
    if (mine) parts.unshift(mine);
    const seen = await visualGuess(shot, text);
    if (seen) parts.push(seen);

    if (!parts.length) {
      beep("fail");
      setStatus("Could not identify.");
      if (code) $("teach").hidden = false;
      await speak(`I could not read enough text. ${code ? "You can tap Add details to type or say the name yourself, or " : "Please "}turn the pack so the front faces the camera, add more light, hold it about 20 centimetres away, and try again.`);
    } else {
      beep("ok");
      setStatus(who.name || "Pack read.");
      $("transcript").dataset.ocr = text;
      const guess = who.name ? "I am not certain, please confirm. " : "";
      let tail = "";
      if (code && who.name && lastMiss === code) {            // skip if the user already saved it by hand
        pendingSave = { code, name: who.name, brand: who.brand, quantity: facts.net || "", mrp: facts.mrp || "" };
        $("save").textContent = `Save as ${who.name}`;
        $("save").hidden = false;
        tail = ` Tap Save, or say save, to remember this barcode as ${who.name}. Or tap Add details to change the name or add more.`;
      }
      await speak(`${parts.join(". ")}. ${guess}${tail}`.trim());
    }
  } catch {
    await speak("The label reader is not available right now. Please try again.");
  }
  busy = false;
  scanner.resume();
  armHints();
}
const readLabel = () => readFront();

// Camera-model guess, only ever spoken with a safeguard (see vision.js).
async function visualGuess(shot, text) {
  let vision;
  try { vision = await import("./vision.js"); } catch { return ""; }
  let top;
  try { [top] = await vision.detect(shot, { conf: 0.5 }); } catch { return ""; }
  if (!top) return "";
  const name = vision.speakable(top.label);
  if (text.trim()) {
    // there is text on the pack: the guess must agree with it, else stay silent
    return vision.agreesWithText(top.index, text)
      ? `The camera model also recognises ${name}, and the text agrees. Please check the pack size`
      : "";
  }
  // no readable text: accept only a stable guess over 3 frames, and say it is uncertain
  if (top.conf < 0.8) return "";
  for (let i = 0; i < 2; i++) {
    await new Promise((r) => setTimeout(r, 350));
    const [again] = await vision.detect(scanner.snapshot(), { conf: 0.5 });
    if (!again || again.index !== top.index) return "";
  }
  return `I cannot read the text, but the camera thinks this may be ${name}. My camera model only knows a small set of products and can be wrong, so please confirm with someone before relying on it`;
}

// The classifier trained on YOUR photos (optional; see training/README.md).
async function recogniseMine(shot) {
  let cls;
  try { cls = await import("./classifier.js"); } catch { return ""; }
  let r;
  try { r = await cls.classify(shot); } catch { return ""; }
  if (!r || !r.accepted) return "";
  const code = r.top.code;
  const product = (await lookupLocal(code)) || { name: r.top.info.name, brand: r.top.info.brand, quantity: r.top.info.quantity, mrp: r.top.info.mrp, diet: r.top.info.diet };
  if (!product.name) return "";
  current = { code, product: { nutrition: null, ...product } };
  showPhotoButton(); $("followups").hidden = false; $("edit").hidden = false;
  return `The camera recognises your saved product. ${summary(current.product).replace(/\s*Say nutrition.*$/, "")} I am ${Math.round(r.top.conf * 100)} percent sure, please confirm`;
}

// ------------------------------------------------------------ training photos
const PHOTOS = 20;
async function takePhotos(code, label, n = PHOTOS) {
  if (!scanner || busy) return;
  busy = true; clearHints(); scanner.pause();
  const session = photos.newSession();
  const prompts = {
    0: code === photos.OTHER ? "Point the camera at something that is not one of your products. Move around slowly." : "Hold the front of the pack toward the camera.",
    5: code === photos.OTHER ? "Now something else, or another angle." : "Turn it a little to the left.",
    10: code === photos.OTHER ? "Keep going. Packs, shelves, tables, hands." : "Now show the back.",
    15: code === photos.OTHER ? "Almost done." : "Tilt it up and move it a little closer.",
  };
  setStatus(`Taking ${n} photos of ${label}…`);
  await speak(`Taking ${n} photos of ${label}. I will beep for each one.`);
  for (let i = 0; i < n; i++) {
    if (prompts[i]) await speak(prompts[i]);
    try { await photos.addPhoto(code, session, i, scanner.snapshot(800)); beep("tick"); } catch { /* storage full or camera gone */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const total = (await photos.counts())[code] || 0;
  beep("ok"); buzz(120);
  setStatus(`${total} photos saved for ${label}.`);
  await speak(`Done. ${total} photos of ${label} are saved on this phone. For best results take another set later in a different place or light.`);
  busy = false; scanner.resume(); armHints();
}
$("photos").onclick = () => {
  const code = current?.code || lastMiss;
  const name = current?.product?.name || "this product";
  if (!code) { speak("Scan a product first."); return; }
  takePhotos(code, name);
};
$("otherPhotos").onclick = () => takePhotos(photos.OTHER, "other things", 30);
$("galleryPhotos").onclick = () => $("galleryFile").click();
$("galleryFile").onchange = async (e) => {
  const files = [...e.target.files]; e.target.value = "";
  if (!files.length) return;
  const code = current?.code || lastMiss;
  if (!code) { speak("Scan or select a product first, so I know which product these photos show."); return; }
  const n = await photos.addFiles(code, files);
  speak(`Added ${n} photos to ${current?.product?.name || "this product"}.`);
};

async function savePending() {
  if (!pendingSave) { speak("There is nothing to save."); return; }
  const p = pendingSave;
  await commitProduct(p.code, { name: p.name, brand: p.brand, quantity: p.quantity, mrp: p.mrp || "", diet: "unknown" });
}

/** Store a product on this phone and make it the current one. */
async function commitProduct(code, rec) {
  const product = { nutrition: null, ...rec };
  await saveCustom(code, product);
  current = { code, product: { ...product, source: "saved on this phone" } };
  pendingSave = null; lastMiss = null; showPhotoButton();
  $("save").hidden = true; $("teach").hidden = true; $("edit").hidden = false; $("followups").hidden = false;
  setStatus(`${product.name} — saved on this phone`);
  await speak(`Saved as ${product.name}. Next time this barcode is scanned I will say it straight away, even without internet.`);
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
    if (shelf && await shelfVoice(said)) return;
    if (/\b(scan|look at|describe) (the )?shelf|shelf mode/i.test(said)) { startShelf(); return; }
    if (/\b(save|yes|remember)\b/i.test(said) && pendingSave) { await savePending(); return; }
    if (/read (the )?(label|front|pack)|read text/i.test(said)) { readLabel(); return; }
    if (/scan|next/i.test(said)) { scanner.resume(); return speak("Scanning."); }
    const intent = alts.map(parseIntent).find(Boolean);
    if (intent) await ask(intent);
    else await speak(`I heard ${said}. You can ask about nutrition, vegetarian, size, price, or say read label.`);
  });
}

// ------------------------------------------------------------ add / edit a product
const F = (id) => $(id);
/** Open the product form. `code` is the barcode, `p` an optional product to prefill/edit. */
function openForm(code, p = {}, { manual = false } = {}) {
  scanner?.pause(); clearHints();
  F("fCode").value = code || "";
  F("fCode").readOnly = !manual;
  F("fName").value = p.name || ""; F("fBrand").value = p.brand || ""; F("fQty").value = p.quantity || "";
  F("fMrp").value = p.mrp || ""; F("fDiet").value = p.diet || "unknown";
  F("dlgTitle").textContent = manual ? "Add a product" : p.source === "saved on this phone" ? "Edit this product" : "Save this product";
  $("dlg").showModal();
  (manual ? F("fCode") : F("fName")).focus();
  speak(manual ? "Add a product. Type the barcode number and the details." : "Type or say the product name and any details. A sighted helper can also fill this in.");
}

$("teach").onclick = () => {
  if (!lastMiss) { speak("There is no unknown product to add. Scan one first."); return; }
  openForm(lastMiss, pendingSave || {});
};
$("edit").onclick = () => {
  if (!current) { speak("Scan a product first."); return; }
  openForm(current.code, current.product);
};
$("addManual").onclick = () => { if (!scanner) return; openForm("", {}, { manual: true }); };

document.querySelectorAll(".say").forEach((btn) => {
  btn.onclick = () => {
    if (!SR) return speak("Dictation is not supported here. Please type it.");
    stopSpeaking();
    const r = new SR(); r.lang = "en-IN";
    const target = F(btn.dataset.for);
    r.onresult = (e) => { target.value = e.results[0][0].transcript.replace(/\.$/, ""); };
    r.start();
  };
});

$("teachForm").onsubmit = async (e) => {
  if (e.submitter?.value === "cancel") { $("dlg").close(); shelfTeach = null; if (!shelf) { scanner?.resume(); armHints(); } return; }
  const name = F("fName").value.trim();
  const code = F("fCode").value.replace(/\s+/g, "");
  if (!name || !/^\d{6,14}$/.test(code)) {
    e.preventDefault();                                  // keep the form open
    speak(!name ? "Please enter the product name." : "Please enter the barcode number, digits only.");
    (!name ? F("fName") : F("fCode")).focus();
    return;
  }
  e.preventDefault();
  $("dlg").close();
  await commitProduct(code, {
    name, brand: F("fBrand").value.trim(), quantity: F("fQty").value.trim(), mrp: F("fMrp").value.trim(),
    diet: F("fDiet").value,
  });
  if (shelfTeach && shelfTeach.code === code) { await saveShelfCrops(code, shelfTeach.crops); shelfTeach = null; }
  if (!shelf) { scanner?.resume(); armHints(); }
};

// ---- my saved products: list, edit, delete, backup
async function showMine() {
  scanner?.pause(); clearHints();
  const items = await listCustom();
  const pc = await photos.counts();
  $("mineCount").textContent = (items.length ? `${items.length} saved on this phone.` : "Nothing saved yet.") + ` Training photos: ${Object.values(pc).reduce((a, b) => a + b, 0)}.`;
  const ul = $("mineList"); ul.textContent = "";
  for (const it of items) {
    const li = document.createElement("li");
    li.append(`${it.name}${it.brand ? " — " + it.brand : ""} (${it.code}) — ${pc[it.code] || 0} photos`);
    const row = document.createElement("div"); row.className = "row";
    const ed = document.createElement("button"); ed.textContent = "Edit"; ed.setAttribute("aria-label", `Edit ${it.name}`);
    ed.onclick = () => { $("mineDlg").close(); openForm(it.code, { ...it, source: "saved on this phone" }); };
    const rm = document.createElement("button"); rm.textContent = "Delete"; rm.setAttribute("aria-label", `Delete ${it.name}`);
    rm.onclick = async () => { await deleteCustom(it.code); if (current?.code === it.code) current = null; showPhotoButton(); speak(`Deleted ${it.name}.`); showMine(); };
    const ph = document.createElement("button"); ph.textContent = "Delete photos"; ph.setAttribute("aria-label", `Delete training photos of ${it.name}`);
    ph.onclick = async () => { await photos.deletePhotos(it.code); speak(`Deleted photos of ${it.name}.`); showMine(); };
    row.append(ed, rm, ph); li.append(row); ul.append(li);
  }
  // products that have photos but are not saved by hand (built-in or found online)
  const savedCodes = new Set(items.map((i) => i.code));
  for (const code of Object.keys(pc)) {
    if (code === photos.OTHER || savedCodes.has(code)) continue;
    const info = (await lookupLocal(code)) || {};
    const li = document.createElement("li"); li.append(`${info.name || "Unnamed product"} (${code}) — ${pc[code]} photos`);
    const row = document.createElement("div"); row.className = "row";
    const d = document.createElement("button"); d.textContent = "Delete photos";
    d.onclick = async () => { await photos.deletePhotos(code); showMine(); };
    row.append(d); li.append(row); ul.append(li);
  }
  if (pc[photos.OTHER]) {
    const li = document.createElement("li"); li.append(`Other things (not a product) — ${pc[photos.OTHER]} photos`);
    const row = document.createElement("div"); row.className = "row";
    const d = document.createElement("button"); d.textContent = "Delete photos";
    d.onclick = async () => { await photos.deletePhotos(photos.OTHER); showMine(); };
    row.append(d); li.append(row); ul.append(li);
  }
  if (!$("mineDlg").open) $("mineDlg").showModal();
}
$("mine").onclick = showMine;
$("mineClose").onclick = () => { $("mineDlg").close(); scanner?.resume(); armHints(); };
$("exportTrain").onclick = async () => {
  const r = await photos.exportDataset(lookupLocal);
  if (!r) { speak("There are no training photos yet. Scan a product and tap Take training photos."); return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(r.blob); a.download = "training-data.zip"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  $("mineCount").textContent = `Exported ${r.photos} photos of ${r.classes} classes. ${r.notes.length ? r.notes.join(" ") : ""}`;
  speak(`Training file created with ${r.photos} photos of ${r.classes} classes. Copy it to your computer and run the training script.${r.notes.length ? " " + r.notes.length + " things to improve are written in the file." : ""}`);
};
$("exportBtn").onclick = async () => {
  const items = await listCustom();
  const products = {};
  for (const { code, ...rest } of items) products[code] = rest;      // same shape as data/products-in.json
  const blob = new Blob([JSON.stringify({ products }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "my-products.json"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  speak(`Backup file created with ${items.length} products.`);
};
$("importBtn").onclick = () => $("importFile").click();
$("importFile").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    let n = 0;
    for (const [code, p] of Object.entries(data.products || {})) {
      if (!/^\d{6,14}$/.test(code) || !p || typeof p.name !== "string" || !p.name.trim()) continue;
      await saveCustom(code, { nutrition: null, diet: "unknown", ...p });
      n++;
    }
    speak(`Imported ${n} products.`); showMine();
  } catch { speak("That file could not be read."); }
};


// ------------------------------------------------------------ shelf mode
// Many products in view at once. The barcode scanner is paused while this runs.
const shelfUi = (on) => {
  $("shelfPanel").hidden = !on;
  $("shelfOn").hidden = on;
  $("mainGrid").hidden = on;
};

async function nameOfCode(code) {
  const mine = await lookupLocal(code);
  if (mine) return mine;
  const { bundledInfo } = await import("./refs.js");
  return (await bundledInfo(code)) || null;
}

async function startShelf() {
  if (!scanner || shelf) return;
  clearHints(); scanner.pause(); busy = true;
  shelfUi(true);
  setStatus("Shelf mode. Move the phone slowly along the shelf.");
  await speak("Shelf mode. Hold the phone about an arm's length from the shelf and move it slowly. I will tell you what I see.");
  const refs = await import("./refs.js");
  const bmpBox = async (bmp) => {                       // crop training photos to the product so the shelf background is left out
    try {
      const v = await import("./vision.js");
      if (!v.names().length) return null;
      const d = await v.detect(bmp, { conf: 0.5, agnostic: true });
      return d[0]?.box || null;
    } catch { return null; }
  };
  const nIndexed = await refs.indexPhotos({ cropBox: bmpBox });
  shelf = new ShelfScanner({
    grab: (max) => scanner.snapshot(max),
    say: (t, o) => speak(t, o),
    nameOf: nameOfCode,
  });
  const ok = await shelf.start();
  if (!ok) { stopShelf(false); return; }
  if (!shelf.refs.length) await speak("I have no saved photos of products yet, so I can count products but not name them. Say teach this product to show me one.", { append: true });
  else if (shelf.mode === "fallback") await speak("The shelf detector is not installed, so I am using the basic one. It may miss products.", { append: true });
  if (nIndexed) setStatus(`Indexed ${nIndexed} photos. Shelf mode.`);
}

function stopShelf(say = true) {
  shelf?.stop(); shelf = null; shelfTeach = null;
  shelfUi(false);
  busy = false; scanner?.resume(); armHints();
  setStatus("Scanning. Point the back of the pack at the camera.");
  if (say) speak("Shelf mode off. Scanning for barcodes.");
}

async function readCentre() {
  const t = shelf?.centreTrack();
  if (!t) { await speak("I cannot see a product in the middle. Centre one product and try again."); return; }
  await speak("Reading the middle product.");
  const crop = shelf.crop(t);
  const ocr = await import("./ocr.js"), id = await import("./identify.js");
  let r = { lines: [], text: "" };
  try { r = await ocr.readLabel(crop); } catch { /* reader unavailable */ }
  const who = id.identify(r.lines), facts = ocr.extractFacts(r.text);
  const parts = [];
  if (who.brand || who.title) parts.push(`This looks like ${[who.brand, who.title].filter(Boolean).join(", ")}`);
  if (facts.mrp) parts.push(`Price printed ${facts.mrp} rupees`);
  if (facts.net) parts.push(`Net quantity ${facts.net}`);
  const known = r.text ? ocr.matchKnown(r.text, await allKnown()) : null;
  if (known) parts.push(`This matches ${known.brand ? known.brand + " " : ""}${known.name} in my list`);
  await speak(parts.length ? parts.join(". ") + "." : "I could not read enough text on the middle product. Move closer to it and try again.");
}

async function teachCentre() {
  const t = shelf?.centreTrack();
  if (!t) { await speak("I cannot see a product in the middle. Centre one product and try again."); return; }
  await speak("Keep the product in the middle and hold steady. Taking pictures.");
  const crops = await shelf.collectCrops(8);
  if (crops.length < 3) { await speak("I could not get a steady view of it. Please try again."); return; }
  const code = internalCode();
  shelfTeach = { code, crops };
  beep("ok");
  openForm(code, {});
}

async function saveShelfCrops(code, crops) {
  const refs = await import("./refs.js"), { embed } = await import("./embed.js");
  const session = photos.newSession();
  let n = 0;
  for (let i = 0; i < crops.length; i++) {
    await photos.addPhoto(code, session, i, crops[i]);
    const vec = await embed(crops[i]);
    if (vec) { await refs.addRef(photos.key(code, session, i), code, vec); n++; }
  }
  if (shelf) { shelf.refs = await refs.loadRefs(true); shelf.names.delete(code); const p = await lookupLocal(code); if (p) shelf.names.set(code, p.brand && !p.name.toLowerCase().includes(p.brand.toLowerCase()) ? `${p.brand} ${p.name}` : p.name); }
  await speak(`I will now recognise it on the shelf from ${n} pictures.`, { append: true });
}

/** Voice commands while shelf mode is on. Returns true if handled. */
async function shelfVoice(said) {
  const s = said.toLowerCase();
  if (/\b(stop|exit|leave|end) (the )?shelf|stop shelf/.test(s)) { stopShelf(); return true; }
  if (/\bteach|\bremember this|learn this/.test(s)) { await teachCentre(); return true; }
  if (/\bread\b.*\b(middle|centre|center|this)\b|\bread\b.*\bproduct/.test(s)) { await readCentre(); return true; }
  const side = s.match(/\b(left|middle|centre|center|right)\b/);
  if (side && /what|which|anything|describe|tell/.test(s)) { await speak(shelf.side(side[1] === "centre" || side[1] === "center" ? "middle" : side[1])); return true; }
  if (/\bwhere\b|\bfind\b|\blocate\b/.test(s)) { await speak(shelf.where(s)); return true; }
  if (/what|describe|see|shelf|tell me|repeat/.test(s)) { shelf.markAllAnnounced(); await speak(shelf.describeNow()); return true; }
  return false;
}

$("shelfOn").onclick = startShelf;
$("shelfDescribe").onclick = async () => { if (shelf) { shelf.markAllAnnounced(); await speak(shelf.describeNow()); } };
$("shelfRead").onclick = readCentre;
$("shelfTeach").onclick = teachCentre;
$("shelfStop").onclick = () => stopShelf();

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
$("nut").onclick = () => ask("nutrition");
$("veg").onclick = () => ask("diet");
$("label").onclick = readLabel;
$("mic").onclick = askByVoice;
$("save").onclick = savePending;
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
