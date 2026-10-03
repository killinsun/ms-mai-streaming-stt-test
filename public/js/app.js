import { runBatch } from "./batch.js";
import { cer } from "./cer.js";
import { openMic, vad } from "./recorder.js";
import { connectEngines } from "./streaming.js";
import { $, SAMPLE_RATE, fmtMs, fmtPct, fmtUsd, setStatus, toWav } from "./util.js";

const status = (text, isErr) => setStatus($("status"), text, isErr);
const loadConfig = () => fetch("/api/config").then((r) => r.json());

// ---------- 読み上げ文章 ----------
// scripts.json の本文は {漢字|かな} 形式で振り仮名を持つ。正解文には漢字だけを使う
const RUBY_RE = /\{([^|}]+)\|([^}]+)\}/g;
const plainText = (text) => text.replace(RUBY_RE, "$1");

function renderRuby(el, text) {
  el.textContent = "";
  let last = 0;
  for (const m of text.matchAll(RUBY_RE)) {
    el.append(text.slice(last, m.index));
    const ruby = document.createElement("ruby");
    const rt = document.createElement("rt");
    rt.textContent = m[2];
    ruby.append(m[1], rt);
    el.append(ruby);
    last = m.index + m[0].length;
  }
  el.append(text.slice(last));
}

let scripts = [];
const currentScript = () => scripts.find((s) => s.id === $("script").value) ?? null;

function showScript() {
  const sc = currentScript();
  $("scriptBox").hidden = !sc;
  if (sc) {
    $("scriptMeta").textContent = `${sc.category} / ${sc.title} / 出典: ${sc.source}`;
    renderRuby($("scriptText"), sc.text);
  }
  remember("script", $("script").value);
}

function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
function recall(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// ---------- 録音 → リアルタイム送信 → バッチ送信 → 保存 ----------
let rec = null;

async function start() {
  const config = await loadConfig();
  vad.threshold = Number($("threshold").value);
  vad.silenceMs = Number($("silenceMs").value);
  for (const id of ["streamCards", "batchCards", "log"]) $(id).innerHTML = "";
  $("summary").hidden = true;
  $("record").disabled = true;

  // マイクを先に開き、接続が整うまでの音声はためておく (押してすぐ話し始めても冒頭を取りこぼさないため)
  const state = { config, engines: [], queue: [], pcm: [], recStart: performance.now() };
  state.mic = await openMic({
    onChunk(chunk, now) {
      state.pcm.push(chunk);
      if (state.engines.length) for (const e of state.engines) e.push(chunk, now);
      else state.queue.push([chunk, now]);
    },
    onLevel(rms, voiced) {
      $("meter").style.width = `${Math.min(100, rms * 400)}%`;
      $("meterBox").classList.toggle("voiced", voiced);
    },
  });
  rec = state;
  status("接続中…（話し始めて大丈夫です）");

  const engines = await connectEngines({ config, lang: $("lang").value, container: $("streamCards") });
  if (!engines.length) {
    await state.mic.close();
    rec = null;
    throw new Error("どのエンジンにも接続できませんでした");
  }
  for (const e of engines) {
    e.t.recStart = state.recStart;
    e.t.status("録音中");
  }
  for (const [chunk, at] of state.queue) for (const e of engines) e.push(chunk, at);
  state.queue = [];
  state.engines = engines;

  $("record").textContent = "■ 停止";
  $("record").classList.add("rec");
  $("record").disabled = false;
  status("録音中");
}

async function stop() {
  const state = rec;
  rec = null;
  $("record").disabled = true;
  const tail = await state.mic.close();
  if (tail) {
    state.pcm.push(tail);
    for (const e of state.engines) e.push(tail, performance.now());
  }

  status("最終結果待ち…");
  const stopAt = performance.now();
  for (const e of state.engines) e.t.stopAt = stopAt;
  await Promise.allSettled(state.engines.map((e) => e.finish().then(() => e.t.status("完了"))));

  status("バッチ送信中…");
  const seconds = state.pcm.reduce((a, c) => a + c.length, 0) / SAMPLE_RATE;
  const clip = { blob: toWav(state.pcm), filename: "recording.wav", seconds };
  const batch = await runBatch({ config: state.config, clip, lang: $("lang").value, container: $("batchCards") });
  const streaming = Object.fromEntries(state.engines.map((e) => [e.t.key, e.t.result()]));

  const script = currentScript();
  const reference = script ? plainText(script.text) : null;
  for (const r of [...Object.values(streaming), ...Object.values(batch)]) r.cerSimple = reference ? cer(reference, r.text) : null;
  renderSummary(streaming, batch);

  const createdAt = new Date();
  const id = `${createdAt.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-")}-${script?.id ?? "free"}`;
  const run = {
    id,
    createdAt: createdAt.toISOString(),
    script: script && { id: script.id, category: script.category, title: script.title, source: script.source },
    reference,
    env: $("env").value,
    lang: $("lang").value,
    settings: { silenceMs: vad.silenceMs, threshold: vad.threshold },
    audioSec: seconds,
    streaming,
    batch,
  };
  await save(run, clip.blob);

  $("record").disabled = false;
  $("record").textContent = "● 録音開始";
  $("record").classList.remove("rec");
}

async function save(run, wav) {
  status("保存中…");
  try {
    await fetch(`/api/runs/${run.id}.wav`, { method: "POST", body: wav });
    const res = await fetch(`/api/runs/${run.id}.json`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(run, null, 2),
    });
    const { path } = await res.json();
    $("saved").textContent = `保存しました: ${path}`;
    status("保存しました");
    // 台本を読んでいたら次の文章へ進める
    const i = scripts.findIndex((s) => s.id === run.script?.id);
    if (i >= 0 && i < scripts.length - 1) {
      $("script").value = scripts[i + 1].id;
      showScript();
    }
  } catch (e) {
    status(`保存に失敗しました: ${e.message ?? e}`, true);
  }
}

function renderSummary(streaming, batch) {
  const rows = [
    ...Object.values(streaming).map((r) => ["リアルタイム", r.model, fmtPct(r.cerSimple), fmtMs(r.eosAvgMs), fmtMs(r.stopToFinalMs), fmtUsd(r.costUsd)]),
    ...Object.values(batch).map((r) => ["バッチ", r.model, fmtPct(r.cerSimple), "—", fmtMs(r.serverMs), fmtUsd(r.costUsd)]),
  ];
  const tbody = $("summaryRows");
  tbody.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    row.forEach((v, i) => {
      const td = document.createElement("td");
      td.textContent = v;
      if (i >= 2) td.className = "num";
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  $("saved").textContent = "";
  $("summary").hidden = false;
}

// ---------- 音声ファイルをバッチだけで送る ----------
async function sendFile(file) {
  let seconds = 0;
  try {
    const ctx = new AudioContext();
    seconds = (await ctx.decodeAudioData(await file.arrayBuffer())).duration;
    await ctx.close();
  } catch {
    // 長さが取れなくても送信はできる (ElevenLabs は応答の audio_duration_secs を使う)
  }
  for (const id of ["streamCards", "batchCards"]) $(id).innerHTML = "";
  $("summary").hidden = true;
  status("バッチ送信中…");
  await runBatch({ config: await loadConfig(), clip: { blob: file, filename: file.name, seconds }, lang: $("lang").value, container: $("batchCards") });
  status("完了");
}

// ---------- 初期化 ----------
$("record").onclick = () => {
  const run = rec ? stop() : start();
  run.catch((e) => {
    status(String(e.message ?? e), true);
    $("record").disabled = false;
  });
};
$("file").onchange = (e) => e.target.files[0] && sendFile(e.target.files[0]).catch((err) => status(String(err.message ?? err), true));
$("script").onchange = showScript;
$("env").onchange = () => remember("env", $("env").value);
$("env").value = recall("env") ?? "";

fetch("/scripts.json")
  .then((r) => r.json())
  .then((list) => {
    scripts = list;
    for (const sc of list) $("script").add(new Option(`${sc.category} / ${sc.title}`, sc.id));
    const saved = recall("script");
    if (saved && list.some((s) => s.id === saved)) $("script").value = saved;
    showScript();
  });

loadConfig().then((config) => {
  const missing = Object.entries(config).filter(([, c]) => !c.configured).map(([k]) => k);
  if (missing.length) status(`未設定: ${missing.join(", ")}（.env を確認）`, true);
});
