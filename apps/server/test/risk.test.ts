import { describe, expect, it } from 'vitest';
import { categorize, riskLabel } from '../src/risk.js';

describe('Risk Engine', () => {
  it('家電操作は home_control (low)', () => {
    const cat = categorize('home.execute', { entity_id: 'light.bedroom', service: 'turn_on' });
    expect(cat).toBe('home_control');
    expect(riskLabel(cat)).toBe('low');
  });

  it('解錠は security_change (確認必須)、施錠は通常の家電操作', () => {
    expect(categorize('home.execute', { entity_id: 'lock.front_door', service: 'unlock' })).toBe('security_change');
    expect(categorize('home.execute', { entity_id: 'lock.front_door', service: 'open' })).toBe('security_change');
    expect(categorize('home.execute', { entity_id: 'lock.front_door', service: 'lock' })).toBe('home_control');
  });

  it('購入系キーワードは purchase (high)', () => {
    const cat = categorize('mac.execute', { command: 'Amazonでトイレットペーパーを購入する' });
    expect(cat).toBe('purchase');
    expect(riskLabel(cat)).toBe('high');
  });

  it('送金は money_transfer', () => {
    expect(categorize('message.send', { body: '10万円振込した' })).toBe('money_transfer');
  });

  it('破壊的shellコマンドは destructive', () => {
    expect(categorize('mac.execute', { command: 'sudo rm -rf /tmp/x' })).toBe('destructive');
    expect(categorize('mac.execute', { command: 'rm -rf ~/Documents' })).toBe('destructive');
  });

  it('通常のshellは mac_shell / GUIは mac_gui', () => {
    expect(categorize('mac.execute', { command: 'ls ~/Desktop' })).toBe('mac_shell');
    expect(categorize('mac.execute', { command: 'open Safariで操作', gui: true })).toBe('mac_gui');
  });

  it('メッセージ送信は messaging_send (medium)', () => {
    const cat = categorize('message.send', { to: '田中さん', body: '遅れます' });
    expect(cat).toBe('messaging_send');
    expect(riskLabel(cat)).toBe('medium');
  });

  it('アカウント削除・一括削除は high', () => {
    expect(riskLabel(categorize('mac.execute', { command: 'サービスのアカウント削除' }))).toBe('high');
    expect(riskLabel(categorize('mac.execute', { command: 'ファイルを全部消して' }))).toBe('high');
  });
});
