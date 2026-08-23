# Aide — 自分の家で動かすAI生活アシスタント

自然言語で目的を伝えると、必要な手段を選んで家電・PC・Webサービスを操作します。
Alexa・スマホ・PCのどこから話しても、同じ会話・同じ記憶が続きます。

```
「リビングの電気つけて」        → 0.7秒で点灯 (AIを経由しない)
「エアコンつけて」             → 室温と外気温から判断し「冷房26度でつけました」
「19時に帰るから快適にしといて」 → 予約し、実行直前に状況を再確認して設定値を調整
「この前調べたやつ何だっけ」     → 過去の会話から答える
```

**自分専用に自宅で動かす前提の構成です。** 誰かが用意したサーバーに繋ぐのではなく、
自分の常駐機（Mac miniまたはRaspberry Pi）・自分のClaudeアカウント・自分の家で完結します。

---

## ⚠️ 使う前に読んでください

**これは単一ユーザー構成です。** 認証を通った人は誰でも、登録された家電すべてを操作できます。
玄関の鍵を繋いだ場合は解錠も含まれます（解錠は既定で承認必須にしていますが、
承認するのも同じアカウントです）。

- パスワードを他人と共有しないでください
- 公開URLで運用する場合、パスワードが唯一の壁です（総当たり対策として15分5回でロックします）
- **不特定多数に使わせる用途には作られていません。** そうしたい場合はマルチユーザー化が必要です

鍵や決済を繋ぐかどうかは、リスクを理解したうえで判断してください。

---

## 何ができるか

| | |
|---|---|
| **家電操作** | Home Assistant経由。明確な指示はAIを経由せず即実行（実測0.7秒） |
| **曖昧な指示** | 「部屋いい感じにして」を室温・外気温・時刻・過去の好みから判断 |
| **予約** | 「19時に帰るから〜」を予約し、実行直前に状況を再確認して設定値を再計算 |
| **状態確認** | 天気・室温・家の状態を1秒以内に音声で回答 |
| **長期記憶** | 会話・好み・操作履歴を横断検索。数か月前の話も引ける |
| **Alexa** | 呼び出し後はセッション維持。「アレクサ」を毎回言わずに会話が続く |
| **PC操作** | shell / ヘッドレスブラウザ（Playwright）/ AppleScript（macOSのみ） |
| **承認フロー** | 決済・送信・解錠はスマホで内容を確認してから実行。文面の修正も可能 |
| **元に戻す** | 家電操作は実行前状態を保存。履歴からワンタップで復元 |

Google（カレンダー・Gmail・連絡先）、LINE、Slackは設定画面から接続できます。

## 設計の要点

**AIをすべての入口にしない。** 「電気つけて」のような明確な指示はルールベースのRouterが
直接Home Assistantへ流します。AIが止まっていても家電は動きます。

**AIは判断が要るときだけ。** 曖昧な指示・複数手順・調べ物・PC操作の計画に限定することで、
利用枠と待ち時間を節約します。

**AI Providerは差し替え可能。** 既定はClaude Code CLI（サブスク枠）。Anthropic API / OpenAI API /
ローカルLLM（Ollama）へ切り替えられます。**有料APIは初期状態でOFF**で、
明示的に有効化するまで課金経路を一切通りません（テストで固定）。

**記憶・設定・履歴は自前で持つ。** Providerを差し替えても失われません。

## 構成

```
Alexa / スマホPWA / PC
      │ HTTPS
  Backend (Railway または自宅の常駐機)
      │ WebSocket（家→サーバーへのoutbound。ルーターのポート開放は不要）
  Agent（自宅の常駐機に常駐 / macOS・Linux）
      ├→ Home Assistant（LAN内）
      ├→ Claude Code CLI
      └→ Playwright / shell /（macOSのみ）AppleScript
```

- `apps/server` — Hono + Drizzle + SQLite。Router / Orchestrator / Tool Registry / Risk Engine / Scheduler
- `apps/web` — Vite + React のPWA
- `apps/mac-agent` — 自宅の常駐エージェント（macOS / Linux 両対応）
- `ops/` — Home Assistant（Docker）、launchd / systemd、Alexaスキル定義

## 必要なもの

- **常時起動のマシン**（Home AssistantとClaude Code CLIが動きます）
  - Mac mini、または **Raspberry Pi 5 / 8GB以上** → [ops/raspberry-pi/README.md](ops/raspberry-pi/README.md)
  - Piの方が家電は速くなります（SwitchBotをBLE直結でき、応答が5秒→1秒未満）。
    ただしPC操作（AppleScript・アプリ起動）はmacOS専用です
- **Claudeのサブスクリプション**（Claude Code CLIが使えること）
- Home Assistantに繋がるスマートホーム機器
- Railwayアカウント（外出先から使う場合。自宅内だけならローカル運用も可）
- Amazon開発者アカウント（Alexaを使う場合。**Echoと同じAmazonアカウント**である必要があります）

> Claudeのサブスクリプションは個人利用に限られます。自分以外の人のリクエストを
> 自分のサブスクで処理することは規約違反です。各自が自分のアカウントで動かしてください。

## はじめ方

```sh
npm install
npm run setup -- <ログインパスワード>   # .env を生成
npm run build
npm start                              # http://localhost:8787
```

Home Assistantの構築、Mac Agentの常駐化、Railwayデプロイ、Alexaスキルの作成は
**[docs/setup.md](docs/setup.md)** に手順があります。

- [docs/architecture.md](docs/architecture.md) — 設計と、実機で判明した制約
- [docs/security.md](docs/security.md) — 権限・承認・秘密情報の扱い
- [docs/alexa-limitations.md](docs/alexa-limitations.md) — Alexa側の制約
- [ops/alexa/README.md](ops/alexa/README.md) — スキル作成手順と落とし穴

## 実機で踏んだ落とし穴

同じ構成を作る人が同じ時間を溶かさないよう、記録しています。

- **Railwayの証明書種別は `Wildcard`。** `Trusted` を選ぶとAlexaが接続せず、サーバーにログすら残りません
- **署名検証は `signature-256`（SHA-256）を使う。** Alexaは `signature`（SHA-1）も送りますが、
  そちらを検証に渡すと100%失敗します
- **Claude CLIには `WebFetch` も許可する。** 無いと検索結果のURLを開けず、調べ物の質が激減します
  （「上映館を全部調べて」で2館→7館の差が出ました）
- **`AMAZON.SearchQuery` はスロット単体の発話を許さない。** 自由発話を受けるにはカスタムスロット型を使います
- **「ありがとう」はStopIntentに明示登録する。** しないとAIに送られ、10秒待たされた挙げ句
  的外れな返事になります
- **呼び出し名に「エーアイ」は使えない。** Alexaが音楽検索と誤認します
- **HAのドメインは種別でなくentity_idから決める。** 赤外線リモコンの照明は `switch.*` なので、
  `light.turn_on` を投げるとHAは200を返しつつ何も実行しません
- **HAは対象がオフラインでも200を返す。** 応答内容を確認しないと「つけました」と嘘をつきます

詳細は各ドキュメントに書いています。

## 開発

```sh
npm test         # 154件
npm run typecheck
npm run dev:server
npm run dev:web
```

## ライセンス

MIT

**無保証です。** 家電・鍵・決済を扱うため、導入と運用は自己責任でお願いします。
