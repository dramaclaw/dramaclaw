// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Desktop installer downloads offered on the login hero.
 *
 * 安装包文件名带版本号(如 DramaClaw-Setup-1.1.0.exe),写死必随发版腐烂。
 * 发布流水线维护着一对"当前版本指针"—— electron-updater 的 latest.yml /
 * latest-mac.yml(CDN 对 *.yml 零缓存,即发即新)。这里按需解析指针拿到
 * 当前安装包的真实文件名;文件名从清单的 url: 字段取,绝不自拼版本号,
 * 将来命名模式变化时本文件无需跟改。
 */
export type DesktopPlatform = "mac" | "windows";

const DOWNLOAD_BASE = "https://dramaclaw-dl.cdnfg.com/desktop/";

const MANIFEST: Record<DesktopPlatform, string> = {
  mac: "latest-mac.yml",
  windows: "latest.yml",
};

// latest-mac.yml 同时列出 zip(自动更新的载体)与 dmg(首次安装的载体),
// 官网必须发 dmg;Windows 清单里只有 exe。
const INSTALLER_EXT: Record<DesktopPlatform, string> = {
  mac: ".dmg",
  windows: ".exe",
};

/**
 * 指针解析失败(断网、CDN 故障、清单格式漂移)时的兜底:GitHub Releases
 * 页含全部平台资产,慢但可达,按钮永远不会点了没反应。
 */
export const FALLBACK_DOWNLOAD_URL =
  "https://github.com/dramaclaw/dramaclaw/releases/latest";

/** 一个平台的当前发布:安装包直链 + 清单里自报的版本与发布日期。 */
export type DesktopRelease = {
  /** 安装包直链;解析失败时退到 GitHub Releases 兜底页,按钮永远可点。 */
  url: string;
  /** 清单里的版本号(如 "1.3.2");字段缺失或格式漂移时为 null。 */
  version: string | null;
  /** 清单里的发布日期,截到 YYYY-MM-DD;解析不出时为 null。 */
  releaseDate: string | null;
};

/** 从 electron-updater 清单文本里挑出目标平台的安装包文件名。 */
export function pickInstallerFromManifest(
  manifest: string,
  platform: DesktopPlatform,
): string | null {
  const ext = INSTALLER_EXT[platform];
  for (const match of manifest.matchAll(/url:\s*(\S+)/g)) {
    if (match[1].endsWith(ext)) return match[1];
  }
  return null;
}

/**
 * 从清单里读版本号与发布日期。下载页拿它当"当前版本"的唯一事实来源 ——
 * 写死在文案里的版本号必随发版腐烂,而这份清单就是发布流水线自己写的。
 */
export function parseManifestRelease(manifest: string): {
  version: string | null;
  releaseDate: string | null;
} {
  return {
    version: manifest.match(/^version:\s*(\S+)/m)?.[1] ?? null,
    releaseDate:
      manifest.match(/^releaseDate:\s*'?(\d{4}-\d{2}-\d{2})/m)?.[1] ?? null,
  };
}

/** 解析当前发布;任何一步失败都退到兜底(url 保底可点,版本字段留空)。 */
export async function resolveDesktopRelease(
  platform: DesktopPlatform,
): Promise<DesktopRelease> {
  const fallback: DesktopRelease = {
    url: FALLBACK_DOWNLOAD_URL,
    version: null,
    releaseDate: null,
  };
  try {
    const res = await fetch(DOWNLOAD_BASE + MANIFEST[platform], {
      cache: "no-store",
    });
    if (!res.ok) return fallback;
    const manifest = await res.text();
    const file = pickInstallerFromManifest(manifest, platform);
    return {
      url: file ? DOWNLOAD_BASE + encodeURIComponent(file) : FALLBACK_DOWNLOAD_URL,
      ...parseManifestRelease(manifest),
    };
  } catch {
    return fallback;
  }
}

/**
 * Which installer to feature as the filled primary button. Falls back to macOS
 * on anything we can't identify (Linux, phones, bots) so the row never renders
 * empty — the other platform stays one click away as the adjacent text link.
 */
export function detectDesktopPlatform(
  userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): DesktopPlatform {
  return /windows|win32|win64/i.test(userAgent) ? "windows" : "mac";
}
