// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 风格清单拉失败后必须还能再来一次。同族的 useFreezoneCameraOptions 是「一个 tab
// 只拉一次」，失败就永久失败 —— 相机参数没了顶多少几个可选项，风格没了则是整墙
// 占位块，而且已选中的风格照样会跟着生成请求走，用户完全无从补救。
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchTemplates = vi.fn();

vi.mock("@/api/ops", () => ({
  listFreezoneStyleTemplates: (project: string) => fetchTemplates(project),
}));

import { useFreezoneStyleTemplates } from "@/features/canvas/hooks/useFreezoneStyleTemplates";

const TEMPLATE = {
  id: "golden_age",
  label: "黄金时代",
  category: "年代",
  cover: "golden_age/cover.webp",
  samples: ["golden_age/female.webp"],
  style_prompt: "黄金时代的提示词",
};

// 模块级缓存按 project 分桶，每个用例换一个 project 就等于拿到一份干净状态。
let seq = 0;
function nextProject() {
  seq += 1;
  return `proj-${seq}`;
}

describe("useFreezoneStyleTemplates 的重试", () => {
  beforeEach(() => {
    fetchTemplates.mockReset();
  });

  it("失败后 retry 能把清单拉回来", async () => {
    const project = nextProject();
    fetchTemplates.mockRejectedValueOnce(new Error("boom"));

    const { result } = renderHook(() => useFreezoneStyleTemplates(project));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.templates).toEqual([]);
    expect(result.current.isLoading).toBe(false);

    fetchTemplates.mockResolvedValueOnce({
      templates: [TEMPLATE],
      assetBase: "https://cdn.example.com/style-gallery",
    });
    act(() => result.current.retry());

    await waitFor(() => expect(result.current.templates).toHaveLength(1));
    expect(result.current.error).toBeNull();
    expect(result.current.assetBase).toBe("https://cdn.example.com/style-gallery");
    expect(fetchTemplates).toHaveBeenCalledTimes(2);
  });

  it("成功态调用 retry 不会白白再拉一次", async () => {
    const project = nextProject();
    fetchTemplates.mockResolvedValueOnce({
      templates: [TEMPLATE],
      assetBase: "",
    });

    const { result } = renderHook(() => useFreezoneStyleTemplates(project));
    await waitFor(() => expect(result.current.templates).toHaveLength(1));

    act(() => result.current.retry());

    expect(fetchTemplates).toHaveBeenCalledTimes(1);
  });

  it("重复渲染不会自己重试 —— 那会变成失败/重渲染的死循环", async () => {
    const project = nextProject();
    fetchTemplates.mockRejectedValue(new Error("boom"));

    const { result, rerender } = renderHook(() =>
      useFreezoneStyleTemplates(project),
    );
    await waitFor(() => expect(result.current.error).not.toBeNull());

    rerender();
    rerender();

    expect(fetchTemplates).toHaveBeenCalledTimes(1);
  });
});
