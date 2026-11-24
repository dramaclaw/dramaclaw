// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { expect, test, type Locator } from '@playwright/test';

const topOf = (item: Locator) => item.evaluate(el => el.getBoundingClientRect().top);
const heightOf = (item: Locator) => item.evaluate(el => el.getBoundingClientRect().height);
const openGuideHeight = (menu: Locator) => menu.locator('[id$="-detail"]').evaluateAll(
  guides => guides[0]?.getBoundingClientRect().height ?? 0,
);

async function expectInlineDetail(row: Locator, i: number) {
  const option = row.locator('../..');
  const detail = option.getByText(`Preview for model ${i}`, {exact: true});
  await expect(detail).toBeAttached();
  const header = (await row.boundingBox())!;
  const detailBox = (await detail.boundingBox())!;
  expect(detailBox.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
}

// Switching guides can remove content above the pointer. At a real scroll
// edge the removed space cannot be preserved without inserting a blank band.
async function expectNearestReachableY(row: Locator, before: number, removedHeight: number) {
  const {y, scrollTop, maxScroll, scale} = await row.evaluate(el => {
    const scroll = el.closest<HTMLElement>('.ui-scrollbar')!;
    return {y: el.getBoundingClientRect().top, scrollTop: scroll.scrollTop,
      maxScroll: scroll.scrollHeight - scroll.clientHeight,
      scale: scroll.getBoundingClientRect().height / scroll.offsetHeight};
  });
  const delta = y - before;
  expect(Math.abs(delta)).toBeLessThan(removedHeight + 1.5);
  if (delta < -1.5) expect(scrollTop * scale).toBeLessThan(1.5);
  if (delta > 1.5) expect((maxScroll - scrollTop) * scale).toBeLessThan(1.5);
}

for (const mode of ['image', 'video', 'grouped-inline', 'grouped-portal']) {
  test(`${mode}: collapsing an upper guide never leaves an empty band above the first model`, async ({ page }) => {
    const grouped = mode.startsWith('grouped-') ? mode.slice(8) : '';
    await page.goto(`/e2e/model-picker.html?placement=top&domain=${grouped ? 'image' : mode}&grouped=${grouped}&count=10&firstGuide`);
    await page.getByRole('button', {name: 'Model 0', exact: true}).click();
    const menu = page.locator('.canvas-node-transient-ui');
    const scroll = grouped ? menu.locator('.ui-scrollbar') : menu;
    const rows = menu.locator('button[aria-pressed]');
    const initialGap = await topOf(rows.first()) - await topOf(menu);
    for (const i of [0, 1, 2, 3, 4, 0, 1, 2]) {
      await rows.nth(i).hover();
      if (i === 0 || i % 2) await expectInlineDetail(rows.nth(i), i);
      else await expect(menu.getByText(/Preview for model/)).toHaveCount(0);
      const leadingGap = await topOf(rows.first()) - await topOf(menu);
      expect(leadingGap).toBeLessThanOrEqual(initialGap + 1);
    }
    await page.mouse.move(0, 0);
    await expect(menu.getByText(/Preview for model/)).toHaveCount(0);
    await scroll.evaluate(el => { el.scrollTop = 0; });
    expect(await topOf(rows.first()) - await topOf(menu)).toBeCloseTo(initialGap, 0);
  });
}

for (const mode of ['image', 'video', 'grouped-inline', 'grouped-portal']) {
  test(`${mode}: wheel reveals the last model's full inline guide without moving the canvas`, async ({page}) => {
    const grouped = mode.startsWith('grouped-') ? mode.slice(8) : '';
    await page.goto(`/e2e/model-picker.html?canvas&placement=top&domain=${grouped ? 'image' : mode}&count=8&longGuide&grouped=${grouped}`);
    const trigger = page.locator('.react-flow__node').getByRole('button', {name: 'Model 0', exact: true}).first();
    await trigger.click();
    const menu = page.locator('.canvas-node-transient-ui');
    const row = menu.getByRole('button', {name: 'Model 7', exact: true});
    await row.scrollIntoViewIfNeeded();
    const top = await topOf(row);
    await row.hover();
    const detail = menu.getByText(/End of guide/);
    await expect(detail).toBeAttached();
    expect(Math.abs(await topOf(row) - top)).toBeLessThan(1.5);
    const bottom = (item: Locator) => item.evaluate(el => el.getBoundingClientRect().bottom);
    expect(await bottom(detail)).toBeGreaterThan(await bottom(menu));
    const before = await trigger.boundingBox();
    await page.mouse.wheel(0, 1200);
    await expect.poll(async () => (await bottom(detail)) - (await bottom(menu))).toBeLessThanOrEqual(0);
    expect(await trigger.boundingBox()).toEqual(before);
    await expect(menu).toBeVisible();
  });
}

for (const domain of ['image', 'video']) {
  test(`${domain}: an open menu follows actual React Flow pans and node drags`, async ({page}) => {
    await page.goto(`/e2e/model-picker.html?canvas&placement=top&domain=${domain}&count=6`);
    const trigger = page.locator('.react-flow__node').getByRole('button', {name: 'Model 0', exact: true});
    const menu = page.locator('.canvas-node-transient-ui');
    await trigger.click();
    async function drag(x: number, y: number, dx: number, dy: number) {
      const before = (await trigger.boundingBox())!;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, {steps: 10});
      await page.mouse.up();
      await expect.poll(async () => Math.abs((await trigger.boundingBox())!.x - before.x)).toBeGreaterThan(20);
      await expect.poll(async () => {
        const m = await menu.boundingBox(), t = (await trigger.boundingBox())!;
        return m && [Math.round(m.x - t.x), Math.round(t.y - (m.y + m.height))];
      }).toEqual([0, 8]);
    }
    await drag(50, 50, 90, 70);
    const handle = (await page.getByText('Drag node').boundingBox())!;
    // Start clear of the portal just above the trigger.
    await drag(handle.x + handle.width - 12, handle.y + handle.height / 2, -75, -55);
    const previousWidth = (await trigger.boundingBox())!.width;
    await page.mouse.move(340, 480);
    await page.mouse.wheel(0, -120);
    await expect.poll(async () => (await trigger.boundingBox())!.width).toBeGreaterThan(previousWidth + 2);
    await expect.poll(async () => {
      const m = (await menu.boundingBox())!, t = (await trigger.boundingBox())!;
      return [Math.round(Math.abs(m.x - t.x)), Math.round(t.y - m.y - m.height)];
    }).toEqual([0, 8]);
    await page.mouse.click(55, 55);
    await expect(menu).toHaveCount(0);
  });
}

for (const mode of ['image', 'video', 'grouped-portal', 'grouped-inline']) {
  test(`${mode}: follows transformed nodes and repeated previews never move the menu away from its trigger`, async ({ page }) => {
    const grouped = mode.startsWith('grouped-') ? mode.slice(8) : '';
    await page.goto(`/e2e/model-picker.html?placement=top&domain=${mode}&count=6&grouped=${grouped}`);
    const node = page.locator('#picker-fixture');
    await node.evaluate(el => Object.assign(el.style, {left: '160px', bottom: '100px'}));
    const trigger = node.getByRole('button', {name: 'Model 0', exact: true}).first();
    await trigger.click();
    const menu = page.locator('.canvas-node-transient-ui').filter({has: page.locator('button[aria-pressed]')}).first();
    const offset = async () => {
      const m = (await menu.boundingBox())!, t = (await trigger.boundingBox())!;
      return {x: Math.round(m.x - t.x), y: Math.round(t.y - m.y - m.height)};
    };
    const initial = await offset();
    for (const i of [1, 0, 1, 3, 0, 3, 1]) {
      await menu.getByRole('button', {name: `Model ${i}`, exact: true}).hover();
      if (i) await expect(menu.getByText(`Preview for model ${i}`)).toBeVisible();
      else await expect(menu.getByText(/Preview for model/)).toHaveCount(0);
      expect(await offset()).toEqual(initial);
    }
    // React Flow pans by changing an ancestor transform, not by scrolling the window.
    for (const move of ['110px 50px', '-75px -65px', '0px 0px']) {
      await node.evaluate((el, translate) => { el.style.translate = translate; }, move);
      await expect.poll(offset).toEqual(initial);
    }
  });
}

for (const grouped of ['inline', 'portal']) {
  test(`grouped image picker pins the model name in ${grouped} mode`, async ({ page }) => {
    await page.goto(`/e2e/model-picker.html?placement=top&domain=image&count=6&grouped=${grouped}`);
    await page.getByRole('button', {name: 'Model 0', exact: true}).click();
    const menu = page.locator('.canvas-node-transient-ui').filter({has: page.locator('button[aria-pressed]')}).first();
    for (const i of [1, 3, 1]) {
      const row = menu.getByRole('button', {name: `Model ${i}`, exact: true});
      const y = await topOf(row);
      const removedHeight = await openGuideHeight(menu);
      await row.hover();
      await expect(menu.getByText(`Preview for model ${i}`)).toBeVisible();
      await expectInlineDetail(row, i);
      await expectNearestReachableY(row, y, removedHeight);
    }
  });
}

for (const placement of ['top', 'bottom']) {
  for (const domain of ['image', 'video']) {
    test(`${domain}: ${placement} picker fits short lists and pins the hovered row`, async ({ page }) => {
      await page.goto(`/e2e/model-picker.html?placement=${placement}&domain=${domain}&count=4&theme=${domain === 'image' ? 'dark' : 'light'}`);
      const trigger = page.locator('button[aria-expanded]').first();
      await trigger.click();
      const menu = page.locator('.canvas-node-transient-ui');
      const rows = menu.locator('button[aria-pressed]');
      const first = rows.first(), last = rows.last();
      const height = await heightOf(menu);
      if (placement === 'top') expect((await topOf(menu)) + height).toBeLessThan(await topOf(trigger));
      else expect(await topOf(menu)).toBeGreaterThan((await topOf(trigger)) + await heightOf(trigger));
      expect(height - ((await topOf(last)) + (await heightOf(last)) - (await topOf(first)))).toBeLessThan(20);
      for (const i of [1, 3, 1]) {
        const row = rows.nth(i);
        await row.scrollIntoViewIfNeeded();
        const y = await topOf(row);
        const removedHeight = await openGuideHeight(menu);
        await row.hover();
        await expectInlineDetail(row, i);
        await expectNearestReachableY(row, y, removedHeight);
        if (placement === 'top') {
          expect(await heightOf(menu)).toBeCloseTo(height, 0);
          expect(await menu.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
        }
      }
      await page.mouse.move(0, 0);
      await expect(menu.getByText(/Preview for model/)).toHaveCount(0);
      expect(await heightOf(menu)).toBeCloseTo(height, 0);
    });
  }
  test(`${placement} picker scrolls within a small viewport without displacing the hovered row`, async ({ page }) => {
    await page.setViewportSize({width: 320, height: 270});
    await page.goto(`/e2e/model-picker.html?placement=${placement}&domain=video&count=16`);
    await page.getByRole('button', { name: 'Model 0', exact: true }).click();
    const menu = page.locator('.canvas-node-transient-ui');
    await menu.evaluate(el => { el.scrollTop = 170; });
    const trigger = page.locator('#picker-fixture button').first();
    const edgeGap = async () => {
      const m = (await menu.boundingBox())!, t = (await trigger.boundingBox())!;
      return placement === 'top' ? t.y - m.y - m.height : m.y - t.y - t.height;
    };
    for (const i of [5, 4, 5, 7, 5]) {
      const row = menu.getByRole('button', { name: `Model ${i}`, exact: true });
      // Separate user scrolling from disclosure: locator.hover() can scroll
      // clipped rows into view *after* the baseline measurement.
      await row.scrollIntoViewIfNeeded();
      const r = (await row.boundingBox())!;
      await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
      if (i % 2) await expectInlineDetail(row, i);
      else await expect(menu.getByText(/Preview for model/)).toHaveCount(0);
      expect(Math.abs(await topOf(row) - r.y)).toBeLessThan(1.5);
      expect(await edgeGap()).toBeCloseTo(8, 0);
    }
    expect(await menu.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    const box = (await menu.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(7);
    expect(box.y + box.height).toBeLessThanOrEqual(263);
  });
}
