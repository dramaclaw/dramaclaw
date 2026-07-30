// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { SuperChatPanel } from "@/features/superchat/superchat-panel";
import { XIADAO_ENABLED } from "@/lib/xiadao-flag";

function ProjectAssistantPage() {
  const { t } = useTranslation();
  return (
    <div className="h-full min-h-0 overflow-hidden bg-background">
      {XIADAO_ENABLED ? (
        <SuperChatPanel />
      ) : (
        // 虾导下线期间 tab 仍然可点，这里顶掉整个聊天区（含输入框），
        // 免得留着能发消息的入口。恢复只需把 XIADAO_ENABLED 改回 true。
        <div className="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
          <img
            src="/images/avatar-claw.png"
            alt=""
            aria-hidden="true"
            className="size-24 rounded-full object-cover opacity-60 grayscale"
          />
          <p className="text-base text-muted-foreground">{t("aiAssistant.upgrading")}</p>
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute("/_app/projects/$project/assistant")({
  component: ProjectAssistantPage,
});
