// サーバーがRailway上で動く場合、Claude Code CLIはMac mini側にしかないため
// Mac Agent経由でLLM補完を実行するProvider。

import type { AgentGateway } from '../agentGateway.js';
import { ProviderUnavailableError, type LlmProvider, type LlmRequest, type LlmResponse } from './provider.js';

export class MacBridgeProvider implements LlmProvider {
  readonly id = 'claude-via-mac';

  constructor(private gateway: AgentGateway, private defaultModel = '') {}

  async available(): Promise<boolean> {
    return this.gateway.connected();
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (!this.gateway.connected()) {
      throw new ProviderUnavailableError('Mac Agentが接続されていないためAI判断機能を利用できません');
    }
    const result = await this.gateway.call<{ text: string }>(
      'llm.complete',
      {
        system: req.system,
        prompt: req.prompt,
        model: req.model || this.defaultModel || undefined,
      },
      200_000,
    );
    return { text: result.text, provider: this.id };
  }
}
