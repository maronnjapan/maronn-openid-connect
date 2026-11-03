import { expect, test } from '@playwright/test';

test('should explain what a function checks using its guard comment and predicate documentation', async ({ page }) => {
  await page.goto('/#hono--fn--completePromptNoneRequest');
  const resolver = page.locator('.diagram .box').filter({ has: page.locator('.title', { hasText: /^!sessionResolver$/ }) });
  await expect(resolver.locator('.sub')).toContainText('セッションリゾルバが無ければ');
  const age = page.locator('.diagram .box:not([role="button"])').filter({ has: page.locator('.title', { hasText: /^requiresReauthentication\(/ }) });
  await expect(age.locator('.sub')).toContainText('認証から `maxAge` 秒を超えていれば');
  await expect(page.locator('.diagram .sub', { hasText: '条件によって処理を分ける' })).toHaveCount(0);
});

test('should end a rejected authorization request before subsequent steps in either direction', async ({ page }) => {
  await page.goto('/#hono--authorize');
  await page.getByRole('button', { name: '表示するケースを選択', exact: true }).click();
  await page.getByRole('button', { name: '解除', exact: true }).click();
  await page.getByRole('checkbox', { name: /return parsed/ }).first().check();
  const titles = page.locator('.diagram .box.on .title');
  await expect(titles).toHaveText(['processAuthorizationRequest()', '認可リクエストを解析する', "'kind' in parsed", 'return parsed']);
  await expect(page.locator('.diagram .edge')).toHaveCount(3);
  await page.getByRole('button', { name: '→ 横方向', exact: true }).click();
  await expect(titles).toHaveText(['processAuthorizationRequest()', '認可リクエストを解析する', "'kind' in parsed", 'return parsed']);
});

test('should keep error responses separate by failed step and open their original step details', async ({ page }) => {
  await page.goto('/#hono--token');
  await page.getByRole('button', { name: '表示するケースを選択', exact: true }).click();
  await page.getByRole('button', { name: 'すべて', exact: true }).click();
  const paths = await page.locator('.diagram .edge.error path').evaluateAll((paths) => paths.map((path) => path.getAttribute('d')));
  expect(paths.length).toBeGreaterThan(2);
  expect(new Set(paths).size).toBe(paths.length);
  const responses = page.locator('.diagram .box.on.tone-error[role="button"]');
  expect(await responses.count()).toBeGreaterThan(2);
  await page.getByRole('button', { name: '100%で表示', exact: true }).click();
  await responses.first().press('Enter');
  await expect(page.getByRole('dialog', { name: /ステップの詳細$/ })).toBeVisible();
});
