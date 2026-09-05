// Alexa Smart Home API の実装。
//
// これが動くと「アレクサ、寝室の電気消して」のような**標準の言い方**が
// Home Assistant経由になる。SwitchBotやIKEAが各社のAlexaスキルを
// 正しく登録できているかに依存しなくなる。
//
// AlexaはスマートホームスキルのエンドポイントとしてAWS Lambdaしか受け付けないため、
// Lambdaは薄いプロキシとし (ops/alexa/lambda/)、実処理はここで行う。

import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { devices } from '../db/schema.js';
import type { HomeAssistantClient, HaState } from '../ha/client.js';
import type { ToolRegistry, ToolContext } from '../tools/index.js';

const NS = {
  discovery: 'Alexa.Discovery',
  power: 'Alexa.PowerController',
  brightness: 'Alexa.BrightnessController',
  thermostat: 'Alexa.ThermostatController',
  temperature: 'Alexa.TemperatureSensor',
  lock: 'Alexa.LockController',
  range: 'Alexa.RangeController',
  authorization: 'Alexa.Authorization',
  base: 'Alexa',
} as const;

export interface SmartHomeDeps {
  db: Db;
  ha: HomeAssistantClient;
  registry: ToolRegistry;
  buildToolContext: (source: ToolContext['source']) => ToolContext;
  /** アクセストークンからユーザーを解決する */
  resolveUser: (token: string) => string | null;
}

interface Directive {
  directive: {
    header: { namespace: string; name: string; messageId: string; correlationToken?: string; payloadVersion: string };
    endpoint?: { endpointId: string; scope?: { token?: string } };
    payload: Record<string, unknown>;
  };
}

const uuid = () => globalThis.crypto.randomUUID();

function response(
  namespace: string,
  name: string,
  payload: Record<string, unknown>,
  opts: { correlationToken?: string; endpointId?: string; properties?: unknown[] } = {},
): Record<string, unknown> {
  const event: Record<string, unknown> = {
    header: { namespace, name, messageId: uuid(), payloadVersion: '3', correlationToken: opts.correlationToken },
    payload,
  };
  if (opts.endpointId) event.endpoint = { endpointId: opts.endpointId };
  const out: Record<string, unknown> = { event };
  if (opts.properties) out.context = { properties: opts.properties };
  return out;
}

function errorResponse(
  type: string,
  message: string,
  opts: { correlationToken?: string; endpointId?: string } = {},
): Record<string, unknown> {
  return response(NS.base, 'ErrorResponse', { type, message }, opts);
}

/** Alexaのエンドポイントidは限られた文字しか使えないので、entity_idを可逆変換する */
export function toEndpointId(entityId: string): string {
  return entityId.replace(/\./g, '__');
}
export function fromEndpointId(endpointId: string): string {
  return endpointId.replace(/__/g, '.');
}

/** 種別ごとに、Alexaへ申告する能力と表示カテゴリを決める */
function capabilitiesFor(type: string, entityId: string) {
  const base = [{ type: 'AlexaInterface', interface: 'Alexa', version: '3' }];
  const withState = (iface: string, props: string[]) => ({
    type: 'AlexaInterface',
    interface: iface,
    version: '3',
    properties: {
      supported: props.map((name) => ({ name })),
      proactivelyReported: false,
      retrievable: true,
    },
  });

  if (type === 'light') {
    const caps = [...base, withState(NS.power, ['powerState'])];
    // 赤外線リモコン経由 (switch.*) は明るさを持たない
    if (entityId.startsWith('light.')) caps.push(withState(NS.brightness, ['brightness']));
    return { caps, categories: ['LIGHT'] };
  }
  if (type === 'climate') {
    return {
      caps: [
        ...base,
        withState(NS.thermostat, ['targetSetpoint', 'thermostatMode']),
        withState(NS.temperature, ['temperature']),
      ],
      categories: ['THERMOSTAT'],
    };
  }
  if (type === 'cover') {
    // カーテンは開度(0〜100%)として扱い、「開けて/閉めて」は semantics で紐づける
    return {
      caps: [
        ...base,
        {
          type: 'AlexaInterface',
          interface: NS.range,
          version: '3',
          instance: 'Curtain.Position',
          properties: {
            supported: [{ name: 'rangeValue' }],
            proactivelyReported: false,
            retrievable: true,
          },
          capabilityResources: {
            friendlyNames: [
              { '@type': 'asset', value: { assetId: 'Alexa.Setting.Opening' } },
            ],
          },
          configuration: {
            supportedRange: { minimumValue: 0, maximumValue: 100, precision: 10 },
            unitOfMeasure: 'Alexa.Unit.Percent',
          },
          semantics: {
            actionMappings: [
              {
                '@type': 'ActionsToDirective',
                actions: ['Alexa.Actions.Close', 'Alexa.Actions.Lower'],
                directive: { name: 'SetRangeValue', payload: { rangeValue: 0 } },
              },
              {
                '@type': 'ActionsToDirective',
                actions: ['Alexa.Actions.Open', 'Alexa.Actions.Raise'],
                directive: { name: 'SetRangeValue', payload: { rangeValue: 100 } },
              },
            ],
            stateMappings: [
              { '@type': 'StatesToValue', states: ['Alexa.States.Closed'], value: 0 },
              { '@type': 'StatesToRange', states: ['Alexa.States.Open'], range: { minimumValue: 1, maximumValue: 100 } },
            ],
          },
        },
      ],
      categories: ['INTERIOR_BLIND'],
    };
  }
  if (type === 'lock') {
    return { caps: [...base, withState(NS.lock, ['lockState'])], categories: ['SMARTLOCK'] };
  }
  if (type === 'tv') {
    return { caps: [...base, withState(NS.power, ['powerState'])], categories: ['TV'] };
  }
  if (type === 'sensor') {
    return { caps: [...base, withState(NS.temperature, ['temperature'])], categories: ['TEMPERATURE_SENSOR'] };
  }
  return { caps: [...base, withState(NS.power, ['powerState'])], categories: ['SWITCH'] };
}

const HVAC_TO_ALEXA: Record<string, string> = { cool: 'COOL', heat: 'HEAT', dry: 'CUSTOM', fan_only: 'CUSTOM', auto: 'AUTO', heat_cool: 'AUTO', off: 'OFF' };
const ALEXA_TO_HVAC: Record<string, string> = { COOL: 'cool', HEAT: 'heat', AUTO: 'heat_cool', OFF: 'off', ECO: 'auto' };

export async function handleDirective(
  deps: SmartHomeDeps,
  body: Directive,
): Promise<Record<string, unknown>> {
  const header = body?.directive?.header;
  if (!header) return errorResponse('INVALID_DIRECTIVE', 'リクエストの形式が不正です');
  const correlationToken = header.correlationToken;

  // 認証: Discoveryはpayload.scope、操作系はendpoint.scopeにトークンが入る
  const token =
    (body.directive.payload?.scope as { token?: string } | undefined)?.token ??
    body.directive.endpoint?.scope?.token ??
    (body.directive.payload?.grantee as { token?: string } | undefined)?.token;
  const userId = token ? deps.resolveUser(token) : null;
  if (!userId) {
    return header.namespace === NS.discovery
      ? response(NS.discovery, 'Discover.ErrorResponse', {
          type: 'EXPIRED_AUTHORIZATION_CREDENTIAL',
          message: '連携が切れています。Alexaアプリで再連携してください',
        })
      : errorResponse('INVALID_AUTHORIZATION_CREDENTIAL', '連携が切れています', { correlationToken });
  }

  if (header.namespace === NS.authorization && header.name === 'AcceptGrant') {
    return response(NS.authorization, 'AcceptGrant.Response', {});
  }

  if (header.namespace === NS.discovery) {
    return discover(deps, userId);
  }

  const endpointId = body.directive.endpoint?.endpointId;
  if (!endpointId) return errorResponse('INVALID_DIRECTIVE', '対象の機器が指定されていません', { correlationToken });
  const entityId = fromEndpointId(endpointId);

  try {
    return await control(deps, userId, entityId, header.namespace, header.name, body.directive.payload, correlationToken);
  } catch (err) {
    console.error('[alexa.smarthome]', header.namespace, header.name, err);
    const message = err instanceof Error ? err.message : '操作できませんでした';
    // 接続断は「機器が反応しない」と伝える (機器の故障と誤解させない)
    return errorResponse('ENDPOINT_UNREACHABLE', message, { correlationToken, endpointId });
  }
}

async function discover(deps: SmartHomeDeps, userId: string): Promise<Record<string, unknown>> {
  const rows = deps.db.select().from(devices).where(eq(devices.userId, userId)).all();
  const endpoints = rows.map((d) => {
    const { caps, categories } = capabilitiesFor(d.type, d.entityId);
    return {
      endpointId: toEndpointId(d.entityId),
      manufacturerName: 'Aide',
      description: `${d.room ? `${d.room}の` : ''}${d.name} (Home Assistant)`,
      friendlyName: d.name,
      displayCategories: categories,
      capabilities: caps,
    };
  });
  return response(NS.discovery, 'Discover.Response', { endpoints });
}

async function control(
  deps: SmartHomeDeps,
  userId: string,
  entityId: string,
  namespace: string,
  name: string,
  payload: Record<string, unknown>,
  correlationToken?: string,
): Promise<Record<string, unknown>> {
  const ctx = deps.buildToolContext('alexa');
  const endpointId = toEndpointId(entityId);
  const domain = entityId.split('.')[0];

  const exec = async (service: string, data?: Record<string, unknown>) => {
    const result = await deps.registry.execute(
      'home.execute',
      { entity_id: entityId, service, data },
      ctx,
    );
    if (!result.ok) throw new Error(result.error ?? '操作できませんでした');
  };

  // ReportState / 状態問い合わせ
  if (namespace === NS.base && name === 'ReportState') {
    const state = await deps.ha.getState(entityId);
    return response(NS.base, 'StateReport', {}, {
      correlationToken,
      endpointId,
      properties: propertiesFor(entityId, state),
    });
  }

  if (namespace === NS.power) {
    await exec(name === 'TurnOn' ? 'turn_on' : 'turn_off');
    return await successResponse(deps, entityId, endpointId, correlationToken);
  }

  if (namespace === NS.brightness) {
    const pct = Number(payload.brightness ?? 100);
    await exec('turn_on', { brightness_pct: Math.max(1, Math.min(100, pct)) });
    return await successResponse(deps, entityId, endpointId, correlationToken);
  }

  if (namespace === NS.thermostat) {
    if (name === 'SetTargetTemperature') {
      const target = (payload.targetSetpoint as { value?: number } | undefined)?.value;
      if (target === undefined) throw new Error('温度が指定されていません');
      await exec('set_temperature', { temperature: target });
    } else if (name === 'AdjustTargetTemperature') {
      const delta = (payload.targetSetpointDelta as { value?: number } | undefined)?.value ?? 0;
      const state = await deps.ha.getState(entityId);
      const current = Number(state?.attributes?.temperature ?? 25);
      await exec('set_temperature', { temperature: current + delta });
    } else if (name === 'SetThermostatMode') {
      const mode = (payload.thermostatMode as { value?: string } | undefined)?.value ?? 'AUTO';
      await exec('set_hvac_mode', { hvac_mode: ALEXA_TO_HVAC[mode] ?? 'auto' });
    }
    return await successResponse(deps, entityId, endpointId, correlationToken);
  }

  if (namespace === NS.range) {
    let target: number;
    if (name === 'AdjustRangeValue') {
      const state = await deps.ha.getState(entityId);
      const current = Number(state?.attributes?.current_position ?? 0);
      target = current + Number(payload.rangeValueDelta ?? 0);
    } else {
      target = Number(payload.rangeValue ?? 0);
    }
    target = Math.max(0, Math.min(100, Math.round(target)));
    // 全開・全閉は専用サービスの方が確実 (位置指定に対応しない機器がある)
    if (target === 0) await exec('close_cover');
    else if (target === 100) await exec('open_cover');
    else await exec('set_cover_position', { position: target });
    return await successResponse(deps, entityId, endpointId, correlationToken);
  }

  if (namespace === NS.lock) {
    if (name === 'Unlock') {
      // 解錠はRisk Engineが承認必須にしている。Alexaからは即時解錠させない
      const result = await deps.registry.execute(
        'home.execute',
        { entity_id: entityId, service: 'unlock' },
        ctx,
      );
      if (!result.ok) {
        return errorResponse(
          'INVALID_AUTHORIZATION_CREDENTIAL',
          result.pendingApprovalId
            ? '安全のため、スマホで承認してから解錠されます'
            : (result.error ?? '解錠できませんでした'),
          { correlationToken, endpointId },
        );
      }
    } else {
      await exec('lock');
    }
    return await successResponse(deps, entityId, endpointId, correlationToken);
  }

  if (domain === 'climate' || domain === 'light' || domain === 'switch') {
    throw new Error(`未対応の操作です (${namespace}.${name})`);
  }
  return errorResponse('INVALID_DIRECTIVE', `未対応の操作です (${namespace}.${name})`, {
    correlationToken,
    endpointId,
  });
}

async function successResponse(
  deps: SmartHomeDeps,
  entityId: string,
  endpointId: string,
  correlationToken?: string,
): Promise<Record<string, unknown>> {
  // 実行直後は状態が追いつかないことがあるので、取れなければ空で返す
  const state = await deps.ha.getState(entityId).catch(() => null);
  return response(NS.base, 'Response', {}, {
    correlationToken,
    endpointId,
    properties: propertiesFor(entityId, state),
  });
}

function propertiesFor(entityId: string, state: HaState | null): unknown[] {
  if (!state) return [];
  const now = new Date().toISOString();
  const prop = (namespace: string, name: string, value: unknown) => ({
    namespace,
    name,
    value,
    timeOfSample: now,
    uncertaintyInMilliseconds: 1000,
  });
  const domain = entityId.split('.')[0];
  const props: unknown[] = [];

  if (domain === 'light' || domain === 'switch' || domain === 'media_player') {
    props.push(prop(NS.power, 'powerState', state.state === 'off' ? 'OFF' : 'ON'));
    const brightness = state.attributes?.brightness;
    if (typeof brightness === 'number') {
      props.push(prop(NS.brightness, 'brightness', Math.round((brightness / 255) * 100)));
    }
  } else if (domain === 'climate') {
    const target = state.attributes?.temperature;
    if (typeof target === 'number') {
      props.push(prop(NS.thermostat, 'targetSetpoint', { value: target, scale: 'CELSIUS' }));
    }
    props.push(prop(NS.thermostat, 'thermostatMode', HVAC_TO_ALEXA[state.state] ?? 'AUTO'));
    const current = state.attributes?.current_temperature;
    if (typeof current === 'number') {
      props.push(prop(NS.temperature, 'temperature', { value: current, scale: 'CELSIUS' }));
    }
  } else if (domain === 'cover') {
    const pos = state.attributes?.current_position;
    const value = typeof pos === 'number' ? pos : state.state === 'open' ? 100 : 0;
    props.push({
      namespace: NS.range,
      name: 'rangeValue',
      instance: 'Curtain.Position',
      value,
      timeOfSample: now,
      uncertaintyInMilliseconds: 1000,
    });
  } else if (domain === 'lock') {
    props.push(prop(NS.lock, 'lockState', state.state === 'locked' ? 'LOCKED' : 'UNLOCKED'));
  } else if (domain === 'sensor') {
    const v = Number(state.state);
    if (Number.isFinite(v)) props.push(prop(NS.temperature, 'temperature', { value: v, scale: 'CELSIUS' }));
  }
  return props;
}
