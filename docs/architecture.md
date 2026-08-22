# Aide アーキテクチャ

自分専用AI生活アシスタント。自然言語で目的を伝えると、必要な手段を選び、家電・PC・Webサービスを操作するパーソナルAIエージェント。

## 全体像

```
Alexa (Phase 2)     スマホPWA        PC Web
     │                  │              │
     └──────────────────┴──────┬───────┘
                               │ HTTPS
                      ┌────────▼────────┐
                      │ Aide Backend    │  Railway (またはMac miniローカル)
                      │  - Router       │  Node.js + TypeScript + Hono
                      │  - Orchestrator │  SQLite (Drizzle ORM)
                      │  - Tool Registry│
                      │  - Risk Engine  │
                      │  - Scheduler    │
                      │  - Memory (FTS5)│
                      └───┬────────┬────┘
              Outbound WS │        │ LLM Provider abstraction
        ┌─────────────────▼──┐   ┌─▼──────────────────────────┐
        │ Mac Agent (常駐)    │   │ 1. Claude Code CLI (local) │
        │  - shell/AppleScript│   │ 2. Claude via Mac Agent    │
        │  - GUI queue        │   │ 3. Anthropic API (初期OFF) │
        │  - Claude CLIブリッジ │   │ 4. OpenAI API (初期OFF)    │
        │  - HAプロキシ        │   └────────────────────────────┘
        └──────┬─────────────┘
               │ LAN
        ┌──────▼──────────┐
        │ Home Assistant  │  Mac mini上のDocker (colima)
        │  統一家電レイヤー  │
        └──┬────┬────┬────┘
      SwitchBot IKEA エアコン/照明/テレビ/今後の機器
```

## 設計原則 (仕様書より)

1. **入口と実行機能の分離** — Alexa/PWA/PCはすべて同一Backendの同一ユーザー・記憶・設定を使う。Alexaは「耳と口」。
2. **家電操作は高速** — Routerが明確な命令 (「電気つけて」「エアコン26度」) をルールベースで判定し、Claudeを経由せずHome Assistantへ即実行 (目標1〜2秒)。Claude停止時も動作する。
3. **複雑な判断はClaude** — 曖昧・文脈依存・複数手順・検索・PC操作計画はClaudeが担当。Context Builderが必要情報だけを組み立てて利用枠を節約。
4. **記憶・設定・履歴は自前管理** — SQLite (Railway Persistent Volume)。AI Providerを差し替えても記憶は失われない。
5. **勝手に仕事を始めない** — 新しい仕事はユーザー指示時のみ。例外はユーザーが依頼した予約タスクの継続実行 (実行直前の再評価を含む)。
6. **ほぼすべての設定は後から変更可能** — settingsテーブル + PWA設定画面。
7. **有料APIは初期OFF** — `ai.paid_api_fallback=off` の間、課金経路は一切使われない。

## コンポーネント

### Router (`src/router/classifier.ts`)
純関数のルールベース分類器。判定順:
- **status**: 天気・室温・湿度・時刻・家の状態の問い合わせ → Claudeを使わず即答 (0.3〜1秒)
  Claude CLIはプロセス起動を伴い9〜12秒かかりAlexaの8秒制限に収まらないため、
  頻出の問い合わせはここで捌く。ただし「明日の天気」等の予報は現在値で答えられないのでClaudeへ回す
- **schedule**: 時刻表現+家電/快適文脈 → Claudeがtasks.createで予約
- **mac**: PC操作語彙 (家電文脈なし)
- **home_direct**: デバイス・操作が一意に決まるON/OFF/温度指定 → 即実行
- **home_ambiguous**: 家電文脈だが曖昧 (「いい感じ」「ちょっと暗く」) → Claude
- **consult**: それ以外 → Claude

デバイス解決は `devices` テーブル (entity_id / 日本語名 / 部屋 / 種別 / エイリアス) を使用。部屋省略時は `router.default_room` 設定で補完。

重要な制約 (実機検証で判明):
- **HAのドメインは種別ではなく entity_id から決める。** 赤外線リモコン経由の照明は種別=light でも entity_id は `switch.*`。`light.turn_on` を `switch.*` へ投げるとHAは200を返しつつ何も実行しない
- **部屋の指定はエイリアスより優先。** 汎用エイリアス (「電気」等) を特定デバイスに付けると、別部屋の指示がそれに吸われる
- **同じ部屋・同じドメインの複数台はまとめて1回で操作する** (例: リビングの照明4灯)。部屋が特定できない場合はまとめずClaudeへ回す
- **無言の失敗を検出する。** HAは対象がオフラインでも200を返すため、応答配列に対象が含まれるかを確認し、含まれなければ状態を取り直して判定する

実測レイテンシ: TRÅDFRI (LAN内) 約90ms / SwitchBot (クラウドAPI) 約5秒。SwitchBotはクラウド往復が必須のため1〜2秒目標を満たせない。ローカル制御にはBLEが必要だが、colimaはVM経由でBluetoothを扱えない (HAOSを別筐体へ移せば解決)。

### Alexa Skill (`src/alexa/skill.ts`)
Alexaは「耳と口」。判断・記憶・実行はBackend側 (仕様書3)。
- 公式の署名検証 (`alexa-verifier`) + タイムスタンプ検証 (150秒)
- `shouldEndSession: false` でセッション維持 → 「アレクサ」なしで会話継続
- **Alexaの8秒制限**: 6秒を超えたら「結果はスマホに通知します」と即答し、
  処理はバックグラウンド継続 → 完了時にWeb Push。
  さらに「さっきの回答教えて」(recall) で口頭でも聞き直せる
- **セッションが切れても会話を引き継ぐ**: Alexaは無応答8秒程度でセッションが切れ、
  話しかけ直すと別sessionIdになる。sessionId対応付け (プロセス内・TTL 30分) が無い場合は
  直近30分のAlexa会話を続けるため、「寝室もお願い」「さっきの回答教えて」が
  セッションをまたいでも成立する
- 呼び出し名が発話に混ざることがあるため `normalizeAlexaQuery` で除去する
  (呼び出し名を変えたら `INVOCATION_ALIASES` も更新)
- 読み上げ長は `alexa.verbosity` に従って文単位で切る

### 統合タイムライン (`GET /api/messages/recent`)
仕様書2「Alexa、スマホ、PCのどこから話しても同じユーザー・同じ記憶・同じ設定」に対応し、
PWAのChatは入口をまたいだ1本のタイムラインを表示する。

- Alexaが8秒で打ち切ってバックグラウンドで書いた回答も、ここに後から現れる
- Chatは8秒ごと + 画面復帰時にポーリングするので、開いたまま待てば表示される
- 各メッセージに `source` を返し、画面ではAlexa由来にタグを出す
- PWAから送信するとき、直近30分の会話があれば入口に関わらず引き継ぐ
  (Alexaで話した直後にPWAで続けても文脈が切れない)

### LLM Provider abstraction (`src/llm/`)
`LlmProvider` インターフェース (`available()` / `complete()`) の実装:

| Provider | 用途 | 課金 |
|---|---|---|
| `claude-cli-local` | Backendと同一マシンに公式Claude Code CLIがある場合。`claude -p --output-format json` (非対話モード) | サブスク枠 |
| `claude-via-mac` | Railway実行時。Mac Agent経由でMac mini上のClaude CLIを呼ぶ | サブスク枠 |
| `anthropic-api` | 設定でONにした場合のみ | 従量 (初期OFF) |
| `openai-api` | 設定でONにした場合のみ | 従量 (初期OFF) |
| `local-llm` | Ollama互換API。モデル名を設定した場合のみ | 無料 |

`auto` 選択はローカルCLI → Mac Agent経由 → ローカルLLM の順。**有料APIへは自動フォールバックしない**(テストで固定)。
非公式API・セッションCookie抜き取り・認証迂回・利用制限回避は行わない。CLIフラグ仕様が変わった場合は `claudeCli.ts` / mac-agentの `llmComplete` を更新する。

### Orchestrator (`src/orchestrator.ts`)
Claudeとの対話はJSONプロトコル (Provider非依存):
```
{"type":"tool_calls","calls":[{"tool":"home.execute","input":{...}}]}
{"type":"final","speak":"...","save_memory":[...]}
```
`tool_calls` に `speak` を添えると、全ツール成功時はその文をそのまま返してLLMへの往復を省く。
LLM 1回あたり8〜10秒かかるため、これで曖昧な指示の応答が約半分になる。失敗があった場合は
結果を渡して考え直させる。

最大6イテレーションのツールループ。Context Builderは System policy / 現在時刻 / 登録デバイス / 関連記憶 (FTS検索) / 直近会話 / 予約タスク / ユーザー依頼のみを送る (全履歴は送らない)。

Anthropic API Provider有効時はネイティブtool_useへの置き換えが可能な構造 (Provider内で変換)。

### Tool Registry (`src/tools/`)
プラグイン構造。`register()` でツール追加。各ツールはzodスキーマ+実行関数。
実行パイプライン: **入力検証 → Risk Engine分類 → 権限チェック → (必要なら承認フロー) → 実行 → Undo記録 → actions記録**。

実装済み: `home.get_state` `home.execute` `memory.*` `tasks.*` `web.fetch` `mac.execute` `mac.status` `notification.send` `system.get_context`
スタブ (Phase 3): `calendar.*` `mail.*` `contacts.search` `message.*` — インターフェース固定済み、`tool_connections` で接続管理。
将来: MCP対応を検討 (RegistryをMCPサーバーとして公開 or MCPクライアント化)。

### Risk Engine + Permissions (`src/risk.ts`, `src/services/permissions.ts`)
- 決済/購入/有料契約/送金 → **必ず確認** (初期値always_ask、キーワード検出含む)
- アカウント削除/大量削除/破壊的shell/復元困難/セキュリティ変更 → **原則確認**
- カテゴリごとに `ask_once` (初回だけ確認→以後自動許可) / `always_ask` / `always_allow` / `deny` をPWAから変更可能

承認はスマホPWAに表示 (送信先・内容・[修正][送信][キャンセル])。Face ID必須にしない。AlexaやPCには「スマホで確認してください」のみ返す。

### Undo (`src/undo.ts`)
`home.execute` は実行前状態 (state/温度/モード/明るさ) を `undo_records` に保存。履歴画面の「元に戻す」で復元。取り消せない操作 (送信済みメール等) は明示する。

### Scheduler (`src/scheduler.ts`)
30秒tick。期限到来タスクを実行。`reevaluate=1` のタスクは実行直前にClaudeが `system.get_context` で気温・室温・天気を再確認し設定値を再計算 (=ユーザー依頼タスクの継続実行)。Claude不通時は保存済みプランをそのまま実行。完了/失敗をWeb Push通知 (レベル設定に従う)。

### Mac Agent (`apps/mac-agent/`)
Mac mini常駐。**Mac→BackendへのOutbound WebSocket** (自宅ルーターのポート開放不要)。共有トークンでBearer認証。
- 実行優先順位: API > CLI > バックグラウンドブラウザ(Playwright, Phase 3) > AppleScript > GUI
- 使用中判定: `ioreg` HIDIdleTime (閾値120秒) + 手動モード (`~/.aide/agent-mode`: auto/busy/free、PWA設定からも変更可)
- 人間が使用中のGUI操作はキューに入れ、アイドルになったら実行。CLI/API系は即実行
- `llm.complete`: Claude Code CLIブリッジ / `ha.request`: LAN内HAへのプロキシ (Railwayから家電操作するための経路)
- AI専用macOSユーザーはPhase 3で作成 (GUIセッション制約により人間と完全同時GUI操作は保証しない前提)
- Codex連携 (Phase 4): Mac AgentのRPCメソッド追加でTool Providerとして拡張可能

### データベース (`src/db/`)
SQLite + Drizzle ORM (PostgreSQL移行可能)。UUID主キー、日時は内部UTC / UI表示Asia/Tokyo。
テーブル: users / settings / conversations / messages / memories (+FTS5 trigram) / preferences / devices / tasks / task_runs / actions / undo_records / permissions / approvals / notifications / push_subscriptions / tool_connections。
長期記憶検索はSQLite FTS5 (trigram=日本語対応) + メタデータ。ローカル多言語Embeddingは後から追加できる構造 (memoriesにカラム追加+検索関数差し替え)。Embeddingのための有料APIは使わない。

## 技術選定の理由 (仕様書23/24からの変更点)

| 項目 | 選定 | 理由 |
|---|---|---|
| Backend | Hono (Fastify案のうちHono採用) | 軽量・Web標準・静的配信/WSと相性良 |
| Frontend | **Vite + React SPA** (Next.js推奨から変更) | 単一ユーザーPWAにSSR不要。Backendが静的配信することでRailwayサービス1つに収まり、メモリ・費用・保守を削減 |
| 実行方式 | tsx (ビルドレス) | 小規模構成でビルドパイプラインを省略。型検査は `npm run typecheck` |
| Docker環境 | colima (Docker Desktopでなく) | 無料・軽量・ヘッドレスMac mini常駐向き。CLI管理で保守しやすい |
| 認証 | パスワード+セッションCookie (bcrypt+JWT) | 単一ユーザーで実装コストと安全性のバランス。Google OAuthはPhase 2+で置換可能 (AuthService差し替え) |

## フェーズ計画

- **Phase 1 (完了)**: Backend / PWA (Chat・Home・Tasks・History・Memory・Settings・Permissions) / SQLite / Claude接続 (Provider abstraction) / Router / Mac Agent / HA導入 / 家電操作 / 会話・操作履歴 / Web Push / 承認フロー / Undo / スケジューラ
- **Phase 2 (完了)**: Alexa Custom Skill (署名検証・マルチターン・8秒制限対策) / 繰り返しタスク / 会話の全文検索
- **Phase 3 (完了)**: Google (Calendar・Gmail・Contacts) / メッセージ送信 (LINE・Slack) / バックグラウンドブラウザ (Playwright) / 承認画面の作り込み
- **Phase 4 (完了)**: Codex連携 / ローカルLLM Provider / OpenAI Provider / 課金遮断の保証をテストで固定

残りは接続作業のみ (コード側は完了):
| 項目 | 必要なもの |
|---|---|
| Alexa実運用 | Railwayデプロイ + ASKコンソールでのスキル登録 |
| Google連携 | Google Cloud ConsoleのOAuthクライアントID/シークレット |
| LINE / Slack | 各サービスのアクセストークン |
| Codex / ローカルLLM | `codex` / `ollama` のインストール (任意) |
| AI専用macOSユーザー | macOSでのユーザー作成 (Mac Agentをそのユーザーで起動) |

## 全文検索の実装メモ

SQLite FTS5 (trigram) を messages / memories に張る。実装上の注意:

- **external-content FTS5 では `count(*) FROM xxx_fts` が元テーブルの件数を返す。**
  未構築の検出に使えないため、`aide_meta.fts_version` で再構築を管理する (`FTS_VERSION` を上げると起動時に一度だけ rebuild)
- **複数語のクエリをそのまま渡すとフレーズ検索になり0件になる。**
  語ごとに分割し、AND (絞り込み) → 0件ならOR (拾い上げ) の順で引く
- trigramは3文字未満のクエリで当たらないため、LIKEフォールバックを併用する
