// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ReactNode } from "react";

import { getAppRouter } from "@/lib/app-router";

// Links in chat replies open in a new tab, except one exact shape: an in-app canvas path
// (/projects/<project>/freezone?canvas=<id>), which an Agent hands over after creating a
// canvas. That shape switches canvases in this tab through the router, and a bare path of
// that shape in a reply is turned into such a link.
export function parseChatCanvasHref(href: string | undefined): { project: string; canvas: string } | null {
  const match = href?.match(/^\/projects\/([A-Za-z0-9._~%-]+)\/freezone\?canvas=([A-Za-z0-9_-]{1,64})$/);
  if (!match) return null;
  try {
    const project = decodeURIComponent(match[1]);
    if (project === "." || project === ".." || project.includes("/")) return null;
    return { project, canvas: match[2] };
  } catch {
    return null;
  }
}

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

const SKIP_NODE_TYPES = new Set([
  "link", "linkReference", "inlineCode", "code", "html", "definition", "image", "imageReference",
]);

function linkCanvasPaths(node: MarkdownNode, value: string): MarkdownNode[] {
  const paths = /\/projects\/[A-Za-z0-9._~%-]+\/freezone\?canvas=[A-Za-z0-9_-]{1,64}(?![A-Za-z0-9_\-&#=%/?])/g;
  const pieces: MarkdownNode[] = [];
  let offset = 0;
  for (const match of value.matchAll(paths)) {
    const start = match.index;
    const path = match[0];
    if ((start > 0 && /[A-Za-z0-9_./:%-]/.test(value[start - 1])) || !parseChatCanvasHref(path)) continue;
    if (start > offset) pieces.push({ type: "text", value: value.slice(offset, start) });
    const link = {
      type: "link", url: path, title: null,
      children: [{ type: "text", value: path }],
    };
    pieces.push(link);
    offset = start + path.length;
  }
  if (offset === 0) return [node];
  if (offset < value.length) pieces.push({ type: "text", value: value.slice(offset) });
  return pieces;
}

export function remarkChatCanvasPaths() {
  function walk(node: MarkdownNode): void {
    if (SKIP_NODE_TYPES.has(node.type) || !node.children) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text" && typeof child.value === "string") {
        return linkCanvasPaths(child, child.value);
      }
      walk(child);
      return [child];
    });
  }
  return walk;
}

export function ChatMarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const canvasLink = parseChatCanvasHref(href);
  const className = "text-primary underline underline-offset-2";
  if (!canvasLink) {
    return <a href={href} target="_blank" rel="noreferrer" className={className}>{children}</a>;
  }
  return (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0
          || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const router = getAppRouter();
        if (!router) return;
        event.preventDefault();
        router.navigate({
          to: "/projects/$project/freezone",
          params: { project: canvasLink.project },
          search: { canvas: canvasLink.canvas },
          resetScroll: false,
        });
      }}
    >
      {children}
    </a>
  );
}
