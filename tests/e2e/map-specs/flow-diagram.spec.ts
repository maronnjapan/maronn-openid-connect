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
  await page.getByRole('button', { name: '表示するケースを選択', exact: true }).click();
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
  const step = page.locator('.diagram .box[role="button"]').first();
  const fitted = await boxPositions(page);
  await step.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'トークンリクエストを解析する — ステップの詳細', exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('parseTokenRequest()', { exact: true })).toBeVisible();
  await drawer.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(step).toBeFocused();
  expect(await boxPositions(page)).toEqual(fitted);
});

test('should close step details with the close button or backdrop and restore focus to the step', async ({ page }) => {
  await page.goto('/#hono--token');
  const step = page.locator('.diagram .box[role="button"]').first();
  const drawer = page.getByRole('dialog', { name: 'トークンリクエストを解析する — ステップの詳細', exact: true });
  await step.click();
  await expect(drawer).toBeVisible();
  const close = drawer.getByRole('button', { name: '詳細を閉じる', exact: true });
  await expect(close).toBeFocused();
  // The modal makes the background inert, including programmatic focus attempts.
  await step.focus();
  await expect(close).toBeFocused();
  await drawer.getByRole('heading', { level: 3 }).click();
  await expect(drawer).toBeVisible();
  await close.click();
  await expect(drawer).toHaveCount(0);
  await expect(step).toBeFocused();
  await step.press('Enter');
  await expect(drawer).toBeVisible();
  await page.mouse.click(16, 500);
  await expect(drawer).toHaveCount(0);
  await expect(step).toBeFocused();
});

test('should show mobile step details at full viewport size without shrinking the flow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#hono--token');
  const step = page.locator('.diagram .box[role="button"]').first();
  await expect(step).toBeVisible();
  const before = await page.locator('.diagram-viewport').boundingBox();
  await step.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'トークンリクエストを解析する — ステップの詳細', exact: true });
  await expect(drawer).toBeVisible();
  expect(await drawer.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  expect(await page.locator('.diagram-viewport').boundingBox()).toEqual(before);
  await drawer.getByRole('button', { name: '詳細を閉じる', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(step).toBeFocused();
});

test('should open member documentation in a dialog and return to the same function flow', async ({ page }) => {
  await page.goto('/#hono--fn--getAuthTransaction');
  const member = page.getByRole('button', { name: /^store\.get\(\):/ });
  await expect(member).toBeVisible();
  const before = await boxPositions(page);
  await member.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'AuthTransactionStore.get()', exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('`key` のトランザクションを返す。', { exact: true })).toBeVisible();
  await expect(page.locator('.diagram .box.selected')).toHaveCount(1);
  await drawer.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(member).toBeFocused();
  await expect(page.locator('.diagram .box.selected')).toHaveCount(0);
  expect(await boxPositions(page)).toEqual(before);
});

test('should use the same branching layout and display controls on function pages', async ({ page }) => {
  await page.goto('/#hono--fn--verifyClientSecret');
  await expect(page.getByRole('group', { name: 'フローの表示設定' })).toBeVisible();
  expect(new Set((await boxPositions(page)).map((box) => box.x)).size > 1).toBe(true);
  await page.getByRole('button', { name: '表示するケースを選択', exact: true }).click();
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
  expect(await page.locator('.diagram-viewport').evaluate((element) => element.clientHeight) >= 844 * 0.6).toBe(true);
  await expect.poll(() => page.locator('.diagram-viewport').evaluate((viewport) =>
    viewport.querySelector('svg')!.getBoundingClientRect().width <= viewport.clientWidth,
  )).toBe(true);
  const before = Number(await page.locator('.diagram').getAttribute('width'));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(async () => Number(await page.locator('.diagram').getAttribute('width')) > before).toBe(true);
});

for (const target of ['/#hono--token', '/#hono--fn--verifyClientSecret']) {
  test(`should collapse the description by default and remember its visibility on ${target}`, async ({ page }) => {
    await page.goto(target);
    const expand = page.getByRole('button', { name: '説明を表示', exact: true });
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.screen-description')).toBeHidden();
    const collapsedHeight = await page.locator('.diagram-viewport').evaluate((element) => element.clientHeight);
    await expand.click();
    await expect(page.getByRole('button', { name: '説明を閉じる', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.screen-description')).toBeVisible();
    expect(await page.locator('.diagram-viewport').evaluate((element) => element.clientHeight) < collapsedHeight).toBe(true);
    await page.reload();
    await expect(page.getByRole('button', { name: '説明を閉じる', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: '説明を閉じる', exact: true }).click();
    await expect(page.locator('.screen-description')).toBeHidden();
    expect(await page.locator('.diagram-viewport').evaluate((element) => element.clientHeight)).toBe(collapsedHeight);
    // The same preference applies when moving between endpoint and function pages.
    await page.goto('/#hono--fn--validateAuthorizationRequestParams');
    await expect(page.getByRole('button', { name: '説明を表示', exact: true })).toHaveAttribute('aria-expanded', 'false');
  });
}

test('should fold the case list without changing selected paths', async ({ page }) => {
  await page.goto('/#hono--token');
  const toggle = page.getByRole('button', { name: '表示するケースを選択', exact: true });
  await expect(page.locator('.case-list')).toBeHidden();
  await expect(page.locator('.cases-current')).toHaveText('authorization_code');
  await toggle.press('Enter');
  await expect(page.locator('.case-list')).toBeVisible();
  await page.getByRole('button', { name: 'すべて', exact: true }).click();
  const arrows = await page.locator('.diagram .edge').count();
  const openHeight = await page.locator('.diagram-viewport').evaluate((element) => element.clientHeight);
  await toggle.press('Enter');
  await expect(page.locator('.case-list')).toBeHidden();
  await expect(page.locator('.diagram .edge')).toHaveCount(arrows);
  expect(await page.locator('.diagram-viewport').evaluate((element) => element.clientHeight) > openHeight).toBe(true);
  await expect(page.locator('.cases-count')).toHaveText('3 / 3');
  await toggle.click();
  await expect(page.locator('.cases input:checked')).toHaveCount(3);
});
