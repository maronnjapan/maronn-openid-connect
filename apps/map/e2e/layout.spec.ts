import { expect, test } from '@playwright/test';
import { chartArea, EXCHANGE_HEADER, player, requestPanel, requestPanelToggle, responseLine, sceneShown, WORKSPACE_HEADER, workspaceOf } from './test-helpers';

/**
 * The flow gives a laptop's screen to its chart: below 1600px of width the
 * request panel starts hidden, and the scene is read in a column beside the
 * chart, which takes the height below the player. The button of the bar
 * shows the panel (the stage, narrower, puts the scene back below the
 * chart) and the choice stays for the next visit. What the stage says the
 * panel holds is a button away while the panel is hidden.
 */
test.describe('the flow on the width of a laptop', () => {
  test('should hide the request panel and read the scene beside the chart, until the bar shows the panel, which stays shown', async ({ page }) => {
    await page.goto('/#hono--token;p');
    await expect(requestPanelToggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(requestPanel(page)).toBeHidden();
    await expect(sceneShown(page)).toContainText('1 / ');

    await test.step('the panel hidden: the scene beside the chart, the chart below the player', async () => {
      const chart = await chartArea(page).boundingBox();
      const scene = await sceneShown(page).boundingBox();
      const controls = await player(page).boundingBox();
      expect(chart).not.toBeNull();
      expect(scene).not.toBeNull();
      expect(controls).not.toBeNull();
      expect(scene!.x).toBeGreaterThanOrEqual(chart!.x + chart!.width - 1);
      expect(scene!.y).toBeLessThan(chart!.y + chart!.height);
      expect(chart!.y).toBeGreaterThanOrEqual(controls!.y + controls!.height - 1);
      // The chart's tools are in the bar above the player, not a row of the chart's own.
      const tools = await page.getByRole('group', { name: '図の表示操作' }).boundingBox();
      expect(tools).not.toBeNull();
      expect(tools!.y + tools!.height).toBeLessThanOrEqual(controls!.y + 1);
    });

    await test.step('the bar shows the panel: the scene goes below the chart on the narrower stage', async () => {
      await requestPanelToggle(page).click();
      await expect(requestPanelToggle(page)).toHaveAttribute('aria-expanded', 'true');
      await expect(requestPanel(page)).toBeVisible();
      await expect(async () => {
        const chart = await chartArea(page).boundingBox();
        const scene = await sceneShown(page).boundingBox();
        expect(chart).not.toBeNull();
        expect(scene).not.toBeNull();
        expect(scene!.y).toBeGreaterThanOrEqual(chart!.y + chart!.height - 1);
      }).toPass();
    });

    await test.step('the choice stays for the next visit, and hiding the panel stays too', async () => {
      await page.reload();
      await expect(requestPanelToggle(page)).toHaveAttribute('aria-expanded', 'true');
      await expect(requestPanel(page)).toBeVisible();
      await requestPanelToggle(page).click();
      await expect(requestPanel(page)).toBeHidden();
      await page.reload();
      await expect(requestPanelToggle(page)).toHaveAttribute('aria-expanded', 'false');
      await expect(requestPanel(page)).toBeHidden();
    });
  });

  test('should show the hidden panel from the stage when the request opened ran no step, to read what it answered', async ({ page, context }) => {
    await page.goto('/#hono--token;p');
    await expect(requestPanelToggle(page)).toHaveAttribute('aria-expanded', 'false');
    // The hidden panel still talks to the live OP: the page names its workspace in a cookie.
    let workspace = '';
    await expect(async () => {
      workspace = await workspaceOf(context);
    }).toPass();
    // A method the token endpoint does not take: the router answers 405, and no step of the endpoint runs.
    const response = await page.request.put('/token', { headers: { [WORKSPACE_HEADER]: workspace } });
    expect(response.status()).toBe(405);
    const exchange = response.headers()[EXCHANGE_HEADER];
    expect(exchange).toMatch(/^x\d+$/);

    const map = await context.newPage();
    await map.goto(`/#hono--token;p;x=${exchange}`);
    await expect(sceneShown(map)).toContainText('このリクエストではエンドポイントの処理は動いていません');
    await expect(requestPanel(map)).toBeHidden();
    await sceneShown(map).getByRole('button', { name: 'リクエストの欄を開く' }).click();
    await expect(requestPanel(map)).toBeVisible();
    await expect(responseLine(map)).toContainText('405 Method Not Allowed');
    await expect(requestPanelToggle(map)).toHaveAttribute('aria-expanded', 'true');
  });
});
