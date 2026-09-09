import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const modal = readFileSync("src/components/login/login-modal.tsx", "utf8");
const media = readFileSync("src/components/login/cinematic/media.ts", "utf8");
const stage = readFileSync("src/components/login/login-stage.tsx", "utf8");
const css = readFileSync("src/components/login/login.module.css", "utf8");

describe("login modal layout contract", () => {
  it("loops the dedicated CDN showcase video beside the account form", () => {
    expect(modal).toContain("loginModalShowcaseVideo");
    expect(modal).toContain("loop");
    expect(media).toContain('cdn("login/login20260826-174426.mp4")');
    expect(modal).not.toContain("/video/login-community-preview.mp4");
    expect(modal).toContain("<LoginCard />");
    expect(css).toMatch(/\.loginDialog\s*\{[\s\S]*?grid-template-columns:/);
  });

  it("keeps the media free of playback and decorative top bars", () => {
    expect(modal).not.toContain("showcaseProgress");
    expect(modal).not.toContain("loginMediaProgress");
    expect(modal).not.toContain("loginMediaTopline");
    expect(css).not.toContain(".loginMediaTopline");
  });

  it("does not retain the obsolete multi-video carousel state machine", () => {
    expect(modal).not.toContain("visibleShowcases");
    expect(modal).not.toContain("showNextShowcase");
    expect(modal).not.toContain("SHOWCASE_CROSSFADE");
    expect(css).not.toContain("loginMediaCrossfade");
  });

  it("keeps the brand above the title with optical left alignment", () => {
    expect(modal).toMatch(/loginPanelHeader[\s\S]*?loginPanelBrand[\s\S]*?loginPanelTitle/);
    expect(css).toMatch(/\.loginPanelBrand\s*\{[\s\S]*?margin:\s*0 0 22px -5px/);
  });

  it("presents the video as a compact borderless rounded media card", () => {
    expect(css).toMatch(/\.loginMedia\s*\{[\s\S]*?margin:\s*10px 0 10px 10px/);
    expect(css).toMatch(/\.loginMedia\s*\{[\s\S]*?aspect-ratio:\s*1 \/ 1/);
    expect(css).toMatch(/\.loginMedia\s*\{[\s\S]*?border:\s*0/);
    expect(css).toMatch(/\.loginMedia\s*\{[\s\S]*?border-radius:\s*16px/);
  });

  it("uses one shared translucent blurred mask without nested dialog blur", () => {
    expect(css).toMatch(
      /\.loginOverlay\s*\{[\s\S]*?background:\s*rgba\(3, 4, 10, 0\.5\);[\s\S]*?backdrop-filter:\s*blur\(20px\) saturate\(112%\)/,
    );
    const dialogRule = css.match(/\.loginDialog\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(dialogRule).toContain("background: rgba(12, 13, 18, 0.72)");
    expect(dialogRule).not.toContain("backdrop-filter");
    expect(css).toMatch(/\.loginPanel\s*\{[\s\S]*?background:\s*transparent/);
  });

  it("explains that OTP login creates an account without a separate application", () => {
    expect(modal).toContain('t("auth.modal.otpRegistration")');
    expect(modal).toContain("phoneOtpEntryVisible()");
    expect(modal).toMatch(/otpEntryVisible\s*\?\s*\([\s\S]*?loginApplyRow/);
    expect(modal).not.toContain("businessWechatQrUrl");
    expect(modal).not.toContain('role="tooltip"');
  });

  it("removes the media panel on narrow mobile screens", () => {
    expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.loginMedia\s*\{\s*display: none;/);
  });

  it("reserves a stable GitHub star value slot before the API responds", () => {
    expect(stage).toContain('stars === null ? "—" : formatStars(stars)');
    expect(css).toMatch(/\.githubStars\s*\{[\s\S]*?flex:\s*0 0 4ch/);
    expect(css).toMatch(/\.githubStars\s*\{[\s\S]*?font-variant-numeric:\s*tabular-nums/);
    expect(css).toMatch(/\.githubStars\s*\{[\s\S]*?text-align:\s*right/);
  });
});
