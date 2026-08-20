# Aide セキュリティ

## 秘密情報

- `.env` / `ops/homeassistant/config/` / `~/.aide/agent.env` は**コミット禁止** (.gitignore済み)。コミットするのは `.env.example` のみ
- 対象: APIキー / OAuthシークレット / Alexa credentials / HAトークン / Claude credentials / Railway secrets / Cookie / アクセストークン
- 秘密情報をmemories(長期記憶)やプロンプトに書かない — 記憶は将来のコンテキストに再注入されるため

## 認証・通信

- PWA: パスワード (bcrypt cost=12) + HS256署名セッションCookie (httpOnly / SameSite=Lax / 本番Secure / 30日)
- ログイン失敗時500ms遅延 (ブルートフォース抑制)。公開URLはRailwayのHTTPS
- Mac Agent: `AGENT_TOKEN` (32byte乱数) をBearerヘッダで提示、サーバー側は定数時間比較。Mac→サーバーのOutbound WSのみで自宅ポート開放なし
- Home Assistantはローカル専用 (8123を外部公開しない)。Railwayからの家電操作はMac Agent経由

## AI実行の安全装置

1. **Risk Engine**: 決済・購入・契約・送金=必ず確認 / 破壊的操作=原則確認 (ツール入力のキーワード検出含む)
2. **Permissions**: カテゴリ別 ask_once / always_ask / always_allow / deny。設定画面から変更可能
3. **承認フロー**: 承認はスマホPWAのみに出す。内容 (送信先/本文/コマンド) を表示し、修正・キャンセル可能
4. **Undo**: 家電操作は実行前状態を保存。取り消せない操作は明示
5. **実行履歴**: 全Tool実行を actions テーブルに記録 (timestamp/source/tool/target/status/undo/approval)
6. **勝手に開始しない**: 自発的タスク生成なし。schedulerはユーザー作成タスクのみ実行
7. **有料API遮断**: `ai.paid_api_fallback=off` の間、AnthropicApiProvider.available()=false で経路自体が閉じる

## Mac Agent の権限境界 (Phase 1)

- Phase 1は現行ユーザーで動作。`mac.execute` は既定で **ask_once** (初回承認必須)
- 破壊的コマンドパターン (`rm -rf` 等) は destructive カテゴリ → 原則確認
- Phase 3でAI専用macOSユーザーへ分離 (ファイルアクセス範囲の限定、ブラウザプロファイル分離)
- GUI操作は人間使用中キューイング (HIDIdleTime + 手動モード)

## エラー処理

- ユーザーへStack Trace/生エラーを返さない (「寝室の照明に接続できませんでした。もう一度試しますか?」形式)
- 詳細はサーバーログ (Railway logs / ~/.aide/agent.log)

## 既知の残課題 (Phase 2+)

- レートリミット (単一ユーザーのため優先度低)
- Alexaリクエスト署名検証 (Skill実装時に必須)
- セッション失効管理 (現状はCookie期限のみ)
- Google OAuth移行 (パスワード認証の置換)
