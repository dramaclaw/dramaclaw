// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiCall } from "@/api/client";
import {
  compileFreezoneRecipePrompt,
  generateFreezoneRecipeText,
  listFreezoneStyleTemplates,
} from "@/api/ops";

vi.mock("@/api/client", () => ({
  apiCall: vi.fn(),
  apiClient: vi.fn(),
}));

describe("freezone style template API", () => {
  beforeEach(() => {
    vi.mocked(apiCall).mockReset();
  });

  it("returns a bare template list unchanged", async () => {
    vi.mocked(apiCall).mockResolvedValueOnce([
      { id: "anime", label: "动漫", style_prompt: "anime style" },
    ]);

    await expect(listFreezoneStyleTemplates("proj")).resolves.toEqual([
      { id: "anime", label: "动漫", style_prompt: "anime style" },
    ]);
  });

  it("unwraps the nested envelope that ships asset_base alongside templates", async () => {
    vi.mocked(apiCall).mockResolvedValueOnce({
      asset_base: "/static/style-gallery",
      version: "3",
      templates: [{ id: "ink", label: "水墨", style_prompt: "ink wash" }],
    });

    await expect(listFreezoneStyleTemplates("proj")).resolves.toEqual([
      { id: "ink", label: "水墨", style_prompt: "ink wash" },
    ]);
  });

  it("returns an empty list instead of a non-array when the shape is unrecognised", async () => {
    vi.mocked(apiCall).mockResolvedValueOnce({ asset_base: "/static" });

    await expect(listFreezoneStyleTemplates("proj")).resolves.toEqual([]);
  });

  it("drops entries without a usable id", async () => {
    vi.mocked(apiCall).mockResolvedValueOnce([
      { id: "ok", label: "可用", style_prompt: "fine" },
      { label: "缺少 id", style_prompt: "broken" },
      null,
    ]);

    await expect(listFreezoneStyleTemplates("proj")).resolves.toEqual([
      { id: "ok", label: "可用", style_prompt: "fine" },
    ]);
  });
});

describe("freezone recipe API", () => {
  beforeEach(() => {
    vi.mocked(apiCall).mockReset();
  });

  it("allows long-running text generation requests", async () => {
    vi.mocked(apiCall).mockResolvedValueOnce({ content: "创意大纲" });

    const content = await generateFreezoneRecipeText({
      recipeId: "video-creative-outline",
      nodePrompt: "生成广告创意大纲",
      userGoal: "制作运动相机广告",
    });

    expect(content).toBe("创意大纲");
    expect(apiCall).toHaveBeenCalledWith(
      "freezone/recipes/generate-text",
      expect.objectContaining({
        method: "POST",
        timeout: 10 * 60 * 1000,
      }),
    );
  });

  it("allows long-running prompt compilation before media submission", async () => {
    vi.mocked(apiCall).mockResolvedValueOnce({
      prompt: "编译后的图片提示词",
      compile_mode: "timeout_fallback",
      recipe_ids: ["video-storyboard-grid", "cinematic-lighting"],
    });
    const onCompileMetadata = vi.fn();

    const prompt = await compileFreezoneRecipePrompt({
      projectId: "project-a",
      productOperationId: "agent_product_a",
      recipeId: "video-storyboard-grid",
      recipeVersion: "3.0.0",
      recipePipeline: [{ id: "cinematic-lighting", version: "2.0.0" }],
      skillId: "video-ad",
      skillVersion: "2.0.0",
      confirmedInputs: { aspect_ratio: "9:16" },
      nodeKind: "image",
      nodePrompt: "生成多宫格分镜图",
      userGoal: "制作运动相机广告",
      onCompileMetadata,
    });

    expect(prompt).toBe("编译后的图片提示词");
    expect(apiCall).toHaveBeenCalledWith(
      "freezone/recipes/compile",
      expect.objectContaining({
        method: "POST",
        timeout: 10 * 60 * 1000,
        json: expect.objectContaining({
          project_id: "project-a",
          product_operation_id: "agent_product_a",
          recipe_version: "3.0.0",
          recipe_pipeline: [{ id: "cinematic-lighting", version: "2.0.0" }],
          skill_id: "video-ad",
          skill_version: "2.0.0",
          confirmed_inputs: { aspect_ratio: "9:16" },
        }),
      }),
    );
    expect(onCompileMetadata).toHaveBeenCalledWith({
      mode: "timeout_fallback",
      prompt: "编译后的图片提示词",
      recipeIds: ["video-storyboard-grid", "cinematic-lighting"],
    });
  });

  it("coalesces concurrent prompt compilations into one bounded batch request", async () => {
    vi.mocked(apiCall).mockImplementationOnce(async (_path, options) => {
      const body = options?.json as {
        items: Array<{ request_id: string; recipe_id: string }>;
      };
      return {
        items: body.items.map((item, index) => ({
          request_id: item.request_id,
          ok: true,
          data: {
            prompt: `compiled-${index + 1}`,
            compile_mode: index === 0 ? "model" : "memory_cache",
            recipe_ids: [item.recipe_id],
          },
        })),
      };
    });
    const firstMetadata = vi.fn();
    const secondMetadata = vi.fn();

    const [first, second] = await Promise.all([
      compileFreezoneRecipePrompt({
        recipeId: "product-hero",
        nodeKind: "image",
        nodePrompt: "商品主视觉",
        onCompileMetadata: firstMetadata,
      }),
      compileFreezoneRecipePrompt({
        recipeId: "product-detail",
        nodeKind: "image",
        nodePrompt: "材质细节",
        onCompileMetadata: secondMetadata,
      }),
    ]);

    expect([first, second]).toEqual(["compiled-1", "compiled-2"]);
    expect(apiCall).toHaveBeenCalledTimes(1);
    expect(apiCall).toHaveBeenCalledWith(
      "freezone/recipes/compile-batch",
      expect.objectContaining({
        method: "POST",
        timeout: 10 * 60 * 1000,
        json: expect.objectContaining({
          items: [
            expect.objectContaining({ recipe_id: "product-hero" }),
            expect.objectContaining({ recipe_id: "product-detail" }),
          ],
        }),
      }),
    );
    expect(firstMetadata).toHaveBeenCalledWith({
      mode: "model",
      prompt: "compiled-1",
      recipeIds: ["product-hero"],
    });
    expect(secondMetadata).toHaveBeenCalledWith({
      mode: "memory_cache",
      prompt: "compiled-2",
      recipeIds: ["product-detail"],
    });
  });

  it("keeps successful batch items when another Recipe compilation fails", async () => {
    vi.mocked(apiCall).mockImplementationOnce(async (_path, options) => {
      const body = options?.json as {
        items: Array<{ request_id: string }>;
      };
      return {
        items: [
          {
            request_id: body.items[0].request_id,
            ok: true,
            data: {
              prompt: "compiled-image",
              compile_mode: "model",
              recipe_ids: ["image"],
            },
          },
          {
            request_id: body.items[1].request_id,
            ok: false,
            error: "Recipe compilation failed",
            retryable: true,
          },
        ],
      };
    });

    const outcomes = await Promise.allSettled([
      compileFreezoneRecipePrompt({
        recipeId: "image",
        nodeKind: "image",
        nodePrompt: "主视觉",
      }),
      compileFreezoneRecipePrompt({
        recipeId: "broken-audio",
        nodeKind: "audio",
        nodePrompt: "背景音乐",
      }),
    ]);

    expect(outcomes[0]).toEqual({ status: "fulfilled", value: "compiled-image" });
    expect(outcomes[1]).toEqual({
      status: "rejected",
      reason: expect.objectContaining({
        message: "HTTP 503: Recipe compilation failed",
      }),
    });
  });

  it("falls back to single compilation when the backend has no batch endpoint", async () => {
    vi.mocked(apiCall)
      .mockRejectedValueOnce({ status: 404 })
      .mockResolvedValueOnce({
        prompt: "first-single",
        compile_mode: "model",
        recipe_ids: ["first"],
      })
      .mockResolvedValueOnce({
        prompt: "second-single",
        compile_mode: "model",
        recipe_ids: ["second"],
      });

    const prompts = await Promise.all([
      compileFreezoneRecipePrompt({
        recipeId: "first",
        nodeKind: "image",
        nodePrompt: "第一张图",
      }),
      compileFreezoneRecipePrompt({
        recipeId: "second",
        nodeKind: "video",
        nodePrompt: "第二段视频",
      }),
    ]);

    expect(prompts).toEqual(["first-single", "second-single"]);
    expect(apiCall).toHaveBeenCalledTimes(3);
    expect(vi.mocked(apiCall).mock.calls.map(([path]) => path)).toEqual([
      "freezone/recipes/compile-batch",
      "freezone/recipes/compile",
      "freezone/recipes/compile",
    ]);
  });
});
