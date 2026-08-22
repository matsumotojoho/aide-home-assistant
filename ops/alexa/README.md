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
   - `ops/alexa/interaction-model.json` の `invocationName` を使う (既定: `マイ アシスタント`)
   - 制約: ひらがな/カタカナ推奨、2語以上、起動詞 (開いて/起動して) を含めない、
     「アレクサ」等の予約語やブランド名は不可
   - 認識率が悪ければここを変えて再ビルドする

3. **Interaction Model** をインポート
   - 左メニュー JSON Editor → `ops/alexa/interaction-model.json` の内容を貼り付け
   - **Build Model** を実行

4. **Endpoint** を設定
   - Endpoint → **HTTPS**
   - Default Region: `https://aide-server-production-49d1.up.railway.app/alexa`
   - SSL証明書の種別: **信頼された認証局から発行された証明書を使用しています**

5. **Test** タブで Development を有効化し、実機で確認

## 使い方

```
「アレクサ、マイアシスタントを開いて」
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
