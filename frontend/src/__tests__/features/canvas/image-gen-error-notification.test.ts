// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("ImageGenNode error notification contract", () => {
  it("stores the raw error separately from the displayed provider message", () => {
    const source = read("src/features/canvas/nodes/ImageGenNode.tsx");

    expect(source).toContain("generationError: displayErrorMessage");
    expect(source).toContain("generationErrorDetails: rawErrorMessage");
    expect(source).toContain("generationErrorRequestId: extractRequestId(rawErrorMessage)");
  });

  it("copies the preserved raw ImageGen error from the node toolbar", () => {
    const source = read("src/features/canvas/ui/NodeActionToolbar.tsx");

    expect(source).toContain("isExportImageNode(node) || isImageGenNode(node)");
    expect(source).toContain("return generationErrorDetails || generationError");
  });

  it("copies the complete error from the request-id row instead of only the id", () => {
    const source = read("src/features/canvas/nodes/ImageGenNode.tsx");

    expect(source).toContain(
      "const copyText = generationErrorDetails || generationError || generationErrorRequestId",
    );
    expect(source).toContain("navigator.clipboard.writeText(copyText)");
    expect(source).not.toContain("navigator.clipboard.writeText(generationErrorRequestId)");
  });
});
