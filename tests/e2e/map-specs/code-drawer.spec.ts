import { expect, test } from '@playwright/test';
import type { MapData } from '../../../apps/map/src/types';

for (const framework of ['hono', 'express', 'fastify', 'nextjs']) {
  test(`should fetch the full ${framework} endpoint source only when its code drawer opens`, async ({ page, request }) => {
    const data = await (await request.get('/data/map.json')).json() as MapData;
    const endpoint = data.flows[framework]!.endpoints.find((item) => item.id === 'token')!;
    const source = data.sources![endpoint.source!]!;
    const expectedCode = await (await request.get(source.url)).json() as string;
    const requests: string[] = [];
    page.on('request', (item) => { if (item.url().includes('/data/sources/')) requests.push(item.url()); });
    await page.goto(`/#${framework}--token`);
    const open = page.getByRole('button', { name: 'エンドポイント全体のコードを見る', exact: true });
    await expect(open).toBeVisible();
    expect(requests).toHaveLength(0);
    const width = await page.locator('.canvas').evaluate((element) => element.clientWidth);
    await open.click();
    const drawer = page.getByRole('dialog', { name: 'コード', exact: true });
    await expect(drawer.locator('.source-code')).toBeVisible();
    await expect(drawer.locator('.where')).toHaveText(source.path);
    expect((await drawer.locator('.source-line > span:last-child').allTextContents()).join('')).toBe(expectedCode.replace(/\r\n/g, '\n').replace(/\n?$/, '\n'));
    expect(requests).toHaveLength(1);
    const close = drawer.getByRole('button', { name: 'コードを閉じる', exact: true });
    await expect(close).toBeFocused();
    await open.focus();
    await expect(close).toBeFocused();
    await drawer.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(open).toBeFocused();
    expect(await page.locator('.canvas').evaluate((element) => element.clientWidth)).toBe(width);
  });
}

test('should inspect step and callee code and return to the step drawer before returning to the diagram', async ({ page }) => {
  await page.goto('/#hono--token');
  const step = page.locator('.diagram .box[role="button"]').first();
  await step.click();
  const detail = page.getByRole('dialog', { name: 'トークンリクエストを解析する — ステップの詳細', exact: true });
  const open = detail.getByRole('button', { name: 'parseTokenRequest() のコードを見る', exact: true });
  await open.click();
  const code = page.getByRole('dialog', { name: 'コード', exact: true });
  await expect(code.locator('.source-code')).toContainText('function parseTokenRequest');
  await expect(code.locator('.where')).toContainText('parse-request.ts:');
  await code.getByRole('button', { name: 'ファイル全体を見る', exact: true }).click();
  await expect(code.locator('.source-line-number').first()).toHaveText('1');
  await expect(code.locator('.source-code')).toContainText('import');
  await code.getByRole('button', { name: '関数だけを見る', exact: true }).click();
  await expect(code.locator('.where')).toContainText('parse-request.ts:');
  const select = code.getByLabel('表示するコード');
  const callee = select.locator('option').filter({ hasText: 'isFormUrlEncoded()' }).first();
  await select.selectOption(await callee.getAttribute('value') as string);
  await expect(code.locator('.source-code')).toContainText('function isFormUrlEncoded');
  await code.getByRole('button', { name: 'コードを閉じる', exact: true }).click();
  await expect(detail).toBeVisible();
  await expect(open).toBeFocused();
  await detail.getByRole('button', { name: 'isFormUrlEncoded() のコードを見る', exact: true }).first().click();
  await expect(code.locator('.source-code')).toContainText('function isFormUrlEncoded');
  await code.press('Escape');
  await detail.press('Escape');
  await expect(detail).toHaveCount(0);
  await expect(step).toBeFocused();
});

test('should show a function with JSDoc and its original line numbers, also on mobile', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const data = await (await request.get('/data/map.json')).json() as MapData;
  const card = Object.values(data.functions).find((item) => item.name === 'parseTokenRequest')!;
  await page.goto('/#hono--fn--parseTokenRequest');
  const open = page.getByRole('button', { name: '関数のコードを見る', exact: true });
  await open.click();
  const drawer = page.getByRole('dialog', { name: 'コード', exact: true });
  await expect(drawer.locator('.source-code')).toContainText('/**');
  await expect(drawer.locator('.source-code')).toContainText('function parseTokenRequest');
  await expect(drawer.locator('.source-line-number').first()).toHaveText(String(card.source!.start));
  await expect(drawer.locator('.source-line-number').last()).toHaveText(String(card.source!.end));
  expect(await drawer.evaluate((element) => element.getBoundingClientRect().width)).toBe(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await drawer.getByRole('button', { name: 'コードを閉じる', exact: true }).click();
  await expect(open).toBeFocused();
});

test('should retry a failed source fetch and close on a backdrop click', async ({ page }) => {
  await page.goto('/#nextjs--token');
  await page.route('**/data/sources/*.json', (route) => route.fulfill({ status: 503, body: 'unavailable' }));
  const open = page.getByRole('button', { name: 'エンドポイント全体のコードを見る', exact: true });
  await open.click();
  const drawer = page.getByRole('dialog', { name: 'コード', exact: true });
  await expect(drawer.getByRole('alert')).toContainText('503');
  await page.unroute('**/data/sources/*.json');
  await drawer.getByRole('button', { name: '再試行', exact: true }).click();
  await expect(drawer.locator('.source-code')).toContainText('export');
  await page.mouse.click(20, 500);
  await expect(drawer).toHaveCount(0);
  await expect(open).toBeFocused();
});
