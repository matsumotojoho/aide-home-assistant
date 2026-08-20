# Aide — 自分専用AI生活アシスタント

自然言語で目的を伝えると、必要な手段を選び、家電・PC・Webサービスを操作するパーソナルAIエージェント。

```
「寝室の電気つけて」        → Router即実行 (Claude不使用、1〜2秒)
「部屋いい感じにして」       → Claudeが室温・好み・時刻から判断して実行
「19時に帰るから快適にして」 → 予約タスク化、実行直前に状況を再確認して調整
「田中さんに遅れると伝えて」 → 文面を作りスマホで承認 (Phase 3)
```

## 構成

- `apps/server` — Backend (Hono + Drizzle + SQLite)。Router / Orchestrator / Tool Registry / Risk Engine / Scheduler / Web Push
- `apps/web` — PWA (Vite + React)。Chat / Home / Tasks / History / Memory / Settings
- `apps/mac-agent` — Mac mini常駐Agent (Outbound WS)。shell/AppleScript実行、GUIキュー、Claude CLIブリッジ、HAプロキシ
- `packages/shared` — 共有型・プロトコル
- `ops/homeassistant` — Home Assistant (Docker/colima)
- `docs/` — [architecture](docs/architecture.md) / [setup](docs/setup.md) / [security](docs/security.md) / [alexa-limitations](docs/alexa-limitations.md)

## クイックスタート

```sh
npm install
npm run setup -- <ログインパスワード>   # .env生成
npm run build                          # PWAビルド
npm start                              # http://localhost:8787
```

Home Assistant / Mac Agent / Railwayデプロイは [docs/setup.md](docs/setup.md) 参照。

## 技術選定と理由

仕様書からの変更点 (詳細は docs/architecture.md):

- **Hono** (推奨候補のうち軽量な方を採用)
- **Vite + React SPA** — Next.js推奨に対し、単一ユーザーPWAにSSRが不要でRailway 1サービスに収めるため変更
- **colima** — Docker Desktopより軽量・無料でヘッドレス常駐向き
- **tsx実行** — 小規模のためビルドレス。型検査は `npm run typecheck`
- **パスワード+セッションCookie認証** — 単一ユーザーの実装コストと安全性のバランス (Google OAuthへ置換可能な構造)

## 原則

- AI Providerは抽象化 (Claude Code CLI → Anthropic API / OpenAI / ローカルLLMへ切替可能)
- 有料APIは初期OFF。ONにするまで課金経路は使われない
- 非公式API・認証迂回・利用制限回避は使用しない
- 家電の明確な操作はClaude障害時も動作する
- すべてのTool実行は履歴に記録され、可能な操作はUndoできる
