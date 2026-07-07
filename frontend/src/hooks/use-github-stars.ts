// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useState } from "react";

// GitHub 匿名 API 限速 60 次/小时/IP，登录页在共享出口 IP 下极易被限流（403）。
// 把上次成功拿到的 star 数落地 localStorage：请求失败/限速时用本地值兜底，
// 成功时刷新显示并写回本地，徽标不再因为一次 403 就消失。
const STARS_STORAGE_KEY = "dramaclaw.login.githubStars";

function readStoredStars(): number | null {
  try {
    const raw = window.localStorage.getItem(STARS_STORAGE_KEY);
    if (!raw) return null;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    // localStorage 在隐私模式/受限环境可能不可用。
    return null;
  }
}

function writeStoredStars(count: number): void {
  try {
    window.localStorage.setItem(STARS_STORAGE_KEY, String(count));
  } catch {
    // 写入失败无所谓，star 数仅为锦上添花。
  }
}

/**
 * 拉取目标仓库的 star 数，值持久化到 localStorage。
 * - 首帧同步返回上次成功落地的值（没有则为 null）。
 * - 请求成功：更新显示并写回 localStorage。
 * - 请求失败/限速：静默保留上次落地的值，不隐藏徽标。
 */
export function useGithubStars(repo: string): number | null {
  const [stars, setStars] = useState<number | null>(() => readStoredStars());

  useEffect(() => {
    let active = true;
    fetch(`https://api.github.com/repos/${repo}`, {
      headers: { Accept: "application/vnd.github+json" },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { stargazers_count?: number } | null) => {
        const count = data?.stargazers_count;
        if (typeof count !== "number") return;
        writeStoredStars(count);
        if (active) setStars(count);
      })
      .catch(() => {
        /* 静默失败：保留上次落地的 star 数 */
      });
    return () => {
      active = false;
    };
  }, [repo]);

  return stars;
}
