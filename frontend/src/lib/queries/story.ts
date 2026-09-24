// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getStoryDoc, putStoryDoc, type StoryDoc } from "@/api/story";

const storyDocKey = (project: string, docId: string) =>
  ["projects", project, "story", "docs", docId] as const;

export function useStoryDoc<T = unknown>(project: string, docId: string | null) {
  return useQuery({
    queryKey: storyDocKey(project, docId ?? "-"),
    queryFn: () => getStoryDoc<T>(project, docId as string),
    enabled: Boolean(project && docId),
    // 创作稿是低频写入的长文本，没必要跟着窗口焦点反复重取。
    staleTime: 30_000,
  });
}

export function useSaveStoryDoc<T = unknown>(project: string, docId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ content, baseRevision }: { content: T; baseRevision?: number }) =>
      putStoryDoc<T>(project, docId as string, content, baseRevision),
    onSuccess: (saved: StoryDoc<T>) => {
      // 直接把返回的最新版本写进缓存，省掉一次往返，也保证 revision 立刻是新的——
      // 下一次保存要拿它做乐观并发校验。
      queryClient.setQueryData(storyDocKey(project, docId ?? "-"), saved);
    },
  });
}
