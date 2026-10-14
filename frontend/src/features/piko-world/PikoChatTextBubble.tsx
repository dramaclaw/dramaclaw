// SPDX-License-Identifier: Elastic-2.0
import { cn } from "@/lib/utils";

export function PikoChatTextBubble({ body, className }: {
  body: string;
  className?: string;
}) {
  return <p className={cn(
    "m-0 h-auto w-fit max-w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
    className,
  )}>{body}</p>;
}
