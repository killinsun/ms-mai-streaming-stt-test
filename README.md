# ms-mai-streaming-stt-test

Microsoft の **MAI-Transcribe-2** と ElevenLabs の **Scribe v2** を、日本語の文字起こしで比較するための検証ツールです。

同じマイク音声をリアルタイム API（MAI-Transcribe-2-Streaming / Scribe v2 Realtime）へ同時に送り、録音を止めたら同じ音声をバッチ API（MAI-Transcribe-2 / Scribe v2）にも送ります。1回の録音で4つの結果を並べて、認識結果・所要時間・料金を比べられます。

ほかに、MAI-Transcribe のレートリミットを確かめるロードテストのスクリプトも入っています。

## 必要なもの

- Node.js 22 以上
- Microsoft Foundry のリソースと、`MAI-Transcribe-2-Streaming` のデプロイ
  - リアルタイム版の提供リージョンは Sweden Central / Central US / South India（2026年10月時点）
- ElevenLabs の API キー

どちらか一方のキーだけでも、設定したエンジンだけで動きます。

## セットアップ

```sh
npm install
# 下の表を見て .env を作る
npm start   # http://localhost:3000
```

`.env` に設定する値は次のとおりです。

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `AZURE_API_KEY` | ○ | Foundry リソースの API キー |
| `AZURE_MAI_ENDPOINT` | ○ | `https://<resource>.services.ai.azure.com`（プロジェクトの URL を貼っても可） |
| `AZURE_MAI_STREAMING_DEPLOYMENT` | | リアルタイム版のデプロイ名（既定: `MAI-Transcribe-2-Streaming`） |
| `AZURE_SPEECH_ENDPOINT` | | バッチ版のエンドポイント。省略時は `AZURE_MAI_ENDPOINT` から `https://<resource>.cognitiveservices.azure.com` を組み立てる |
| `ELEVENLABS_API_KEY` | ○ | ElevenLabs の API キー |
| `ELEVENLABS_MODEL` / `ELEVENLABS_BATCH_MODEL` | | 既定: `scribe_v2_realtime` / `scribe_v2` |
| `PRICE_MAI_PER_HOUR` / `PRICE_MAI_BATCH_PER_HOUR` | | 料金の計算に使う単価（USD/音声1時間。既定: 0.54 / 0.10） |
| `PRICE_ELEVENLABS_PER_HOUR` / `PRICE_ELEVENLABS_BATCH_PER_HOUR` | | 同上（既定: 0.39 / 0.22） |
| `PORT` | | 既定: 3000 |

API キーはブラウザに渡さず、ローカルサーバー（`server.mjs`）が各社の API へ中継します。

## 使い方

1. 「文章」で読み上げる文章を選びます。「台本なし」なら自由に話せます。
2. 「● 録音開始」を押して読み上げ、終わったら「■ 停止」を押します。
3. リアルタイム版の結果は話している間に表示され、停止後にバッチ版の結果と、簡易 CER（文字誤り率）・所要時間・料金の表が出ます。

結果と録音は `results/runs/<日時>-<文章ID>.json` と `.wav` に保存されます。台本を読んでいた場合は、終わると次の文章に進みます。

読み上げる文章は `public/scripts.json` にあります。本文中の `{漢字|かな}` は振り仮名として表示され、CER の計算には漢字だけが使われます。

### 計測している値

| 値 | 内容 |
| --- | --- |
| 発話開始→初回部分結果 | 話し始めてから最初の途中結果が届くまで |
| 発話終了→確定 | 話し終えてから確定結果が届くまで |
| commit→確定（MAI のみ） | `input_audio_buffer.commit` を送ってから確定結果が届くまで |
| 停止→最終確定 | 停止ボタンを押してから最後の確定結果が届くまで |
| API 応答時間（バッチ） | ローカルサーバーから API へのリクエスト〜レスポンス完了まで |
| 簡易 CER | 記号を除き、算用数字を漢数字にそろえてから計算した文字誤り率 |

「発話開始」「発話終了」はブラウザ側の音量で判定しているので、目安の値です。

### 条件をそろえるための設定

- MAI のリアルタイム版にはサーバー側の VAD（無音検出）がないため、ブラウザで無音を検出して commit を送ります。ElevenLabs の `vad_silence_threshold_secs` と同じ秒数（画面の「確定までの無音」）を使います。
- バッチ版は、どちらもタイムスタンプなしで呼びます（ElevenLabs は音声イベントのタグもなし）。

## ロードテスト

MAI-Transcribe のレートリミットを確かめるスクリプトです。テスト用の音声は macOS の `say` で作ります。

```sh
npm run fixture                                   # fixtures/ja-8s.wav を作る
npm run load:batch                                # 計画と概算料金だけを表示
npm run load:batch -- --yes                       # 60→300→600→900→1200 req/min を各60秒
npm run load:stream -- --yes                      # 同時 5→10→25→50→100 セッションを各30秒
npm run load:stream -- --sessions 50,100,200 --hold-seconds 60 --yes
```

- batch: MAI-Transcribe-2 に段階的にリクエストを送り、段階ごとに成功・429・その他の件数とレイテンシを表示します。
- stream: MAI-Transcribe-2-Streaming の同時セッション数を段階的に増やし、接続拒否・エラー・確定レイテンシを表示します。
- 失敗率が `--stop-429-ratio`（既定 0.5）以上になった段階で止まります。
- 1件ずつの詳細は `results/*.jsonl` に保存されます。

上限や拒否の判定は Azure のリソースごとです。同じリソースを他のアプリでも使っていると、結果が混ざります。

## ライセンス

MIT
