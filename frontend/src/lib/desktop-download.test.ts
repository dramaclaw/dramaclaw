// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  detectDesktopPlatform,
  FALLBACK_DOWNLOAD_URL,
  parseManifestRelease,
  pickInstallerFromManifest,
  resolveDesktopRelease,
} from "./desktop-download";

// 与发布流水线产出的 electron-updater 清单同形状(url 字段带版本号文件名)。
const WINDOWS_MANIFEST = `version: 1.1.0
files:
  - url: DramaClaw-Setup-1.1.0.exe
    sha512: occFiM5M3gMp2RqWdM+5Fjw==
    size: 883116200
path: DramaClaw-Setup-1.1.0.exe
sha512: occFiM5M3gMp2RqWdM+5Fjw==
releaseDate: '2026-07-15T08:45:34.419Z'
`;

// macOS 清单同时列 zip(自动更新载体)与 dmg(首装载体)。
const MAC_MANIFEST = `version: 1.1.0
files:
  - url: DramaClaw-1.1.0-arm64.zip
    sha512: Bw4uOHg/lIXnqAlOKsuZMw==
    size: 1003619976
  - url: DramaClaw-1.1.0-arm64.dmg
    sha512: 5xw1uPGkX0Yl3m2n4o5p6q==
    size: 969342976
path: DramaClaw-1.1.0-arm64.zip
sha512: Bw4uOHg/lIXnqAlOKsuZMw==
releaseDate: '2026-07-15T08:45:34.419Z'
`;

// 文件名带空格的形态(electron-builder NSIS 默认 artifactName)。
const SPACED_MANIFEST = `version: 1.1.0
files:
  - url: DramaClaw Setup 1.1.0.exe
    sha512: occFiM5M3gMp2RqWdM+5Fjw==
    size: 883116200
path: DramaClaw Setup 1.1.0.exe
releaseDate: '2026-07-15T08:45:34.419Z'
`;

describe("pickInstallerFromManifest", () => {
  it("picks the .exe from the Windows manifest", () => {
    expect(pickInstallerFromManifest(WINDOWS_MANIFEST, "windows")).toBe(
      "DramaClaw-Setup-1.1.0.exe",
    );
  });

  it("picks the .dmg (not the auto-update .zip) from the mac manifest", () => {
    expect(pickInstallerFromManifest(MAC_MANIFEST, "mac")).toBe(
      "DramaClaw-1.1.0-arm64.dmg",
    );
  });

  it("returns null when the wanted installer type is absent", () => {
    expect(pickInstallerFromManifest(WINDOWS_MANIFEST, "mac")).toBeNull();
    expect(pickInstallerFromManifest("", "windows")).toBeNull();
  });

  // electron-builder 的 NSIS 默认 artifactName 带空格,YAML 里是裸标量。
  it("keeps spaces in the filename", () => {
    expect(
      pickInstallerFromManifest(SPACED_MANIFEST, "windows"),
    ).toBe("DramaClaw Setup 1.1.0.exe");
  });

  it("strips quoting when the manifest quotes the value", () => {
    expect(
      pickInstallerFromManifest("files:\n  - url: 'DramaClaw 1.0.dmg'\n", "mac"),
    ).toBe("DramaClaw 1.0.dmg");
  });
});

describe("parseManifestRelease", () => {
  it("reads version and release date off the manifest", () => {
    expect(parseManifestRelease(WINDOWS_MANIFEST)).toEqual({
      version: "1.1.0",
      releaseDate: "2026-07-15",
    });
  });

  // path: 那行也含版本号,但只有行首的 version: 才算数。
  it("ignores version-looking text on other lines", () => {
    expect(parseManifestRelease(MAC_MANIFEST).version).toBe("1.1.0");
  });

  it("returns nulls when the fields are missing", () => {
    expect(parseManifestRelease("")).toEqual({
      version: null,
      releaseDate: null,
    });
  });
});

describe("resolveDesktopRelease", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function stubManifest(body: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 })),
    );
  }

  it("percent-encodes a filename with spaces exactly once", async () => {
    stubManifest(SPACED_MANIFEST);
    const release = await resolveDesktopRelease("windows");
    expect(release.url).toBe(
      "https://dramaclaw-dl.cdnfg.com/desktop/DramaClaw%20Setup%201.1.0.exe",
    );
  });

  // 清单里已经是编码过的写法,再 encode 一次会变成 %2520。
  it("does not double-encode an already-encoded filename", async () => {
    stubManifest("files:\n  - url: DramaClaw%20Setup%201.1.0.exe\n");
    const release = await resolveDesktopRelease("windows");
    expect(release.url).toBe(
      "https://dramaclaw-dl.cdnfg.com/desktop/DramaClaw%20Setup%201.1.0.exe",
    );
  });

  it("falls back and warns when the fetch is blocked", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(resolveDesktopRelease("mac")).resolves.toEqual({
      url: FALLBACK_DOWNLOAD_URL,
      version: null,
      releaseDate: null,
    });
    expect(warn).toHaveBeenCalled();
  });
});

describe("detectDesktopPlatform", () => {
  it("classifies Windows user agents", () => {
    expect(
      detectDesktopPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"),
    ).toBe("windows");
  });

  it("falls back to mac for everything else", () => {
    expect(
      detectDesktopPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"),
    ).toBe("mac");
    expect(detectDesktopPlatform("")).toBe("mac");
  });
});
