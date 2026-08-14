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

/**
 * 从 electron-updater 清单文本里挑出目标平台的安装包文件名。
 *
 * 取到行尾再 trim,不用 `\S+`:electron-builder 的 NSIS 默认 artifactName 会
 * 产出带空格的文件名(`DramaClaw Setup 1.3.2.exe`),YAML 里就是不加引号的
 * 裸标量,`\S+` 会在第一个空格处截断,拼出必然 404 的直链。带引号的形式
 * (值里含 `:`、`#` 等特殊字符时 js-yaml 会加引号)顺手剥掉。
 */
export function pickInstallerFromManifest(
  manifest: string,
  platform: DesktopPlatform,
): string | null {
  const ext = INSTALLER_EXT[platform];
  for (const match of manifest.matchAll(/^\s*-?\s*url:\s*(.+)$/gm)) {
    const file = match[1].trim().replace(/^(['"])(.*)\1$/, "$2");
    if (file.endsWith(ext)) return file;
  }
  return null;
}

/**
 * 文件名转成 URL 里的一个路径段。
 *
 * 清单里的 url 有时已经是编码过的(空格写成 %20),直接再 encode 会变成
 * %2520 —— 链接照样 404。所以先 decode 一次再统一编码,两种写法都归一。
 * encodeURIComponent 本身是安全边界,别去掉:它把文件名钉死成路径末节,
 * `../` 穿越和 `//evil.com` 这类开放重定向都拼不出来。
 */
function encodeInstallerPath(file: string): string {
  let decoded = file;
  try {
    decoded = decodeURIComponent(file);
  } catch {
    // 非法转义序列(比如文件名里有裸 %),按原样编码即可。
  }
  return encodeURIComponent(decoded);
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
    if (!res.ok) {
      warnUnresolved(platform, `manifest responded ${res.status}`);
      return fallback;
    }
    const manifest = await res.text();
    const file = pickInstallerFromManifest(manifest, platform);
    if (!file) warnUnresolved(platform, "no installer url in manifest");
    return {
      url: file ? DOWNLOAD_BASE + encodeInstallerPath(file) : FALLBACK_DOWNLOAD_URL,
      ...parseManifestRelease(manifest),
    };
  } catch (err) {
    // CSP 拦截、CORS、断网在页面上是同一副样子(都退成 GitHub 兜底按钮),
    // 不留一行日志就没法区分"CDN 挂了"和"nginx 少放行一个域名"。
    warnUnresolved(platform, err);
    return fallback;
  }
}

function warnUnresolved(platform: DesktopPlatform, cause: unknown): void {
  console.warn(
    `[desktop-download] ${platform} 版本指针解析失败,退到 GitHub Releases 兜底。` +
      ` 若为网络错误,先查 CSP connect-src 是否放行 ${DOWNLOAD_BASE}`,
    cause,
  );
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
