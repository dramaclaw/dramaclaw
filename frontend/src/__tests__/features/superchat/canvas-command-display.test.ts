import { describe, expect, it } from "vitest";
import {
  canvasApprovalAppliesWithoutClick,
  canvasApprovalIsExpired,
} from "@/features/superchat/canvas-command-display";

describe("canvasApprovalIsExpired", () => {
  it.each([
    [undefined, 5, false],
    [6, 5, false],
    [5, 5, true],
    [4, 5, true],
  ])("returns %s at %s as expired: %s", (expiresAt, nowMs, expected) => {
    expect(canvasApprovalIsExpired(expiresAt, nowMs)).toBe(expected);
  });
});

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
