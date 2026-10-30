// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { cn } from "@/lib/utils";

/**
 * 快捷键小键帽：一个字母的圆角小块，贴在按钮角上或跟在文字后面。
 * 只是给眼睛看的：读屏靠按钮上的 aria-keyshortcuts 读键位，这里再念一遍字母只会把
 * 「选择」听成「选择 W」，所以整块 aria-hidden。
 */
export function PrevizKeyCap({ children, className }: { children: string; className?: string }) {
  return (
    <kbd
      aria-hidden
      className={cn(
        "pointer-events-none inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full border border-white/20 bg-black/80 px-1 font-sans text-[9px] font-medium leading-none text-white/75",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
