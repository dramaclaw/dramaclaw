import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/features/freezone/FreezoneShell.tsx", "utf8");

describe("freezone xia-dao launcher contract", () => {
  it("uses one video source for both the idle first frame and hover motion", () => {
    expect(source).toContain('src="/images/xia-dao-launcher.mp4"');
    expect(source).not.toContain("xia-dao-launcher-poster.png");
    expect(source).not.toContain('src="/images/avatar-claw.png"');
    expect(source).not.toContain('src="/images/avatar-motion.mp4"');
    expect(source).toContain("const CHAT_LAUNCHER_VISUAL_WIDTH = 96");
    expect(source).toContain("const CHAT_LAUNCHER_VISUAL_HEIGHT = 35");
    expect(source).toContain("const CHAT_LAUNCHER_HIT_HEIGHT = 44");
    expect(source).toContain("brightness-[1.08]");
    expect(source).toContain("group-hover/xia-dao:brightness-[1.16]");
  });

  it("plays from frame zero on hover or focus and resets on exit", () => {
    expect(source).toContain("video.currentTime = 0");
    expect(source).toContain("void video.play().catch(() => undefined)");
    expect(source).toContain("video.pause()");
    expect(source).toContain("onMouseEnter={playMotion}");
    expect(source).toContain("onMouseLeave={stopMotion}");
    expect(source).toContain("onFocus={playMotion}");
    expect(source).toContain("onBlur={stopMotion}");
  });

  it("keeps the existing click and drag interactions", () => {
    expect(source).toContain("onPointerDown={handlePointerDown}");
    expect(source).toContain("onClick={handleClick}");
    expect(source).toContain("onClick();");
  });
});
