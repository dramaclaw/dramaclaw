// SPDX-License-Identifier: Elastic-2.0
import { Ticker } from "pixi.js";
import { expect, it } from "vitest";
import { createClickFeedback } from "./click-feedback";
it("reuses one marker and releases its ticker after fading and disposal", () => {
  const ticker = new Ticker(); ticker.autoStart = false;
  const feedback = createClickFeedback(ticker);
  expect(ticker.count).toBe(0);
  feedback.show({ x: 10, y: 20 });
  feedback.show({ x: 30, y: 40 });
  expect(ticker.count).toBe(1);
  expect(feedback.marker.x).toBe(30);
  for (let time = 100; time <= 700; time += 100) ticker.update(time);
  expect(feedback.marker.visible).toBe(false);
  expect(ticker.count).toBe(0);
  feedback.show({ x: 50, y: 60 });
  feedback.destroy();
  expect(ticker.count).toBe(0);
  ticker.destroy();
});
