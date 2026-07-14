// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Desktop installer downloads offered on the login hero.
 *
 * TODO(wx): 换成真实的安装包地址（OSS / GitHub Releases 均可）。在此之前按钮
 * 指向占位地址，先把版式和样式定下来。
 */
export type DesktopPlatform = "mac" | "windows";

export const DESKTOP_DOWNLOAD_URL: Record<DesktopPlatform, string> = {
  mac: "#download-mac-placeholder",
  windows: "#download-windows-placeholder",
};

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
