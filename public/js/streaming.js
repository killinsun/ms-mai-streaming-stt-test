// リアルタイム API (MAI-Transcribe-2-Streaming / ElevenLabs Scribe v2 Realtime) の接続と計測
import { vad, sinceVoiceEnd } from "./recorder.js";
import { $, SAMPLE_RATE, avg, b64, collectUsage, fmtMs, fmtSec, fmtUsd, log, usageText, waitUntil } from "./util.js";

const FINISH_TIMEOUT_MS = 10000;

// ---------- 共通の計測と表示 ----------
function createTracker({ key, title, model, extraHead, container, pricePerHour }) {
  const card = $("streamCardTpl").content.firstElementChild.cloneNode(true);
  card.querySelector(".title").textContent = title;
  card.querySelector(".model").textContent = model;
  card.querySelector(".extraHead").textContent = extraHead ?? "";
  container.appendChild(card);
  const m = (name) => card.querySelector(`[data-m="${name}"]`);

  const t = {
    key, card, closed: false, t0: performance.now(), recStart: null, stopAt: null,
    samplesSent: 0, lines: [], current: "", interim: "", usage: {},
    firstPartialAt: null, segTtfp: null, segTtfpUtt: null, ttfps: [], eoss: [], segs: [],
    connectMs: null, firstMs: null, stopMs: null, error: null,
  };

  t.status = (text, isErr = false) => {
    const s = card.querySelector(".cardStatus");
    s.textContent = text;
    s.classList.toggle("err", isErr);
    if (isErr) t.error = text;
  };
  t.event = (ev) => {
    collectUsage(ev, t.usage);
    m("tokens").textContent = usageText(t.usage);
  };
  t.ready = () => {
    t.connectMs = performance.now() - t.t0;
    m("connect").textContent = fmtMs(t.connectMs);
    t.status("準備完了");
  };
  t.audio = (n) => {
    t.samplesSent += n;
    const sec = t.samplesSent / SAMPLE_RATE;
    m("audio").textContent = fmtSec(sec);
    m("cost").textContent = fmtUsd((sec / 3600) * pricePerHour);
  };
  // 部分結果 (確定前の仮テキスト) を受け取ったとき
  t.partial = (now) => {
    if (t.firstPartialAt == null && t.recStart != null) {
      t.firstPartialAt = now;
      t.firstMs = now - t.recStart;
      m("first").textContent = fmtMs(t.firstMs);
    }
    if (t.segTtfp == null && vad.uttStart != null && vad.uttId !== t.segTtfpUtt) {
      t.segTtfp = now - vad.uttStart;
      t.segTtfpUtt = vad.uttId;
    }
  };
  t.render = () => {
    const el = card.querySelector(".transcript");
    el.textContent = [...t.lines, t.current].filter(Boolean).join("\n");
    if (t.interim) {
      const span = document.createElement("span");
      span.className = "interim";
      span.textContent = t.interim;
      el.appendChild(span);
    }
    el.scrollTop = el.scrollHeight;
  };
  // 1 区間の確定
  t.segment = (text, now, commitMs = null) => {
    const eos = sinceVoiceEnd(now);
    if (t.segTtfp != null) t.ttfps.push(t.segTtfp);
    if (eos != null) t.eoss.push(eos);
    t.segs.push({ text, ttfpMs: t.segTtfp, eosMs: eos, commitMs });
    const tr = document.createElement("tr");
    const cells = [[t.segs.length, "num"], [text, ""], [fmtMs(t.segTtfp), "num"], [eos == null ? "発話中" : fmtMs(eos), "num"], [commitMs == null ? "" : fmtMs(commitMs), "num"]];
    for (const [v, cls] of cells) {
      const td = document.createElement("td");
      td.textContent = v;
      td.className = cls;
      tr.appendChild(td);
    }
    card.querySelector("tbody").appendChild(tr);
    m("ttfpAvg").textContent = fmtMs(avg(t.ttfps));
    m("eosAvg").textContent = fmtMs(avg(t.eoss));
    t.segTtfp = null;
    if (t.stopAt != null) {
      t.stopMs = now - t.stopAt;
      m("stop").textContent = fmtMs(t.stopMs);
    }
  };
  // 保存用のスナップショット
  t.result = () => ({
    model,
    text: t.lines.join(""),
    lines: [...t.lines],
    segments: t.segs,
    connectMs: t.connectMs,
    firstPartialMs: t.firstMs,
    stopToFinalMs: t.stopMs,
    ttfpAvgMs: avg(t.ttfps),
    eosAvgMs: avg(t.eoss),
    audioSec: t.samplesSent / SAMPLE_RATE,
    costUsd: (t.samplesSent / SAMPLE_RATE / 3600) * pricePerHour,
    usage: t.usage,
    error: t.error,
  });
  return t;
}

function openSocket(path, t, onEvent) {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`);
  ws.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    const type = ev.type ?? ev.message_type;
    if (!/intermediate|partial/.test(type)) log(t.key, "←", ev);
    t.event(ev);
    onEvent(ev, type, performance.now());
  };
  ws.onclose = () => (t.closed = true);
  ws.onerror = () => t.status("WebSocket エラー", true);
  const send = (obj) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!obj.audio && !obj.audio_base_64) log(t.key, "→", obj);
    ws.send(JSON.stringify(obj));
  };
  return { ws, send };
}

// ---------- MAI-Transcribe-2-Streaming (Realtime API) ----------
function createMai({ cfg, lang, container }) {
  const t = createTracker({
    key: "mai", title: "MAI-Transcribe-2-Streaming", model: cfg.model, extraHead: "commit→確定",
    container, pricePerHour: cfg.pricePerHour,
  });
  const MIN_COMMIT_SAMPLES = SAMPLE_RATE / 10; // API は 100ms 未満のバッファの commit を拒否する
  const commits = [];
  let samplesSinceCommit = 0;
  let isReady = false;

  const { ws, send } = openSocket("/ws/mai", t, (ev, type, now) => {
    switch (type) {
      case "session.created":
        send({
          type: "session.update",
          session: {
            type: "transcription",
            audio: { input: {
              format: { type: "audio/pcm", rate: SAMPLE_RATE },
              transcription: { model: cfg.model, language: lang || null },
              turn_detection: null,
              noise_reduction: null,
            } },
          },
        });
        break;
      case "session.updated":
        isReady = true;
        t.ready();
        break;
      case "conversation.item.input_audio_transcription.intermediate":
        t.partial(now);
        t.interim = ev.intermediate ?? "";
        t.render();
        break;
      case "conversation.item.input_audio_transcription.delta":
        t.partial(now);
        t.current += ev.delta ?? "";
        t.interim = "";
        t.render();
        break;
      case "conversation.item.input_audio_transcription.completed": {
        const c = commits.find((x) => !x.done);
        if (c) c.done = true;
        t.lines.push(ev.transcript ?? t.current);
        t.current = "";
        t.interim = "";
        t.render();
        t.segment(ev.transcript ?? "", now, c ? now - c.at : null);
        break;
      }
      case "error":
      case "conversation.item.input_audio_transcription.failed":
        t.status(`エラー: ${ev.error?.message ?? JSON.stringify(ev)}`, true);
        break;
    }
  });

  const commit = () => {
    if (samplesSinceCommit === 0) return;
    if (samplesSinceCommit < MIN_COMMIT_SAMPLES) {
      // 録音末尾の端数は無音で 100ms まで埋めてから確定させる
      send({ type: "input_audio_buffer.append", audio: b64(new Int16Array(MIN_COMMIT_SAMPLES - samplesSinceCommit)) });
    }
    samplesSinceCommit = 0;
    commits.push({ at: performance.now(), done: false });
    send({ type: "input_audio_buffer.commit" });
  };

  return {
    t,
    ready: () => isReady,
    push(chunk, now) {
      send({ type: "input_audio_buffer.append", audio: b64(chunk) });
      samplesSinceCommit += chunk.length;
      t.audio(chunk.length);
      // サーバー側の VAD がないので、ElevenLabs と同じ無音秒数でこちらから commit する
      const eos = sinceVoiceEnd(now);
      if (eos != null && eos >= vad.silenceMs && vad.lastVoiceAt > (commits.at(-1)?.at ?? 0)) commit();
    },
    async finish() {
      commit();
      await waitUntil(() => t.closed || commits.every((c) => c.done), FINISH_TIMEOUT_MS);
      ws.close();
    },
    close: () => ws.close(),
  };
}

// ---------- ElevenLabs Scribe v2 Realtime ----------
function createEleven({ cfg, lang, container }) {
  const t = createTracker({
    key: "eleven", title: "ElevenLabs Scribe v2 Realtime", model: cfg.model, extraHead: "",
    container, pricePerHour: cfg.pricePerHour,
  });
  let isReady = false;
  let waitingFinal = false;
  const params = new URLSearchParams({ silence: String(vad.silenceMs / 1000) });
  if (lang) params.set("lang", lang);

  const { ws, send } = openSocket(`/ws/eleven?${params}`, t, (ev, type, now) => {
    switch (type) {
      case "session_started":
        isReady = true;
        t.ready();
        break;
      case "partial_transcript":
        if (ev.text) t.partial(now);
        t.interim = ev.text ?? "";
        t.render();
        break;
      case "committed_transcript": {
        const text = (ev.text ?? "").trim();
        waitingFinal = false;
        t.interim = "";
        if (!text) break;
        t.lines.push(text);
        t.render();
        t.segment(text, now);
        break;
      }
      case "insufficient_audio_activity":
        waitingFinal = false;
        break;
      default:
        if (/error|exceeded|throttled|limited|overflow|exhausted|invalid/.test(type)) {
          waitingFinal = false;
          t.status(`${type}: ${typeof ev.error === "string" ? ev.error : ev.error?.message ?? JSON.stringify(ev)}`, true);
        }
    }
  });

  return {
    t,
    ready: () => isReady,
    push(chunk) {
      send({ message_type: "input_audio_chunk", audio_base_64: b64(chunk), commit: false, sample_rate: SAMPLE_RATE });
      t.audio(chunk.length);
    },
    async finish() {
      // 録音末尾を手動で確定させる
      waitingFinal = true;
      send({ message_type: "input_audio_chunk", audio_base_64: "", commit: true, sample_rate: SAMPLE_RATE });
      await waitUntil(() => t.closed || !waitingFinal, FINISH_TIMEOUT_MS);
      ws.close();
    },
    close: () => ws.close(),
  };
}

const FACTORIES = { mai: createMai, eleven: createEleven };

// 設定済みのエンジンにつなぎ、準備ができたものだけを返す
export async function connectEngines({ config, lang, container, timeoutMs = 10000 }) {
  const engines = Object.entries(FACTORIES)
    .filter(([key]) => config[key]?.configured)
    .map(([key, create]) => create({ cfg: config[key], lang, container }));
  await Promise.all(engines.map((e) => waitUntil(() => e.ready() || e.t.closed, timeoutMs)));
  for (const e of engines) {
    if (e.ready()) continue;
    if (!e.t.error) e.t.status("接続できませんでした", true);
    e.close();
  }
  return engines.filter((e) => e.ready());
}
