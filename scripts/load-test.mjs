// MAI-Transcribe のレートリミット検証用ロードテスト。
//
//   batch  : MAI-Transcribe-2 (Fast Transcription API) に、段階ごとに req/min を上げながらリクエストを送る。
//            ステップごとに 2xx / 429 / その他 の件数とレイテンシを集計する。
//   stream : MAI-Transcribe-2-Streaming (Realtime API) の同時セッション数を段階的に増やす。
//            各セッションは WAV を実時間ペースで流し、接続拒否・エラー・確定レイテンシを集計する。
//
// 使い方:
//   node --env-file=.env scripts/load-test.mjs batch  --file fixtures/ja-8s.wav [--rpm 60,300,600,900,1200] [--step-seconds 60] --yes
//   node --env-file=.env scripts/load-test.mjs stream --file fixtures/ja-8s.wav [--sessions 5,10,25,50,100] [--hold-seconds 30] --yes
//
// --yes を付けないと、計画と概算料金を表示するだけで実行しない。
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { WebSocket } from "ws";

const { positionals, values: opts } = parseArgs({
  allowPositionals: true,
  options: {
    file: { type: "string" },
    rpm: { type: "string", default: "60,300,600,900,1200" },
    "step-seconds": { type: "string", default: "60" },
    sessions: { type: "string", default: "5,10,25,50,100" },
    "hold-seconds": { type: "string", default: "30" },
    "ramp-ms": { type: "string", default: "2000" },
    "commit-seconds": { type: "string", default: "5" },
    "cooldown-seconds": { type: "string", default: "15" },
    "stop-429-ratio": { type: "string", default: "0.5" },
    lang: { type: "string", default: "ja" },
    yes: { type: "boolean", default: false },
  },
});

const mode = positionals[0];
if (!["batch", "stream"].includes(mode) || !opts.file) {
  console.error("usage: load-test.mjs <batch|stream> --file <16kHz mono PCM16 wav> [--yes]");
  process.exit(2);
}

const env = (k, d = "") => (process.env[k] ?? d).trim();
const API_KEY = env("AZURE_API_KEY");
const ORIGIN = new URL(env("AZURE_MAI_ENDPOINT")).origin;
const SPEECH_ORIGIN = env("AZURE_SPEECH_ENDPOINT")
  ? new URL(env("AZURE_SPEECH_ENDPOINT")).origin
  : ORIGIN.replace(".services.ai.azure.com", ".cognitiveservices.azure.com");
const DEPLOYMENT = env("AZURE_MAI_STREAMING_DEPLOYMENT", "MAI-Transcribe-2-Streaming");
const PRICE_BATCH = Number(env("PRICE_MAI_BATCH_PER_HOUR", "0.10"));
const PRICE_STREAM = Number(env("PRICE_MAI_PER_HOUR", "0.54"));

const list = (s) => s.split(",").map(Number).filter((n) => n > 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};

// ---------- WAV ----------
function parseWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("WAV ではありません");
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      fmt = { channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    } else if (id === "data") {
      if (!fmt) throw new Error("fmt チャンクがありません");
      return { ...fmt, pcm: buf.subarray(off + 8, off + 8 + size) };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("data チャンクがありません");
}

const wavBuf = await readFile(opts.file);
const wav = parseWav(wavBuf);
const audioSeconds = wav.pcm.length / (wav.rate * wav.channels * (wav.bits / 8));

// ---------- 結果ファイル ----------
await mkdir(new URL("../results/", import.meta.url), { recursive: true });
const outPath = new URL(`../results/${new Date().toISOString().replace(/[:.]/g, "-")}-${mode}.jsonl`, import.meta.url);
const record = (obj) => appendFile(outPath, JSON.stringify(obj) + "\n");

// ---------- batch ----------
async function batchRequest(step, i) {
  const form = new FormData();
  form.append("audio", new Blob([wavBuf], { type: "audio/wav" }), "audio.wav");
  form.append(
    "definition",
    JSON.stringify({ enhancedMode: { enabled: true, model: "MAI-Transcribe-2" }, ...(opts.lang ? { locales: [opts.lang] } : {}) }),
  );
  const t0 = performance.now();
  const r = { mode: "batch", step, i, startedAt: new Date().toISOString() };
  try {
    const res = await fetch(`${SPEECH_ORIGIN}/speechtotext/transcriptions:transcribe?api-version=2025-10-15`, {
      method: "POST",
      headers: { "Ocp-Apim-Subscription-Key": API_KEY },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    r.status = res.status;
    r.retryAfter = res.headers.get("retry-after");
    r.region = res.headers.get("x-ms-region");
    if (!res.ok) r.body = text.slice(0, 300);
  } catch (e) {
    r.status = 0;
    r.error = String(e.message ?? e);
  }
  r.latencyMs = Math.round(performance.now() - t0);
  await record(r);
  return r;
}

async function runBatch() {
  const steps = list(opts.rpm);
  const stepSec = Number(opts["step-seconds"]);
  const total = steps.reduce((a, rpm) => a + Math.round((rpm * stepSec) / 60), 0);
  console.log(`MAI-Transcribe-2 batch: ${SPEECH_ORIGIN}`);
  console.log(`音声 ${audioSeconds.toFixed(1)}s / ステップ ${steps.join(" → ")} req/min × ${stepSec}s / 合計 ${total} リクエスト`);
  console.log(`概算料金: $${((total * audioSeconds) / 3600 * PRICE_BATCH).toFixed(3)} (単価 $${PRICE_BATCH}/h)`);
  if (!opts.yes) return console.log("\n--yes を付けると実行します");

  const summaries = [];
  for (const rpm of steps) {
    const n = Math.round((rpm * stepSec) / 60);
    const interval = 60_000 / rpm;
    const start = performance.now();
    const inflight = [];
    process.stdout.write(`\n[${rpm} req/min] 送信中 `);
    for (let i = 0; i < n; i++) {
      await sleep(start + i * interval - performance.now());
      inflight.push(batchRequest(rpm, i));
      if (i % Math.max(1, Math.round(n / 20)) === 0) process.stdout.write(".");
    }
    const results = await Promise.all(inflight);
    const ok = results.filter((r) => r.status >= 200 && r.status < 300);
    const throttled = results.filter((r) => r.status === 429);
    const s = {
      "req/min": rpm,
      sent: n,
      "2xx": ok.length,
      "429 件数": throttled.length,
      other: n - ok.length - throttled.length,
      "p50 ms": pct(ok.map((r) => r.latencyMs), 50),
      "p95 ms": pct(ok.map((r) => r.latencyMs), 95),
      "retry-after": [...new Set(throttled.map((r) => r.retryAfter).filter(Boolean))].join(",") || "-",
    };
    summaries.push(s);
    console.log("");
    console.table([s]);
    const others = results.filter((r) => r.status !== 429 && (r.status < 200 || r.status >= 300));
    if (others.length) console.log("  その他のエラー例:", others.slice(0, 3).map((r) => `${r.status} ${r.error ?? r.body ?? ""}`));
    if (throttled.length) console.log("  429 の例:", throttled[0].body);
    if (throttled.length / n >= Number(opts["stop-429-ratio"])) {
      console.log(`  429 が ${Math.round((throttled.length / n) * 100)}% に達したので打ち切ります`);
      break;
    }
    await sleep(Number(opts["cooldown-seconds"]) * 1000);
  }
  console.log("\n=== まとめ ===");
  console.table(summaries);
}

// ---------- stream ----------
function runSession(step, id, holdSec) {
  const commitBytes = wav.rate * 2 * Number(opts["commit-seconds"]);
  const chunkBytes = (wav.rate * 2) / 10; // 100ms
  const r = { mode: "stream", step, id, startedAt: new Date().toISOString(), commits: [], errors: [] };
  const t0 = performance.now();

  return new Promise((resolve) => {
    let done = false;
    const finish = async (reason) => {
      if (done) return;
      done = true;
      r.endReason = reason;
      r.totalMs = Math.round(performance.now() - t0);
      try { ws.close(); } catch {}
      await record(r);
      resolve(r);
    };
    const url = `${ORIGIN.replace("https://", "wss://")}/mai/v1/realtime?intent=transcription`;
    const ws = new WebSocket(url, { headers: { "api-key": API_KEY } });
    const pendingCommits = [];

    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        r.handshakeStatus = res.statusCode;
        r.retryAfter = res.headers["retry-after"];
        r.errors.push(body.slice(0, 300));
        finish("handshake_rejected");
      });
    });
    ws.on("error", (e) => { r.errors.push(String(e.message ?? e)); finish("socket_error"); });
    ws.on("close", (code, reason) => { r.closeCode = code; r.closeReason = reason.toString(); finish(done ? r.endReason : "closed_by_server"); });

    const stream = async () => {
      const start = performance.now();
      let sent = 0;
      let sinceCommit = 0;
      let pos = 0;
      const totalBytes = Math.round(wav.rate * 2 * holdSec);
      while (sent < totalBytes && !done) {
        // WAV をループさせて hold-seconds 分を実時間ペースで流す
        const end = Math.min(pos + chunkBytes, wav.pcm.length);
        const chunk = wav.pcm.subarray(pos, end);
        pos = end >= wav.pcm.length ? 0 : end;
        ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: chunk.toString("base64") }));
        sent += chunk.length;
        sinceCommit += chunk.length;
        if (sinceCommit >= commitBytes) {
          sinceCommit = 0;
          pendingCommits.push(performance.now());
          ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        }
        await sleep(start + (sent / (wav.rate * 2)) * 1000 - performance.now());
      }
      if (done) return;
      if (sinceCommit) {
        // API は 100ms 未満のバッファの commit を拒否するので無音で埋める
        const minBytes = (wav.rate * 2) / 10;
        if (sinceCommit < minBytes) {
          ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: Buffer.alloc(minBytes - sinceCommit).toString("base64") }));
        }
        pendingCommits.push(performance.now());
        ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      }
      const deadline = performance.now() + 30_000;
      while (pendingCommits.length && !done && performance.now() < deadline) await sleep(50);
      finish(pendingCommits.length ? "final_timeout" : "ok");
    };

    ws.on("message", (data) => {
      const ev = JSON.parse(data.toString());
      switch (ev.type) {
        case "session.created":
          r.createdMs = Math.round(performance.now() - t0);
          ws.send(JSON.stringify({
            type: "session.update",
            session: {
              type: "transcription",
              audio: { input: {
                format: { type: "audio/pcm", rate: wav.rate },
                transcription: { model: DEPLOYMENT, language: opts.lang || null },
                turn_detection: null, noise_reduction: null,
              } },
            },
          }));
          break;
        case "session.updated":
          r.readyMs = Math.round(performance.now() - t0);
          stream();
          break;
        case "conversation.item.input_audio_transcription.completed": {
          const at = pendingCommits.shift();
          if (at != null) r.commits.push(Math.round(performance.now() - at));
          break;
        }
        case "error":
        case "conversation.item.input_audio_transcription.failed":
          r.errors.push(JSON.stringify(ev.error ?? ev).slice(0, 300));
          break;
      }
    });
  });
}

async function runStream() {
  const steps = list(opts.sessions);
  const holdSec = Number(opts["hold-seconds"]);
  if (wav.rate !== 16000 && wav.rate !== 24000) throw new Error(`サンプルレートは 16000/24000 のみ (${wav.rate})`);
  if (wav.channels !== 1 || wav.bits !== 16) throw new Error("モノラル PCM16 の WAV が必要です");
  const totalSec = steps.reduce((a, n) => a + n * holdSec, 0);
  console.log(`MAI-Transcribe-2-Streaming: ${ORIGIN} / deployment=${DEPLOYMENT}`);
  console.log(`同時セッション ${steps.join(" → ")} × ${holdSec}s (各ステップ開始を ${opts["ramp-ms"]}ms に分散)`);
  console.log(`送信音声 合計 ${(totalSec / 60).toFixed(1)} 分 / 概算料金: $${(totalSec / 3600 * PRICE_STREAM).toFixed(3)} (単価 $${PRICE_STREAM}/h)`);
  if (!opts.yes) return console.log("\n--yes を付けると実行します");

  const summaries = [];
  for (const n of steps) {
    process.stdout.write(`\n[${n} 同時セッション] 実行中…`);
    const rampMs = Number(opts["ramp-ms"]);
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) => sleep((rampMs * i) / n).then(() => runSession(n, i, holdSec))),
    );
    const ok = results.filter((r) => r.endReason === "ok");
    const rejected = results.filter((r) => r.endReason === "handshake_rejected");
    const s = {
      sessions: n,
      ok: ok.length,
      rejected: rejected.length,
      "other fail": n - ok.length - rejected.length,
      "ready p50 ms": pct(results.filter((r) => r.readyMs).map((r) => r.readyMs), 50),
      "ready p95 ms": pct(results.filter((r) => r.readyMs).map((r) => r.readyMs), 95),
      "commit→final p50": pct(results.flatMap((r) => r.commits), 50),
      "commit→final p95": pct(results.flatMap((r) => r.commits), 95),
    };
    summaries.push(s);
    console.log("");
    console.table([s]);
    const codes = [...new Set(rejected.map((r) => r.handshakeStatus))];
    if (rejected.length) console.log(`  接続拒否 status=${codes.join(",")} 例:`, rejected[0].errors[0]);
    const failed = results.filter((r) => r.endReason !== "ok" && r.endReason !== "handshake_rejected");
    if (failed.length) console.log("  その他の失敗例:", failed.slice(0, 3).map((r) => `${r.endReason} close=${r.closeCode ?? "-"} ${r.errors[0] ?? r.closeReason ?? ""}`));
    if ((n - ok.length) / n >= Number(opts["stop-429-ratio"])) {
      console.log(`  失敗が ${Math.round(((n - ok.length) / n) * 100)}% に達したので打ち切ります`);
      break;
    }
    await sleep(Number(opts["cooldown-seconds"]) * 1000);
  }
  console.log("\n=== まとめ ===");
  console.table(summaries);
}

if (!API_KEY || !env("AZURE_MAI_ENDPOINT")) {
  console.error(".env に AZURE_API_KEY / AZURE_MAI_ENDPOINT を設定してください");
  process.exit(2);
}
await (mode === "batch" ? runBatch() : runStream());
if (opts.yes) console.log(`\n詳細: ${outPath.pathname}`);
