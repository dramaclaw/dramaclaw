// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useState } from "react";
import {
  FALLBACK_DOWNLOAD_URL,
  resolveDesktopRelease,
  type DesktopPlatform,
  type DesktopRelease,
} from "@/lib/desktop-download";

type Releases = Record<DesktopPlatform, DesktopRelease>;

let cached: Releases | null = null;

/** 解析完成前的占位:按钮指向 GitHub Releases,版本字段留空由调用方决定怎么显示。 */
function pending(): Releases {
  const blank: DesktopRelease = {
    url: FALLBACK_DOWNLOAD_URL,
    resolved: false,
    version: null,
    releaseDate: null,
    sha512: null,
  };
  return { mac: { ...blank }, windows: { ...blank } };
}

/**
 * 挂载后解析 CDN 上的版本指针(latest*.yml),拿到当前安装包直链与版本号。
 * 模块级缓存与 useGithubStars 同款:同一次会话只解析一遍——登录页头部与
 * 下载页共用这一份缓存,两处都出现时不会重复打 CDN。
 */
export function useDesktopRelease(): Releases {
  const [releases, setReleases] = useState<Releases>(cached ?? pending());

  useEffect(() => {
    if (cached !== null) return;
    let active = true;
    Promise.all(
      (["mac", "windows"] as const).map(
        async (os) => [os, await resolveDesktopRelease(os)] as const,
      ),
    ).then((entries) => {
      const next = pending();
      for (const [os, release] of entries) next[os] = release;
      // 只缓存解析成功的结果。失败也写缓存的话,一次瞬时抖动(CDN 504、
      // 切网)就把整个会话钉死在 GitHub 兜底上,再怎么跳页都恢复不了;
      // 不写则下一次挂载会重试一遍。
      //
      // 判据是 resolved 而不是 version:清单有版本号、却没解出安装包时
      // version 非空但 url 已经是兜底,按 version 判会把这种半成功缓存下来。
      if (Object.values(next).every((r) => r.resolved)) cached = next;
      if (active) setReleases(next);
    });
    return () => {
      active = false;
    };
  }, []);

  return releases;
}
