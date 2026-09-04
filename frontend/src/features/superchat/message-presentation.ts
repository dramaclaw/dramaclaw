// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ChatRole } from "@/features/superchat/types";

export type MessageSurface = "user" | "plain" | "tool" | "system" | "error";

export function resolveMessagePresentation({
  role,
  tool,
  error,
  streaming,
}: {
  role: ChatRole;
  tool: boolean;
  error: boolean;
  streaming: boolean;
}): { surface: MessageSurface; showAssistantActions: boolean } {
  if (role === "user") {
    return { surface: "user", showAssistantActions: false };
  }
  if (tool) {
    return { surface: "tool", showAssistantActions: !streaming };
  }
  if (role === "system") {
    return { surface: "system", showAssistantActions: false };
  }
  if (error) {
    return { surface: "error", showAssistantActions: !streaming };
  }
  return { surface: "plain", showAssistantActions: !streaming };
}
