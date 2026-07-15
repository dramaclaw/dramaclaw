// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  detectDesktopPlatform,
  pickInstallerFromManifest,
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
