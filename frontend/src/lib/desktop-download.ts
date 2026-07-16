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

/** 解析当前版本安装包的 CDN 直链;任何一步失败都返回 null(调用方走兜底)。 */
export async function resolveDesktopDownloadUrl(
  platform: DesktopPlatform,
): Promise<string | null> {
  try {
    const res = await fetch(DOWNLOAD_BASE + MANIFEST[platform], {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const file = pickInstallerFromManifest(await res.text(), platform);
    return file ? DOWNLOAD_BASE + encodeURIComponent(file) : null;
  } catch {
    return null;
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
