// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiCallEnvelope } from "@/api/client";
import { listFreezoneStyleTemplates } from "@/api/ops";

vi.mock("@/api/client", () => ({
  apiCall: vi.fn(),
  apiCallEnvelope: vi.fn(),
  apiClient: vi.fn(),
}));

const TEMPLATE = {
  id: "gu-zhuang-01",
  label: "工笔重彩",
  category: "古装",
  cover: "gu-zhuang-01/cover.jpg",
  samples: ["gu-zhuang-01/f.jpg", "gu-zhuang-01/m.jpg"],
  style_prompt: "工笔重彩，青绿设色",
};

/**
 * 这个端点的 `data` 形状在两个仓库间改过来又改回去，每改一次都把没跟进的前端打成
 * 白屏（`templates.find is not a function` 冒泡到根错误边界）。这里把「后端可能吐
 * 什么」全钉死：任何一种都不许抛，认不出的最多退化成空图墙。
 */
describe("listFreezoneStyleTemplates 对后端形状的容错", () => {
  beforeEach(() => {
    vi.mocked(apiCallEnvelope).mockReset();
  });

  it("裸列表（当前契约，也是最早的形状）", async () => {
    vi.mocked(apiCallEnvelope).mockResolvedValue({
      ok: true,
      data: [TEMPLATE],
      asset_base: "https://cdn.example.com/style",
      version: "2026-08-06",
    });

    const result = await listFreezoneStyleTemplates("p1");

    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]).toEqual(TEMPLATE);
    expect(result.assetBase).toBe("https://cdn.example.com/style");
    expect(result.version).toBe("2026-08-06");
  });

  it("data 是 {asset_base, version, templates} 对象（曾经的破坏性形状）", async () => {
    vi.mocked(apiCallEnvelope).mockResolvedValue({
      ok: true,
      data: {
        asset_base: "https://cdn.example.com/style",
        version: "2026-08-06",
        templates: [TEMPLATE],
      },
    });

    const result = await listFreezoneStyleTemplates("p1");

    expect(result.templates).toEqual([TEMPLATE]);
    expect(result.assetBase).toBe("https://cdn.example.com/style");
    expect(result.version).toBe("2026-08-06");
  });

  it("其它常见包装（data / items / style_templates）", async () => {
    for (const key of ["data", "items", "style_templates"]) {
      vi.mocked(apiCallEnvelope).mockResolvedValue({
        ok: true,
        data: { [key]: [TEMPLATE] },
      });
      const result = await listFreezoneStyleTemplates("p1");
      expect(result.templates, `包装键 ${key}`).toEqual([TEMPLATE]);
    }
  });

  it("完全认不出的形状退空列表，不抛", async () => {
    for (const data of [null, undefined, 42, "nope", { unexpected: true }]) {
      vi.mocked(apiCallEnvelope).mockResolvedValue({ ok: true, data });
      await expect(listFreezoneStyleTemplates("p1")).resolves.toEqual({
        assetBase: "",
        version: "",
        templates: [],
      });
    }
  });

  it("丢掉没有 id 的条目，其余字段缺失只降级不丢条目", async () => {
    vi.mocked(apiCallEnvelope).mockResolvedValue({
      ok: true,
      data: [
        { label: "没有 id" },
        null,
        "字符串",
        { id: "bare" },
        TEMPLATE,
      ],
    });

    const result = await listFreezoneStyleTemplates("p1");

    expect(result.templates.map((item) => item.id)).toEqual(["bare", TEMPLATE.id]);
    // 缺字段的那条要能安全渲染：label 兜底成 id，samples 是数组而不是 undefined。
    expect(result.templates[0]).toEqual({
      id: "bare",
      label: "bare",
      category: "",
      cover: "",
      samples: [],
      style_prompt: "",
    });
  });

  it("samples 里的非字符串成员被剔掉", async () => {
    vi.mocked(apiCallEnvelope).mockResolvedValue({
      ok: true,
      data: [{ ...TEMPLATE, samples: ["ok.jpg", null, 7, "", "also-ok.jpg"] }],
    });

    const result = await listFreezoneStyleTemplates("p1");

    expect(result.templates[0].samples).toEqual(["ok.jpg", "also-ok.jpg"]);
  });
});
