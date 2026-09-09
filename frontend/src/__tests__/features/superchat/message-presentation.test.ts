// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { resolveMessagePresentation } from "@/features/superchat/message-presentation";

describe("resolveMessagePresentation", () => {
  it.each([
    ["assistant text", "assistant", false, false, false, "plain", true],
    ["streaming assistant", "assistant", false, false, true, "plain", false],
    ["assistant error", "assistant", false, true, false, "error", true],
    ["tool event", "tool", true, false, false, "tool", true],
    ["system event", "system", false, false, false, "system", false],
    ["user message", "user", false, false, false, "user", false],
  ] as const)(
    "%s uses the expected surface and action visibility",
    (_name, role, tool, error, streaming, surface, showAssistantActions) => {
      expect(resolveMessagePresentation({ role, tool, error, streaming })).toEqual({
        surface,
        showAssistantActions,
      });
    },
  );
});
