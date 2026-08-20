// Claude Code CLI (公式) の非対話モードを利用するProvider。
// サブスクリプション枠で動作し、API従量課金は発生しない。
// 公式CLIの `claude -p --output-format json` のみを使用する (非公式API・認証迂回はしない)。
// 注意: CLIのフラグ仕様が変わった場合はここを更新する (docs/architecture.md参照)。

import { spawn, spawnSync } from 'node:child_process';
import { ProviderUnavailableError, type LlmProvider, type LlmRequest, type LlmResponse } from './provider.js';

export class ClaudeCliProvider implements LlmProvider {
  readonly id = 'claude-cli-local';
  private availableCache: boolean | null = null;

  constructor(private defaultModel = '', private timeoutMs = 180_000) {}

  async available(): Promise<boolean> {
    if (this.availableCache !== null) return this.availableCache;
    try {
      const res = spawnSync('claude', ['--version'], { timeout: 10_000, encoding: 'utf8' });
      this.availableCache = res.status === 0;
    } catch {
      this.availableCache = false;
    }
    return this.availableCache;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const args = ['-p', '--output-format', 'json', '--max-turns', '8'];
    // Web検索のみCLI内蔵ツールとして許可 (ファイル操作等はAide側のTool Registryで管理)
    args.push('--allowedTools', 'WebSearch');
    const model = req.model || this.defaultModel;
    if (model) args.push('--model', model);
    if (req.system) args.push('--append-system-prompt', req.system);

    return new Promise<LlmResponse>((resolve, reject) => {
      const child = spawn('claude', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new ProviderUnavailableError('Claude CLIの応答がタイムアウトしました'));
      }, this.timeoutMs);

      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new ProviderUnavailableError(`Claude CLIを起動できません: ${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new ProviderUnavailableError(`Claude CLIがエラー終了しました (${code}): ${stderr.slice(0, 500)}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean };
          if (parsed.is_error) {
            reject(new ProviderUnavailableError(`Claude CLIエラー: ${String(parsed.result).slice(0, 300)}`));
            return;
          }
          resolve({ text: parsed.result ?? '', provider: this.id });
        } catch {
          // JSONで返らない場合はテキストをそのまま利用
          resolve({ text: stdout.trim(), provider: this.id });
        }
      });

      child.stdin.write(req.prompt);
      child.stdin.end();
    });
  }
}
