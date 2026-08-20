// Provider abstraction (仕様書: Claudeとの接続部分は必ずProvider abstractionを作る)
// 将来 Claude API / OpenAI API / ローカルLLM へ切替可能にする。

export interface LlmRequest {
  system: string;
  prompt: string; // 会話+ツール結果を組み立てた単一プロンプト (CLI/API両対応の共通形)
  model?: string;
}

export interface LlmResponse {
  text: string;
  provider: string;
}

export interface LlmProvider {
  readonly id: string;
  available(): Promise<boolean>;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export class ProviderUnavailableError extends Error {
  constructor(message = '現在AI判断機能が利用できません') {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}
