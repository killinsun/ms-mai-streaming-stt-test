// 簡易 CER (文字誤り率)。記号を除き、算用数字を漢数字にそろえてから編集距離を取る。
// 送り仮名の違いや人名の漢字の違いまでは吸収しないので、画面の値は目安。

const D_KANJI = "〇一二三四五六七八九";

function under10000(n) {
  let s = "";
  for (const [unit, c] of [[1000, "千"], [100, "百"], [10, "十"]]) {
    const d = Math.floor(n / unit) % 10;
    if (d) s += (d === 1 ? "" : D_KANJI[d]) + c;
  }
  return n % 10 ? s + D_KANJI[n % 10] : s;
}

function toKanjiNumber(digits) {
  // 先頭が 0 の数字列 (電話番号など) は 1 桁ずつ読む
  if (digits.length > 1 && digits[0] === "0") return [...digits].map((d) => D_KANJI[d]).join("");
  const n = Number(digits);
  if (n === 0) return "〇";
  if (!Number.isSafeInteger(n)) return digits;
  let s = "";
  for (const [unit, c] of [[1e12, "兆"], [1e8, "億"], [1e4, "万"]]) {
    const q = Math.floor(n / unit) % 10000;
    if (q) s += under10000(q) + c;
  }
  return s + under10000(n % 10000);
}

export function normalizeForCer(text) {
  return (text ?? "")
    .normalize("NFKC")
    .replace(/%/g, "パーセント")
    .replace(/(\d)\s*(mm|cm|km)/g, (_, d, u) => d + { mm: "ミリ", cm: "センチ", km: "キロ" }[u])
    .replace(/(\d),(?=\d{3})/g, "$1")
    .replace(/(\d)\.(\d)/g, "$1点$2")
    // 電話番号のようなハイフン区切りの数字列は 1 桁ずつ読む
    .replace(/\d+(?:-\d+)+/g, (m) => [...m.replace(/-/g, "")].map((d) => D_KANJI[d]).join(""))
    .replace(/\d+/g, toKanjiNumber)
    .replace(/[\s、。，．,.!?！？「」『』（）()［］[\]・\-—…:：;；"'“”‘’]/g, "");
}

export function editDistance(a, b) {
  let prev = Int32Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Int32Array(b.length + 1);
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function cer(reference, hypothesis) {
  if (hypothesis == null) return null;
  const r = [...normalizeForCer(reference)];
  return r.length ? editDistance(r, [...normalizeForCer(hypothesis)]) / r.length : null;
}
