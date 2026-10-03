#!/usr/bin/env bash
# ロードテスト用の日本語音声 (16kHz モノラル PCM16 WAV) を macOS の say で作る。
# 合成音声は再配布せず、各自の環境で生成する。
set -euo pipefail
out="${1:-fixtures/ja-8s.wav}"
mkdir -p "$(dirname "$out")"
tmp="$(mktemp -t fixture).aiff"
say -v Kyoko -o "$tmp" "今日は営業企画部の長谷川さんについてお話しします。会議は十月二日の午後三時からです。"
afconvert -f WAVE -d LEI16@16000 -c 1 "$tmp" "$out"
rm -f "$tmp"
echo "created: $out"
