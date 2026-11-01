// Voice output (Web Speech API), audio cues and vibration.

const KEY = "gva-settings";
const settings = { rate: 1, screenReaderMode: false };
try { Object.assign(settings, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch {} };

let voice = null;
let liveEl = null;
let audio = null;

export const getSettings = () => ({ ...settings });
export function setRate(r) { settings.rate = Math.min(1.8, Math.max(0.6, r)); save(); return settings.rate; }
export function setScreenReaderMode(on) { settings.screenReaderMode = !!on; save(); }
export function bindLive(el) { liveEl = el; }

function pickVoice() {
  if (!("speechSynthesis" in window)) return;
  const vs = speechSynthesis.getVoices();
  voice = vs.find((v) => v.lang === "en-IN") ||
          vs.find((v) => v.lang.replace("_", "-").startsWith("en-IN")) ||
          vs.find((v) => v.lang.startsWith("en-GB")) ||
          vs.find((v) => v.lang.startsWith("en")) || null;
}
if ("speechSynthesis" in window) {
  pickVoice();
  speechSynthesis.addEventListener?.("voiceschanged", pickVoice);
}

const chunks = (text) =>
  text.replace(/\s+/g, " ").match(/[^.!?;]+[.!?;]?/g)?.map((s) => s.trim()).filter(Boolean) || [];

let token = 0;

/** Speak text; resolves when finished (or cancelled). A new call cancels the old one. */
export function speak(text, { append = false } = {}) {
  if (liveEl) liveEl.textContent = text;
  if (settings.screenReaderMode || !("speechSynthesis" in window)) return Promise.resolve();
  const my = ++token;
  if (!append) speechSynthesis.cancel();
  return new Promise((resolve) => {
    const parts = chunks(text);
    let i = 0;
    const next = () => {
      if (my !== token || i >= parts.length) return resolve();
      const u = new SpeechSynthesisUtterance(parts[i++]);
      if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = "en-IN";
      u.rate = settings.rate;
      let done = false;
      const fin = () => { if (!done) { done = true; clearTimeout(t); next(); } };
      // some Android builds never fire `end`; don't hang forever
      const t = setTimeout(fin, Math.max(2500, parts[i - 1].length * 120 / settings.rate));
      u.onend = fin; u.onerror = fin;
      speechSynthesis.speak(u);
    };
    next();
  });
}

export function stopSpeaking() {
  token++;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

function ctx() {
  try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  return audio;
}

export function beep(kind = "ok") {
  const c = ctx();
  if (!c) return;
  const tones = { ok: [880, 1320], fail: [300], tick: [660] }[kind] || [880];
  tones.forEach((f, i) => {
    const o = c.createOscillator(), g = c.createGain();
    o.frequency.value = f; o.type = "sine";
    const t0 = c.currentTime + i * 0.13;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.4, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
    o.connect(g).connect(c.destination);
    o.start(t0); o.stop(t0 + 0.13);
  });
}

export function buzz(pattern) { try { navigator.vibrate?.(pattern); } catch {} }
