import { expect, test, type Page } from '@playwright/test';

/** Read the unscaled box coordinates to compare placement independently of zoom. */
async function boxPositions(page: Page) {
  return page.locator('.diagram .box .frame').evaluateAll((boxes) => boxes.map((box) => ({
    x: Number(box.getAttribute('x')),
    y: Number(box.getAttribute('y')),
  })));
}

test('should spread endpoint branches across the canvas and preserve placement when cases change', async ({ page }) => {
  await page.goto('/#hono--token');
  await expect(page.getByRole('group', { name: 'フローの表示設定' })).toBeVisible();
  const positions = await boxPositions(page);
  expect(new Set(positions.map((box) => box.x)).size > 1).toBe(true);
  const before = await page.locator('.diagram .edge').count();
  await page.getByRole('button', { name: 'すべて', exact: true }).click();
  expect(await boxPositions(page)).toEqual(positions);
  expect(await page.locator('.diagram .edge').count() > before).toBe(true);
  await expect(page.locator('.diagram .edge.error').first()).toBeAttached();
  await page.getByRole('button', { name: '解除', exact: true }).click();
  await expect(page.locator('.diagram .edge')).toHaveCount(0);
  expect(await boxPositions(page)).toEqual(positions);
});

test('should switch flow direction, zoom and fit the diagram inside the available area', async ({ page }) => {
  await page.goto('/#hono--token');
  const horizontal = page.getByRole('button', { name: '→ 横方向', exact: true });
  await horizontal.click();
  await expect(horizontal).toHaveAttribute('aria-pressed', 'true');
  const positions = await boxPositions(page);
  expect(positions[1]!.x > positions[0]!.x).toBe(true);
  await page.getByRole('button', { name: '100%で表示', exact: true }).click();
  await expect(page.getByRole('button', { name: '100%で表示', exact: true })).toHaveText('100%');
  const originalWidth = await page.locator('.diagram').getAttribute('width');
  await page.getByRole('button', { name: '拡大', exact: true }).click();
  await expect(page.getByRole('button', { name: '100%で表示', exact: true })).toHaveText('125%');
  expect(Number(await page.locator('.diagram').getAttribute('width')) > Number(originalWidth)).toBe(true);
  await page.getByRole('button', { name: '縮小', exact: true }).click();
  await expect(page.getByRole('button', { name: '100%で表示', exact: true })).toHaveText('100%');
  await page.getByRole('button', { name: '↓ 縦方向', exact: true }).click();
  await page.getByRole('button', { name: '全体を表示', exact: true }).click();
  await expect.poll(() => page.locator('.diagram-viewport').evaluate((viewport) => {
    const diagram = viewport.querySelector('svg')!.getBoundingClientRect();
    return diagram.width <= viewport.clientWidth && diagram.height <= viewport.clientHeight;
  })).toBe(true);
  // A step can still be opened after fitting and changing direction.
  await page.locator('.diagram .box[role="button"]').first().press('Enter');
  await expect(page.getByRole('complementary', { name: 'ステップの詳細', exact: true })).toBeVisible();
});

test('should use the same branching layout and display controls on function pages', async ({ page }) => {
  await page.goto('/#hono--fn--verifyClientSecret');
  await expect(page.getByRole('group', { name: 'フローの表示設定' })).toBeVisible();
  expect(new Set((await boxPositions(page)).map((box) => box.x)).size > 1).toBe(true);
  await page.getByRole('button', { name: 'すべて', exact: true }).click();
  const positions = await boxPositions(page);
  await page.getByRole('button', { name: '→ 横方向', exact: true }).click();
  expect(await boxPositions(page)).not.toEqual(positions);
  await expect(page.locator('.callers')).toBeVisible();
});

test('should keep the controls reachable on narrow screens and refit when the viewport changes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#hono--token');
  await expect(page.getByRole('button', { name: '幅に合わせる', exact: true })).toBeVisible();
  await expect.poll(() => page.locator('.diagram-viewport').evaluate((viewport) =>
    viewport.querySelector('svg')!.getBoundingClientRect().width <= viewport.clientWidth,
  )).toBe(true);
  const before = Number(await page.locator('.diagram').getAttribute('width'));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(async () => Number(await page.locator('.diagram').getAttribute('width')) > before).toBe(true);
});
