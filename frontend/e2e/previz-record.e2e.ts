// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 预演台冒烟：打开编辑器 → 放一台机位 → 全局录制 → 成片是恒定 30 fps 的 mp4，
 * 并且作为视频节点接回了画布。
 *
 * 跑在真浏览器里是因为这条路上的东西 jsdom 一样都没有：WebGL、WebCodecs、rAF 节拍。
 * 不需要登录也不需要后端，`/api/v1` 全部在这里拦掉。
 */
import { expect, test, type Request } from "@playwright/test";
import { ALL_FORMATS, BufferSource, Input } from "mediabunny";

const FRAMES = 45;
const FPS = 30;
const UPLOADED_URL = "/api/v1/smoke/recording.mp4";

/** 从 multipart 请求体里把 `file` 那一段的原始字节切出来。 */
function uploadedFile(request: Request): Buffer {
  const body = request.postDataBuffer();
  const boundary = /boundary=(.+)$/.exec(request.headers()["content-type"] ?? "")?.[1];
  if (!body || !boundary) throw new Error("upload is not multipart");
  const start = body.indexOf("\r\n\r\n") + 4;
  const end = body.lastIndexOf(`\r\n--${boundary}`);
  return body.subarray(start, end);
}

test("records a constant 30 fps mp4 and lands it on the canvas", async ({ page }) => {
  let recording: Buffer | null = null;
  const unexpected: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    if (request.method() === "POST" && request.url().endsWith("/freezone/upload")) {
      recording = uploadedFile(request);
      await route.fulfill({
        json: {
          ok: true,
          data: { url: UPLOADED_URL, filename: "recording.mp4", size: recording.length },
        },
      });
      return;
    }
    unexpected.push(`${request.method()} ${request.url()}`);
    await route.fulfill({ status: 404, json: { ok: false, error: "not stubbed" } });
  });

  await page.goto(`/e2e/previz.html?p=smoke&frames=${FRAMES}`);

  await page.getByRole("button", { name: "添加机位" }).click();
  await page.getByRole("button", { name: "录制", exact: true }).click();
  await page.getByRole("menuitem", { name: "全局录制" }).click();

  await expect(page.getByText("已生成录制节点")).toBeVisible({ timeout: 90_000 });

  const nodes = await page.evaluate(() => window.__previzHarness!.videoNodes());
  expect(nodes).toEqual([
    { videoUrl: UPLOADED_URL, durationMs: Math.round(((FRAMES + 1) / FPS) * 1000) },
  ]);

  expect(recording).not.toBeNull();
  const input = new Input({ source: new BufferSource(recording!), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  expect(video?.codec).toBe("avc");
  const stats = await video!.computePacketStats();
  // 0..FRAMES 每帧一格，一帧不多一帧不少，平均帧率才正好是 30。掉回实时录制的话
  // 这里对不上：那条路出的帧数跟着渲染快慢走。
  expect(stats.packetCount).toBe(FRAMES + 1);
  expect(stats.averagePacketRate).toBeCloseTo(FPS, 3);
  expect(await input.computeDuration()).toBeCloseTo((FRAMES + 1) / FPS, 3);

  expect(unexpected).toEqual([]);
});
