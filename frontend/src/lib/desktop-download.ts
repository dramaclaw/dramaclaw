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
  /**
   * 这一个安装包自己的 sha512(base64,electron-builder 的原样格式),
   * 供用户下载后核验完整性。清单缺字段时为 null。
   */
  sha512: string | null;
};

/** 清单 `files:` 列表里的一条:安装包文件名 + 它自己的校验和。 */
export type ManifestInstaller = {
  file: string;
  sha512: string | null;
};

/** 去掉 YAML 标量两侧的引号(值含 `:`、`#` 等特殊字符时 js-yaml 会加)。 */
function unquote(value: string): string {
  return value.trim().replace(/^(['"])(.*)\1$/, "$2");
}

/**
 * 从 electron-updater 清单文本里挑出目标平台的安装包 —— 文件名与校验和。
 *
 * 逐行扫而不是一把正则,因为 sha512 必须**跟着它所属的那条 files: 条目**走:
 * 清单末尾还有一份顶层 sha512,对应的是顶层 path:(mac 上那是自动更新用的
 * zip),挂到 dmg 上会让用户按错的值去核验,比不显示更糟。
 *
 * 文件名取到行尾再 trim,不用 `\S+`:electron-builder 的 NSIS 默认
 * artifactName 会产出带空格的文件名(`DramaClaw Setup 1.3.2.exe`),YAML 里
 * 就是不加引号的裸标量,`\S+` 会在第一个空格处截断,拼出必然 404 的直链。
 */
export function pickInstallerFromManifest(
  manifest: string,
  platform: DesktopPlatform,
): ManifestInstaller | null {
  const ext = INSTALLER_EXT[platform];
  let open: ManifestInstaller | null = null;

  for (const line of manifest.split("\n")) {
    // 零缩进且非列表项的行(version:/path:/releaseDate:)结束当前条目。
    if (/^\S/.test(line)) {
      if (open?.file.endsWith(ext)) return open;
      open = null;
      continue;
    }
    const url = line.match(/^\s*-?\s*url:\s*(.+)$/);
    if (url) {
      if (open?.file.endsWith(ext)) return open;
      open = { file: unquote(url[1]), sha512: null };
      continue;
    }
    const sha = line.match(/^\s*sha512:\s*(.+)$/);
    if (sha && open) open.sha512 = unquote(sha[1]);
  }
  return open?.file.endsWith(ext) ? open : null;
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
    sha512: null,
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
    const installer = pickInstallerFromManifest(manifest, platform);
    if (!installer) warnUnresolved(platform, "no installer url in manifest");
    return {
      url: installer
        ? DOWNLOAD_BASE + encodeInstallerPath(installer.file)
        : FALLBACK_DOWNLOAD_URL,
      sha512: installer?.sha512 ?? null,
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
