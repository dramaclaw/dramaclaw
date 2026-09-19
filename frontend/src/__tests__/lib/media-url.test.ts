// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, it, expect } from "vitest";
import {
  resolveMediaUrl,
  withMediaVariant,
  withRemoteImageVariant,
} from "@/lib/media-url";

describe("resolveMediaUrl", () => {
  it("returns null for null input", () => {
    expect(resolveMediaUrl(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(resolveMediaUrl(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(resolveMediaUrl("")).toBeNull();
  });

  it("routes project /static/ media through the protected project static URL", () => {
    window.history.pushState(null, "", "/");
    expect(resolveMediaUrl("/static/admin/proj/sketches/img.png?v=123")).toBe(
      "/static/projects/proj/sketches/img.png?v=123",
    );
  });

  it("preserves canonical protected project static URLs", () => {
    expect(resolveMediaUrl("/static/projects/proj/sketches/img.png?v=123")).toBe(
      "/static/projects/proj/sketches/img.png?v=123",
    );
  });

  it("uses the current route project id instead of the legacy static project path", () => {
    window.history.pushState(null, "", "/projects/01KS77361FXAQNKQF2W4EWWVCW/characters");
    expect(
      resolveMediaUrl(
        "/static/admin/xuanchuanpian/assets/characters/%E9%9D%A2%E9%A6%86%E7%94%B7%E9%9D%92%E5%B9%B4/portrait.png?v=123",
      ),
    ).toBe(
      "/static/projects/01KS77361FXAQNKQF2W4EWWVCW/assets/characters/%E9%9D%A2%E9%A6%86%E7%94%B7%E9%9D%92%E5%B9%B4/portrait.png?v=123",
    );
  });

  it("uses the freezone query project id instead of the legacy static project path", () => {
    window.history.pushState(null, "", "/freezone/?p=01KS77361FXAQNKQF2W4EWWVCW");
    expect(
      resolveMediaUrl(
        "/static/admin/xuanchuanpian/assets/scenes/%E5%85%B0%E5%B7%9E%E6%8B%89%E9%9D%A2%E9%A6%86/master.png?v=123",
      ),
    ).toBe(
      "/static/projects/01KS77361FXAQNKQF2W4EWWVCW/assets/scenes/%E5%85%B0%E5%B7%9E%E6%8B%89%E9%9D%A2%E9%A6%86/master.png?v=123",
    );
  });

  it("preserves non-project /static/ paths", () => {
    expect(resolveMediaUrl("/static/style-examples/demo.png")).toBe(
      "/static/style-examples/demo.png",
    );
  });

  it("preserves legacy project-only /static/ paths", () => {
    expect(resolveMediaUrl("/static/demo/assets/narrator/voice.wav")).toBe(
      "/static/demo/assets/narrator/voice.wav",
    );
  });

  it("canonicalizes project media API URLs to protected static URLs for the current project", () => {
    window.history.pushState(null, "", "/projects/01KS77361FXAQNKQF2W4EWWVCW/assets");
    expect(
      resolveMediaUrl(
        "/api/v1/projects/xuanchuanpian/media/assets/scenes/%E5%85%B0%E5%B7%9E%E6%8B%89%E9%9D%A2%E9%A6%86/reverse_master.png?v=123",
      ),
    ).toBe(
      "/static/projects/01KS77361FXAQNKQF2W4EWWVCW/assets/scenes/%E5%85%B0%E5%B7%9E%E6%8B%89%E9%9D%A2%E9%A6%86/reverse_master.png?v=123",
    );
  });

  it("canonicalizes same-origin absolute project media API URLs", () => {
    window.history.pushState(null, "", "/projects/01KS77361FXAQNKQF2W4EWWVCW/assets");
    expect(
      resolveMediaUrl(
        `${window.location.origin}/api/v1/projects/xuanchuanpian/media/assets/scenes/hall/reverse_master.png?v=123`,
      ),
    ).toBe(
      "/static/projects/01KS77361FXAQNKQF2W4EWWVCW/assets/scenes/hall/reverse_master.png?v=123",
    );
  });

  it("passes through absolute /api/ paths", () => {
    expect(resolveMediaUrl("/api/v1/projects/x/y")).toBe(
      "/api/v1/projects/x/y",
    );
  });

  it("rejects javascript: URLs", () => {
    expect(resolveMediaUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects data: URLs", () => {
    expect(resolveMediaUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("rejects vbscript: URLs", () => {
    expect(resolveMediaUrl("vbscript:msgbox(1)")).toBeNull();
  });

  it("rejects protocol-relative URLs", () => {
    expect(resolveMediaUrl("//evil.example.com/x.png")).toBeNull();
  });

  it("rejects cross-origin absolute URLs", () => {
    expect(resolveMediaUrl("http://example.com/img.png")).toBeNull();
    expect(resolveMediaUrl("https://evil.example.com/img.png")).toBeNull();
  });
});

describe("resolveMediaUrl variants", () => {
  it("asks the backend for a downscaled copy of a project image", () => {
    window.history.pushState(null, "", "/");
    expect(
      resolveMediaUrl("/static/projects/proj/freezone/_outputs/a.png", {
        variant: "thumb",
      }),
    ).toBe("/static/projects/proj/freezone/_outputs/a.png?st_thumb=thumb");
  });

  it("keeps an existing cache-bust token alongside the variant", () => {
    expect(
      resolveMediaUrl("/static/projects/proj/images/a.png?st_v=17", {
        variant: "thumb",
      }),
    ).toBe("/static/projects/proj/images/a.png?st_v=17&st_thumb=thumb");
  });

  it("applies the variant after legacy paths are canonicalized", () => {
    window.history.pushState(null, "", "/projects/01KS77361FXAQNKQF2W4EWWVCW/freezone");
    expect(
      resolveMediaUrl("/static/admin/demo/images/a.jpg", { variant: "thumb" }),
    ).toBe(
      "/static/projects/01KS77361FXAQNKQF2W4EWWVCW/images/a.jpg?st_thumb=thumb",
    );
  });

  it("leaves non-image media untouched", () => {
    for (const path of [
      "/static/projects/proj/videos/clip.mp4",
      "/static/projects/proj/audio/voice.wav",
      "/static/projects/proj/renders/world.sog",
    ]) {
      expect(resolveMediaUrl(path, { variant: "thumb" })).toBe(path);
    }
  });

  it("leaves paths outside the protected project route untouched", () => {
    expect(
      resolveMediaUrl("/static/style-examples/demo.png", { variant: "thumb" }),
    ).toBe("/static/style-examples/demo.png");
  });

  it("still rejects unsafe input when a variant is requested", () => {
    expect(resolveMediaUrl("javascript:alert(1)", { variant: "thumb" })).toBeNull();
    expect(resolveMediaUrl("//evil.example.com/x.png", { variant: "thumb" })).toBeNull();
    expect(resolveMediaUrl(null, { variant: "thumb" })).toBeNull();
  });

  it("is a no-op when no variant is passed", () => {
    const path = "/static/projects/proj/images/a.png?v=123#frag";
    expect(resolveMediaUrl(path, {})).toBe(resolveMediaUrl(path));
    expect(resolveMediaUrl(path, undefined)).toBe(resolveMediaUrl(path));
  });

});

// Canvas nodes resolve their URL through resolveImageDisplayUrl +
// withImageCacheBust, so they need the variant step on its own.
describe("withMediaVariant", () => {
  it("appends the variant to a protected project image", () => {
    expect(withMediaVariant("/static/projects/proj/images/a.png", "thumb")).toBe(
      "/static/projects/proj/images/a.png?st_thumb=thumb",
    );
  });

  it("keeps query and fragment around the variant", () => {
    expect(
      withMediaVariant("/static/projects/proj/images/a.png?v=9#frag", "thumb"),
    ).toBe("/static/projects/proj/images/a.png?v=9&st_thumb=thumb#frag");
  });

  // split(sep, 2) truncates instead of splitting once, so a second separator
  // silently disappears from the URL the backend receives.
  it("keeps everything after the first separator", () => {
    expect(withMediaVariant("/static/projects/p/a.png#x#y", "thumb")).toBe(
      "/static/projects/p/a.png?st_thumb=thumb#x#y",
    );
    expect(withMediaVariant("/static/projects/p/a.png?v=1?z=2", "thumb")).toBe(
      "/static/projects/p/a.png?v=1%3Fz%3D2&st_thumb=thumb",
    );
  });

  it("replaces a variant rather than stacking a second one", () => {
    expect(
      withMediaVariant("/static/projects/proj/images/a.png?st_thumb=card", "thumb"),
    ).toBe("/static/projects/proj/images/a.png?st_thumb=thumb");
  });

  // Identity is how callers detect "no downscaled copy was actually requested".
  it("returns the input untouched wherever the variant cannot apply", () => {
    for (const url of [
      "blob:http://localhost/abcd",
      "data:image/png;base64,AAAA",
      "/static/style-examples/demo.png",
      "/static/admin/proj/images/a.png",
      "/static/projects/proj/videos/clip.mp4",
      "/static/projects/proj/audio/voice.wav",
    ]) {
      expect(withMediaVariant(url, "thumb")).toBe(url);
    }
  });
});

describe("withRemoteImageVariant", () => {
  const CDN = "https://libtv-res.liblib.art/sd-gen/a/898013514_28d8.png";

  it("无 query 的远端图片地址挂上服务端缩放", () => {
    const out = withRemoteImageVariant(CDN, 1280);
    const process = decodeURIComponent(new URL(out).searchParams.get("x-oss-process")!);
    expect(process).toBe("image/resize,w_1280,m_lfit/format,webp/ignore-error,1");
  });

  it("已有 image/resize 的地址换掉宽度，而不是再挂一个", () => {
    const out = withRemoteImageVariant(`${CDN}?x-oss-process=image%2Fresize%2Cw_320`, 640);
    const params = new URL(out).searchParams;
    expect([...params.keys()]).toEqual(["x-oss-process"]);
    expect(params.get("x-oss-process")).toContain("w_640");
  });

  // 预签名地址的签名覆盖 query，多加一个参数会让签名失效、图直接裂掉。
  // 预签名地址必然带 query，所以「有 query 就不动」正好把它们排除干净。
  it("带其它查询参数的地址一律不碰", () => {
    const signed = `${CDN}?Expires=123&Signature=abc`;
    expect(withRemoteImageVariant(signed, 1280)).toBe(signed);
  });

  it("视频抽帧参数不会被图片缩放覆盖掉", () => {
    const snap = `${CDN}?x-oss-process=video%2Fsnapshot%2Ct_0%2Cf_jpg%2Cw_200`;
    expect(withRemoteImageVariant(snap, 1280)).toBe(snap);
  });

  it("本地路径与非图片后缀原样返回", () => {
    expect(withRemoteImageVariant("/static/projects/p/a.png", 640)).toBe("/static/projects/p/a.png");
    expect(withRemoteImageVariant("https://cdn.example/clip.mp4", 640)).toBe("https://cdn.example/clip.mp4");
  });
});
