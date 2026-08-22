// バックグラウンドブラウザ (Playwright / headless)。
// Mac操作の優先順位 (仕様書19) の3番目。人間のGUIを奪わないため、
// ユーザーがMac使用中でもキューに入れず即実行してよい。
//
// ブラウザは使い回し、一定時間アイドルで自動的に閉じる (メモリ16GBのため)。

import type { Browser, BrowserContext, Page } from 'playwright';

const IDLE_CLOSE_MS = 5 * 60_000;
const NAV_TIMEOUT_MS = 30_000;

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let idleTimer: NodeJS.Timeout | null = null;
// AI専用のブラウザプロファイル。人間のSafari/Chromeとは完全に分離される
const PROFILE_DIR = `${process.env.HOME}/.aide/browser-profile`;

async function getContext(): Promise<BrowserContext> {
  if (context) return context;
  const { chromium } = await import('playwright');
  // ログイン状態を保持するため永続プロファイルを使う
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: { width: 1280, height: 900 },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  });
  browser = context.browser();
  context.setDefaultTimeout(NAV_TIMEOUT_MS);
  return context;
}

function touchIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void closeBrowser(), IDLE_CLOSE_MS);
}

export async function closeBrowser(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const c = context;
  context = null;
  browser = null;
  await c?.close().catch(() => undefined);
}

export interface BrowseResult {
  url: string;
  title: string;
  text?: string;
  screenshotBase64?: string;
  result?: unknown;
}

/** ページを開いて本文テキストを取得する (最も一般的な用途) */
export async function browseUrl(
  url: string,
  opts: { screenshot?: boolean; waitFor?: string } = {},
): Promise<BrowseResult> {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (opts.waitFor) await page.waitForSelector(opts.waitFor, { timeout: 15_000 }).catch(() => undefined);
    // 動的描画のぶん少し待つ
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
    const title = await page.title();
    const text = await extractText(page);
    const screenshotBase64 = opts.screenshot
      ? (await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false })).toString('base64')
      : undefined;
    return { url: page.url(), title, text, screenshotBase64 };
  } finally {
    await page.close().catch(() => undefined);
    touchIdle();
  }
}

/**
 * 任意のPlaywrightスクリプトを実行する (ログイン後の操作など)。
 * scriptは async 関数の本体として評価され、`page` が渡される。
 */
export async function runScript(script: string, timeoutMs = 60_000): Promise<BrowseResult> {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    const fn = new Function(
      'page',
      `return (async () => { ${script} })();`,
    ) as (page: Page) => Promise<unknown>;
    const result = await Promise.race([
      fn(page),
      new Promise((_, reject) => setTimeout(() => reject(new Error('スクリプトがタイムアウトしました')), timeoutMs)),
    ]);
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      result: result ?? null,
    };
  } finally {
    await page.close().catch(() => undefined);
    touchIdle();
  }
}

async function extractText(page: Page): Promise<string> {
  const text = await page.evaluate(() => {
    const drop = document.querySelectorAll('script, style, noscript, svg');
    drop.forEach((el: Element) => el.remove());
    return (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim();
  });
  return text.slice(0, 60_000);
}
