import { compileStoryGroup } from "./compileStoryGroup";
import type {
  CanvasNode,
  CanvasEdge,
  VideoNodeData,
  GroupNodeData,
} from "@/features/canvas/domain/canvasNodes";
import type { StoryChoiceEdgeData } from "./storyTypes";

type PlaybackVideoData = Pick<
  VideoNodeData,
  | "displayName"
  | "narration"
  | "videoUrl"
  | "choiceLoopVideoUrl"
  | "storyRole"
  | "choiceTimeLimitSec"
  | "endingLabel"
  | "storyCta"
>;
type PlaybackGroupData = Pick<
  GroupNodeData,
  "storyVariableDefinitions" | "storyFlags"
>;
/** The publication wire contract deliberately excludes generation/editor data. */
export interface PlaybackSnapshot {
  groupId: string;
  nodes: Array<
    Pick<CanvasNode, "id" | "type" | "parentId" | "position"> & {
      data: PlaybackVideoData | PlaybackGroupData;
    }
  >;
  edges: Array<
    Pick<CanvasEdge, "id" | "type" | "source" | "target"> & {
      data: Pick<
        StoryChoiceEdgeData,
        | "choiceText"
        | "transitionMode"
        | "order"
        | "condition"
        | "effects"
        | "feedbackText"
        | "interaction"
        | "isDefault"
        | "needsReview"
      >;
    }
  >;
}
export interface PublishedVersion {
  public_id: string;
  number?: number;
  created_at?: string;
  published_at?: string | null;
  published?: boolean;
  version: string;
  status: "preparing" | "ready" | "failed";
  title: string;
  description: string;
  cover?: string;
  cover_mode?: "landscape" | "portrait";
  cover_position_x?: number;
  cover_position_y?: number;
  revision: number;
  progress?: { completed: number; total: number };
  error?: string;
  issues: Array<{ severity: string; code: string; entity_id?: string; node_id?: string; entity_label?: string }>;
  snapshot?: PlaybackSnapshot;
}
export type PlayerVersion = Pick<PublishedVersion,
  "public_id" | "version" | "title" | "description" | "snapshot" | "cover" |
  "cover_mode" | "cover_position_x" | "cover_position_y" | "number" | "published_at"
>;
export interface Publication {
  public_id: string;
  active_version: string | null;
  listed: boolean;
  versions: PublishedVersion[];
}
export function compilePlayback(snapshot: PlaybackSnapshot) {
  // Runtime compiler retains its canvas entry point for editor/export callers.
  return compileStoryGroup(
    snapshot.groupId,
    snapshot.nodes as CanvasNode[],
    snapshot.edges as CanvasEdge[],
  );
}
export const playerSaveKey = (id: string, version: string) =>
  `dramaclaw.player.save.${id}.${version}`;
export function savedVersion(id: string): string | null {
  try {
    return localStorage.getItem(`dramaclaw.player.version.${id}`);
  } catch {
    return null;
  }
}
export function rememberVersion(id: string, version: string) {
  try {
    localStorage.setItem(`dramaclaw.player.version.${id}`, version);
  } catch {
    /* Playback works without storage. */
  }
}
