import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "@/features/canvas/domain/canvasNodes";
const { generate, viewer } = vi.hoisted(() => ({
  generate: vi.fn(),
  viewer: vi.fn(),
}));
vi.mock("@/features/canvas/application/derivedMedia", () => ({
  generateDerivedMedia: generate,
}));
vi.mock("@/features/canvas/ui/ImageDerivedActions", () => ({
  useDerivedVideoCost: () => ({
    available: true,
    cost: { data: { data: { display: "80" } } },
  }),
}));
vi.mock("@/components/credit-cost-inline", () => ({
  CreditCostInline: () => null,
}));
vi.mock("@/stores/canvasStore", () => ({
  useCanvasStore: () => ({ updateNodeData: vi.fn(), openImageViewer: viewer }),
}));
vi.mock("@/lib/url-params", () => ({
  readUrl: () => ({ project: "p", canvas: "c" }),
}));
import { DerivedMediaActions } from "@/features/canvas/ui/DerivedMediaActions";
function node(data: Record<string, unknown>): CanvasNode {
  return {
    id: "gif",
    type: "animatedGifNode",
    position: { x: 0, y: 0 },
    data,
  } as CanvasNode;
}
describe("derived media toolbar states", () => {
  it("requires confirmation before regenerating a paid video", () => {
    generate.mockClear();
    render(<DerivedMediaActions node={node({ sourceImageUrl: "/a.png", generationError: "failed" })} />);
    fireEvent.click(screen.getByRole("button", { name: "重新生成视频" }));
    expect(generate).not.toHaveBeenCalled();
    expect(screen.getByText(/视频按报价计费/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认生成" }));
    expect(generate).toHaveBeenCalledWith("p", "gif", "gif", "/a.png", undefined, "c", expect.any(Function));
  });
  it("offers preview/download after success without duplicate delete or retry", () => {
    render(<DerivedMediaActions node={node({ imageUrl: "/a.gif" })} />);
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    expect(viewer).toHaveBeenCalledWith("/a.gif", ["/a.gif"]);
    expect(screen.getByRole("button", { name: "下载 GIF" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /删除|重试/ })).toBeNull();
  });
  it("only retries local conversion when a paid video exists", () => {
    render(
      <DerivedMediaActions
        node={node({
          sourceImageUrl: "/a.png",
          sourceVideoUrl: "/v.mp4",
          generationError: "failed",
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "重试转换 · 免费" }));
    expect(generate).toHaveBeenCalledWith(
      "p",
      "gif",
      "gif",
      "/a.png",
      "/v.mp4",
      "c",
      expect.any(Function),
    );
  });
  it("shows stage without allowing duplicate generation while busy", () => {
    render(
      <DerivedMediaActions
        node={node({ isGenerating: true, generationStage: "正在转换 GIF" })}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("正在转换 GIF");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
