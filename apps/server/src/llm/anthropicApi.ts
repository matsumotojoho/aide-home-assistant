// Anthropic API Provider — 初期状態OFF。
// 設定 `ai.paid_api_fallback` が 'on' かつ APIキーがある場合のみ利用可能。
// 有効化されるまで絶対にAPI課金経路を使わない (仕様書31)。

import Anthropic from '@anthropic-ai/sdk';
import { ProviderUnavailableError, type LlmProvider, type LlmRequest, type LlmResponse } from './provider.js';

export class AnthropicApiProvider implements LlmProvider {
  readonly id = 'anthropic-api';
  private client: Anthropic | null = null;

  constructor(
    private apiKey: string,
    private isEnabled: () => boolean, // settings 'ai.paid_api_fallback' === 'on'
    private defaultModel = 'claude-opus-5',
  ) {}

  async available(): Promise<boolean> {
    return Boolean(this.apiKey) && this.isEnabled();
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (!(await this.available())) {
      throw new ProviderUnavailableError('Anthropic APIは設定で無効化されています (Paid API fallback: OFF)');
    }
    this.client ??= new Anthropic({ apiKey: this.apiKey });
    const response = await this.client.messages.create({
      model: req.model || this.defaultModel,
      max_tokens: 8000,
      system: req.system,
      messages: [{ role: 'user', content: req.prompt }],
    });
    if (response.stop_reason === 'refusal') {
      throw new ProviderUnavailableError('AIがこのリクエストの処理を辞退しました');
    }
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return { text, provider: this.id };
  }
}
