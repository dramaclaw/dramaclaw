// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  ArrowDown,
  ArrowUp,
  Braces,
  Copy,
  Download,
  File,
  Image,
  ListTree,
  Maximize2,
  Mic,
  MicOff,
  Plus,
  Play,
  Pin,
  PinOff,
  Search,
  ShieldAlert,
  Wrench,
  X,
  Volume2,
} from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useParams } from "@tanstack/react-router";
import { attachBorderBeam, type BorderBeamController } from "border-beam-vanilla";
import {
  SpecRenderer,
  SpecRendererProvider,
  VideoDetailModal,
} from "dramaclaw-spec-render";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuthStore } from "@/stores/auth-store";
import { cn } from "@/lib/utils";
import { resolveMediaUrl } from "@/lib/media-url";
import { api } from "@/lib/api";
import { backendErrorToastMessage, jsonWithBackendError } from "@/lib/api-errors";
import { p } from "@/lib/api-path";
import { useSuperChat } from "@/features/superchat/use-superchat";
import { useAiAvatarUrl } from "@/features/superchat/ai-avatar";
import { buildChatTaskLabel } from "@/features/superchat/task-notification-label";
import { useEventBus } from "@/task-center/event-bus-context";
import {
  extractStructuredBlocks,
  isUiSpec,
  looksLikeStructuredRenderText,
  type StructuredBlock,
  type UiSpec,
} from "@/features/superchat/spec-extract";
import type { ChatMessage } from "@/features/superchat/types";
import type { ApprovalRequest, ChatAttachment } from "@/features/superchat/types";
import { FormatCheckDetailsDialog } from "@/components/ingest/FormatCheckDetailsDialog";
import type { FormatCheck, UploadResult } from "@/lib/queries/ingest";
import type { ErrorResponse, OkResponse, TaskResponse } from "@/types/api";

type SpecMediaDetailSection = {
  title: string;
  body?: string;
  items?: string[];
};

type SpecMediaDetail = {
  kind: "image" | "video";
  src: string;
  poster?: string;
  title?: string;
  description?: string;
  tags?: Array<{ label: string; color?: string }>;
  sections?: SpecMediaDetailSection[];
  candidates?: Array<{ id?: string; src: string; label?: string }>;
};

// Reuse the canonical upload payload shape (incl. format_check) from the ingest
// query module so the contract lives in one place.
type IngestUploadResult = UploadResult;

type PreparedIngestAttachment = {
  attachment: ChatAttachment;
  original: ChatAttachment;
  upload?: IngestUploadResult;
  error?: string;
};

type UploadedIngestFile = {
  filename: string;
  originalName?: string;
  size: number;
  totalChars?: number;
  chapterCount?: number;
  uploadedAt: number;
};

type ReingestConfirmation = {
  stage: "choose_overwrite" | "confirm_clear";
  filename: string;
  project: string;
  originalText: string;
};

type IngestAutomationResult = {
  filename: string;
  taskType?: string;
  taskKey?: string;
  message?: string;
  rebuild?: boolean;
};

function parseSpecMediaUrl(src: string): string | null {
  if (src.startsWith("st-unresolved:")) return src;
  return null;
}

function resolveSpecMediaUrl(src: string): Promise<string> {
  if (src.startsWith("st-unresolved:")) return Promise.resolve(src);
  return Promise.resolve(resolveMediaUrl(src) ?? src);
}

type AttachmentBlob = {
  blob: Blob;
  filename: string;
};

type QueuedSendItem = {
  id: string;
  text: string;
  attachments: ChatAttachment[];
  createdAt: number;
};

const ENABLE_SUPERCHAT_FILE_UPLOAD = false;

function isToolMessage(message: ChatMessage): boolean {
  if (message.role === "tool") return true;
  if (!message.raw || typeof message.raw !== "object") return false;
  const raw = message.raw as Record<string, unknown>;
  const role = raw.role;
  const type = raw.type;
  return (
    role === "trace"
    || role === "tool"
    || role === "tool_result"
    || role === "toolResult"
    || type === "tool.result"
    || type === "tool_update"
  );
}

function isHistoricalToolMessage(message: ChatMessage): boolean {
  const raw = message.raw && typeof message.raw === "object"
    ? (message.raw as Record<string, unknown>)
    : {};
  return raw.role === "trace";
}

function normalizeMessageText(text: string): string {
  return text.trim().replace(/\n{3,}/g, "\n\n");
}

function PlainMessageText({ text }: { text: string }) {
  const paragraphs = normalizeMessageText(text)
    .split(/\n{2}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) return null;

  return (
    <div className="space-y-2 break-words leading-relaxed">
      {paragraphs.map((paragraph, index) => (
        <p key={`${index}-${paragraph.slice(0, 12)}`} className="whitespace-pre-wrap">
          {paragraph}
        </p>
      ))}
    </div>
  );
}

function MarkdownMessageText({ text }: { text: string }) {
  const normalized = normalizeMessageText(text);
  if (!normalized) return null;

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      components={{
        h1: ({ children }) => <h1 className="mb-2 mt-3 text-lg font-semibold leading-7 first:mt-0">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 mt-3 text-base font-semibold leading-6 first:mt-0">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-1.5 mt-2.5 text-sm font-semibold leading-6 first:mt-0">{children}</h3>,
        p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="my-1.5 list-disc space-y-1 pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-1 pl-5">{children}</ol>,
        li: ({ children }) => <li className="pl-0.5">{children}</li>,
        strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        a: ({ children, href }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            {children}
          </a>
        ),
        code: ({ children }) => (
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em]">{children}</code>
        ),
        pre: ({ children }) => (
          <pre className="my-2 max-w-full overflow-x-auto rounded-md border border-border/70 bg-muted/35 p-2 text-xs leading-5">
            {children}
          </pre>
        ),
        hr: () => <hr className="my-4 border-0 border-t border-white/[0.08]" />,
        blockquote: ({ children }) => (
          <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>
        ),
      }}
    >
      {normalized}
    </ReactMarkdown>
  );
}

function MessageText({
  text,
  markdown = false,
}: {
  text: string;
  markdown?: boolean;
}) {
  return markdown
    ? <MarkdownMessageText text={text} />
    : <PlainMessageText text={text} />;
}

const ASSISTANT_ERROR_TEXT_PATTERNS: RegExp[] = [
  /模型内容安全过滤拦截/u,
  /Render 任务没有生成可用图片/u,
  /错误原因：.+/u,
  /生成.+失败/u,
  /任务.+失败/u,
  /没有成功启动/u,
  /请先根据返回的错误/u,
  /content filter triggered/i,
  /finish reason:\s*['"]?content_filter/i,
];

function isAssistantErrorReply(message: ChatMessage): boolean {
  if (message.role !== "assistant") return false;
  const text = message.text.trim();
  if (!text) return false;
  return ASSISTANT_ERROR_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}

function isAssistantCompletionNotice(message: ChatMessage): boolean {
  if (message.role !== "assistant") return false;
  return /^✅ .+已完成。/u.test(message.text.trim());
}

function errorTextRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const pattern of ASSISTANT_ERROR_TEXT_PATTERNS) {
    const match = pattern.exec(text);
    if (!match || match.index < 0) continue;
    const start = match.index;
    let end = start + match[0].length;
    while (end < text.length && !/[。！？\n]/u.test(text[end])) {
      end += 1;
    }
    if (end < text.length && /[。！？]/u.test(text[end])) {
      end += 1;
    }
    ranges.push([start, end]);
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

function HighlightedErrorText({ text }: { text: string }) {
  const ranges = errorTextRanges(text);
  if (ranges.length === 0) return <MessageText text={text} markdown />;

  const nodes: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], index) => {
    if (start > cursor) {
      nodes.push(<MessageText key={`normal-${index}`} text={text.slice(cursor, start)} markdown />);
    }
    nodes.push(
      <span key={`error-${index}`} className="text-red-300">
        {text.slice(start, end)}
      </span>,
    );
    cursor = Math.max(cursor, end);
  });
  if (cursor < text.length) {
    nodes.push(<MessageText key="normal-tail" text={text.slice(cursor)} markdown />);
  }
  return <div className="space-y-1.5">{nodes}</div>;
}

function HighlightedCompletionText({ text }: { text: string }) {
  const match = /^✅ .+?已完成。/u.exec(text);
  if (!match) return <MessageText text={text} markdown />;
  const end = match[0].length;
  return (
    <div className="break-words leading-relaxed whitespace-pre-wrap">
      <span className="text-emerald-300">{text.slice(0, end)}</span>
      <span>{text.slice(end)}</span>
    </div>
  );
}

function DotsIndicator({ label, dotClassName = "size-1.5" }: { label?: string; dotClassName?: string }) {
  return (
    <div className="flex items-center gap-2" aria-live="polite" aria-label={label}>
      <span className="flex items-center gap-1">
        <span className={cn(dotClassName, "rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0ms]")} />
        <span className={cn(dotClassName, "rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:150ms]")} />
        <span className={cn(dotClassName, "rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:300ms]")} />
      </span>
      {label && <span className="sr-only">{label}</span>}
    </div>
  );
}

function ChatAvatarFrame({
  role,
  label,
  streaming: _streaming = false,
}: {
  role: ChatMessage["role"];
  label?: string;
  streaming?: boolean;
}) {
  const isAssistant = role === "assistant";
  const isTool = role === "tool";
  const initial = label?.trim().charAt(0).toUpperCase() || (isAssistant ? "虾" : isTool ? "" : "U");
  // Shared, fetch-once avatar source (see ai-avatar.ts) — null until ready so we
  // don't kick off a raw-path request from every avatar before the blob lands.
  const avatarUrl = useAiAvatarUrl();

  return (
    <div
      className={cn(
        "relative flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full border text-xs font-medium shadow-sm",
        isAssistant ? "size-11" : "size-10",
        isAssistant
          ? "border-transparent bg-transparent text-muted-foreground shadow-none"
          : isTool
            ? "border-amber-500/30 bg-amber-500/10 text-amber-500"
            : "border-primary/20 bg-primary text-primary-foreground",
      )}
      aria-hidden="true"
    >
      {isAssistant ? (
        avatarUrl && (
          <video
            className="size-full object-cover"
            src={avatarUrl}
            autoPlay
            loop
            muted
            playsInline
            aria-hidden="true"
          />
        )
      ) : isTool ? (
        <Wrench className="size-4" />
      ) : (
        initial
      )}
    </div>
  );
}

function renderJsonScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function triggerDownload(url: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  link.rel = "noopener noreferrer";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

type KeyframeVideoPreviewItem = {
  id: string;
  title: string;
  description?: string;
  poster?: string;
  videoSrc?: string;
  status?: string;
  progress?: number;
};

type UnifiedMediaKind = "image" | "video" | "audio";

type UnifiedMediaItem = {
  id: string;
  kind: UnifiedMediaKind;
  title: string;
  description?: string;
  src: string;
  poster?: string;
};

function elementProps(element: unknown): Record<string, unknown> {
  if (!element || typeof element !== "object") return {};
  const props = (element as Record<string, unknown>).props;
  return props && typeof props === "object" && !Array.isArray(props)
    ? props as Record<string, unknown>
    : {};
}

function textProp(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function numberProp(value: unknown): number | undefined {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseFloat(value)
      : Number.NaN;
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 100) : undefined;
}

function specElementOrder(spec: UiSpec): string[] {
  const root = spec.elements[spec.root];
  const children = root && typeof root === "object"
    ? (root as Record<string, unknown>).children
    : undefined;
  const ordered = Array.isArray(children)
    ? children.filter((child): child is string => typeof child === "string")
    : [];
  const orderedSet = new Set(ordered);
  return [
    ...ordered,
    ...Object.keys(spec.elements).filter((key) => key !== spec.root && !orderedSet.has(key)),
  ];
}

function extractUnifiedMediaItems(spec: UiSpec): UnifiedMediaItem[] {
  const mediaSpecTypes = new Set([
    "character_showcase",
    "sketch_gallery",
    "keyframe_video",
    "audio_list",
    "media_bundle",
  ]);
  if (spec.type && !mediaSpecTypes.has(spec.type)) return [];

  const items: UnifiedMediaItem[] = [];
  for (const id of specElementOrder(spec)) {
    const element = spec.elements[id];
    if (!element || typeof element !== "object") continue;
    const record = element as Record<string, unknown>;
    const props = elementProps(record);
    const type = typeof record.type === "string" ? record.type : "";
    const src = textProp(props.src, props.url);
    if (!src) continue;

    if (type === "Image") {
      items.push({
        id,
        kind: "image",
        title: textProp(props.overlayTitle, props.title, props.caption, props.alt, id),
        description: textProp(props.overlayDescription, props.description),
        src,
        poster: textProp(props.poster, props.thumbnail),
      });
      continue;
    }

    if (type === "Video") {
      items.push({
        id,
        kind: "video",
        title: textProp(props.overlayTitle, props.title, props.caption, props.alt, id),
        description: textProp(props.overlayDescription, props.description),
        src,
        poster: textProp(props.poster, props.thumbnail),
      });
      continue;
    }

    if (type === "Audio") {
      items.push({
        id,
        kind: "audio",
        title: textProp(props.overlayTitle, props.title, props.caption, props.alt, id),
        description: textProp(props.overlayDescription, props.description),
        src,
        poster: textProp(props.poster, props.thumbnail),
      });
    }
  }
  return items;
}

function extractKeyframeVideoPreviewItems(spec: UiSpec): KeyframeVideoPreviewItem[] {
  return Object.entries(spec.elements)
    .flatMap(([id, element]) => {
      if (!element || typeof element !== "object") return [];
      const record = element as Record<string, unknown>;
      if (record.type !== "Video") return [];

      const props = elementProps(record);
      const videoSrc = textProp(props.src, props.url);
      if (!videoSrc) return [];

      return [{
        id,
        title: textProp(props.overlayTitle, props.caption, props.alt, id),
        description: textProp(props.overlayDescription, props.description),
        poster: textProp(props.poster),
        videoSrc,
      }];
    });
}

function useResolvedSpecUrl(src?: string): string | undefined {
  const [resolved, setResolved] = useState(src);

  useEffect(() => {
    let cancelled = false;
    if (!src) {
      setResolved(undefined);
      return undefined;
    }

    resolveSpecMediaUrl(src).then((url) => {
      if (!cancelled) setResolved(url);
    });

    return () => {
      cancelled = true;
    };
  }, [src]);

  return resolved;
}

function useVideoFirstFrame(src?: string, explicitPoster?: string): string | undefined {
  const [poster, setPoster] = useState(explicitPoster);

  useEffect(() => {
    if (explicitPoster) {
      setPoster(explicitPoster);
      return undefined;
    }

    setPoster(undefined);
    if (!src) return undefined;

    let cancelled = false;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = src;

    const capture = () => {
      if (cancelled || video.videoWidth <= 0 || video.videoHeight <= 0) return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        setPoster(canvas.toDataURL("image/jpeg", 0.82));
      } catch {
        setPoster(undefined);
      }
    };

    const seekToFirstFrame = () => {
      if (cancelled) return;
      const target = Number.isFinite(video.duration) && video.duration > 0
        ? Math.min(0.12, Math.max(video.duration / 100, 0.01))
        : 0.01;
      try {
        video.currentTime = target;
      } catch {
        capture();
      }
    };

    video.addEventListener("loadeddata", seekToFirstFrame, { once: true });
    video.addEventListener("seeked", capture, { once: true });
    video.load();

    return () => {
      cancelled = true;
      video.removeAttribute("src");
      video.load();
    };
  }, [src, explicitPoster]);

  return poster;
}

function KeyframeVideoPreviewCard({ item }: { item: KeyframeVideoPreviewItem }) {
  const [open, setOpen] = useState(false);
  const poster = useResolvedSpecUrl(item.poster);
  const videoSrc = useResolvedSpecUrl(item.videoSrc);
  const previewPoster = useVideoFirstFrame(videoSrc, poster);
  const playable = Boolean(videoSrc);
  const cardStyle = { width: "158px", height: "211px" };

  return (
    <>
      <div style={{ perspective: 800, ...cardStyle }} className="shrink-0">
        <div className="relative h-full w-full overflow-hidden rounded-2xl bg-white/5 p-[1.5px]">
          <div className="relative z-10 h-full w-full overflow-hidden rounded-[14px] bg-zinc-950">
            <button
              type="button"
              className={cn("relative h-full w-full cursor-pointer text-left", !playable && "cursor-default")}
              onClick={() => {
                if (playable) setOpen(true);
              }}
              aria-label={item.title}
            >
              {previewPoster ? (
                <img
                  className="block h-full w-full select-none object-cover"
                  src={previewPoster}
                  alt={item.title}
                  loading="lazy"
                  draggable={false}
                />
              ) : (
                <span className="st-keyframe-video-placeholder block h-full w-full" />
              )}
              {playable && (
                <span className="st-keyframe-video-play">
                  <Play className="size-5 fill-white text-white" />
                </span>
              )}
              <span className="absolute inset-x-0 bottom-0 z-10 flex flex-col gap-1 bg-gradient-to-t from-black/85 via-black/35 to-transparent px-3 pb-3 pt-8 text-white">
                <span className="truncate text-sm font-semibold">{item.title}</span>
                {item.description && (
                  <span className="line-clamp-2 text-[11px] leading-4 text-white/80">
                    {item.description}
                  </span>
                )}
                {item.status && (
                  <span className="st-keyframe-video-status">{item.status}</span>
                )}
                {item.progress !== undefined && (
                  <span className="st-keyframe-video-progress">
                    <span style={{ width: `${item.progress}%` }} />
                  </span>
                )}
              </span>
            </button>
          </div>
        </div>
      </div>
      {playable && (
        <VideoDetailModal
          src={videoSrc}
          poster={poster}
          title={item.title}
          description={item.description}
          open={open}
          setOpen={setOpen}
        />
      )}
    </>
  );
}

function UnifiedMediaCard({
  item,
  onOpenMedia,
}: {
  item: UnifiedMediaItem;
  onOpenMedia?: (detail: SpecMediaDetail) => void;
}) {
  const [videoOpen, setVideoOpen] = useState(false);
  const src = useResolvedSpecUrl(item.src);
  const poster = useResolvedSpecUrl(item.poster);
  const previewPoster = useVideoFirstFrame(item.kind === "video" ? src : undefined, poster);
  const imageSrc = item.kind === "video" ? previewPoster : item.kind === "image" ? src : poster;
  const playable = Boolean(src);

  const openPreview = () => {
    if (!src) return;
    if (item.kind === "video") {
      setVideoOpen(true);
      return;
    }
    if (item.kind === "image") {
      onOpenMedia?.({
        kind: "image",
        src,
        poster,
        title: item.title,
        description: item.description,
      });
    }
  };

  return (
    <>
      <div className="st-unified-media-card">
        <div className="relative h-full w-full overflow-hidden rounded-2xl bg-white/5 p-[1.5px]">
          <div className="relative z-10 h-full w-full overflow-hidden rounded-[14px] bg-zinc-950">
            {item.kind === "audio" ? (
              <div className="relative flex h-full w-full flex-col justify-center gap-4 px-3 pb-16 pt-5">
                <span className="mx-auto flex size-14 items-center justify-center rounded-full border border-white/15 bg-white/10 text-white shadow-[0_12px_30px_rgba(0,0,0,0.3)]">
                  <Volume2 className="size-7" />
                </span>
                {src && (
                  <audio
                    className="st-unified-media-audio w-full"
                    src={src}
                    controls
                    preload="metadata"
                  />
                )}
                {!src && <span className="st-keyframe-video-placeholder absolute inset-0" />}
                <span className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col gap-1 bg-gradient-to-t from-black/85 via-black/35 to-transparent px-3 pb-3 pt-8 text-white">
                  <span className="truncate text-sm font-semibold">{item.title}</span>
                  {item.description && (
                    <span className="line-clamp-2 text-[11px] leading-4 text-white/80">
                      {item.description}
                    </span>
                  )}
                </span>
              </div>
            ) : (
              <button
                type="button"
                className={cn("relative h-full w-full text-left", playable ? "cursor-pointer" : "cursor-default")}
                onClick={openPreview}
                aria-label={item.title}
              >
                {imageSrc ? (
                  <img
                    className="block h-full w-full select-none object-cover"
                    src={imageSrc}
                    alt={item.title}
                    loading="lazy"
                    draggable={false}
                  />
                ) : (
                  <span className="st-keyframe-video-placeholder block h-full w-full" />
                )}
                {item.kind === "video" && playable && (
                  <span className="st-keyframe-video-play">
                    <Play className="size-5 fill-white text-white" />
                  </span>
                )}
                <span className="absolute inset-x-0 bottom-0 z-10 flex flex-col gap-1 bg-gradient-to-t from-black/85 via-black/35 to-transparent px-3 pb-3 pt-8 text-white">
                  <span className="truncate text-sm font-semibold">{item.title}</span>
                  {item.description && (
                    <span className="line-clamp-2 text-[11px] leading-4 text-white/80">
                      {item.description}
                    </span>
                  )}
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
      {item.kind === "video" && src && (
        <VideoDetailModal
          src={src}
          poster={poster}
          title={item.title}
          description={item.description}
          open={videoOpen}
          setOpen={setVideoOpen}
        />
      )}
    </>
  );
}

function UnifiedMediaGrid({
  spec,
  onOpenMedia,
}: {
  spec: UiSpec;
  onOpenMedia?: (detail: SpecMediaDetail) => void;
}) {
  const items = extractUnifiedMediaItems(spec);
  if (items.length === 0) return null;

  return (
    <div className="st-unified-media-grid">
      {items.map((item) => (
        <UnifiedMediaCard key={item.id} item={item} onOpenMedia={onOpenMedia} />
      ))}
    </div>
  );
}

function extractPendingKeyframeVideoItem(spec: UiSpec): KeyframeVideoPreviewItem | null {
  const root = spec.elements[spec.root];
  const rootProps = elementProps(root);
  const title = textProp(rootProps.title, rootProps.description, spec.type);
  const description = textProp(rootProps.description);
  let status = "";
  let progress: number | undefined;

  for (const element of Object.values(spec.elements)) {
    if (!element || typeof element !== "object") continue;
    const record = element as Record<string, unknown>;
    const props = elementProps(record);
    if (record.type === "Badge" && !status) {
      status = textProp(props.label, props.text);
    }
    if (record.type === "Progress" && progress === undefined) {
      progress = numberProp(props.value);
    }
  }

  if (!title && !status && progress === undefined) return null;

  return {
    id: "pending",
    title,
    description,
    status,
    progress,
  };
}

function KeyframeVideoPreview({ spec }: { spec: UiSpec }) {
  const videoItems = extractKeyframeVideoPreviewItems(spec);
  const pendingItem = videoItems.length === 0 ? extractPendingKeyframeVideoItem(spec) : null;
  const items = videoItems.length > 0 ? videoItems : pendingItem ? [pendingItem] : [];

  if (items.length === 0) {
    return <SpecRenderer spec={spec} />;
  }

  return (
    <div className="st-keyframe-video-preview">
      <div className="st-keyframe-video-grid">
        {items.map((item) => (
          <KeyframeVideoPreviewCard key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}

function UiSpecRenderer({
  spec,
  onOpenMedia,
}: {
  spec: UiSpec;
  onOpenMedia?: (detail: SpecMediaDetail) => void;
}) {
  const mediaItems = extractUnifiedMediaItems(spec);
  // Keep this wrapper aligned with SuperChat so media specs inherit the same
  // renderer sizing and do not get an extra local card frame.
  return (
    <div
      className="chat-spec-renderer w-full min-w-0 max-w-full overflow-visible [contain:layout]"
      data-spec-type={spec.type ?? "auto"}
    >
      <SpecRendererProvider
        resolveMediaUrl={resolveSpecMediaUrl}
        parseMediaUrl={parseSpecMediaUrl}
        loadingVideoUrl="/video/loading.mp4"
      >
        {mediaItems.length > 0 ? (
          <UnifiedMediaGrid spec={spec} onOpenMedia={onOpenMedia} />
        ) : spec.type === "keyframe_video" ? (
          <KeyframeVideoPreview spec={spec} />
        ) : (
          <SpecRenderer spec={spec} />
        )}
      </SpecRendererProvider>
    </div>
  );
}

function JsonNode({
  name,
  value,
  depth = 0,
}: {
  name?: string;
  value: unknown;
  depth?: number;
}) {
  if (Array.isArray(value)) {
    return (
      <div className={cn("space-y-1", depth > 0 && "pl-3")}>
        {name && <div className="text-xs font-medium text-muted-foreground">{name}</div>}
        {value.map((item, index) => (
          <JsonNode key={index} name={`#${index + 1}`} value={item} depth={depth + 1} />
        ))}
      </div>
    );
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const objectTitle =
      typeof (value as Record<string, unknown>).title === "string"
        ? String((value as Record<string, unknown>).title)
        : name;
    return (
      <div className={cn("rounded-md border border-border/70 bg-background/45 p-2", depth > 0 && "ml-2")}>
        {objectTitle && <div className="mb-1 text-xs font-semibold text-foreground">{objectTitle}</div>}
        <div className="space-y-1">
          {entries.map(([key, item]) => (
            <JsonNode key={key} name={key} value={item} depth={depth + 1} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("grid grid-cols-[88px_minmax(0,1fr)] gap-2 text-xs", depth > 0 && "pl-2")}>
      {name && <span className="truncate text-muted-foreground">{name}</span>}
      <span className="min-w-0 break-words font-mono text-foreground/90">{renderJsonScalar(value)}</span>
    </div>
  );
}

function StructuredRenderer({
  blocks,
  onOpenMedia,
}: {
  blocks: StructuredBlock[];
  onOpenMedia?: (detail: SpecMediaDetail) => void;
}) {
  if (blocks.length === 0) return null;
  return (
    <div className="mt-3 flex w-full min-w-0 max-w-full flex-col items-stretch gap-3">
      {blocks.map((block) => {
        if (isUiSpec(block.value)) {
          return (
            <section
              key={block.id}
              className="w-full min-w-0 max-w-full flex-none overflow-visible [contain:layout]"
            >
              <UiSpecRenderer spec={block.value} onOpenMedia={onOpenMedia} />
            </section>
          );
        }
        return (
          <section
            key={block.id}
            className="w-full min-w-0 max-w-full rounded-lg border border-border/70 bg-background/35 p-2 [contain:layout]"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <Badge variant="outline" className="h-5 rounded-md px-1.5 text-[10px] uppercase">
                {block.label}
              </Badge>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => navigator.clipboard?.writeText(JSON.stringify(block.value, null, 2)).catch(() => undefined)}
                aria-label="Copy JSON"
              >
                <Copy className="size-3" />
              </Button>
            </div>
            <JsonNode value={block.value} />
          </section>
        );
      })}
    </div>
  );
}

function SpecMediaDetailModal({
  detail,
  onClose,
  onOpenMedia,
}: {
  detail: SpecMediaDetail | null;
  onClose: () => void;
  onOpenMedia: (detail: SpecMediaDetail) => void;
}) {
  const { t } = useTranslation();
  const open = Boolean(detail);
  const src = detail?.src ?? "";
  const poster = detail?.poster || src;
  const downloadSrc = detail?.kind === "video" ? src || poster : src;
  const sections =
    detail?.sections && detail.sections.length > 0
      ? detail.sections
      : detail?.description
        ? [{ title: t("aiAssistant.mediaDescription"), body: detail.description }]
        : [];

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) onClose();
    }}>
      <DialogContent
        showCloseButton={false}
        className="fixed inset-0 left-0 top-0 flex h-screen w-screen max-w-none translate-x-0 translate-y-0 items-center justify-center rounded-none border-none bg-black/25 p-0 text-white backdrop-blur-xl sm:max-w-none"
      >
        <DialogTitle className="sr-only">{detail?.title || t("aiAssistant.mediaDetail")}</DialogTitle>
        <div className="absolute right-6 top-5 z-50 flex items-center gap-5">
          <button
            type="button"
            className="text-white/45 transition hover:text-white"
            onClick={() => {
              if (downloadSrc) triggerDownload(downloadSrc);
            }}
            aria-label={t("aiAssistant.download")}
            title={t("aiAssistant.download")}
          >
            <Download className="size-6" />
          </button>
          <DialogClose className="text-white/45 outline-none transition hover:text-white" aria-label={t("aiAssistant.closeDetail")}>
            <X className="size-7" />
          </DialogClose>
        </div>

        {detail && (
          <div className="flex h-full w-full max-w-7xl items-center justify-center p-6">
            <div className="grid h-full w-full grid-cols-1 items-center gap-8 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-10">
              <div className="relative mx-auto flex max-h-[82vh] max-w-full items-center justify-center overflow-hidden rounded-[28px] bg-black/45 shadow-[0_30px_80px_rgba(0,0,0,0.45)]">
                {detail.kind === "video" ? (
                  <video
                    className="block max-h-[82vh] max-w-full object-contain"
                    src={src}
                    poster={poster || undefined}
                    controls
                    playsInline
                  />
                ) : (
                  <img
                    className="block max-h-[82vh] max-w-full object-contain"
                    src={src}
                    alt={detail.title || "image"}
                  />
                )}
              </div>

              <div className="flex min-w-0 flex-col justify-center self-center">
                {detail.title && (
                  <h2 className="text-[34px] font-semibold tracking-tight text-white/95">
                    {detail.title}
                  </h2>
                )}
                {detail.tags && detail.tags.length > 0 && (
                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {detail.tags.map((tag) => (
                      <span
                        key={`${tag.label}:${tag.color ?? ""}`}
                        className="rounded border border-white/20 px-2 py-1 text-xs text-white/70"
                        style={tag.color ? { borderColor: tag.color, color: tag.color } : undefined}
                      >
                        {tag.label}
                      </span>
                    ))}
                  </div>
                )}

                <div className="mt-6 space-y-0">
                  {sections.map((section, index) => (
                    <section key={`${section.title}-${index}`} className="border-t border-white/10 py-7 first:border-t">
                      {section.title && (
                        <h3 className="mb-5 text-[15px] font-medium text-white/55">
                          {section.title}
                        </h3>
                      )}
                      {section.items && section.items.length > 0 && (
                        <ul className="space-y-5 text-[16px] leading-8 text-white/88">
                          {section.items.map((item, itemIndex) => (
                            <li key={`${section.title}-${itemIndex}`} className="flex gap-3">
                              <span className="mt-[11px] size-1.5 shrink-0 rounded-full bg-white/65" />
                              <span>{item}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {section.body && (
                        <p className="whitespace-pre-wrap text-[16px] leading-8 text-white/88">
                          {section.body}
                        </p>
                      )}
                    </section>
                  ))}
                </div>

                {detail.candidates && detail.candidates.length > 0 && (
                  <div className="mt-2 border-t border-white/10 pt-5">
                    <div className="mb-3 text-[15px] font-medium text-white/55">
                      {t("aiAssistant.mediaCandidates")}
                    </div>
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {detail.candidates.map((candidate, index) => (
                        <button
                          key={candidate.id || index}
                          type="button"
                          onClick={() => onOpenMedia({
                            ...detail,
                            kind: "image",
                            src: candidate.src,
                            title: candidate.label || detail.title,
                          })}
                          className="block w-16 shrink-0 overflow-hidden rounded-lg border border-white/15 bg-black"
                          title={candidate.label}
                        >
                          <img src={candidate.src} alt={candidate.label || "candidate"} className="aspect-[3/4] w-full object-cover" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const MessageBubble = memo(function MessageBubble({
  message,
  variant = "default",
  onOpenDetail,
  onOpenMedia,
  pinned,
  onDelete,
  onTogglePin,
  deferStructuredRender = false,
  streaming = false,
}: {
  message: ChatMessage;
  variant?: SuperChatPanelVariant;
  onOpenDetail: (message: ChatMessage) => void;
  onOpenMedia: (detail: SpecMediaDetail) => void;
  pinned: boolean;
  onDelete: (id: string) => void;
  onTogglePin: (id: string) => void;
  deferStructuredRender?: boolean;
  streaming?: boolean;
}) {
  const isUser = message.role === "user";
  const isTool = isToolMessage(message);
  const isHistoricalTool = isTool && isHistoricalToolMessage(message);
  const isFreezoneLayout = variant === "freezone";
  const isErrorReply = isAssistantErrorReply(message);
  const isCompletionNotice = isAssistantCompletionNotice(message);
  const { t } = useTranslation();
  const shouldWaitForStructuredRender =
    deferStructuredRender && !isUser && !isTool && looksLikeStructuredRenderText(message.text);
  const { displayText, blocks } = extractStructuredBlocks(message);
  const copyText = async () => {
    await navigator.clipboard?.writeText(message.text).catch(() => undefined);
  };
  const speak = () => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(message.text));
  };
  const userActionButtonClass =
    "size-7 rounded-md text-foreground/70 opacity-100 hover:bg-white/[0.1] hover:text-foreground";
  const userActionIconClass = "size-3.5 stroke-[2.25]";
  const actions = (
    <div
      className={cn(
        isUser
          ? "pointer-events-none absolute right-1.5 top-1.5 z-10 flex translate-y-0.5 items-center gap-0.5 rounded-full border border-border/70 bg-background/85 px-1 py-0.5 text-foreground/75 opacity-0 shadow-sm backdrop-blur transition-opacity group-hover/message-actions:pointer-events-auto group-hover/message-actions:opacity-100 group-focus-within/message-actions:pointer-events-auto group-focus-within/message-actions:opacity-100"
          : "mt-2 flex items-center gap-1 text-muted-foreground/70",
      )}
    >
      <Button
        variant="ghost"
        size="icon-xs"
        className={cn("opacity-70 hover:bg-white/[0.06] hover:text-foreground hover:opacity-100", isUser && userActionButtonClass)}
        onClick={copyText}
        aria-label="Copy"
      >
        <Copy className={cn("size-3.5", isUser && userActionIconClass)} />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className={cn("opacity-70 hover:bg-white/[0.06] hover:text-foreground hover:opacity-100", isUser && userActionButtonClass)}
        onClick={speak}
        aria-label="Speak"
      >
        <Volume2 className={cn("size-3.5", isUser && userActionIconClass)} />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className={cn("opacity-70 hover:bg-white/[0.06] hover:text-foreground hover:opacity-100", isUser && userActionButtonClass)}
        onClick={() => onOpenDetail(message)}
        aria-label="Details"
      >
        <Maximize2 className={cn("size-3.5", isUser && userActionIconClass)} />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className={cn("opacity-70 hover:bg-white/[0.06] hover:text-foreground hover:opacity-100", isUser && userActionButtonClass)}
        onClick={() => onTogglePin(message.id)}
        aria-label={pinned ? "Unpin" : "Pin"}
      >
        {pinned ? <PinOff className={cn("size-3.5", isUser && userActionIconClass)} /> : <Pin className={cn("size-3.5", isUser && userActionIconClass)} />}
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className={cn("opacity-70 hover:bg-white/[0.06] hover:text-foreground hover:opacity-100", isUser && userActionButtonClass)}
        onClick={() => onDelete(message.id)}
        aria-label="Delete"
      >
        <X className={cn("size-3.5", isUser && userActionIconClass)} />
      </Button>
    </div>
  );

  if (isUser) {
    return (
      <div className="flex justify-end">
        <article className={cn("max-w-[72%]", isFreezoneLayout && "max-w-[82%]")}>
          <div className="group/message-actions">
            <div
              className={cn(
                "relative rounded-[14px] border-0 bg-white/[0.12] px-4 py-2.5 text-sm leading-6 text-foreground shadow-none",
              )}
            >
              {actions}
              <AttachmentList attachments={message.attachments} align="end" />
              {displayText && (
                <div className="whitespace-pre-wrap break-words">{displayText}</div>
              )}
              <StructuredRenderer blocks={blocks} />
            </div>
          </div>
        </article>
      </div>
    );
  }

  return (
    <div className={cn("flex items-start gap-3", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (
        <ChatAvatarFrame
          role={message.role}
          label={message.displayName || t("aiAssistant.title")}
          streaming={streaming}
        />
      )}
      <div className={cn("flex min-w-0 flex-1", isUser ? "justify-end" : "justify-start")}>
        <article
          className={cn(
            "group relative text-sm leading-6 shadow-none",
            blocks.length > 0 && !isUser && !isTool
              ? "w-full min-w-0 overflow-visible"
              : "w-fit overflow-hidden",
            isTool
              ? "max-w-[86%] rounded-[14px] border border-amber-500/20 bg-amber-500/8 px-4 pb-3 pt-2 text-card-foreground"
              : isUser
                ? "max-w-[86%] rounded-[14px] bg-muted px-4 pb-3 pt-2 text-foreground"
                : "max-w-full rounded-[14px] border border-white/[0.08] bg-transparent px-4 pb-3 pt-2 text-foreground",
          )}
        >
        <div className="pointer-events-none absolute right-1.5 top-1.5 z-10 flex translate-y-0.5 items-center gap-0.5 rounded-full border border-border/70 bg-background/85 px-1 py-0.5 opacity-0 shadow-sm backdrop-blur transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
          <Button
            variant="ghost"
            size="icon-xs"
            className="opacity-70 hover:opacity-100"
            onClick={copyText}
            aria-label="Copy"
          >
            <Copy className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="opacity-70 hover:opacity-100"
            onClick={speak}
            aria-label="Speak"
          >
            <Volume2 className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="opacity-70 hover:opacity-100"
            onClick={() => onOpenDetail(message)}
            aria-label="Details"
          >
            <Maximize2 className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="opacity-70 hover:opacity-100"
            onClick={() => onTogglePin(message.id)}
            aria-label={pinned ? "Unpin" : "Pin"}
          >
            {pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="opacity-70 hover:opacity-100"
            onClick={() => onDelete(message.id)}
            aria-label="Delete"
          >
            <X className="size-3" />
          </Button>
        </div>
        {(isTool || (message.displayName && !isUser)) && (
          <div className="mb-1 flex items-center gap-2 pr-28">
            {isTool ? (
              <Badge variant="outline" className="h-5 rounded-md px-1.5 text-[10px] uppercase">
                {isHistoricalTool ? t("aiAssistant.historyTool") : t("aiAssistant.tool")}
              </Badge>
            ) : message.displayName && !isUser ? (
              <div className="text-[11px] font-medium text-muted-foreground">
                {message.displayName}
              </div>
            ) : null}
          </div>
        )}
        <AttachmentList attachments={message.attachments} />
        {shouldWaitForStructuredRender ? (
          <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground" aria-live="polite">
            <span>{t("aiAssistant.waitingStructuredRender")}</span>
            <DotsIndicator />
          </div>
        ) : (
          <>
            {displayText && (
              isErrorReply && !isUser && !isTool
                ? <HighlightedErrorText text={displayText} />
                : isCompletionNotice && !isUser && !isTool
                  ? <HighlightedCompletionText text={displayText} />
                  : <MessageText text={displayText} markdown={!isUser && !isTool} />
            )}
            <StructuredRenderer blocks={blocks} onOpenMedia={onOpenMedia} />
          </>
        )}
        </article>
      </div>
      {isUser && (
        <ChatAvatarFrame
          role="user"
          label={message.displayName}
        />
      )}
    </div>
  );
});

function ComposerWaitingStatus({
  label,
  visible,
  variant = "default",
}: {
  label: string;
  visible: boolean;
  variant?: SuperChatPanelVariant;
}) {
  const { t } = useTranslation();
  const waitingResponseOptions = t("aiAssistant.waitingResponses", { returnObjects: true });
  const randomLabels = Array.isArray(waitingResponseOptions)
    ? waitingResponseOptions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const randomLabelsKey = randomLabels.join("\u0000");
  const [selectedLabel, setSelectedLabel] = useState(label);

  useEffect(() => {
    if (!visible) return;
    const options = randomLabels.length > 0 ? randomLabels : [label];
    setSelectedLabel(options[Math.floor(Math.random() * options.length)] ?? label);
  }, [label, randomLabelsKey, visible]);

  const displayLabel = selectedLabel.replace(/[.。…\s]+$/u, "");
  return (
    <div
      className={cn(
        "flex h-7 w-full items-center gap-2 px-1 text-xs text-foreground/72 transition-opacity duration-150",
        variant === "freezone" && "max-w-none",
        visible ? "opacity-100" : "pointer-events-none opacity-0",
      )}
      aria-live="polite"
      aria-hidden={!visible}
      aria-label={visible ? displayLabel : undefined}
    >
      {visible && <span>{displayLabel}</span>}
      <DotsIndicator label={visible ? displayLabel : undefined} dotClassName="size-1" />
    </div>
  );
}

type TimelineTurn = {
  id: string;
  index: number;
  preview: string;
  timestamp: number;
  hasAttachment: boolean;
  hasImage: boolean;
};

function buildTimelineTurns(messages: ChatMessage[]): TimelineTurn[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message, index) => {
      const attachments = message.attachments ?? [];
      const hasImage = attachments.some((attachment) => attachment.mimeType?.startsWith("image/"));
      const hasAttachment = attachments.length > 0;
      const preview = message.text.trim().slice(0, 60) || (hasImage ? "Image" : hasAttachment ? "File" : "...");
      return {
        id: message.id,
        index,
        preview,
        timestamp: message.timestamp,
        hasAttachment,
        hasImage,
      };
    });
}

function ChatTimeline({
  messages,
  scrollRef,
}: {
  messages: ChatMessage[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const turns = useMemo(() => buildTimelineTurns(messages), [messages]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [hoveredTurn, setHoveredTurn] = useState<{
    index: number;
    top: number;
    right: number;
  } | null>(null);
  const activeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || turns.length < 2) return;

    const handleScroll = () => {
      const containerRect = container.getBoundingClientRect();
      const targetY = containerRect.top + containerRect.height / 3;
      let closest = -1;
      let closestDistance = Infinity;

      for (let index = turns.length - 1; index >= 0; index -= 1) {
        const element = container.querySelector(`[data-turn-id="${CSS.escape(turns[index].id)}"]`);
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        const distance = Math.abs(rect.top - targetY);
        if (distance < closestDistance) {
          closestDistance = distance;
          closest = index;
        }
      }
      setActiveIndex(closest);
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => container.removeEventListener("scroll", handleScroll);
  }, [scrollRef, turns]);

  useEffect(() => {
    activeButtonRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const scrollToTurn = useCallback((turn: TimelineTurn) => {
    const container = scrollRef.current;
    if (!container) return;
    const element = container.querySelector(`[data-turn-id="${CSS.escape(turn.id)}"]`);
    element?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [scrollRef]);

  if (turns.length < 2) return null;

  return (
    <div className="pointer-events-none absolute bottom-4 right-1 top-4 z-20 hidden w-9 select-none lg:flex">
      <div className="pointer-events-auto relative flex h-full w-full justify-center">
        <div className="absolute inset-y-2 left-1/2 w-px -translate-x-1/2 bg-border/70" />
        <div className="flex max-h-full flex-col items-center gap-2 overflow-y-auto px-2 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {turns.map((turn, index) => (
            <div key={turn.id} className="relative">
              <button
                ref={index === activeIndex ? activeButtonRef : null}
                type="button"
                className={cn(
                  "relative z-10 rounded-full border transition-all duration-150",
                  turns.length > 80 ? "size-1.5" : turns.length > 40 ? "size-2" : "size-2.5",
                  index === activeIndex
                    ? "scale-125 border-primary bg-primary"
                    : "border-muted-foreground/40 bg-background hover:border-primary hover:bg-primary/20",
                )}
                onClick={() => scrollToTurn(turn)}
                onMouseEnter={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setHoveredTurn({
                    index,
                    top: rect.top + rect.height / 2,
                    right: window.innerWidth - rect.left + 12,
                  });
                }}
                onMouseLeave={() => setHoveredTurn(null)}
                aria-label={`Turn ${index + 1}: ${turn.preview}`}
              />
            </div>
          ))}
        </div>
      </div>
      {hoveredTurn && turns[hoveredTurn.index] && createPortal(
        <div
          className="pointer-events-none fixed z-[80] -translate-y-1/2"
          style={{ top: hoveredTurn.top, right: hoveredTurn.right }}
        >
          <div className="max-w-[240px] rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg">
            <div className="flex items-center gap-1 font-medium">
              {turns[hoveredTurn.index].hasImage && <Image className="size-3 shrink-0 text-muted-foreground" />}
              {turns[hoveredTurn.index].hasAttachment && !turns[hoveredTurn.index].hasImage && <File className="size-3 shrink-0 text-muted-foreground" />}
              <span className="line-clamp-3 whitespace-normal break-words">{turns[hoveredTurn.index].preview}</span>
            </div>
            <div className="mt-1 text-muted-foreground">
              {new Date(turns[hoveredTurn.index].timestamp).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function AttachmentList({
  attachments,
  align = "start",
}: {
  attachments?: ChatAttachment[];
  align?: "start" | "end";
}) {
  const visibleAttachments = attachments?.filter(shouldRenderAttachmentChip) ?? [];
  if (visibleAttachments.length === 0) return null;

  return (
    <div className={cn("mb-2 flex flex-wrap gap-1.5", align === "end" && "justify-end")}>
      {visibleAttachments.map((attachment) => (
        <AttachmentChip key={attachment.id || attachment.fileName || attachment.content} attachment={attachment} />
      ))}
    </div>
  );
}

function AttachmentChip({ attachment }: { attachment: ChatAttachment }) {
  const isImage = isImageAttachment(attachment);

  return (
    <span className="inline-flex max-w-44 items-center gap-1.5 rounded-md border border-border/70 bg-background/45 px-2 py-1 text-xs">
      {isImage ? <Image className="size-3.5" /> : <File className="size-3.5" />}
      <span className="truncate">{attachment.fileName || attachment.mimeType || "Attachment"}</span>
    </span>
  );
}

function shouldRenderAttachmentChip(attachment: ChatAttachment): boolean {
  if (!isImageAttachment(attachment) && !isVideoAttachment(attachment)) return true;
  return false;
}

function isImageAttachment(attachment: ChatAttachment): boolean {
  return (
    attachment.mimeType?.startsWith("image/")
    || attachment.type === "image"
    || attachment.kind === "image"
    || /\.(avif|gif|jpe?g|png|webp)$/i.test(attachment.fileName ?? "")
  );
}

function isVideoAttachment(attachment: ChatAttachment): boolean {
  return (
    attachment.mimeType?.startsWith("video/")
    || attachment.type === "video"
    || attachment.kind === "video"
    || /\.(m4v|mov|mp4|webm)$/i.test(attachment.fileName ?? "")
  );
}

function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: ApprovalRequest;
  onResolve: (decision: "allow-once" | "allow-always" | "deny") => void;
}) {
  const { t } = useTranslation();
  const remaining = approval.expiresAtMs
    ? Math.max(0, Math.ceil((approval.expiresAtMs - Date.now()) / 1000))
    : null;

  return (
    <div className="border-b border-amber-500/20 bg-amber-500/8 px-3 py-3">
      <div className="mb-2 flex items-start gap-2">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{approval.title}</div>
          {remaining !== null && (
            <div className="text-xs text-muted-foreground">
              {t("aiAssistant.approvalExpires", { seconds: remaining })}
            </div>
          )}
        </div>
        <Badge variant="outline" className="rounded-md uppercase">
          {approval.kind}
        </Badge>
      </div>
      {approval.description && (
        <p className="mb-2 text-xs leading-5 text-muted-foreground">{approval.description}</p>
      )}
      {approval.command && (
        <pre className="max-h-32 overflow-auto rounded-md border border-border/70 bg-background/60 px-2 py-1.5 text-xs whitespace-pre-wrap break-all">
          {approval.command}
        </pre>
      )}
      <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
        {approval.cwd && <div className="truncate">CWD: {approval.cwd}</div>}
        {approval.host && <div className="truncate">Host: {approval.host}</div>}
        {approval.security && <div className="truncate">Security: {approval.security}</div>}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="xs" onClick={() => onResolve("allow-once")}>
          {t("aiAssistant.allowOnce")}
        </Button>
        <Button size="xs" variant="outline" onClick={() => onResolve("allow-always")}>
          {t("aiAssistant.allowAlways")}
        </Button>
        <Button size="xs" variant="destructive" onClick={() => onResolve("deny")}>
          {t("aiAssistant.deny")}
        </Button>
      </div>
    </div>
  );
}

function ControlBar({
  chat,
  compact = false,
  searchOpen,
  onToggleSearch,
}: {
  chat: ReturnType<typeof useSuperChat>;
  compact?: boolean;
  searchOpen: boolean;
  onToggleSearch: () => void;
}) {
  const { t } = useTranslation();
  const hasInstances = chat.relayInstances.length > 0;
  const hasModels = chat.models.length > 0;
  const transportStatus =
    chat.connected
      ? "connected"
      : chat.connecting || chat.busy
        ? "reconnecting"
        : "disconnected";
  const transportLabel =
    transportStatus === "connected"
      ? t("aiAssistant.connected")
      : transportStatus === "reconnecting"
        ? t("aiAssistant.reconnecting")
        : t("aiAssistant.disconnected");
  return (
    <div
      className={cn(
        "flex min-w-0 shrink items-center gap-2",
        !compact && "flex-wrap border-b border-border/65 px-3 py-2",
      )}
    >
      {!compact && (
        <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" title={chat.error || transportLabel}>
          <span>{transportLabel}</span>
          <span>{t("aiAssistant.backendTransport")}</span>
        </div>
      )}
      {hasInstances && (
        <select
          value={chat.selectedInstanceId}
          onChange={(event) => chat.selectRelayInstance(event.target.value)}
          className={cn(
            "h-7 min-w-0 rounded-md border border-border bg-background px-2 text-xs outline-none disabled:opacity-50",
            compact ? "w-28" : "flex-1",
          )}
          title={t("aiAssistant.instance")}
        >
          {chat.relayInstances.map((instance) => (
            <option key={instance.instanceId} value={instance.instanceId}>
              {instance.instanceName || instance.instanceId}{instance.busy ? " *" : ""}
            </option>
          ))}
        </select>
      )}
      {hasModels && (
        <select
          value={chat.activeModel ?? ""}
          onChange={(event) => chat.switchModel(event.target.value)}
          disabled={chat.modelsLoading}
          className={cn(
            "h-7 min-w-0 rounded-md border border-border bg-background px-2 text-xs outline-none disabled:opacity-50",
            compact ? "w-28" : "flex-1",
          )}
          title={t("aiAssistant.model")}
        >
          {chat.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label || model.id}{model.reasoning ? " +" : ""}
            </option>
          ))}
        </select>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onToggleSearch}
        aria-label={t("aiAssistant.search")}
        title={t("aiAssistant.search")}
        className={searchOpen ? "text-primary" : "text-muted-foreground"}
      >
        <Search className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => chat.setSettings({ showToolEvents: !chat.settings.showToolEvents })}
        aria-pressed={chat.settings.showToolEvents}
        aria-label={t("aiAssistant.showToolEvents")}
        title={t("aiAssistant.showToolEvents")}
        className={chat.settings.showToolEvents ? "text-primary" : "text-muted-foreground"}
      >
        <ListTree className="size-4" />
      </Button>
      {!compact && (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => chat.setSettings({
              showStructuredSourceWhileStreaming: !chat.settings.showStructuredSourceWhileStreaming,
            })}
            aria-pressed={chat.settings.showStructuredSourceWhileStreaming}
            aria-label={t("aiAssistant.showStructuredSourceWhileStreaming")}
            title={t("aiAssistant.showStructuredSourceWhileStreaming")}
            className={chat.settings.showStructuredSourceWhileStreaming ? "text-primary" : "text-muted-foreground"}
          >
            <Braces className="size-4" />
          </Button>
        </>
      )}
    </div>
  );
}

function HeaderControlPortal({
  chat,
  searchOpen,
  onToggleSearch,
}: {
  chat: ReturnType<typeof useSuperChat>;
  searchOpen: boolean;
  onToggleSearch: () => void;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setTarget(document.getElementById("superchat-header-controls"));
  }, []);

  if (!target) return null;
  return createPortal(
    <ControlBar
      chat={chat}
      compact
      searchOpen={searchOpen}
      onToggleSearch={onToggleSearch}
    />,
    target,
  );
}

function SearchBar({
  query,
  onChange,
  onClose,
}: {
  query: string;
  onChange: (query: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-2">
      <Search className="size-4 shrink-0 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={query}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
        placeholder={t("aiAssistant.search")}
        className="h-7 border-0 bg-transparent text-sm shadow-none focus-visible:ring-0"
      />
      {query && (
        <Button variant="ghost" size="icon" className="size-6" onClick={() => onChange("")}>
          <X className="size-3" />
        </Button>
      )}
      <Button variant="ghost" size="icon" className="size-6" onClick={onClose}>
        <X className="size-4" />
      </Button>
    </div>
  );
}

function PinnedPanel({
  messages,
  onClear,
  onTogglePin,
}: {
  messages: ChatMessage[];
  onClear: () => void;
  onTogglePin: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (messages.length === 0) return null;

  return (
    <div className="border-b border-border/65 bg-muted/20 px-3 py-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <Pin className="size-3.5" />
          {t("aiAssistant.pinned")}
        </div>
        <Button variant="ghost" size="xs" onClick={onClear}>
          {t("aiAssistant.clearPinned")}
        </Button>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {messages.map((message) => (
          <button
            key={message.id}
            type="button"
            onClick={() => onTogglePin(message.id)}
            className="min-w-44 max-w-56 rounded-md border border-border/70 bg-background/70 px-2 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
          >
            <div className="line-clamp-2">{message.text}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageDetailPanel({
  message,
  onClose,
  onOpenMedia,
}: {
  message: ChatMessage | null;
  onClose: () => void;
  onOpenMedia: (detail: SpecMediaDetail) => void;
}) {
  const { t } = useTranslation();
  if (!message) return null;
  const { displayText, blocks } = extractStructuredBlocks(message);

  return (
    <aside className="hidden h-full w-72 shrink-0 flex-col border-l border-border/65 bg-background xl:flex">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/65 px-3">
        <div className="text-sm font-medium">{t("aiAssistant.messageDetail")}</div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("aiAssistant.closeDetail")}>
          <X className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mb-3 flex items-center gap-2">
          <Badge variant="outline" className="rounded-md uppercase">
            {message.role}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {new Date(message.timestamp).toLocaleString()}
          </span>
        </div>
        {displayText && (
          <pre className="mb-3 whitespace-pre-wrap break-words rounded-md border border-border/70 bg-muted/30 p-2 text-xs leading-5">
            {displayText}
          </pre>
        )}
        <StructuredRenderer blocks={blocks} onOpenMedia={onOpenMedia} />
        {message.raw !== undefined && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-muted-foreground">{t("aiAssistant.raw")}</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words rounded-md border border-border/70 bg-muted/30 p-2 text-[11px] leading-5">
              {JSON.stringify(message.raw, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </aside>
  );
}

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string; isFinal?: boolean }>> }) => void) | null;
  onend: (() => void) | null;
};

function createSpeechRecognition(): SpeechRecognitionLike | null {
  const candidate = (window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  });
  const Ctor = candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

const VIDEO_CREATION_RE =
  /(生成|创建|制作|开始|做|转|剪|出).{0,12}(视频|短剧|短片|成片|影片)|(?:视频|短剧|短片|成片|影片).{0,12}(生成|创建|制作|开始|做|转)|create.{0,16}video|make.{0,16}video|generate.{0,16}video|story.{0,12}video/i;
const UPLOADED_FILES_QUERY_RE =
  /(当前|现在|刚才|我)?\s*(上传|传了|传过|已上传).{0,12}(哪些|什么|列表|文件|剧本|小说)|(?:what|which|list|show).{0,20}uploaded.{0,10}(files?|scripts?)/i;

const NOVEL_ATTACHMENT_EXTENSIONS = new Set([".txt", ".md", ".doc", ".docx"]);
const INLINE_TEXT_ATTACHMENT_EXTENSIONS = new Set([".txt", ".md"]);
const NOVEL_ATTACHMENT_MIME_TYPES = new Set([
  "text/markdown",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const INLINE_TEXT_ATTACHMENT_LIMIT = 120_000;
const UPLOADED_INGEST_FILES_PREFIX = "superchat:ingest-uploads:";

function uploadedIngestFilesKey(project?: string): string | null {
  const id = project?.trim();
  if (!id) return null;
  return `${UPLOADED_INGEST_FILES_PREFIX}${id}`;
}

function isUploadedIngestFile(value: unknown): value is UploadedIngestFile {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.filename === "string" &&
    typeof record.size === "number" &&
    typeof record.uploadedAt === "number"
  );
}

function loadUploadedIngestFiles(project?: string): UploadedIngestFile[] {
  const key = uploadedIngestFilesKey(project);
  if (!key) return [];
  try {
    const raw = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(raw) ? raw.filter(isUploadedIngestFile).slice(-20) : [];
  } catch {
    return [];
  }
}

function saveUploadedIngestFiles(project: string | undefined, files: UploadedIngestFile[]) {
  const key = uploadedIngestFilesKey(project);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(files.slice(-20)));
  } catch {
    // best-effort chat context
  }
}

function mergeUploadedIngestFiles(
  current: UploadedIngestFile[],
  additions: UploadedIngestFile[],
): UploadedIngestFile[] {
  if (additions.length === 0) return current;
  const byFilename = new Map<string, UploadedIngestFile>();
  for (const item of current) byFilename.set(item.filename, item);
  for (const item of additions) byFilename.set(item.filename, item);
  return [...byFilename.values()]
    .sort((left, right) => left.uploadedAt - right.uploadedAt)
    .slice(-20);
}

function extensionOf(filename?: string): string {
  const name = filename?.trim().toLowerCase() ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot) : "";
}

function isNovelAttachment(attachment: ChatAttachment): boolean {
  return NOVEL_ATTACHMENT_EXTENSIONS.has(extensionOf(attachment.fileName));
}

function isAllowedScriptUpload(file: File): boolean {
  return NOVEL_ATTACHMENT_EXTENSIONS.has(extensionOf(file.name));
}

function isAllowedScriptDragItem(item: { name?: string; type?: string }): boolean {
  const extension = extensionOf(item.name);
  if (extension) return NOVEL_ATTACHMENT_EXTENSIONS.has(extension);
  const type = item.type?.trim().toLowerCase() ?? "";
  if (!type) return true;
  return NOVEL_ATTACHMENT_MIME_TYPES.has(type);
}

function isInlineTextAttachment(attachment: ChatAttachment): boolean {
  return INLINE_TEXT_ATTACHMENT_EXTENSIONS.has(extensionOf(attachment.fileName));
}

function shouldReportUploadedFiles(text: string): boolean {
  return UPLOADED_FILES_QUERY_RE.test(text);
}

function isOverwriteChoice(text: string): boolean {
  return /^覆盖[。.!！?？\s]*$/.test(text.trim());
}

function isFinalOverwriteConfirmation(text: string): boolean {
  return /^(确定|继续)[。.!！?？\s]*$/.test(text.trim());
}

function uploadedFileFromPrepared(item: PreparedIngestAttachment): UploadedIngestFile | null {
  if (!item.upload) return null;
  return {
    filename: item.upload.filename,
    originalName: item.original.fileName,
    size: item.upload.size,
    totalChars: item.upload.total_chars,
    chapterCount: item.upload.count,
    uploadedAt: Date.now(),
  };
}

function buildUploadedFilesContext(project: string | undefined, files: UploadedIngestFile[]): string {
  const lines = [
    "[DRAMACLAW_UPLOADED_FILES]",
    "If the user asks what files are currently uploaded, answer directly from this list. These files have already been uploaded to the current SuperTale_N project ingest directory.",
    project ? `dramaclaw_project_id: ${project}` : null,
  ].filter((line): line is string => line !== null);

  if (files.length === 0) {
    lines.push("no_uploaded_files: true");
  } else {
    files.forEach((file, index) => {
      lines.push("");
      lines.push(`file_${index + 1}_filename: ${file.filename}`);
      if (file.originalName && file.originalName !== file.filename) {
        lines.push(`file_${index + 1}_original_name: ${file.originalName}`);
      }
      lines.push(`file_${index + 1}_size_bytes: ${file.size}`);
      if (typeof file.totalChars === "number") {
        lines.push(`file_${index + 1}_total_chars: ${file.totalChars}`);
      }
      if (typeof file.chapterCount === "number") {
        lines.push(`file_${index + 1}_chapter_count: ${file.chapterCount}`);
      }
    });
  }

  lines.push("[/DRAMACLAW_UPLOADED_FILES]");
  return lines.join("\n");
}

function buildReingestConfirmationContext(
  pending: ReingestConfirmation,
): string {
  return [
    "[DRAMACLAW_REINGEST_CONFIRMATION]",
    `stage: ${pending.stage}`,
    `dramaclaw_project_id: ${pending.project}`,
    `filename: ${pending.filename}`,
    pending.stage === "choose_overwrite"
      ? "The current project has already ingested a script. Do not call ingest/start yet. Tell the user the current project is not empty and ask only whether they want to overwrite this project. Do not recommend creating a new project, and do not offer to create another project from the current project flow."
      : "The user chose overwrite. Do not call ingest/start yet. Ask the second confirmation and warn that overwrite/rebuild will clear existing characters, episodes, scripts, sketches, audio, videos, and other pipeline outputs. Only an exact user reply of 确定 or 继续 may proceed.",
    "[/DRAMACLAW_REINGEST_CONFIRMATION]",
  ].join("\n");
}

function buildReingestCancelledContext(pending: ReingestConfirmation): string {
  return [
    "[DRAMACLAW_REINGEST_CANCELLED]",
    `stage: ${pending.stage}`,
    `dramaclaw_project_id: ${pending.project}`,
    `filename: ${pending.filename}`,
    "The overwrite/re-ingest flow was cancelled or not explicitly confirmed. Do not call any write API. Briefly tell the user no overwrite was performed.",
    "[/DRAMACLAW_REINGEST_CANCELLED]",
  ].join("\n");
}

function dataUrlToAttachmentBlob(attachment: ChatAttachment): AttachmentBlob | null {
  const content = attachment.content;
  if (!content?.startsWith("data:")) return null;
  const comma = content.indexOf(",");
  if (comma < 0) return null;
  const meta = content.slice(0, comma);
  const base64 = content.slice(comma + 1);
  const mime = attachment.mimeType || /data:([^;]+)/.exec(meta)?.[1] || "application/octet-stream";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return {
    blob: new Blob([bytes], { type: mime }),
    filename: attachment.fileName || "novel.txt",
  };
}

function dataUrlToText(attachment: ChatAttachment): string | null {
  const content = attachment.content;
  if (!content?.startsWith("data:")) return null;
  const comma = content.indexOf(",");
  if (comma < 0) return null;
  const meta = content.slice(0, comma);
  const payload = content.slice(comma + 1);
  try {
    if (!/;base64/i.test(meta)) {
      return decodeURIComponent(payload);
    }
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

async function uploadNovelForIngest(
  project: string,
  file: AttachmentBlob,
): Promise<IngestUploadResult> {
  const formData = new FormData();
  formData.append("file", file.blob, file.filename);
  const response = await jsonWithBackendError<OkResponse<IngestUploadResult> | ErrorResponse>(
    api.post(p`api/v1/projects/${project}/ingest/upload`, { body: formData }),
  );
  if (!response.ok) {
    const fc = (response as ErrorResponse & { format_check?: FormatCheck }).format_check;
    throw new Error(fc?.summary || response.error);
  }
  return response.data;
}

// Surface non-blocking format warnings as a success+risk toast per file. Upload
// already succeeded for these (warning never blocks), so we only notify and let
// the user open the details dialog. Iterate every prepared file, not just the first.
function surfaceFormatCheckWarnings(
  prepared: PreparedIngestAttachment[],
  t: TFunction,
  onViewDetails: (fc: FormatCheck, filename: string) => void,
): void {
  for (const item of prepared) {
    const fc = item.upload?.format_check;
    if (!fc || fc.level !== "warning") continue;
    const filename = item.upload?.filename || item.original.fileName || "";
    toast.warning(fc.summary, {
      action: {
        label: t("aiAssistant.formatCheck.viewDetails"),
        onClick: () => onViewDetails(fc, filename),
      },
    });
  }
}

async function uploadAttachmentsForIngest(
  project: string,
  attachments: ChatAttachment[],
  t: TFunction,
): Promise<PreparedIngestAttachment[]> {
  const prepared: PreparedIngestAttachment[] = [];

  for (const attachment of attachments) {
    const file = isNovelAttachment(attachment)
      ? dataUrlToAttachmentBlob(attachment)
      : null;

    if (!file) {
      prepared.push({ attachment, original: attachment });
      continue;
    }

    try {
      toast.info(t("aiAssistant.attachmentAnalysisUploading", { filename: file.filename }));
      const upload = await uploadNovelForIngest(project, file);
      const { content: _content, path: _path, url: _url, ...attachmentMetadata } = attachment;
      prepared.push({
        upload,
        original: attachment,
        attachment: {
          ...attachmentMetadata,
          fileName: upload.filename,
          fileSize: upload.size,
        },
      });
    } catch (error) {
      const message = backendErrorToastMessage(error, t);
      const { content: _content, ...attachmentMetadata } = attachment;
      prepared.push({
        original: attachment,
        attachment: attachmentMetadata,
        error: message,
      });
    }
  }

  return prepared;
}

async function startNovelIngest(
  project: string,
  filename: string,
  options: { rebuild?: boolean } = {},
): Promise<TaskResponse> {
  const response = await jsonWithBackendError<TaskResponse | ErrorResponse>(
    api.post(p`api/v1/projects/${project}/ingest/start`, {
      json: {
        filename,
        rebuild: options.rebuild ?? false,
      },
    }),
  );
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response;
}

async function projectHasIngestedContent(project: string): Promise<boolean> {
  const response = await api
    .get(p`api/v1/projects/${project}/pipeline/status`)
    .json<
      | OkResponse<{ global?: { ingested?: boolean } }>
      | ErrorResponse
    >();
  if (!response.ok) {
    throw new Error(response.error);
  }
  return Boolean(response.data.global?.ingested);
}

async function buildAttachmentAnalysisContext(
  project: string | undefined,
  preparedAttachments: PreparedIngestAttachment[],
): Promise<string> {
  const lines = [
    "[DRAMACLAW_ATTACHMENT_CONTEXT]",
    "The user attached file(s). No explicit video-generation instruction was detected, so do not start the DramaClaw/SuperTale video pipeline unless the user asks for it later. Analyze the attached text when available, and ask a focused follow-up if the intent is ambiguous.",
  ];

  for (const prepared of preparedAttachments) {
    const attachment = prepared.attachment;
    const originalAttachment = prepared.original;
    const filename = attachment.fileName || "attachment";
    const ext = extensionOf(filename);
    lines.push("");
    lines.push(`file: ${filename}`);
    lines.push(`mime_type: ${attachment.mimeType || "application/octet-stream"}`);
    if (typeof attachment.fileSize === "number") {
      lines.push(`size_bytes: ${attachment.fileSize}`);
    }

    if (project && isNovelAttachment(originalAttachment)) {
      if (prepared.upload) {
        lines.push(`dramaclaw_upload_filename: ${prepared.upload.filename}`);
        lines.push(`dramaclaw_project_id: ${project}`);
        lines.push("dramaclaw_upload_target: supertale_ingest");
        if (typeof prepared.upload.total_chars === "number") {
          lines.push(`dramaclaw_total_chars: ${prepared.upload.total_chars}`);
        }
        if (typeof prepared.upload.count === "number") {
          lines.push(`dramaclaw_chapter_count: ${prepared.upload.count}`);
        }
      } else if (prepared.error) {
        lines.push(`dramaclaw_upload_error: ${prepared.error}`);
      }
    }

    if (isInlineTextAttachment(originalAttachment)) {
      const text = dataUrlToText(originalAttachment);
      if (text) {
        const truncated = text.length > INLINE_TEXT_ATTACHMENT_LIMIT;
        lines.push(`text_content${truncated ? "_truncated" : ""}:`);
        lines.push("```text");
        lines.push(text.slice(0, INLINE_TEXT_ATTACHMENT_LIMIT));
        lines.push("```");
        if (truncated) {
          lines.push(`truncated_after_chars: ${INLINE_TEXT_ATTACHMENT_LIMIT}`);
        }
      } else if (ext) {
        lines.push(`text_decode_error: unable to decode ${ext} attachment in the browser`);
      }
    } else if (isNovelAttachment(attachment)) {
      lines.push("text_content_unavailable: this attachment type cannot be decoded in the browser without starting the video ingest flow");
    }
  }

  lines.push("[/DRAMACLAW_ATTACHMENT_CONTEXT]");
  return lines.join("\n");
}

function appendIngestAutomationContext(
  text: string,
  result: IngestAutomationResult,
): string {
  return [
    text,
    "",
    "[DRAMACLAW_INGEST_AUTOMATION]",
    `novel_filename: ${result.filename}`,
    result.rebuild ? "rebuild: true" : "rebuild: false",
    result.taskType ? `task_type: ${result.taskType}` : null,
    result.taskKey ? `task_key: ${result.taskKey}` : null,
    result.message ? `message: ${result.message}` : null,
    "The uploaded novel has already been submitted to the project ingest API. Continue the DramaClaw/SuperTale video creation workflow from this task instead of asking the user to upload a novel again.",
    "[/DRAMACLAW_INGEST_AUTOMATION]",
  ].filter((line): line is string => line !== null).join("\n");
}

function appendAttachmentAnalysisContext(text: string, context: string): string {
  return [text, "", context].join("\n");
}

type SuperChatPanelVariant = "default" | "freezone";

interface SuperChatPanelProps {
  variant?: SuperChatPanelVariant;
  onRequestClose?: () => void;
}

export function SuperChatPanel({
  variant = "default",
  onRequestClose,
}: SuperChatPanelProps = {}) {
  const { t } = useTranslation();
  const params = useParams({ strict: false }) as { project?: string };
  const username = useAuthStore((s) => s.username);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [detailMessage, setDetailMessage] = useState<ChatMessage | null>(null);
  const [mediaDetail, setMediaDetail] = useState<SpecMediaDetail | null>(null);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploadedIngestFiles, setUploadedIngestFiles] = useState<UploadedIngestFile[]>(() =>
    loadUploadedIngestFiles(params.project?.trim()),
  );
  const [reingestConfirmation, setReingestConfirmation] =
    useState<ReingestConfirmation | null>(null);
  const [formatCheckDetails, setFormatCheckDetails] = useState<{
    formatCheck: FormatCheck;
    filename: string;
  } | null>(null);
  const [queuedMessages, setQueuedMessages] = useState<QueuedSendItem[]>([]);
  const [selectedQueuedMessageId, setSelectedQueuedMessageId] = useState<string | null>(null);
  const [selectedHistoryMessageIndex, setSelectedHistoryMessageIndex] = useState<number | null>(null);
  const [preparingSend, setPreparingSend] = useState(false);
  const [recording, setRecording] = useState(false);
  const [dragFileState, setDragFileState] = useState<"valid" | "invalid" | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const draftInputRef = useRef<HTMLTextAreaElement | null>(null);
  const restoreDraftFocusRef = useRef(false);
  const dragDepthRef = useRef(0);
  const speechRef = useRef<SpeechRecognitionLike | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const historyScrollKeyRef = useRef<string | null>(null);
  const composerShellRef = useRef<HTMLDivElement | null>(null);
  const composerBeamRef = useRef<BorderBeamController | null>(null);
  const notifiedTaskKeysRef = useRef<Set<string>>(new Set());
  const taskEventBus = useEventBus();
  const chat = useSuperChat({
    project: params.project,
    displayName: username || "SuperTale",
  });
  const isChatInitializing = !chat.historyReady && chat.messages.length === 0 && (chat.connecting || chat.connected);

  const hasSendableContent = draft.trim().length > 0 || attachments.length > 0;
  const canSend = hasSendableContent && chat.connected && !preparingSend;
  const composerWaiting = chat.busy && (!hasSendableContent || !chat.connected || preparingSend);
  const activeMessages = useMemo(
    () =>
      chat.messages.filter(
        (message) => !chat.deletedIds.has(message.id) && (chat.settings.showToolEvents || !isToolMessage(message)),
      ),
    [chat.deletedIds, chat.messages, chat.settings.showToolEvents],
  );
  const userMessageHistory = useMemo(
    () =>
      activeMessages
        .filter((message) => message.role === "user" && message.text.trim().length > 0)
        .map((message) => message.text),
    [activeMessages],
  );
  const pinnedMessages = useMemo(
    () => activeMessages.filter((message) => chat.pinnedIds.has(message.id)),
    [activeMessages, chat.pinnedIds],
  );

  useEffect(() => {
    const project = params.project?.trim();
    if (!project) return;
    return taskEventBus.on("*", (event) => {
      if (event.type !== "task_complete" && event.type !== "task_failed") return;
      const taskProject = (event.task.project_id ?? event.task.project).trim();
      if (taskProject !== project) return;

      const dedupeKey = `${event.type}:${event.task.task_key || event.task.task_id}`;
      if (notifiedTaskKeysRef.current.has(dedupeKey)) return;
      notifiedTaskKeysRef.current.add(dedupeKey);

      const label = buildChatTaskLabel(event.task, t);
      const text =
        event.type === "task_complete"
          ? `✅ ${label}已完成。你可以让我查看结果，或继续下一步。`
          : `${label}失败：${event.task.error || event.task.current_task || "未提供具体错误原因"}\n请根据错误处理前置条件后再继续。`;
      void chat.appendNotification(text);
    });
  }, [chat.appendNotification, params.project, t, taskEventBus]);

  const searchQuery = search.trim().toLowerCase();
  const visibleMessages = useMemo(
    () =>
      searchQuery
        ? activeMessages.filter((message) => message.text.toLowerCase().includes(searchQuery))
        : activeMessages,
    [activeMessages, searchQuery],
  );
  const activeMessageCount = activeMessages.length;
  const lastActiveMessageId = activeMessages[activeMessages.length - 1]?.id ?? "";
  const deferStructuredRender =
    chat.busy && !chat.settings.showStructuredSourceWhileStreaming;
  const streamTextAlreadyRendered =
    Boolean(chat.streamText)
    && visibleMessages.some(
      (message) => message.role === "assistant" && message.text === chat.streamText,
    );
  const lastConversationalMessage = [...activeMessages]
    .reverse()
    .find((message) => message.role === "user" || message.role === "assistant");
  const lastUserMessage = [...activeMessages]
    .reverse()
    .find((message) => message.role === "user" && message.text.trim().length > 0);
  const activeTurnUserMessage = chat.activeTurnId
    ? activeMessages.find(
      (message) =>
        message.role === "user"
        && message.turnId === chat.activeTurnId
        && message.text.trim().length > 0,
    )
    : null;
  const activeTurnHasAssistantReply = Boolean(
    chat.activeTurnId
    && activeMessages.some(
      (message) =>
        message.role === "assistant"
        && message.turnId === chat.activeTurnId
        && message.text.trim().length > 0,
    ),
  );
  const lastUserHasAssistantReply = Boolean(
    lastUserMessage?.turnId
    && activeMessages.some(
      (message) =>
        message.role === "assistant"
        && message.turnId === lastUserMessage.turnId
        && message.text.trim().length > 0,
    ),
  );
  const currentStreamingAssistantId =
    deferStructuredRender && lastConversationalMessage?.role === "assistant"
      ? lastConversationalMessage.id
      : null;
  const isCurrentStreamingAssistantMessage = (message: ChatMessage): boolean =>
    message.role === "assistant" && message.id === currentStreamingAssistantId;
  const isStreamingAssistantMessage = (message: ChatMessage): boolean =>
    chat.busy
    && message.role === "assistant"
    && (
      message.id === currentStreamingAssistantId
      || (lastConversationalMessage?.role === "assistant" && message.id === lastConversationalMessage.id)
    );
  const showWaitingIndicator =
    chat.busy
    && !chat.streamText.trim()
    && (
      composerWaiting
      || (
        activeTurnUserMessage
          ? !activeTurnHasAssistantReply
          : (!lastUserMessage || !lastUserHasAssistantReply)
      )
    );
  const scrollToChatBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    const top = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTo({ top, behavior });
    shouldStickToBottomRef.current = true;
    setShowScrollToBottom(false);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const updateStickiness = () => {
      const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      shouldStickToBottomRef.current = distanceToBottom < 96;
      setShowScrollToBottom(distanceToBottom > 180);
    };
    updateStickiness();
    el.addEventListener("scroll", updateStickiness, { passive: true });
    return () => el.removeEventListener("scroll", updateStickiness);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (shouldStickToBottomRef.current || chat.busy) {
        scrollToChatBottom();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [chat.busy, chat.messages, chat.streamText, showWaitingIndicator, scrollToChatBottom]);

  useEffect(() => {
    const list = messageListRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!shouldStickToBottomRef.current && !chat.busy) return;
      window.requestAnimationFrame(() => scrollToChatBottom());
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [chat.busy, scrollToChatBottom]);

  useEffect(() => {
    if (!chat.historyReady) return;
    const scrollKey = `${params.project ?? ""}:${activeMessageCount}:${lastActiveMessageId}`;
    if (historyScrollKeyRef.current === scrollKey) return;
    historyScrollKeyRef.current = scrollKey;
    shouldStickToBottomRef.current = true;
    let secondFrame = 0;
    const firstTimeout = window.setTimeout(scrollToChatBottom, 120);
    const secondTimeout = window.setTimeout(scrollToChatBottom, 360);
    const thirdTimeout = window.setTimeout(scrollToChatBottom, 800);
    const firstFrame = window.requestAnimationFrame(() => {
      scrollToChatBottom();
      secondFrame = window.requestAnimationFrame(() => scrollToChatBottom());
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
      window.clearTimeout(firstTimeout);
      window.clearTimeout(secondTimeout);
      window.clearTimeout(thirdTimeout);
    };
  }, [activeMessageCount, chat.historyReady, lastActiveMessageId, params.project, scrollToChatBottom]);

  useEffect(() => {
    setQueuedMessages([]);
    setSelectedQueuedMessageId(null);
    setSelectedHistoryMessageIndex(null);
    setUploadedIngestFiles(loadUploadedIngestFiles(params.project?.trim()));
    setReingestConfirmation(null);
  }, [params.project]);

  const recordUploadedFiles = useCallback(
    (project: string | undefined, prepared: PreparedIngestAttachment[]): UploadedIngestFile[] => {
      const additions = prepared
        .map(uploadedFileFromPrepared)
        .filter((item): item is UploadedIngestFile => Boolean(item));
      if (additions.length === 0) return uploadedIngestFiles;

      const next = mergeUploadedIngestFiles(uploadedIngestFiles, additions);
      setUploadedIngestFiles(next);
      saveUploadedIngestFiles(project, next);
      return next;
    },
    [uploadedIngestFiles],
  );

  const sendWithIngestAutomation = useCallback(
    async (text: string, messageAttachments: ChatAttachment[]): Promise<boolean> => {
      let nextText = text;
      let transportAttachments = messageAttachments;
      let contextUploadedFiles = uploadedIngestFiles;
      const project = params.project?.trim();
      const videoIntent = VIDEO_CREATION_RE.test(text);
      const hasNovelAttachments = messageAttachments.some(isNovelAttachment);

      if (reingestConfirmation) {
        if (reingestConfirmation.stage === "choose_overwrite") {
          if (!isOverwriteChoice(text)) {
            const pending = reingestConfirmation;
            setReingestConfirmation(null);
            return chat.send(
              text,
              [],
              appendAttachmentAnalysisContext(text, buildReingestCancelledContext(pending)),
            );
          }

          const nextPending = {
            ...reingestConfirmation,
            stage: "confirm_clear" as const,
          };
          setReingestConfirmation(nextPending);
          return chat.send(
            text,
            [],
            appendAttachmentAnalysisContext(text, buildReingestConfirmationContext(nextPending)),
          );
        }

        if (!isFinalOverwriteConfirmation(text)) {
          const pending = reingestConfirmation;
          setReingestConfirmation(null);
          return chat.send(
            text,
            [],
            appendAttachmentAnalysisContext(text, buildReingestCancelledContext(pending)),
          );
        }

        setPreparingSend(true);
        try {
          const started = await startNovelIngest(
            reingestConfirmation.project,
            reingestConfirmation.filename,
            { rebuild: true },
          );
          nextText = appendIngestAutomationContext(text, {
            filename: reingestConfirmation.filename,
            taskType: started.task_type,
            taskKey: started.task_key,
            message: started.message,
            rebuild: true,
          });
          toast.success(t("aiAssistant.ingestAutomationStarted", { filename: reingestConfirmation.filename }));
          setReingestConfirmation(null);
          return chat.send(text, [], nextText);
        } catch (error) {
          const message = backendErrorToastMessage(error, t);
          toast.error(t("aiAssistant.ingestAutomationFailed", { message }));
          return false;
        } finally {
          setPreparingSend(false);
        }
      }

      if (videoIntent && hasNovelAttachments) {
        const project = params.project?.trim();
        if (!project) {
          toast.error(t("aiAssistant.ingestAutomationNoProject"));
          return false;
        }

        setPreparingSend(true);
        try {
          const prepared = await uploadAttachmentsForIngest(project, messageAttachments, t);
          surfaceFormatCheckWarnings(prepared, t, (formatCheck, filename) =>
            setFormatCheckDetails({ formatCheck, filename }),
          );
          transportAttachments = prepared.map((item) => item.attachment);
          contextUploadedFiles = recordUploadedFiles(project, prepared);
          const uploaded = prepared.find((item) => item.upload)?.upload;
          if (!uploaded) {
            const error = prepared.find((item) => item.error)?.error;
            throw new Error(error || t("aiAssistant.ingestAutomationMissingFile"));
          }
          if (await projectHasIngestedContent(project)) {
            const pending: ReingestConfirmation = {
              stage: "choose_overwrite",
              filename: uploaded.filename,
              project,
              originalText: text,
            };
            setReingestConfirmation(pending);
            nextText = appendAttachmentAnalysisContext(
              text,
              buildReingestConfirmationContext(pending),
            );
            return chat.send(text, transportAttachments, nextText);
          }
          const started = await startNovelIngest(project, uploaded.filename);
          nextText = appendIngestAutomationContext(text, {
            filename: uploaded.filename,
            taskType: started.task_type,
            taskKey: started.task_key,
            message: started.message,
            rebuild: false,
          });
          toast.success(t("aiAssistant.ingestAutomationStarted", { filename: uploaded.filename }));
        } catch (error) {
          const message = backendErrorToastMessage(error, t);
          toast.error(t("aiAssistant.ingestAutomationFailed", { message }));
          return false;
        } finally {
          setPreparingSend(false);
        }
      } else if (videoIntent && !hasNovelAttachments && uploadedIngestFiles.length > 0) {
        if (!project) {
          toast.error(t("aiAssistant.ingestAutomationNoProject"));
          return false;
        }

        setPreparingSend(true);
        try {
          const uploaded = uploadedIngestFiles[uploadedIngestFiles.length - 1];
          if (await projectHasIngestedContent(project)) {
            const pending: ReingestConfirmation = {
              stage: "choose_overwrite",
              filename: uploaded.filename,
              project,
              originalText: text,
            };
            setReingestConfirmation(pending);
            nextText = appendAttachmentAnalysisContext(
              text,
              buildReingestConfirmationContext(pending),
            );
            return chat.send(text, [], nextText);
          }
          const started = await startNovelIngest(project, uploaded.filename);
          nextText = appendIngestAutomationContext(text, {
            filename: uploaded.filename,
            taskType: started.task_type,
            taskKey: started.task_key,
            message: started.message,
            rebuild: false,
          });
          toast.success(t("aiAssistant.ingestAutomationStarted", { filename: uploaded.filename }));
        } catch (error) {
          const message = backendErrorToastMessage(error, t);
          toast.error(t("aiAssistant.ingestAutomationFailed", { message }));
          return false;
        } finally {
          setPreparingSend(false);
        }
      } else if (messageAttachments.length > 0) {
        setPreparingSend(true);
        try {
          const prepared = project
            ? await uploadAttachmentsForIngest(project, messageAttachments, t)
            : messageAttachments.map((attachment) => ({ attachment, original: attachment }));
          surfaceFormatCheckWarnings(prepared, t, (formatCheck, filename) =>
            setFormatCheckDetails({ formatCheck, filename }),
          );
          transportAttachments = prepared.map((item) => item.attachment);
          contextUploadedFiles = recordUploadedFiles(project, prepared);
          const context = await buildAttachmentAnalysisContext(
            project,
            prepared,
          );
          nextText = appendAttachmentAnalysisContext(text, context);
        } finally {
          setPreparingSend(false);
        }
      }

      if (shouldReportUploadedFiles(text)) {
        nextText = appendAttachmentAnalysisContext(
          nextText,
          buildUploadedFilesContext(project, contextUploadedFiles),
        );
      }

      return chat.send(text, transportAttachments, nextText);
    },
    [chat, params.project, recordUploadedFiles, reingestConfirmation, t, uploadedIngestFiles],
  );

  useEffect(() => {
    const shell = composerShellRef.current;
    if (!shell) return;
    const beam = attachBorderBeam(shell, {
      size: "md",
      colorVariant: "colorful",
      theme: "dark",
      active: false,
      borderRadius: 16,
      strength: 0.9,
      duration: 1.96,
    });
    composerBeamRef.current = beam;
    return () => {
      composerBeamRef.current = null;
      beam.destroy();
    };
  }, []);

  useEffect(() => {
    if (chat.busy || !chat.connected || preparingSend || queuedMessages.length === 0) return;
    const selectedIndex = selectedQueuedMessageId
      ? queuedMessages.findIndex((message) => message.id === selectedQueuedMessageId)
      : -1;
    const nextIndex = selectedIndex >= 0 ? selectedIndex : 0;
    const nextMessage = queuedMessages[nextIndex];
    const remainingMessages = queuedMessages.filter((_, index) => index !== nextIndex);
    void sendWithIngestAutomation(nextMessage.text, nextMessage.attachments).then((sent) => {
      if (!sent) return;
      setQueuedMessages(remainingMessages);
      setSelectedQueuedMessageId(remainingMessages[0]?.id ?? null);
    });
  }, [
    chat.busy,
    chat.connected,
    preparingSend,
    queuedMessages,
    selectedQueuedMessageId,
    sendWithIngestAutomation,
  ]);

  useEffect(() => {
    if (queuedMessages.length === 0) {
      if (selectedQueuedMessageId) setSelectedQueuedMessageId(null);
      return;
    }
    if (selectedQueuedMessageId && queuedMessages.some((message) => message.id === selectedQueuedMessageId)) return;
    setSelectedQueuedMessageId(queuedMessages[0].id);
  }, [queuedMessages, selectedQueuedMessageId]);

  useLayoutEffect(() => {
    if (!restoreDraftFocusRef.current) return;
    restoreDraftFocusRef.current = false;
    const textarea = draftInputRef.current;
    if (!textarea || textarea.disabled) return;
    if (document.activeElement === textarea) return;
    textarea.focus({ preventScroll: true });
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
  }, [draft]);

  const submit = () => {
    const hasCurrentContent = draft.trim().length > 0 || attachments.length > 0;
    if (!hasCurrentContent || preparingSend) return;
    if (!chat.connected) {
      toast.error(t("aiAssistant.waiting"));
      return;
    }
    setSelectedHistoryMessageIndex(null);
    const text = draft.trim() || t("aiAssistant.attachmentOnlyPrompt");
    const queuedAttachments = attachments.map((attachment) => ({ ...attachment }));
    if (chat.busy) {
      setQueuedMessages((current) => [
        ...current,
        {
          id: `queue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text,
          attachments: queuedAttachments,
          createdAt: Date.now(),
        },
      ]);
      setDraft("");
      setAttachments([]);
      return;
    }
    void sendWithIngestAutomation(text, queuedAttachments).then((sent) => {
      if (!sent) return;
      setDraft("");
      setAttachments([]);
    });
  };

  const handleComposerKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (
      target &&
      target !== draftInputRef.current &&
      (target.tagName === "BUTTON" || target.tagName === "INPUT" || target.getAttribute("role") === "button")
    ) {
      return;
    }
    event.preventDefault();
    submit();
  };

  const selectQueuedMessageByOffset = (offset: number) => {
    if (queuedMessages.length === 0) return;
    setSelectedQueuedMessageId((current) => {
      const currentIndex = current
        ? queuedMessages.findIndex((message) => message.id === current)
        : -1;
      const baseIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex = (baseIndex + offset + queuedMessages.length) % queuedMessages.length;
      return queuedMessages[nextIndex].id;
    });
  };

  const selectHistoryMessage = (direction: "older" | "newer") => {
    if (userMessageHistory.length === 0) return false;
    if (direction === "older") {
      const nextIndex =
        selectedHistoryMessageIndex === null
          ? userMessageHistory.length - 1
          : Math.max(0, selectedHistoryMessageIndex - 1);
      setSelectedHistoryMessageIndex(nextIndex);
      setDraft(userMessageHistory[nextIndex]);
      restoreDraftFocusRef.current = true;
      return true;
    }
    if (selectedHistoryMessageIndex === null) return false;
    if (selectedHistoryMessageIndex >= userMessageHistory.length - 1) {
      setSelectedHistoryMessageIndex(null);
      setDraft("");
      restoreDraftFocusRef.current = true;
      return true;
    }
    const nextIndex = selectedHistoryMessageIndex + 1;
    setSelectedHistoryMessageIndex(nextIndex);
    setDraft(userMessageHistory[nextIndex]);
    restoreDraftFocusRef.current = true;
    return true;
  };

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach((file) => {
      if (!isAllowedScriptUpload(file)) return;
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        const dataUrl = String(reader.result || "");
        setAttachments((current) => [
          ...current,
          {
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type: file.type.startsWith("image/") ? "image" : "file",
            mimeType: file.type || "application/octet-stream",
            fileName: file.name,
            fileSize: file.size,
            content: dataUrl,
          },
        ]);
      });
      reader.readAsDataURL(file);
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
    window.requestAnimationFrame(() => {
      draftInputRef.current?.focus({ preventScroll: true });
    });
  };

  const eventHasFiles = (event: ReactDragEvent<HTMLElement>): boolean =>
    Array.from(event.dataTransfer.types).includes("Files");

  const resolveDragFileState = (event: ReactDragEvent<HTMLElement>): "valid" | "invalid" => {
    const items = Array.from(event.dataTransfer.items).filter((item) => item.kind === "file");
    if (items.length === 0) return "valid";
    return items.every((item) => {
      const file = item.getAsFile();
      if (file) return isAllowedScriptDragItem(file);
      return isAllowedScriptDragItem({ type: item.type });
    })
      ? "valid"
      : "invalid";
  };

  const handleComposerDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!ENABLE_SUPERCHAT_FILE_UPLOAD) return;
    if (!eventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    setDragFileState(resolveDragFileState(event));
  };

  const handleComposerDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!ENABLE_SUPERCHAT_FILE_UPLOAD) return;
    if (!eventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const nextState = resolveDragFileState(event);
    setDragFileState(nextState);
    event.dataTransfer.dropEffect = nextState === "valid" ? "copy" : "none";
  };

  const handleComposerDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!ENABLE_SUPERCHAT_FILE_UPLOAD) return;
    if (!eventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragFileState(null);
  };

  const handleComposerDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!ENABLE_SUPERCHAT_FILE_UPLOAD) return;
    if (!eventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setDragFileState(null);
    addFiles(event.dataTransfer.files);
  };

  const toggleSpeech = () => {
    if (recording) {
      speechRef.current?.stop();
      setRecording(false);
      return;
    }
    const recognition = createSpeechRecognition();
    if (!recognition) return;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "zh-CN";
    recognition.onresult = (event) => {
      let text = "";
      for (let i = 0; i < event.results.length; i += 1) {
        text += event.results[i][0]?.transcript ?? "";
      }
      setDraft(text);
    };
    recognition.onend = () => setRecording(false);
    speechRef.current = recognition;
    setRecording(true);
    recognition.start();
  };

  const isFreezoneLayout = variant === "freezone";

  return (
    <div className={cn("relative flex h-full min-h-0 overflow-hidden bg-background", isFreezoneLayout && "bg-transparent")}>
      {!isFreezoneLayout && (
        <HeaderControlPortal
          chat={chat}
          searchOpen={searchOpen}
          onToggleSearch={() => setSearchOpen((value) => !value)}
        />
      )}
      <section className="relative z-10 flex min-w-0 flex-1 flex-col">
        {isFreezoneLayout && (
          <div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-white/[0.06] bg-black/[0.16] px-3 py-1 backdrop-blur-xl">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div className="truncate text-sm font-medium text-foreground">
                {t("freezone.chat.title")}
              </div>
              <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    chat.connected ? "bg-emerald-400" : chat.connecting ? "bg-amber-300" : "bg-muted-foreground",
                  )}
                  aria-hidden="true"
                />
                <span className="truncate">
                  {chat.connected
                    ? t("aiAssistant.connected")
                    : chat.connecting || chat.busy
                      ? t("aiAssistant.reconnecting")
                      : t("aiAssistant.disconnected")}
                </span>
              </div>
            </div>
            <ControlBar
              chat={chat}
              compact
              searchOpen={searchOpen}
              onToggleSearch={() => setSearchOpen((value) => !value)}
            />
            {onRequestClose && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onRequestClose}
                aria-label={t("freezone.chat.close")}
                title={t("freezone.chat.close")}
                className="text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
              >
                <X className="size-4" />
              </Button>
            )}
          </div>
        )}
        {chat.error && (
          <div className="border-b border-destructive/20 bg-destructive/8 px-3 py-2 text-xs text-destructive">
            {chat.error}
          </div>
        )}

        {chat.approvals.map((approval) => (
          <ApprovalCard
            key={approval.id}
            approval={approval}
            onResolve={(decision) => chat.resolveApproval(approval, decision)}
          />
        ))}

        <PinnedPanel
          messages={pinnedMessages}
          onClear={chat.clearPinned}
          onTogglePin={chat.togglePin}
        />

        {searchOpen && (
          <SearchBar
            query={search}
            onChange={setSearch}
            onClose={() => setSearchOpen(false)}
          />
        )}

        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            className={cn(
              "h-full overflow-y-auto px-3 py-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              isFreezoneLayout && "px-2.5 py-3",
            )}
          >
            {isChatInitializing ? (
              <div className={cn("mx-auto flex h-full w-full max-w-[760px] items-center justify-center text-center", isFreezoneLayout && "max-w-none")}>
                <div className="max-w-72 text-sm text-muted-foreground">
                  <div className="mb-3 flex justify-center text-primary" aria-hidden="true">
                    <DotsIndicator />
                  </div>
                  <div className="mb-2 font-medium text-foreground">
                    {chat.connected ? t("aiAssistant.syncingHistoryTitle") : t("aiAssistant.connecting")}
                  </div>
                  <div className="text-xs leading-5">{t("aiAssistant.syncingHistoryDescription")}</div>
                </div>
              </div>
            ) : chat.messages.length === 0 && !chat.streamText && !showWaitingIndicator ? (
              <div className={cn("mx-auto flex h-full w-full max-w-[760px] items-center justify-center text-center", isFreezoneLayout && "max-w-none")}>
                <div className="max-w-64 text-sm text-muted-foreground">
                  <div className="mb-2 font-medium text-foreground">{t("aiAssistant.emptyTitle")}</div>
                  <div className="text-xs leading-5">{t("aiAssistant.emptyDescription")}</div>
                </div>
              </div>
            ) : (
              <div ref={messageListRef} className={cn("mx-auto w-full max-w-[760px] space-y-5", isFreezoneLayout && "max-w-none space-y-4")}>
                {visibleMessages.map((message) => (
                  <div
                    key={message.id}
                    data-message-id={message.id}
                    data-turn-id={message.role === "user" ? message.id : undefined}
                  >
                    <MessageBubble
                      message={message}
                      variant={variant}
                      onOpenDetail={setDetailMessage}
                      onOpenMedia={setMediaDetail}
                      pinned={chat.pinnedIds.has(message.id)}
                      onDelete={chat.deleteMessage}
                      onTogglePin={chat.togglePin}
                      deferStructuredRender={deferStructuredRender && isCurrentStreamingAssistantMessage(message)}
                      streaming={isStreamingAssistantMessage(message)}
                    />
                  </div>
                ))}
                {chat.streamText && !streamTextAlreadyRendered && (
                  <MessageBubble
                    message={{
                      id: "streaming",
                      role: "assistant",
                      text: chat.streamText,
                      timestamp: Date.now(),
                    }}
                    variant={variant}
                    onOpenDetail={setDetailMessage}
                    onOpenMedia={setMediaDetail}
                    pinned={false}
                    onDelete={() => undefined}
                    onTogglePin={() => undefined}
                    deferStructuredRender={deferStructuredRender}
                    streaming={chat.busy}
                  />
                )}
              </div>
            )}
          </div>
          {showScrollToBottom && (
            <Button
              type="button"
              size="icon"
              variant="secondary"
              className={cn(
                "absolute bottom-4 left-1/2 z-30 h-9 w-9 -translate-x-1/2 rounded-full border border-white/12 bg-background/88 text-foreground shadow-lg backdrop-blur transition hover:bg-background",
                isFreezoneLayout && "bottom-3",
              )}
              title="回到底部"
              aria-label="回到底部"
              onClick={() => scrollToChatBottom("auto")}
            >
              <ArrowDown className="h-4 w-4" />
            </Button>
          )}
          {!isFreezoneLayout && (
            <ChatTimeline messages={visibleMessages} scrollRef={scrollRef} />
          )}
        </div>

        <div className={cn("sticky bottom-0 z-40 shrink-0 bg-transparent p-3", isFreezoneLayout && "px-4 pb-4 pt-1")}>
          <div className={cn("relative mx-auto mb-2.5 h-7 w-full max-w-[760px]", isFreezoneLayout && "max-w-none")}>
            <ComposerWaitingStatus
              label={t("aiAssistant.waitingResponse")}
              visible={showWaitingIndicator}
              variant={variant}
            />
          </div>
          <div
            ref={composerShellRef}
            className={cn(
              "relative mx-auto w-full max-w-[760px] overflow-hidden rounded-2xl border border-white/10 bg-white/[0.022] shadow-none backdrop-blur-xl",
              dragFileState === "valid" && "border-primary/70 bg-primary/5",
              dragFileState === "invalid" && "border-destructive/80 bg-destructive/10",
              isFreezoneLayout && "max-w-none rounded-xl bg-white/[0.035]",
            )}
            onDragEnter={handleComposerDragEnter}
            onDragOver={handleComposerDragOver}
            onDragLeave={handleComposerDragLeave}
            onDrop={handleComposerDrop}
            onKeyDown={handleComposerKeyDown}
            onFocus={() => composerBeamRef.current?.setActive(true)}
            onBlur={(event) => {
              const next = event.relatedTarget;
              if (next instanceof Node && event.currentTarget.contains(next)) return;
              composerBeamRef.current?.setActive(false);
            }}
          >
            {ENABLE_SUPERCHAT_FILE_UPLOAD && (
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                accept=".txt,.md,.doc,.docx"
                onChange={(event) => addFiles(event.target.files)}
              />
            )}
            {ENABLE_SUPERCHAT_FILE_UPLOAD && dragFileState && (
              <div
                className={cn(
                  "pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-background/72 text-sm font-medium backdrop-blur-sm",
                  dragFileState === "invalid" ? "text-destructive" : "text-foreground",
                )}
              >
                {dragFileState === "invalid" ? t("aiAssistant.unsupportedDropFiles") : t("aiAssistant.dropFiles")}
              </div>
            )}
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-4 pt-3">
                {attachments.map((attachment) => (
                  <span
                    key={attachment.id}
                    className="inline-flex max-w-48 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs"
                  >
                    {attachment.mimeType?.startsWith("image/") ? <Image className="size-3.5" /> : <File className="size-3.5" />}
                    <span className="truncate">{attachment.fileName}</span>
                    <button
                      type="button"
                      onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={t("aiAssistant.removeAttachment")}
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {queuedMessages.length > 0 && (
              <div className="border-t border-border/60 px-4 py-2">
                <div className="mb-1.5 text-xs font-medium text-muted-foreground">
                  {t("aiAssistant.queuedCount", { count: queuedMessages.length })}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {queuedMessages.map((message) => (
                    <span
                      key={message.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedQueuedMessageId(message.id)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        setSelectedQueuedMessageId(message.id);
                      }}
                      className={cn(
                        "inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-left text-xs transition-colors",
                        selectedQueuedMessageId === message.id
                          ? "border-primary/70 bg-primary/10 text-foreground"
                          : "border-border bg-muted/35 text-foreground/85 hover:bg-muted/60",
                      )}
                      aria-label={t("aiAssistant.selectQueuedMessage")}
                      aria-selected={selectedQueuedMessageId === message.id}
                    >
                      <span className="max-w-56 truncate">{message.text}</span>
                      {message.attachments.length > 0 && (
                        <span className="text-muted-foreground">
                          {t("aiAssistant.queuedAttachments", { count: message.attachments.length })}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setQueuedMessages((current) => current.filter((item) => item.id !== message.id));
                        }}
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={t("aiAssistant.removeQueuedMessage")}
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
            <Textarea
              ref={draftInputRef}
              value={draft}
              onChange={(event) => {
                setSelectedHistoryMessageIndex(null);
                setDraft(event.target.value);
              }}
              onKeyDown={(event) => {
                if (
                  queuedMessages.length > 0
                  && draft.trim().length === 0
                  && (event.key === "ArrowUp" || event.key === "ArrowDown")
                ) {
                  event.preventDefault();
                  selectQueuedMessageByOffset(event.key === "ArrowUp" ? -1 : 1);
                  return;
                }
                if (
                  event.key === "ArrowUp"
                  && queuedMessages.length === 0
                  && (draft.trim().length === 0 || selectedHistoryMessageIndex !== null)
                ) {
                  event.preventDefault();
                  selectHistoryMessage("older");
                  return;
                }
                if (
                  event.key === "ArrowDown"
                  && queuedMessages.length === 0
                  && selectedHistoryMessageIndex !== null
                ) {
                  event.preventDefault();
                  selectHistoryMessage("newer");
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              dir="auto"
              placeholder={t("aiAssistant.placeholder")}
              className={cn(
                "max-h-[220px] min-h-14 resize-none border-0 bg-transparent px-5 py-4 text-base shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0 dark:bg-transparent",
                isFreezoneLayout && "min-h-11 px-3.5 py-3 text-sm",
              )}
              rows={1}
            />
            <div className="flex items-center justify-between px-3 py-2">
              <div className="flex items-center gap-1">
                {ENABLE_SUPERCHAT_FILE_UPLOAD && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    disabled={!chat.connected}
                    onClick={() => fileInputRef.current?.click()}
                    aria-label={t("aiAssistant.attach")}
                    title={t("aiAssistant.attach")}
                  >
                    <Plus className="size-4" />
                  </Button>
                )}
              </div>
              <div className="flex shrink-0 items-end gap-1.5">
                {recording && (
                  <div className="mr-1 flex items-center gap-1.5 text-sm text-primary">
                    <span className="size-2 animate-pulse rounded-full bg-primary" />
                    <span>{t("aiAssistant.listening")}</span>
                  </div>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn("size-8 rounded-full text-white/85 hover:bg-white/[0.08] hover:text-white", recording && "text-primary")}
                  disabled={!chat.connected}
                  onClick={toggleSpeech}
                  aria-label={recording ? t("aiAssistant.stopVoice") : t("aiAssistant.voiceInput")}
                  title={recording ? t("aiAssistant.stopVoice") : t("aiAssistant.voiceInput")}
                >
                  {recording ? <MicOff className="size-4.5" /> : <Mic className="size-4.5" />}
                </Button>
                <Button
                  type="button"
                  size="icon"
                  className={cn(
                    "size-8 rounded-full shadow-none disabled:bg-white/30 disabled:text-black/45",
                    chat.busy
                      ? "bg-white/10 text-white hover:bg-white/15"
                      : "bg-white text-black hover:bg-white/90",
                  )}
                  disabled={chat.busy ? false : !canSend}
                  onClick={chat.busy ? chat.abort : submit}
                  aria-label={chat.busy ? t("aiAssistant.stop") : t("aiAssistant.send")}
                  title={chat.busy ? t("aiAssistant.stop") : t("aiAssistant.send")}
                >
                  {chat.busy ? (
                    <span className="size-2.5 rounded-[2.5px] bg-current" aria-hidden />
                  ) : (
                    <ArrowUp className="size-[18px]" />
                  )}
                </Button>
              </div>
            </div>
          </div>
          {!isFreezoneLayout && (
            <p className="mx-auto mt-[13px] w-full max-w-[680px] text-center text-[11px] leading-4 text-white/25">
              {t("aiAssistant.disclaimer")}
            </p>
          )}
        </div>
      </section>
      <MessageDetailPanel
        message={detailMessage}
        onClose={() => setDetailMessage(null)}
        onOpenMedia={setMediaDetail}
      />
      <SpecMediaDetailModal
        detail={mediaDetail}
        onClose={() => setMediaDetail(null)}
        onOpenMedia={setMediaDetail}
      />
      <FormatCheckDetailsDialog
        formatCheck={formatCheckDetails?.formatCheck ?? null}
        filename={formatCheckDetails?.filename}
        open={Boolean(formatCheckDetails)}
        onOpenChange={(next) => {
          if (!next) setFormatCheckDetails(null);
        }}
      />
      <img
        src="/images/bg-chat-buttom.png"
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 z-0 w-full max-w-none select-none"
      />
    </div>
  );
}
