import type { SettingsService } from '../services/settings.js';
import type { AgentGateway } from '../agentGateway.js';
import { ClaudeCliProvider } from './claudeCli.js';
import { MacBridgeProvider } from './macBridge.js';
import { AnthropicApiProvider } from './anthropicApi.js';
import { ProviderUnavailableError, type LlmProvider } from './provider.js';

export * from './provider.js';

export interface ProviderSelector {
  /** 設定と可用性から使用Providerを決定する */
  pick(): Promise<LlmProvider>;
  ids(): string[];
}

export function createProviderSelector(deps: {
  settings: SettingsService;
  gateway: AgentGateway;
  anthropicApiKey: string;
}): ProviderSelector {
  const { settings, gateway } = deps;
  const cli = new ClaudeCliProvider();
  const bridge = new MacBridgeProvider(gateway);
  const api = new AnthropicApiProvider(
    deps.anthropicApiKey,
    () => settings.get('ai.paid_api_fallback') === 'on',
  );

  const byId: Record<string, LlmProvider> = {
    'claude-cli-local': cli,
    'claude-via-mac': bridge,
    'anthropic-api': api,
  };

  return {
    ids: () => Object.keys(byId),
    async pick(): Promise<LlmProvider> {
      const configured = settings.get('ai.provider');
      const cliModel = settings.get('ai.claude_cli_model');
      const apiModel = settings.get('ai.api_model');

      if (configured !== 'auto') {
        const p = byId[configured];
        if (!p) throw new ProviderUnavailableError(`未対応のProvider設定です: ${configured}`);
        if (!(await p.available())) {
          throw new ProviderUnavailableError(`Provider ${configured} は現在利用できません`);
        }
        return wrapWithModel(p, configured === 'anthropic-api' ? apiModel : cliModel);
      }

      // auto: ローカルCLI → Mac Agent経由 の順で選択。有料APIへは自動フォールバックしない。
      if (await cli.available()) return wrapWithModel(cli, cliModel);
      if (await bridge.available()) return wrapWithModel(bridge, cliModel);
      throw new ProviderUnavailableError(
        'Claude Code CLIが見つからず、Mac Agentも未接続のためAI判断機能を利用できません',
      );
    },
  };
}

function wrapWithModel(p: LlmProvider, model: string): LlmProvider {
  if (!model) return p;
  return {
    id: p.id,
    available: () => p.available(),
    complete: (req) => p.complete({ ...req, model: req.model || model }),
  };
}
