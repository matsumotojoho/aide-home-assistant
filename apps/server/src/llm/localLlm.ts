// ローカルLLM Provider (Phase 4) — Ollama互換のHTTP APIを叩く。
// 有料APIを使わずにフォールバックしたい場合の選択肢。
// Ollamaが起動していなければ available() が false を返すだけで、他に影響しない。

import { ProviderUnavailableError, type LlmProvider, type LlmRequest, type LlmResponse } from './provider.js';

const DEFAULT_ENDPOINT = 'http://localhost:11434';

export class LocalLlmProvider implements LlmProvider {
  readonly id = 'local-llm';

  constructor(
    private getModel: () => string,
    private endpoint = process.env.OLLAMA_HOST ?? DEFAULT_ENDPOINT,
  ) {}

  async available(): Promise<boolean> {
    if (!this.getModel()) return false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch(`${this.endpoint}/api/tags`, { signal: ctrl.signal });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const model = req.model || this.getModel();
    if (!model) throw new ProviderUnavailableError('ローカルLLMのモデルが未設定です');
    const res = await fetch(`${this.endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.prompt },
        ],
        options: { temperature: 0.3 },
      }),
    });
    if (!res.ok) {
      throw new ProviderUnavailableError('ローカルLLMの応答に失敗しました');
    }
    const data = (await res.json()) as { message?: { content?: string } };
    return { text: data.message?.content ?? '', provider: this.id };
  }
}
