// バッチ API (MAI-Transcribe-2 / ElevenLabs Scribe v2) の呼び出しと表示
import { $, collectUsage, fmtMs, fmtSec, fmtUsd, log, usageText } from "./util.js";

const TARGETS = {
  mai: {
    title: "MAI-Transcribe-2",
    text: (b) => b.combinedPhrases?.map((p) => p.text).join("\n"),
    seconds: (b) => (b.durationMilliseconds ? b.durationMilliseconds / 1000 : null),
    lang: (b) => b.phrases?.[0]?.locale,
  },
  eleven: {
    title: "ElevenLabs Scribe v2",
    text: (b) => b.text ?? b.transcripts?.map((t) => t.text).join("\n"),
    seconds: (b) => b.audio_duration_secs ?? null,
    lang: (b) => b.language_code,
  },
};

function createCard(title, model, container) {
  const card = $("batchCardTpl").content.firstElementChild.cloneNode(true);
  card.querySelector(".title").textContent = title;
  card.querySelector(".model").textContent = model;
  container.appendChild(card);
  const status = (text, isErr = false) => {
    const s = card.querySelector(".cardStatus");
    s.textContent = text;
    s.classList.toggle("err", isErr);
  };
  return { card, m: (name) => card.querySelector(`[data-m="${name}"]`), status };
}

// clip: { blob, filename, seconds }
async function runOne(key, cfg, clip, lang, container) {
  const target = TARGETS[key];
  const c = createCard(target.title, cfg.batchModel, container);
  const result = { model: cfg.batchModel, text: null, rttMs: null, serverMs: null, audioSec: null, rtf: null, costUsd: null, lang: null, region: null, error: null };
  c.status("送信中…");
  const params = new URLSearchParams({ filename: clip.filename });
  if (lang) params.set("lang", lang);
  const t0 = performance.now();
  try {
    const res = await fetch(`/api/batch/${key}?${params}`, {
      method: "POST",
      headers: { "content-type": clip.blob.type || "application/octet-stream" },
      body: clip.blob,
    });
    const json = await res.json();
    result.rttMs = performance.now() - t0;
    result.serverMs = json.serverMs ?? null;
    log(key, "← batch", json);
    c.m("rtt").textContent = fmtMs(result.rttMs);
    c.m("server").textContent = fmtMs(result.serverMs);
    c.m("tokens").textContent = usageText(collectUsage(json.body));
    if (json.status !== 200) throw new Error(`HTTP ${json.status}: ${JSON.stringify(json.body)}`);

    const seconds = target.seconds(json.body) ?? clip.seconds;
    Object.assign(result, {
      text: target.text(json.body) ?? null,
      audioSec: seconds,
      rtf: seconds ? json.serverMs / 1000 / seconds : null,
      costUsd: seconds ? (seconds / 3600) * cfg.batchPricePerHour : null,
      lang: target.lang(json.body) ?? null,
      region: json.region ?? null,
    });
    c.m("audio").textContent = seconds ? fmtSec(seconds) : "—";
    c.m("rtf").textContent = result.rtf == null ? "—" : result.rtf.toFixed(3);
    c.m("cost").textContent = fmtUsd(result.costUsd);
    c.m("lang").textContent = [result.lang, result.region].filter(Boolean).join(" / ") || "—";
    c.card.querySelector(".transcript").textContent = result.text ?? JSON.stringify(json.body);
    c.status("完了");
  } catch (e) {
    result.error = String(e.message ?? e);
    c.status(result.error, true);
  }
  return result;
}

// 設定済みの全エンジンに同じ音声を同時に送り、{ mai: result, eleven: result } を返す
export async function runBatch({ config, clip, lang, container }) {
  const keys = Object.keys(TARGETS).filter((k) => config[k]?.configured);
  const results = await Promise.all(keys.map((k) => runOne(k, config[k], clip, lang, container)));
  return Object.fromEntries(keys.map((k, i) => [k, results[i]]));
}
