import { describe, expect, it } from "vitest";
import { canvasApprovalAppliesWithoutClick } from "@/features/superchat/canvas-command-display";

describe("canvasApprovalAppliesWithoutClick", () => {
  it("applies a server-admitted frame in manual mode", () => {
    expect(canvasApprovalAppliesWithoutClick("manual_confirm", true)).toBe(true);
  });
  it("keeps local confirmation in manual mode without server approval", () => {
    expect(canvasApprovalAppliesWithoutClick("manual_confirm", false)).toBe(false);
    expect(canvasApprovalAppliesWithoutClick("manual_confirm", undefined)).toBe(false);
  });
  it("preserves automatic mode", () => {
    expect(canvasApprovalAppliesWithoutClick("auto_execute", false)).toBe(true);
  });
});
