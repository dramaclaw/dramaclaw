// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("VideoNode error notification contract", () => {
  it("uses preserved diagnostics for policy detection and dialog copy", () => {
    const source = read("src/features/canvas/nodes/VideoNode.tsx");

    expect(source).toContain(
      'const haystack = `${displayErrorMessage}\\n${diagnostics.details ?? ""}`',
    );
    expect(source).toContain("diagnostics.details ?? undefined");
    expect(source).not.toContain(
      'const haystack = `${displayErrorMessage}\\n${resolved.details ?? ""}`',
    );
  });
});
