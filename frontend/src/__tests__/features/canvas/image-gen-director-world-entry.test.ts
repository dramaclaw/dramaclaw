// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("ImageGenNode director combined world entry", () => {
  it("passes a combined capture handler so preset director assets can export bundles", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/canvas/nodes/ImageGenNode.tsx"),
      "utf8",
    );

    expect(source).toContain("handleDirectorCaptureCombined");
    expect(source).toContain("onSubmitDirectorCombined={handleDirectorCaptureCombined}");
    expect(source).not.toContain("onCaptureCanvasNode={handleDirectorCaptureCombined}");
    expect(source).toContain("controlFrameBundle");
  });

  it("does not expose selected-background capture from the director-combined entry", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/canvas/nodes/ImageGenNode.tsx"),
      "utf8",
    );

    expect(source).not.toContain("onCaptureSelectedBackground={handleDirectorCaptureSelectedBackground}");
  });

  it("lets dragged director bundle upload nodes open Director World", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/canvas/nodes/UploadNode.tsx"),
      "utf8",
    );

    expect(source).toContain("getBeatDirectorStageManifest");
    expect(source).toContain("sourceRole === \"director_combined\"");
    expect(source).toContain("onSubmitDirectorCombined={handleDirectorCaptureCombined}");
    expect(source).toContain("onCaptureCanvasNode={handleDirectorOutputCanvasNode}");
    expect(source).not.toContain("autoCommitDirectorCombined");
    expect(source).toContain("meta.captureBundle");
    // 文案已搬进词条，源码里只剩 key；措辞本身对着 locale 查（见下一个用例）。
    expect(source).toContain("label: t('node.threeDWorld.combinedLabel')");
    expect(source).toContain("label: t('node.threeDWorld.envOnlyLabel')");
    expect(source).toContain("addPanoCaptureGroup");
    expect(source).toContain("kind: 'director_render'");
    expect(source).not.toContain("freezone/assets-updated");
  });

  it("exports both combined and env_only from normal Director World canvas output", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/canvas/nodes/ThreeDWorldNode.tsx"),
      "utf8",
    );

    expect(source).toContain("meta.captureBundle");
    // 文案已搬进词条，源码里只剩 key；措辞本身对着 locale 查。
    expect(source).toContain("label: t('node.threeDWorld.combinedLabel')");
    expect(source).toContain("label: t('node.threeDWorld.envOnlyLabel')");
    const zh = JSON.parse(
      readFileSync(resolve(process.cwd(), "public/locales/zh/translation.json"), "utf8"),
    );
    expect(zh.node.threeDWorld.combinedLabel).toBe("导演合成图");
    expect(zh.node.threeDWorld.envOnlyLabel).toBe("纯背景图");
    expect(source).toContain("director_control_bundle");
  });

  it("guards Director World canvas output against duplicate in-flight group creation", () => {
    const threeDWorldSource = readFileSync(
      resolve(process.cwd(), "src/features/canvas/nodes/ThreeDWorldNode.tsx"),
      "utf8",
    );
    const uploadSource = readFileSync(
      resolve(process.cwd(), "src/features/canvas/nodes/UploadNode.tsx"),
      "utf8",
    );

    expect(threeDWorldSource).toContain("captureCanvasNodeBusyRef");
    expect(uploadSource).toContain("captureCanvasNodeBusyRef");
  });

  it("restores the bundle source when opening Director World from a dragged upload node", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/canvas/nodes/UploadNode.tsx"),
      "utf8",
    );

    expect(source).toContain("directorControlBundleSourceId");
    expect(source).toContain("active_source_id: directorControlBundleSourceId");
    expect(source).toContain("sceneSnapshotFromDirectorControlBundle");
    expect(source).toContain("initialScene={directorInitialScene}");
  });

  it("only writes beat bundles directly in mainline commit mode", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/viewer-kit/three-d/ThreeDDirectorDialog.tsx"),
      "utf8",
    );

    expect(source).toContain("autoCommitDirectorCombined &&");
    expect(source).toContain("DIRECTOR_CONTROL_FRAME_MAX_LONG_EDGE");
  });
});
