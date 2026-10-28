import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/features/freezone/FreezoneShell.tsx", "utf8");

describe("freezone xia-dao launcher contract", () => {
  it("keeps the existing click and drag interactions", () => {
    expect(source).toContain("onPointerDown={handlePointerDown}");
    expect(source).toContain("onClick={handleClick}");
    expect(source).toContain("onClick();");
  });
});
