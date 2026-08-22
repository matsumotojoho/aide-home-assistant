// OpenAI API Provider (Phase 4) — 初期状態OFF。
// Anthropic APIと同じく、ai.paid_api_fallback が 'on' のときだけ利用可能。

import { ProviderUnavailableError, type LlmProvider, type LlmRequest, type LlmResponse } from './provider.js';

export class OpenAiApiProvider implements LlmProvider {
  readonly id = 'openai-api';

  constructor(
    private apiKey: string,
    private isEnabled: () => boolean,
    private getModel: () => string,
  ) {}

  async available(): Promise<boolean> {
    return Boolean(this.apiKey) && this.isEnabled();
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (!(await this.available())) {
      throw new ProviderUnavailableError('OpenAI APIは設定で無効化されています (Paid API fallback: OFF)');
    }
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: req.model || this.getModel(),
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.prompt },
        ],
      }),
    });
    if (!res.ok) {
      console.error('[openai]', res.status, (await res.text().catch(() => '')).slice(0, 300));
      throw new ProviderUnavailableError('OpenAI APIの呼び出しに失敗しました');
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return { text: data.choices?.[0]?.message?.content ?? '', provider: this.id };
  }
}
