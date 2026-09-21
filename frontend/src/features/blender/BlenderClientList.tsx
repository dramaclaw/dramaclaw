// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Monitor } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { confirmDialog } from "@/components/confirm-dialog-host";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { BlenderAddonDownloadLink } from "@/features/blender/BlenderAddonDownloadLink";
import { BLENDER_PAGE_CARD } from "@/features/blender/styles";
import {
  listBlenderClients,
  revokeBlenderClient,
  type BlenderClient,
} from "@/features/blender/api";

/**
 * 已连接的 Blender，带吊销。
 *
 * 渲染在配对页上，**不是**设置弹窗——设置弹窗只在 CE 运行时渲染
 * （header.tsx 的 `{ceRuntime ? <SettingsDialog/> : null}`），放那儿等于 EE 用户
 * 永远断不开插件。
 */
export function BlenderClientList() {
  const { t } = useTranslation();
  const [clients, setClients] = useState<BlenderClient[] | null>(null);

  const reload = useCallback(async () => {
    try {
      setClients(await listBlenderClients());
    } catch {
      // 列不出来就当空的。这是配对页的附属区块，不该因为它失败就挡住配对。
      setClients([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function revoke(client: BlenderClient) {
    // 不可撤销：断开后那台机器上的插件必须重新配对。
    const confirmed = await confirmDialog({
      title: t("blender.clients.revokeTitle"),
      description: t("blender.clients.revokeBody"),
      confirmText: t("blender.clients.revoke"),
    });
    if (!confirmed) return;
    await revokeBlenderClient(client.token_id);
    toast.success(t("blender.clients.revoked"));
    await reload();
  }

  return (
    <Card className={BLENDER_PAGE_CARD}>
      <CardHeader>
        <CardTitle>
          <h2>{t("blender.clients.title")}</h2>
        </CardTitle>
        {clients?.length ? (
          <CardAction>
            <Badge variant="secondary" className="bg-muted text-muted-foreground">{clients.length}</Badge>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {clients === null ? (
          <Skeleton className="h-12 bg-surface" />
        ) : clients.length === 0 ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">{t("blender.clients.empty")}</p>
            <BlenderAddonDownloadLink />
          </div>
        ) : (
          <ul className="flex flex-col">
            {clients.map((client, index) => (
              // ul 的直接子元素只能是 li，分隔线放进 li 里。
              <li key={client.token_id}>
                {index > 0 ? <Separator className="my-1 bg-[var(--ui-border-soft)]" /> : null}
                <div className="flex items-center gap-3 py-2">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface text-muted-foreground">
                    <Monitor className="size-4" aria-hidden="true" />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{client.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {client.last_seen
                        ? t("blender.clients.lastSeen", {
                            when: new Date(client.last_seen * 1000).toLocaleString(),
                          })
                        : t("blender.clients.neverUsed")}
                    </span>
                  </div>
                  {/* 安静按钮：红色只在 hover 时出现，别跟上面的提交按钮抢眼。 */}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="rounded-full text-muted-foreground hover:text-destructive"
                    onClick={() => void revoke(client)}
                  >
                    {t("blender.clients.revoke")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
