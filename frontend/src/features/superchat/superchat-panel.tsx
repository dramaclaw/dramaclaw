// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  ArrowDown,
  ArrowUp,
  AlertCircle,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  File,
  Image,
  ListTree,
  Maximize2,
  Mic,
  MicOff,
  Package,
  Plus,
  Play,
  Pin,
  PinOff,
  Search,
  ShieldAlert,
  Wrench,
  X,
  Volume2,
  VolumeX,
} from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
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
import { apiCall } from "@/api/client";
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
import {
  SUPERCHAT_CANVAS_CONTEXT_REQUEST_EVENT,
  useSuperChat,
} from "@/features/superchat/use-superchat";
import { useAiAvatarUrl } from "@/features/superchat/ai-avatar";
import { buildChatTaskLabel } from "@/features/superchat/task-notification-label";
import { ComposerWaitingStatus } from "@/features/superchat/composer-waiting-status";
import { calculateTimelineContextDelta } from "@/features/superchat/timeline-scroll";
import { useEventBus } from "@/task-center/event-bus-context";
import {
  extractStructuredBlocks,
  isUiSpec,
  looksLikeStructuredRenderText,
  type StructuredBlock,
  type UiSpec,
} from "@/features/superchat/spec-extract";
import type { ChatMessage, ChatMessagePart } from "@/features/superchat/types";
import type { ApprovalDecision, ApprovalRequest, ChatAttachment } from "@/features/superchat/types";
import { FormatCheckDetailsDialog } from "@/components/ingest/FormatCheckDetailsDialog";
import type { FormatCheck, UploadResult } from "@/lib/queries/ingest";
import type { ErrorResponse, OkResponse, TaskResponse } from "@/types/api";
import type { CanvasOntologyContext } from "@/features/canvas/ontology/canvasOntology";
import { resolveNodeDisplayName } from "@/features/canvas/domain/nodeDisplay";
import { useCanvasStore, type CanvasNode } from "@/stores/canvasStore";
import type { CanvasNodeType, VideoGenQuality } from "@/features/canvas/domain/canvasNodes";
import { VIDEO_GENERATION_ASPECT_RATIOS } from "@/features/canvas/application/imageData";
import { useFreezoneImageModels } from "@/features/canvas/hooks/useFreezoneImageModels";
import { useFreezoneVideoModels } from "@/features/canvas/hooks/useFreezoneVideoModels";
import type {
  CanvasChatCommand,
  CanvasChatCommandApplyStep,
  CanvasChatCommandApplyResult,
  CanvasCommandApprovalEventDetail,
  CanvasCommandResultEventDetail,
  CanvasChatCommandEnvelope,
} from "@/features/freezone/canvasChatCommands";
import {
  applyCanvasChatCommandsAsync,
  FREEZONE_CANVAS_COMMAND_APPROVAL_EVENT,
  FREEZONE_CANVAS_COMMAND_RESULT_EVENT,
  subscribeCanvasCommandApprovals,
} from "@/features/freezone/canvasChatCommands";
import { FREEZONE_CANVAS_WRITE_TOOL_NAME_SET } from "@/features/freezone/canvasCommandTools";
import { canvasCommandUserMessageFromResult } from "@/features/freezone/canvasCommandUserMessages";
import {
  FREEZONE_CANVAS_CONTEXT_ACTIVITY_EVENT,
  FREEZONE_CANVAS_CONTEXT_TOOL_RESULT_EVENT,
  type CanvasContextActivityPayload,
  type CanvasContextToolResultPayload,
} from "@/features/freezone/canvasContextToolResult";
import { reportCanvasCommandToolResult } from "@/features/freezone/canvasCommandToolResult";
import {
  buildCanvasChatCommandContext,
  buildCanvasNodeReferenceAttachment,
  buildCanvasNodeReferenceContext,
  canvasNodeReferenceAttachmentNodes,
  canvasNodeReferenceAttachmentNodeIds,
  isCanvasNodeReferenceAttachment,
  mergeCanvasNodeReferenceAttachments,
  pruneCanvasNodeReferenceAttachments,
  shouldIncludeCanvasSummary,
} from "@/features/freezone/chatNodeReferences";
import {
  visibleStructuredBlocksForMessage,
  type CanvasCommandExecutionMode,
} from "@/features/superchat/canvas-command-display";
import { looksLikeCanvasExecutionNarration } from "@/features/superchat/canvas-execution-narration";
import {
  filterFreezoneSkillSuggestions,
  getFreezoneSkillSlashQuery,
  insertFreezoneSkillMention,
  moveFreezoneSkillSuggestionIndex,
  toFreezoneSkillSuggestions,
} from "@/features/superchat/freezone-skill-suggestions";
import {
  freezoneAgentConfigQueryKey,
  type FreezoneAgentConfigKind,
  type FreezoneAgentConfigPayload,
} from "@/lib/queries/freezone-agent-config";

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

type CanvasNodeReferencePreview = {
  nodeId: string;
  label: string;
  nodeType: string | null;
  mediaType: string | null;
  sourceUrl: string | null;
  previewUrl: string | null;
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

const FREEZONE_TOOL_DISPLAY: Record<string, { title: string; description: string }> = {
  freezone_emit_canvas_command: {
    title: "准备画布操作",
    description: "生成可执行的画布修改命令",
  },
  freezone_create_node: {
    title: "创建节点",
    description: "准备创建一个画布节点",
  },
  freezone_add_next_node: {
    title: "追加节点",
    description: "准备在节点后创建下游节点",
  },
  freezone_update_node_data: {
    title: "更新节点",
    description: "准备修改节点数据",
  },
  freezone_create_edge: {
    title: "创建连线",
    description: "准备连接两个画布节点",
  },
  freezone_delete_nodes: {
    title: "删除节点",
    description: "准备删除画布节点",
  },
  freezone_delete_edges: {
    title: "断开连线",
    description: "准备断开画布连线",
  },
  freezone_move_nodes: {
    title: "移动节点",
    description: "准备移动画布节点",
  },
  freezone_layout_nodes: {
    title: "整理布局",
    description: "准备整理画布节点布局",
  },
  freezone_group_nodes: {
    title: "创建分组",
    description: "准备把节点放入视觉分组",
  },
  freezone_select_nodes: {
    title: "选择节点",
    description: "准备选中或聚焦画布节点",
  },
  freezone_run_node_action: {
    title: "运行节点动作",
    description: "准备运行节点前端动作",
  },
  freezone_get_canvas_ontology: {
    title: "读取画布 Ontology",
    description: "获取当前画布详细 ontology",
  },
  freezone_get_canvas_snapshot: {
    title: "读取画布",
    description: "获取当前画布节点和连线信息",
  },
  freezone_get_selection: {
    title: "读取选择",
    description: "获取当前选中的画布节点",
  },
  freezone_get_node_detail: {
    title: "读取节点",
    description: "获取单个节点详情",
  },
  freezone_get_neighbor_graph: {
    title: "读取上下游",
    description: "获取节点邻近关系",
  },
  freezone_get_node_action_catalog: {
    title: "读取节点能力",
    description: "获取单个节点可用动作",
  },
  freezone_get_node_create_schema: {
    title: "读取创建参数",
    description: "获取节点创建参数",
  },
  freezone_get_audio_voice_options: {
    title: "读取音色",
    description: "获取音频节点音色选项",
  },
  freezone_get_slot_candidates: {
    title: "读取槽位",
    description: "获取当前可提交槽位",
  },
  freezone_get_mainline_projection_assets: {
    title: "读取主线资产",
    description: "获取可映射到画布的主线资产",
  },
  freezone_get_canvas_action_catalog: {
    title: "查询画布能力",
    description: "获取画布级 action catalog",
  },
  freezone_get_canvas_command_catalog: {
    title: "读取命令规则",
    description: "获取批量画布命令字段规则",
  },
  freezone_get_link_type_catalog: {
    title: "读取连线类型",
    description: "获取普通节点连线类型",
  },
  freezone_validate_canvas_commands: {
    title: "校验画布命令",
    description: "预校验 canvas_chat_commands",
  },
  freezone_summarize_canvas: {
    title: "总结画布",
    description: "整理当前画布结构摘要",
  },
};

function toolRawRecord(message: ChatMessage): Record<string, unknown> | null {
  return message.raw && typeof message.raw === "object"
    ? (message.raw as Record<string, unknown>)
    : null;
}

function freezoneToolName(message: ChatMessage): string {
  const raw = toolRawRecord(message);
  const candidates = [
    raw?.name,
    raw?.tool_name,
    raw?.toolName,
    raw?.function_name,
    raw?.functionName,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && FREEZONE_TOOL_DISPLAY[candidate]) return candidate;
  }
  for (const name of Object.keys(FREEZONE_TOOL_DISPLAY)) {
    if (message.text.includes(name)) return name;
  }
  return "";
}

function freezoneToolDisplay(message: ChatMessage): { title: string; description: string } | null {
  const name = freezoneToolName(message);
  return FREEZONE_TOOL_DISPLAY[name] ?? null;
}

function freezoneToolStatus(message: ChatMessage): "running" | "done" | "failed" {
  const raw = toolRawRecord(message);
  const status = typeof raw?.status === "string" ? raw.status.toLowerCase() : "";
  if (
    raw?.type === "tool.call"
    || raw?.type === "agent.tool.started"
    || status === "pending"
    || status === "in_progress"
  ) return "running";
  if (["failed", "error", "cancelled", "canceled"].includes(status)) return "failed";
  if (raw?.success === false || raw?.error) return "failed";
  const result = raw?.result ?? raw?.output;
  if (result && typeof result === "object" && (result as Record<string, unknown>).ok === false) return "failed";
  return "done";
}

function freezoneToolMeta(message: ChatMessage): string[] {
  const raw = toolRawRecord(message);
  if (!raw) return [];
  const toolName = freezoneToolName(message);
  const values: string[] = [];
  const input = raw.input && typeof raw.input === "object" ? raw.input as Record<string, unknown> : null;
  const rawInput =
    raw.raw && typeof raw.raw === "object" && (raw.raw as Record<string, unknown>).rawInput && typeof (raw.raw as Record<string, unknown>).rawInput === "object"
      ? (raw.raw as Record<string, unknown>).rawInput as Record<string, unknown>
      : null;
  const result = raw.result && typeof raw.result === "object" ? raw.result as Record<string, unknown> : null;
  const data = result?.data && typeof result.data === "object" ? result.data as Record<string, unknown> : null;
  const project = input?.project_id ?? input?.project ?? rawInput?.project_id ?? rawInput?.project ?? data?.project;
  const canvas = input?.canvas_id ?? input?.canvasId ?? rawInput?.canvas_id ?? rawInput?.canvasId ?? data?.canvas_id;
  if (typeof project === "string" && project.trim()) values.push(`项目：${project}`);
  if (typeof canvas === "string" && canvas.trim()) values.push(`画布：${canvas}`);
  if (Array.isArray(data?.objects)) values.push(`节点：${data.objects.length}`);
  if (Array.isArray(data?.links)) values.push(`连线：${data.links.length}`);
  if (toolName === "freezone_get_canvas_ontology") values.push(`读取：${CANVAS_CONTEXT_REQUEST_LABELS.canvas_ontology}`);
  if (toolName === "freezone_summarize_canvas") values.push(`读取：${CANVAS_CONTEXT_REQUEST_LABELS.canvas_summary}`);
  if (toolName === "freezone_get_canvas_action_catalog") values.push(`读取：${CANVAS_CONTEXT_REQUEST_LABELS.canvas_action_catalog}`);
  if (toolName === "freezone_get_canvas_command_catalog") values.push(`读取：${CANVAS_CONTEXT_REQUEST_LABELS.canvas_command_catalog}`);
  if (toolName === "freezone_get_link_type_catalog") values.push(`读取：${CANVAS_CONTEXT_REQUEST_LABELS.link_type_catalog}`);
  if (toolName === "freezone_get_selection") values.push(`读取：${CANVAS_CONTEXT_REQUEST_LABELS.selection_detail}`);
  if (toolName === "freezone_get_node_detail") values.push(`读取：${CANVAS_CONTEXT_REQUEST_LABELS.node_detail}`);
  if (toolName === "freezone_get_neighbor_graph") values.push(`读取：${CANVAS_CONTEXT_REQUEST_LABELS.neighbor_graph}`);
  if (toolName === "freezone_get_node_action_catalog") values.push(`读取：${CANVAS_CONTEXT_REQUEST_LABELS.node_action_catalog}`);
  if (toolName === "freezone_get_node_create_schema") values.push(`读取：${CANVAS_CONTEXT_REQUEST_LABELS.node_create_schema}`);
  if (toolName === "freezone_get_audio_voice_options") values.push(`读取：${CANVAS_CONTEXT_REQUEST_LABELS.audio_voice_options}`);
  if (toolName === "freezone_get_slot_candidates") values.push(`读取：${CANVAS_CONTEXT_REQUEST_LABELS.slot_candidates}`);
  if (toolName === "freezone_get_mainline_projection_assets") values.push(`读取：${CANVAS_CONTEXT_REQUEST_LABELS.mainline_projection_assets}`);
  if (toolName === "freezone_validate_canvas_commands") values.push(`校验：${CANVAS_CONTEXT_REQUEST_LABELS.validate_canvas_commands}`);
  return values.slice(0, 4);
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
                onClick={() => {
                  void writeClipboardText(JSON.stringify(block.value, null, 2)).then((ok) => {
                    if (ok) toast.success("已复制");
                    else toast.error("复制失败");
                  });
                }}
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

function CanvasContextActivityCard({ activity }: { activity: CanvasContextActivity }) {
  const [expanded, setExpanded] = useState(false);
  const failed = activity.status === "failed";
  const running = activity.status === "running";
  const visualTone = canvasContextActivityVisualTone(activity);
  const label = activity.labels.length > 0 ? activity.labels.join("、") : "画布上下文";
  const isThinking = activity.labels.includes(CANVAS_CONTEXT_THINKING_LABEL);
  const isValidation = canvasContextActivityIsValidation(activity);
  const hasErrors = activity.errors.length > 0;
  const statusText = isThinking
    ? CANVAS_CONTEXT_THINKING_LABEL
    : isValidation
      ? running
        ? "正在校验画布命令"
        : failed
          ? "画布命令校验失败"
          : "已校验画布命令"
      : running
        ? `正在读取${label}`
        : failed
          ? `读取${label}失败`
          : `已读取${label}`;
  const repeatText = activity.repeatCount && activity.repeatCount > 1 ? ` × ${activity.repeatCount}` : "";
  return (
    <div className={cn("mt-2 w-fit max-w-full rounded-md px-0 py-1 text-xs", visualTone === "warning" ? "text-amber-300/90" : "text-muted-foreground")}>
      <button
        type="button"
        className={cn("flex max-w-full items-center gap-2 text-left", hasErrors && "cursor-pointer")}
        onClick={() => hasErrors && setExpanded((value) => !value)}
      >
        {running ? <DotsIndicator /> : failed ? <AlertCircle className="size-3.5 shrink-0" /> : <CheckCircle2 className="size-3.5 shrink-0" />}
        <span className="font-medium">{statusText}{repeatText}</span>
        {hasErrors && <ChevronRight className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")} />}
      </button>
      {failed && hasErrors && expanded && (
        <div className="mt-1 max-w-[min(560px,80vw)] break-words pl-[22px] text-[11px] leading-4 text-muted-foreground/80">
          {activity.errors.join("; ")}
        </div>
      )}
    </div>
  );
}

function FreezoneToolActivityCard({ message }: { message: ChatMessage }) {
  const display = freezoneToolDisplay(message);
  if (!display) return null;
  const status = freezoneToolStatus(message);
  const meta = freezoneToolMeta(message);
  return (
    <div
      className={cn(
        "w-full max-w-[86%] rounded-xl border px-3 py-2 text-sm",
        status === "failed"
          ? "border-red-400/20 bg-red-500/8 text-red-100"
          : "border-white/[0.08] bg-white/[0.035] text-foreground",
      )}
    >
      <div className="flex items-center gap-2">
        {status === "running" ? (
          <span className="text-muted-foreground">
            <DotsIndicator />
          </span>
        ) : status === "failed" ? (
          <AlertCircle className="size-3.5 text-red-400" />
        ) : (
          <CheckCircle2 className="size-3.5 text-emerald-400" />
        )}
        <span className="font-medium">{display.title}</span>
        <span className="text-xs text-muted-foreground">
          {status === "running" ? "进行中" : status === "failed" ? "失败" : "完成"}
        </span>
      </div>
      <div className="mt-1 text-xs leading-5 text-muted-foreground">
        {display.description}
      </div>
      {meta.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] leading-4 text-muted-foreground/80">
          {meta.map((item) => (
            <span key={item} className="max-w-60 truncate">{item}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function genericToolTitle(message: ChatMessage): string {
  const raw = toolRawRecord(message);
  const name = typeof raw?.name === "string" ? raw.name.trim() : "";
  if (!name) return "执行工具";
  return name
    .replace(/^freezone_/u, "")
    .replace(/[_-]+/gu, " ")
    .replace(/\b\w/gu, (value) => value.toUpperCase());
}

function AgentToolActivityCard({ message }: { message: ChatMessage }) {
  if (freezoneToolDisplay(message)) return <FreezoneToolActivityCard message={message} />;
  const raw = toolRawRecord(message);
  const status = freezoneToolStatus(message);
  const error = typeof raw?.error === "string"
    ? raw.error.trim()
    : raw?.error ? JSON.stringify(raw.error) : "";
  const detail = error || (typeof raw?.text === "string" ? raw.text.trim() : "");
  return (
    <div
      className={cn(
        "w-full max-w-[86%] rounded-xl border px-3 py-2 text-sm",
        status === "failed"
          ? "border-red-400/20 bg-red-500/8 text-red-100"
          : "border-white/[0.08] bg-white/[0.035] text-foreground",
      )}
    >
      <div className="flex items-center gap-2">
        {status === "running" ? (
          <span className="text-muted-foreground"><DotsIndicator /></span>
        ) : status === "failed" ? (
          <AlertCircle className="size-3.5 text-red-400" />
        ) : (
          <CheckCircle2 className="size-3.5 text-emerald-400" />
        )}
        <span className="font-medium">{genericToolTitle(message)}</span>
        <span className="text-xs text-muted-foreground">
          {status === "running" ? "进行中" : status === "failed" ? "失败" : "完成"}
        </span>
      </div>
      {detail && <div className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</div>}
    </div>
  );
}

function AgentPlanCard({ event }: { event: unknown }) {
  const record = event && typeof event === "object" && !Array.isArray(event)
    ? event as Record<string, unknown>
    : {};
  const entries = Array.isArray(record.entries)
    ? record.entries.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
    : [];
  if (entries.length === 0) return null;
  const completed = entries.filter((entry) => entry.status === "completed").length;
  return (
    <div className="w-full max-w-[86%] rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 py-2.5 text-sm">
      <div className="mb-2 flex items-center gap-2">
        <ListTree className="size-3.5 text-primary" />
        <span className="font-medium">执行计划</span>
        <span className="ml-auto text-xs text-muted-foreground">{completed}/{entries.length}</span>
      </div>
      <div className="space-y-1.5">
        {entries.map((entry, index) => {
          const status = typeof entry.status === "string" ? entry.status : "pending";
          const content = typeof entry.content === "string" ? entry.content : `步骤 ${index + 1}`;
          return (
            <div key={`${index}-${content}`} className="flex items-start gap-2 text-xs leading-5">
              {status === "completed" ? (
                <CheckCircle2 className="mt-1 size-3 shrink-0 text-emerald-400" />
              ) : status === "in_progress" ? (
                <span className="mt-1.5 size-2 shrink-0 animate-pulse rounded-full bg-primary" />
              ) : (
                <span className="mt-1.5 size-2 shrink-0 rounded-full border border-muted-foreground/50" />
              )}
              <span className={status === "completed" ? "text-muted-foreground" : "text-foreground/90"}>{content}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgentThoughtCard({ event }: { event: unknown }) {
  const text = event && typeof event === "object" && !Array.isArray(event)
    && typeof (event as Record<string, unknown>).text === "string"
    ? String((event as Record<string, unknown>).text).trim()
    : "";
  if (!text) return null;
  return (
    <details className="w-full max-w-[86%] rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none font-medium">思考过程</summary>
      <div className="mt-2 whitespace-pre-wrap break-words leading-5">{text}</div>
    </details>
  );
}

function AgentUsageCard({ event }: { event: unknown }) {
  const usage = event && typeof event === "object" && !Array.isArray(event)
    ? (event as Record<string, unknown>).usage
    : null;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const values = Object.entries(usage as Record<string, unknown>)
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .slice(0, 6);
  if (values.length === 0) return null;
  return (
    <details className="w-full max-w-[86%] text-[11px] text-muted-foreground/75">
      <summary className="cursor-pointer select-none">上下文用量</summary>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        {values.map(([key, value]) => <span key={key}>{key}: {String(value)}</span>)}
      </div>
    </details>
  );
}

function agentActivityLabelFromMessage(message: ChatMessage | undefined): string | null {
  if (!message?.parts?.length) return null;
  for (const part of [...message.parts].reverse()) {
    if (part.type === "tool_status") {
      const toolMessage = part.event as ChatMessage;
      if (freezoneToolStatus(toolMessage) !== "running") continue;
      return `正在${freezoneToolDisplay(toolMessage)?.title ?? genericToolTitle(toolMessage)}`;
    }
    if (part.type === "agent_plan" && part.event && typeof part.event === "object" && !Array.isArray(part.event)) {
      const entries = (part.event as Record<string, unknown>).entries;
      if (!Array.isArray(entries)) continue;
      const active = entries.find((entry) =>
        Boolean(entry && typeof entry === "object" && !Array.isArray(entry) && (entry as Record<string, unknown>).status === "in_progress"),
      );
      if (active && typeof (active as Record<string, unknown>).content === "string") {
        return `正在${String((active as Record<string, unknown>).content)}`;
      }
    }
  }
  return null;
}

function CanvasCommandPlanList({ plans }: { plans: CanvasCommandPlan[] | undefined }) {
  if (!plans || plans.length === 0) return null;
  return (
    <div className="space-y-2 px-3 py-2">
      {plans.slice(0, 6).map((plan) => (
        <div key={`${plan.index}-${plan.type}`} className="rounded-lg bg-black/15 px-2.5 py-2">
          <div className="flex items-center gap-2 text-foreground/90">
            {plan.destructive ? (
              <AlertCircle className="size-3.5 shrink-0 text-destructive" />
            ) : (
              <ListTree className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="font-medium">{plan.label}</span>
            {plan.primary && <span className="ml-auto max-w-48 truncate text-[11px] text-muted-foreground">{plan.primary}</span>}
          </div>
          {plan.details.length > 0 && (
            <div className="mt-1.5 space-y-0.5 text-[11px] leading-4 text-muted-foreground">
              {plan.details.slice(0, 5).map((detail) => <div key={detail} className="truncate">{detail}</div>)}
            </div>
          )}
        </div>
      ))}
      {plans.length > 6 && <div className="px-1 text-[11px] text-muted-foreground">还有 {plans.length - 6} 个操作将在确认后一起执行</div>}
    </div>
  );
}

function imageGenerateCommandNodeIds(envelopes: CanvasChatCommandEnvelope[]): string[] {
  const nodeIds: string[] = [];
  for (const envelope of envelopes) {
    for (const command of envelope.commands) {
      if (command.type === "run_node_action" && command.action === "generate_image") {
        nodeIds.push(command.node_id);
      }
    }
  }
  return nodeIds;
}

function videoGenerateCommandNodeIds(envelopes: CanvasChatCommandEnvelope[]): string[] {
  const nodeIds: string[] = [];
  for (const envelope of envelopes) {
    for (const command of envelope.commands) {
      if (command.type === "run_node_action" && command.action === "generate_video") {
        nodeIds.push(command.node_id);
      }
    }
  }
  return nodeIds;
}

function imageApprovalInitialParams(
  approval: PendingCanvasCommandApproval,
  canvasNodes: CanvasNode[],
  fallbackModel: string,
): CanvasApprovalImageParams | null {
  const nodeIds = imageGenerateCommandNodeIds(approval.envelopes);
  if (nodeIds.length !== 1) return null;
  const nodeId = nodeIds[0];
  const nodeData = canvasNodes.find((node) => node.id === nodeId)?.data as Record<string, unknown> | undefined;
  const textValue = (value: unknown, fallback: string) =>
    typeof value === "string" && value.trim() ? value.trim() : fallback;
  const countValue = typeof nodeData?.count === "number" && CANVAS_APPROVAL_IMAGE_COUNT_OPTIONS.includes(nodeData.count as 1 | 2 | 4)
    ? nodeData.count
    : 1;
  return {
    nodeId,
    model: textValue(nodeData?.model, fallbackModel),
    aspectRatio: textValue(nodeData?.aspectRatio, "16:9"),
    size: textValue(nodeData?.size, "2K"),
    quality: textValue(nodeData?.quality, "medium"),
    count: countValue,
  };
}

function resolutionToVideoQuality(value: string): VideoGenQuality | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "480p") return "480P";
  if (normalized === "720p") return "720P";
  if (normalized === "1080p") return "1080P";
  return null;
}

function videoQualityOptionsForApproval(
  model: { resolutionOptions?: string[] } | null | undefined,
): readonly VideoGenQuality[] {
  const options = (model?.resolutionOptions ?? [])
    .map(resolutionToVideoQuality)
    .filter((item): item is VideoGenQuality => Boolean(item));
  return options.length > 0 ? options : CANVAS_APPROVAL_VIDEO_QUALITY_OPTIONS;
}

function normalizeVideoQualityForApproval(
  value: unknown,
  options: readonly VideoGenQuality[],
): VideoGenQuality {
  const fallback = options.includes("720P") ? "720P" : options[0] ?? "720P";
  return typeof value === "string" && options.includes(value as VideoGenQuality)
    ? (value as VideoGenQuality)
    : fallback;
}

function videoDurationBoundsForApproval(
  model: { minDuration?: number | null; maxDuration?: number | null } | null | undefined,
): { min: number; max: number } {
  const min = Number(model?.minDuration);
  const max = Number(model?.maxDuration);
  const resolvedMin = Number.isFinite(min) && min > 0 ? min : CANVAS_APPROVAL_VIDEO_DURATION_MIN;
  const resolvedMax = Number.isFinite(max) && max >= resolvedMin ? max : CANVAS_APPROVAL_VIDEO_DURATION_MAX;
  return { min: resolvedMin, max: resolvedMax };
}

function clampVideoDurationForApproval(value: unknown, bounds: { min: number; max: number }): number {
  const numeric = typeof value === "number" ? value : Number(value);
  const safe = Number.isFinite(numeric) ? numeric : bounds.min;
  return Math.min(Math.max(Math.round(safe), bounds.min), bounds.max);
}

function isCanvasApprovalVideoCount(value: unknown): value is CanvasApprovalVideoParams["count"] {
  return (
    typeof value === "number" &&
    CANVAS_APPROVAL_VIDEO_COUNT_OPTIONS.includes(value as CanvasApprovalVideoParams["count"])
  );
}

function videoApprovalInitialParams(
  approval: PendingCanvasCommandApproval,
  canvasNodes: CanvasNode[],
  models: Array<{
    id: string;
    label?: string;
    resolutionOptions?: string[];
    minDuration?: number | null;
    maxDuration?: number | null;
  }>,
  fallbackModel: string,
): CanvasApprovalVideoParams | null {
  const nodeIds = videoGenerateCommandNodeIds(approval.envelopes);
  if (nodeIds.length !== 1) return null;
  const nodeId = nodeIds[0];
  const nodeData = canvasNodes.find((node) => node.id === nodeId)?.data as Record<string, unknown> | undefined;
  const textValue = (value: unknown, fallback: string) =>
    typeof value === "string" && value.trim() ? value.trim() : fallback;
  const rawModel = textValue(nodeData?.model, fallbackModel);
  const selectedModel = models.find((item) => item.id === rawModel) ?? models[0];
  const model = selectedModel?.id ?? rawModel;
  const qualityOptions = videoQualityOptionsForApproval(selectedModel);
  const durationBounds = videoDurationBoundsForApproval(selectedModel);
  const aspectRatio = textValue(nodeData?.aspectRatio, "16:9");
  const normalizedAspectRatio = (VIDEO_GENERATION_ASPECT_RATIOS as readonly string[]).includes(aspectRatio)
    ? aspectRatio
    : "16:9";
  const countValue = isCanvasApprovalVideoCount(nodeData?.count)
    ? nodeData.count
    : 1;
  return {
    nodeId,
    model,
    aspectRatio: normalizedAspectRatio,
    quality: normalizeVideoQualityForApproval(nodeData?.quality, qualityOptions),
    durationSec: clampVideoDurationForApproval(nodeData?.durationSec, durationBounds),
    generateAudio: Boolean(nodeData?.generateAudio),
    count: countValue,
  };
}

function amendCanvasApprovalWithImageParams(
  approval: PendingCanvasCommandApproval,
  params: CanvasApprovalImageParams | null,
): PendingCanvasCommandApproval {
  if (!params) return approval;
  let inserted = false;
  const imageData = {
    model: params.model,
    aspectRatio: params.aspectRatio,
    size: params.size,
    quality: params.quality,
    count: params.count,
  };
  return {
    ...approval,
    envelopes: approval.envelopes.map((envelope) => ({
      ...envelope,
      commands: envelope.commands.flatMap((command) => {
        if (
          inserted ||
          command.type !== "run_node_action" ||
          command.action !== "generate_image" ||
          command.node_id !== params.nodeId
        ) {
          return [command];
        }
        inserted = true;
        return [
          {
            type: "update_node_data" as const,
            node_id: params.nodeId,
            data: imageData,
          },
          command,
        ];
      }),
    })),
  };
}

function amendCanvasApprovalWithVideoParams(
  approval: PendingCanvasCommandApproval,
  params: CanvasApprovalVideoParams | null,
): PendingCanvasCommandApproval {
  if (!params) return approval;
  let inserted = false;
  const videoData = {
    model: params.model,
    aspectRatio: params.aspectRatio,
    quality: params.quality,
    durationSec: params.durationSec,
    generateAudio: params.generateAudio,
    count: params.count,
  };
  return {
    ...approval,
    envelopes: approval.envelopes.map((envelope) => ({
      ...envelope,
      commands: envelope.commands.flatMap((command) => {
        if (
          inserted ||
          command.type !== "run_node_action" ||
          command.action !== "generate_video" ||
          command.node_id !== params.nodeId
        ) {
          return [command];
        }
        inserted = true;
        return [
          {
            type: "update_node_data" as const,
            node_id: params.nodeId,
            data: videoData,
          },
          command,
        ];
      }),
    })),
  };
}

export const amendCanvasApprovalWithImageParamsForTest = amendCanvasApprovalWithImageParams;
export const amendCanvasApprovalWithVideoParamsForTest = amendCanvasApprovalWithVideoParams;

function CanvasApprovalImageParamSelect({
  ariaLabel,
  disabled,
  icon,
  onChange,
  options,
  value,
}: {
  ariaLabel: string;
  disabled?: boolean;
  icon?: ReactNode;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  value: string;
}) {
  return (
    <label className="group inline-flex h-6 max-w-full items-center gap-1 rounded-full bg-transparent px-0 text-[11px] text-foreground/90">
      {icon && <span className="shrink-0 text-muted-foreground/80">{icon}</span>}
      <select
        aria-label={ariaLabel}
        className="max-w-32 appearance-none truncate border-0 bg-transparent py-0 pl-0 pr-3 text-[11px] font-medium text-foreground outline-none transition-colors hover:text-foreground disabled:opacity-60"
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function CanvasApprovalVideoConfigChip({
  disabled,
  durationBounds,
  onChange,
  params,
  qualityOptions,
}: {
  disabled?: boolean;
  durationBounds: { min: number; max: number };
  onChange: (patch: Partial<CanvasApprovalVideoParams>) => void;
  params: CanvasApprovalVideoParams;
  qualityOptions: readonly VideoGenQuality[];
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const audioLabel = params.generateAudio ? "有声" : "静音";

  const updatePopoverPosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPopoverStyle({
      left: Math.min(rect.left, window.innerWidth - 244),
      top: rect.bottom + 8,
      width: 244,
    });
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) return;
    updatePopoverPosition();
    window.addEventListener("resize", updatePopoverPosition);
    window.addEventListener("scroll", updatePopoverPosition, true);
    return () => {
      window.removeEventListener("resize", updatePopoverPosition);
      window.removeEventListener("scroll", updatePopoverPosition, true);
    };
  }, [isOpen, updatePopoverPosition]);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        popoverRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setIsOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [isOpen]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={`视频参数：${params.aspectRatio} · ${params.quality} · ${params.durationSec}s · ${audioLabel}`}
        onClick={() => setIsOpen((prev) => !prev)}
        className="inline-flex h-6 max-w-full items-center gap-1 rounded-full bg-transparent px-0 text-[11px] font-medium text-foreground outline-none transition-colors hover:text-foreground disabled:opacity-60"
      >
        <span>{params.aspectRatio}</span>
        <span className="text-muted-foreground/70">·</span>
        <span>{params.quality}</span>
        <span className="text-muted-foreground/70">·</span>
        <span>{params.durationSec}s</span>
        {params.generateAudio ? (
          <Volume2 className="size-3 text-muted-foreground/80" />
        ) : (
          <VolumeX className="size-3 text-muted-foreground/80" />
        )}
        <ChevronDown className="size-3 text-muted-foreground/80" />
      </button>
      {isOpen && createPortal(
        <div
          ref={popoverRef}
          style={popoverStyle}
          className="fixed z-[10000] rounded-lg border border-white/10 bg-[#2b2b2b] p-2 text-xs text-foreground shadow-2xl"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">比例</div>
          <div className="mb-3 grid grid-cols-4 gap-1.5">
            {VIDEO_GENERATION_ASPECT_RATIOS.map((ratio) => {
              const isActive = params.aspectRatio === ratio;
              return (
                <button
                  key={ratio}
                  type="button"
                  onClick={() => onChange({ aspectRatio: ratio })}
                  className={cn(
                    "rounded-full px-2 py-1 text-[11px] transition-colors",
                    isActive
                      ? "bg-white/18 text-foreground"
                      : "bg-white/[0.06] text-muted-foreground hover:bg-white/[0.1] hover:text-foreground",
                  )}
                >
                  {ratio}
                </button>
              );
            })}
          </div>

          <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">清晰度</div>
          <div className="mb-3 grid grid-cols-3 gap-1.5">
            {qualityOptions.map((quality) => {
              const isActive = params.quality === quality;
              return (
                <button
                  key={quality}
                  type="button"
                  onClick={() => onChange({ quality })}
                  className={cn(
                    "rounded-full px-2 py-1 text-[11px] transition-colors",
                    isActive
                      ? "bg-white/18 text-foreground"
                      : "bg-white/[0.06] text-muted-foreground hover:bg-white/[0.1] hover:text-foreground",
                  )}
                >
                  {quality}
                </button>
              );
            })}
          </div>

          <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-muted-foreground">
            <span>视频时长</span>
            <span className="text-foreground">{params.durationSec}s</span>
          </div>
          <input
            aria-label="视频时长"
            type="range"
            min={durationBounds.min}
            max={durationBounds.max}
            step={1}
            value={params.durationSec}
            onChange={(event) => onChange({ durationSec: Number(event.target.value) })}
            className="mb-3 w-full"
          />

          <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">生成音频</div>
          <div className="flex items-center justify-between rounded-md bg-white/[0.06] px-2.5 py-1.5">
            <span className="text-xs font-medium text-foreground">{audioLabel}</span>
            <button
              type="button"
              role="switch"
              aria-checked={params.generateAudio}
              aria-label="生成音频"
              onClick={() => onChange({ generateAudio: !params.generateAudio })}
              className={cn(
                "relative h-5 w-9 rounded-full transition-colors",
                params.generateAudio ? "bg-white/35" : "bg-white/15",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 size-4 rounded-full bg-white transition-transform",
                  params.generateAudio ? "translate-x-4" : "translate-x-0.5",
                )}
              />
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function CanvasCommandApprovalCard({
  approval,
  isExecuting = false,
  onApply,
  onCancel,
}: {
  approval: PendingCanvasCommandApproval;
  isExecuting?: boolean;
  onApply: (approval: PendingCanvasCommandApproval) => void;
  onCancel: (approval: PendingCanvasCommandApproval) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const params = useParams({ strict: false }) as { project?: string };
  const imageModels = useFreezoneImageModels(params.project);
  const videoModels = useFreezoneVideoModels(params.project);
  const canvasNodes = useCanvasStore((state) => state.nodes);
  const fallbackImageModel = imageModels.models[0]?.id ?? "";
  const fallbackVideoModel = videoModels.models[0]?.id ?? "";
  const initialImageParams = useMemo(
    () => imageApprovalInitialParams(approval, canvasNodes, fallbackImageModel),
    [approval, canvasNodes, fallbackImageModel],
  );
  const initialVideoParams = useMemo(
    () => videoApprovalInitialParams(approval, canvasNodes, videoModels.models, fallbackVideoModel),
    [approval, canvasNodes, fallbackVideoModel, videoModels.models],
  );
  const [imageParams, setImageParams] = useState<CanvasApprovalImageParams | null>(() => initialImageParams);
  const [videoParams, setVideoParams] = useState<CanvasApprovalVideoParams | null>(() => initialVideoParams);
  const remaining = approval.expiresAt
    ? Math.max(0, Math.ceil((approval.expiresAt - now) / 1000))
    : null;

  useEffect(() => {
    setImageParams(initialImageParams);
  }, [initialImageParams]);

  useEffect(() => {
    setVideoParams(initialVideoParams);
  }, [initialVideoParams]);

  useEffect(() => {
    if (!approval.expiresAt || isExecuting) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [approval.expiresAt, isExecuting]);

  const amendedApproval = useMemo(
    () => amendCanvasApprovalWithVideoParams(
      amendCanvasApprovalWithImageParams(approval, imageParams),
      videoParams,
    ),
    [approval, imageParams, videoParams],
  );
  const imageModelOptions = useMemo(() => {
    const options = imageModels.models.map((model) => ({ value: model.id, label: model.label ?? model.id }));
    if (imageParams?.model && !options.some((option) => option.value === imageParams.model)) {
      return [{ value: imageParams.model, label: imageParams.model }, ...options];
    }
    return options;
  }, [imageModels.models, imageParams?.model]);
  const updateImageParams = useCallback((patch: Partial<CanvasApprovalImageParams>) => {
    setImageParams((current) => current ? { ...current, ...patch } : current);
  }, []);
  const selectedVideoModel = useMemo(
    () => videoModels.models.find((model) => model.id === videoParams?.model) ?? videoModels.models[0],
    [videoModels.models, videoParams?.model],
  );
  const videoQualityOptions = useMemo(
    () => videoQualityOptionsForApproval(selectedVideoModel),
    [selectedVideoModel],
  );
  const videoDurationBounds = useMemo(
    () => videoDurationBoundsForApproval(selectedVideoModel),
    [selectedVideoModel],
  );
  const videoModelOptions = useMemo(() => {
    const options = videoModels.models.map((model) => ({ value: model.id, label: model.label ?? model.id }));
    if (videoParams?.model && !options.some((option) => option.value === videoParams.model)) {
      return [{ value: videoParams.model, label: videoParams.model }, ...options];
    }
    return options;
  }, [videoModels.models, videoParams?.model]);
  const updateVideoParams = useCallback((patch: Partial<CanvasApprovalVideoParams>) => {
    setVideoParams((current) => {
      if (!current) return current;
      const next = { ...current, ...patch };
      const model = videoModels.models.find((item) => item.id === next.model) ?? videoModels.models[0];
      const qualityOptions = videoQualityOptionsForApproval(model);
      const durationBounds = videoDurationBoundsForApproval(model);
      return {
        ...next,
        quality: normalizeVideoQualityForApproval(next.quality, qualityOptions),
        durationSec: clampVideoDurationForApproval(next.durationSec, durationBounds),
      };
    });
  }, [videoModels.models]);

  return (
    <div className="mt-3 w-full min-w-0 overflow-hidden rounded-xl border border-amber-400/25 bg-background/95 text-xs text-muted-foreground shadow-lg backdrop-blur-sm">
      <div className="flex items-start gap-2 border-b border-amber-400/15 px-3 py-2">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">待确认的画布操作</div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">Agent 计划执行 {approval.commandCount} 个操作，确认后才会应用到画布。</p>
        </div>
        <Badge variant="outline" className="rounded-md uppercase">{isExecuting ? "执行中" : "确认"}</Badge>
      </div>
      <CanvasCommandPlanList plans={approval.plans} />
      {imageParams && (
        <div className="border-t border-amber-400/10 px-3 py-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <CanvasApprovalImageParamSelect
              ariaLabel="图片模型"
              disabled={isExecuting}
              icon={<Image className="size-3" />}
              value={imageParams.model}
              onChange={(value) => updateImageParams({ model: value })}
              options={imageModelOptions}
            />
            <span className="h-4 w-px bg-white/[0.12]" />
            <CanvasApprovalImageParamSelect
              ariaLabel="图片比例"
              disabled={isExecuting}
              value={imageParams.aspectRatio}
              onChange={(value) => updateImageParams({ aspectRatio: value })}
              options={CANVAS_APPROVAL_IMAGE_ASPECT_RATIO_OPTIONS.map((option) => ({
                value: option,
                label: option === "auto" ? "自动比例" : option,
              }))}
            />
            <span className="h-4 w-px bg-white/[0.12]" />
            <CanvasApprovalImageParamSelect
              ariaLabel="图片分辨率"
              disabled={isExecuting}
              value={imageParams.size}
              onChange={(value) => updateImageParams({ size: value })}
              options={CANVAS_APPROVAL_IMAGE_SIZE_OPTIONS.map((option) => ({ value: option, label: option }))}
            />
            <span className="h-4 w-px bg-white/[0.12]" />
            <CanvasApprovalImageParamSelect
              ariaLabel="图片画质"
              disabled={isExecuting}
              value={imageParams.quality}
              onChange={(value) => updateImageParams({ quality: value })}
              options={CANVAS_APPROVAL_IMAGE_QUALITY_OPTIONS.map((option) => ({ value: option, label: option }))}
            />
            <span className="h-4 w-px bg-white/[0.12]" />
            <CanvasApprovalImageParamSelect
              ariaLabel="图片数量"
              disabled={isExecuting}
              value={String(imageParams.count)}
              onChange={(value) => updateImageParams({ count: Number(value) })}
              options={CANVAS_APPROVAL_IMAGE_COUNT_OPTIONS.map((option) => ({ value: String(option), label: `${option} 张` }))}
            />
          </div>
        </div>
      )}
      {videoParams && (
        <div className="border-t border-amber-400/10 px-3 py-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <CanvasApprovalImageParamSelect
              ariaLabel="视频模型"
              disabled={isExecuting}
              value={videoParams.model}
              onChange={(value) => updateVideoParams({ model: value })}
              options={videoModelOptions}
            />
            <span className="h-3.5 w-px bg-white/[0.12]" />
            <CanvasApprovalVideoConfigChip
              disabled={isExecuting}
              durationBounds={videoDurationBounds}
              onChange={updateVideoParams}
              params={videoParams}
              qualityOptions={videoQualityOptions}
            />
            <span className="h-3.5 w-px bg-white/[0.12]" />
            <CanvasApprovalImageParamSelect
              ariaLabel="视频数量"
              disabled={isExecuting}
              value={String(videoParams.count)}
              onChange={(value) => updateVideoParams({ count: Number(value) as 1 | 2 | 4 })}
              options={CANVAS_APPROVAL_VIDEO_COUNT_OPTIONS.map((option) => ({ value: String(option), label: `${option} 个` }))}
            />
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-amber-400/15 px-3 py-2.5">
        {remaining !== null && !isExecuting ? (
          <span className="mr-auto text-[11px] leading-4 text-amber-500">
            {remaining}s 后自动取消
          </span>
        ) : null}
        <Button size="xs" variant="outline" disabled={isExecuting} onClick={() => onCancel(approval)}>取消</Button>
        <Button size="xs" disabled={isExecuting} onClick={() => onApply(amendedApproval)}>{isExecuting ? "执行中..." : "确认执行"}</Button>
      </div>
    </div>
  );
}

function canvasCommandFeedbackHasFailure(feedback: CanvasCommandFeedback): boolean {
  return feedback.errors.length > 0 || (feedback.commandResults ?? []).some((step) => step.status !== "success");
}

function canvasCommandFeedbackIsInvalidCommand(feedback: CanvasCommandFeedback): boolean {
  return (feedback.commandResults ?? []).some((step) => step.label === "画布命令无效");
}

type CanvasFeedbackVisualTone = "muted" | "warning" | "destructive" | "success";

function canvasContextActivityVisualTone(activity: CanvasContextActivity): CanvasFeedbackVisualTone {
  if (activity.status === "failed") {
    return canvasContextActivityIsValidation(activity) ? "muted" : "warning";
  }
  return "muted";
}

export const canvasContextActivityVisualToneForTest = canvasContextActivityVisualTone;

function canvasCommandFeedbackVisualTone(feedback: CanvasCommandFeedback): CanvasFeedbackVisualTone {
  const failed = canvasCommandFeedbackHasFailure(feedback);
  if (!failed) return "success";
  return canvasCommandFeedbackIsValidationOnly(feedback) ? "muted" : "destructive";
}

export const canvasCommandFeedbackVisualToneForTest = canvasCommandFeedbackVisualTone;

function canvasCommandFeedbackCompactTitle(feedback: CanvasCommandFeedback): string {
  const firstFailedStep = (feedback.commandResults ?? []).find((step) => step.status !== "success");
  const firstPlan = feedback.plans?.[0];
  if (firstFailedStep?.label === "已取消") return "画布操作已取消";
  if (firstPlan?.type === "run_node_action" && firstPlan.label.includes("生成图片")) return "生成图片失败";
  if (firstPlan?.type === "run_node_action" && firstPlan.label.includes("生成视频")) return "生成视频失败";
  if (firstFailedStep?.label) return firstFailedStep.label;
  return "画布操作失败";
}

function expiredCanvasApprovalFeedback(approval: PendingCanvasCommandApproval): CanvasCommandFeedback | null {
  if (!approval.autoExpires || !approval.expiresAt || approval.expiresAt > Date.now()) return null;
  const error = "画布操作等待超时，已自动取消";
  return {
    applied: 0,
    openedUiActions: 0,
    errors: [error],
    commandResults: [
      {
        commandIndex: -1,
        type: "validate",
        status: "error",
        label: "已取消",
        error,
      },
    ],
    key: `expired:${approval.key}`,
    plans: approval.plans,
    anchorTextPrefix: approval.anchorTextPrefix ?? undefined,
    surfaceOrder: approval.surfaceOrder ?? approval.receivedAt,
  };
}

function CanvasCommandFeedbackCard({ feedback }: { feedback: CanvasCommandFeedback }) {
  const [expanded, setExpanded] = useState(false);
  const steps = feedback.commandResults ?? [];
  const successfulCount = feedback.applied + feedback.openedUiActions;
  if (steps.length === 0 && successfulCount === 0 && feedback.errors.length === 0) return null;
  const failed = canvasCommandFeedbackHasFailure(feedback);
  const invalidCommand = canvasCommandFeedbackIsInvalidCommand(feedback);
  const visualTone = canvasCommandFeedbackVisualTone(feedback);
  const mutedFailure = failed && visualTone === "muted";
  const initiallyCompact = failed && successfulCount === 0;
  const collapseSuccessfulDetails = !failed && steps.length > 2;
  const compactTitle = canvasCommandFeedbackCompactTitle(feedback);
  const userFailureMessage = failed
    ? canvasCommandUserMessageFromResult(
        feedback.errors,
        feedback.commandResults.map((step) => ({ error: step.error })),
      )
    : null;

  if ((initiallyCompact || collapseSuccessfulDetails) && !expanded) {
    return (
      <button
        type="button"
        data-canvas-command-feedback-key={feedback.key}
        data-canvas-command-feedback-signature={canvasCommandFeedbackDedupeKey(feedback)}
        onClick={() => setExpanded(true)}
        className={cn(
          "mt-2 flex w-fit max-w-full items-center gap-1.5 rounded-md px-0 py-1 text-left text-xs font-medium",
          collapseSuccessfulDetails
            ? "text-emerald-300/90 hover:text-emerald-200"
            : mutedFailure
              ? "text-muted-foreground hover:text-foreground/80"
              : invalidCommand
                ? "text-amber-300/90 hover:text-amber-200"
                : "text-destructive/90 hover:text-destructive",
        )}
      >
        <span className="truncate">{collapseSuccessfulDetails ? `画布执行完成，已执行 ${successfulCount} 项` : compactTitle}</span>
        <ChevronRight className="size-3.5 shrink-0" />
      </button>
    );
  }

  return (
    <div
      className={cn(
        "mt-3 w-full min-w-0 overflow-hidden rounded-xl border text-xs text-muted-foreground",
        mutedFailure
          ? "border-white/[0.10] bg-background/80 backdrop-blur-sm"
          : invalidCommand
            ? "border-amber-400/20 bg-amber-400/[0.035]"
            : failed
              ? "border-destructive/20 bg-destructive/[0.035]"
              : "border-white/[0.10] bg-background/90 backdrop-blur-sm",
      )}
      data-canvas-command-feedback-key={feedback.key}
      data-canvas-command-feedback-signature={canvasCommandFeedbackDedupeKey(feedback)}
    >
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2 text-foreground/90">
        <Wrench className="size-3.5" />
        <span className="font-medium">画布执行</span>
        {(initiallyCompact || collapseSuccessfulDetails) && (
          <button type="button" onClick={() => setExpanded(false)} className="ml-auto rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground">收起</button>
        )}
        {successfulCount > 0 && <span className={cn("text-[11px] text-muted-foreground", !initiallyCompact && "ml-auto")}>已执行 {successfulCount} 项</span>}
      </div>
      {expanded && <CanvasCommandPlanList plans={feedback.plans} />}
      <div className="space-y-1 px-3 py-2">
        {userFailureMessage && (
          <div className={cn(
            "mb-1 rounded-md px-2 py-1.5 leading-5",
            mutedFailure
              ? "bg-white/[0.035] text-muted-foreground"
              : invalidCommand
                ? "bg-amber-400/[0.06] text-amber-100/90"
                : "bg-destructive/[0.06] text-destructive",
          )}>
            {userFailureMessage}
          </div>
        )}
        {steps.map((step, index) => {
          const ok = step.status === "success";
          return (
            <div key={`${step.commandIndex}-${step.type}-${step.nodeId ?? ""}-${step.action ?? ""}-${index}`} className="flex items-start gap-2 leading-5">
              {ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-400" /> : <AlertCircle className={cn("mt-0.5 size-3.5 shrink-0", mutedFailure ? "text-muted-foreground" : invalidCommand ? "text-amber-300" : "text-destructive")} />}
              <div className="min-w-0 flex-1">
                <div className={cn("font-medium", ok ? "text-foreground/90" : mutedFailure ? "text-muted-foreground" : invalidCommand ? "text-amber-300" : "text-destructive")}>{step.label}</div>
                {(step.createdNodeId || step.nodeId || step.action || step.error) && (
                  <div className="mt-0.5 space-y-0.5 break-words text-[11px] text-muted-foreground">
                    {step.createdNodeId && <div>新节点：{step.createdNodeId}</div>}
                    {!step.createdNodeId && step.nodeId && <div>节点：{step.nodeId}</div>}
                    {step.action && <div>动作：{step.action}</div>}
                    {step.error && ok && <div className={invalidCommand ? "text-amber-200/80" : "text-destructive"}>{step.error}</div>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {steps.length === 0 && successfulCount > 0 && (
          <div className="flex items-center gap-2 text-foreground/90">
            <CheckCircle2 className="size-3.5 text-emerald-400" />
            <span>已应用 {successfulCount} 个画布操作</span>
          </div>
        )}
        {feedback.errors.length > 0 && steps.length === 0 && !userFailureMessage && (
          <div className={cn("break-words", invalidCommand ? "text-amber-200/80" : "text-destructive")}>{feedback.errors.join("; ")}</div>
        )}
      </div>
    </div>
  );
}

type SkillStudioQuestionOption = {
  id?: string;
  label?: string;
  description?: string;
};

type SkillStudioQuestion = {
  id?: string;
  title?: string;
  selection_mode?: "single" | "multiple";
  selectionMode?: "single" | "multiple";
  allow_custom?: boolean;
  allowCustom?: boolean;
  options?: SkillStudioQuestionOption[];
};

type SkillStudioQuestionSelection = {
  option_ids?: string[];
  option_id?: string;
  custom_text?: string;
  customText?: string;
};

type SkillStudioQuestionSelections = Record<string, string | string[] | SkillStudioQuestionSelection>;

type AssistantClarificationQuestion = SkillStudioQuestion & {
  mode?: "single" | "multiple";
};

type AssistantClarificationAnswers = SkillStudioQuestionSelections;

type AssistantClarificationUiEvent = {
  type: "assistant.clarification.request";
  bridge_key?: string;
  project_id?: string | null;
  canvas_id?: string | null;
  agent_id?: string | null;
  turn_id?: string | null;
  anchor_text_prefix?: string | null;
  received_at?: number;
  receivedAt?: number;
  clarification_id?: string;
  title?: string;
  description?: string;
  questions?: AssistantClarificationQuestion[];
  allow_recommended?: boolean;
  allow_skip?: boolean;
  submitted?: boolean;
  action?: string;
  clarification_status?: string;
  answers?: AssistantClarificationAnswers;
  skipped?: boolean;
  used_recommended?: boolean;
};

type SkillStudioUiEvent =
  | {
      type: "skill_studio.status";
      status?: string;
      message?: string;
      turn_id?: string | null;
      anchor_text_prefix?: string | null;
      received_at?: number;
      receivedAt?: number;
    }
  | {
      type: "skill_studio.questions";
      bridge_key?: string;
      project_id?: string | null;
      canvas_id?: string | null;
      agent_id?: string | null;
      turn_id?: string | null;
      anchor_text_prefix?: string | null;
      received_at?: number;
      receivedAt?: number;
      skill_studio_session_id?: string;
      title?: string;
      description?: string;
      questions?: SkillStudioQuestion[];
      allow_recommended?: boolean;
      allow_skip?: boolean;
      submitted?: boolean;
      action?: string;
      selections?: SkillStudioQuestionSelections;
    }
  | {
      type: "skill_studio.draft";
      bridge_key?: string;
      project_id?: string | null;
      canvas_id?: string | null;
      agent_id?: string | null;
      turn_id?: string | null;
      anchor_text_prefix?: string | null;
      received_at?: number;
      receivedAt?: number;
      skill_studio_session_id?: string;
      mode?: string;
      summary?: string;
      skill?: Record<string, unknown>;
      recipes?: Array<Record<string, unknown>>;
      warnings?: unknown[];
      draft?: Record<string, unknown>;
      submitted?: boolean;
      cancelled?: boolean;
      revision_pending?: boolean;
      action?: string;
      skill_studio_status?: string;
      saved_to_catalog?: boolean;
      saved_skill_ids?: string[];
      saved_recipe_ids?: string[];
    };

function uiEventRecordString(value: Record<string, unknown>, key: string): string | null {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : null;
}

function uiEventStableKey(event: unknown): string | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const value = event as Record<string, unknown>;
  const type = uiEventRecordString(value, "type");
  if (!type) return null;
  if (type === "skill_studio.status") return type;
  const stableId =
    uiEventRecordString(value, "bridge_key")
    ?? uiEventRecordString(value, "skill_studio_session_id")
    ?? uiEventRecordString(value, "clarification_id");
  return stableId ? `${type}:${stableId}` : null;
}

function uiEventReceivedAt(event: unknown): number | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const value = event as Record<string, unknown>;
  if (typeof value.received_at === "number" && Number.isFinite(value.received_at)) return value.received_at;
  if (typeof value.receivedAt === "number" && Number.isFinite(value.receivedAt)) return value.receivedAt;
  return null;
}

function uiEventFirstReceivedAt(...events: unknown[]): number {
  for (const event of events) {
    const receivedAt = uiEventReceivedAt(event);
    if (receivedAt != null) return receivedAt;
  }
  return Date.now();
}

function skillStudioStatusPriority(event: unknown): number {
  if (!event || typeof event !== "object" || Array.isArray(event)) return 0;
  const value = event as Record<string, unknown>;
  if (value.type !== "skill_studio.status") return 0;
  const status = typeof value.status === "string" ? value.status : "";
  if (status === "draft_recipe_ready") return 4;
  if (status === "draft_skill_ready") return 3;
  if (status === "draft_begin") return 2;
  if (status === "finalizing" || status === "drafting" || status === "routing") return 1;
  return 1;
}

function isRealSkillStudioProgressStatus(event: unknown): boolean {
  return skillStudioStatusPriority(event) >= 2;
}

function filterStaleSkillStudioStatus(events: SkillStudioUiEvent[]): SkillStudioUiEvent[] {
  return events.filter((event) => event.type !== "skill_studio.status" || isRealSkillStudioProgressStatus(event));
}

function shouldReplaceStableUiEvent(existing: unknown, next: unknown): boolean {
  const existingKey = uiEventStableKey(existing);
  if (existingKey !== "skill_studio.status") return true;
  return skillStudioStatusPriority(next) >= skillStudioStatusPriority(existing);
}

function mergeUiEventsByStableKey<T>(events: T[]): T[] {
  const merged: T[] = [];
  for (const event of events) {
    const key = uiEventStableKey(event);
    if (!key) {
      merged.push(event);
      continue;
    }
    const existingIndex = merged.findIndex((candidate) => uiEventStableKey(candidate) === key);
    if (existingIndex >= 0) {
      if (!shouldReplaceStableUiEvent(merged[existingIndex], event)) continue;
      const existingReceivedAt = uiEventReceivedAt(merged[existingIndex]);
      const nextReceivedAt = uiEventReceivedAt(event);
      const firstReceivedAt =
        existingReceivedAt == null
          ? nextReceivedAt
          : nextReceivedAt == null
            ? existingReceivedAt
            : Math.min(existingReceivedAt, nextReceivedAt);
      merged[existingIndex] = {
        ...(merged[existingIndex] as Record<string, unknown>),
        ...(event as Record<string, unknown>),
        ...(firstReceivedAt == null ? {} : { received_at: firstReceivedAt }),
      } as T;
    } else {
      merged.push(event);
    }
  }
  return merged;
}

function hydrateOrderedPartsWithUiEvents(
  parts: ChatMessagePart[] | undefined,
  uiEvents: unknown[] | undefined,
): ChatMessagePart[] | undefined {
  if (!parts?.length || !uiEvents?.length) return parts;
  const eventByKey = new Map<string, unknown>();
  for (const event of mergeUiEventsByStableKey(uiEvents)) {
    const key = uiEventStableKey(event);
    if (key) eventByKey.set(key, event);
  }
  if (eventByKey.size === 0) return parts;
  let changed = false;
  const nextParts = parts.map((part) => {
    if (part.type === "text") return part;
    const key = uiEventStableKey(part.event);
    const latestEvent = key ? eventByKey.get(key) : undefined;
    if (!latestEvent || latestEvent === part.event) return part;
    changed = true;
    return { ...part, event: latestEvent };
  });
  return changed ? nextParts : parts;
}

export const hydrateOrderedPartsWithUiEventsForTest = hydrateOrderedPartsWithUiEvents;

function skillStudioEventsFromUiEvents(events: unknown[] | undefined): SkillStudioUiEvent[] {
  if (!events || events.length === 0) return [];
  const rawSkillStudioEvents = events.filter((event): event is SkillStudioUiEvent => {
    if (!event || typeof event !== "object") return false;
    const type = (event as Record<string, unknown>).type;
    return type === "skill_studio.status" || type === "skill_studio.questions" || type === "skill_studio.draft";
  });
  const skillStudioEvents = mergeUiEventsByStableKey(rawSkillStudioEvents) as SkillStudioUiEvent[];
  const hasInteractiveCard = skillStudioEvents.some((event) =>
    event.type === "skill_studio.questions" || event.type === "skill_studio.draft",
  );
  return hasInteractiveCard
    ? filterStaleSkillStudioStatus(skillStudioEvents)
    : skillStudioEvents;
}

export const skillStudioEventsFromUiEventsForTest = skillStudioEventsFromUiEvents;

function visibleSkillStudioEventsForMessage(message: ChatMessage): SkillStudioUiEvent[] {
  const events = skillStudioEventsFromUiEvents(messageUiEvents(message));
  const visibleEvents = events.filter((event) =>
    !(event.type === "skill_studio.questions" && event.submitted !== true),
  );
  const hasClarificationCard = assistantClarificationEventsFromUiEvents(messageUiEvents(message)).length > 0;
  if (hasClarificationCard) return filterStaleSkillStudioStatus(visibleEvents);
  const hasSubmittedCard = visibleEvents.some((event) =>
    (event.type === "skill_studio.questions" || event.type === "skill_studio.draft") && event.submitted === true,
  );
  if (hasSubmittedCard) return filterStaleSkillStudioStatus(visibleEvents);
  if (!message.text.trim()) return visibleEvents;
  return visibleEvents.filter((event) => event.type !== "skill_studio.status");
}

export const visibleSkillStudioEventsForMessageForTest = visibleSkillStudioEventsForMessage;

function uiEventsAfterLatestSkillStudioDraft(events: unknown[] | undefined): unknown[] | undefined {
  if (!events?.length) return events;
  let latestDraftIndex = -1;
  for (const [index, event] of events.entries()) {
    if (
      event
      && typeof event === "object"
      && !Array.isArray(event)
      && (event as Record<string, unknown>).type === "skill_studio.draft"
    ) {
      latestDraftIndex = index;
    }
  }
  return latestDraftIndex >= 0 ? events.slice(latestDraftIndex + 1) : events;
}

function pendingSkillStudioQuestionEventsForMessage(message: ChatMessage): Extract<SkillStudioUiEvent, { type: "skill_studio.questions" }>[] {
  return skillStudioEventsFromUiEvents(uiEventsAfterLatestSkillStudioDraft(messageUiEvents(message)))
    .filter((event): event is Extract<SkillStudioUiEvent, { type: "skill_studio.questions" }> =>
      event.type === "skill_studio.questions" && event.submitted !== true,
    );
}

function messageHasSkillStudioCardEvent(message: ChatMessage): boolean {
  if (message.role !== "assistant") return false;
  return skillStudioEventsFromUiEvents(messageUiEvents(message)).some((event) =>
    event.type === "skill_studio.questions" || event.type === "skill_studio.draft",
  );
}

function messageHasSubmittedSkillStudioCardEvent(message: ChatMessage): boolean {
  if (message.role !== "assistant") return false;
  return skillStudioEventsFromUiEvents(messageUiEvents(message)).some((event) =>
    (event.type === "skill_studio.questions" || event.type === "skill_studio.draft") && event.submitted === true,
  );
}

function messageIsSkillStudioStatusOnly(message: ChatMessage): boolean {
  if (message.role !== "assistant" || message.text.trim()) return false;
  const events = skillStudioEventsFromUiEvents(messageUiEvents(message));
  return events.length > 0 && events.every((event) => event.type === "skill_studio.status");
}

function shouldHideSkillStudioStatusOnlyMessage(message: ChatMessage, submittedTurnIds: Set<string>): boolean {
  return Boolean(message.turnId && submittedTurnIds.has(message.turnId) && messageIsSkillStudioStatusOnly(message));
}

export const shouldHideSkillStudioStatusOnlyMessageForTest = shouldHideSkillStudioStatusOnlyMessage;

function visibleCanvasContextActivitiesForMessage(
  message: ChatMessage,
  activities: CanvasContextActivity[],
): CanvasContextActivity[] {
  if (!messageHasSkillStudioCardEvent(message)) return activities;
  return activities.filter(canvasContextActivityIsValidation);
}

export const visibleCanvasContextActivitiesForMessageForTest = visibleCanvasContextActivitiesForMessage;

function latestPendingSkillStudioQuestionEvent(messages: ChatMessage[]): Extract<SkillStudioUiEvent, { type: "skill_studio.questions" }> | null {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    const pendingEvents = pendingSkillStudioQuestionEventsForMessage(message);
    const event = pendingEvents[pendingEvents.length - 1];
    if (event) return event;
  }
  return null;
}

export const latestPendingSkillStudioQuestionEventForTest = latestPendingSkillStudioQuestionEvent;

type ActiveComposerPromptScope = {
  busy: boolean;
  activeTurnId: string | null;
};

function activeTurnMessages(messages: ChatMessage[], scope: ActiveComposerPromptScope): ChatMessage[] {
  if (!scope.busy || !scope.activeTurnId) return [];
  return messages.filter((message) => message.turnId === scope.activeTurnId);
}

function latestPendingSkillStudioQuestionEventForActiveTurn(
  messages: ChatMessage[],
  scope: ActiveComposerPromptScope,
): Extract<SkillStudioUiEvent, { type: "skill_studio.questions" }> | null {
  return latestPendingSkillStudioQuestionEvent(activeTurnMessages(messages, scope));
}

export const latestPendingSkillStudioQuestionEventForActiveTurnForTest = latestPendingSkillStudioQuestionEventForActiveTurn;

function assistantClarificationEventsFromUiEvents(events: unknown[] | undefined): AssistantClarificationUiEvent[] {
  if (!events || events.length === 0) return [];
  return mergeUiEventsByStableKey(events.filter((event): event is AssistantClarificationUiEvent => {
    if (!event || typeof event !== "object") return false;
    return (event as Record<string, unknown>).type === "assistant.clarification.request";
  })) as AssistantClarificationUiEvent[];
}

function visibleAssistantClarificationEventsForMessage(message: ChatMessage): AssistantClarificationUiEvent[] {
  return assistantClarificationEventsFromUiEvents(messageUiEvents(message)).filter((event) => event.submitted === true);
}

function pendingAssistantClarificationEventsForMessage(message: ChatMessage): AssistantClarificationUiEvent[] {
  return assistantClarificationEventsFromUiEvents(uiEventsAfterLatestSkillStudioDraft(messageUiEvents(message)))
    .filter((event) => event.submitted !== true);
}

function assistantClarificationIsAfterRevisionPendingDraft(
  message: ChatMessage,
  event: AssistantClarificationUiEvent,
): boolean {
  const events = messageUiEvents(message) ?? [];
  let seenRevisionPendingDraft = false;
  const targetIdentity = assistantClarificationEventIdentity(event);
  for (const candidate of events) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const value = candidate as Record<string, unknown>;
    if (value.type === "skill_studio.draft" && value.revision_pending === true) {
      seenRevisionPendingDraft = true;
      continue;
    }
    if (value.type !== "assistant.clarification.request") continue;
    const candidateEvent = value as AssistantClarificationUiEvent;
    if (assistantClarificationEventIdentity(candidateEvent) === targetIdentity) {
      return seenRevisionPendingDraft;
    }
  }
  return false;
}

function activeAssistantClarificationIsSkillStudioRevision(
  messages: ChatMessage[],
  event: AssistantClarificationUiEvent,
): boolean {
  return messages.some((message) =>
    message.role === "assistant" && assistantClarificationIsAfterRevisionPendingDraft(message, event),
  );
}

export const activeAssistantClarificationIsSkillStudioRevisionForTest = activeAssistantClarificationIsSkillStudioRevision;

function latestPendingAssistantClarificationEvent(messages: ChatMessage[]): AssistantClarificationUiEvent | null {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    const pendingEvents = pendingAssistantClarificationEventsForMessage(message);
    const event = pendingEvents[pendingEvents.length - 1];
    if (event) return event;
  }
  return null;
}

export const latestPendingAssistantClarificationEventForTest = latestPendingAssistantClarificationEvent;

function latestPendingAssistantClarificationEventForActiveTurn(
  messages: ChatMessage[],
  scope: ActiveComposerPromptScope,
): AssistantClarificationUiEvent | null {
  return latestPendingAssistantClarificationEvent(activeTurnMessages(messages, scope));
}

export const latestPendingAssistantClarificationEventForActiveTurnForTest = latestPendingAssistantClarificationEventForActiveTurn;

function messageIsWaitingForUserReply(message: ChatMessage): boolean {
  if (message.role !== "assistant") return false;
  return pendingSkillStudioQuestionEventsForMessage(message).length > 0
    || pendingAssistantClarificationEventsForMessage(message).length > 0;
}

export const messageIsWaitingForUserReplyForTest = messageIsWaitingForUserReply;

type SkillStudioFlowItem =
  | { kind: "text"; key: string; text: string }
  | { kind: "event"; key: string; event: SkillStudioUiEvent };

type AssistantInteractionFlowEvent =
  | { kind: "skill_studio"; key: string; order: number; event: SkillStudioUiEvent }
  | { kind: "clarification"; key: string; order: number; event: AssistantClarificationUiEvent };

type AssistantInteractionFlowItem =
  | { kind: "text"; key: string; text: string }
  | { kind: "skill_studio"; key: string; event: SkillStudioUiEvent }
  | { kind: "clarification"; key: string; event: AssistantClarificationUiEvent };

const skillStudioDraftFieldLabels = {
  skill: {
    id: "ID",
    category: "Category",
    description: "Description",
    keywords: "触发关键词",
    node_scopes: "节点类型",
    metaPlanningHints: "规划器提示词",
    promptStyleGuide: "风格指引",
    behaviorRules: "行为规则",
    passingScore: "通过分数线",
    domainRules: "领域规则",
    ratingBands: "评分档位",
    visualReviewItems: "视觉评审项",
    textReviewItems: "文案评审项",
  },
  recipe: {
    id: "ID",
    name: "名称",
    output_kind: "生成类型",
    action_keys: "操作类型",
    system_prompt: "System Prompt",
    must_have_items: "必需元素",
    planning_prompt: "规划器提示词",
    result_summary: "输出概述",
    requires_source_media: "依赖上游多模态输入",
    enabled: "启用",
    force_enhancement: "强制增强",
    skip_detail_check: "跳过细节检查",
  },
};

export const skillStudioDraftFieldLabelsForTest = skillStudioDraftFieldLabels;

function buildSkillStudioFlowItems(text: string, events: SkillStudioUiEvent[]): SkillStudioFlowItem[] {
  if (events.length === 0) {
    return text ? [{ kind: "text", key: "text:0", text }] : [];
  }
  const anchored: Array<{ event: SkillStudioUiEvent; index: number; offset: number }> = [];
  for (const [index, event] of events.entries()) {
    const anchor = typeof event.anchor_text_prefix === "string" ? event.anchor_text_prefix : "";
    if (anchor && text.startsWith(anchor)) {
      anchored.push({ event, index, offset: anchor.length });
    }
  }
  anchored.sort((left, right) => left.offset - right.offset || left.index - right.index);
  const anchoredIndexes = new Set(anchored.map((item) => item.index));
  const items: SkillStudioFlowItem[] = [];
  let cursor = 0;
  for (const item of anchored) {
    if (item.offset > cursor) {
      items.push({ kind: "text", key: `text:${cursor}`, text: text.slice(cursor, item.offset) });
      cursor = item.offset;
    }
    items.push({ kind: "event", key: `${item.event.type}:${item.index}`, event: item.event });
  }
  if (text.slice(cursor)) {
    items.push({ kind: "text", key: `text:${cursor}`, text: text.slice(cursor) });
  }
  for (const [index, event] of events.entries()) {
    if (!anchoredIndexes.has(index)) {
      items.push({ kind: "event", key: `${event.type}:${index}`, event });
    }
  }
  return items;
}

export const buildSkillStudioFlowItemsForTest = buildSkillStudioFlowItems;

function commonPrefixLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) index += 1;
  return index;
}

function assistantInteractionEventAnchorEndIndex(text: string, event: AssistantInteractionFlowEvent): number {
  const hasAnchor = typeof event.event.anchor_text_prefix === "string";
  const anchor = hasAnchor ? event.event.anchor_text_prefix ?? "" : "";
  if (!hasAnchor || !anchor) return 0;
  if (text.startsWith(anchor)) return anchor.length;
  const sharedPrefixLength = commonPrefixLength(text, anchor);
  if (sharedPrefixLength >= Math.min(16, text.length, anchor.length)) return sharedPrefixLength;
  return text.length;
}

function assistantInteractionEventOrder(event: AssistantInteractionFlowEvent): number {
  return uiEventReceivedAt(event.event) ?? event.order;
}

function buildAssistantInteractionFlowItems(
  text: string,
  skillStudioEvents: SkillStudioUiEvent[],
  clarificationEvents: AssistantClarificationUiEvent[],
): AssistantInteractionFlowItem[] {
  const events: AssistantInteractionFlowEvent[] = [
    ...clarificationEvents.map((event, index): AssistantInteractionFlowEvent => ({
      kind: "clarification",
      key: `clarification:${event.bridge_key || event.clarification_id || index}`,
      order: index,
      event,
    })),
    ...skillStudioEvents.map((event, index): AssistantInteractionFlowEvent => ({
      kind: "skill_studio",
      key: `skill_studio:${event.type}:${uiEventRecordString(event as Record<string, unknown>, "bridge_key") ?? uiEventRecordString(event as Record<string, unknown>, "skill_studio_session_id") ?? index}`,
      order: clarificationEvents.length + index,
      event,
    })),
  ].sort((left, right) => {
    const leftIndex = assistantInteractionEventAnchorEndIndex(text, left);
    const rightIndex = assistantInteractionEventAnchorEndIndex(text, right);
    return leftIndex - rightIndex || assistantInteractionEventOrder(left) - assistantInteractionEventOrder(right) || left.order - right.order;
  });
  if (events.length === 0) {
    return text ? [{ kind: "text", key: "text:0", text }] : [];
  }
  const items: AssistantInteractionFlowItem[] = [];
  let cursor = 0;
  for (const event of events) {
    const anchorEnd = assistantInteractionEventAnchorEndIndex(text, event);
    const nextCursor = Math.max(cursor, Math.min(anchorEnd, text.length));
    if (nextCursor > cursor) {
      items.push({ kind: "text", key: `text:${cursor}:${nextCursor}`, text: text.slice(cursor, nextCursor) });
      cursor = nextCursor;
    }
    if (event.kind === "clarification") {
      items.push({ kind: "clarification", key: event.key, event: event.event });
    } else {
      items.push({ kind: "skill_studio", key: event.key, event: event.event });
    }
  }
  if (text.slice(cursor)) {
    items.push({ kind: "text", key: `text:${cursor}`, text: text.slice(cursor) });
  }
  return items;
}

export const buildAssistantInteractionFlowItemsForTest = buildAssistantInteractionFlowItems;

function canvasContextActivityCollapseKey(activity: CanvasContextActivity): string | null {
  if (activity.errors.length > 0) return null;
  return JSON.stringify({
    status: activity.status,
    labels: activity.labels,
  });
}

function mergeRepeatedCanvasContextActivity(
  existing: CanvasContextActivity,
  next: CanvasContextActivity,
): CanvasContextActivity {
  return {
    ...existing,
    repeatCount: (existing.repeatCount ?? 1) + (next.repeatCount ?? 1),
  };
}

function collapseRepeatedCanvasStatusFlowItems(items: CanvasCommandFlowItem[]): CanvasCommandFlowItem[] {
  if (items.length < 2) return items;
  const collapsed: CanvasCommandFlowItem[] = [];
  for (const item of items) {
    const previous = collapsed[collapsed.length - 1];
    if (item.kind === "context" && previous?.kind === "context") {
      const currentKey = canvasContextActivityCollapseKey(item.activity);
      const previousKey = canvasContextActivityCollapseKey(previous.activity);
      if (currentKey && currentKey === previousKey) {
        collapsed[collapsed.length - 1] = {
          ...previous,
          key: `${previous.key}+${item.key}`,
          activity: mergeRepeatedCanvasContextActivity(previous.activity, item.activity),
        };
        continue;
      }
    }
    collapsed.push(item);
  }
  return collapsed;
}

export const collapseRepeatedCanvasStatusFlowItemsForTest = collapseRepeatedCanvasStatusFlowItems;

function collapseRepeatedCanvasStatusParts(parts: ChatMessagePart[]): ChatMessagePart[] {
  if (parts.length < 2) return parts;
  const collapsed: ChatMessagePart[] = [];
  for (const part of parts) {
    const previous = collapsed[collapsed.length - 1];
    if (
      part.type === "canvas_context"
      && previous?.type === "canvas_context"
      && part.event
      && previous.event
      && typeof part.event === "object"
      && !Array.isArray(part.event)
      && typeof previous.event === "object"
      && !Array.isArray(previous.event)
    ) {
      const currentActivity = part.event as CanvasContextActivity;
      const previousActivity = previous.event as CanvasContextActivity;
      const currentKey = canvasContextActivityCollapseKey(currentActivity);
      const previousKey = canvasContextActivityCollapseKey(previousActivity);
      if (currentKey && currentKey === previousKey) {
        collapsed[collapsed.length - 1] = {
          ...previous,
          id: `${previous.id}+${part.id}`,
          event: mergeRepeatedCanvasContextActivity(previousActivity, currentActivity),
        };
        continue;
      }
    }
    collapsed.push(part);
  }
  return collapsed;
}

export const collapseRepeatedCanvasStatusPartsForTest = collapseRepeatedCanvasStatusParts;

function messageHasSkillStudioUiEvent(message: ChatMessage): boolean {
  return skillStudioEventsFromUiEvents(messageUiEvents(message)).length > 0;
}

export const messageHasSkillStudioUiEventForTest = messageHasSkillStudioUiEvent;

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}

function parseListText(value: string): string[] {
  return value
    .split(/[,，、\n]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function listText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? "").trim()).filter(Boolean).join("、");
  }
  if (typeof value === "string") {
    return parseListText(value).join("、") || value.trim();
  }
  return "";
}

function stringListField(...values: unknown[]): string[] {
  for (const value of values) {
    if (Array.isArray(value)) return cleanStringArray(value);
    if (typeof value === "string" && value.trim()) return parseListText(value);
  }
  return [];
}

function skillStudioRatingBandList(value: unknown): string[] {
  return getRecordArray(value)
    .map((item) => {
      const score = typeof item.score === "number" && Number.isFinite(item.score)
        ? String(item.score)
        : textField(item.score);
      const description = textField(item.description);
      if (score && description) return `${score}：${description}`;
      return description || score;
    })
    .filter(Boolean);
}

function parseSkillStudioRatingBandList(value: string[]): Array<Record<string, unknown>> {
  return value.map((item) => {
    const [scoreText, ...descriptionParts] = item.split(/[：:]/u);
    const description = descriptionParts.join("：").trim();
    const score = Number(scoreText.trim());
    if (Number.isFinite(score) && description) {
      return { score, description };
    }
    return { score: Number.isFinite(score) ? score : 0, description: item.trim() };
  });
}

function skillStudioReviewItemList(value: unknown): string[] {
  return getRecordArray(value)
    .map((item) => {
      const name = textField(item.name);
      const weight = typeof item.weight === "number" && Number.isFinite(item.weight)
        ? String(item.weight)
        : textField(item.weight);
      const description = textField(item.description);
      const prefix = weight ? `${name}（${weight}）` : name;
      if (prefix && description) return `${prefix}：${description}`;
      return description || prefix;
    })
    .filter(Boolean);
}

function parseSkillStudioReviewItemList(value: string[]): Array<Record<string, unknown>> {
  return value.map((item) => {
    const [nameAndWeight, ...descriptionParts] = item.split(/[：:]/u);
    const description = descriptionParts.join("：").trim();
    const weightMatch = nameAndWeight.match(/^(.*?)（([^）]+)）$/u);
    const name = (weightMatch?.[1] ?? nameAndWeight).trim();
    const weight = weightMatch ? Number(weightMatch[2].trim()) : undefined;
    return {
      name,
      ...(Number.isFinite(weight) ? { weight } : {}),
      description,
    };
  });
}

function skillStudioEvaluationDraftFields(evaluation: Record<string, unknown>) {
  return {
    qualityThreshold: evaluation.quality_threshold,
    domainConstraints: stringListField(evaluation.domain_constraints),
    ratingBands: skillStudioRatingBandList(evaluation.rating_bands),
    visualReviewItems: skillStudioReviewItemList(evaluation.visual_review_items),
    textReviewItems: skillStudioReviewItemList(evaluation.text_review_items),
  };
}

export const skillStudioEvaluationDraftFieldsForTest = skillStudioEvaluationDraftFields;

function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function getRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function cleanStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
}

function isSkillStudioRecipeOutputKind(value: unknown): value is "text" | "image" | "video" | "audio" {
  return value === "text" || value === "image" || value === "video" || value === "audio";
}

type SkillStudioCatalogSaveItem = {
  kind: FreezoneAgentConfigKind;
  payload: FreezoneAgentConfigPayload;
};

function firstNonEmptyText(...values: unknown[]): string {
  for (const value of values) {
    const text = textField(value);
    if (text) return text;
  }
  return "";
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function numberOrRawText(value: string): number | string {
  if (!value.trim()) return "";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function normalizedSkillStudioSkillPayload(skill: Record<string, unknown>): FreezoneAgentConfigPayload {
  const triggers = getRecord(skill.triggers);
  const planning = getRecord(skill.planning);
  const evaluation = getRecord(skill.evaluation);
  const visual = getRecord(evaluation.visual);
  const text = getRecord(evaluation.text);
  const workflowTemplates = normalizedSkillStudioWorkflowTemplates(
    skill.workflow_templates ?? skill.workflowTemplates,
  );
  const payload: FreezoneAgentConfigPayload = {
    id: textField(skill.id),
    enabled: skill.enabled !== false,
    description: textField(skill.description),
    category: firstNonEmptyText(skill.category, "general"),
    triggers: {
      keywords: cleanStringArray(triggers.keywords),
      node_scopes: cleanStringArray(
        triggers.node_scopes ?? triggers.nodeTypes ?? triggers.node_types,
      ),
    },
    planning: {
      planning_notes: firstNonEmptyText(planning.planning_notes, planning.metaPlanningHints),
      prompt_guide: firstNonEmptyText(planning.prompt_guide, planning.promptStyleGuide),
      conduct_rules: cleanStringArray(planning.conduct_rules ?? planning.behaviorRules),
      default_aspect_ratios: normalizedSkillStudioDefaultAspectRatios(
        planning.default_aspect_ratios ?? planning.defaultAspectRatios,
      ),
    },
    evaluation: {
      rating_bands: getRecordArray(evaluation.rating_bands ?? evaluation.scoreAnchors).map((item) => ({
        score: optionalFiniteNumber(item.score) ?? 0,
        description: textField(item.description),
      })),
      quality_threshold: optionalFiniteNumber(evaluation.quality_threshold ?? evaluation.passingScore),
      domain_constraints: cleanStringArray(evaluation.domain_constraints ?? evaluation.domainRules),
      visual_review_items: getRecordArray(
        evaluation.visual_review_items ?? visual.dimensions,
      ).map(normalizedSkillStudioReviewItem),
      text_review_items: getRecordArray(
        evaluation.text_review_items ?? text.dimensions,
      ).map(normalizedSkillStudioReviewItem),
    },
  };
  if (workflowTemplates.length > 0) {
    payload.workflow_templates = workflowTemplates;
  }
  return payload;
}

const SKILL_STUDIO_IMAGE_ASPECT_RATIOS = new Set([
  "1:1",
  "9:16",
  "16:9",
  "3:4",
  "4:3",
  "3:2",
  "2:3",
  "4:5",
  "5:4",
  "21:9",
]);

const SKILL_STUDIO_VIDEO_ASPECT_RATIOS = new Set([
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
  "21:9",
]);

function normalizedSkillStudioDefaultAspectRatios(value: unknown): Record<string, string> {
  const ratios = getRecord(value);
  const next: Record<string, string> = {};
  const imageRatio = textField(ratios.imageGeneration);
  if (SKILL_STUDIO_IMAGE_ASPECT_RATIOS.has(imageRatio)) {
    next.imageGeneration = imageRatio;
  }
  const videoRatio = textField(ratios.videoGeneration);
  if (SKILL_STUDIO_VIDEO_ASPECT_RATIOS.has(videoRatio)) {
    next.videoGeneration = videoRatio;
  }
  return next;
}

function normalizedSkillStudioReviewItem(item: Record<string, unknown>) {
  return {
    name: textField(item.name),
    weight: optionalFiniteNumber(item.weight) ?? 1,
    description: textField(item.description),
  };
}

function normalizedSkillStudioWorkflowTemplates(value: unknown): Array<Record<string, unknown>> {
  return getRecordArray(value).map((template) => {
    const steps = getRecordArray(template.steps);
    return {
      ...template,
      steps: steps.map((step) => ({
        ...step,
        node_type: normalizedSkillStudioWorkflowNodeType(step.node_type),
      })),
    };
  });
}

function normalizedSkillStudioWorkflowNodeType(value: unknown): string {
  const nodeType = textField(value);
  if (
    nodeType === "textGeneration" ||
    nodeType === "imageGeneration" ||
    nodeType === "videoGeneration" ||
    nodeType === "audioGeneration"
  ) {
    return nodeType;
  }
  if (nodeType === "textAnnotationNode" || nodeType === "scriptNode") return "textGeneration";
  if (nodeType === "imageGenNode" || nodeType === "storyboardGenNode") return "imageGeneration";
  if (nodeType === "videoNode") return "videoGeneration";
  if (nodeType === "audioNode") return "audioGeneration";
  return nodeType;
}

function normalizedSkillStudioRecipePayload(recipe: Record<string, unknown>): FreezoneAgentConfigPayload {
  const outputKind = isSkillStudioRecipeOutputKind(recipe.output_kind)
    ? recipe.output_kind
    : "image";
  return {
    id: textField(recipe.id),
    enabled: recipe.enabled !== false,
    name: textField(recipe.name),
    output_kind: outputKind,
    action_keys: cleanStringArray(recipe.action_keys),
    system_prompt: textField(recipe.system_prompt),
    must_have_items: cleanStringArray(recipe.must_have_items),
    planning_prompt: textField(recipe.planning_prompt),
    result_summary: textField(recipe.result_summary),
    requires_source_media: recipe.requires_source_media === true,
    force_enhancement: recipe.force_enhancement === true,
    skip_detail_check: recipe.skip_detail_check === true,
  };
}

function SkillStudioListField({
  disabled,
  label,
  onChange,
  placeholder,
  value,
}: {
  disabled?: boolean;
  label: string;
  onChange: (value: string[]) => void;
  placeholder?: string;
  value: string[];
}) {
  const [draft, setDraft] = useState("");
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const addDraft = useCallback(() => {
    const nextItems = parseListText(draft);
    if (nextItems.length === 0) return;
    onChange(Array.from(new Set([...value, ...nextItems])));
    setDraft("");
  }, [draft, onChange, value]);
  const removeItem = useCallback((indexToRemove: number) => {
    onChange(value.filter((_, index) => index !== indexToRemove));
  }, [onChange, value]);
  const beginEditItem = useCallback((index: number, item: string) => {
    setEditingIndex(index);
    setEditingDraft(item);
    requestAnimationFrame(() => editInputRef.current?.focus({ preventScroll: true }));
  }, []);
  const commitEditItem = useCallback(() => {
    if (editingIndex === null) return;
    const nextItem = editingDraft.trim();
    const nextItems = nextItem
      ? value.map((item, index) => (index === editingIndex ? nextItem : item))
      : value.filter((_, index) => index !== editingIndex);
    onChange(Array.from(new Set(nextItems.filter(Boolean))));
    setEditingIndex(null);
    setEditingDraft("");
  }, [editingDraft, editingIndex, onChange, value]);

  return (
    <div className="block">
      <span className="mb-1 block text-[11px] font-medium text-muted-foreground">{label}</span>
      <div
        className={cn(
          "flex min-h-8 flex-wrap items-center gap-1.5 rounded-lg border border-white/[0.08] bg-black/20 px-2 py-1",
          "transition-colors focus-within:border-cyan-200/25 focus-within:ring-1 focus-within:ring-cyan-300/20",
          disabled && "opacity-70",
        )}
      >
        {value.map((item, index) => (
          <span
            key={`${item}:${index}`}
            className="inline-flex min-h-6 max-w-full items-center gap-1 rounded-md bg-white/[0.07] px-2 py-0.5 text-xs text-foreground"
          >
            {editingIndex === index ? (
              <input
                ref={editInputRef}
                aria-label={`编辑 ${item}`}
                value={editingDraft}
                onChange={(event) => setEditingDraft(event.target.value)}
                onBlur={commitEditItem}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitEditItem();
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setEditingIndex(null);
                    setEditingDraft("");
                  }
                }}
                style={{ width: `${Math.min(Math.max(editingDraft.length + 1.5, 4.5), 26)}em` }}
                className="h-5 max-w-full rounded-sm bg-black/20 px-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-cyan-300/30"
              />
            ) : disabled ? (
              <span className="min-w-0 whitespace-normal break-words leading-4">{item}</span>
            ) : (
              <button
                type="button"
                aria-label={`编辑 ${item}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => beginEditItem(index, item)}
                className="min-w-0 rounded-sm text-left whitespace-normal break-words leading-4 transition-colors hover:text-cyan-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-300/30"
              >
                {item}
              </button>
            )}
            {!disabled && (
              <button
                type="button"
                aria-label={`删除 ${item}`}
                onClick={() => removeItem(index)}
                className="grid size-3.5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
        {!disabled && (
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === "," || event.key === "，") {
                event.preventDefault();
                addDraft();
                return;
              }
              if ((event.key === "Backspace" || event.key === "Delete") && !draft && value.length) {
                event.preventDefault();
                onChange(value.slice(0, -1));
              }
            }}
            onBlur={addDraft}
            placeholder={value.length ? undefined : placeholder}
            className="h-6 min-w-32 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        )}
      </div>
    </div>
  );
}

function assertSkillStudioCatalogPayload(kind: FreezoneAgentConfigKind, payload: FreezoneAgentConfigPayload) {
  if (kind === "skills") {
    const triggers = getRecord(payload.triggers);
    if (
      !textField(payload.id)
      || !textField(payload.category)
      || !textField(payload.description)
      || cleanStringArray(triggers.keywords).length === 0
    ) {
      throw new Error("invalid skill catalog payload");
    }
    return;
  }
  if (
    !textField(payload.id)
    || !textField(payload.name)
    || !isSkillStudioRecipeOutputKind(payload.output_kind)
    || cleanStringArray(payload.action_keys).length === 0
    || !textField(payload.system_prompt)
    || !textField(payload.planning_prompt)
    || !textField(payload.result_summary)
  ) {
    throw new Error("invalid recipe catalog payload");
  }
}

function buildSkillStudioCatalogSaveItems(draft: Record<string, unknown>): SkillStudioCatalogSaveItem[] {
  const items: SkillStudioCatalogSaveItem[] = [];
  const skill = getRecord(draft.skill);
  if (Object.keys(skill).length > 0) {
    const payload = normalizedSkillStudioSkillPayload(skill);
    assertSkillStudioCatalogPayload("skills", payload);
    items.push({ kind: "skills", payload });
  }
  const recipes = Array.isArray(draft.recipes)
    ? draft.recipes.filter((recipe): recipe is Record<string, unknown> =>
        Boolean(recipe) && typeof recipe === "object" && !Array.isArray(recipe),
      )
    : [];
  for (const recipe of recipes) {
    const payload = normalizedSkillStudioRecipePayload(recipe);
    assertSkillStudioCatalogPayload("recipes", payload);
    items.push({ kind: "recipes", payload });
  }
  if (items.length === 0) {
    throw new Error("empty skill studio catalog draft");
  }
  return items;
}

export const buildSkillStudioCatalogSaveItemsForTest = buildSkillStudioCatalogSaveItems;

function skillStudioQuestionKey(question: SkillStudioQuestion, index: number): string {
  return question.id?.trim() || `question_${index + 1}`;
}

function skillStudioQuestionEventIdentity(event: Extract<SkillStudioUiEvent, { type: "skill_studio.questions" }>): string {
  return event.bridge_key?.trim()
    || event.skill_studio_session_id?.trim()
    || event.title?.trim()
    || "skill_studio.questions";
}

function assistantClarificationEventIdentity(event: AssistantClarificationUiEvent): string {
  return event.bridge_key?.trim()
    || event.clarification_id?.trim()
    || event.title?.trim()
    || "assistant.clarification.request";
}

export const skillStudioQuestionEventIdentityForTest = skillStudioQuestionEventIdentity;
export const assistantClarificationEventIdentityForTest = assistantClarificationEventIdentity;

function skillStudioOptionKey(option: SkillStudioQuestionOption, index: number): string {
  return option.id?.trim() || `option_${index + 1}`;
}

function findSkillStudioOption(
  question: SkillStudioQuestion,
  selectedOptionId: string | undefined,
): SkillStudioQuestionOption | null {
  if (!selectedOptionId) return null;
  return (question.options ?? []).find((option, index) => skillStudioOptionKey(option, index) === selectedOptionId) ?? null;
}

function skillStudioQuestionSelectionMode(question: SkillStudioQuestion): "single" | "multiple" {
  return (question as AssistantClarificationQuestion).mode === "multiple"
    || question.selection_mode === "multiple"
    || question.selectionMode === "multiple"
    ? "multiple"
    : "single";
}

function skillStudioQuestionAllowsCustom(question: SkillStudioQuestion): boolean {
  return question.allow_custom !== false && question.allowCustom !== false;
}

function normalizedSkillStudioQuestionSelection(
  selection: SkillStudioQuestionSelections[string] | undefined,
): { optionIds: string[]; customText: string } {
  if (!selection) return { optionIds: [], customText: "" };
  if (typeof selection === "string") return { optionIds: selection ? [selection] : [], customText: "" };
  if (Array.isArray(selection)) {
    return { optionIds: selection.filter((value): value is string => typeof value === "string" && value.trim().length > 0), customText: "" };
  }
  if (typeof selection === "object") {
    const optionIds = Array.isArray(selection.option_ids)
      ? selection.option_ids.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : typeof selection.option_id === "string" && selection.option_id.trim().length > 0
        ? [selection.option_id]
        : [];
    const customText = typeof selection.custom_text === "string"
      ? selection.custom_text
      : typeof selection.customText === "string"
        ? selection.customText
        : "";
    return { optionIds, customText };
  }
  return { optionIds: [], customText: "" };
}

function skillStudioSelectionHasAnswer(selection: SkillStudioQuestionSelections[string] | undefined): boolean {
  const normalized = normalizedSkillStudioQuestionSelection(selection);
  return normalized.optionIds.length > 0 || normalized.customText.trim().length > 0;
}

function QuestionOptionSelectionMark({
  selected,
  mode,
}: {
  selected: boolean;
  mode: "single" | "multiple";
}) {
  const isMultiple = mode === "multiple";
  return (
	    <span
	      className={cn(
	        "mt-1 flex size-4 shrink-0 items-center justify-center border transition-colors",
	        isMultiple ? "rounded-[4px]" : "rounded-full",
	        selected
	          ? "border-cyan-200/70 bg-cyan-200/[0.08] text-cyan-50"
	          : "border-white/18 bg-transparent text-transparent group-hover:border-white/32",
	      )}
	      aria-hidden="true"
	    >
	      {selected && (
	        isMultiple
	          ? <Check className="size-3" strokeWidth={2.2} />
	          : <span className="size-1.5 rounded-full bg-current" />
	      )}
	    </span>
  );
}

function skillStudioSelectionForMode(
  question: SkillStudioQuestion,
  optionIds: string[],
  customText: string,
): SkillStudioQuestionSelection {
  const selectionMode = skillStudioQuestionSelectionMode(question);
  const normalizedOptionIds = selectionMode === "multiple" ? optionIds : optionIds.slice(0, 1);
  return {
    option_ids: normalizedOptionIds,
    custom_text: customText,
  };
}

function formatSkillStudioOption(option: SkillStudioQuestionOption): string {
  const label = option.label?.trim() || option.id?.trim() || "未命名选项";
  const description = option.description?.trim();
  return description ? `${label}（${description}）` : label;
}

function selectedSkillStudioOptionLabel(
  question: SkillStudioQuestion,
  questionIndex: number,
  selections: SkillStudioQuestionSelections,
): string {
  const selection = normalizedSkillStudioQuestionSelection(selections[skillStudioQuestionKey(question, questionIndex)]);
  const selectedLabels = selection.optionIds
    .map((optionId) => findSkillStudioOption(question, optionId))
    .filter((option): option is SkillStudioQuestionOption => Boolean(option))
    .map(formatSkillStudioOption);
  const customText = selection.customText.trim();
  const parts = [...selectedLabels, ...(customText ? [`补充：${customText}`] : [])];
  return parts.length > 0 ? parts.join("；") : "未选择";
}

type SkillStudioQuestionTimelineItem = {
  key: string;
  title: string;
  summary: string;
  answered: boolean;
};

function skillStudioQuestionActionSummary(action: string | undefined): string | null {
  if (action === "skip") return "已跳过";
  if (action === "recommended") return "已用推荐配置";
  return null;
}

function buildSkillStudioQuestionTimelineItems(
  questions: SkillStudioQuestion[],
  selections: SkillStudioQuestionSelections,
  action?: string,
): SkillStudioQuestionTimelineItem[] {
  const actionSummary = skillStudioQuestionActionSummary(action);
  return questions
    .map((question, index) => ({ question, index }))
    .filter(({ question }) => (question.options ?? []).length > 0 || skillStudioQuestionAllowsCustom(question))
    .map(({ question, index }) => {
      const key = skillStudioQuestionKey(question, index);
      const hasAnswer = skillStudioSelectionHasAnswer(selections[key]);
      return {
        key,
        title: question.title || `问题 ${index + 1}`,
        summary: hasAnswer ? selectedSkillStudioOptionLabel(question, index, selections) : actionSummary ?? "未选择",
        answered: hasAnswer || Boolean(actionSummary),
      };
    });
}

export const buildSkillStudioQuestionTimelineItemsForTest = buildSkillStudioQuestionTimelineItems;

export function buildSkillStudioQuestionResponseForTest(
  event: Extract<SkillStudioUiEvent, { type: "skill_studio.questions" }>,
  selections: SkillStudioQuestionSelections,
): string {
  const lines = [
    "我已在 Skill Studio 问题卡片中完成选择。",
    event.skill_studio_session_id ? `Skill Studio 会话：${event.skill_studio_session_id}` : "",
    event.title ? `卡片：${event.title}` : "",
  ].filter(Boolean);

  const answers = (event.questions ?? [])
    .map((question, index) => ({ question, index }))
    .filter(({ question }) => (question.options ?? []).length > 0)
    .map(({ question, index }) =>
      `- ${question.title || `问题 ${index + 1}`}：${selectedSkillStudioOptionLabel(question, index, selections)}`,
    );

  return [
    ...lines,
    "选择如下：",
    ...answers,
    "用户已完成选择，请结合当前上下文继续。",
  ].join("\n");
}

export function buildSkillStudioQuestionToolResultForTest(
  event: Extract<SkillStudioUiEvent, { type: "skill_studio.questions" }>,
  selections: SkillStudioQuestionSelections,
) {
  const safeSelections = Object.fromEntries(
    Object.entries(selections).filter(([key]) => !key.startsWith("__")),
  ) as SkillStudioQuestionSelections;
  return {
    turn_id: event.turn_id ?? undefined,
    anchor_text_prefix: event.anchor_text_prefix ?? undefined,
    bridge_key: event.bridge_key ?? "",
    project_id: event.project_id ?? undefined,
    canvas_id: event.canvas_id ?? undefined,
    agent_id: event.agent_id ?? undefined,
    tool_call_status: "completed" as const,
    skill_studio_status: "answered",
    ok: true,
    action: "submit",
    selections: safeSelections,
    message: buildSkillStudioQuestionResponseForTest(event, safeSelections),
  };
}

export function buildAssistantClarificationResponseForTest(
  event: AssistantClarificationUiEvent,
  answers: AssistantClarificationAnswers,
): string {
  const lines = [
    "我已完成补充信息选择。",
    event.clarification_id ? `Clarification：${event.clarification_id}` : "",
    event.title ? `卡片：${event.title}` : "",
  ].filter(Boolean);

  const answerLines = (event.questions ?? [])
    .map((question, index) => ({ question, index }))
    .filter(({ question }) => (question.options ?? []).length > 0 || skillStudioQuestionAllowsCustom(question))
    .map(({ question, index }) =>
      `${question.title || `问题 ${index + 1}`}\n${selectedSkillStudioOptionLabel(question, index, answers)}`,
    );

  return [
    ...lines,
    "回答如下：",
    ...answerLines,
    "请基于以上补充信息继续。",
  ].join("\n");
}

export function buildAssistantClarificationToolResultForTest(
  event: AssistantClarificationUiEvent,
  answers: AssistantClarificationAnswers,
  options: { skillStudioRevision?: boolean } = {},
) {
  const safeAnswers = Object.fromEntries(
    Object.entries(answers).filter(([key]) => !key.startsWith("__")),
  ) as AssistantClarificationAnswers;
  const message = [
    buildAssistantClarificationResponseForTest(event, safeAnswers),
    options.skillStudioRevision
      ? "当前处于 Skill Studio 草稿修订流程。请根据这个回答决定下一步；如果还需要追问，请一次只提出一个问题，等用户回答后再决定是否继续追问。信息足够时直接输出完整更新后的 Skill / Recipe 草稿。"
      : "",
  ].filter(Boolean).join("\n\n");
  return {
    turn_id: event.turn_id ?? undefined,
    anchor_text_prefix: event.anchor_text_prefix ?? undefined,
    bridge_key: event.bridge_key ?? "",
    project_id: event.project_id ?? undefined,
    canvas_id: event.canvas_id ?? undefined,
    agent_id: event.agent_id ?? undefined,
    tool_call_status: "completed" as const,
    clarification_status: "answered",
    ok: true,
    action: "submit",
    answers: safeAnswers,
    message,
  };
}

function buildPersistedAssistantClarificationEvent(
  event: AssistantClarificationUiEvent,
  {
    action,
    answers,
    clarificationStatus,
    receivedAt,
    skipped,
    usedRecommended,
  }: {
    action: string;
    answers: AssistantClarificationAnswers;
    clarificationStatus: string;
    receivedAt: number;
    skipped: boolean;
    usedRecommended: boolean;
  },
): Record<string, unknown> {
  return {
    type: "assistant.clarification.request",
    bridge_key: event.bridge_key,
    project_id: event.project_id,
    canvas_id: event.canvas_id,
    agent_id: event.agent_id,
    anchor_text_prefix: event.anchor_text_prefix ?? null,
    received_at: receivedAt,
    clarification_id: event.clarification_id,
    title: event.title,
    description: event.description,
    questions: event.questions,
    allow_recommended: event.allow_recommended,
    allow_skip: event.allow_skip,
    submitted: true,
    action,
    clarification_status: clarificationStatus,
    answers,
    skipped,
    used_recommended: usedRecommended,
  };
}

export const buildPersistedAssistantClarificationEventForTest = buildPersistedAssistantClarificationEvent;

function draftPayloadFromEvent(event: Extract<SkillStudioUiEvent, { type: "skill_studio.draft" }>) {
  if (event.draft && typeof event.draft === "object" && !Array.isArray(event.draft)) {
    const draft = event.draft;
    return {
      summary: typeof draft.summary === "string" ? draft.summary : event.summary || "",
      skill: draft.skill && typeof draft.skill === "object" && !Array.isArray(draft.skill) ? draft.skill as Record<string, unknown> : {},
      recipes: Array.isArray(draft.recipes) ? draft.recipes : [],
      warnings: Array.isArray(draft.warnings) ? draft.warnings : [],
    };
  }
  return {
    summary: event.summary || "",
    skill: event.skill && typeof event.skill === "object" ? event.skill : {},
    recipes: Array.isArray(event.recipes) ? event.recipes : [],
    warnings: Array.isArray(event.warnings) ? event.warnings : [],
  };
}

export function buildSkillStudioDraftToolResultForTest(
  event: Extract<SkillStudioUiEvent, { type: "skill_studio.draft" }>,
  draft: Record<string, unknown>,
) {
  const skill = draft.skill && typeof draft.skill === "object" && !Array.isArray(draft.skill)
    ? draft.skill as Record<string, unknown>
    : {};
  const recipes = Array.isArray(draft.recipes) ? draft.recipes : [];
  const summary = typeof draft.summary === "string" ? draft.summary : event.summary || "";
  const warnings = Array.isArray(draft.warnings) ? draft.warnings : [];
  const savedSkillIds = textField(skill.id) ? [textField(skill.id)] : [];
  const savedRecipeIds = recipes
    .map((recipe) => textField((recipe as Record<string, unknown>).id))
    .filter((id): id is string => Boolean(id));
  return {
    turn_id: event.turn_id ?? undefined,
    bridge_key: event.bridge_key ?? "",
    project_id: event.project_id ?? undefined,
    canvas_id: event.canvas_id ?? undefined,
    agent_id: event.agent_id ?? undefined,
    tool_call_status: "completed" as const,
    skill_studio_status: "catalog_saved",
    ok: true,
    action: "confirm_add",
    saved_to_catalog: true,
    saved_skill_ids: savedSkillIds,
    saved_recipe_ids: savedRecipeIds,
    draft: { summary, skill, recipes, warnings },
    message: [
      "我已在 Skill Studio 草稿卡片中确认添加，已保存为正式 Skill / Recipe。",
      event.skill_studio_session_id ? `Skill Studio 会话：${event.skill_studio_session_id}` : "",
      textField(skill.id) ? `Skill：${textField(skill.id)}` : "",
      savedRecipeIds.length > 0 ? `Recipes：${savedRecipeIds.join("、")}` : "",
      "该 Skill / Recipe 已写入虾画配置，可立即使用。请不要再要求用户保存为正式能力。",
    ].filter(Boolean).join("\n"),
  };
}

export function buildSkillStudioDraftCancelToolResultForTest(
  event: Extract<SkillStudioUiEvent, { type: "skill_studio.draft" }>,
  draft: Record<string, unknown> = draftPayloadFromEvent(event),
) {
  return {
    turn_id: event.turn_id ?? undefined,
    bridge_key: event.bridge_key ?? "",
    project_id: event.project_id ?? undefined,
    canvas_id: event.canvas_id ?? undefined,
    agent_id: event.agent_id ?? undefined,
    tool_call_status: "completed" as const,
    skill_studio_status: "catalog_cancelled",
    ok: true,
    action: "cancel",
    cancelled: true,
    draft,
    saved_to_catalog: false,
    saved_skill_ids: [],
    saved_recipe_ids: [],
    message: [
      "用户已取消 Skill Studio 草稿保存。",
      event.skill_studio_session_id ? `Skill Studio 会话：${event.skill_studio_session_id}` : "",
      "本次草稿不会写入虾画配置。",
      "请只确认取消结果，不要自动继续创建画布、执行工作流或推进后续阶段；除非用户再次明确提出下一步。",
    ].filter(Boolean).join("\n"),
  };
}

export function buildSkillStudioDraftRevisionToolResultForTest(
  event: Extract<SkillStudioUiEvent, { type: "skill_studio.draft" }>,
  draft: Record<string, unknown>,
) {
  return {
    turn_id: event.turn_id ?? undefined,
    bridge_key: event.bridge_key ?? "",
    project_id: event.project_id ?? undefined,
    canvas_id: event.canvas_id ?? undefined,
    agent_id: event.agent_id ?? undefined,
    tool_call_status: "completed" as const,
    skill_studio_status: "revision_started",
    ok: true,
    action: "start_revision",
    saved_to_catalog: false,
    saved_skill_ids: [],
    saved_recipe_ids: [],
    draft,
    message: [
      "用户已启动 Skill Studio 草稿修改会话。",
      event.skill_studio_session_id ? `Skill Studio 会话：${event.skill_studio_session_id}` : "",
      "用户已经明确表示需要调整当前草稿，不要再询问是否需要调整。",
      "不要询问是否保存当前版本，也不要提供 save_now / save_current / confirm_save 这类选项；保存只由页面草稿卡的确认按钮处理。",
      "如果需要追问，请直接询问具体修改方向、范围或偏好。",
      "请基于当前完整草稿，一个问题一个问题地收集修改意图；信息足够后使用分片草稿工具输出更新草稿。",
      "下一步只能调用 freezone_request_user_clarification，或按顺序调用 freezone_begin_agent_catalog_draft / freezone_put_agent_catalog_skill / freezone_put_agent_catalog_recipe / freezone_finish_agent_catalog_draft。",
      "不要在单个 tool_call 里传完整 Skill / Recipe catalog。",
      "不要用普通文本总结修改结果；不要只说明改了什么；未输出更新草稿前不要让用户保存。",
    ].filter(Boolean).join("\n"),
  };
}

function skillStudioDraftFooterText({
  submitted,
  cancelled,
  revisionPending,
}: {
  submitted: boolean;
  cancelled: boolean;
  revisionPending: boolean;
}): string {
  if (submitted) return "已添加到虾画 Skills / Recipes";
  if (cancelled) return "已取消，本草稿不会保存";
  if (revisionPending) return "AI 调整中，请按后续问题补充修改方向";
  return "保存前可展开各项继续微调";
}

export const skillStudioDraftFooterTextForTest = skillStudioDraftFooterText;

function buildSkillStudioRecommendedResponse(event: Extract<SkillStudioUiEvent, { type: "skill_studio.questions" }>): string {
  return [
    "请使用推荐配置继续 Skill Studio 流程。",
    event.skill_studio_session_id ? `Skill Studio 会话：${event.skill_studio_session_id}` : "",
    event.title ? `卡片：${event.title}` : "",
    "请基于当前目标直接生成一个可编辑的 Skill / Recipe 草稿。",
  ].filter(Boolean).join("\n");
}

function buildSkillStudioSkipResponse(event: Extract<SkillStudioUiEvent, { type: "skill_studio.questions" }>): string {
  return [
    "我选择跳过问题卡片，直接进入 Skill Studio 草稿生成。",
    event.skill_studio_session_id ? `Skill Studio 会话：${event.skill_studio_session_id}` : "",
    event.title ? `卡片：${event.title}` : "",
    "请根据已有上下文生成 Skill / Recipe 草稿。",
  ].filter(Boolean).join("\n");
}

function skillStudioEventMatches(
  candidate: unknown,
  event: Extract<SkillStudioUiEvent, { type: "skill_studio.questions" | "skill_studio.draft" }>,
): boolean {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const value = candidate as Record<string, unknown>;
  if (value.type !== event.type) return false;
  if (event.bridge_key) return value.bridge_key === event.bridge_key;
  if (value.bridge_key) return false;
  if (event.skill_studio_session_id && value.skill_studio_session_id === event.skill_studio_session_id) {
    return true;
  }
  return false;
}

export const skillStudioEventMatchesForTest = skillStudioEventMatches;

function SkillStudioQuestionsCard({
  event,
  onSubmit,
}: {
  event: Extract<SkillStudioUiEvent, { type: "skill_studio.questions" }>;
  onSubmit?: (
    event: Extract<SkillStudioUiEvent, { type: "skill_studio.questions" }>,
    selections: SkillStudioQuestionSelections,
  ) => Promise<boolean>;
}) {
  const questions = Array.isArray(event.questions) ? event.questions : [];
  const eventIdentity = skillStudioQuestionEventIdentity(event);
  const [selections, setSelections] = useState<SkillStudioQuestionSelections>(() =>
    event.selections && typeof event.selections === "object" ? event.selections : {},
  );
  const [submitted, setSubmitted] = useState(event.submitted === true);
  const [activeQuestionPosition, setActiveQuestionPosition] = useState(0);
  useEffect(() => {
    setSelections(event.selections && typeof event.selections === "object" ? event.selections : {});
    setSubmitted(event.submitted === true);
    setActiveQuestionPosition(0);
  }, [eventIdentity]);
  const selectableQuestions = questions
    .map((question, index) => ({ question, index }))
    .filter(({ question }) => (question.options ?? []).length > 0 || skillStudioQuestionAllowsCustom(question));
  const activeItem = selectableQuestions[Math.min(activeQuestionPosition, Math.max(selectableQuestions.length - 1, 0))] ?? null;
  const answeredCount = selectableQuestions.filter(({ question, index }) =>
    skillStudioSelectionHasAnswer(selections[skillStudioQuestionKey(question, index)]),
  ).length;
  const hasAnySelection = answeredCount > 0;
  const canSubmitSelections = selectableQuestions.length > 0 && hasAnySelection;
  const allQuestionsAnswered = selectableQuestions.length > 0 && answeredCount === selectableQuestions.length;
  const timelineItems = useMemo(
    () => buildSkillStudioQuestionTimelineItems(questions, selections, event.action),
    [event.action, questions, selections],
  );
  const submittedSummary = submitted
    ? skillStudioQuestionActionSummary(event.action)
      ?? `已提交回答 · ${answeredCount} / ${selectableQuestions.length || timelineItems.length} 个`
    : "";
  const goToQuestion = useCallback((position: number) => {
    if (selectableQuestions.length === 0) return;
    setActiveQuestionPosition(Math.max(0, Math.min(position, selectableQuestions.length - 1)));
  }, [selectableQuestions.length]);
  const submitSelections = useCallback(() => {
    if (!onSubmit || submitted) return;
    void onSubmit(event, selections).then((ok) => {
      if (ok) setSubmitted(true);
    });
  }, [event, onSubmit, selections, submitted]);
  const selectOption = useCallback((
    question: SkillStudioQuestion,
    questionIndex: number,
    optionKey: string,
	  ) => {
	    if (submitted) return;
	    const questionKey = skillStudioQuestionKey(question, questionIndex);
	    const selectionMode = skillStudioQuestionSelectionMode(question);
	    setSelections((current) => {
	      const currentSelection = normalizedSkillStudioQuestionSelection(current[questionKey]);
	      const optionIds = selectionMode === "multiple"
	        ? currentSelection.optionIds.includes(optionKey)
	          ? currentSelection.optionIds.filter((candidate) => candidate !== optionKey)
          : [...currentSelection.optionIds, optionKey]
        : [optionKey];
      const next = {
        ...current,
        [questionKey]: skillStudioSelectionForMode(question, optionIds, currentSelection.customText),
	      };
	      return next;
	    });
	    if (selectionMode === "single" && activeQuestionPosition < selectableQuestions.length - 1) {
	      setActiveQuestionPosition((position) => Math.min(position + 1, selectableQuestions.length - 1));
	    }
	  }, [activeQuestionPosition, selectableQuestions.length, submitted]);
  const updateCustomText = useCallback((
    question: SkillStudioQuestion,
    questionIndex: number,
    customText: string,
  ) => {
    if (submitted) return;
    const questionKey = skillStudioQuestionKey(question, questionIndex);
    setSelections((current) => {
      const currentSelection = normalizedSkillStudioQuestionSelection(current[questionKey]);
      return {
        ...current,
        [questionKey]: skillStudioSelectionForMode(question, currentSelection.optionIds, customText),
      };
    });
  }, [submitted]);
  const readOnly = submitted;

  if (readOnly) {
    return (
      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.025] px-3 py-3 text-sm shadow-[0_14px_40px_rgba(0,0,0,0.16)] backdrop-blur-sm">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-foreground/90">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-emerald-400/10 text-emerald-100/85">
                <CheckCircle2 className="size-3.5" />
              </span>
              <span className="truncate font-medium tracking-normal">{event.title || "Skill Studio 选择"}</span>
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              {submittedSummary}
            </div>
          </div>
          <span className="shrink-0 rounded-full border border-emerald-300/15 bg-emerald-400/[0.08] px-2 py-0.5 text-[11px] text-emerald-100/75">
            {skillStudioQuestionActionSummary(event.action) ?? "已提交"}
          </span>
        </div>
        <div className="relative ml-2.5 space-y-0.5">
          {timelineItems.length > 1 && (
            <div className="absolute bottom-4 left-[7px] top-4 w-px bg-gradient-to-b from-emerald-300/30 via-white/[0.08] to-transparent" />
          )}
          {timelineItems.map((item) => (
            <div key={item.key} className="relative grid grid-cols-[16px_minmax(0,1fr)] gap-3 py-1.5">
              <span
                className={cn(
                  "relative z-10 mt-1 flex size-4 items-center justify-center rounded-full border",
                  item.answered
                    ? "border-emerald-300/35 bg-emerald-400/15 text-emerald-100"
                    : "border-white/[0.12] bg-white/[0.04] text-muted-foreground",
                )}
              >
                {item.answered ? <CheckCircle2 className="size-3" /> : <span className="size-1.5 rounded-full bg-current opacity-60" />}
              </span>
              <div className="min-w-0 pb-1.5">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-[11px] leading-5 text-muted-foreground">{item.title}</span>
                  <span className={cn(
                    "min-w-0 text-xs leading-5",
                    item.answered ? "font-medium text-foreground/90" : "text-muted-foreground/70",
                  )}>
                    {item.summary}
                  </span>
                </div>
              </div>
            </div>
          ))}
          {timelineItems.length === 0 && (
            <div className="rounded-xl border border-white/[0.06] bg-black/10 px-3 py-2 text-xs text-muted-foreground">
              已提交，未包含可展示的问题配置。
            </div>
          )}
        </div>
      </div>
    );
  }

  const activeQuestion = activeItem?.question;
  const activeQuestionIndex = activeItem?.index ?? 0;
  const activeQuestionKey = activeQuestion ? skillStudioQuestionKey(activeQuestion, activeQuestionIndex) : "";
  const activeSelection = normalizedSkillStudioQuestionSelection(selections[activeQuestionKey]);
  const activeSelectionMode = activeQuestion ? skillStudioQuestionSelectionMode(activeQuestion) : "single";
  const activeSelectedCount = activeSelection.optionIds.length + (activeSelection.customText.trim() ? 1 : 0);
  const hasPrevious = activeQuestionPosition > 0;
  const hasNext = activeQuestionPosition < selectableQuestions.length - 1;
  const continueLabel = hasNext ? "下一题" : allQuestionsAnswered ? "提交选择" : "用当前选择继续";
  const continueAction = () => {
    if (hasNext) {
      goToQuestion(activeQuestionPosition + 1);
      return;
    }
    submitSelections();
  };

  return (
	    <div className="flex max-h-[min(70vh,560px)] flex-col bg-transparent px-4 pb-3 pt-3 text-sm">
	      <div className="mb-2.5 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
	        <div className="min-w-0">
	          <div className="line-clamp-2 break-words text-sm font-medium leading-5 text-foreground">
	            {activeQuestion?.title || event.title || "需要你补充一点信息"}
	          </div>
	          {event.description && (
	            <div className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
	              {event.description}
	            </div>
	          )}
	        </div>
	        {selectableQuestions.length > 0 && (
          <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <button
              type="button"
              disabled={!hasPrevious}
              className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
              onClick={() => goToQuestion(activeQuestionPosition - 1)}
              aria-label="上一题"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="min-w-10 text-center tabular-nums">{activeQuestionPosition + 1}/{selectableQuestions.length}</span>
            <button
              type="button"
              disabled={!hasNext}
              className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
              onClick={() => goToQuestion(activeQuestionPosition + 1)}
              aria-label="下一题"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {activeQuestion ? (
          <div className="overflow-hidden rounded-2xl bg-white/[0.035] ring-1 ring-white/[0.07]">
          <div className="flex items-center justify-between gap-2 px-3 py-2 text-[11px] text-muted-foreground/80">
            <span>{activeSelectionMode === "multiple" ? "可多选，也可以补充" : "选择一个方向，也可以补充"}</span>
            {activeSelectionMode === "multiple" && (
              <span className="shrink-0 rounded-full bg-white/[0.05] px-2 py-1 text-[11px] text-muted-foreground">
                多选
              </span>
            )}
          </div>
          <div className="divide-y divide-white/[0.06]">
            {(activeQuestion.options ?? []).map((option, optionIndex) => {
              const optionKey = skillStudioOptionKey(option, optionIndex);
              const selected = activeSelection.optionIds.includes(optionKey);
              return (
                <button
	                  key={option.id || optionIndex}
	                  type="button"
	                  role={activeSelectionMode === "multiple" ? "checkbox" : "radio"}
	                  aria-checked={selected}
	                  className={cn(
	                    "group flex w-full items-start gap-3 px-3 py-3 text-left transition-colors",
	                    selected ? "bg-white/[0.09]" : "hover:bg-white/[0.05]",
	                  )}
	                  onClick={() => selectOption(activeQuestion, activeQuestionIndex, optionKey)}
	                >
	                  <QuestionOptionSelectionMark selected={selected} mode={activeSelectionMode} />
	                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm leading-5 text-foreground/88">
                      {option.label || option.id || `选项 ${optionIndex + 1}`}
                    </span>
                    {option.description && (
                      <span className="mt-0.5 block line-clamp-2 break-words text-xs leading-4 text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </span>
                  {activeSelectionMode === "single" && <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground/65" />}
                </button>
              );
            })}
            {skillStudioQuestionAllowsCustom(activeQuestion) && (
              <div className="px-3 py-2.5">
                <Textarea
                  value={activeSelection.customText}
                  onChange={(changeEvent) => updateCustomText(activeQuestion, activeQuestionIndex, changeEvent.target.value)}
                  placeholder="其他补充..."
                  className="min-h-11 resize-none rounded-xl border-0 bg-white/[0.05] px-3 py-2 text-sm leading-5 shadow-none placeholder:text-muted-foreground/65 focus-visible:ring-1 focus-visible:ring-white/15"
                />
              </div>
            )}
          </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] px-3 py-6 text-center text-xs text-muted-foreground">
            暂无可选择的问题
          </div>
        )}
      </div>
      <div className="mt-2.5 flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-white/[0.08] pt-2.5">
        <div className="text-xs text-muted-foreground/80">
          已选择 {activeSelectedCount} 项 · {answeredCount} / {selectableQuestions.length}
        </div>
        <div className="flex items-center gap-2">
          {event.allow_skip && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 rounded-full px-3 text-xs text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
              disabled={!onSubmit}
              onClick={() => {
                void onSubmit?.(event, { __action: "skip" }).then((ok) => {
                  if (ok) setSubmitted(true);
                });
              }}
            >
              跳过
            </Button>
          )}
          {event.allow_recommended && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 rounded-full border-white/[0.12] bg-white/[0.04] px-3 text-xs hover:bg-white/[0.08]"
              disabled={!onSubmit}
              onClick={() => {
                void onSubmit?.(event, { __action: "recommended" }).then((ok) => {
                  if (ok) setSubmitted(true);
                });
              }}
            >
              使用推荐配置
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            className="h-8 rounded-full px-3 text-xs"
            disabled={!onSubmit || (hasNext ? false : !canSubmitSelections)}
            onClick={continueAction}
          >
            {continueLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

function AssistantClarificationSummaryCard({ event }: { event: AssistantClarificationUiEvent }) {
  const questions = Array.isArray(event.questions) ? event.questions : [];
  const answers = event.answers && typeof event.answers === "object" ? event.answers : {};
  const timelineItems = buildSkillStudioQuestionTimelineItems(questions, answers);
  const answeredCount = timelineItems.filter((item) => item.answered).length;
  const skipped = event.skipped === true || event.action === "skip";
  const statusLabel = skipped ? "已跳过" : "已提交";
  const countLabel = skipped
    ? `已跳过问题 · ${timelineItems.length} 个`
    : `已提交回答 · ${answeredCount} / ${timelineItems.length} 个`;
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.025] px-3 py-3 text-sm shadow-[0_14px_40px_rgba(0,0,0,0.16)] backdrop-blur-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-foreground/90">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-emerald-400/10 text-emerald-100/85">
              <CheckCircle2 className="size-3.5" />
            </span>
            <span className="truncate font-medium tracking-normal">{event.title || "问题回答"}</span>
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {countLabel}
          </div>
        </div>
        <span className="shrink-0 rounded-full border border-emerald-300/15 bg-emerald-400/[0.08] px-2 py-0.5 text-[11px] text-emerald-100/75">
          {statusLabel}
        </span>
      </div>
      <div className="relative ml-2.5 space-y-0.5">
        {timelineItems.length > 1 && (
          <div className="absolute bottom-4 left-[7px] top-4 w-px bg-gradient-to-b from-emerald-300/30 via-white/[0.08] to-transparent" />
        )}
        {timelineItems.map((item) => (
          <div key={item.key} className="relative grid grid-cols-[16px_minmax(0,1fr)] gap-3 py-1.5">
            <span
              className={cn(
                "relative z-10 mt-1 flex size-4 items-center justify-center rounded-full border",
                item.answered
                  ? "border-emerald-300/35 bg-emerald-400/15 text-emerald-100"
                  : "border-white/[0.12] bg-white/[0.04] text-muted-foreground",
              )}
            >
              {item.answered ? <CheckCircle2 className="size-3" /> : <span className="size-1.5 rounded-full bg-current opacity-60" />}
            </span>
            <div className="min-w-0 pb-1.5">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-[11px] leading-5 text-muted-foreground">{item.title}</span>
                <span className={cn(
                  "min-w-0 text-xs leading-5",
                  item.answered ? "font-medium text-foreground/90" : "text-muted-foreground/70",
                )}>
                  {item.summary}
                </span>
              </div>
            </div>
          </div>
        ))}
        {timelineItems.length === 0 && (
          <div className="rounded-xl border border-white/[0.06] bg-black/10 px-3 py-2 text-xs text-muted-foreground">
            已提交，未包含可展示的问题配置。
          </div>
        )}
      </div>
    </div>
  );
}

function AssistantClarificationInputCard({
  event,
  onSubmit,
}: {
  event: AssistantClarificationUiEvent;
  onSubmit?: (event: AssistantClarificationUiEvent, answers: AssistantClarificationAnswers) => Promise<boolean>;
}) {
  const questions = Array.isArray(event.questions) ? event.questions : [];
  const eventIdentity = assistantClarificationEventIdentity(event);
  const [answers, setAnswers] = useState<AssistantClarificationAnswers>(() =>
    event.answers && typeof event.answers === "object" ? event.answers : {},
  );
  const [activeQuestionPosition, setActiveQuestionPosition] = useState(0);
  useEffect(() => {
    setAnswers(event.answers && typeof event.answers === "object" ? event.answers : {});
    setActiveQuestionPosition(0);
  }, [eventIdentity]);
  const selectableQuestions = questions
    .map((question, index) => ({ question, index }))
    .filter(({ question }) => (question.options ?? []).length > 0 || skillStudioQuestionAllowsCustom(question));
  const activeItem = selectableQuestions[Math.min(activeQuestionPosition, Math.max(selectableQuestions.length - 1, 0))] ?? null;
  const answeredCount = selectableQuestions.filter(({ question, index }) =>
    skillStudioSelectionHasAnswer(answers[skillStudioQuestionKey(question, index)]),
  ).length;
  const allQuestionsAnswered = selectableQuestions.length > 0 && answeredCount === selectableQuestions.length;
  const canSubmit = answeredCount > 0 || selectableQuestions.length === 0;
  const goToQuestion = useCallback((position: number) => {
    if (selectableQuestions.length === 0) return;
    setActiveQuestionPosition(Math.max(0, Math.min(position, selectableQuestions.length - 1)));
	  }, [selectableQuestions.length]);
	  const selectOption = useCallback((question: AssistantClarificationQuestion, questionIndex: number, optionKey: string) => {
	    const questionKey = skillStudioQuestionKey(question, questionIndex);
	    const selectionMode = skillStudioQuestionSelectionMode(question);
	    setAnswers((current) => {
	      const currentSelection = normalizedSkillStudioQuestionSelection(current[questionKey]);
	      const optionIds = selectionMode === "multiple"
	        ? currentSelection.optionIds.includes(optionKey)
	          ? currentSelection.optionIds.filter((candidate) => candidate !== optionKey)
          : [...currentSelection.optionIds, optionKey]
        : [optionKey];
      return {
        ...current,
	        [questionKey]: skillStudioSelectionForMode(question, optionIds, currentSelection.customText),
	      };
	    });
	    if (selectionMode === "single" && activeQuestionPosition < selectableQuestions.length - 1) {
	      setActiveQuestionPosition((position) => Math.min(position + 1, selectableQuestions.length - 1));
	    }
	  }, [activeQuestionPosition, selectableQuestions.length]);
  const updateCustomText = useCallback((question: AssistantClarificationQuestion, questionIndex: number, customText: string) => {
    const questionKey = skillStudioQuestionKey(question, questionIndex);
    setAnswers((current) => {
      const currentSelection = normalizedSkillStudioQuestionSelection(current[questionKey]);
      return {
        ...current,
        [questionKey]: skillStudioSelectionForMode(question, currentSelection.optionIds, customText),
      };
    });
  }, []);
  const submitAnswers = useCallback(() => {
    if (!onSubmit || !canSubmit) return;
    void onSubmit(event, answers);
  }, [answers, canSubmit, event, onSubmit]);
  const activeQuestion = activeItem?.question;
  const activeQuestionIndex = activeItem?.index ?? 0;
  const activeQuestionKey = activeQuestion ? skillStudioQuestionKey(activeQuestion, activeQuestionIndex) : "";
  const activeSelection = normalizedSkillStudioQuestionSelection(answers[activeQuestionKey]);
  const activeSelectionMode = activeQuestion ? skillStudioQuestionSelectionMode(activeQuestion) : "single";
  const hasPrevious = activeQuestionPosition > 0;
  const hasNext = activeQuestionPosition < selectableQuestions.length - 1;
  const activeSelectedCount = activeSelection.optionIds.length + (activeSelection.customText.trim() ? 1 : 0);
  const continueLabel = hasNext ? "下一题" : allQuestionsAnswered ? "提交选择" : "用当前选择继续";
  const continueAction = () => {
    if (hasNext) {
      goToQuestion(activeQuestionPosition + 1);
      return;
    }
    submitAnswers();
  };

  return (
	    <div className="bg-transparent px-4 pb-3 pt-3 text-sm">
	      <div className="mb-2.5 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
	        <div className="min-w-0">
	          <div className="line-clamp-2 break-words text-sm font-medium leading-5 text-foreground">
	            {activeQuestion?.title || event.title || "需要你补充一点信息"}
	          </div>
	          {event.description && (
	            <div className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
	              {event.description}
	            </div>
	          )}
	        </div>
	        {selectableQuestions.length > 0 && (
          <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <button
              type="button"
              disabled={!hasPrevious}
              className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
              onClick={() => goToQuestion(activeQuestionPosition - 1)}
              aria-label="上一题"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="min-w-10 text-center tabular-nums">{activeQuestionPosition + 1}/{selectableQuestions.length}</span>
            <button
              type="button"
              disabled={!hasNext}
              className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
              onClick={() => goToQuestion(activeQuestionPosition + 1)}
              aria-label="下一题"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        )}
      </div>
      {activeQuestion ? (
        <div className="overflow-hidden rounded-2xl bg-white/[0.035] ring-1 ring-white/[0.07]">
          <div className="flex items-center justify-between gap-2 px-3 py-2 text-[11px] text-muted-foreground/80">
            <span>{activeSelectionMode === "multiple" ? "可多选，也可以补充" : "选择一个方向，也可以补充"}</span>
            {activeSelectionMode === "multiple" && (
              <span className="shrink-0 rounded-full bg-white/[0.05] px-2 py-1 text-[11px] text-muted-foreground">
                多选
              </span>
            )}
          </div>
          <div className="divide-y divide-white/[0.06]">
            {(activeQuestion.options ?? []).map((option, optionIndex) => {
              const optionKey = skillStudioOptionKey(option, optionIndex);
              const selected = activeSelection.optionIds.includes(optionKey);
              return (
                <button
	                  key={option.id || optionIndex}
	                  type="button"
	                  role={activeSelectionMode === "multiple" ? "checkbox" : "radio"}
	                  aria-checked={selected}
	                  className={cn(
	                    "group flex w-full items-start gap-3 px-3 py-3 text-left transition-colors",
	                    selected ? "bg-white/[0.09]" : "hover:bg-white/[0.05]",
	                  )}
	                  onClick={() => selectOption(activeQuestion, activeQuestionIndex, optionKey)}
	                >
	                  <QuestionOptionSelectionMark selected={selected} mode={activeSelectionMode} />
	                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm leading-5 text-foreground/88">
                      {option.label || option.id || `选项 ${optionIndex + 1}`}
                    </span>
                    {option.description && (
                      <span className="mt-0.5 block line-clamp-2 break-words text-xs leading-4 text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </span>
                  {activeSelectionMode === "single" && <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground/65" />}
                </button>
              );
            })}
            {skillStudioQuestionAllowsCustom(activeQuestion) && (
              <div className="px-3 py-2.5">
                <Textarea
                  value={activeSelection.customText}
                  onChange={(changeEvent) => updateCustomText(activeQuestion, activeQuestionIndex, changeEvent.target.value)}
                  placeholder="其他补充..."
                  className="min-h-11 resize-none rounded-xl border-0 bg-white/[0.05] px-3 py-2 text-sm leading-5 shadow-none placeholder:text-muted-foreground/65 focus-visible:ring-1 focus-visible:ring-white/15"
                />
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] px-3 py-6 text-center text-xs text-muted-foreground">
          暂无可选择的问题
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground/80">
          已选择 {activeSelectedCount} 项 · {answeredCount} / {selectableQuestions.length}
        </div>
        <div className="flex items-center gap-2">
          {event.allow_skip && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 rounded-full px-3 text-xs text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
              onClick={() => {
                void onSubmit?.(event, { __action: "skip" });
              }}
            >
              跳过
            </Button>
          )}
          {event.allow_recommended && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 rounded-full border-white/[0.12] bg-white/[0.04] px-3 text-xs hover:bg-white/[0.08]"
              onClick={() => {
                void onSubmit?.(event, { __action: "recommended" });
              }}
            >
              使用推荐配置
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            className="h-8 rounded-full px-3 text-xs"
            disabled={!onSubmit || (hasNext ? false : !canSubmit)}
            onClick={continueAction}
          >
            {continueLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SkillStudioDraftCard({
  event,
  onSubmit,
  onStartRevision,
  onDraftChange,
  onCancel,
  onPreserveScrollAnchor,
}: {
  event: Extract<SkillStudioUiEvent, { type: "skill_studio.draft" }>;
  onSubmit?: (
    event: Extract<SkillStudioUiEvent, { type: "skill_studio.draft" }>,
    draft: Record<string, unknown>,
  ) => Promise<boolean>;
  onStartRevision?: (
    event: Extract<SkillStudioUiEvent, { type: "skill_studio.draft" }>,
    draft: Record<string, unknown>,
  ) => Promise<boolean>;
  onDraftChange?: (
    event: Extract<SkillStudioUiEvent, { type: "skill_studio.draft" }>,
    draft: Record<string, unknown>,
  ) => void;
  onCancel?: (
    event: Extract<SkillStudioUiEvent, { type: "skill_studio.draft" }>,
    draft: Record<string, unknown>,
  ) => void;
  onPreserveScrollAnchor?: (anchor: HTMLElement | null) => void;
}) {
  const [draftObject, setDraftObject] = useState<Record<string, unknown>>(() => draftPayloadFromEvent(event));
  const [draftText, setDraftText] = useState(() => prettyJson(draftObject));
  const [submitted, setSubmitted] = useState(event.submitted === true);
  const [cancelled, setCancelled] = useState(event.cancelled === true);
  const [revisionPending, setRevisionPending] = useState(event.revision_pending === true);
  const [jsonError, setJsonError] = useState<string | null>(null);
  useEffect(() => {
    setSubmitted(event.submitted === true);
    setCancelled(event.cancelled === true);
    setRevisionPending(event.revision_pending === true);
  }, [event.cancelled, event.revision_pending, event.submitted]);
  const skill = getRecord(draftObject.skill);
  const recipes = Array.isArray(draftObject.recipes)
    ? draftObject.recipes.filter((recipe): recipe is Record<string, unknown> => Boolean(recipe && typeof recipe === "object" && !Array.isArray(recipe)))
    : [];
  const triggers = getRecord(skill.triggers);
  const planning = getRecord(skill.planning);
  const evaluation = getRecord(skill.evaluation);
  const evaluationFields = skillStudioEvaluationDraftFields(evaluation);
  const workflowTemplates = getRecordArray(skill.workflow_templates ?? skill.workflowTemplates);
  const syncDraftObject = useCallback((updater: (current: Record<string, unknown>) => Record<string, unknown>) => {
    setDraftObject((current) => {
      const next = updater(current);
      setDraftText(prettyJson(next));
      onDraftChange?.(event, next);
      return next;
    });
    if (jsonError) setJsonError(null);
  }, [event, jsonError, onDraftChange]);
  const updateSkillField = useCallback((key: string, value: unknown) => {
    syncDraftObject((current) => ({
      ...current,
      skill: {
        ...getRecord(current.skill),
        [key]: value,
      },
    }));
  }, [syncDraftObject]);
  const updateNestedSkillField = useCallback((
    section: "triggers" | "planning" | "evaluation",
    key: string,
    value: unknown,
    removeKeys: string[] = [],
  ) => {
    syncDraftObject((current) => {
      const currentSkill = getRecord(current.skill);
      const currentSection = getRecord(currentSkill[section]);
      const nextSection = {
        ...currentSection,
        [key]: value,
      };
      for (const removeKey of removeKeys) {
        delete nextSection[removeKey];
      }
      return {
        ...current,
        skill: {
          ...currentSkill,
          [section]: nextSection,
        },
      };
    });
  }, [syncDraftObject]);
  const updateRecipeField = useCallback((recipeIndex: number, key: string, value: unknown) => {
    syncDraftObject((current) => {
      const currentRecipes = Array.isArray(current.recipes) ? current.recipes : [];
      return {
        ...current,
        recipes: currentRecipes.map((recipe, index) => index === recipeIndex
          ? { ...getRecord(recipe), [key]: value }
          : recipe),
      };
    });
  }, [syncDraftObject]);
  const submitDraft = useCallback(() => {
    if (!onSubmit || submitted || cancelled) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(draftText);
    } catch {
      setJsonError("JSON 格式不正确，请检查后再提交");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setJsonError("草稿必须是 JSON 对象");
      return;
    }
    setJsonError(null);
    onDraftChange?.(event, parsed as Record<string, unknown>);
    void onSubmit(event, parsed as Record<string, unknown>).then((ok) => {
      if (ok) setSubmitted(true);
    });
  }, [cancelled, draftText, event, onDraftChange, onSubmit, submitted]);
  const cancelDraft = useCallback(() => {
    if (submitted || cancelled || revisionPending) return;
    setCancelled(true);
    onCancel?.(event, draftObject);
  }, [cancelled, draftObject, event, onCancel, revisionPending, submitted]);
  const startRevision = useCallback(() => {
    if (!onStartRevision || submitted || cancelled || revisionPending) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(draftText);
    } catch {
      setJsonError("JSON 格式不正确，请检查后再调整");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setJsonError("草稿必须是 JSON 对象");
      return;
    }
    setJsonError(null);
    onDraftChange?.(event, parsed as Record<string, unknown>);
    setRevisionPending(true);
    void onStartRevision(event, parsed as Record<string, unknown>).then((ok) => {
      if (!ok) setRevisionPending(false);
    });
  }, [cancelled, draftText, event, onDraftChange, onStartRevision, revisionPending, submitted]);
  const preserveDetailsScroll = useCallback((clickEvent: ReactMouseEvent<HTMLDivElement>) => {
    const target = clickEvent.target instanceof HTMLElement ? clickEvent.target : null;
    const summary = target?.closest("summary");
    if (!summary || !clickEvent.currentTarget.contains(summary)) return;
    onPreserveScrollAnchor?.(summary as HTMLElement);
  }, [onPreserveScrollAnchor]);
  const readOnly = submitted || cancelled || revisionPending;
  const fieldClass = "h-8 rounded-lg border-white/[0.08] bg-black/20 text-xs shadow-none focus-visible:ring-cyan-300/20 disabled:opacity-70";
  const labelClass = "mb-1 block text-[11px] font-medium text-muted-foreground";
  const textAreaClass = "min-h-16 resize-y rounded-lg border-white/[0.08] bg-black/20 text-xs leading-5 shadow-none focus-visible:ring-cyan-300/20 disabled:opacity-70";
  return (
    <div
      className="rounded-xl border border-white/[0.08] bg-white/[0.035] p-3 text-sm shadow-[0_18px_50px_rgba(0,0,0,0.2)] backdrop-blur-sm"
      onClickCapture={preserveDetailsScroll}
    >
      <div className="mb-2 flex items-center gap-2 text-foreground">
        <span className="flex size-6 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.04] text-emerald-100/90">
          <Package className="size-3.5" />
        </span>
        <span className="font-medium">Skill / Recipe 草稿</span>
        {event.mode && (
          <Badge variant="outline" className="h-5 rounded-md border-white/[0.1] px-1.5 text-[10px] text-muted-foreground">
            {event.mode === "edit" ? "编辑" : "新建"}
          </Badge>
        )}
      </div>
      {event.summary && (
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">{event.summary}</p>
      )}
      <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.045]">
        <div className="p-3">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            <Package className="size-3.5" />
            <span>Skill</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold leading-5 text-foreground">
              {textField(skill.id) || "untitled-skill"}
            </span>
            {textField(skill.category) && (
              <span className="rounded-full bg-white/[0.07] px-2 py-0.5 text-[10px] text-muted-foreground">
                {textField(skill.category)}
              </span>
            )}
          </div>
          <p className="mt-1.5 line-clamp-3 text-xs leading-5 text-muted-foreground">
            {textField(skill.description) || "暂无描述"}
          </p>
        </div>

        <details className="group border-t border-white/[0.07]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-xs marker:hidden">
            <span className="flex min-w-0 items-center gap-2 text-foreground/85">
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
              <Braces className="size-3.5 shrink-0 text-muted-foreground" />
              <span>基础信息</span>
            </span>
          </summary>
          <div className="space-y-2 border-t border-white/[0.06] px-3 pb-3 pt-2">
            <div className="grid gap-2 md:grid-cols-2">
              <label>
                <span className={labelClass}>{skillStudioDraftFieldLabels.skill.id}</span>
                <Input
                  value={textField(skill.id)}
                  disabled={readOnly}
                  onChange={(changeEvent) => updateSkillField("id", changeEvent.target.value)}
                  className={cn(fieldClass, "font-mono")}
                />
              </label>
              <label>
                <span className={labelClass}>{skillStudioDraftFieldLabels.skill.category}</span>
                <Input
                  value={textField(skill.category)}
                  disabled={readOnly}
                  onChange={(changeEvent) => updateSkillField("category", changeEvent.target.value)}
                  className={fieldClass}
                />
              </label>
            </div>
            <label className="block">
              <span className={labelClass}>{skillStudioDraftFieldLabels.skill.description}</span>
              <Textarea
                value={textField(skill.description)}
                disabled={readOnly}
                onChange={(changeEvent) => updateSkillField("description", changeEvent.target.value)}
                className={textAreaClass}
              />
            </label>
          </div>
        </details>

        <details className="group border-t border-white/[0.07]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-xs marker:hidden">
            <span className="flex min-w-0 items-center gap-2 text-foreground/85">
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{skillStudioDraftFieldLabels.skill.keywords}</span>
            </span>
          </summary>
	          <div className="border-t border-white/[0.06] px-3 pb-3 pt-2">
	            <SkillStudioListField
	              label={skillStudioDraftFieldLabels.skill.keywords}
	              value={stringListField(triggers.keywords)}
	              disabled={readOnly}
	              onChange={(value) => updateNestedSkillField("triggers", "keywords", value)}
	              placeholder="输入关键词后按 Enter"
	            />
	          </div>
	        </details>

        {workflowTemplates.length > 0 && (
          <details className="group border-t border-white/[0.07]">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-xs marker:hidden">
              <span className="flex min-w-0 items-center gap-2 text-foreground/85">
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                <ListTree className="size-3.5 shrink-0 text-muted-foreground" />
                <span>工作流模板</span>
              </span>
              <span className="rounded-full border border-cyan-300/20 bg-cyan-300/[0.08] px-2 py-0.5 text-[10px] text-cyan-100/80">
                {workflowTemplates.length} 个模板
              </span>
            </summary>
            <div className="space-y-2 border-t border-white/[0.06] px-3 pb-3 pt-2">
              {workflowTemplates.map((template, templateIndex) => {
                const steps = getRecordArray(template.steps);
                return (
                  <div key={textField(template.id) || templateIndex} className="rounded-lg border border-white/[0.07] bg-black/15 p-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-xs font-medium text-foreground/90">
                        {textField(template.name) || textField(template.id) || `模板 ${templateIndex + 1}`}
                      </span>
                      <span className="shrink-0 rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {steps.length} 步
                      </span>
                    </div>
                    {textField(template.description) && (
                      <p className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-4 text-muted-foreground">
                        {textField(template.description)}
                      </p>
                    )}
                    {steps.length > 0 && (
                      <ol className="mt-2 space-y-1">
                        {steps.map((step, stepIndex) => (
                          <li key={textField(step.id) || stepIndex} className="flex min-w-0 gap-2 text-[11px] text-muted-foreground">
                            <span className="shrink-0 tabular-nums text-foreground/60">
                              {Number(step.step_number) || stepIndex + 1}.
                            </span>
                            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-4">
                              {textField(step.goal_template) || textField(step.action_key) || textField(step.node_type) || "未命名步骤"}
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                );
              })}
            </div>
          </details>
        )}

        <details className="group border-t border-white/[0.07]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-xs marker:hidden">
            <span className="flex min-w-0 items-center gap-2 text-foreground/85">
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
              <ListTree className="size-3.5 shrink-0 text-muted-foreground" />
              <span>规划策略</span>
            </span>
          </summary>
          <div className="space-y-2 border-t border-white/[0.06] px-3 pb-3 pt-2">
            <div className="grid gap-2 md:grid-cols-2">
              <label>
                <span className={labelClass}>{skillStudioDraftFieldLabels.skill.metaPlanningHints}</span>
	                <Textarea
	                  value={firstNonEmptyText(planning.planning_notes, planning.metaPlanningHints)}
	                  disabled={readOnly}
	                  onChange={(changeEvent) => updateNestedSkillField("planning", "planning_notes", changeEvent.target.value, ["metaPlanningHints"])}
	                  className={textAreaClass}
	                />
	              </label>
	              <label>
	                <span className={labelClass}>{skillStudioDraftFieldLabels.skill.promptStyleGuide}</span>
	                <Textarea
	                  value={firstNonEmptyText(planning.prompt_guide, planning.promptStyleGuide)}
	                  disabled={readOnly}
	                  onChange={(changeEvent) => updateNestedSkillField("planning", "prompt_guide", changeEvent.target.value, ["promptStyleGuide"])}
	                  className={textAreaClass}
	                />
	              </label>
	            </div>
	            <SkillStudioListField
	              label={skillStudioDraftFieldLabels.skill.behaviorRules}
	              value={stringListField(planning.conduct_rules, planning.behaviorRules)}
	              disabled={readOnly}
	              onChange={(value) => updateNestedSkillField("planning", "conduct_rules", value, ["behaviorRules"])}
	              placeholder="输入规则后按 Enter"
	            />
	          </div>
	        </details>

        <details className="group border-t border-white/[0.07]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-xs marker:hidden">
            <span className="flex min-w-0 items-center gap-2 text-foreground/85">
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
              <CheckCircle2 className="size-3.5 shrink-0 text-muted-foreground" />
              <span>评估标准</span>
            </span>
          </summary>
          <div className="grid gap-2 border-t border-white/[0.06] px-3 pb-3 pt-2 md:grid-cols-[120px_1fr]">
            <label>
              <span className={labelClass}>{skillStudioDraftFieldLabels.skill.passingScore}</span>
              <Input
                value={String(evaluationFields.qualityThreshold ?? "")}
                disabled={readOnly}
                onChange={(changeEvent) => updateNestedSkillField("evaluation", "quality_threshold", numberOrRawText(changeEvent.target.value))}
                className={fieldClass}
              />
            </label>
            <label>
	              <span className={labelClass}>{skillStudioDraftFieldLabels.skill.domainRules}</span>
	              <Input
	                value={listText(evaluationFields.domainConstraints)}
	                disabled={readOnly}
	                onChange={(changeEvent) => updateNestedSkillField("evaluation", "domain_constraints", parseListText(changeEvent.target.value))}
	                placeholder="用顿号、逗号或换行分隔"
	                className={fieldClass}
	              />
            </label>
            <div className="md:col-span-2">
              <SkillStudioListField
                label={skillStudioDraftFieldLabels.skill.ratingBands}
                value={evaluationFields.ratingBands}
                disabled={readOnly}
                onChange={(value) => updateNestedSkillField("evaluation", "rating_bands", parseSkillStudioRatingBandList(value))}
                placeholder="如：8：风格统一且文化元素准确"
              />
            </div>
            <div className="md:col-span-2">
              <SkillStudioListField
                label={skillStudioDraftFieldLabels.skill.visualReviewItems}
                value={evaluationFields.visualReviewItems}
                disabled={readOnly}
                onChange={(value) => updateNestedSkillField("evaluation", "visual_review_items", parseSkillStudioReviewItemList(value))}
                placeholder="如：风格一致性（0.35）：是否符合视觉风格"
              />
            </div>
            <div className="md:col-span-2">
              <SkillStudioListField
                label={skillStudioDraftFieldLabels.skill.textReviewItems}
                value={evaluationFields.textReviewItems}
                disabled={readOnly}
                onChange={(value) => updateNestedSkillField("evaluation", "text_review_items", parseSkillStudioReviewItemList(value))}
                placeholder="如：文案传播力（0.4）：标题是否有记忆点"
              />
            </div>
          </div>
        </details>
      </div>
      {recipes.length > 0 && (
        <div className="mt-2 overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.035]">
          <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            <File className="size-3.5" />
            <span>Recipes ({recipes.length})</span>
          </div>
          {recipes.map((recipe, index) => (
            <details key={textField(recipe.id) || index} className="group border-b border-white/[0.07] last:border-b-0">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-xs marker:hidden">
                <span className="flex min-w-0 items-center gap-2">
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                  <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {textField(recipe.output_kind) || "类型"}
                  </span>
                  <span className="truncate text-foreground/85">{textField(recipe.name) || textField(recipe.id) || `Recipe ${index + 1}`}</span>
                </span>
              </summary>
              <div className="space-y-2 border-t border-white/[0.06] px-3 pb-3 pt-2">
                <div className="grid gap-2 md:grid-cols-2">
                  <label>
                    <span className={labelClass}>{skillStudioDraftFieldLabels.recipe.id}</span>
                    <Input
                      value={textField(recipe.id)}
                      disabled={readOnly}
                      onChange={(changeEvent) => updateRecipeField(index, "id", changeEvent.target.value)}
                      className={cn(fieldClass, "font-mono")}
                    />
                  </label>
                  <label>
                    <span className={labelClass}>{skillStudioDraftFieldLabels.recipe.name}</span>
                    <Input
                      value={textField(recipe.name)}
                      disabled={readOnly}
                      onChange={(changeEvent) => updateRecipeField(index, "name", changeEvent.target.value)}
                      className={fieldClass}
                    />
                  </label>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  <label>
                    <span className={labelClass}>{skillStudioDraftFieldLabels.recipe.output_kind}</span>
                    <Input
                      value={textField(recipe.output_kind)}
                      disabled={readOnly}
                      onChange={(changeEvent) => updateRecipeField(index, "output_kind", changeEvent.target.value)}
                      className={fieldClass}
                    />
                  </label>
                  <SkillStudioListField
                    label={skillStudioDraftFieldLabels.recipe.action_keys}
                    value={stringListField(recipe.action_keys)}
                    disabled={readOnly}
                    onChange={(value) => updateRecipeField(index, "action_keys", value)}
                    placeholder="输入类型后按 Enter"
                  />
                </div>
                <label className="block">
                  <span className={labelClass}>{skillStudioDraftFieldLabels.recipe.system_prompt}</span>
                  <Textarea
                    value={textField(recipe.system_prompt)}
                    disabled={readOnly}
                    onChange={(changeEvent) => updateRecipeField(index, "system_prompt", changeEvent.target.value)}
                    className={cn(textAreaClass, "min-h-24")}
                  />
                </label>
                <div className="grid gap-2 md:grid-cols-2">
                  <SkillStudioListField
                    label={skillStudioDraftFieldLabels.recipe.must_have_items}
                    value={stringListField(recipe.must_have_items)}
                    disabled={readOnly}
                    onChange={(value) => updateRecipeField(index, "must_have_items", value)}
                    placeholder="输入元素后按 Enter"
                  />
                  <label>
                    <span className={labelClass}>{skillStudioDraftFieldLabels.recipe.requires_source_media}</span>
                    <Input
                      value={String(Boolean(recipe.requires_source_media))}
                      disabled={readOnly}
                      onChange={(changeEvent) => updateRecipeField(index, "requires_source_media", changeEvent.target.value === "true")}
                      placeholder="true / false"
                      className={fieldClass}
                    />
                  </label>
                </div>
                <div className="grid gap-2 md:grid-cols-3">
                  <label>
                    <span className={labelClass}>{skillStudioDraftFieldLabels.recipe.enabled}</span>
                    <Input
                      value={String(recipe.enabled !== false)}
                      disabled={readOnly}
                      onChange={(changeEvent) => updateRecipeField(index, "enabled", changeEvent.target.value !== "false")}
                      placeholder="true / false"
                      className={fieldClass}
                    />
                  </label>
                  <label>
                    <span className={labelClass}>{skillStudioDraftFieldLabels.recipe.force_enhancement}</span>
                    <Input
                      value={String(recipe.force_enhancement === true)}
                      disabled={readOnly}
                      onChange={(changeEvent) => updateRecipeField(index, "force_enhancement", changeEvent.target.value === "true")}
                      placeholder="true / false"
                      className={fieldClass}
                    />
                  </label>
                  <label>
                    <span className={labelClass}>{skillStudioDraftFieldLabels.recipe.skip_detail_check}</span>
                    <Input
                      value={String(recipe.skip_detail_check === true)}
                      disabled={readOnly}
                      onChange={(changeEvent) => updateRecipeField(index, "skip_detail_check", changeEvent.target.value === "true")}
                      placeholder="true / false"
                      className={fieldClass}
                    />
                  </label>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  <label>
                    <span className={labelClass}>{skillStudioDraftFieldLabels.recipe.planning_prompt}</span>
                    <Textarea
                      value={textField(recipe.planning_prompt)}
                      disabled={readOnly}
                      onChange={(changeEvent) => updateRecipeField(index, "planning_prompt", changeEvent.target.value)}
                      className={textAreaClass}
                    />
                  </label>
                  <label>
                    <span className={labelClass}>{skillStudioDraftFieldLabels.recipe.result_summary}</span>
                    <Textarea
                      value={textField(recipe.result_summary)}
                      disabled={readOnly}
                      onChange={(changeEvent) => updateRecipeField(index, "result_summary", changeEvent.target.value)}
                      className={textAreaClass}
                    />
                  </label>
                </div>
              </div>
            </details>
          ))}
        </div>
      )}
      {Array.isArray(event.warnings) && event.warnings.length > 0 && (
        <div className="mt-2 rounded-md border border-amber-400/20 bg-amber-400/[0.05] px-2 py-1.5 text-xs text-amber-100/90">
          {event.warnings.map((warning) => String(warning)).join("；")}
        </div>
      )}
      <details className="group mt-2 overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.035]">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-xs marker:hidden">
          <span className="flex items-center gap-2 text-muted-foreground">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
            <Braces className="size-3.5" />
            查看原始 JSON
          </span>
          {readOnly && (
            <span className={cn(
              "flex items-center gap-1 text-[11px]",
              cancelled ? "text-muted-foreground" : "text-emerald-100/80",
            )}>
              {cancelled ? <X className="size-3" /> : <CheckCircle2 className="size-3" />}
              {cancelled ? "已取消" : "已提交"}
            </span>
          )}
        </summary>
        <div className="border-t border-white/[0.06]">
          <Textarea
            value={draftText}
            disabled={readOnly}
            onChange={(changeEvent) => {
              const nextText = changeEvent.target.value;
              setDraftText(nextText);
              if (jsonError) setJsonError(null);
              try {
                const parsed = JSON.parse(nextText);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                  const nextDraft = parsed as Record<string, unknown>;
                  setDraftObject(nextDraft);
                  onDraftChange?.(event, nextDraft);
                }
              } catch {
                // Keep the user's raw JSON text while they are still editing.
              }
            }}
            spellCheck={false}
            className="min-h-44 resize-y border-0 bg-transparent font-mono text-[11px] leading-5 text-foreground/80 shadow-none focus-visible:ring-0 disabled:opacity-70"
          />
        </div>
      </details>
      {jsonError && <div className="mt-2 text-xs text-amber-200">{jsonError}</div>}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] text-muted-foreground">
          {skillStudioDraftFooterText({ submitted, cancelled, revisionPending })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 rounded-lg border-white/[0.12] bg-white/[0.04] px-3 text-xs hover:bg-white/[0.08]"
            disabled={!onStartRevision || readOnly}
            onClick={startRevision}
          >
            让 AI 调整
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 rounded-lg px-3 text-xs"
            disabled={readOnly}
            onClick={cancelDraft}
          >
            取消
          </Button>
	          <Button
	            type="button"
            size="sm"
            className="h-8 rounded-lg px-3 text-xs"
            disabled={!onSubmit || readOnly}
            onClick={submitDraft}
          >
            确认添加
          </Button>
        </div>
      </div>
    </div>
  );
}

function SkillStudioStatusCard({ event }: { event: Extract<SkillStudioUiEvent, { type: "skill_studio.status" }> }) {
  return (
    <div className="flex items-center gap-2 px-1 py-1 text-xs text-muted-foreground">
      <ListTree className="size-3.5 shrink-0 text-cyan-100/70" />
      <span>{event.message || "正在进入 Skill Studio..."}</span>
      <DotsIndicator />
    </div>
  );
}

function SkillStudioEventCard({
  event,
  onSubmitQuestionResponse,
  onSubmitDraftResponse,
  onStartDraftRevision,
  onDraftChange,
  onCancelDraft,
  onPreserveScrollAnchor,
}: {
  event: SkillStudioUiEvent;
  onSubmitQuestionResponse?: (
    event: Extract<SkillStudioUiEvent, { type: "skill_studio.questions" }>,
    selections: SkillStudioQuestionSelections,
  ) => Promise<boolean>;
  onSubmitDraftResponse?: (
    event: Extract<SkillStudioUiEvent, { type: "skill_studio.draft" }>,
    draft: Record<string, unknown>,
  ) => Promise<boolean>;
  onStartDraftRevision?: (
    event: Extract<SkillStudioUiEvent, { type: "skill_studio.draft" }>,
    draft: Record<string, unknown>,
  ) => Promise<boolean>;
  onDraftChange?: (
    event: Extract<SkillStudioUiEvent, { type: "skill_studio.draft" }>,
    draft: Record<string, unknown>,
  ) => void;
  onCancelDraft?: (
    event: Extract<SkillStudioUiEvent, { type: "skill_studio.draft" }>,
    draft: Record<string, unknown>,
  ) => void;
  onPreserveScrollAnchor?: (anchor: HTMLElement | null) => void;
}) {
  if (event.type === "skill_studio.status") {
    return <SkillStudioStatusCard event={event} />;
  }
  if (event.type === "skill_studio.questions") {
    return <SkillStudioQuestionsCard event={event} onSubmit={onSubmitQuestionResponse} />;
  }
  return (
    <SkillStudioDraftCard
      event={event}
      onSubmit={onSubmitDraftResponse}
      onStartRevision={onStartDraftRevision}
      onDraftChange={onDraftChange}
      onCancel={onCancelDraft}
      onPreserveScrollAnchor={onPreserveScrollAnchor}
    />
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
  canvasCommandApprovals = [],
  canvasCommandFeedbacks = [],
  canvasContextActivities = [],
  executingCanvasCommandApprovalIds = new Set<string>(),
  onApplyCanvasCommandApproval,
  onCancelCanvasCommandApproval,
  onSubmitSkillStudioQuestionResponse,
  onSubmitSkillStudioDraftResponse,
  onStartSkillStudioDraftRevision,
  onSkillStudioDraftChange,
  onCancelSkillStudioDraft,
  onPreserveScrollAnchor,
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
  canvasCommandApprovals?: PendingCanvasCommandApproval[];
  canvasCommandFeedbacks?: CanvasCommandFeedback[];
  canvasContextActivities?: CanvasContextActivity[];
  executingCanvasCommandApprovalIds?: Set<string>;
  onApplyCanvasCommandApproval?: (approval: PendingCanvasCommandApproval) => void;
  onCancelCanvasCommandApproval?: (approval: PendingCanvasCommandApproval) => void;
  onSubmitSkillStudioQuestionResponse?: (
    event: Extract<SkillStudioUiEvent, { type: "skill_studio.questions" }>,
    selections: SkillStudioQuestionSelections,
  ) => Promise<boolean>;
  onSubmitSkillStudioDraftResponse?: (
    event: Extract<SkillStudioUiEvent, { type: "skill_studio.draft" }>,
    draft: Record<string, unknown>,
  ) => Promise<boolean>;
  onStartSkillStudioDraftRevision?: (
    event: Extract<SkillStudioUiEvent, { type: "skill_studio.draft" }>,
    draft: Record<string, unknown>,
  ) => Promise<boolean>;
  onSkillStudioDraftChange?: (
    event: Extract<SkillStudioUiEvent, { type: "skill_studio.draft" }>,
    draft: Record<string, unknown>,
  ) => void;
  onCancelSkillStudioDraft?: (
    event: Extract<SkillStudioUiEvent, { type: "skill_studio.draft" }>,
    draft: Record<string, unknown>,
  ) => void;
  onPreserveScrollAnchor?: (anchor: HTMLElement | null) => void;
}) {
  const isUser = message.role === "user";
  const isTool = isToolMessage(message);
  const isHistoricalTool = isTool && isHistoricalToolMessage(message);
  const isFreezoneLayout = variant === "freezone";
  const freezoneToolActivity = isTool ? freezoneToolDisplay(message) : null;
  const isErrorReply = isAssistantErrorReply(message);
  const isCompletionNotice = isAssistantCompletionNotice(message);
  const { t } = useTranslation();
  const shouldWaitForStructuredRender =
    deferStructuredRender && !isUser && !isTool && looksLikeStructuredRenderText(message.text);
  const { displayText, blocks } = extractStructuredBlocks(message);
  const visibleBlocks = visibleStructuredBlocksForMessage(blocks, {
    isFreezoneLayout,
    isUser,
    isTool,
  });
  const skillStudioEvents = !isUser && !isTool
    ? visibleSkillStudioEventsForMessage(message)
    : [];
  const clarificationSummaryEvents = !isUser && !isTool
    ? visibleAssistantClarificationEventsForMessage(message)
    : [];
  const waitingForUserReply = !isUser && !isTool && messageIsWaitingForUserReply(message);
  const assistantInteractionFlowItems = !isUser && !isTool
    ? buildAssistantInteractionFlowItems(displayText, skillStudioEvents, clarificationSummaryEvents)
    : [];
  const assistantOrderedPartsRaw = !isUser && !isTool && message.parts?.some((part) => part.type !== "text")
    ? hydrateOrderedPartsWithUiEvents(message.parts, messageUiEvents(message)) ?? []
    : [];
  const assistantOrderedParts = collapseRepeatedCanvasStatusParts(assistantOrderedPartsRaw);
  const visibleCanvasContextActivities = !isUser && !isTool
    ? visibleCanvasContextActivitiesForMessage(message, canvasContextActivities)
    : canvasContextActivities;
  const hasValidationContextActivity = visibleCanvasContextActivities.some(canvasContextActivityIsValidation);
  const visibleCanvasCommandFeedbacks = dedupeCanvasCommandFeedbacks(canvasCommandFeedbacks)
    .filter((feedback) => !(hasValidationContextActivity && canvasCommandFeedbackIsValidationOnly(feedback)));
  const suppressCanvasExecutionNarration =
    isFreezoneLayout
    && !isUser
    && !isTool
    && (visibleCanvasCommandFeedbacks.length > 0 || canvasCommandApprovals.length > 0)
    && looksLikeCanvasExecutionNarration(message.text);
  const hasCanvasCommandSurface =
    visibleCanvasCommandFeedbacks.length > 0
    || canvasCommandApprovals.length > 0
    || visibleCanvasContextActivities.length > 0;
  const canvasCommandFlowItems = useMemo(
    () => isUser || !hasCanvasCommandSurface
      ? []
      : collapseRepeatedCanvasStatusFlowItems(buildCanvasCommandFlowItems(
        suppressCanvasExecutionNarration ? "" : displayText,
        canvasCommandApprovals,
        visibleCanvasCommandFeedbacks,
        visibleCanvasContextActivities,
        skillStudioEvents,
        clarificationSummaryEvents,
      )),
    [
      canvasCommandApprovals,
      displayText,
      hasCanvasCommandSurface,
      isUser,
      clarificationSummaryEvents,
      skillStudioEvents,
      suppressCanvasExecutionNarration,
      visibleCanvasContextActivities,
      visibleCanvasCommandFeedbacks,
    ],
  );
  const copyText = async () => {
    const ok = await writeClipboardText(message.text);
    if (ok) toast.success("已复制");
    else toast.error("复制失败");
  };
  const speak = () => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(message.text));
  };
  const actions = (
    <div
      className={cn(
        isUser
          ? "pointer-events-none absolute bottom-2 right-0 z-10 flex items-center gap-0.5 whitespace-nowrap rounded-full border border-border/70 bg-background/85 px-1 py-0.5 text-foreground/75 opacity-0 shadow-sm backdrop-blur transition-opacity after:absolute after:-top-2 after:left-0 after:h-2 after:w-full after:content-[''] group-hover/message-actions:pointer-events-auto group-hover/message-actions:opacity-100 group-focus-within/message-actions:pointer-events-auto group-focus-within/message-actions:opacity-100"
          : "mt-2 flex items-center gap-1 text-muted-foreground/70",
      )}
    >
      <Button
        variant="ghost"
        size="icon-xs"
        className="opacity-70 hover:bg-white/[0.06] hover:text-foreground hover:opacity-100"
        onClick={copyText}
        aria-label="Copy"
      >
        <Copy className="size-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="opacity-70 hover:bg-white/[0.06] hover:text-foreground hover:opacity-100"
        onClick={speak}
        aria-label="Speak"
      >
        <Volume2 className="size-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="opacity-70 hover:bg-white/[0.06] hover:text-foreground hover:opacity-100"
        onClick={() => onOpenDetail(message)}
        aria-label="Details"
      >
        <Maximize2 className="size-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="opacity-70 hover:bg-white/[0.06] hover:text-foreground hover:opacity-100"
        onClick={() => onTogglePin(message.id)}
        aria-label={pinned ? "Unpin" : "Pin"}
      >
        {pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="opacity-70 hover:bg-white/[0.06] hover:text-foreground hover:opacity-100"
        onClick={() => onDelete(message.id)}
        aria-label="Delete"
      >
        <X className="size-3" />
      </Button>
    </div>
  );

  if (freezoneToolActivity && !hasCanvasCommandSurface) {
    return (
      <div className="flex items-start gap-3 justify-start">
        <ChatAvatarFrame
          role={message.role}
          label={message.displayName || t("aiAssistant.title")}
          streaming={freezoneToolStatus(message) === "running"}
        />
        <div className="flex min-w-0 flex-1 justify-start">
          <AgentToolActivityCard message={message} />
        </div>
      </div>
    );
  }

  if (isUser) {
    const visibleAttachments = message.attachments?.filter(shouldRenderAttachmentChip) ?? [];
    const hasCanvasReferenceAttachment = visibleAttachments.some(isCanvasNodeReferenceAttachment);
    if (hasCanvasReferenceAttachment) {
      return (
        <div className="flex justify-end">
          <article className={cn("max-w-[72%]", isFreezoneLayout && "max-w-[82%]")}>
            <div className="group/message-actions relative z-0 transition-[padding] duration-150 hover:z-30 hover:pb-10 focus-within:z-30 focus-within:pb-10">
              <div className="rounded-[14px] border-0 bg-white/[0.12] px-3 py-2.5 text-sm leading-6 text-foreground shadow-none">
                <AttachmentList attachments={message.attachments} align="start" compact />
                {displayText && (
                  <div className="whitespace-pre-wrap break-words">{displayText}</div>
                )}
                <StructuredRenderer blocks={visibleBlocks} />
              </div>
              {actions}
            </div>
          </article>
        </div>
      );
    }

    return (
      <div className="flex justify-end">
        <article className={cn("max-w-[72%]", isFreezoneLayout && "max-w-[82%]")}>
          <div className="group/message-actions relative z-0 transition-[padding] duration-150 hover:z-30 hover:pb-10 focus-within:z-30 focus-within:pb-10">
            <div className="rounded-[14px] border-0 bg-white/[0.12] px-4 py-2.5 text-sm leading-6 text-foreground shadow-none">
              <AttachmentList attachments={message.attachments} align="end" />
              {displayText && (
                <div className="whitespace-pre-wrap break-words">{displayText}</div>
              )}
              <StructuredRenderer blocks={visibleBlocks} />
            </div>
            {actions}
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
            visibleBlocks.length > 0 && !isUser && !isTool
              ? "w-full min-w-0 overflow-visible"
              : isUser
                ? "w-fit overflow-visible"
                : "w-fit overflow-hidden",
            isTool
              ? "max-w-[86%] rounded-[14px] border border-amber-500/20 bg-amber-500/8 px-4 pb-3 pt-2 text-card-foreground"
              : isUser
                ? "max-w-[86%] rounded-[14px] bg-muted px-4 pb-3 pt-2 text-foreground"
                : "max-w-full rounded-[14px] border border-white/[0.08] bg-transparent px-4 pb-3 pt-2 text-foreground",
          )}
        >
        <div
          className={cn(
            "pointer-events-none absolute right-1.5 z-10 flex items-center gap-0.5 rounded-full border border-border/70 bg-background/90 px-1 py-0.5 opacity-0 shadow-sm backdrop-blur transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
            isUser ? "top-full mt-1" : "top-1.5 translate-y-0.5",
          )}
        >
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
            {assistantOrderedParts.length > 0 ? (
              <div className="space-y-1.5">
                {assistantOrderedParts.map((part) => {
                  if (part.type === "text") {
                    if (suppressCanvasExecutionNarration || !part.text) return null;
                    return isErrorReply && !isUser && !isTool
                      ? <HighlightedErrorText key={part.id} text={part.text} />
                      : isCompletionNotice && !isUser && !isTool
                        ? <HighlightedCompletionText key={part.id} text={part.text} />
                        : <MessageText key={part.id} text={part.text} markdown={!isUser && !isTool} />;
                  }
                  if (part.type === "canvas_approval") {
                    const approval = part.event as PendingCanvasCommandApproval;
                    const stillPending = canvasCommandApprovals.some((item) =>
                      pendingCanvasCommandApprovalMatches(item, approval),
                    );
                    if (!stillPending) {
                      const expiredFeedback = expiredCanvasApprovalFeedback(approval);
                      return expiredFeedback
                        ? <CanvasCommandFeedbackCard key={part.id} feedback={expiredFeedback} />
                        : null;
                    }
                    return (
                      <CanvasCommandApprovalCard
                        key={part.id}
                        approval={approval}
                        isExecuting={executingCanvasCommandApprovalIds.has(approval.id)}
                        onApply={onApplyCanvasCommandApproval ?? (() => undefined)}
                        onCancel={onCancelCanvasCommandApproval ?? (() => undefined)}
                      />
                    );
                  }
                  if (part.type === "canvas_feedback") {
                    return <CanvasCommandFeedbackCard key={part.id} feedback={part.event as CanvasCommandFeedback} />;
                  }
                  if (part.type === "canvas_context") {
                    return <CanvasContextActivityCard key={part.id} activity={part.event as CanvasContextActivity} />;
                  }
                  if (part.type === "skill_studio") {
                    return (
                      <SkillStudioEventCard
                        key={part.id}
                        event={part.event as SkillStudioUiEvent}
                        onSubmitQuestionResponse={onSubmitSkillStudioQuestionResponse}
                        onSubmitDraftResponse={onSubmitSkillStudioDraftResponse}
                        onStartDraftRevision={onStartSkillStudioDraftRevision}
                        onDraftChange={onSkillStudioDraftChange}
                        onCancelDraft={onCancelSkillStudioDraft}
                        onPreserveScrollAnchor={onPreserveScrollAnchor}
                      />
                    );
                  }
                  if (part.type === "clarification") {
                    return (
                      <AssistantClarificationSummaryCard
                        key={part.id}
                        event={part.event as AssistantClarificationUiEvent}
                      />
                    );
                  }
                  if (part.type === "tool_status") {
                    const toolMessage = part.event as ChatMessage;
                    return <AgentToolActivityCard key={part.id} message={toolMessage} />;
                  }
                  if (part.type === "agent_plan") {
                    return <AgentPlanCard key={part.id} event={part.event} />;
                  }
                  if (part.type === "agent_thought") {
                    return <AgentThoughtCard key={part.id} event={part.event} />;
                  }
                  if (part.type === "agent_usage") {
                    return <AgentUsageCard key={part.id} event={part.event} />;
                  }
                  return null;
                })}
              </div>
            ) : canvasCommandFlowItems.length > 0 ? (
              <div className="space-y-1.5">
                {canvasCommandFlowItems.map((item) => {
                  if (item.kind === "text") {
                    return <MessageText key={item.key} text={item.text} markdown={!isUser && !isTool} />;
                  }
                  if (item.kind === "approval") {
                    return (
                      <CanvasCommandApprovalCard
                        key={item.key}
                        approval={item.approval}
                        isExecuting={executingCanvasCommandApprovalIds.has(item.approval.id)}
                        onApply={onApplyCanvasCommandApproval ?? (() => undefined)}
                        onCancel={onCancelCanvasCommandApproval ?? (() => undefined)}
                      />
                    );
                  }
                  if (item.kind === "feedback") {
                    return <CanvasCommandFeedbackCard key={item.key} feedback={item.feedback} />;
                  }
                  if (item.kind === "skill_studio") {
                    return (
                      <SkillStudioEventCard
                        key={item.key}
                        event={item.event}
                        onSubmitQuestionResponse={onSubmitSkillStudioQuestionResponse}
                        onSubmitDraftResponse={onSubmitSkillStudioDraftResponse}
                        onStartDraftRevision={onStartSkillStudioDraftRevision}
                        onDraftChange={onSkillStudioDraftChange}
                        onCancelDraft={onCancelSkillStudioDraft}
                        onPreserveScrollAnchor={onPreserveScrollAnchor}
                      />
                    );
                  }
                  if (item.kind === "clarification") {
                    return (
                      <AssistantClarificationSummaryCard
                        key={item.key}
                        event={item.event}
                      />
                    );
                  }
                  return <CanvasContextActivityCard key={item.key} activity={item.activity} />;
                })}
              </div>
            ) : (
              <div className="space-y-2">
                {assistantInteractionFlowItems.length > 0 ? (
                  assistantInteractionFlowItems.map((item) => {
                    if (item.kind === "clarification") {
                      return (
                        <AssistantClarificationSummaryCard
                          key={item.key}
                          event={item.event}
                        />
                      );
                    }
                    if (item.kind === "skill_studio") {
                      return (
                        <SkillStudioEventCard
                          key={item.key}
                          event={item.event}
                          onSubmitQuestionResponse={onSubmitSkillStudioQuestionResponse}
                          onSubmitDraftResponse={onSubmitSkillStudioDraftResponse}
                          onStartDraftRevision={onStartSkillStudioDraftRevision}
                          onDraftChange={onSkillStudioDraftChange}
                          onCancelDraft={onCancelSkillStudioDraft}
                          onPreserveScrollAnchor={onPreserveScrollAnchor}
                        />
                      );
                    }
                    if (suppressCanvasExecutionNarration || !item.text) return null;
                    return isErrorReply && !isUser && !isTool
                      ? <HighlightedErrorText key={item.key} text={item.text} />
                      : isCompletionNotice && !isUser && !isTool
                        ? <HighlightedCompletionText key={item.key} text={item.text} />
                        : <MessageText key={item.key} text={item.text} markdown={!isUser && !isTool} />;
                  })
                ) : !suppressCanvasExecutionNarration && displayText ? (
                  isErrorReply && !isUser && !isTool
                    ? <HighlightedErrorText text={displayText} />
                    : isCompletionNotice && !isUser && !isTool
                      ? <HighlightedCompletionText text={displayText} />
                      : <MessageText text={displayText} markdown={!isUser && !isTool} />
                ) : waitingForUserReply ? (
                    <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.035] px-3 py-1.5 text-xs text-muted-foreground">
                      <ListTree className="size-3.5" />
                      <span>正在等待您的回复</span>
                    </div>
                ) : null}
              </div>
            )}
            <StructuredRenderer blocks={visibleBlocks} onOpenMedia={onOpenMedia} />
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
  const timelineListRef = useRef<HTMLDivElement | null>(null);
  const [scrollEdges, setScrollEdges] = useState({ up: false, down: false });

  const updateScrollEdges = useCallback(() => {
    const list = timelineListRef.current;
    if (!list) return;
    const next = {
      up: list.scrollTop > 1,
      down: list.scrollTop + list.clientHeight < list.scrollHeight - 1,
    };
    setScrollEdges((current) => current.up === next.up && current.down === next.down ? current : next);
  }, []);

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
    const list = timelineListRef.current;
    const button = activeButtonRef.current;
    if (!list || !button) return;
    const listRect = list.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const edgePadding = 8;
    if (buttonRect.top < listRect.top + edgePadding) {
      list.scrollBy({ top: buttonRect.top - listRect.top - edgePadding, behavior: "auto" });
    } else if (buttonRect.bottom > listRect.bottom - edgePadding) {
      list.scrollBy({ top: buttonRect.bottom - listRect.bottom + edgePadding, behavior: "auto" });
    }
  }, [activeIndex]);

  useEffect(() => {
    const list = timelineListRef.current;
    if (!list) return;
    updateScrollEdges();
    list.addEventListener("scroll", updateScrollEdges, { passive: true });
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updateScrollEdges);
    resizeObserver?.observe(list);
    return () => {
      list.removeEventListener("scroll", updateScrollEdges);
      resizeObserver?.disconnect();
    };
  }, [turns.length, updateScrollEdges]);

  const scrollToTurn = useCallback((turn: TimelineTurn) => {
    const container = scrollRef.current;
    if (!container) return;
    const element = container.querySelector(`[data-turn-id="${CSS.escape(turn.id)}"]`);
    element?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [scrollRef]);

  const revealTimelineContext = useCallback((button: HTMLButtonElement) => {
    const list = timelineListRef.current;
    if (!list) return;
    const listRect = list.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const delta = calculateTimelineContextDelta({
      viewportHeight: list.clientHeight,
      nodeCenter: buttonRect.top - listRect.top + buttonRect.height / 2,
      scrollTop: list.scrollTop,
      scrollHeight: list.scrollHeight,
    });
    if (Math.abs(delta) < 1) return;
    list.scrollTo({ top: list.scrollTop + delta, behavior: "smooth" });
  }, []);

  if (turns.length < 2) return null;

  return (
    <div className="pointer-events-none absolute bottom-4 right-1 top-4 z-20 hidden w-9 select-none lg:flex">
      <div className="pointer-events-auto relative flex h-full w-full justify-center">
        <div className="absolute inset-y-2 left-1/2 w-px -translate-x-1/2 bg-border/70" />
        <div
          ref={timelineListRef}
          className="flex max-h-full flex-col items-center gap-2 overflow-y-auto px-2 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {turns.map((turn, index) => (
            <button
              key={turn.id}
              ref={index === activeIndex ? activeButtonRef : null}
              type="button"
              className="group/timeline-dot relative z-10 flex h-6 w-4 shrink-0 items-center justify-center"
              onClick={(event) => {
                revealTimelineContext(event.currentTarget);
                scrollToTurn(turn);
              }}
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
            >
              <span
                aria-hidden="true"
                className={cn(
                  "rounded-full border transition-[width,height,background-color,border-color] duration-150",
                  index === activeIndex
                    ? turns.length > 80
                      ? "size-2 border-primary bg-primary"
                      : turns.length > 40
                        ? "size-2.5 border-primary bg-primary"
                        : "size-3 border-primary bg-primary"
                    : cn(
                        "border-muted-foreground/40 bg-background group-hover/timeline-dot:border-primary group-hover/timeline-dot:bg-primary/20",
                        turns.length > 80 ? "size-1.5" : turns.length > 40 ? "size-2" : "size-2.5",
                      ),
                )}
              />
            </button>
          ))}
        </div>
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 z-20 h-10 bg-gradient-to-b from-background via-background/55 to-transparent transition-opacity duration-200",
            scrollEdges.up ? "opacity-75" : "opacity-0",
          )}
          aria-hidden="true"
        />
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 z-20 h-10 bg-gradient-to-t from-background via-background/55 to-transparent transition-opacity duration-200",
            scrollEdges.down ? "opacity-75" : "opacity-0",
          )}
          aria-hidden="true"
        />
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
  compact = false,
}: {
  attachments?: ChatAttachment[];
  align?: "start" | "end";
  compact?: boolean;
}) {
  const visibleAttachments = attachments?.filter(shouldRenderAttachmentChip) ?? [];
  if (visibleAttachments.length === 0) return null;

  return (
    <div className={cn(compact ? "mb-2 flex flex-wrap gap-1.5" : "mb-2 flex flex-wrap gap-2", align === "end" && "justify-end")}>
      {visibleAttachments.flatMap((attachment) => {
        if (isCanvasNodeReferenceAttachment(attachment)) {
          return canvasNodeReferenceAttachmentNodes(attachment).map((node) => (
            <CanvasNodeReferenceCard
              key={`${attachment.id}:${node.nodeId}`}
              node={node}
              compact
            />
          ));
        }
        return [
          <AttachmentChip
            key={attachment.id || attachment.fileName || attachment.content}
            attachment={attachment}
          />,
        ];
      })}
    </div>
  );
}

type SentCanvasNodeReferencePreview = ReturnType<typeof canvasNodeReferenceAttachmentNodes>[number];

function CanvasNodeReferenceCard({
  node,
  compact = false,
}: {
  node: SentCanvasNodeReferencePreview;
  compact?: boolean;
}) {
  const mediaSrc = canvasReferenceResolvedUrl(node.sourceUrl);
  const previewSrc = canvasReferenceResolvedUrl(node.previewUrl) ?? mediaSrc;
  const isVideo = node.mediaType === "video" || canvasReferenceIsVideoUrl(mediaSrc);
  const previewIsImage = canvasReferenceIsImageUrl(previewSrc);
  const previewIsVideo = canvasReferenceIsVideoUrl(previewSrc) || (isVideo && !previewIsImage);
  const isImage =
    node.mediaType === "image" ||
    node.mediaType === "pano360" ||
    canvasReferenceIsImageUrl(mediaSrc);
  const title = node.label || node.nodeId;
  const kindLabel =
    node.mediaType === "video"
      ? "Video"
      : node.mediaType === "audio"
        ? "Audio"
        : node.mediaType === "text"
          ? "Text"
          : node.mediaType === "image" || node.mediaType === "pano360"
            ? "Image"
            : node.nodeType || "Canvas";

  if (compact) {
    return (
      <div
        className="group/canvas-ref relative w-[92px] cursor-pointer overflow-hidden rounded-[10px] bg-black/15 p-1.5 shadow-none transition hover:bg-black/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
        title={`${title} · ${node.nodeId}`}
        role="button"
        tabIndex={0}
        onClick={() => focusCanvasReferenceNode(node.nodeId)}
        onKeyDown={(event) => handleCanvasReferenceKeyDown(event, node.nodeId)}
      >
        <div className="relative size-10 overflow-hidden rounded-md bg-black/25">
          {previewSrc && previewIsVideo ? (
            <CanvasReferenceVideoPreview src={previewSrc} title={title} iconClassName="size-5" />
          ) : previewSrc && (previewIsImage || isImage) ? (
            <img
              src={previewSrc}
              alt={title}
              className="h-full w-full object-cover"
              loading="lazy"
              decoding="async"
              draggable={false}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-muted-foreground">
              {isVideo ? <Play className="size-5" /> : <ListTree className="size-5" />}
            </div>
          )}
        </div>
        <div className="mt-1.5 line-clamp-2 text-[11px] font-medium leading-3.5 text-foreground/90">
          {title}
        </div>
      </div>
    );
  }

  return (
    <div
      className="group/canvas-ref relative w-full cursor-pointer overflow-hidden rounded-xl border border-white/10 bg-white/[0.06] shadow-sm transition hover:bg-white/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
      title={`${title} · ${node.nodeId}`}
      role="button"
      tabIndex={0}
      onClick={() => focusCanvasReferenceNode(node.nodeId)}
      onKeyDown={(event) => handleCanvasReferenceKeyDown(event, node.nodeId)}
    >
      <div className="relative h-28 bg-black/25">
        {previewSrc && previewIsVideo ? (
          <CanvasReferenceVideoPreview src={previewSrc} title={title} iconClassName="size-6" />
        ) : previewSrc && (previewIsImage || isImage) ? (
          <img
            src={previewSrc}
            alt={title}
            className="h-full w-full object-cover"
            loading="lazy"
            decoding="async"
            draggable={false}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            {isVideo ? <Play className="size-6" /> : <ListTree className="size-6" />}
          </div>
        )}
      </div>
      <div className="px-2.5 py-2">
        <div className="line-clamp-2 text-xs font-medium leading-4 text-foreground">{title}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <ListTree className="size-3" />
          <span className="truncate">{kindLabel}</span>
        </div>
      </div>
    </div>
  );
}

function AttachmentChip({ attachment }: { attachment: ChatAttachment }) {
  const isImage = isImageAttachment(attachment);
  const isCanvasReference = isCanvasNodeReferenceAttachment(attachment);

  return (
    <span className="inline-flex max-w-44 items-center gap-1.5 rounded-md border border-border/70 bg-background/45 px-2 py-1 text-xs">
      {isCanvasReference ? (
        <ListTree className="size-3.5" />
      ) : isImage ? (
        <Image className="size-3.5" />
      ) : (
        <File className="size-3.5" />
      )}
      <span className="truncate">{attachment.label || attachment.fileName || attachment.mimeType || "Attachment"}</span>
    </span>
  );
}

function shouldRenderAttachmentChip(attachment: ChatAttachment): boolean {
  if (isCanvasNodeReferenceAttachment(attachment)) return true;
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
  onResolve: (decision: ApprovalDecision) => void;
}) {
  const { t } = useTranslation();
  const remaining = approval.expiresAtMs
    ? Math.max(0, Math.ceil((approval.expiresAtMs - Date.now()) / 1000))
    : null;
  const agentOptions = approval.kind === "agent"
    ? (approval.options ?? []).flatMap((option) => {
      const optionId = option.optionId ?? option.option_id;
      return optionId ? [{ ...option, optionId }] : [];
    })
    : [];

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
        {approval.kind === "agent" ? agentOptions.map((option) => {
          const kind = String(option.kind ?? "").toLowerCase();
          const destructive = kind.includes("reject") || kind.includes("deny");
          const persistent = kind.includes("always");
          return (
            <Button
              key={option.optionId}
              size="xs"
              variant={destructive ? "destructive" : persistent ? "outline" : "default"}
              onClick={() => onResolve({ optionId: option.optionId })}
            >
              {option.name || option.optionId}
            </Button>
          );
        }) : (<>
          <Button size="xs" onClick={() => onResolve("allow-once")}>
            {t("aiAssistant.allowOnce")}
          </Button>
          <Button size="xs" variant="outline" onClick={() => onResolve("allow-always")}>
            {t("aiAssistant.allowAlways")}
          </Button>
          <Button size="xs" variant="destructive" onClick={() => onResolve("deny")}>
            {t("aiAssistant.deny")}
          </Button>
        </>)}
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

async function writeClipboardText(text: string): Promise<boolean> {
  const value = text.trim();
  if (!value) return false;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the textarea path. Clipboard API can fail in embedded views.
  }

  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

function getCanvasNodeLabel(node: CanvasNode): string {
  if (!node.type) return node.id;
  return resolveNodeDisplayName(node.type as CanvasNodeType, node.data);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function canvasReferenceMediaType(node: CanvasNode): string | null {
  if (node.type === "videoNode") return "video";
  if (node.type === "audioNode") return "audio";
  if (node.type === "threeDWorldNode") return "model";
  if (
    node.type === "uploadNode" ||
    node.type === "imageNode" ||
    node.type === "imageGenNode" ||
    node.type === "exportImageNode" ||
    node.type === "pano360ViewerNode"
  ) {
    return "image";
  }
  return stringOrNull((node.data as { media_kind?: unknown }).media_kind);
}

function canvasReferenceSourceUrl(node: CanvasNode): string | null {
  const data = node.data as {
    imageUrl?: unknown;
    previewImageUrl?: unknown;
    referenceImageUrl?: unknown;
    videoUrl?: unknown;
    audioUrl?: unknown;
    sourceUrl?: unknown;
  };
  if (node.type === "videoNode") {
    return stringOrNull(data.videoUrl) || stringOrNull(data.sourceUrl) || stringOrNull(data.previewImageUrl);
  }
  if (node.type === "audioNode") {
    return stringOrNull(data.audioUrl) || stringOrNull(data.sourceUrl);
  }
  return (
    stringOrNull(data.imageUrl) ||
    stringOrNull(data.previewImageUrl) ||
    stringOrNull(data.referenceImageUrl) ||
    stringOrNull(data.videoUrl) ||
    stringOrNull(data.audioUrl) ||
    stringOrNull(data.sourceUrl)
  );
}

function canvasReferencePreviewUrl(node: CanvasNode): string | null {
  const data = node.data as {
    imageUrl?: unknown;
    previewImageUrl?: unknown;
    referenceImageUrl?: unknown;
    videoUrl?: unknown;
  };
  if (node.type === "videoNode") {
    return stringOrNull(data.previewImageUrl) || stringOrNull(data.videoUrl);
  }
  return stringOrNull(data.previewImageUrl) || stringOrNull(data.imageUrl) || stringOrNull(data.referenceImageUrl);
}

function canvasNodeToReferencePreview(node: CanvasNode): CanvasNodeReferencePreview {
  return {
    nodeId: node.id,
    label: getCanvasNodeLabel(node),
    nodeType: node.type ?? null,
    mediaType: canvasReferenceMediaType(node),
    sourceUrl: canvasReferenceSourceUrl(node),
    previewUrl: canvasReferencePreviewUrl(node),
  };
}

function getSelectedFreezoneNodes(nodes: CanvasNode[], selectedNodeId: string | null): CanvasNode[] {
  const selected = new Map<string, CanvasNode>();
  for (const node of nodes) {
    if (node.selected || node.id === selectedNodeId) selected.set(node.id, node);
  }
  return [...selected.values()];
}

function canvasReferenceResolvedUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  return resolveMediaUrl(value) ?? value;
}

function canvasReferenceIsImageUrl(value: string | null): boolean {
  return /\.(avif|gif|jpe?g|png|webp)(\?|#|$)/i.test(value ?? "");
}

function canvasReferenceIsVideoUrl(value: string | null): boolean {
  return /\.(m4v|mov|mp4|webm)(\?|#|$)/i.test(value ?? "");
}

function CanvasReferenceVideoPreview({
  src,
  title,
  iconClassName = "size-5",
  animated = false,
}: {
  src: string;
  title: string;
  iconClassName?: string;
  animated?: boolean;
}) {
  const videoSrc = animated || src.includes("#") ? src : `${src}#t=0.1`;
  return (
    <div className="relative h-full w-full bg-black">
      <video
        src={videoSrc}
        className="h-full w-full object-cover"
        autoPlay={animated}
        loop={animated}
        muted
        playsInline
        preload="metadata"
        aria-label={title}
      />
      <div className={cn(
        "pointer-events-none absolute inset-0 flex items-center justify-center text-white/90 transition-opacity",
        animated
          ? "bg-black/5 opacity-0 group-hover/canvas-ref:opacity-100"
          : "bg-black/10 opacity-100",
      )}>
        <Play className={iconClassName} />
      </div>
    </div>
  );
}

function focusCanvasReferenceNode(nodeId: string): void {
  const store = useCanvasStore.getState();
  if (!store.nodes.some((node) => node.id === nodeId)) return;
  store.onNodesChange(
    store.nodes.map((node) => ({
      id: node.id,
      type: "select" as const,
      selected: node.id === nodeId,
    })),
  );
  store.setSelectedNode(nodeId);
  store.requestFocusNode(nodeId);
}

function removeCanvasReferenceNode(nodeId: string): void {
  const store = useCanvasStore.getState();
  if (!store.nodes.some((node) => node.id === nodeId)) return;
  store.onNodesChange([{ id: nodeId, type: "select", selected: false }]);
  if (store.selectedNodeId === nodeId) {
    const nextSelectedNodeId = store.nodes.find((node) => node.id !== nodeId && node.selected)?.id ?? null;
    store.setSelectedNode(nextSelectedNodeId);
  }
}

function handleCanvasReferenceKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  nodeId: string,
): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  focusCanvasReferenceNode(nodeId);
}

function CanvasNodeReferenceThumb({
  node,
  onRemove,
}: {
  node: CanvasNodeReferencePreview;
  onRemove?: () => void;
}) {
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const [previewPosition, setPreviewPosition] = useState<{ left: number; top: number } | null>(null);
  const mediaSrc = canvasReferenceResolvedUrl(node.sourceUrl);
  const previewSrc = canvasReferenceResolvedUrl(node.previewUrl) ?? mediaSrc;
  const isVideo = node.mediaType === "video" || canvasReferenceIsVideoUrl(mediaSrc);
  const previewIsImage = canvasReferenceIsImageUrl(previewSrc);
  const previewIsVideo = canvasReferenceIsVideoUrl(previewSrc) || (isVideo && !previewIsImage);
  const isImage =
    node.mediaType === "image" ||
    node.mediaType === "pano360" ||
    canvasReferenceIsImageUrl(mediaSrc);
  const title = node.label || node.nodeId;
  const updatePreviewPosition = useCallback(() => {
    const rect = thumbRef.current?.getBoundingClientRect();
    if (!rect) return;
    const previewWidth = 160;
    const previewHeight = 196;
    const left = Math.min(
      Math.max(rect.left + rect.width / 2, previewWidth / 2 + 12),
      window.innerWidth - previewWidth / 2 - 12,
    );
    const top = rect.top - previewHeight - 8 > 12
      ? rect.top - previewHeight - 8
      : rect.bottom + 8;
    setPreviewPosition({ left, top });
  }, []);

  return (
    <div
      ref={thumbRef}
      className="group relative size-11 shrink-0 cursor-pointer overflow-visible focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
      aria-label={`${title} · ${node.nodeId}`}
      role="button"
      onMouseEnter={updatePreviewPosition}
      onMouseMove={updatePreviewPosition}
      onMouseLeave={() => setPreviewPosition(null)}
      onFocus={updatePreviewPosition}
      onBlur={() => setPreviewPosition(null)}
      onClick={() => focusCanvasReferenceNode(node.nodeId)}
      onKeyDown={(event) => handleCanvasReferenceKeyDown(event, node.nodeId)}
      tabIndex={0}
    >
      <div className="h-full w-full overflow-hidden rounded-lg border border-white/10 bg-white/[0.07] transition group-hover:border-white/25 group-hover:ring-2 group-hover:ring-white/10">
        {previewSrc && previewIsVideo ? (
          <CanvasReferenceVideoPreview src={previewSrc} title={title} iconClassName="size-4" />
        ) : previewSrc && (previewIsImage || isImage) ? (
          <img
            src={previewSrc}
            alt={title}
            className="h-full w-full object-cover"
            loading="lazy"
            decoding="async"
            draggable={false}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            {isVideo ? <Play className="size-4" /> : <ListTree className="size-4" />}
          </div>
      )}
      </div>
      <button
        type="button"
        className="absolute -right-1.5 -top-1.5 z-20 flex size-4 items-center justify-center rounded-full border border-white/15 bg-background/95 text-muted-foreground opacity-0 shadow-sm transition hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
        aria-label={`移除 ${title}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setPreviewPosition(null);
          removeCanvasReferenceNode(node.nodeId);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
        }}
      >
        <X className="size-2.5" />
      </button>
      {previewPosition
        ? createPortal(
          <div
            className="pointer-events-none fixed z-[9999] w-40 -translate-x-1/2 overflow-hidden rounded-xl border border-white/10 bg-popover shadow-2xl"
            style={{ left: previewPosition.left, top: previewPosition.top }}
          >
            <div className="h-40 bg-black/30">
              {mediaSrc && isVideo ? (
                <CanvasReferenceVideoPreview
                  src={mediaSrc}
                  title={title}
                  iconClassName="size-8"
                  animated
                />
              ) : mediaSrc && isImage ? (
                <img
                  src={mediaSrc}
                  alt={title}
                  className="h-full w-full object-cover"
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                  {isVideo ? <Play className="size-8" /> : <ListTree className="size-8" />}
                </div>
              )}
            </div>
            <div className="truncate px-3 py-2 text-xs font-semibold text-popover-foreground">
              {title}
            </div>
          </div>,
          document.body,
        )
        : null}
      {onRemove && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          className="pointer-events-none absolute -right-0.5 -top-0.5 z-10 rounded-full bg-background/90 p-0.5 text-muted-foreground opacity-0 shadow-sm transition group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 hover:bg-background hover:text-foreground"
          aria-label="移除画布引用"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

function pushParsedCanvasJsonText(values: unknown[], text: string): void {
  const candidates = [text];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]) candidates.push(match[1]);
  }

  const firstObject = text.indexOf("{");
  const lastObject = text.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) {
    candidates.push(text.slice(firstObject, lastObject + 1));
  }

  const firstArray = text.indexOf("[");
  const lastArray = text.lastIndexOf("]");
  if (firstArray >= 0 && lastArray > firstArray) {
    candidates.push(text.slice(firstArray, lastArray + 1));
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    try {
      values.push(JSON.parse(trimmed));
    } catch {
      values.push(trimmed);
    }
  }
}

export function canvasCommandCandidateValues(message: ChatMessage): unknown[] {
  const values: unknown[] = [];
  if (message.role !== "tool") {
    const { blocks } = extractStructuredBlocks(message);
    values.push(...blocks.map((block) => block.value));
  }
  const raw = message.raw && typeof message.raw === "object"
    ? (message.raw as Record<string, unknown>)
    : null;
  const result = raw?.result;
  const resultText =
    typeof result === "string"
      ? result
      : result && typeof result === "object" && typeof (result as Record<string, unknown>).text === "string"
        ? String((result as Record<string, unknown>).text)
        : "";
  const toolName = typeof raw?.name === "string" ? raw.name : "";
  const isCanvasContextTool =
    toolName === "freezone_get_canvas_ontology" ||
    toolName === "freezone_summarize_canvas" ||
    toolName === "freezone_get_canvas_action_catalog" ||
    toolName === "freezone_get_canvas_command_catalog" ||
    toolName === "freezone_get_link_type_catalog" ||
    toolName === "freezone_get_selection" ||
    toolName === "freezone_get_node_detail" ||
    toolName === "freezone_get_neighbor_graph" ||
    toolName === "freezone_get_node_action_catalog" ||
    toolName === "freezone_get_node_create_schema" ||
    toolName === "freezone_get_audio_voice_options" ||
    toolName === "freezone_get_slot_candidates" ||
    toolName === "freezone_get_mainline_projection_assets" ||
    toolName === "freezone_validate_canvas_commands";
  const mayContainCanvasCommand =
    raw?.name === "freezone_request_canvas_context" ||
    FREEZONE_CANVAS_WRITE_TOOL_NAME_SET.has(toolName) ||
    isCanvasContextTool ||
    resultText.includes("canvas_chat_commands.v1") ||
    resultText.includes("canvas_context_request.v1") ||
    resultText.includes("canvas_command_emitted");
  if (message.role === "tool" && !mayContainCanvasCommand) return values;
  if (!isCanvasContextTool) {
    if (typeof result === "string") pushParsedCanvasJsonText(values, result);
    if (result && typeof result === "object") {
      const record = result as Record<string, unknown>;
      values.push(result);
      if (record.envelope) values.push(record.envelope);
      if (typeof record.text === "string") pushParsedCanvasJsonText(values, record.text);
    }
  }
  for (const key of ["input", "rawInput", "raw_input", "raw"]) {
    const value = raw?.[key];
    if (!value || typeof value !== "object") continue;
    values.push(value);
    const record = value as Record<string, unknown>;
    if (record.envelope) values.push(record.envelope);
    if (record.rawInput && typeof record.rawInput === "object") values.push(record.rawInput);
    if (record.raw_input && typeof record.raw_input === "object") values.push(record.raw_input);
    if (typeof record.text === "string") pushParsedCanvasJsonText(values, record.text);
  }
  return values;
}

type ComposerEnterEventLike = {
  key: string;
  shiftKey: boolean;
  defaultPrevented: boolean;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
  };
};

export function shouldSubmitComposerEnter(event: ComposerEnterEventLike): boolean {
  if (event.key !== "Enter" || event.shiftKey || event.defaultPrevented) return false;
  if (event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229) return false;
  return true;
}

type ComposerWaitingIndicatorInput = {
  busy: boolean;
  hasAssistantText: boolean;
  streamText: string;
  pendingCanvasCommandApprovalCount: number;
  hasPendingVisibleUserMessage: boolean;
  hasThinkingCanvasContextActivity: boolean;
  hasActiveComposerPrompt?: boolean;
};

export function shouldShowComposerWaitingIndicator(input: ComposerWaitingIndicatorInput): boolean {
  void input.hasAssistantText;
  void input.streamText;
  return (
    input.busy &&
    input.pendingCanvasCommandApprovalCount === 0 &&
    input.hasPendingVisibleUserMessage &&
    !input.hasThinkingCanvasContextActivity &&
    !input.hasActiveComposerPrompt
  );
}

export function shouldShowComposerWaitingStatus(
  showWaitingIndicator: boolean,
  variant: SuperChatPanelVariant,
): boolean {
  void variant;
  return showWaitingIndicator;
}

const CANVAS_CONTEXT_REQUEST_LABELS: Record<string, string> = {
  canvas_ontology: "画布 Ontology",
  canvas_summary: "画布摘要",
  canvas_action_catalog: "画布能力",
  canvas_command_catalog: "命令规则",
  node_detail: "节点详情",
  neighbor_graph: "上下游关系",
  node_action_catalog: "节点能力",
  action_catalog: "节点能力",
  action_catalog_by_id: "能力详情",
  node_create_schema: "节点参数",
  audio_voice_options: "音色选项",
  slot_candidates: "可提交槽位",
  mainline_projection_assets: "主线资产",
  selection_detail: "当前选择",
  link_type_catalog: "连线类型",
  validate_canvas_commands: "命令校验",
};
const CANVAS_CONTEXT_THINKING_LABEL = "正在思考中";
type CanvasContextActivity = {
  key: string;
  turnId: string | null;
  bridgeKey: string | null;
  status: "running" | "done" | "failed";
  labels: string[];
  errors: string[];
  repeatCount?: number;
  anchorTextPrefix?: string | null;
  surfaceOrder?: number;
};

type CanvasCommandPlan = {
  index: number;
  type: CanvasChatCommand["type"];
  label: string;
  primary?: string;
  details: string[];
  destructive?: boolean;
};

type CanvasCommandFeedbackStep = {
  commandIndex: number;
  type: string;
  status: string;
  label: string;
  nodeId?: string;
  action?: string;
  createdNodeId?: string;
  error?: string;
};

type CanvasCommandFeedback = Pick<CanvasChatCommandApplyResult, "applied" | "openedUiActions" | "errors"> & {
  commandResults: CanvasCommandFeedbackStep[];
  key: string;
  plans?: CanvasCommandPlan[];
  anchorTextPrefix?: string;
  surfaceOrder?: number;
};

const CANVAS_APPROVAL_IMAGE_SIZE_OPTIONS = ["1K", "2K", "4K"] as const;
const CANVAS_APPROVAL_IMAGE_QUALITY_OPTIONS = ["low", "medium", "high"] as const;
const CANVAS_APPROVAL_IMAGE_ASPECT_RATIO_OPTIONS = [
  "auto",
  "1:1",
  "9:16",
  "16:9",
  "3:4",
  "4:3",
  "3:2",
  "2:3",
  "4:5",
  "5:4",
  "21:9",
] as const;
const CANVAS_APPROVAL_IMAGE_COUNT_OPTIONS = [1, 2, 4] as const;
const CANVAS_APPROVAL_VIDEO_QUALITY_OPTIONS: readonly VideoGenQuality[] = ["480P", "720P", "1080P"];
const CANVAS_APPROVAL_VIDEO_COUNT_OPTIONS = [1, 2, 4] as const;
const CANVAS_APPROVAL_VIDEO_DURATION_MIN = 5;
const CANVAS_APPROVAL_VIDEO_DURATION_MAX = 15;

type PendingCanvasCommandApproval = {
  id: string;
  key: string;
  messageId: string;
  turnId?: string | null;
  bridgeKey?: string | null;
  agentId?: string | null;
  anchorTextPrefix?: string | null;
  surfaceOrder?: number;
  receivedAt: number;
  autoExpires?: boolean;
  expiresAt?: number;
  envelopes: CanvasChatCommandEnvelope[];
  commandCount: number;
  plans: CanvasCommandPlan[];
};

type CanvasApprovalImageParams = {
  nodeId: string;
  model: string;
  aspectRatio: string;
  size: string;
  quality: string;
  count: number;
};

type CanvasApprovalVideoParams = {
  nodeId: string;
  model: string;
  aspectRatio: string;
  quality: VideoGenQuality;
  durationSec: number;
  generateAudio: boolean;
  count: 1 | 2 | 4;
};

type CanvasCommandApprovalCancelReason = "user" | "timeout";

type CanvasCommandFlowItem =
  | { kind: "text"; key: string; text: string }
  | { kind: "approval"; key: string; approval: PendingCanvasCommandApproval }
  | { kind: "feedback"; key: string; feedback: CanvasCommandFeedback }
  | { kind: "context"; key: string; activity: CanvasContextActivity }
  | { kind: "skill_studio"; key: string; event: SkillStudioUiEvent }
  | { kind: "clarification"; key: string; event: AssistantClarificationUiEvent };

type CanvasCommandSurfaceEvent =
  | {
      kind: "approval";
      key: string;
      order: number;
      anchorTextPrefix?: string | null;
      approval: PendingCanvasCommandApproval;
    }
  | {
      kind: "feedback";
      key: string;
      order: number;
      anchorTextPrefix?: string | null;
      feedback: CanvasCommandFeedback;
    }
  | {
      kind: "context";
      key: string;
      order: number;
      anchorTextPrefix?: string | null;
      activity: CanvasContextActivity;
    }
  | {
      kind: "skill_studio";
      key: string;
      order: number;
      anchorTextPrefix?: string | null;
      event: SkillStudioUiEvent;
    }
  | {
      kind: "clarification";
      key: string;
      order: number;
      anchorTextPrefix?: string | null;
      event: AssistantClarificationUiEvent;
    };

const CANVAS_COMMAND_EXECUTION_MODE_STORAGE_KEY = "freezone.canvasCommandExecutionMode";

function loadCanvasCommandExecutionMode(): CanvasCommandExecutionMode {
  if (typeof window === "undefined") return "manual_confirm";
  return window.localStorage.getItem(CANVAS_COMMAND_EXECUTION_MODE_STORAGE_KEY) === "auto_execute"
    ? "auto_execute"
    : "manual_confirm";
}

function saveCanvasCommandExecutionMode(mode: CanvasCommandExecutionMode): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CANVAS_COMMAND_EXECUTION_MODE_STORAGE_KEY, mode);
}

function canvasSurfaceEventOrder(value: Record<string, unknown>, fallbackIndex = 0): number {
  if (typeof value.id === "number" && Number.isFinite(value.id)) return value.id;
  if (typeof value.received_at === "number" && Number.isFinite(value.received_at)) return value.received_at;
  if (typeof value.receivedAt === "number" && Number.isFinite(value.receivedAt)) return value.receivedAt;
  return fallbackIndex;
}

function compactJsonValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function nodeTypeLabel(nodeType: string | undefined): string {
  if (!nodeType) return "节点";
  if (nodeType === "imageGenNode") return "图片节点";
  if (nodeType === "videoNode") return "视频节点";
  if (nodeType === "textAnnotationNode") return "文本节点";
  if (nodeType === "audioNode") return "音频节点";
  if (nodeType === "scriptNode") return "脚本节点";
  return nodeType;
}

function canvasCommandPlanLabel(command: CanvasChatCommand): string {
  switch (command.type) {
    case "create_node":
      return `创建${nodeTypeLabel(command.node_type)}`;
    case "add_next_node":
      return `添加下游${nodeTypeLabel(command.node_type)}`;
    case "update_node_data":
      return "更新节点参数";
    case "delete_nodes":
      return "删除节点";
    case "delete_edges":
      return "断开连接";
    case "create_edge":
      return "创建连接";
    case "layout_nodes":
      return "整理布局";
    case "group_nodes":
      return "创建普通组";
    case "move_nodes":
      return "移动节点";
    case "select_nodes":
      return "选中节点";
    case "run_node_action":
      if (command.action === "generate_image") return "生成图片";
      if (command.action === "generate_video") return "生成视频";
      if (command.action === "open_video_compose_modal") return "打开视频合成";
      if (command.action === "open_video_viewer") return "打开视频";
      return "执行节点动作";
    case "open_mainline_projection":
      return "打开主线虾画";
    default:
      return "画布操作";
  }
}

function canvasCommandPlanPrimary(command: CanvasChatCommand): string | undefined {
  switch (command.type) {
    case "create_node":
      return command.client_id;
    case "add_next_node":
      return command.source_node_id;
    case "update_node_data":
    case "run_node_action":
      return command.node_id;
    case "open_mainline_projection":
      if (command.request.scope === "beat") return `EP${command.request.episode ?? ""} / Beat ${command.request.beat ?? ""}`;
      if (command.request.scope === "episode") return `EP${command.request.episode ?? ""}`;
      return command.request.asset_id ?? command.request.identity_id ?? command.request.character ?? command.request.asset_kind ?? "主线素材";
    case "delete_nodes":
    case "select_nodes":
    case "group_nodes":
      return command.node_ids.join(", ");
    case "layout_nodes":
      return command.node_ids?.length ? command.node_ids.join(", ") : "当前画布";
    case "create_edge":
      return `${command.source} -> ${command.target}`;
    case "delete_edges":
      return command.pairs?.map((pair) => `${pair.source} - ${pair.target}`).join(", ")
        || command.edge_ids?.join(", ");
    case "move_nodes":
      return [
        ...Object.keys(command.positions ?? {}),
        ...Object.keys(command.deltas ?? {}),
      ].join(", ");
    default:
      return undefined;
  }
}

function canvasCommandPlanDetails(command: CanvasChatCommand): string[] {
  const details: string[] = [];
  if (command.type === "create_node" || command.type === "add_next_node") {
    if (command.type === "create_node" && command.position) {
      details.push(`位置：${Math.round(command.position.x)}, ${Math.round(command.position.y)}`);
    }
    if (command.type === "add_next_node") {
      details.push(`上游：${command.source_node_id}`);
      if (command.connect) details.push("自动连线");
    }
    for (const key of ["displayName", "title", "content", "text", "prompt", "model", "size", "requestAspectRatio", "aspectRatio", "count"] as const) {
      const value = command.data?.[key as keyof typeof command.data];
      if (value !== undefined && value !== "") details.push(`${key}：${compactJsonValue(value)}`);
    }
  } else if (command.type === "update_node_data") {
    for (const [key, value] of Object.entries(command.data)) {
      if (value !== undefined && value !== "") details.push(`${key} -> ${compactJsonValue(value)}`);
    }
  } else if (command.type === "run_node_action") {
    details.push(`动作：${command.action}`);
  } else if (command.type === "open_mainline_projection") {
    details.push(`范围：${command.request.scope}`);
    if (typeof command.request.episode === "number") details.push(`集数：${command.request.episode}`);
    if (typeof command.request.beat === "number") details.push(`Beat：${command.request.beat}`);
    if (command.request.primary_slot) details.push(`目标：${command.request.primary_slot}`);
    if (command.request.asset_kind) details.push(`素材类型：${command.request.asset_kind}`);
  } else if (command.type === "create_edge") {
    details.push(`link_type：${command.link_type}`);
  } else if (command.type === "layout_nodes") {
    details.push(`模式：${command.mode}`);
    details.push(command.node_ids?.length ? `数量：${command.node_ids.length}` : "范围：当前画布全部节点");
  } else if (command.type === "group_nodes") {
    details.push(`数量：${command.node_ids.length}`);
    if (command.label) details.push(`名称：${command.label}`);
  } else if (command.type === "move_nodes") {
    const moveCount = new Set([
      ...Object.keys(command.positions ?? {}),
      ...Object.keys(command.deltas ?? {}),
    ]).size;
    details.push(`数量：${moveCount}`);
  } else if (command.type === "delete_nodes") {
    details.push(`数量：${command.node_ids.length}`);
  } else if (command.type === "delete_edges") {
    details.push(`数量：${(command.edge_ids?.length ?? 0) + (command.pairs?.length ?? 0)}`);
  }
  return details;
}

function canvasCommandIsDestructive(command: CanvasChatCommand): boolean {
  return command.type === "delete_nodes" || command.type === "delete_edges";
}

function canvasCommandPlansFromEnvelopes(envelopes: CanvasChatCommandEnvelope[] | undefined): CanvasCommandPlan[] {
  if (!envelopes || envelopes.length === 0) return [];
  const plans: CanvasCommandPlan[] = [];
  let index = 0;
  for (const envelope of envelopes) {
    for (const command of envelope.commands) {
      plans.push({
        index,
        type: command.type,
        label: canvasCommandPlanLabel(command),
        primary: canvasCommandPlanPrimary(command),
        details: canvasCommandPlanDetails(command),
        destructive: canvasCommandIsDestructive(command),
      });
      index += 1;
    }
  }
  return plans;
}

function canvasContextLabelsFromTypes(types: string[]): string[] {
  return Array.from(new Set(types))
    .map((type) => CANVAS_CONTEXT_REQUEST_LABELS[type] ?? type)
    .filter((label) => label.trim().length > 0)
    .slice(0, 3);
}

function collectCanvasContextRequestTypes(value: unknown, output: string[] = []): string[] {
  if (!value || typeof value !== "object") return output;
  const record = value as Record<string, unknown>;
  if (record.schema_version === "canvas_context_request.v1" && Array.isArray(record.requests)) {
    for (const request of record.requests) {
      if (!request || typeof request !== "object") continue;
      const type = (request as Record<string, unknown>).type;
      if (typeof type === "string" && type.trim()) output.push(type.trim());
    }
  }
  for (const key of ["input", "raw", "rawInput", "raw_input", "previousRaw", "envelope", "result", "data"]) {
    collectCanvasContextRequestTypes(record[key], output);
  }
  return output;
}

function canvasContextLabelsFromResponses(responses: Array<Record<string, unknown>> | undefined): string[] {
  if (!responses || responses.length === 0) return [];
  return canvasContextLabelsFromTypes(
    responses
      .map((response) => response.type)
      .filter((type): type is string => typeof type === "string" && type.trim().length > 0),
  );
}

function canvasContextActivityFromUiEvent(event: unknown, fallbackIndex = 0): CanvasContextActivity | null {
  if (!event || typeof event !== "object") return null;
  const value = event as Record<string, unknown>;
  if (value.type !== "canvas_context_result") return null;
  const result = value.result && typeof value.result === "object"
    ? value.result as Record<string, unknown>
    : null;
  if (!result) return null;
  const responses = (Array.isArray(result.responses) ? result.responses : []).filter(
    (item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)),
  );
  const errors = (Array.isArray(result.errors) ? result.errors : []).map((item) => String(item)).filter(Boolean);
  const ok = result.ok !== false && errors.length === 0;
  return {
    key: typeof value.bridge_key === "string" && value.bridge_key.trim()
      ? `context:${value.bridge_key.trim()}`
      : `context-event:${String(value.id ?? value.received_at ?? value.receivedAt ?? fallbackIndex)}`,
    turnId: null,
    bridgeKey: typeof value.bridge_key === "string" ? value.bridge_key : null,
    status: ok ? "done" : "failed",
    labels: canvasContextLabelsFromResponses(responses),
    errors,
    surfaceOrder: canvasSurfaceEventOrder(value, fallbackIndex),
    anchorTextPrefix: typeof value.anchor_text_prefix === "string"
      ? value.anchor_text_prefix
      : typeof value.anchorTextPrefix === "string"
        ? value.anchorTextPrefix
        : null,
  };
}

function canvasContextActivitiesFromUiEvents(events: unknown[] | undefined): CanvasContextActivity[] {
  if (!events || events.length === 0) return [];
  return events
    .map((event, index) => canvasContextActivityFromUiEvent(event, index))
    .filter((activity): activity is CanvasContextActivity => Boolean(activity));
}

function mergeCanvasContextActivity(current: CanvasContextActivity[] | undefined, activity: CanvasContextActivity) {
  const items = current ?? [];
  const index = items.findIndex((item) => item.key === activity.key);
  if (index < 0) return [...items, activity];
  const next = [...items];
  next[index] = {
    ...next[index],
    ...activity,
    labels: activity.labels.length > 0 ? activity.labels : next[index].labels,
    errors: activity.errors.length > 0 ? activity.errors : next[index].errors,
    anchorTextPrefix: next[index].anchorTextPrefix ?? activity.anchorTextPrefix,
    surfaceOrder:
      next[index].surfaceOrder == null
        ? activity.surfaceOrder
        : activity.surfaceOrder == null
          ? next[index].surfaceOrder
          : Math.min(next[index].surfaceOrder, activity.surfaceOrder),
  };
  return next;
}

function mergeCanvasContextActivitySources(...sources: Array<CanvasContextActivity[] | undefined>) {
  let merged: CanvasContextActivity[] = [];
  for (const source of sources) {
    if (!source || source.length === 0) continue;
    for (const activity of source) merged = mergeCanvasContextActivity(merged, activity);
  }
  return merged;
}

export const mergeCanvasContextActivitiesForTest = mergeCanvasContextActivitySources;

function createThinkingCanvasContextActivity(turnId: string): CanvasContextActivity {
  return {
    key: `thinking:${turnId}`,
    turnId,
    bridgeKey: null,
    status: "running",
    labels: [CANVAS_CONTEXT_THINKING_LABEL],
    errors: [],
  };
}

function canvasContextActivityIsValidation(activity: CanvasContextActivity): boolean {
  return activity.labels.includes(CANVAS_CONTEXT_REQUEST_LABELS.validate_canvas_commands) || activity.labels.includes("命令校验");
}

function canvasCommandAnchorEndIndex(text: string, anchorTextPrefix?: string | null): number {
  if (!text) return 0;
  if (anchorTextPrefix == null) return text.length;
  if (anchorTextPrefix === "") return 0;
  const index = text.indexOf(anchorTextPrefix);
  if (index >= 0) return index + anchorTextPrefix.length;
  const relaxedIndex = relaxedCanvasCommandAnchorEndIndex(text, anchorTextPrefix);
  return relaxedIndex ?? text.length;
}

function relaxedCanvasCommandAnchorEndIndex(text: string, anchorTextPrefix: string): number | null {
  const tokens = anchorTextPrefix.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return anchorTextPrefix === "" ? 0 : null;
  let cursor = 0;
  let matchedEnd = 0;
  for (const token of tokens) {
    const index = text.indexOf(token, cursor);
    if (index < 0) return null;
    matchedEnd = index + token.length;
    cursor = matchedEnd;
  }
  return matchedEnd;
}

function firstCanvasCommandSemanticMarkerIndex(text: string, markers: string[]): number | null {
  let best: number | null = null;
  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index < 0) continue;
    best = best == null ? index : Math.min(best, index);
  }
  return best;
}

function canvasCommandSemanticAnchorIndex(text: string, event: CanvasCommandSurfaceEvent): number | null {
  if (!text) return null;
  if (
    event.kind === "context" &&
    (
      event.activity.labels.includes(CANVAS_CONTEXT_REQUEST_LABELS.validate_canvas_commands) ||
      event.activity.labels.includes("命令校验")
    )
  ) {
    return firstCanvasCommandSemanticMarkerIndex(text, [
      "验证通过",
      "校验通过",
      "验证失败",
      "校验失败",
      "命令验证",
      "命令校验",
    ]);
  }
  if (event.kind === "context") {
    const readAnchor = canvasContextReadSemanticAnchorIndex(text, event.activity);
    if (readAnchor != null) return readAnchor;
  }
  if (event.kind === "feedback" && event.feedback.applied + event.feedback.openedUiActions > 0) {
    return firstCanvasCommandSemanticMarkerIndex(text, [
      "已经在画布上",
      "已在画布上",
      "已成功创建",
      "成功创建",
      "已经成功",
      "我已经成功",
      "已创建",
      "创建好了",
      "搭建好了",
    ]);
  }
  return null;
}

function canvasContextReadSemanticAnchorIndex(text: string, activity: CanvasContextActivity): number | null {
  if (!activity.labels.some((label) => label !== CANVAS_CONTEXT_REQUEST_LABELS.validate_canvas_commands && label !== "命令校验")) {
    return null;
  }
  const requestMarkers = [
    "我需要获取",
    "我需要读取",
    "我先获取",
    "我先读取",
    "先获取",
    "先读取",
    "让我先查看",
    "让我查看",
    "查看一下",
    "创建schema",
    "获取该节点的详细信息",
    "读取节点详情",
    "检查当前",
    "确认当前",
  ];
  const requestIndex = firstCanvasCommandSemanticMarkerIndex(text, requestMarkers);
  if (requestIndex != null) {
    const paragraphEnd = text.indexOf("\n\n", requestIndex);
    return paragraphEnd < 0 ? text.length : paragraphEnd + 2;
  }
  return firstCanvasCommandSemanticMarkerIndex(text, [
    "现在我已经获取",
    "现在我已获取",
    "已经获取",
    "已获取",
    "已经读取",
    "已读取",
  ]);
}

function canvasCommandSurfaceEventAnchorEndIndex(text: string, event: CanvasCommandSurfaceEvent): number {
  if (event.kind === "skill_studio" || event.kind === "clarification") {
    if (event.anchorTextPrefix == null) return text.length;
    if (event.anchorTextPrefix === "") return 0;
    const anchorEndIndex = canvasCommandAnchorEndIndex(text, event.anchorTextPrefix);
    const hasStaleAnchor =
      typeof event.anchorTextPrefix === "string"
      && event.anchorTextPrefix.length > 0
      && !text.startsWith(event.anchorTextPrefix);
    if (hasStaleAnchor) {
      const sharedPrefixLength = commonPrefixLength(text, event.anchorTextPrefix);
      if (sharedPrefixLength >= Math.min(16, text.length, event.anchorTextPrefix.length)) return sharedPrefixLength;
      return text.length;
    }
    return anchorEndIndex;
  }
  const anchorIndex = canvasCommandAnchorEndIndex(text, event.anchorTextPrefix);
  const semanticIndex = canvasCommandSemanticAnchorIndex(text, event);
  if (
    event.kind === "context" &&
    event.anchorTextPrefix == null &&
    semanticIndex == null
  ) {
    return 0;
  }
  if (
    event.kind === "feedback" &&
    event.anchorTextPrefix == null &&
    event.feedback.applied + event.feedback.openedUiActions > 0
  ) {
    return 0;
  }
  return semanticIndex != null && semanticIndex < anchorIndex ? semanticIndex : anchorIndex;
}

function canvasCommandFeedbackDedupeKey(feedback: CanvasCommandFeedback): string {
  return JSON.stringify({
    applied: feedback.applied,
    openedUiActions: feedback.openedUiActions,
    errors: feedback.errors,
    commandResults: (feedback.commandResults ?? []).map((step) => ({
      commandIndex: step.commandIndex,
      type: step.type,
      status: step.status,
      label: step.label,
      nodeId: step.nodeId,
      action: step.action,
      error: step.error,
    })),
    plans: feedback.plans,
  });
}

function dedupeCanvasCommandFeedbacks(feedbacks: CanvasCommandFeedback[]): CanvasCommandFeedback[] {
  if (feedbacks.length < 2) return feedbacks;
  const indexByKey = new Map<string, number>();
  const deduped: CanvasCommandFeedback[] = [];
  for (const feedback of feedbacks) {
    const key = canvasCommandFeedbackDedupeKey(feedback);
    const existingIndex = indexByKey.get(key);
    if (existingIndex !== undefined) {
      const existing = deduped[existingIndex];
      deduped[existingIndex] = {
        ...existing,
        anchorTextPrefix: existing.anchorTextPrefix ?? feedback.anchorTextPrefix,
        surfaceOrder:
          existing.surfaceOrder == null
            ? feedback.surfaceOrder
            : feedback.surfaceOrder == null
              ? existing.surfaceOrder
              : Math.min(existing.surfaceOrder, feedback.surfaceOrder),
      };
      continue;
    }
    indexByKey.set(key, deduped.length);
    deduped.push(feedback);
  }
  return deduped;
}

function buildCanvasCommandFlowItems(
  text: string,
  approvals: PendingCanvasCommandApproval[],
  feedbacks: CanvasCommandFeedback[],
  contextActivities: CanvasContextActivity[],
  skillStudioEvents: SkillStudioUiEvent[] = [],
  clarificationEvents: AssistantClarificationUiEvent[] = [],
): CanvasCommandFlowItem[] {
  if (approvals.length === 0 && feedbacks.length === 0 && contextActivities.length === 0 && skillStudioEvents.length === 0 && clarificationEvents.length === 0) return [];
  const dedupedFeedbacks = dedupeCanvasCommandFeedbacks(feedbacks);
  const events: CanvasCommandSurfaceEvent[] = [
    ...approvals.map((approval, index): CanvasCommandSurfaceEvent => ({
      kind: "approval",
      key: `approval:${approval.id}`,
      order: approval.surfaceOrder ?? index,
      anchorTextPrefix: approval.anchorTextPrefix,
      approval,
    })),
    ...dedupedFeedbacks.map((feedback, index): CanvasCommandSurfaceEvent => ({
      kind: "feedback",
      key: `feedback:${feedback.key}`,
      order: feedback.surfaceOrder ?? approvals.length + index,
      anchorTextPrefix: feedback.anchorTextPrefix,
      feedback,
    })),
    ...contextActivities.map((activity, index): CanvasCommandSurfaceEvent => ({
      kind: "context",
      key: `context:${activity.key}`,
      order: activity.surfaceOrder ?? approvals.length + feedbacks.length + index,
      anchorTextPrefix: activity.anchorTextPrefix,
      activity,
    })),
    ...skillStudioEvents.map((event, index): CanvasCommandSurfaceEvent => ({
      kind: "skill_studio",
      key: `skill_studio:${event.type}:${index}`,
      order: uiEventReceivedAt(event) ?? approvals.length + feedbacks.length + contextActivities.length + index,
      anchorTextPrefix: typeof event.anchor_text_prefix === "string" ? event.anchor_text_prefix : null,
      event,
    })),
    ...clarificationEvents.map((event, index): CanvasCommandSurfaceEvent => ({
      kind: "clarification",
      key: `clarification:${event.bridge_key || event.clarification_id || index}`,
      order: uiEventReceivedAt(event) ?? approvals.length + feedbacks.length + contextActivities.length + skillStudioEvents.length + index,
      anchorTextPrefix: typeof event.anchor_text_prefix === "string" ? event.anchor_text_prefix : null,
      event,
    })),
  ].sort((left, right) => {
    const leftIndex = canvasCommandSurfaceEventAnchorEndIndex(text, left);
    const rightIndex = canvasCommandSurfaceEventAnchorEndIndex(text, right);
    return leftIndex - rightIndex || left.order - right.order;
  });

  const items: CanvasCommandFlowItem[] = [];
  let cursor = 0;
  for (const event of events) {
    const anchorEnd = canvasCommandSurfaceEventAnchorEndIndex(text, event);
    const nextCursor = Math.max(cursor, Math.min(anchorEnd, text.length));
    if (nextCursor > cursor) {
      const segment = text.slice(cursor, nextCursor);
      if (segment.trim()) items.push({ kind: "text", key: `text:${cursor}:${nextCursor}`, text: segment });
      cursor = nextCursor;
    }
    if (event.kind === "approval") {
      items.push({ kind: "approval", key: event.key, approval: event.approval });
    } else if (event.kind === "feedback") {
      items.push({ kind: "feedback", key: event.key, feedback: event.feedback });
    } else if (event.kind === "skill_studio") {
      items.push({ kind: "skill_studio", key: event.key, event: event.event });
    } else if (event.kind === "clarification") {
      items.push({ kind: "clarification", key: event.key, event: event.event });
    } else {
      items.push({ kind: "context", key: event.key, activity: event.activity });
    }
  }
  if (cursor < text.length) {
    const segment = text.slice(cursor);
    if (segment.trim()) items.push({ kind: "text", key: `text:${cursor}:end`, text: segment.replace(/^\n+/, "") });
  }
  return items;
}

export const buildCanvasCommandFlowItemsForTest = buildCanvasCommandFlowItems;

function mergeCanvasCommandFeedbackSources(...sources: Array<CanvasCommandFeedback[] | undefined>): CanvasCommandFeedback[] {
  const items = sources.flatMap((source) => source ?? []);
  if (items.length === 0) return [];
  return dedupeCanvasCommandFeedbacks(items);
}

function canvasApprovalPartId(approval: PendingCanvasCommandApproval): string {
  return `canvas_approval:${approval.id}`;
}

function canvasFeedbackPartId(feedback: CanvasCommandFeedback): string {
  return `canvas_feedback:${feedback.key}`;
}

function canvasContextPartId(activity: CanvasContextActivity): string {
  return `canvas_context:${activity.key}`;
}

export const mergeCanvasCommandFeedbacksForTest = mergeCanvasCommandFeedbackSources;

function mergeCanvasCommandResults(
  previous: CanvasCommandFeedbackStep[] | undefined,
  next: CanvasCommandFeedbackStep[],
): CanvasCommandFeedbackStep[] {
  const merged = [...(previous ?? [])];
  for (const step of next) {
    const existingIndex = merged.findIndex(
      (item) =>
        item.commandIndex === step.commandIndex &&
        item.type === step.type &&
        item.nodeId === step.nodeId &&
        item.action === step.action &&
        item.label === step.label,
    );
    if (existingIndex >= 0) {
      merged[existingIndex] = step;
    } else {
      merged.push(step);
    }
  }
  return merged.sort((left, right) => left.commandIndex - right.commandIndex);
}

function mergeCanvasCommandFeedbackValue(
  previous: CanvasCommandFeedback | undefined,
  key: string,
  result: Pick<CanvasChatCommandApplyResult, "applied" | "openedUiActions" | "errors"> & {
    commandResults: CanvasCommandFeedbackStep[];
  },
  plans: CanvasCommandPlan[] = [],
  anchorTextPrefix?: string | null,
  surfaceOrder?: number,
): CanvasCommandFeedback {
  const nextAnchorTextPrefix = anchorTextPrefix == null ? undefined : anchorTextPrefix;
  return {
    key,
    applied: (previous?.applied ?? 0) + result.applied,
    openedUiActions: (previous?.openedUiActions ?? 0) + result.openedUiActions,
    errors: [...(previous?.errors ?? []), ...result.errors],
    commandResults: mergeCanvasCommandResults(previous?.commandResults, result.commandResults),
    plans: [...(previous?.plans ?? []), ...plans],
    anchorTextPrefix: previous?.anchorTextPrefix ?? nextAnchorTextPrefix,
    surfaceOrder: previous?.surfaceOrder ?? surfaceOrder,
  };
}

function appendCanvasCommandFeedbackCard(
  current: CanvasCommandFeedback[] | undefined,
  key: string,
  result: Pick<CanvasChatCommandApplyResult, "applied" | "openedUiActions" | "errors"> & {
    commandResults: CanvasCommandFeedbackStep[];
  },
  plans: CanvasCommandPlan[] = [],
  anchorTextPrefix?: string | null,
  surfaceOrder?: number,
): CanvasCommandFeedback[] {
  const items = current ?? [];
  const index = items.findIndex((item) => item.key === key);
  if (index < 0) return [...items, mergeCanvasCommandFeedbackValue(undefined, key, result, plans, anchorTextPrefix, surfaceOrder)];
  const next = [...items];
  next[index] = mergeCanvasCommandFeedbackValue(next[index], key, result, plans, anchorTextPrefix, surfaceOrder);
  return next;
}

function canvasCommandApplyResultFromUnknown(value: unknown): CanvasChatCommandApplyResult | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Partial<CanvasChatCommandApplyResult>;
  const commandResults = Array.isArray(result.commandResults) ? result.commandResults : [];
  if (
    typeof result.applied !== "number" &&
    typeof result.openedUiActions !== "number" &&
    !Array.isArray(result.errors) &&
    commandResults.length === 0
  ) return null;
  return {
    applied: typeof result.applied === "number" ? result.applied : 0,
    openedUiActions: typeof result.openedUiActions === "number" ? result.openedUiActions : 0,
    createdNodeIds: Array.isArray(result.createdNodeIds)
      ? result.createdNodeIds.filter((item): item is string => typeof item === "string")
      : [],
    errors: Array.isArray(result.errors) ? result.errors.map((item) => String(item)) : [],
    commandResults: commandResults.filter(
      (item): item is CanvasChatCommandApplyStep =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof (item as CanvasChatCommandApplyStep).label === "string" &&
        typeof (item as CanvasChatCommandApplyStep).status === "string",
    ),
  };
}

function canvasCommandFeedbacksFromUiEvents(events: unknown[] | undefined): CanvasCommandFeedback[] {
  if (!events || events.length === 0) return [];
  const feedbacks: CanvasCommandFeedback[] = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const value = event as Record<string, unknown>;
    if (value.type !== "canvas_command_result") continue;
    const result = canvasCommandApplyResultFromUnknown(value.result);
    if (!result) continue;
    const envelopes = Array.isArray(value.envelopes) ? (value.envelopes as CanvasChatCommandEnvelope[]) : undefined;
    const anchorTextPrefix = typeof value.anchor_text_prefix === "string"
      ? value.anchor_text_prefix
      : typeof value.anchorTextPrefix === "string"
        ? value.anchorTextPrefix
        : undefined;
    const key = typeof value.bridge_key === "string" && value.bridge_key.trim()
      ? `bridge:${value.bridge_key.trim()}`
      : `event:${String(value.id ?? value.received_at ?? value.receivedAt ?? feedbacks.length)}`;
    feedbacks.push(
      mergeCanvasCommandFeedbackValue(
        undefined,
        key,
        result,
        canvasCommandPlansFromEnvelopes(envelopes),
        anchorTextPrefix,
        canvasSurfaceEventOrder(value, feedbacks.length),
      ),
    );
  }
  return feedbacks;
}

function canvasCommandApprovalDetailsFromUiEvents(events: unknown[] | undefined): CanvasCommandApprovalEventDetail[] {
  if (!events || events.length === 0) return [];
  const approvals: CanvasCommandApprovalEventDetail[] = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const value = event as Record<string, unknown>;
    if (value.type !== "canvas_command_approval") continue;
    if (!Array.isArray(value.envelopes)) continue;
    const canvasId = typeof value.canvas_id === "string"
      ? value.canvas_id
      : typeof value.canvasId === "string"
        ? value.canvasId
        : null;
    const turnId = typeof value.turn_id === "string"
      ? value.turn_id
      : typeof value.turnId === "string"
        ? value.turnId
        : null;
    const bridgeKey = typeof value.bridge_key === "string"
      ? value.bridge_key
      : typeof value.bridgeKey === "string"
        ? value.bridgeKey
        : null;
    const anchorTextPrefix = typeof value.anchor_text_prefix === "string"
      ? value.anchor_text_prefix
      : typeof value.anchorTextPrefix === "string"
        ? value.anchorTextPrefix
        : null;
    approvals.push({
      canvasId,
      turnId,
      anchorMessageId: typeof value.anchorMessageId === "string" ? value.anchorMessageId : null,
      anchorTextPrefix,
      bridgeKey,
      envelopes: value.envelopes as CanvasChatCommandEnvelope[],
      receivedAt: canvasSurfaceEventOrder(value, approvals.length),
    });
  }
  return approvals;
}

function messageUiEvents(message: ChatMessage): unknown[] | undefined {
  if (message.uiEvents && message.uiEvents.length > 0) return message.uiEvents;
  const raw = message.raw && typeof message.raw === "object" ? (message.raw as Record<string, unknown>) : null;
  const rawEvents = raw && Array.isArray(raw.ui_events)
    ? raw.ui_events
    : raw && Array.isArray(raw.uiEvents)
      ? raw.uiEvents
      : undefined;
  return rawEvents && rawEvents.length > 0 ? rawEvents : undefined;
}

function mergeCanvasCommandFeedbackRecord(
  current: Record<string, CanvasCommandFeedback[]>,
  key: string | undefined | null,
  feedbacks: CanvasCommandFeedback[],
): void {
  if (!key) return;
  let next = current[key] ?? [];
  for (const feedback of feedbacks) {
    next = appendCanvasCommandFeedbackCard(
      next,
      feedback.key,
      feedback,
      feedback.plans ?? [],
      feedback.anchorTextPrefix,
      feedback.surfaceOrder,
    );
  }
  current[key] = next;
}

function canvasCommandFeedbackIsValidationOnly(feedback: CanvasCommandFeedback): boolean {
  const steps = feedback.commandResults ?? [];
  return (
    feedback.applied === 0 &&
    feedback.openedUiActions === 0 &&
    steps.length > 0 &&
    !steps.some((step) => step.label === "已取消") &&
    steps.every((step) => step.type === "validate" || step.label === "校验画布命令")
  );
}

export const canvasCommandFeedbackIsValidationOnlyForTest = canvasCommandFeedbackIsValidationOnly;

function canvasCommandApprovalEnvelopesMatch(left: CanvasChatCommandEnvelope[], right: CanvasChatCommandEnvelope[]) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function isCanvasCommandToolMessage(message: ChatMessage): boolean {
  if (message.role !== "tool") return false;
  const raw = message.raw && typeof message.raw === "object"
    ? (message.raw as Record<string, unknown>)
    : null;
  return (
    [...FREEZONE_CANVAS_WRITE_TOOL_NAME_SET].some((name) => message.text.includes(name)) ||
    FREEZONE_CANVAS_WRITE_TOOL_NAME_SET.has(String(raw?.name ?? "")) ||
    raw?.type === "canvas.command"
  );
}

function findCanvasCommandFeedbackMessageId(messages: ChatMessage[], turnId?: string | null): string | null {
  const candidates = [...messages].reverse();
  if (turnId) {
    const tool = candidates.find((message) => message.turnId === turnId && isCanvasCommandToolMessage(message));
    if (tool) return tool.id;
    const assistant = candidates.find((message) => message.turnId === turnId && message.role === "assistant");
    if (assistant) return assistant.id;
  }
  const latestTool = candidates.find(isCanvasCommandToolMessage);
  return latestTool?.id ?? null;
}

function resolveCanvasCommandFeedbackMessageId(input: {
  anchorMessageId?: string | null;
  messages: ChatMessage[];
  turnId: string | null;
  latestAssistantMessageId: string | null;
  receivedAt?: number | null;
}): string {
  if (input.anchorMessageId) return input.anchorMessageId;
  const sameTurnMessageId = findCanvasCommandFeedbackMessageId(input.messages, input.turnId);
  if (sameTurnMessageId) return sameTurnMessageId;
  if (input.turnId) return `assistant-${input.turnId}`;
  if (input.latestAssistantMessageId) return input.latestAssistantMessageId;
  return `canvas-command-result:${input.receivedAt ?? Date.now()}`;
}

export const resolveCanvasCommandFeedbackMessageIdForTest = resolveCanvasCommandFeedbackMessageId;

function findCanvasCommandApprovalMessageId(messages: ChatMessage[], turnId?: string | null): string | null {
  const candidates = [...messages].reverse();
  if (turnId) {
    const assistant = candidates.find((message) => message.turnId === turnId && message.role === "assistant");
    if (assistant) return assistant.id;
    return null;
  }
  const latestAssistant = candidates.find((message) => message.role === "assistant");
  return latestAssistant?.id ?? null;
}

function resolveCanvasCommandApprovalMessageId(input: {
  anchorMessageId?: string | null;
  messages: ChatMessage[];
  turnId: string | null;
  latestAssistantMessageId: string | null;
  receivedAt?: number | null;
}): string {
  if (input.anchorMessageId) return input.anchorMessageId;
  const sameTurnMessageId = findCanvasCommandApprovalMessageId(input.messages, input.turnId);
  if (sameTurnMessageId) return sameTurnMessageId;
  if (input.turnId) return `assistant-${input.turnId}`;
  if (input.latestAssistantMessageId) return input.latestAssistantMessageId;
  return `tool-canvas-command:${input.receivedAt ?? Date.now()}`;
}

export const resolveCanvasCommandApprovalMessageIdForTest = resolveCanvasCommandApprovalMessageId;

function canvasCommandApprovalKey(
  bridgeKey: string | null | undefined,
  turnId: string | null | undefined,
  envelopes: unknown[],
  receivedAt?: number,
): string {
  if (bridgeKey && turnId) return `bridge:${bridgeKey}:turn:${turnId}`;
  if (bridgeKey) return `bridge:${bridgeKey}`;
  try {
    return `local:${turnId ?? "no-turn"}:${JSON.stringify(envelopes)}`;
  } catch {
    return `local:${turnId ?? "no-turn"}:${receivedAt ?? Date.now()}`;
  }
}

function canvasCommandFeedbackKey(
  bridgeKey: string | null | undefined,
  turnId: string | null | undefined,
  receivedAt?: number,
  fallback?: string,
): string {
  if (bridgeKey && turnId) return `bridge:${bridgeKey}:turn:${turnId}`;
  if (bridgeKey) return `bridge:${bridgeKey}`;
  if (receivedAt != null) return `received:${receivedAt}`;
  return fallback ?? `local:${turnId ?? "no-turn"}:${Date.now()}`;
}

export const canvasCommandApprovalKeyForTest = canvasCommandApprovalKey;
export const canvasCommandFeedbackKeyForTest = canvasCommandFeedbackKey;

function canvasCommandApprovalApplyKey(approval: PendingCanvasCommandApproval): string {
  if (approval.bridgeKey && approval.turnId) return `bridge:${approval.bridgeKey}:turn:${approval.turnId}`;
  if (approval.bridgeKey) return `bridge:${approval.bridgeKey}`;
  try {
    return `local:${approval.turnId ?? "no-turn"}:${JSON.stringify(approval.envelopes)}`;
  } catch {
    return approval.key;
  }
}

function canvasCommandApprovalCanRepeat(approval: PendingCanvasCommandApproval): boolean {
  return approval.envelopes.some((envelope) =>
    envelope.commands.some((command) =>
      command.type === "create_node" ||
      command.type === "add_next_node" ||
      (command.type === "run_node_action" && command.action === "open_video_compose_modal"),
    ),
  );
}

function pendingCanvasCommandApprovalMatches(
  item: PendingCanvasCommandApproval,
  approval: PendingCanvasCommandApproval,
): boolean {
  return (
    item.key === approval.key ||
    (
      Boolean(item.bridgeKey) &&
      Boolean(approval.bridgeKey) &&
      item.bridgeKey === approval.bridgeKey &&
      (item.turnId === approval.turnId || canvasCommandApprovalEnvelopesMatch(item.envelopes, approval.envelopes))
    ) ||
    (
      Boolean(item.turnId) &&
      Boolean(approval.turnId) &&
      item.turnId === approval.turnId &&
      canvasCommandApprovalEnvelopesMatch(item.envelopes, approval.envelopes)
    )
  );
}

function mergePendingCanvasCommandApproval(
  current: PendingCanvasCommandApproval[],
  approval: PendingCanvasCommandApproval,
): PendingCanvasCommandApproval[] {
  const index = current.findIndex((item) => pendingCanvasCommandApprovalMatches(item, approval));
  if (index < 0) return [...current, approval];
  const next = [...current];
  const previous = next[index];
  next[index] = {
    ...previous,
    ...approval,
    id: previous.id,
    messageId: approval.messageId || previous.messageId,
    turnId: approval.turnId ?? previous.turnId,
    bridgeKey: approval.bridgeKey ?? previous.bridgeKey,
    anchorTextPrefix: previous.anchorTextPrefix ?? approval.anchorTextPrefix,
    surfaceOrder: previous.surfaceOrder ?? approval.surfaceOrder,
  };
  return next;
}

export const mergePendingCanvasCommandApprovalForTest = mergePendingCanvasCommandApproval;

function removePendingCanvasCommandApproval(
  current: PendingCanvasCommandApproval[],
  approval: PendingCanvasCommandApproval,
): PendingCanvasCommandApproval[] {
  const next = current.filter((item) => {
    if (item.id === approval.id || item.key === approval.key) return false;
    if (approval.bridgeKey && item.bridgeKey === approval.bridgeKey) return false;
    return true;
  });
  return next.length === current.length ? current : next;
}

function removePendingCanvasCommandApprovalsForResult(
  current: PendingCanvasCommandApproval[],
  detail: CanvasCommandResultEventDetail,
): PendingCanvasCommandApproval[] {
  const resultKey = canvasCommandApprovalKey(
    detail.bridgeKey,
    detail.turnId,
    detail.envelopes ?? [],
    detail.receivedAt,
  );
  const serializedEnvelopes = (() => {
    try {
      return detail.envelopes ? JSON.stringify(detail.envelopes) : null;
    } catch {
      return null;
    }
  })();
  const next = current.filter((approval) => {
    if (
      detail.bridgeKey &&
      approval.bridgeKey === detail.bridgeKey &&
      (!detail.turnId || approval.turnId === detail.turnId)
    ) return false;
    if (approval.key === resultKey) return false;
    if (detail.turnId && approval.turnId === detail.turnId && serializedEnvelopes) {
      try {
        if (JSON.stringify(approval.envelopes) === serializedEnvelopes) return false;
      } catch {
        return true;
      }
    }
    return true;
  });
  return next.length === current.length ? current : next;
}

function removeCompletedPendingCanvasCommandApprovals(
  current: PendingCanvasCommandApproval[],
  feedbackByMessageId: Record<string, CanvasCommandFeedback[]>,
  persistedFeedbackByMessageId: Record<string, CanvasCommandFeedback[]>,
): PendingCanvasCommandApproval[] {
  if (current.length === 0) return current;
  const completedKeys = new Set<string>();
  const collect = (records: Record<string, CanvasCommandFeedback[]>) => {
    for (const feedbacks of Object.values(records)) {
      for (const feedback of feedbacks) completedKeys.add(feedback.key);
    }
  };
  collect(feedbackByMessageId);
  collect(persistedFeedbackByMessageId);
  if (completedKeys.size === 0) return current;
  const next = current.filter((approval) => {
    if (completedKeys.has(approval.key)) return false;
    if (approval.bridgeKey && completedKeys.has(`bridge:${approval.bridgeKey}`)) return false;
    return true;
  });
  return next.length === current.length ? current : next;
}

function canvasCommandApprovalHasCompletedFeedback(
  approval: PendingCanvasCommandApproval,
  feedbackByMessageId: Record<string, CanvasCommandFeedback[]>,
  persistedFeedbackByMessageId: Record<string, CanvasCommandFeedback[]>,
): boolean {
  const completedKeys = new Set<string>();
  for (const records of [feedbackByMessageId, persistedFeedbackByMessageId]) {
    for (const feedbacks of Object.values(records)) {
      for (const feedback of feedbacks) completedKeys.add(feedback.key);
    }
  }
  if (completedKeys.has(approval.key)) return true;
  return Boolean(approval.bridgeKey && completedKeys.has(`bridge:${approval.bridgeKey}`));
}

type SuperChatPanelVariant = "default" | "freezone";

interface SuperChatPanelProps {
  variant?: SuperChatPanelVariant;
  freezoneCanvasId?: string | null;
  freezoneAgentId?: string | null;
  connectionEnabled?: boolean;
  onConnectionStateChange?: (state: {
    busy: boolean;
    connected: boolean;
    connecting: boolean;
  }) => void;
  canvasId?: string | null;
  currentCanvasMetadata?: Record<string, unknown> | null;
  currentCanvasSelection?: Array<Partial<CanvasNodeReferencePreview> & { nodeId: string; label?: string }>;
  currentCanvasOntologyContext?: CanvasOntologyContext | null;
  pendingAttachments?: ChatAttachment[];
  onPendingAttachmentsConsumed?: () => void;
  onRequestClose?: () => void;
  freezoneHeaderActions?: ReactNode;
  onFreezoneUserMessage?: (message: string, timestamp: number) => void;
}

export function SuperChatPanel({
  variant = "default",
  freezoneCanvasId = null,
  freezoneAgentId = null,
  connectionEnabled = true,
  onConnectionStateChange,
  canvasId = null,
  currentCanvasSelection = [],
  currentCanvasOntologyContext = null,
  pendingAttachments = [],
  onPendingAttachmentsConsumed,
  onRequestClose,
  freezoneHeaderActions,
  onFreezoneUserMessage,
}: SuperChatPanelProps = {}) {
  const { t } = useTranslation();
  const params = useParams({ strict: false }) as { project?: string };
  const queryClient = useQueryClient();
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
  const [composerInputFocused, setComposerInputFocused] = useState(false);
  const [recording, setRecording] = useState(false);
  const [dragFileState, setDragFileState] = useState<"valid" | "invalid" | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [freezoneSkillCatalog, setFreezoneSkillCatalog] = useState<FreezoneAgentConfigPayload[]>([]);
  const [freezoneSkillCatalogLoaded, setFreezoneSkillCatalogLoaded] = useState(false);
  const [activeFreezoneSkillSuggestionIndex, setActiveFreezoneSkillSuggestionIndex] = useState(0);
  const freezoneSkillSuggestionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const draftInputRef = useRef<HTMLTextAreaElement | null>(null);
  const restoreDraftFocusRef = useRef(false);
  const dragDepthRef = useRef(0);
  const speechRef = useRef<SpeechRecognitionLike | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const suppressAutoScrollUntilRef = useRef(0);
  const historyScrollKeyRef = useRef<string | null>(null);
  const composerShellRef = useRef<HTMLDivElement | null>(null);
  const composerBeamRef = useRef<BorderBeamController | null>(null);
  const canvasCommandModeButtonRef = useRef<HTMLButtonElement | null>(null);
  const skillStudioDraftPersistTimerRef = useRef<number | null>(null);
  const onFreezoneUserMessageRef = useRef(onFreezoneUserMessage);
  const notifiedTaskKeysRef = useRef<Set<string>>(new Set());
  const taskEventBus = useEventBus();
  const canvasNodes = useCanvasStore((state) => state.nodes);
  const canvasEdges = useCanvasStore((state) => state.edges);
  const selectedCanvasNodeId = useCanvasStore((state) => state.selectedNodeId);
  const chat = useSuperChat({
    project: params.project,
    displayName: username || "SuperTale",
    surface: variant === "freezone" ? "freezone" : undefined,
    freezoneCanvasId: variant === "freezone" ? freezoneCanvasId ?? canvasId : null,
    freezoneAgentId: variant === "freezone" ? freezoneAgentId : null,
    connectionEnabled,
  });
  const updateChatUiEvent = chat.updateUiEvent;
  const [pendingCanvasCommandApprovals, setPendingCanvasCommandApprovals] = useState<PendingCanvasCommandApproval[]>([]);
  const [canvasCommandFeedbackByMessageId, setCanvasCommandFeedbackByMessageId] = useState<Record<string, CanvasCommandFeedback[]>>({});
  const [canvasContextActivitiesByMessageId, setCanvasContextActivitiesByMessageId] = useState<Record<string, CanvasContextActivity[]>>({});
  const [executingCanvasCommandApprovalIds, setExecutingCanvasCommandApprovalIds] = useState<Set<string>>(() => new Set());
  const executingCanvasCommandApprovalIdsRef = useRef<Set<string>>(new Set());
  const appliedCanvasCommandApprovalKeysRef = useRef<Set<string>>(new Set());
  const resolvedCanvasCommandApprovalKeysRef = useRef<Set<string>>(new Set());
  const [canvasCommandExecutionMode, setCanvasCommandExecutionMode] = useState<CanvasCommandExecutionMode>(() => loadCanvasCommandExecutionMode());
  const [canvasCommandModeMenuOpen, setCanvasCommandModeMenuOpen] = useState(false);
  const [canvasCommandModeMenuPosition, setCanvasCommandModeMenuPosition] = useState<{
    left: number;
    bottom: number;
  } | null>(null);
  const isChatInitializing = !chat.historyReady && chat.messages.length === 0 && (chat.connecting || chat.connected);

  useEffect(() => {
    onFreezoneUserMessageRef.current = onFreezoneUserMessage;
  }, [onFreezoneUserMessage]);

  useEffect(() => {
    onConnectionStateChange?.({
      busy: chat.busy,
      connected: chat.connected,
      connecting: chat.connecting,
    });
  }, [chat.busy, chat.connected, chat.connecting, onConnectionStateChange]);

  const isFreezoneLayout = variant === "freezone";
  const freezoneSkillSuggestions = useMemo(
    () => toFreezoneSkillSuggestions(freezoneSkillCatalog),
    [freezoneSkillCatalog],
  );
  const freezoneSkillSlashQuery = isFreezoneLayout ? getFreezoneSkillSlashQuery(draft) : null;
  const visibleFreezoneSkillSuggestions = useMemo(
    () => freezoneSkillSlashQuery === null
      ? []
      : filterFreezoneSkillSuggestions(freezoneSkillSuggestions, freezoneSkillSlashQuery).slice(0, 8),
    [freezoneSkillSlashQuery, freezoneSkillSuggestions],
  );
  const showFreezoneSkillSuggestions =
    isFreezoneLayout
    && freezoneSkillSlashQuery !== null
    && visibleFreezoneSkillSuggestions.length > 0;
  const insertFreezoneSkillSuggestion = useCallback((skillId: string) => {
    setDraft((current) => insertFreezoneSkillMention(current, skillId));
    setActiveFreezoneSkillSuggestionIndex(0);
    restoreDraftFocusRef.current = true;
  }, []);

  useEffect(() => {
    if (!isFreezoneLayout || freezoneSkillSlashQuery === null || freezoneSkillCatalogLoaded) return;
    let cancelled = false;
    void apiCall<FreezoneAgentConfigPayload[]>("freezone/agent-config/skills")
      .then((items) => {
        if (cancelled) return;
        setFreezoneSkillCatalog(items);
      })
      .catch(() => {
        if (cancelled) return;
        setFreezoneSkillCatalog([]);
      })
      .finally(() => {
        if (cancelled) return;
        setFreezoneSkillCatalogLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [freezoneSkillCatalogLoaded, freezoneSkillSlashQuery, isFreezoneLayout]);

  useEffect(() => {
    setActiveFreezoneSkillSuggestionIndex(0);
  }, [freezoneSkillSlashQuery]);

  useEffect(() => {
    setActiveFreezoneSkillSuggestionIndex((index) =>
      visibleFreezoneSkillSuggestions.length > 0
        ? Math.min(index, visibleFreezoneSkillSuggestions.length - 1)
        : 0,
    );
    freezoneSkillSuggestionRefs.current.length = visibleFreezoneSkillSuggestions.length;
  }, [visibleFreezoneSkillSuggestions.length]);

  useEffect(() => {
    if (!showFreezoneSkillSuggestions) return;
    const activeElement = freezoneSkillSuggestionRefs.current[activeFreezoneSkillSuggestionIndex];
    activeElement?.scrollIntoView({ block: "nearest" });
  }, [activeFreezoneSkillSuggestionIndex, showFreezoneSkillSuggestions]);
  const selectedFreezoneNodes = useMemo(
    () => (isFreezoneLayout ? getSelectedFreezoneNodes(canvasNodes, selectedCanvasNodeId) : []),
    [canvasNodes, isFreezoneLayout, selectedCanvasNodeId],
  );
  const selectedFreezoneNodeAttachment = useMemo(() => {
    if (!isFreezoneLayout || selectedFreezoneNodes.length === 0) return null;
    const project = params.project?.trim();
    const currentCanvasId = freezoneCanvasId ?? canvasId;
    if (!project || !currentCanvasId) return null;
    return buildCanvasNodeReferenceAttachment(
      project,
      currentCanvasId,
      selectedFreezoneNodes,
      canvasEdges,
      canvasNodes,
      { displayNodes: selectedFreezoneNodes },
    );
  }, [
    canvasEdges,
    canvasId,
    canvasNodes,
    freezoneCanvasId,
    isFreezoneLayout,
    params.project,
    selectedFreezoneNodes,
  ]);
  const existingCanvasNodeIds = useMemo(
    () => new Set(canvasNodes.map((node) => node.id)),
    [canvasNodes],
  );
  const hasSelectedFreezoneNodeContext = Boolean(selectedFreezoneNodeAttachment);
  const visibleComposerAttachments = useMemo(
    () => attachments.filter((attachment) => !isCanvasNodeReferenceAttachment(attachment)),
    [attachments],
  );
  const hasSendableContent =
    draft.trim().length > 0 || attachments.length > 0 || hasSelectedFreezoneNodeContext;
  const canSend = hasSendableContent && chat.connected && !preparingSend;
  const composerWaiting = chat.busy && (!hasSendableContent || !chat.connected || preparingSend);
  const selectedFreezoneNodePreviews = useMemo(
    () => selectedFreezoneNodes.map((node) => canvasNodeToReferencePreview(node)),
    [selectedFreezoneNodes],
  );
  const deselectFreezoneNodeReferences = useCallback((nodeIds: ReadonlySet<string>) => {
    if (!isFreezoneLayout) return;
    if (nodeIds.size === 0) return;
    const store = useCanvasStore.getState();
    store.onNodesChange([...nodeIds].map((nodeId) => ({ id: nodeId, type: "select", selected: false })));
    const remainingSelected = useCanvasStore
      .getState()
      .nodes
      .filter((node) => Boolean(node.selected) && !nodeIds.has(node.id));
    store.setSelectedNode(remainingSelected.length === 1 ? remainingSelected[0]?.id ?? null : null);
  }, [isFreezoneLayout]);
  const deselectFreezoneNodeReference = useCallback((nodeId: string) => {
    deselectFreezoneNodeReferences(new Set([nodeId]));
  }, [deselectFreezoneNodeReferences]);
  const deselectAllSelectedFreezoneNodeReferences = useCallback(() => {
    deselectFreezoneNodeReferences(new Set(selectedFreezoneNodes.map((node) => node.id)));
  }, [deselectFreezoneNodeReferences, selectedFreezoneNodes]);
  const removeAttachment = useCallback((attachment: ChatAttachment) => {
    const removedCanvasNodeIds = new Set(canvasNodeReferenceAttachmentNodeIds(attachment));
    setAttachments((current) => current.filter((item) => item.id !== attachment.id));
    deselectFreezoneNodeReferences(removedCanvasNodeIds);
  }, [deselectFreezoneNodeReferences]);
  const composerBeamActive =
    composerInputFocused
    && chat.connected
    && !chat.busy
    && !preparingSend
    && queuedMessages.length === 0;
  const activeMessages = useMemo(
    () =>
      chat.messages.filter(
        (message) => !chat.deletedIds.has(message.id) && (chat.settings.showToolEvents || !isToolMessage(message)),
      ),
    [chat.deletedIds, chat.messages, chat.settings.showToolEvents],
  );
  const persistedCanvasCommandFeedbackByMessageId = useMemo(() => {
    const byMessageId: Record<string, CanvasCommandFeedback[]> = {};
    if (variant !== "freezone") return byMessageId;
    for (const message of chat.messages) {
      const feedbacks = canvasCommandFeedbacksFromUiEvents(messageUiEvents(message));
      if (feedbacks.length === 0) continue;
      mergeCanvasCommandFeedbackRecord(byMessageId, message.id, feedbacks);
      mergeCanvasCommandFeedbackRecord(byMessageId, message.turnId, feedbacks);
    }
    return byMessageId;
  }, [chat.messages, variant]);
  const latestAssistantMessageId = useMemo(
    () => [...activeMessages].reverse().find((message) => message.role === "assistant")?.id ?? null,
    [activeMessages],
  );
  const effectiveFreezoneCanvasId = variant === "freezone" ? freezoneCanvasId ?? canvasId ?? null : null;
  const effectiveFreezoneAgentId = variant === "freezone" ? freezoneAgentId?.trim() || "main" : null;
  const chatScopeKey = `${params.project ?? ""}:${variant}:${effectiveFreezoneCanvasId ?? ""}:${effectiveFreezoneAgentId ?? ""}`;
  const freezoneAgentMatches = useCallback((agentId?: string | null) => {
    if (variant !== "freezone") return true;
    return (agentId || "main") === (effectiveFreezoneAgentId || "main");
  }, [effectiveFreezoneAgentId, variant]);
  const firstUserMessage = useMemo(
    () => activeMessages.find((message) => message.role === "user" && message.text.trim().length > 0) ?? null,
    [activeMessages],
  );
  const latestUserMessageForFreezoneTitle = useMemo(
    () => [...activeMessages].reverse().find((message) => message.role === "user") ?? null,
    [activeMessages],
  );

  useEffect(() => {
    if (variant !== "freezone" || !firstUserMessage || !latestUserMessageForFreezoneTitle) return;
    onFreezoneUserMessageRef.current?.(firstUserMessage.text.trim(), latestUserMessageForFreezoneTitle.timestamp);
  }, [firstUserMessage, latestUserMessageForFreezoneTitle, variant]);

  useEffect(() => {
    saveCanvasCommandExecutionMode(canvasCommandExecutionMode);
  }, [canvasCommandExecutionMode]);

  useEffect(() => {
    if (variant !== "freezone") return;
    setPendingCanvasCommandApprovals((current) =>
      removeCompletedPendingCanvasCommandApprovals(
        current,
        canvasCommandFeedbackByMessageId,
        persistedCanvasCommandFeedbackByMessageId,
      ),
    );
  }, [canvasCommandFeedbackByMessageId, persistedCanvasCommandFeedbackByMessageId, variant]);

  const setCanvasExecutionMode = useCallback((mode: CanvasCommandExecutionMode) => {
    setCanvasCommandExecutionMode(mode);
    saveCanvasCommandExecutionMode(mode);
    setCanvasCommandModeMenuOpen(false);
  }, []);

  useLayoutEffect(() => {
    if (!canvasCommandModeMenuOpen) {
      setCanvasCommandModeMenuPosition(null);
      return;
    }
    const updatePosition = () => {
      const button = canvasCommandModeButtonRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const menuWidth = 288;
      setCanvasCommandModeMenuPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8)),
        bottom: Math.max(8, window.innerHeight - rect.top + 8),
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [canvasCommandModeMenuOpen]);

  useEffect(() => {
    if (!canvasCommandModeMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (canvasCommandModeButtonRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-canvas-command-mode-menu='true']")) return;
      setCanvasCommandModeMenuOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [canvasCommandModeMenuOpen]);

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
    if (variant === "freezone") return;
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
  }, [chat.appendNotification, params.project, t, taskEventBus, variant]);

  const appendCanvasCommandFeedback = useCallback((
    messageId: string,
    feedbackKey: string,
    result: Pick<CanvasChatCommandApplyResult, "applied" | "openedUiActions" | "errors" | "commandResults">,
    plans: CanvasCommandPlan[] = [],
    anchorTextPrefix?: string | null,
    surfaceOrder?: number,
  ) => {
    setCanvasCommandFeedbackByMessageId((current) => ({
      ...current,
      [messageId]: appendCanvasCommandFeedbackCard(
        current[messageId],
        feedbackKey,
        result,
        plans,
        anchorTextPrefix,
        surfaceOrder,
      ),
    }));
  }, []);

  const buildApprovalFromDetail = useCallback((detail: CanvasCommandApprovalEventDetail): PendingCanvasCommandApproval | null => {
    if (variant === "freezone" && detail.canvasId && effectiveFreezoneCanvasId && detail.canvasId !== effectiveFreezoneCanvasId) {
      return null;
    }
    if (!freezoneAgentMatches(detail.agentId)) return null;
    const turnId = detail.turnId ?? null;
    const bridgeKey = detail.bridgeKey ?? null;
    const messageId = resolveCanvasCommandApprovalMessageId({
      anchorMessageId: detail.anchorMessageId,
      messages: activeMessages,
      turnId,
      latestAssistantMessageId,
      receivedAt: detail.receivedAt,
    });
    const key = canvasCommandApprovalKey(bridgeKey, turnId, detail.envelopes, detail.receivedAt);
    const commandCount = detail.envelopes.reduce((sum, envelope) => sum + envelope.commands.length, 0);
    const receivedAt = detail.receivedAt ?? Date.now();
    const receivedAtLooksLikeEpochMs = receivedAt > 1_000_000_000_000;
    const expiresAt = detail.autoExpires
      ? (receivedAtLooksLikeEpochMs ? receivedAt + 30_000 : Date.now() + 30_000)
      : undefined;
    return {
      id: key,
      key,
      messageId,
      turnId,
      bridgeKey,
      agentId: detail.agentId ?? null,
      anchorTextPrefix: detail.anchorTextPrefix,
      surfaceOrder: detail.receivedAt,
      receivedAt,
      autoExpires: detail.autoExpires,
      expiresAt,
      envelopes: detail.envelopes,
      commandCount,
      plans: canvasCommandPlansFromEnvelopes(detail.envelopes),
    };
  }, [activeMessages, effectiveFreezoneCanvasId, freezoneAgentMatches, latestAssistantMessageId, variant]);

  const handleCanvasCommandApproval = useCallback((detail: CanvasCommandApprovalEventDetail) => {
    const approval = buildApprovalFromDetail(detail);
    if (!approval) return false;
    const resolvedKeys = resolvedCanvasCommandApprovalKeysRef.current;
    if (resolvedKeys.has(approval.key) || resolvedKeys.has(canvasCommandApprovalApplyKey(approval))) return true;
    setPendingCanvasCommandApprovals((current) => mergePendingCanvasCommandApproval(current, approval));
    chat.upsertAssistantMessagePart(
      { messageId: approval.messageId, turnId: approval.turnId },
      {
        id: canvasApprovalPartId(approval),
        type: "canvas_approval",
        event: approval,
      },
    );
    return true;
  }, [buildApprovalFromDetail, chat]);

  useEffect(
    () => subscribeCanvasCommandApprovals((detail) => handleCanvasCommandApproval({ ...detail, autoExpires: true })),
    [handleCanvasCommandApproval],
  );

  useEffect(() => {
    const handleEvent = (event: Event) => {
      handleCanvasCommandApproval({
        ...(event as CustomEvent<CanvasCommandApprovalEventDetail>).detail,
        autoExpires: true,
      });
    };
    window.addEventListener(FREEZONE_CANVAS_COMMAND_APPROVAL_EVENT, handleEvent);
    return () => window.removeEventListener(FREEZONE_CANVAS_COMMAND_APPROVAL_EVENT, handleEvent);
  }, [handleCanvasCommandApproval]);

  useEffect(() => {
    if (variant !== "freezone") return;
    setPendingCanvasCommandApprovals((current) => {
      let next = current;
      for (const message of chat.messages) {
        for (const detail of canvasCommandApprovalDetailsFromUiEvents(messageUiEvents(message))) {
          const approval = buildApprovalFromDetail({
            ...detail,
            turnId: detail.turnId ?? message.turnId ?? null,
          });
          if (!approval) continue;
          const resolvedKeys = resolvedCanvasCommandApprovalKeysRef.current;
          if (resolvedKeys.has(approval.key) || resolvedKeys.has(canvasCommandApprovalApplyKey(approval))) continue;
          if (canvasCommandApprovalHasCompletedFeedback(
            approval,
            canvasCommandFeedbackByMessageId,
            persistedCanvasCommandFeedbackByMessageId,
          )) continue;
          if (next.some((item) => pendingCanvasCommandApprovalMatches(item, approval))) continue;
          next = mergePendingCanvasCommandApproval(next, approval);
        }
      }
      return next;
    });
  }, [
    buildApprovalFromDetail,
    canvasCommandFeedbackByMessageId,
    chat.messages,
    persistedCanvasCommandFeedbackByMessageId,
    variant,
  ]);

  const handleCanvasCommandResult = useCallback((detail: CanvasCommandResultEventDetail) => {
    if (variant === "freezone" && detail.canvasId && effectiveFreezoneCanvasId && detail.canvasId !== effectiveFreezoneCanvasId) {
      return;
    }
    if (!freezoneAgentMatches(detail.agentId)) return;
    const turnId = detail.turnId ?? null;
    const messageId = resolveCanvasCommandFeedbackMessageId({
      anchorMessageId: detail.anchorMessageId,
      messages: activeMessages,
      turnId,
      latestAssistantMessageId,
      receivedAt: detail.receivedAt,
    });
    const feedbackKey = canvasCommandFeedbackKey(detail.bridgeKey, turnId, detail.receivedAt);
    const envelopes = detail.envelopes ?? [];
    const plans = canvasCommandPlansFromEnvelopes(envelopes);
    appendCanvasCommandFeedback(
      messageId,
      feedbackKey,
      detail.result,
      plans,
      detail.anchorTextPrefix,
      detail.receivedAt,
    );
    const feedback: CanvasCommandFeedback = {
      ...detail.result,
      commandResults: detail.result.commandResults,
      key: feedbackKey,
      plans,
      anchorTextPrefix: detail.anchorTextPrefix ?? undefined,
      surfaceOrder: detail.receivedAt,
    };
    for (const approval of pendingCanvasCommandApprovals) {
      if (!pendingCanvasCommandApprovalMatches(approval, {
        id: canvasCommandApprovalKey(detail.bridgeKey, turnId, envelopes, detail.receivedAt),
        key: canvasCommandApprovalKey(detail.bridgeKey, turnId, envelopes, detail.receivedAt),
        messageId,
        turnId,
        bridgeKey: detail.bridgeKey ?? null,
        agentId: detail.agentId ?? null,
        receivedAt: detail.receivedAt ?? Date.now(),
        envelopes,
        commandCount: envelopes.reduce((sum, envelope) => sum + envelope.commands.length, 0),
        plans,
      })) continue;
      chat.removeAssistantMessagePart(
        { messageId: approval.messageId, turnId: approval.turnId },
        canvasApprovalPartId(approval),
      );
    }
    chat.upsertAssistantMessagePart(
      { messageId, turnId },
      {
        id: canvasFeedbackPartId(feedback),
        type: "canvas_feedback",
        event: feedback,
      },
    );
    setPendingCanvasCommandApprovals((current) => removePendingCanvasCommandApprovalsForResult(current, detail));
  }, [activeMessages, appendCanvasCommandFeedback, chat, effectiveFreezoneCanvasId, freezoneAgentMatches, latestAssistantMessageId, pendingCanvasCommandApprovals, variant]);

  useEffect(() => {
    const handleEvent = (event: Event) => {
      handleCanvasCommandResult((event as CustomEvent<CanvasCommandResultEventDetail>).detail);
    };
    window.addEventListener(FREEZONE_CANVAS_COMMAND_RESULT_EVENT, handleEvent);
    return () => window.removeEventListener(FREEZONE_CANVAS_COMMAND_RESULT_EVENT, handleEvent);
  }, [handleCanvasCommandResult]);

  useEffect(() => {
    if (variant !== "freezone" || !effectiveFreezoneCanvasId) return;
    const canvasIdForRequest = effectiveFreezoneCanvasId;

    const handleCanvasContextRequest = (event: Event) => {
      const detail = (event as CustomEvent<{
        bridge_key?: string | null;
        canvas_id?: string | null;
        agent_id?: string | null;
        agentId?: string | null;
        turn_id?: string | null;
        envelope?: unknown;
        anchorMessageId?: string | null;
        anchorTextPrefix?: string | null;
      }>).detail;
      if (!detail?.bridge_key) return;
      const requestAgentId = typeof detail.agent_id === "string" ? detail.agent_id : detail.agentId;
      if (!freezoneAgentMatches(requestAgentId)) return;
      const bridgeKey = detail.bridge_key;
      const requestCanvasId = typeof detail.canvas_id === "string" && detail.canvas_id.trim()
        ? detail.canvas_id
        : canvasIdForRequest;
      if (requestCanvasId !== canvasIdForRequest) return;
      const turnId = typeof detail.turn_id === "string" && detail.turn_id.trim()
        ? detail.turn_id
        : chat.activeTurnId;
      const labels = canvasContextLabelsFromTypes(collectCanvasContextRequestTypes(detail.envelope));
      const assistantAnchorText = turnId
        ? activeMessages.find((message) => message.turnId === turnId && message.role === "assistant" && message.text.trim())?.text
        : null;
      const anchorTextPrefix =
        typeof detail.anchorTextPrefix === "string"
          ? detail.anchorTextPrefix
          : assistantAnchorText
            ? assistantAnchorText
            : turnId && turnId === chat.activeTurnId && chat.streamText
              ? chat.streamText
              : null;
      const surfaceOrder = Date.now();
      if (turnId) {
        const activity: CanvasContextActivity = {
          key: `context:${bridgeKey}`,
          turnId,
          bridgeKey,
          status: "running",
          labels,
          errors: [],
          anchorTextPrefix,
          surfaceOrder,
        };
        setCanvasContextActivitiesByMessageId((current) => ({
          ...current,
          [turnId]: mergeCanvasContextActivity(current[turnId], activity),
        }));
        chat.upsertAssistantMessagePart(
          { turnId },
          {
            id: canvasContextPartId(activity),
            type: "canvas_context",
            event: activity,
          },
        );
      }
    };

    window.addEventListener(SUPERCHAT_CANVAS_CONTEXT_REQUEST_EVENT, handleCanvasContextRequest);
    return () => {
      window.removeEventListener(SUPERCHAT_CANVAS_CONTEXT_REQUEST_EVENT, handleCanvasContextRequest);
    };
  }, [
    activeMessages,
    chat.activeTurnId,
    chat.streamText,
    chat,
    effectiveFreezoneCanvasId,
    freezoneAgentMatches,
    variant,
  ]);

  useEffect(() => {
    const handleCanvasContextActivity = (event: Event) => {
      const detail = (event as CustomEvent<CanvasContextActivityPayload>).detail;
      if (variant === "freezone" && detail.canvas_id && effectiveFreezoneCanvasId && detail.canvas_id !== effectiveFreezoneCanvasId) return;
      if (!freezoneAgentMatches(detail.agent_id)) return;
      const messageId = detail.turn_id
        ? activeMessages.find((message) => message.turnId === detail.turn_id && message.role === "assistant")?.id ?? `assistant-${detail.turn_id}`
        : latestAssistantMessageId ?? `canvas-context:${detail.received_at ?? Date.now()}`;
      const activity: CanvasContextActivity = {
        key: `context:${detail.bridge_key}`,
        turnId: detail.turn_id ?? null,
        bridgeKey: detail.bridge_key,
        status: detail.status,
        labels: detail.labels,
        errors: detail.errors,
        anchorTextPrefix: detail.anchor_text_prefix,
        surfaceOrder: detail.surface_order ?? detail.received_at,
      };
      setCanvasContextActivitiesByMessageId((current) => ({
        ...current,
        [messageId]: mergeCanvasContextActivity(current[messageId], activity),
      }));
      chat.upsertAssistantMessagePart(
        { messageId, turnId: activity.turnId },
        {
          id: canvasContextPartId(activity),
          type: "canvas_context",
          event: activity,
        },
      );
    };
    const handleCanvasContextResult = (event: Event) => {
      const detail = (event as CustomEvent<CanvasContextToolResultPayload>).detail;
      if (!detail?.bridge_key) return;
      if (variant === "freezone" && detail.canvas_id && effectiveFreezoneCanvasId && detail.canvas_id !== effectiveFreezoneCanvasId) return;
      if (!freezoneAgentMatches(detail.agent_id)) return;
      const labels = canvasContextLabelsFromResponses(detail.responses);
      const fallbackTurnId =
        typeof detail.turn_id === "string" && detail.turn_id.trim()
          ? detail.turn_id
          : null;
      const fallbackMessageId = fallbackTurnId
        ? activeMessages.find((message) => message.turnId === fallbackTurnId && message.role === "assistant")?.id ?? fallbackTurnId
        : latestAssistantMessageId ?? `canvas-context:${detail.received_at ?? Date.now()}`;
      const activity: CanvasContextActivity = {
        key: `context:${detail.bridge_key}`,
        turnId: fallbackTurnId,
        bridgeKey: detail.bridge_key,
        status: detail.ok ? "done" : "failed",
        labels,
        errors: detail.errors ?? [],
        anchorTextPrefix: detail.anchor_text_prefix ?? null,
        surfaceOrder: detail.received_at ?? Date.now(),
      };
      setCanvasContextActivitiesByMessageId((current) => {
        const next = { ...current };
        let updated = false;
        let partTargetMessageId = fallbackMessageId;
        for (const [messageId, activities] of Object.entries(current)) {
          if (!activities.some((item) => item.bridgeKey === detail.bridge_key)) continue;
          next[messageId] = mergeCanvasContextActivity(activities, activity);
          partTargetMessageId = messageId;
          updated = true;
        }
        if (!updated) {
          next[fallbackMessageId] = mergeCanvasContextActivity(current[fallbackMessageId], activity);
        }
        chat.upsertAssistantMessagePart(
          { messageId: partTargetMessageId, turnId: activity.turnId },
          {
            id: canvasContextPartId(activity),
            type: "canvas_context",
            event: activity,
          },
        );
        return next;
      });
    };
    window.addEventListener(FREEZONE_CANVAS_CONTEXT_ACTIVITY_EVENT, handleCanvasContextActivity);
    window.addEventListener(FREEZONE_CANVAS_CONTEXT_TOOL_RESULT_EVENT, handleCanvasContextResult);
    return () => {
      window.removeEventListener(FREEZONE_CANVAS_CONTEXT_ACTIVITY_EVENT, handleCanvasContextActivity);
      window.removeEventListener(FREEZONE_CANVAS_CONTEXT_TOOL_RESULT_EVENT, handleCanvasContextResult);
    };
  }, [activeMessages, chat, effectiveFreezoneCanvasId, freezoneAgentMatches, latestAssistantMessageId, variant]);

  const persistCanvasCommandUiEvent = useCallback((
    turnId: string | null | undefined,
    event: Record<string, unknown>,
  ) => {
    if (!params.project || !effectiveFreezoneCanvasId || !turnId) return;
    void api.post("api/v1/chat/ui-events", {
      json: {
        scope: {
          kind: "project",
          id: params.project,
          surface: "freezone",
          canvasId: effectiveFreezoneCanvasId,
        },
        turn_id: turnId,
        event,
      },
    }).catch((error) => {
      console.warn("[freezone-canvas-command] failed to persist superchat canvas event", {
        canvasId: effectiveFreezoneCanvasId,
        turnId,
        error,
      });
    });
  }, [effectiveFreezoneCanvasId, params.project]);

  const persistSkillStudioUiEvent = useCallback((
    turnId: string | null | undefined,
    event: Record<string, unknown>,
    options: { debounce?: boolean } = {},
  ) => {
    if (!params.project || !effectiveFreezoneCanvasId || !turnId) return;
    const postEvent = () => {
      void api.post("api/v1/chat/ui-events", {
        json: {
          scope: {
            kind: "project",
            id: params.project,
            surface: "freezone",
            canvasId: effectiveFreezoneCanvasId,
            agentId: typeof event.agent_id === "string" ? event.agent_id : effectiveFreezoneAgentId,
          },
          turn_id: turnId,
          event,
        },
      }).catch((error) => {
        console.warn("[skill-studio] failed to persist superchat ui event", {
          canvasId: effectiveFreezoneCanvasId,
          turnId,
          error,
        });
      });
    };
    if (!options.debounce) {
      postEvent();
      return;
    }
    if (skillStudioDraftPersistTimerRef.current !== null) {
      window.clearTimeout(skillStudioDraftPersistTimerRef.current);
    }
    skillStudioDraftPersistTimerRef.current = window.setTimeout(() => {
      skillStudioDraftPersistTimerRef.current = null;
      postEvent();
    }, 450);
  }, [effectiveFreezoneAgentId, effectiveFreezoneCanvasId, params.project]);

  useEffect(() => () => {
    if (skillStudioDraftPersistTimerRef.current !== null) {
      window.clearTimeout(skillStudioDraftPersistTimerRef.current);
      skillStudioDraftPersistTimerRef.current = null;
    }
  }, []);

  const handleApplyCanvasCommandApproval = useCallback((approval: PendingCanvasCommandApproval) => {
    if (executingCanvasCommandApprovalIdsRef.current.has(approval.id)) return;
    resolvedCanvasCommandApprovalKeysRef.current.add(approval.key);
    resolvedCanvasCommandApprovalKeysRef.current.add(canvasCommandApprovalApplyKey(approval));
    if (resolvedCanvasCommandApprovalKeysRef.current.size > 200) {
      resolvedCanvasCommandApprovalKeysRef.current = new Set(
        [...resolvedCanvasCommandApprovalKeysRef.current].slice(-100),
      );
    }
    executingCanvasCommandApprovalIdsRef.current.add(approval.id);
    setExecutingCanvasCommandApprovalIds(new Set(executingCanvasCommandApprovalIdsRef.current));
    void (async () => {
      const receivedAt = Date.now();
      try {
        const applyKey = canvasCommandApprovalApplyKey(approval);
        const canRepeatApproval = canvasCommandApprovalCanRepeat(approval);
        if (!canRepeatApproval && appliedCanvasCommandApprovalKeysRef.current.has(applyKey)) {
          setPendingCanvasCommandApprovals((current) => removePendingCanvasCommandApproval(current, approval));
          return;
        }
        if (!canRepeatApproval) {
          appliedCanvasCommandApprovalKeysRef.current.add(applyKey);
          if (appliedCanvasCommandApprovalKeysRef.current.size > 100) {
            appliedCanvasCommandApprovalKeysRef.current = new Set(
              [...appliedCanvasCommandApprovalKeysRef.current].slice(-50),
            );
          }
        }

        let result: CanvasChatCommandApplyResult;
        try {
          result = await applyCanvasChatCommandsAsync(approval.envelopes, {
            projectId: params.project,
            canvasId: effectiveFreezoneCanvasId,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const errorMessage = `画布命令执行异常：${message}`;
          result = {
            applied: 0,
            openedUiActions: 0,
            createdNodeIds: [],
            errors: [errorMessage],
            commandResults: [
              {
                commandIndex: -1,
                type: "validate",
                status: "error",
                label: "画布执行异常",
                error: errorMessage,
              },
            ],
          };
        }

        reportCanvasCommandToolResult({
          bridgeKey: approval.bridgeKey,
          turnId: approval.turnId,
          anchorTextPrefix: approval.anchorTextPrefix,
          projectId: params.project,
          canvasId: effectiveFreezoneCanvasId,
          agentId: approval.agentId ?? effectiveFreezoneAgentId,
          result,
        });
        const feedbackKey = canvasCommandFeedbackKey(approval.bridgeKey, approval.turnId, undefined, approval.key);
        appendCanvasCommandFeedback(
          approval.messageId,
          feedbackKey,
          result,
          approval.plans,
          approval.anchorTextPrefix,
          receivedAt,
        );
        if (approval.turnId) {
          appendCanvasCommandFeedback(
            approval.turnId,
            feedbackKey,
            result,
            approval.plans,
            approval.anchorTextPrefix,
            receivedAt,
          );
        }
        const feedback: CanvasCommandFeedback = {
          ...result,
          commandResults: result.commandResults,
          key: feedbackKey,
          plans: approval.plans,
          anchorTextPrefix: approval.anchorTextPrefix ?? undefined,
          surfaceOrder: receivedAt,
        };
        chat.removeAssistantMessagePart(
          { messageId: approval.messageId, turnId: approval.turnId },
          canvasApprovalPartId(approval),
        );
        chat.upsertAssistantMessagePart(
          { messageId: approval.messageId, turnId: approval.turnId },
          {
            id: canvasFeedbackPartId(feedback),
            type: "canvas_feedback",
            event: feedback,
          },
        );
        persistCanvasCommandUiEvent(approval.turnId, {
          schema_version: "canvas_command_result.v1",
          type: "canvas_command_result",
          canvas_id: effectiveFreezoneCanvasId,
          bridge_key: approval.bridgeKey ?? null,
          envelopes: approval.envelopes,
          result,
          anchor_text_prefix: approval.anchorTextPrefix ?? null,
          received_at: receivedAt,
        });
        setPendingCanvasCommandApprovals((current) => removePendingCanvasCommandApproval(current, approval));
      } finally {
        executingCanvasCommandApprovalIdsRef.current.delete(approval.id);
        setExecutingCanvasCommandApprovalIds(new Set(executingCanvasCommandApprovalIdsRef.current));
      }
    })();
  }, [appendCanvasCommandFeedback, chat, effectiveFreezoneAgentId, effectiveFreezoneCanvasId, params.project, persistCanvasCommandUiEvent]);

  const handleCancelCanvasCommandApproval = useCallback((approval: PendingCanvasCommandApproval, reason: CanvasCommandApprovalCancelReason = "user") => {
    if (executingCanvasCommandApprovalIdsRef.current.has(approval.id)) return;
    resolvedCanvasCommandApprovalKeysRef.current.add(approval.key);
    resolvedCanvasCommandApprovalKeysRef.current.add(canvasCommandApprovalApplyKey(approval));
    if (resolvedCanvasCommandApprovalKeysRef.current.size > 200) {
      resolvedCanvasCommandApprovalKeysRef.current = new Set(
        [...resolvedCanvasCommandApprovalKeysRef.current].slice(-100),
      );
    }
    const receivedAt = Date.now();
    const cancelMessage = reason === "timeout" ? "画布操作等待超时，已自动取消" : t("freezone.chat.canvasCommandsCancelled");
    const result: CanvasChatCommandApplyResult = {
      applied: 0,
      openedUiActions: 0,
      createdNodeIds: [],
      errors: [cancelMessage],
      commandResults: [
        {
          commandIndex: -1,
          type: "validate",
          status: "error",
          label: "已取消",
          error: cancelMessage,
        },
      ],
    };
    reportCanvasCommandToolResult({
      bridgeKey: approval.bridgeKey,
      turnId: approval.turnId,
      anchorTextPrefix: approval.anchorTextPrefix,
      projectId: params.project,
      canvasId: effectiveFreezoneCanvasId,
      agentId: approval.agentId ?? effectiveFreezoneAgentId,
      result,
      cancelled: true,
    });
    const feedbackKey = canvasCommandFeedbackKey(approval.bridgeKey, approval.turnId, undefined, approval.key);
    persistCanvasCommandUiEvent(approval.turnId, {
      schema_version: "canvas_command_result.v1",
      type: "canvas_command_result",
      canvas_id: effectiveFreezoneCanvasId,
      bridge_key: approval.bridgeKey ?? null,
      envelopes: approval.envelopes,
      result,
      anchor_text_prefix: approval.anchorTextPrefix ?? null,
      received_at: receivedAt,
      cancelled: true,
      cancel_reason: reason,
    });
    appendCanvasCommandFeedback(
      approval.messageId,
      feedbackKey,
      result,
      approval.plans,
      approval.anchorTextPrefix,
      receivedAt,
    );
    if (approval.turnId) {
      appendCanvasCommandFeedback(
        approval.turnId,
        feedbackKey,
        result,
        approval.plans,
        approval.anchorTextPrefix,
        receivedAt,
      );
    }
    const feedback: CanvasCommandFeedback = {
      ...result,
      commandResults: result.commandResults,
      key: feedbackKey,
      plans: approval.plans,
      anchorTextPrefix: approval.anchorTextPrefix ?? undefined,
      surfaceOrder: receivedAt,
    };
    chat.removeAssistantMessagePart(
      { messageId: approval.messageId, turnId: approval.turnId },
      canvasApprovalPartId(approval),
    );
    chat.upsertAssistantMessagePart(
      { messageId: approval.messageId, turnId: approval.turnId },
      {
        id: canvasFeedbackPartId(feedback),
        type: "canvas_feedback",
        event: feedback,
      },
    );
    setPendingCanvasCommandApprovals((current) => removePendingCanvasCommandApproval(current, approval));
  }, [appendCanvasCommandFeedback, chat, effectiveFreezoneAgentId, effectiveFreezoneCanvasId, params.project, persistCanvasCommandUiEvent, t]);

  useEffect(() => {
    if (canvasCommandExecutionMode !== "auto_execute") return;
    for (const approval of pendingCanvasCommandApprovals) {
      if (!executingCanvasCommandApprovalIds.has(approval.id)) handleApplyCanvasCommandApproval(approval);
    }
  }, [canvasCommandExecutionMode, executingCanvasCommandApprovalIds, handleApplyCanvasCommandApproval, pendingCanvasCommandApprovals]);

  useEffect(() => {
    if (pendingCanvasCommandApprovals.length === 0) return;
    const cancelExpiredApprovals = () => {
      const now = Date.now();
      for (const approval of pendingCanvasCommandApprovals) {
        if (executingCanvasCommandApprovalIdsRef.current.has(approval.id)) continue;
        if (approval.expiresAt && approval.expiresAt <= now) {
          handleCancelCanvasCommandApproval(approval, "timeout");
        }
      }
    };
    cancelExpiredApprovals();
    const timer = window.setInterval(cancelExpiredApprovals, 1_000);
    return () => window.clearInterval(timer);
  }, [handleCancelCanvasCommandApproval, pendingCanvasCommandApprovals]);

  const searchQuery = search.trim().toLowerCase();
  const visibleMessages = useMemo(() => {
    const submittedSkillStudioTurnIds = new Set(
      activeMessages
        .filter(messageHasSubmittedSkillStudioCardEvent)
        .map((message) => message.turnId)
        .filter((turnId): turnId is string => Boolean(turnId)),
    );
    const messages = activeMessages.filter((message) =>
      !shouldHideSkillStudioStatusOnlyMessage(message, submittedSkillStudioTurnIds),
    );
    return searchQuery
      ? messages.filter((message) => message.text.toLowerCase().includes(searchQuery))
      : messages;
  }, [activeMessages, searchQuery]);
  const activeClarificationEvent = useMemo(
    () => latestPendingAssistantClarificationEventForActiveTurn(visibleMessages, {
      busy: chat.busy,
      activeTurnId: chat.activeTurnId,
    }),
    [chat.activeTurnId, chat.busy, visibleMessages],
  );
  const activeSkillStudioQuestionEvent = useMemo(
    () => latestPendingSkillStudioQuestionEventForActiveTurn(visibleMessages, {
      busy: chat.busy,
      activeTurnId: chat.activeTurnId,
    }),
    [chat.activeTurnId, chat.busy, visibleMessages],
  );
  const hasActiveComposerPrompt = Boolean(activeSkillStudioQuestionEvent || activeClarificationEvent);
  const orphanCanvasCommandSurfaces = useMemo(() => {
    type OrphanSurface = { id: string; turnId: string | null };
    const surfaces = new Map<string, OrphanSurface>();
    const hasVisibleAssistantSurface = (id: string, turnId: string | null) =>
      visibleMessages.some(
        (message) =>
          message.role === "assistant" &&
          (message.id === id || (turnId && message.turnId === turnId)),
      );
    const addSurface = (id: string | null | undefined, turnId: string | null | undefined) => {
      const resolvedTurnId = turnId ?? null;
      const resolvedId = id || (resolvedTurnId ? `assistant-${resolvedTurnId}` : null);
      if (!resolvedId) return;
      if (hasVisibleAssistantSurface(resolvedId, resolvedTurnId)) return;
      surfaces.set(resolvedId, { id: resolvedId, turnId: resolvedTurnId });
    };
    for (const approval of pendingCanvasCommandApprovals) addSurface(approval.messageId, approval.turnId);
    const addEventRecordSurfaces = (records: Record<string, unknown>) => {
      for (const key of Object.keys(records)) {
        if (key.startsWith("assistant-")) {
          addSurface(key, key.slice("assistant-".length) || null);
        } else if (key.startsWith("turn-")) {
          addSurface(`assistant-${key}`, key);
        }
      }
    };
    addEventRecordSurfaces(canvasCommandFeedbackByMessageId);
    addEventRecordSurfaces(persistedCanvasCommandFeedbackByMessageId);
    addEventRecordSurfaces(canvasContextActivitiesByMessageId);
    return [...surfaces.values()].filter((surface) => {
      const approvals = pendingCanvasCommandApprovals.filter(
        (approval) =>
          approval.messageId === surface.id ||
          (surface.turnId && approval.turnId === surface.turnId),
      );
      const feedbacks = mergeCanvasCommandFeedbackSources(
        canvasCommandFeedbackByMessageId[surface.id],
        surface.turnId ? canvasCommandFeedbackByMessageId[surface.turnId] : undefined,
        persistedCanvasCommandFeedbackByMessageId[surface.id],
        surface.turnId ? persistedCanvasCommandFeedbackByMessageId[surface.turnId] : undefined,
      );
      const activities = mergeCanvasContextActivitySources(
        canvasContextActivitiesByMessageId[surface.id],
        surface.turnId ? canvasContextActivitiesByMessageId[surface.turnId] : undefined,
      );
      return approvals.length > 0 || feedbacks.length > 0 || activities.length > 0;
    });
  }, [
    canvasCommandFeedbackByMessageId,
    canvasContextActivitiesByMessageId,
    pendingCanvasCommandApprovals,
    persistedCanvasCommandFeedbackByMessageId,
    visibleMessages,
  ]);
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
  const activeAgentActivityLabel = agentActivityLabelFromMessage(
    chat.activeTurnId
      ? activeMessages.find(
        (message) => message.role === "assistant" && message.turnId === chat.activeTurnId,
      )
      : undefined,
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
  const thinkingCanvasContextActivity = useMemo(() => {
    if (hasActiveComposerPrompt) return null;
    if (variant !== "freezone" || !chat.busy || !chat.activeTurnId || chat.streamText.trim()) return null;
    const turnId = chat.activeTurnId;
    const hasAssistantText = activeMessages.some(
      (message) =>
        message.role === "assistant" &&
        message.turnId === turnId &&
        message.text.trim().length > 0,
    );
    if (hasAssistantText) return null;
    const hasSkillStudioStatus = activeMessages.some(
      (message) =>
        message.role === "assistant" &&
        message.turnId === turnId &&
        messageHasSkillStudioUiEvent(message),
    );
    if (hasSkillStudioStatus) return null;
    const hasAgentRuntimeActivity = activeMessages.some(
      (message) =>
        message.role === "assistant"
        && message.turnId === turnId
        && message.parts?.some((part) =>
          part.type === "agent_plan"
          || part.type === "agent_thought"
          || part.type === "tool_status"
        ),
    );
    if (hasAgentRuntimeActivity) return null;
    const hasContextActivity = (canvasContextActivitiesByMessageId[turnId]?.length ?? 0) > 0;
    const hasFeedback =
      (canvasCommandFeedbackByMessageId[turnId]?.length ?? 0) > 0 ||
      (persistedCanvasCommandFeedbackByMessageId[turnId]?.length ?? 0) > 0;
    const hasPendingApproval = pendingCanvasCommandApprovals.some((approval) => approval.turnId === turnId);
    if (hasContextActivity || hasFeedback || hasPendingApproval) return null;
    return createThinkingCanvasContextActivity(turnId);
  }, [
    activeMessages,
    canvasCommandFeedbackByMessageId,
    canvasContextActivitiesByMessageId,
    chat.activeTurnId,
    chat.busy,
    chat.streamText,
    hasActiveComposerPrompt,
    pendingCanvasCommandApprovals,
    persistedCanvasCommandFeedbackByMessageId,
    variant,
  ]);
  const showWaitingIndicator =
    chat.busy
    && !chat.streamText.trim()
    && !hasActiveComposerPrompt
    && !thinkingCanvasContextActivity
    && (
      composerWaiting
      || (
        activeTurnUserMessage
          ? !activeTurnHasAssistantReply
          : (!lastUserMessage || !lastUserHasAssistantReply)
      )
    );
  const scrollToChatBottom = useCallback((behavior: ScrollBehavior = "auto", options?: { force?: boolean }) => {
    if (!options?.force && suppressAutoScrollUntilRef.current > Date.now()) return;
    const el = scrollRef.current;
    if (!el) return;
    const top = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTo({ top, behavior });
    shouldStickToBottomRef.current = true;
    setShowScrollToBottom(false);
  }, []);
  const preserveScrollAnchor = useCallback((anchor: HTMLElement | null) => {
    const el = scrollRef.current;
    if (!el || !anchor) return;
    const beforeTop = anchor.getBoundingClientRect().top;
    suppressAutoScrollUntilRef.current = Date.now() + 700;
    shouldStickToBottomRef.current = false;
    const restore = () => {
      if (!anchor.isConnected) return;
      const afterTop = anchor.getBoundingClientRect().top;
      el.scrollTop += afterTop - beforeTop;
    };
    window.requestAnimationFrame(() => {
      restore();
      window.requestAnimationFrame(restore);
    });
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
      if (shouldStickToBottomRef.current) {
        scrollToChatBottom();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [chat.busy, chat.messages, chat.streamText, showWaitingIndicator, scrollToChatBottom]);

  useEffect(() => {
    const list = messageListRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!shouldStickToBottomRef.current) return;
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
  }, [chatScopeKey, params.project]);

  useEffect(() => {
    if (pendingAttachments.length === 0) return;
    setAttachments((current) => {
      const pendingCanvasReferenceIds = new Set(
        pendingAttachments
          .filter(isCanvasNodeReferenceAttachment)
          .map((attachment) => attachment.id)
          .filter((id): id is string => Boolean(id)),
      );
      const currentWithoutReplacedCanvasReferences =
        pendingCanvasReferenceIds.size > 0
          ? current.filter(
              (attachment) =>
                !(
                  isCanvasNodeReferenceAttachment(attachment) &&
                  attachment.id &&
                  pendingCanvasReferenceIds.has(attachment.id)
                ),
            )
          : current;
      return pruneCanvasNodeReferenceAttachments(
        mergeCanvasNodeReferenceAttachments([
          ...currentWithoutReplacedCanvasReferences,
          ...pendingAttachments,
        ]),
        existingCanvasNodeIds,
      );
    });
    onPendingAttachmentsConsumed?.();
    restoreDraftFocusRef.current = true;
  }, [existingCanvasNodeIds, onPendingAttachmentsConsumed, pendingAttachments]);

  useEffect(() => {
    if (variant !== "freezone" || currentCanvasSelection.length > 0) return;
    setAttachments((current) => {
      const next = current.filter((attachment) => !isCanvasNodeReferenceAttachment(attachment));
      return next.length === current.length ? current : next;
    });
  }, [currentCanvasSelection.length, variant]);

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
      const safeMessageAttachments =
        variant === "freezone"
          ? pruneCanvasNodeReferenceAttachments(messageAttachments, existingCanvasNodeIds)
          : messageAttachments;
      const canvasReferenceContext =
        variant === "freezone" ? buildCanvasNodeReferenceContext(safeMessageAttachments) : null;
      const canvasReferenceAttachments = safeMessageAttachments.filter(isCanvasNodeReferenceAttachment);
      const ordinaryAttachments = safeMessageAttachments.filter(
        (attachment) => !isCanvasNodeReferenceAttachment(attachment),
      );
      let transportAttachments = safeMessageAttachments;
      let contextUploadedFiles = uploadedIngestFiles;
      const project = params.project?.trim();
      const canvasCommandContext =
        variant === "freezone"
          ? buildCanvasChatCommandContext(currentCanvasOntologyContext, {
              includeCanvasSummary: shouldIncludeCanvasSummary(text, {
                hasFocusedNodeContext: Boolean(canvasReferenceContext),
              }),
            })
          : null;
      const videoIntent = VIDEO_CREATION_RE.test(text);
      const hasNovelAttachments = ordinaryAttachments.some(isNovelAttachment);

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
          return chat.send(text, canvasReferenceAttachments, nextText);
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
          const prepared = await uploadAttachmentsForIngest(project, ordinaryAttachments, t);
          surfaceFormatCheckWarnings(prepared, t, (formatCheck, filename) =>
            setFormatCheckDetails({ formatCheck, filename }),
          );
          transportAttachments = [...prepared.map((item) => item.attachment), ...canvasReferenceAttachments];
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
      } else if (ordinaryAttachments.length > 0) {
        setPreparingSend(true);
        try {
          const prepared = project
            ? await uploadAttachmentsForIngest(project, ordinaryAttachments, t)
            : ordinaryAttachments.map((attachment) => ({ attachment, original: attachment }));
          surfaceFormatCheckWarnings(prepared, t, (formatCheck, filename) =>
            setFormatCheckDetails({ formatCheck, filename }),
          );
          transportAttachments = [...prepared.map((item) => item.attachment), ...canvasReferenceAttachments];
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

      if (canvasCommandContext) {
        nextText = appendAttachmentAnalysisContext(nextText, canvasCommandContext);
      }
      if (canvasReferenceContext) {
        nextText = appendAttachmentAnalysisContext(nextText, canvasReferenceContext);
      }

      return chat.send(text, transportAttachments, nextText);
    },
    [
      chat,
      currentCanvasOntologyContext,
      existingCanvasNodeIds,
      params.project,
      recordUploadedFiles,
      reingestConfirmation,
      t,
      uploadedIngestFiles,
      variant,
    ],
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
    composerBeamRef.current?.setActive?.(composerBeamActive);
  }, [composerBeamActive]);

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
    const messageAttachments = selectedFreezoneNodeAttachment
      ? mergeCanvasNodeReferenceAttachments([...attachments, selectedFreezoneNodeAttachment])
      : attachments;
    const hasCurrentContent = draft.trim().length > 0 || messageAttachments.length > 0;
    if (!hasCurrentContent || preparingSend) return;
    if (!chat.connected) {
      toast.error(t("aiAssistant.waiting"));
      return;
    }
    setSelectedHistoryMessageIndex(null);
    const hasOnlyCanvasReferences =
      draft.trim().length === 0
      && messageAttachments.length > 0
      && messageAttachments.every(isCanvasNodeReferenceAttachment);
    const text = draft.trim() || (
      hasOnlyCanvasReferences
        ? t("aiAssistant.canvasReferenceOnlyPrompt")
        : t("aiAssistant.attachmentOnlyPrompt")
    );
    const queuedAttachments = messageAttachments.map((attachment) => ({ ...attachment }));
    const sentCanvasNodeIds = new Set(queuedAttachments.flatMap(canvasNodeReferenceAttachmentNodeIds));
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
      deselectFreezoneNodeReferences(sentCanvasNodeIds);
      return;
    }
    void sendWithIngestAutomation(text, queuedAttachments).then((sent) => {
      if (!sent) return;
      setDraft("");
      setAttachments([]);
      deselectFreezoneNodeReferences(sentCanvasNodeIds);
    });
  };

  const submitSkillStudioQuestionResponse = useCallback(async (
    event: Extract<SkillStudioUiEvent, { type: "skill_studio.questions" }>,
    selections: SkillStudioQuestionSelections,
  ): Promise<boolean> => {
    if (!chat.busy || !event.turn_id || event.turn_id !== chat.activeTurnId) {
      toast.error("这轮对话已结束，不能继续提交这个问题");
      return false;
    }
    if (!event.bridge_key) {
      toast.error("Skill Studio 桥接信息缺失，请重试");
      return false;
    }
    try {
      const action = selections.__action === "recommended"
        ? "recommended"
        : selections.__action === "skip"
          ? "skip"
          : "submit";
      const payload = {
        ...buildSkillStudioQuestionToolResultForTest(event, selections),
        action,
        skill_studio_status: action === "submit" ? "answered" : action,
        message:
          action === "recommended"
            ? buildSkillStudioRecommendedResponse(event)
            : action === "skip"
              ? buildSkillStudioSkipResponse(event)
              : buildSkillStudioQuestionResponseForTest(event, selections),
      };
      if (!chat.submitSkillStudioResult(payload)) {
        toast.error("Skill Studio 连接未就绪，请重试");
        return false;
      }
      if (event.turn_id) {
        const receivedAt = uiEventFirstReceivedAt(event);
        const persistedEvent = {
          type: "skill_studio.questions",
          bridge_key: event.bridge_key,
          skill_studio_session_id: event.skill_studio_session_id,
          project_id: event.project_id ?? params.project,
          canvas_id: event.canvas_id ?? effectiveFreezoneCanvasId,
          agent_id: event.agent_id ?? effectiveFreezoneAgentId,
          anchor_text_prefix: event.anchor_text_prefix ?? null,
          received_at: receivedAt,
          title: event.title,
          description: event.description,
          questions: event.questions,
          submitted: true,
          action,
          selections: payload.selections,
        };
        updateChatUiEvent(
          event.turn_id,
          (candidate) => skillStudioEventMatches(candidate, event),
          (candidate) => ({
            ...(candidate as Record<string, unknown>),
            received_at: uiEventFirstReceivedAt(candidate, event),
            submitted: true,
            action,
            selections: payload.selections,
          }),
        );
        persistSkillStudioUiEvent(event.turn_id, persistedEvent);
      }
      return true;
    } catch (error) {
      console.error("[superchat] skill studio result submit failed", error);
      toast.error("提交 Skill Studio 选择失败，请重试");
      return false;
    }
  }, [chat, effectiveFreezoneAgentId, effectiveFreezoneCanvasId, params.project, persistSkillStudioUiEvent, updateChatUiEvent]);

  const submitAssistantClarificationResponse = useCallback(async (
    event: AssistantClarificationUiEvent,
    answers: AssistantClarificationAnswers,
  ): Promise<boolean> => {
    if (!chat.busy || !event.turn_id || event.turn_id !== chat.activeTurnId) {
      toast.error("这轮对话已结束，不能继续提交这个问题");
      return false;
    }
    if (!event.bridge_key) {
      toast.error("补充信息桥接缺失，请重试");
      return false;
    }
    try {
      const action = answers.__action === "recommended"
        ? "recommended"
        : answers.__action === "skip"
          ? "skip"
          : "submit";
      const skillStudioRevision = activeAssistantClarificationIsSkillStudioRevision(visibleMessages, event);
	      const payload = {
	        ...buildAssistantClarificationToolResultForTest(event, answers, { skillStudioRevision }),
	        action,
	        clarification_status: action === "submit" ? "answered" : action,
	        skipped: action === "skip",
	        used_recommended: action === "recommended",
	      };
      if (!chat.submitAssistantClarificationResult(payload)) {
        toast.error("补充信息连接未就绪，请重试");
        return false;
      }
      if (event.turn_id) {
        const actionStatus = action === "submit" ? "answered" : action;
        const receivedAt = uiEventFirstReceivedAt(event);
        const persistedEvent = buildPersistedAssistantClarificationEvent(event, {
          action,
          answers: payload.answers,
          clarificationStatus: actionStatus,
          receivedAt,
          skipped: action === "skip",
          usedRecommended: action === "recommended",
        });
        updateChatUiEvent(
          event.turn_id,
          (candidate) =>
            Boolean(
              candidate
              && typeof candidate === "object"
              && (candidate as Record<string, unknown>).type === "assistant.clarification.request"
              && (
                (event.bridge_key && (candidate as Record<string, unknown>).bridge_key === event.bridge_key)
                || (event.clarification_id && (candidate as Record<string, unknown>).clarification_id === event.clarification_id)
              ),
            ),
          (candidate) => ({
            ...(candidate as Record<string, unknown>),
            received_at: uiEventFirstReceivedAt(candidate, event),
            submitted: true,
            action,
            clarification_status: actionStatus,
            answers: payload.answers,
            skipped: action === "skip",
            used_recommended: action === "recommended",
            anchor_text_prefix: event.anchor_text_prefix ?? null,
          }),
        );
        persistSkillStudioUiEvent(event.turn_id, persistedEvent);
      }
      return true;
    } catch (error) {
      console.error("[superchat] clarification result submit failed", error);
      toast.error("提交补充信息失败，请重试");
      return false;
    }
	  }, [chat, persistSkillStudioUiEvent, updateChatUiEvent, visibleMessages]);

  const submitSkillStudioDraftResponse = useCallback(async (
    event: Extract<SkillStudioUiEvent, { type: "skill_studio.draft" }>,
    draftPayload: Record<string, unknown>,
  ): Promise<boolean> => {
    if (!event.bridge_key) {
      toast.error("Skill Studio 桥接信息缺失，请重试");
      return false;
    }
    try {
      const payload = buildSkillStudioDraftToolResultForTest(event, draftPayload);
      if (!chat.submitSkillStudioResult(payload)) {
        toast.error("Skill Studio 连接未就绪，请重试");
        return false;
      }
      const savedKinds = new Set<FreezoneAgentConfigKind>([
        ...(payload.saved_skill_ids.length > 0 ? ["skills" as const] : []),
        ...(payload.saved_recipe_ids.length > 0 ? ["recipes" as const] : []),
      ]);
      for (const kind of savedKinds) {
        void queryClient.invalidateQueries({
          queryKey: freezoneAgentConfigQueryKey(kind),
        });
      }
      if (savedKinds.has("skills")) {
        void apiCall<FreezoneAgentConfigPayload[]>("freezone/agent-config/skills")
          .then((skills) => {
            setFreezoneSkillCatalog(skills);
            setFreezoneSkillCatalogLoaded(true);
          })
          .catch(() => undefined);
      }
      if (event.turn_id) {
        const receivedAt = uiEventFirstReceivedAt(event);
        const persistedEvent = {
          type: "skill_studio.draft",
          bridge_key: event.bridge_key,
          skill_studio_session_id: event.skill_studio_session_id,
          project_id: event.project_id ?? params.project,
          canvas_id: event.canvas_id ?? effectiveFreezoneCanvasId,
          agent_id: event.agent_id ?? effectiveFreezoneAgentId,
          anchor_text_prefix: event.anchor_text_prefix ?? null,
          received_at: receivedAt,
          mode: event.mode,
          draft: payload.draft,
          submitted: true,
          saved_to_catalog: payload.saved_to_catalog,
          saved_skill_ids: payload.saved_skill_ids,
          saved_recipe_ids: payload.saved_recipe_ids,
          action: payload.action,
        };
        updateChatUiEvent(
          event.turn_id,
          (candidate) => skillStudioEventMatches(candidate, event),
            (candidate) => ({
              ...(candidate as Record<string, unknown>),
              received_at: uiEventFirstReceivedAt(candidate, event),
              submitted: true,
              draft: payload.draft,
              saved_to_catalog: payload.saved_to_catalog,
              saved_skill_ids: payload.saved_skill_ids,
              saved_recipe_ids: payload.saved_recipe_ids,
              action: payload.action,
            }),
          );
        persistSkillStudioUiEvent(event.turn_id, persistedEvent);
      }
      toast.success("已添加到虾画 Skills / Recipes");
      return true;
    } catch (error) {
      console.error("[superchat] skill studio draft submit failed", error);
      toast.error("添加 Skill / Recipe 失败，请检查必填字段后重试");
      return false;
    }
  }, [chat, effectiveFreezoneAgentId, effectiveFreezoneCanvasId, params.project, persistSkillStudioUiEvent, queryClient, updateChatUiEvent]);

  const handleSkillStudioDraftChange = useCallback((
    event: Extract<SkillStudioUiEvent, { type: "skill_studio.draft" }>,
    draftPayload: Record<string, unknown>,
  ) => {
    if (!event.turn_id) return;
    const receivedAt = uiEventFirstReceivedAt(event);
    const persistedEvent = {
      type: "skill_studio.draft",
      bridge_key: event.bridge_key,
      skill_studio_session_id: event.skill_studio_session_id,
      project_id: event.project_id ?? params.project,
      canvas_id: event.canvas_id ?? effectiveFreezoneCanvasId,
      agent_id: event.agent_id ?? effectiveFreezoneAgentId,
      anchor_text_prefix: event.anchor_text_prefix ?? null,
      received_at: receivedAt,
      mode: event.mode,
      draft: draftPayload,
    };
    updateChatUiEvent(
      event.turn_id,
      (candidate) => skillStudioEventMatches(candidate, event),
      (candidate) => ({
        ...(candidate as Record<string, unknown>),
        received_at: uiEventFirstReceivedAt(candidate, event),
        draft: draftPayload,
      }),
    );
    persistSkillStudioUiEvent(event.turn_id, persistedEvent, { debounce: true });
  }, [effectiveFreezoneAgentId, effectiveFreezoneCanvasId, params.project, persistSkillStudioUiEvent, updateChatUiEvent]);

  const startSkillStudioDraftRevision = useCallback(async (
    event: Extract<SkillStudioUiEvent, { type: "skill_studio.draft" }>,
    draftPayload: Record<string, unknown>,
  ): Promise<boolean> => {
    if (!event.turn_id) return false;
    if (!event.bridge_key) {
      toast.error("Skill Studio 桥接信息缺失，请重试");
      return false;
    }
    try {
      const payload = buildSkillStudioDraftRevisionToolResultForTest(event, draftPayload);
      if (!chat.submitSkillStudioResult(payload)) {
        toast.error("Skill Studio 连接未就绪，请重试");
        return false;
      }
      const receivedAt = uiEventFirstReceivedAt(event);
      const persistedEvent = {
        type: "skill_studio.draft",
        bridge_key: event.bridge_key,
        skill_studio_session_id: event.skill_studio_session_id,
        project_id: event.project_id ?? params.project,
        canvas_id: event.canvas_id ?? effectiveFreezoneCanvasId,
        agent_id: event.agent_id ?? effectiveFreezoneAgentId,
        anchor_text_prefix: event.anchor_text_prefix ?? null,
        received_at: receivedAt,
        mode: event.mode,
        draft: payload.draft,
        revision_pending: true,
        action: payload.action,
        skill_studio_status: payload.skill_studio_status,
      };
      updateChatUiEvent(
        event.turn_id,
        (candidate) => skillStudioEventMatches(candidate, event),
        (candidate) => ({
          ...(candidate as Record<string, unknown>),
          received_at: uiEventFirstReceivedAt(candidate, event),
          draft: payload.draft,
          revision_pending: true,
          action: payload.action,
          skill_studio_status: payload.skill_studio_status,
        }),
      );
      persistSkillStudioUiEvent(event.turn_id, persistedEvent);
      return true;
    } catch (error) {
      console.error("[superchat] skill studio draft revision submit failed", error);
      toast.error("启动草稿调整失败，请重试");
      return false;
    }
  }, [chat, effectiveFreezoneAgentId, effectiveFreezoneCanvasId, params.project, persistSkillStudioUiEvent, updateChatUiEvent]);

  const handleCancelSkillStudioDraft = useCallback((
    event: Extract<SkillStudioUiEvent, { type: "skill_studio.draft" }>,
    draftPayload: Record<string, unknown>,
  ) => {
    if (!event.turn_id) return;
    if (!event.bridge_key) {
      toast.error("Skill Studio 桥接信息缺失，请重试");
      return;
    }
    const payload = buildSkillStudioDraftCancelToolResultForTest(event, draftPayload);
    if (!chat.submitSkillStudioResult(payload)) {
      toast.error("Skill Studio 连接未就绪，请重试");
      return;
    }
    const receivedAt = uiEventFirstReceivedAt(event);
    const persistedEvent = {
      type: "skill_studio.draft",
      bridge_key: event.bridge_key,
      skill_studio_session_id: event.skill_studio_session_id,
      project_id: event.project_id ?? params.project,
      canvas_id: event.canvas_id ?? effectiveFreezoneCanvasId,
      agent_id: event.agent_id ?? effectiveFreezoneAgentId,
      anchor_text_prefix: event.anchor_text_prefix ?? null,
      received_at: receivedAt,
      draft: payload.draft,
      cancelled: true,
    };
    updateChatUiEvent(
      event.turn_id,
      (candidate) => skillStudioEventMatches(candidate, event),
      (candidate) => ({
        ...(candidate as Record<string, unknown>),
        received_at: uiEventFirstReceivedAt(candidate, event),
        draft: payload.draft,
        cancelled: true,
      }),
    );
    persistSkillStudioUiEvent(event.turn_id, persistedEvent);
  }, [chat, effectiveFreezoneAgentId, effectiveFreezoneCanvasId, params.project, persistSkillStudioUiEvent, updateChatUiEvent]);

  const handleComposerKeyDown = (event: ReactKeyboardEvent) => {
    if (!shouldSubmitComposerEnter(event)) return;
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
            {freezoneHeaderActions}
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
            ) : chat.messages.length === 0 && !chat.streamText && !showWaitingIndicator && orphanCanvasCommandSurfaces.length === 0 ? (
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
                      canvasCommandApprovals={pendingCanvasCommandApprovals.filter(
                        (approval) =>
                          message.role === "assistant" &&
                          (
                            approval.messageId === message.id ||
                            (approval.turnId && approval.turnId === message.turnId)
                          ),
                      )}
                      canvasCommandFeedbacks={mergeCanvasCommandFeedbackSources(
                        canvasCommandFeedbacksFromUiEvents(messageUiEvents(message)),
                        mergeCanvasCommandFeedbackSources(
                          canvasCommandFeedbackByMessageId[message.id],
                          message.turnId ? canvasCommandFeedbackByMessageId[message.turnId] : undefined,
                          message.turnId ? canvasCommandFeedbackByMessageId[`assistant-${message.turnId}`] : undefined,
                        ),
                      )}
                      canvasContextActivities={mergeCanvasContextActivitySources(
                        canvasContextActivitiesFromUiEvents(messageUiEvents(message)),
                        canvasContextActivitiesByMessageId[message.id],
                        message.turnId ? canvasContextActivitiesByMessageId[message.turnId] : undefined,
                        message.turnId ? canvasContextActivitiesByMessageId[`assistant-${message.turnId}`] : undefined,
                      )}
                      executingCanvasCommandApprovalIds={executingCanvasCommandApprovalIds}
                      onApplyCanvasCommandApproval={handleApplyCanvasCommandApproval}
                      onCancelCanvasCommandApproval={handleCancelCanvasCommandApproval}
                      onSubmitSkillStudioQuestionResponse={submitSkillStudioQuestionResponse}
                      onSubmitSkillStudioDraftResponse={submitSkillStudioDraftResponse}
                      onStartSkillStudioDraftRevision={startSkillStudioDraftRevision}
                      onSkillStudioDraftChange={handleSkillStudioDraftChange}
                      onCancelSkillStudioDraft={handleCancelSkillStudioDraft}
                      onPreserveScrollAnchor={preserveScrollAnchor}
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
                    onSubmitSkillStudioQuestionResponse={submitSkillStudioQuestionResponse}
                    onSubmitSkillStudioDraftResponse={submitSkillStudioDraftResponse}
                    onStartSkillStudioDraftRevision={startSkillStudioDraftRevision}
                    onSkillStudioDraftChange={handleSkillStudioDraftChange}
                    onCancelSkillStudioDraft={handleCancelSkillStudioDraft}
                    onPreserveScrollAnchor={preserveScrollAnchor}
                  />
                )}
                {orphanCanvasCommandSurfaces.map((surface) => (
                  <MessageBubble
                    key={`orphan-canvas-surface:${surface.id}`}
                    message={{
                      id: surface.id,
                      role: "assistant",
                      text: "",
                      displayName: "Agent",
                      timestamp: Date.now(),
                      turnId: surface.turnId ?? undefined,
                    }}
                    variant={variant}
                    onOpenDetail={setDetailMessage}
                    onOpenMedia={setMediaDetail}
                    pinned={false}
                    onDelete={() => undefined}
                    onTogglePin={() => undefined}
                    streaming={chat.busy}
                    canvasCommandApprovals={pendingCanvasCommandApprovals.filter(
                      (approval) =>
                        approval.messageId === surface.id ||
                        (surface.turnId && approval.turnId === surface.turnId),
                    )}
                    canvasCommandFeedbacks={mergeCanvasCommandFeedbackSources(
                      canvasCommandFeedbackByMessageId[surface.id],
                      surface.turnId ? canvasCommandFeedbackByMessageId[surface.turnId] : undefined,
                      persistedCanvasCommandFeedbackByMessageId[surface.id],
                      surface.turnId ? persistedCanvasCommandFeedbackByMessageId[surface.turnId] : undefined,
                    )}
                    canvasContextActivities={mergeCanvasContextActivitySources(
                      canvasContextActivitiesByMessageId[surface.id],
                      surface.turnId ? canvasContextActivitiesByMessageId[surface.turnId] : undefined,
                    )}
                    executingCanvasCommandApprovalIds={executingCanvasCommandApprovalIds}
                    onApplyCanvasCommandApproval={handleApplyCanvasCommandApproval}
                    onCancelCanvasCommandApproval={handleCancelCanvasCommandApproval}
                    onSubmitSkillStudioQuestionResponse={submitSkillStudioQuestionResponse}
                    onSubmitSkillStudioDraftResponse={submitSkillStudioDraftResponse}
                    onStartSkillStudioDraftRevision={startSkillStudioDraftRevision}
                    onSkillStudioDraftChange={handleSkillStudioDraftChange}
                    onCancelSkillStudioDraft={handleCancelSkillStudioDraft}
                    onPreserveScrollAnchor={preserveScrollAnchor}
                  />
                ))}
                {thinkingCanvasContextActivity && (
                  <MessageBubble
                    message={{
                      id: thinkingCanvasContextActivity.key,
                      role: "assistant",
                      text: "",
                      timestamp: Date.now(),
                      turnId: thinkingCanvasContextActivity.turnId ?? undefined,
                    }}
                    variant={variant}
                    onOpenDetail={setDetailMessage}
                    onOpenMedia={setMediaDetail}
                    pinned={false}
                    onDelete={() => undefined}
                    onTogglePin={() => undefined}
                    streaming={chat.busy}
                    canvasContextActivities={[thinkingCanvasContextActivity]}
                    onSubmitSkillStudioQuestionResponse={submitSkillStudioQuestionResponse}
                    onSubmitSkillStudioDraftResponse={submitSkillStudioDraftResponse}
                    onStartSkillStudioDraftRevision={startSkillStudioDraftRevision}
                    onSkillStudioDraftChange={handleSkillStudioDraftChange}
                    onCancelSkillStudioDraft={handleCancelSkillStudioDraft}
                    onPreserveScrollAnchor={preserveScrollAnchor}
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
              onClick={() => scrollToChatBottom("auto", { force: true })}
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
              label={isFreezoneLayout ? t("aiAssistant.freezoneWaitingResponse") : t("aiAssistant.waitingResponse")}
              activityLabel={activeAgentActivityLabel}
              visible={showWaitingIndicator}
              variant={isFreezoneLayout ? "freezone" : "default"}
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
            {activeSkillStudioQuestionEvent && (
              <SkillStudioQuestionsCard
                key={skillStudioQuestionEventIdentity(activeSkillStudioQuestionEvent)}
                event={activeSkillStudioQuestionEvent}
                onSubmit={submitSkillStudioQuestionResponse}
              />
            )}
            {activeClarificationEvent && (
              <AssistantClarificationInputCard
                key={assistantClarificationEventIdentity(activeClarificationEvent)}
                event={activeClarificationEvent}
                onSubmit={submitAssistantClarificationResponse}
              />
            )}
            {!hasActiveComposerPrompt && showFreezoneSkillSuggestions && (
              <div className="border-b border-white/10 bg-black/20 px-3 py-2.5">
                <div className="mb-1.5 px-0.5 text-xs text-muted-foreground/85">
                  技能
                </div>
                <div className="max-h-52 overflow-y-auto pr-1">
                  {visibleFreezoneSkillSuggestions.map((skill, index) => (
                    <button
                      key={skill.id}
                      ref={(element) => {
                        freezoneSkillSuggestionRefs.current[index] = element;
                      }}
                      type="button"
                      className={cn(
                        "flex h-8 w-full items-center gap-2 rounded-md px-1 text-left text-sm transition hover:bg-white/[0.06] focus-visible:bg-white/[0.06] focus-visible:outline-none",
                        activeFreezoneSkillSuggestionIndex === index && "bg-white/[0.06]",
                      )}
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      onMouseEnter={() => setActiveFreezoneSkillSuggestionIndex(index)}
                      onClick={() => insertFreezoneSkillSuggestion(skill.id)}
                    >
                      <Package className="size-3.5 shrink-0 text-muted-foreground/80" />
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="shrink-0 text-[13px] font-medium text-foreground/90">
                          {skill.label}
                        </span>
                        {skill.description && (
                          <span className="truncate text-xs text-muted-foreground/65">
                            {skill.description}
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {!hasActiveComposerPrompt && visibleComposerAttachments.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
                {visibleComposerAttachments.map((attachment) => (
                  <span
                    key={attachment.id}
                    className="inline-flex max-w-48 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs"
                  >
                    {attachment.mimeType?.startsWith("image/") ? <Image className="size-3.5" /> : <File className="size-3.5" />}
                    <span className="truncate">{attachment.label || attachment.fileName}</span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(attachment)}
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
              <div className="border-t border-white/[0.05] px-4 py-2">
                <div className="mb-1.5 text-xs font-normal text-foreground/40">
                  {t("aiAssistant.queuedCount", { count: queuedMessages.length })}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {queuedMessages.map((message) => {
                    const showSelectedState = queuedMessages.length > 1 && selectedQueuedMessageId === message.id;
                    return (
                      <div
                        key={message.id}
                        className={cn(
                          "inline-flex max-w-full items-center overflow-hidden rounded-[6px] border border-white/[0.08] bg-white/[0.035] text-xs text-foreground/70 transition-colors hover:bg-white/[0.055] focus-within:border-white/[0.18]",
                          showSelectedState && "border-primary/35 bg-primary/[0.07] text-foreground/90 focus-within:border-primary/45",
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedQueuedMessageId(message.id)}
                          className="flex min-w-0 items-center gap-1.5 px-2 py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25"
                          aria-label={t("aiAssistant.selectQueuedMessage")}
                          aria-pressed={showSelectedState}
                        >
                          <span className="max-w-56 truncate">{message.text}</span>
                          {message.attachments.length > 0 && (
                            <span className="shrink-0 text-foreground/45">
                              {t("aiAssistant.queuedAttachments", { count: message.attachments.length })}
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setQueuedMessages((current) => current.filter((item) => item.id !== message.id));
                          }}
                          className="mr-0.5 flex size-5 shrink-0 items-center justify-center rounded-[4px] text-foreground/35 transition-colors hover:bg-white/[0.06] hover:text-foreground/75 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25"
                          aria-label={t("aiAssistant.removeQueuedMessage")}
                        >
                          <X className="size-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {!hasActiveComposerPrompt && isFreezoneLayout && selectedFreezoneNodes.length > 0 && (
              <div className={cn("px-4", visibleComposerAttachments.length > 0 ? "pt-2" : "pt-3")}>
                <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>当前选中</span>
                  <div className="flex items-center gap-2">
                    <span>本轮会使用</span>
                    {selectedFreezoneNodes.length > 1 && (
                      <button
                        type="button"
                        onClick={deselectAllSelectedFreezoneNodeReferences}
                        className="rounded-sm px-1.5 py-0.5 text-[11px] font-medium text-destructive transition hover:bg-destructive/10 hover:text-destructive"
                        aria-label="取消全部画布引用"
                      >
                        全部取消
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {selectedFreezoneNodePreviews.map((node) => (
                    <CanvasNodeReferenceThumb
                      key={node.nodeId}
                      node={node}
                      onRemove={() => deselectFreezoneNodeReference(node.nodeId)}
                    />
                  ))}
                </div>
              </div>
            )}
            {!hasActiveComposerPrompt && (
              <>
                <Textarea
                  ref={draftInputRef}
                  value={draft}
                  onChange={(event) => {
                    setSelectedHistoryMessageIndex(null);
                    setDraft(event.target.value);
                  }}
                  onFocus={() => setComposerInputFocused(true)}
                  onBlur={() => setComposerInputFocused(false)}
                  onKeyDown={(event) => {
                    if (
                      showFreezoneSkillSuggestions
                      && (event.key === "ArrowDown" || event.key === "ArrowUp")
                    ) {
                      event.preventDefault();
                      setActiveFreezoneSkillSuggestionIndex((index) =>
                        moveFreezoneSkillSuggestionIndex(
                          index,
                          event.key === "ArrowDown" ? 1 : -1,
                          visibleFreezoneSkillSuggestions.length,
                        ),
                      );
                      return;
                    }
                    if (
                      showFreezoneSkillSuggestions
                      && event.key === "Enter"
                      && !event.shiftKey
                      && visibleFreezoneSkillSuggestions[activeFreezoneSkillSuggestionIndex]
                    ) {
                      event.preventDefault();
                      insertFreezoneSkillSuggestion(
                        visibleFreezoneSkillSuggestions[activeFreezoneSkillSuggestionIndex].id,
                      );
                      return;
                    }
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
                    if (shouldSubmitComposerEnter(event)) {
                      event.preventDefault();
                      submit();
                    }
                  }}
                  dir="auto"
                  placeholder={isFreezoneLayout ? t("aiAssistant.freezonePlaceholder") : t("aiAssistant.placeholder")}
                  className={cn(
                    "max-h-[220px] min-h-14 resize-none border-0 bg-transparent px-5 py-4 text-base shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0 dark:bg-transparent",
                    isFreezoneLayout && "min-h-11 px-3.5 py-3 text-sm",
                  )}
                  rows={1}
                />
                <div className="flex items-center justify-between px-3 py-2">
                  <div className="flex items-center gap-1">
                    {isFreezoneLayout && (
                      <div>
                        <Button
                          ref={canvasCommandModeButtonRef}
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
                          onClick={() => setCanvasCommandModeMenuOpen((open) => !open)}
                        >
                          {canvasCommandExecutionMode === "manual_confirm" ? (
                            <>
                              <ShieldAlert className="size-3.5" />
                              手动确认
                            </>
                          ) : (
                            <>
                              <Wrench className="size-3.5" />
                              自动生成
                            </>
                          )}
                        </Button>
                      </div>
                    )}
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
              </>
            )}
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
      {isFreezoneLayout && canvasCommandModeMenuOpen && canvasCommandModeMenuPosition && createPortal(
        <div
          data-canvas-command-mode-menu="true"
          className="fixed z-[1000] w-72 overflow-hidden rounded-xl border border-white/10 bg-popover p-1.5 text-popover-foreground shadow-xl"
          style={{
            left: canvasCommandModeMenuPosition.left,
            bottom: canvasCommandModeMenuPosition.bottom,
          }}
        >
          <button
            type="button"
            className={cn(
              "flex min-h-[58px] w-full items-start gap-3 rounded-lg px-3 py-2 text-left hover:bg-white/[0.06]",
              canvasCommandExecutionMode === "manual_confirm" && "bg-white/[0.08]",
            )}
            onClick={() => setCanvasExecutionMode("manual_confirm")}
          >
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">手动确认</span>
              <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                Agent 在执行画布命令前都会请求确认
              </span>
            </span>
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
              {canvasCommandExecutionMode === "manual_confirm" && <CheckCircle2 className="size-4" />}
            </span>
          </button>
          <button
            type="button"
            className={cn(
              "flex min-h-[58px] w-full items-start gap-3 rounded-lg px-3 py-2 text-left hover:bg-white/[0.06]",
              canvasCommandExecutionMode === "auto_execute" && "bg-white/[0.08]",
            )}
            onClick={() => setCanvasExecutionMode("auto_execute")}
          >
            <Wrench className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">自动生成</span>
              <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                Agent 会自动执行安全命令并反馈结果
              </span>
            </span>
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
              {canvasCommandExecutionMode === "auto_execute" && <CheckCircle2 className="size-4" />}
            </span>
          </button>
        </div>,
        document.body,
      )}
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
