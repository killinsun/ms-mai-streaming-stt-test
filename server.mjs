// API キーをブラウザに渡さないためのローカルサーバー。
//   GET  /                   … public/ 以下の静的ファイル
//   GET  /api/config         … 料金・モデル名など画面に必要な設定
//   POST /api/batch/<engine> … 音声ファイルを各社のバッチ API へ転送
//   POST /api/runs/<id>.json|.wav … ベンチマーク結果と録音を results/runs/ に保存
//   WS   /ws/<engine>        … 各社のリアルタイム API へ双方向に中継
import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, normalize } from "node:path";
import { WebSocket, WebSocketServer } from "ws";

const env = (k, d = "") => (process.env[k] ?? d).trim();
const origin = (url) => (url ? new URL(url).origin : "");

const AZURE_API_KEY = env("AZURE_API_KEY");
// /api/projects/... 付きのプロジェクト URL が渡されてもリソースのルートだけを使う
const MAI_ENDPOINT = origin(env("AZURE_MAI_ENDPOINT"));
const SPEECH_ENDPOINT =
  origin(env("AZURE_SPEECH_ENDPOINT")) || MAI_ENDPOINT.replace(".services.ai.azure.com", ".cognitiveservices.azure.com");
const ELEVENLABS_API_KEY = env("ELEVENLABS_API_KEY");
const PORT = Number(env("PORT", "3000"));

const config = {
  mai: {
    configured: Boolean(AZURE_API_KEY && MAI_ENDPOINT),
    model: env("AZURE_MAI_STREAMING_DEPLOYMENT", "MAI-Transcribe-2-Streaming"),
    pricePerHour: Number(env("PRICE_MAI_PER_HOUR", "0.54")),
    batchModel: env("AZURE_MAI_BATCH_MODEL", "MAI-Transcribe-2"),
    batchPricePerHour: Number(env("PRICE_MAI_BATCH_PER_HOUR", "0.10")),
  },
  eleven: {
    configured: Boolean(ELEVENLABS_API_KEY),
    model: env("ELEVENLABS_MODEL", "scribe_v2_realtime"),
    pricePerHour: Number(env("PRICE_ELEVENLABS_PER_HOUR", "0.39")),
    batchModel: env("ELEVENLABS_BATCH_MODEL", "scribe_v2"),
    batchPricePerHour: Number(env("PRICE_ELEVENLABS_BATCH_PER_HOUR", "0.22")),
  },
};

// ---------- リアルタイム API の接続先 ----------
const realtime = {
  mai: () => ({
    url: `${MAI_ENDPOINT.replace("https://", "wss://")}/mai/v1/realtime?intent=transcription`,
    headers: { "api-key": AZURE_API_KEY },
  }),
  // 確定までの無音秒数は画面の設定に合わせる (MAI 側はブラウザで同じ秒数を検出して commit する)
  eleven: (params) => {
    const u = new URL("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
    u.searchParams.set("model_id", config.eleven.model);
    u.searchParams.set("audio_format", "pcm_16000");
    u.searchParams.set("commit_strategy", "vad");
    u.searchParams.set("vad_silence_threshold_secs", params.get("silence") || "0.8");
    if (params.get("lang")) u.searchParams.set("language_code", params.get("lang"));
    return { url: u.toString(), headers: { "xi-api-key": ELEVENLABS_API_KEY } };
  },
};

// ---------- バッチ API ----------
// 条件をそろえるため、どちらもタイムスタンプなしで呼ぶ (ElevenLabs は音声イベントのタグもなし)
const batch = {
  mai: (audio, params) => {
    const definition = { enhancedMode: { enabled: true, model: config.mai.batchModel } };
    if (params.get("lang")) definition.locales = [params.get("lang")];
    const form = new FormData();
    form.append("audio", audio, params.get("filename") || "audio.wav");
    form.append("definition", JSON.stringify(definition));
    return fetch(`${SPEECH_ENDPOINT}/speechtotext/transcriptions:transcribe?api-version=2025-10-15`, {
      method: "POST",
      headers: { "Ocp-Apim-Subscription-Key": AZURE_API_KEY },
      body: form,
    });
  },
  eleven: (audio, params) => {
    const form = new FormData();
    form.append("model_id", config.eleven.batchModel);
    form.append("file", audio, params.get("filename") || "audio.wav");
    form.append("timestamps_granularity", "none");
    form.append("tag_audio_events", "false");
    if (params.get("lang")) form.append("language_code", params.get("lang"));
    return fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
      body: form,
    });
  },
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

const sendJson = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function handleBatch(name, req, res, params) {
  const audio = new Blob([await readBody(req)], { type: req.headers["content-type"] || "audio/wav" });
  if (!config[name].configured) return sendJson(res, 400, { status: 400, body: { error: `${name} の認証情報が未設定です` } });
  const started = performance.now();
  const upstream = await batch[name](audio, params);
  const text = await upstream.text();
  const serverMs = performance.now() - started;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  sendJson(res, 200, { status: upstream.status, serverMs, region: upstream.headers.get("x-region"), body });
}

// ---------- 静的ファイル ----------
const PUBLIC_DIR = new URL("./public/", import.meta.url);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

async function serveStatic(pathname, res) {
  const path = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const type = TYPES[extname(path)];
  if (!type) return res.writeHead(404).end();
  try {
    const body = await readFile(new URL(`.${path}`, PUBLIC_DIR));
    res.writeHead(200, { "content-type": `${type}; charset=utf-8` });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/api/config") {
      sendJson(res, 200, config);
    } else if (req.method === "POST" && /^\/api\/batch\/(mai|eleven)$/.test(url.pathname)) {
      await handleBatch(url.pathname.split("/").pop(), req, res, url.searchParams);
    } else if (req.method === "POST" && /^\/api\/runs\/[\w-]+\.(json|wav)$/.test(url.pathname)) {
      const dir = new URL("./results/runs/", import.meta.url);
      await mkdir(dir, { recursive: true });
      const file = new URL(url.pathname.slice("/api/runs/".length), dir);
      await writeFile(file, await readBody(req));
      sendJson(res, 200, { path: file.pathname });
    } else if (req.method === "GET") {
      await serveStatic(url.pathname, res);
    } else {
      res.writeHead(404).end();
    }
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: String(e) });
  }
});

// ---------- WebSocket 中継 ----------
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  const name = url.pathname.replace(/^\/ws\//, "");
  if (!realtime[name]) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (client) => relay(client, name, url.searchParams));
});

function relay(client, name, params) {
  const sendError = (message) => {
    if (client.readyState !== WebSocket.OPEN) return;
    client.send(JSON.stringify({ type: "error", message_type: "error", error: { message } }));
    client.close();
  };
  if (!config[name].configured) return sendError(`${name} の認証情報が未設定です`);

  const { url, headers } = realtime[name](params);
  const upstream = new WebSocket(url, { headers });
  const pending = [];

  upstream.on("open", () => {
    for (const m of pending) upstream.send(m);
    pending.length = 0;
  });
  upstream.on("message", (data) => client.readyState === WebSocket.OPEN && client.send(data.toString()));
  upstream.on("unexpected-response", (_req, r) => {
    let body = "";
    r.on("data", (c) => (body += c));
    r.on("end", () => sendError(`upstream ${r.statusCode}: ${body}`));
  });
  upstream.on("error", (e) => sendError(String(e)));
  upstream.on("close", () => client.close());

  client.on("message", (data) => {
    const m = data.toString();
    if (upstream.readyState === WebSocket.OPEN) upstream.send(m);
    else pending.push(m);
  });
  client.on("close", () => upstream.close());
}

server.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
  for (const [name, c] of Object.entries(config)) {
    console.log(`  ${name}: ${c.configured ? `${c.model} / ${c.batchModel}` : "未設定 (.env を確認)"}`);
  }
});
