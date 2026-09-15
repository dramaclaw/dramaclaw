import { render } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
beforeAll(() =>
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  ),
);
afterAll(() => vi.unstubAllGlobals());

vi.mock("@/stores/canvasStore", () => ({ useCanvasStore: () => ({}) }));
vi.mock("@/features/canvas/application/derivedMedia", () => ({
  generateDerivedMedia: vi.fn(),
}));
import { DerivedMediaNode } from "@/features/canvas/nodes/DerivedMediaNode";

describe("derived media edge endpoints", () => {
  it.each(["vectorSvgNode", "animatedGifNode"])(
    "%s exposes the handles used by saved canvas edges",
    (type) => {
      const props = {
        id: "output",
        type,
        data: {},
        selected: false,
      } as NodeProps;
      const { container } = render(
        <ReactFlowProvider>
          <DerivedMediaNode {...props} />
        </ReactFlowProvider>,
      );
      expect(
        container
          .querySelector(".react-flow__handle.target")
          ?.getAttribute("data-handleid"),
      ).toBe("target");
      expect(
        container
          .querySelector(".react-flow__handle.source")
          ?.getAttribute("data-handleid"),
      ).toBe("source");
      expect(container.textContent).not.toMatch(/下载|删除|重新生成/);
    },
  );
});
