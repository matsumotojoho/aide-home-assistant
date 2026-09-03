// Alexaスマートホームスキル。これが動くと「アレクサ、寝室の電気消して」という
// 標準の言い方がHome Assistant経由になり、各社のAlexa連携の不調に左右されなくなる。

import { describe, expect, it } from 'vitest';
import { v4 as uuid } from 'uuid';
import { makeTestEnv } from './helpers.js';
import { devices } from '../src/db/schema.js';
import { handleDirective, toEndpointId, fromEndpointId } from '../src/alexa/smarthome.js';
import { AlexaOAuth } from '../src/alexa/oauth.js';
import type { HomeAssistantClient } from '../src/ha/client.js';

function seed(env: ReturnType<typeof makeTestEnv>, rows: Array<[string, string, string | null, string]>) {
  for (const [entityId, name, room, type] of rows) {
    env.db
      .insert(devices)
      .values({
        id: uuid(),
        userId: env.userId,
        entityId,
        name,
        room,
        type,
        aliases: '[]',
        createdAt: new Date().toISOString(),
      })
      .run();
  }
}

function deps(env: ReturnType<typeof makeTestEnv>, token = 'valid-token') {
  return {
    db: env.db,
    ha: env.ha as unknown as HomeAssistantClient,
    registry: env.registry,
    buildToolContext: () => ({ ...env.ctx, source: 'alexa' as const }),
    resolveUser: (t: string) => (t === token ? env.userId : null),
  };
}

const directive = (
  namespace: string,
  name: string,
  opts: { endpointId?: string; token?: string; payload?: Record<string, unknown> } = {},
) => ({
  directive: {
    header: { namespace, name, messageId: 'm1', correlationToken: 'c1', payloadVersion: '3' },
    ...(opts.endpointId
      ? { endpoint: { endpointId: opts.endpointId, scope: { token: opts.token ?? 'valid-token' } } }
      : {}),
    payload: opts.payload ?? (opts.endpointId ? {} : { scope: { token: opts.token ?? 'valid-token' } }),
  },
});

describe('Alexaスマートホーム: 機器の検出', () => {
  it('登録済みの機器を種別ごとの能力付きで返す', async () => {
    const env = makeTestEnv();
    seed(env, [
      ['light.dian_qi', '寝室の電気', '寝室', 'light'],
      ['switch.dining', 'ダイニングの電気', 'ダイニング', 'light'],
      ['climate.eakon', '寝室のエアコン', '寝室', 'climate'],
      ['lock.front', '玄関の鍵', '玄関', 'lock'],
    ]);
    const res = (await handleDirective(deps(env), directive('Alexa.Discovery', 'Discover'))) as never;
    const endpoints = (res as { event: { payload: { endpoints: Array<Record<string, unknown>> } } }).event.payload
      .endpoints;
    expect(endpoints).toHaveLength(4);

    const byName = Object.fromEntries(endpoints.map((e) => [e.friendlyName as string, e]));
    expect(byName['寝室の電気'].displayCategories).toEqual(['LIGHT']);
    expect(byName['玄関の鍵'].displayCategories).toEqual(['SMARTLOCK']);
    expect(byName['寝室のエアコン'].displayCategories).toEqual(['THERMOSTAT']);

    // 赤外線経由 (switch.*) は明るさを持たないので申告しない
    const ifaces = (e: Record<string, unknown>) =>
      (e.capabilities as Array<{ interface: string }>).map((c) => c.interface);
    expect(ifaces(byName['寝室の電気'])).toContain('Alexa.BrightnessController');
    expect(ifaces(byName['ダイニングの電気'])).not.toContain('Alexa.BrightnessController');
  });

  it('連携が切れていれば再連携を促す', async () => {
    const env = makeTestEnv();
    const res = (await handleDirective(
      deps(env),
      directive('Alexa.Discovery', 'Discover', { token: 'bad' }),
    )) as { event: { payload: { type: string } } };
    expect(res.event.payload.type).toBe('EXPIRED_AUTHORIZATION_CREDENTIAL');
  });
});

describe('Alexaスマートホーム: 操作', () => {
  it('消灯するとHAへ turn_off が飛ぶ', async () => {
    const env = makeTestEnv();
    seed(env, [['light.dian_qi', '寝室の電気', '寝室', 'light']]);
    env.ha.states.set('light.dian_qi', { entity_id: 'light.dian_qi', state: 'on', attributes: {} });

    const res = (await handleDirective(
      deps(env),
      directive('Alexa.PowerController', 'TurnOff', { endpointId: toEndpointId('light.dian_qi') }),
    )) as { event: { header: { name: string } }; context?: { properties: Array<Record<string, unknown>> } };

    expect(res.event.header.name).toBe('Response');
    expect(env.ha.calls[0]).toMatchObject({ domain: 'light', service: 'turn_off' });
    expect(res.context?.properties?.[0]).toMatchObject({ name: 'powerState', value: 'OFF' });
  });

  it('明るさ指定は brightness_pct に変換される', async () => {
    const env = makeTestEnv();
    seed(env, [['light.dian_qi', '寝室の電気', '寝室', 'light']]);
    env.ha.states.set('light.dian_qi', { entity_id: 'light.dian_qi', state: 'on', attributes: {} });
    await handleDirective(
      deps(env),
      directive('Alexa.BrightnessController', 'SetBrightness', {
        endpointId: toEndpointId('light.dian_qi'),
        payload: { brightness: 40 },
      }),
    );
    expect(env.ha.calls[0].data).toMatchObject({ brightness_pct: 40 });
  });

  it('エアコンの温度指定が通る', async () => {
    const env = makeTestEnv();
    seed(env, [['climate.eakon', '寝室のエアコン', '寝室', 'climate']]);
    env.ha.states.set('climate.eakon', {
      entity_id: 'climate.eakon',
      state: 'cool',
      attributes: { temperature: 28 },
    });
    await handleDirective(
      deps(env),
      directive('Alexa.ThermostatController', 'SetTargetTemperature', {
        endpointId: toEndpointId('climate.eakon'),
        payload: { targetSetpoint: { value: 26, scale: 'CELSIUS' } },
      }),
    );
    expect(env.ha.calls.at(-1)?.data).toMatchObject({ temperature: 26 });
  });

  it('解錠はAlexaから即実行させず、承認へ回す', async () => {
    const env = makeTestEnv();
    seed(env, [['lock.front', '玄関の鍵', '玄関', 'lock']]);
    env.ha.states.set('lock.front', { entity_id: 'lock.front', state: 'locked', attributes: {} });

    const res = (await handleDirective(
      deps(env),
      directive('Alexa.LockController', 'Unlock', { endpointId: toEndpointId('lock.front') }),
    )) as { event: { header: { name: string }; payload: { message: string } } };

    expect(res.event.header.name).toBe('ErrorResponse');
    expect(res.event.payload.message).toContain('承認');
    // 実際には解錠していない
    expect(env.ha.calls).toHaveLength(0);
  });

  it('施錠はそのまま実行できる', async () => {
    const env = makeTestEnv();
    seed(env, [['lock.front', '玄関の鍵', '玄関', 'lock']]);
    env.ha.states.set('lock.front', { entity_id: 'lock.front', state: 'unlocked', attributes: {} });
    const res = (await handleDirective(
      deps(env),
      directive('Alexa.LockController', 'Lock', { endpointId: toEndpointId('lock.front') }),
    )) as { event: { header: { name: string } } };
    expect(res.event.header.name).toBe('Response');
    expect(env.ha.calls[0]).toMatchObject({ service: 'lock' });
  });

  it('機器に届かないときは ENDPOINT_UNREACHABLE を返す', async () => {
    const env = makeTestEnv();
    seed(env, [['light.dian_qi', '寝室の電気', '寝室', 'light']]);
    // 状態が取れない = 接続断
    env.ha.getState = async () => {
      throw new Error('Home Assistantに接続できませんでした');
    };
    const res = (await handleDirective(
      deps(env),
      directive('Alexa.PowerController', 'TurnOn', { endpointId: toEndpointId('light.dian_qi') }),
    )) as { event: { header: { name: string }; payload: { type: string } } };
    expect(res.event.header.name).toBe('ErrorResponse');
    expect(res.event.payload.type).toBe('ENDPOINT_UNREACHABLE');
  });

  it('entity_idとendpointIdは相互に戻せる', () => {
    for (const id of ['light.dian_qi', 'switch.taininkunodian_qi', 'climate.eakon']) {
      expect(fromEndpointId(toEndpointId(id))).toBe(id);
    }
  });
});

describe('Alexaアカウントリンク (OAuth2)', () => {
  const config = { clientId: 'client-abc', clientSecret: 'secret-xyz' };

  it('認可コードをトークンへ交換できる', () => {
    const env = makeTestEnv();
    const oauth = new AlexaOAuth(env.db, config);
    const redirect = 'https://pitangui.amazon.com/api/skill/link/ABC';
    const code = oauth.issueCode(env.userId, config.clientId, redirect);
    const tokens = oauth.exchangeCode(code, config.clientId, redirect);
    expect(tokens).not.toBeNull();
    expect(oauth.verifyAccessToken(tokens!.access_token)).toBe(env.userId);
  });

  it('認可コードは1度きり', () => {
    const env = makeTestEnv();
    const oauth = new AlexaOAuth(env.db, config);
    const redirect = 'https://pitangui.amazon.com/api/skill/link/ABC';
    const code = oauth.issueCode(env.userId, config.clientId, redirect);
    expect(oauth.exchangeCode(code, config.clientId, redirect)).not.toBeNull();
    expect(oauth.exchangeCode(code, config.clientId, redirect)).toBeNull();
  });

  it('redirect_uriが違えば拒否する', () => {
    const env = makeTestEnv();
    const oauth = new AlexaOAuth(env.db, config);
    const code = oauth.issueCode(env.userId, config.clientId, 'https://pitangui.amazon.com/a');
    expect(oauth.exchangeCode(code, config.clientId, 'https://evil.example.com/a')).toBeNull();
  });

  it('リダイレクト先はAmazonのドメインだけ許可する', () => {
    const env = makeTestEnv();
    const oauth = new AlexaOAuth(env.db, config);
    expect(oauth.isAllowedRedirect('https://pitangui.amazon.com/api/skill/link/X')).toBe(true);
    expect(oauth.isAllowedRedirect('https://layla.amazon.co.jp/api/skill/link/X')).toBe(true);
    expect(oauth.isAllowedRedirect('https://evil.example.com/x')).toBe(false);
    expect(oauth.isAllowedRedirect('http://pitangui.amazon.com/x')).toBe(false);
    // ドメイン末尾を偽装した形も弾く
    expect(oauth.isAllowedRedirect('https://amazon.com.evil.example/x')).toBe(false);
  });

  it('client_secretが違えば拒否する', () => {
    const env = makeTestEnv();
    const oauth = new AlexaOAuth(env.db, config);
    expect(oauth.verifyClient(config.clientId, 'wrong')).toBe(false);
    expect(oauth.verifyClient('wrong', config.clientSecret)).toBe(false);
    expect(oauth.verifyClient(config.clientId, config.clientSecret)).toBe(true);
  });

  it('リフレッシュでアクセストークンを再発行できる', () => {
    const env = makeTestEnv();
    const oauth = new AlexaOAuth(env.db, config);
    const redirect = 'https://pitangui.amazon.com/a';
    const code = oauth.issueCode(env.userId, config.clientId, redirect);
    const first = oauth.exchangeCode(code, config.clientId, redirect)!;
    const again = oauth.refresh(first.refresh_token)!;
    expect(oauth.verifyAccessToken(again.access_token)).toBe(env.userId);
  });

  it('連携解除で全トークンが無効になる', () => {
    const env = makeTestEnv();
    const oauth = new AlexaOAuth(env.db, config);
    const redirect = 'https://pitangui.amazon.com/a';
    const code = oauth.issueCode(env.userId, config.clientId, redirect);
    const tokens = oauth.exchangeCode(code, config.clientId, redirect)!;
    oauth.revokeAll(env.userId);
    expect(oauth.verifyAccessToken(tokens.access_token)).toBeNull();
    expect(oauth.refresh(tokens.refresh_token)).toBeNull();
  });
});
