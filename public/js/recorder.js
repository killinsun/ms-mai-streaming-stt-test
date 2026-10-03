import { SAMPLE_RATE } from "./util.js";

const CHUNK_SAMPLES = 320; // 20ms

const workletSrc = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("capture", Capture);`;

// ---------- ブラウザ側の発話判定 (全エンジン共通の時刻基準) ----------
export const vad = { lastVoiceAt: null, uttStart: null, uttId: 0, threshold: 0.015, silenceMs: 800 };

function updateVad(rms, now) {
  if (rms < vad.threshold) return false;
  if (vad.lastVoiceAt == null || now - vad.lastVoiceAt >= vad.silenceMs) {
    vad.uttId++;
    vad.uttStart = now;
  }
  vad.lastVoiceAt = now;
  return true;
}

// 直近 60ms 以上無音なら、発話が終わってから何 ms 経ったかを返す
export const sinceVoiceEnd = (now) =>
  vad.lastVoiceAt != null && now - vad.lastVoiceAt >= 60 ? now - vad.lastVoiceAt : null;

// マイクを開き、20ms ごとの PCM16 チャンクを onChunk(chunk, now) に渡す。
// onLevel(rms, voiced) はレベルメーター用。
export async function openMic({ onChunk, onLevel }) {
  Object.assign(vad, { lastVoiceAt: null, uttStart: null, uttId: 0 });
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([workletSrc], { type: "application/javascript" })));
  const node = new AudioWorkletNode(ctx, "capture");
  ctx.createMediaStreamSource(stream).connect(node);

  let pending = new Int16Array(CHUNK_SAMPLES);
  let pendingLen = 0;
  let peak = 0;

  node.port.onmessage = ({ data: f32 }) => {
    let sum = 0;
    for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
    peak = Math.max(peak, Math.sqrt(sum / f32.length));
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      pending[pendingLen++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (pendingLen === CHUNK_SAMPLES) {
        const now = performance.now();
        onLevel?.(peak, updateVad(peak, now));
        onChunk(pending, now);
        pending = new Int16Array(CHUNK_SAMPLES);
        pendingLen = 0;
        peak = 0;
      }
    }
  };

  return {
    async close() {
      node.port.onmessage = null;
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
      onLevel?.(0, false);
      // 20ms に満たない末尾も返す
      return pendingLen ? pending.slice(0, pendingLen) : null;
    },
  };
}
