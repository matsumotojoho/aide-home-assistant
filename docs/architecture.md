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
- **schedule**: 時刻表現+家電/快適文脈 → Claudeがtasks.createで予約
- **mac**: PC操作語彙 (家電文脈なし)
- **home_direct**: デバイス・操作が一意に決まるON/OFF/温度指定 → 即実行
- **home_ambiguous**: 家電文脈だが曖昧 (「いい感じ」「ちょっと暗く」) → Claude
- **consult**: それ以外 → Claude

デバイス解決は `devices` テーブル (entity_id / 日本語名 / 部屋 / 種別 / エイリアス) を使用。部屋省略時は `router.default_room` 設定で補完。

### LLM Provider abstraction (`src/llm/`)
`LlmProvider` インターフェース (`available()` / `complete()`) の実装:

| Provider | 用途 | 課金 |
|---|---|---|
| `claude-cli-local` | Backendと同一マシンに公式Claude Code CLIがある場合。`claude -p --output-format json` (非対話モード) | サブスク枠 |
| `claude-via-mac` | Railway実行時。Mac Agent経由でMac mini上のClaude CLIを呼ぶ | サブスク枠 |
| `anthropic-api` | 設定でONにした場合のみ | 従量 (初期OFF) |

`auto` 選択はローカルCLI → Mac Agent経由の順。**有料APIへは自動フォールバックしない**。
非公式API・セッションCookie抜き取り・認証迂回・利用制限回避は行わない。CLIフラグ仕様が変わった場合は `claudeCli.ts` / mac-agentの `llmComplete` を更新する。

### Orchestrator (`src/orchestrator.ts`)
Claudeとの対話はJSONプロトコル (Provider非依存):
```
{"type":"tool_calls","calls":[{"tool":"home.execute","input":{...}}]}
{"type":"final","speak":"...","save_memory":[...]}
```
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

- **Phase 1 (実装済み)**: Backend / PWA (Chat・Home・Tasks・History・Memory・Settings・Permissions) / SQLite / Claude接続 (Provider abstraction) / Router / Mac Agent基本通信 / HA導入 / 家電ON/OFF / 会話・操作履歴 / 設定 / Web Push / 承認フロー / Undo / スケジューラ / ChatGPTインポート(基本)
- **Phase 2**: Alexa Custom Skill (マルチターン) / 学習の高度化 / 繰り返しタスク / 通知詳細設定
- **Phase 3**: Google Calendar / Gmail / Contacts / Messaging (LINE等) / Playwright / AI専用macOSユーザー / 高度な権限ルール
- **Phase 4**: Codex連携 / ローカルLLM / 有料APIフォールバック / マルチユーザー / セマンティック記憶
