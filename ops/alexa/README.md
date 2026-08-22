# Alexa Custom Skill セットアップ

> エンドポイントは公開済みです: `https://aide-server-production-49d1.up.railway.app/alexa`
> AlexaはHTTPS必須のため、ローカル(localhost)では動作しません。

## 手順

1. https://developer.amazon.com/alexa/console/ask で **Create Skill**
   - Skill name: `マイアシスタント`
   - Primary locale: **日本語 (Japanese)**
   - Model: **Custom** / Hosting: **Provision your own**
   - Template: **Start from Scratch**

2. **Invocation Name** を設定
   - `ops/alexa/interaction-model.json` の `invocationName` を使う (現在: `エージェント`)
   - 制約: ひらがな/カタカナ推奨、2語以上、起動詞 (開いて/起動して) を含めない、
     「アレクサ」等の予約語やブランド名は不可
   - 認識率が悪ければここを変えて再ビルドする

3. **Interaction Model** をインポート
   - 左メニュー JSON Editor → `ops/alexa/interaction-model.json` の内容を貼り付け
   - **Build Model** を実行

4. **Endpoint** を設定
   - Endpoint → **HTTPS**
   - Default Region: `https://aide-server-production-49d1.up.railway.app/alexa`
   - SSL証明書の種別: **サブドメインのワイルドカード証明書** を選ぶ
     (Railwayは `*.up.railway.app` のワイルドカード証明書。「信頼された認証局〜」を選ぶと
      AlexaがTLS検証で接続を拒否し、リクエストがサーバーに一切届かない)

5. **Test** タブで Development を有効化し、実機で確認

## 使い方

```
「アレクサ、エージェントを開いて」
  → 「はい、何をしましょう?」
「今日19時に帰るから快適にしといて」
  → 「了解。帰宅前に室温を確認して調整します」   ← セッション維持
「寝室もお願い」                                  ← 「アレクサ」不要で継続
```

## 実装済みの仕様

- 公式のリクエスト署名検証 (`alexa-verifier`) + タイムスタンプ検証 (150秒)
- 応答後は `shouldEndSession: false` でセッション維持 → 連続会話が可能
- **8秒タイムアウト対策**: 処理が6秒を超えたら「結果はスマホに通知します」と即答し、
  完了後にWeb Pushで結果を届ける
- 会話履歴はAlexa側ではなくBackendの `conversations` (source=alexa) で管理
- 読み上げ長は設定タブの `alexa.verbosity` (短く/標準/詳しく/全文) に従う

## 既知の制約

`docs/alexa-limitations.md` を参照。要点:

- ウェイクワード + 呼び出し名が必須。任意の発話を常時横取りすることはできない
- 無応答が約8秒続くとセッションが切れる (再開は「アレクサ、マイアシスタントを開いて」)
- 「アレクサ、電気つけて」のようなAlexa標準のスマートホーム操作は、
  そのままAlexa側に任せた方が速い (無理にAI経由にしない方針)


## 実機検証で判明した落とし穴

1. **SSL証明書の種別**
   Railwayは `*.up.railway.app` のワイルドカード証明書。`Trusted` を選ぶとAlexaが接続せず、
   サーバーにログすら残らない。`Wildcard` を選ぶこと。

2. **署名ヘッダーはSHA-256側を使う**
   Alexaは `signature` (SHA-1) と `signature-256` (SHA-256) の両方を送る。
   検証はRSA-SHA256で行うため `signature-256` を使う。SHA-1側を渡すと必ず
   `invalid signature` になる。証明書URLのヘッダーは `signaturecertchainurl` (ハイフン無し)。

3. **AMAZON.SearchQuery はスロット単体の発話を許さない**
   `"{query}"` だけのサンプルは `MissingCarrierPhraseWithPhraseSlot` でビルドに失敗する。
   自由発話を丸ごと受けたいので、カスタムスロット型 (`QueryType`) に代表的な発話を並べる方式にした。
   カスタムスロットは一覧に無い値もそのまま渡ってくる。

4. **distributionMode は PUBLIC のまま**
   `PRIVATE` はAlexa for Business向けの配布方式。自分専用でも、審査に出さずDevelopmentで
   使うぶんにはPUBLICでよい。

5. **呼び出し名が発話に混ざる**
   Alexaは「エージェントでリビングの電気つけて」のように、呼び出し名を含んだ文字列を
   そのままスロットへ入れてくることがある。そのままRouterへ渡すと部屋やデバイスの
   判定を邪魔するため、サーバー側 (`normalizeAlexaQuery`) で前置きを除去している。
   「エージェントを開いて」のように起動だけの発話はClaudeを呼ばずに即答する。
   呼び出し名を変えたら `apps/server/src/alexa/skill.ts` の `INVOCATION_ALIASES` も更新すること。

6. **呼び出し名の選び方**
   「えーあい」(AI) はAlexaが音楽検索と誤認しやすく実用にならなかった。
   一般的すぎる語・Alexa標準機能と competing する語は避ける。
