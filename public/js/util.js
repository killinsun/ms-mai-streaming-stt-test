export const SAMPLE_RATE = 16000;

export const $ = (id) => document.getElementById(id);
export const fmtMs = (ms) => (ms == null || Number.isNaN(ms) ? "—" : `${Math.round(ms)} ms`);
export const fmtSec = (s) => `${s.toFixed(2)} s`;
export const fmtUsd = (u) => (u == null ? "—" : `$${u.toFixed(6)}`);
export const fmtPct = (x) => (x == null ? "—" : `${(x * 100).toFixed(2)}%`);
export const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function setStatus(el, text, isErr = false) {
  el.textContent = text;
  el.classList.toggle("err", isErr);
}

export function waitUntil(fn, timeoutMs) {
  return new Promise((resolve) => {
    const started = performance.now();
    const tick = () => (fn() || performance.now() - started > timeoutMs ? resolve(fn()) : setTimeout(tick, 20));
    tick();
  });
}

export function b64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// 16kHz モノラル PCM16 の WAV を作る
export function toWav(chunks) {
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const view = new DataView(new ArrayBuffer(44 + total * 2));
  const ascii = (offset, s) => [...s].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + total * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, total * 2, true);
  let offset = 44;
  for (const c of chunks) for (let i = 0; i < c.length; i++, offset += 2) view.setInt16(offset, c[i], true);
  return new Blob([view.buffer], { type: "audio/wav" });
}

export function log(tag, dir, obj) {
  const el = $("log");
  const line = document.createElement("div");
  line.textContent = `${(performance.now() / 1000).toFixed(3)} [${tag}] ${dir} ${JSON.stringify(obj)}`;
  if (/error|failed|exceeded|throttled|limited/.test(obj.type ?? obj.message_type ?? "")) line.className = "err";
  el.appendChild(line);
  while (el.childNodes.length > 800) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

// どちらの API もトークン数は仕様にないが、応答に usage / token 系の項目があれば合計して表示する
export function collectUsage(obj, acc = {}, prefix = "") {
  if (!obj || typeof obj !== "object") return acc;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "number" && (prefix || /usage|token/i.test(k))) acc[key] = (acc[key] || 0) + v;
    else if (v && typeof v === "object") collectUsage(v, acc, prefix || /usage|token/i.test(k) ? key : "");
  }
  return acc;
}
export const usageText = (u) =>
  Object.keys(u).length ? Object.entries(u).map(([k, v]) => `${k}: ${v}`).join("\n") : "API から返却なし";
