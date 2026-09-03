// Alexa スマートホームスキルのエンドポイント。
//
// AlexaはスマートホームスキルのendpointにAWS Lambdaしか受け付けないため、
// Lambdaは中継だけを行い、実処理はAideのサーバー側で行う。
// ここにロジックを置かないので、機能追加のたびにLambdaを更新する必要はない。
//
// 必要な環境変数:
//   AIDE_URL           例: https://xxx.up.railway.app
//   AIDE_LAMBDA_SECRET Aide側の ALEXA_LAMBDA_SECRET と同じ値

const TIMEOUT_MS = 7000;

export const handler = async (event) => {
  const base = (process.env.AIDE_URL || '').replace(/\/$/, '');
  const secret = process.env.AIDE_LAMBDA_SECRET || '';
  if (!base || !secret) {
    return errorResponse(event, 'INTERNAL_ERROR', 'Lambdaの環境変数が未設定です');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/alexa/smarthome`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-aide-lambda-secret': secret },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error('aide responded', res.status, (await res.text()).slice(0, 300));
      return errorResponse(event, 'ENDPOINT_UNREACHABLE', 'サーバーに接続できませんでした');
    }
    return await res.json();
  } catch (err) {
    console.error('proxy failed', err);
    return errorResponse(event, 'ENDPOINT_UNREACHABLE', 'サーバーに接続できませんでした');
  } finally {
    clearTimeout(timer);
  }
};

function errorResponse(event, type, message) {
  const header = event?.directive?.header ?? {};
  const isDiscovery = header.namespace === 'Alexa.Discovery';
  return {
    event: {
      header: {
        namespace: isDiscovery ? 'Alexa.Discovery' : 'Alexa',
        name: isDiscovery ? 'Discover.ErrorResponse' : 'ErrorResponse',
        messageId: header.messageId ? `${header.messageId}-r` : 'error',
        correlationToken: header.correlationToken,
        payloadVersion: '3',
      },
      payload: { type, message },
    },
  };
}
