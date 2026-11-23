// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AlertTriangle, Copy, Loader2 } from "lucide-react";

import {
  AGENT_KEY_LABEL_MAX_LENGTH,
  createAgentKey,
  listAgentKeys,
  revokeAgentKey,
  type AgentKeySummary,
} from "@/api/agentKeys";
import { listSupertaleProjects, type SupertaleProjectSummary } from "@/api/projects";
import { confirmDialog } from "@/components/confirm-dialog-host";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { backendErrorToastMessage } from "@/lib/api-errors";

const AGENT_KEYS_QUERY_KEY = ["agent-keys", "list"] as const;
const AGENT_KEY_PROJECTS_QUERY_KEY = ["agent-keys", "projects"] as const;
const AUTH_HEADER_EXAMPLE = "Authorization: Bearer <key>";
// The web server forwards /mcp to the API, so this site's address is the MCP address.
const mcpUrl = (path: string) => `${window.location.origin}${path}`;

type ProjectScope = "selected" | "all";
type AgentKeyStatus = "active" | "revoked" | "expired";

/** Revealed plaintext key. Lives only in component state, never in a shared cache. */
interface RevealedKey {
  label: string;
  value: string;
}

function agentKeyStatus(key: AgentKeySummary, now: number): AgentKeyStatus {
  if (key.revoked_at) return "revoked";
  if (key.expires_at && Date.parse(key.expires_at) <= now) return "expired";
  return "active";
}

function projectName(project: SupertaleProjectSummary): string {
  return project.display_name || project.name || project.id;
}

export function AgentKeySettings({ open }: { open: boolean }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const formId = useId();
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<ProjectScope>("selected");
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<RevealedKey | null>(null);

  const keysQuery = useQuery({
    queryKey: AGENT_KEYS_QUERY_KEY,
    queryFn: listAgentKeys,
    enabled: open,
  });
  const projectsQuery = useQuery({
    queryKey: AGENT_KEY_PROJECTS_QUERY_KEY,
    queryFn: listSupertaleProjects,
    enabled: open,
  });

  // Drop the one-time key as soon as the settings dialog closes.
  useEffect(() => {
    if (!open) setRevealed(null);
  }, [open]);

  const projectNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const project of projectsQuery.data ?? []) names.set(project.id, projectName(project));
    return names;
  }, [projectsQuery.data]);

  const trimmedLabel = label.trim();
  const canSubmit =
    !creating &&
    trimmedLabel.length > 0 &&
    trimmedLabel.length <= AGENT_KEY_LABEL_MAX_LENGTH &&
    (scope === "all" || selectedProjects.length > 0);

  const errorMessage = (error: unknown) => backendErrorToastMessage(error, t);
  const formatTime = (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(i18n.language);
  };

  const refreshKeys = () => queryClient.invalidateQueries({ queryKey: AGENT_KEYS_QUERY_KEY });

  const toggleProject = (projectId: string, checked: boolean) => {
    setSelectedProjects((current) =>
      checked
        ? current.includes(projectId) ? current : [...current, projectId]
        : current.filter((id) => id !== projectId),
    );
  };

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setCreating(true);
    try {
      const created = await createAgentKey({
        label: trimmedLabel,
        allowedProjects: scope === "all" ? [] : selectedProjects,
      });
      setRevealed({ label: created.label, value: created.key });
      setLabel("");
      setSelectedProjects([]);
      setScope("selected");
      toast.success(t("settings.agentKeys.create.created"));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setCreating(false);
      void refreshKeys();
    }
  };

  const handleCopy = async () => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.value);
      toast.success(t("settings.agentKeys.reveal.copied"));
    } catch {
      toast.error(t("settings.agentKeys.reveal.copyFailed"));
    }
  };

  const handleRevoke = async (key: AgentKeySummary) => {
    const confirmed = await confirmDialog({
      title: t("settings.agentKeys.revoke.confirmTitle"),
      description: t("settings.agentKeys.revoke.confirmDescription", { label: key.label }),
      confirmText: t("settings.agentKeys.revoke.confirm"),
      cancelText: t("settings.agentKeys.revoke.cancel"),
      confirmVariant: "destructive",
    });
    if (!confirmed) return;
    setRevokingId(key.id);
    try {
      await revokeAgentKey(key.id);
      toast.success(t("settings.agentKeys.revoke.done"));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRevokingId(null);
      // The list is the source of truth whether or not the revoke succeeded.
      void refreshKeys();
    }
  };

  const now = Date.now();
  const keys = keysQuery.data ?? [];

  return (
    <div className="flex flex-col gap-6 px-5 py-5">
      <section>
        <h2 className="font-heading text-sm font-medium">{t("settings.agentKeys.title")}</h2>
        <p className="mt-2 max-w-[640px] text-xs leading-5 text-muted-foreground">
          {t("settings.agentKeys.intro")}
        </p>
      </section>

      {revealed ? (
        <section
          aria-label={t("settings.agentKeys.reveal.title")}
          className="flex flex-col gap-3 rounded-lg border border-amber-400/40 bg-amber-400/[0.06] p-4"
        >
          <h3 className="text-sm font-medium">{t("settings.agentKeys.reveal.title")}</h3>
          <div className="flex items-center gap-2">
            <Input
              id={`${formId}-revealed`}
              aria-label={t("settings.agentKeys.reveal.keyLabel")}
              readOnly
              value={revealed.value}
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-xs"
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button type="button" variant="outline" size="sm" onClick={() => void handleCopy()}>
              <Copy className="size-3.5" aria-hidden />
              {t("settings.agentKeys.reveal.copy")}
            </Button>
          </div>
          <p className="flex items-start gap-2 text-xs text-amber-300">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{t("settings.agentKeys.reveal.warning")}</span>
          </p>
          <p className="text-xs leading-5 text-muted-foreground">
            <UsageHint
              template={t("settings.agentKeys.reveal.usage", {
                // Keep the placeholders so they can be rendered as inline code below.
                header: "{{header}}",
                tools: "{{tools}}",
                workflows: "{{workflows}}",
              })}
            />
          </p>
          <div>
            <Button type="button" size="sm" onClick={() => setRevealed(null)}>
              {t("settings.agentKeys.reveal.done")}
            </Button>
          </div>
        </section>
      ) : null}

      <form
        onSubmit={(event) => void handleCreate(event)}
        className="flex max-w-[640px] flex-col gap-4 rounded-lg border border-border p-4"
      >
        <h3 className="text-sm font-medium">{t("settings.agentKeys.create.title")}</h3>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${formId}-label`}>{t("settings.agentKeys.create.label")}</Label>
          <Input
            id={`${formId}-label`}
            value={label}
            maxLength={AGENT_KEY_LABEL_MAX_LENGTH}
            placeholder={t("settings.agentKeys.create.labelPlaceholder")}
            autoComplete="off"
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">{t("settings.agentKeys.create.scope")}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`${formId}-scope`}
              value="selected"
              checked={scope === "selected"}
              onChange={() => setScope("selected")}
            />
            {t("settings.agentKeys.create.scopeSelected")}
          </label>
          {scope === "selected" ? (
            <div className="ml-6 flex max-h-48 flex-col gap-2 overflow-y-auto">
              {projectsQuery.isLoading ? (
                <p className="text-xs text-muted-foreground">{t("settings.agentKeys.create.projectsLoading")}</p>
              ) : projectsQuery.isError ? (
                <p className="text-xs text-destructive">{t("settings.agentKeys.create.projectsError")}</p>
              ) : (projectsQuery.data ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("settings.agentKeys.create.noProjects")}</p>
              ) : (
                (projectsQuery.data ?? []).map((project) => {
                  const name = projectName(project);
                  return (
                    <label key={project.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={selectedProjects.includes(project.id)}
                        onCheckedChange={(checked) => toggleProject(project.id, checked === true)}
                      />
                      <span className="min-w-0 truncate">{name}</span>
                    </label>
                  );
                })
              )}
              {selectedProjects.length === 0 && (projectsQuery.data ?? []).length > 0 ? (
                <p className="text-xs text-muted-foreground">{t("settings.agentKeys.create.selectProject")}</p>
              ) : null}
            </div>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`${formId}-scope`}
              value="all"
              checked={scope === "all"}
              onChange={() => setScope("all")}
            />
            {t("settings.agentKeys.create.scopeAll")}
          </label>
          {scope === "all" ? (
            <p className="ml-6 flex items-start gap-2 text-xs text-amber-300">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{t("settings.agentKeys.create.allWarning")}</span>
            </p>
          ) : null}
        </fieldset>

        <div>
          <Button type="submit" size="sm" disabled={!canSubmit}>
            {creating ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            {t("settings.agentKeys.create.submit")}
          </Button>
        </div>
      </form>

      <section className="flex max-w-[640px] flex-col gap-3">
        <h3 className="text-sm font-medium">{t("settings.agentKeys.list.title")}</h3>
        {keysQuery.isLoading ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            {t("settings.agentKeys.list.loading")}
          </p>
        ) : keysQuery.isError ? (
          <div className="flex items-center gap-3 text-xs">
            <span className="text-destructive">{errorMessage(keysQuery.error)}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void keysQuery.refetch()}>
              {t("settings.agentKeys.list.retry")}
            </Button>
          </div>
        ) : keys.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("settings.agentKeys.list.empty")}</p>
        ) : (
          <ul aria-label={t("settings.agentKeys.list.title")} className="flex flex-col gap-2">
            {keys.map((key) => {
              const status = agentKeyStatus(key, now);
              const scopeText =
                key.allowed_projects.length === 0
                  ? t("settings.agentKeys.list.allProjects")
                  : t("settings.agentKeys.list.projects", {
                      names: key.allowed_projects.map((id) => projectNames.get(id) ?? id).join(", "),
                    });
              return (
                <li key={key.id} className="flex items-start gap-3 rounded-lg border border-border p-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium">{key.label}</span>
                      <Badge
                        variant={status === "active" ? "secondary" : status === "revoked" ? "destructive" : "outline"}
                      >
                        {t(`settings.agentKeys.status.${status}`)}
                      </Badge>
                    </div>
                    <span className="text-xs text-muted-foreground">{scopeText}</span>
                    <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                      <span>{t("settings.agentKeys.list.created", { time: formatTime(key.created_at) })}</span>
                      <span>
                        {key.last_used_at
                          ? t("settings.agentKeys.list.lastUsed", { time: formatTime(key.last_used_at) })
                          : t("settings.agentKeys.list.neverUsed")}
                      </span>
                      {key.expires_at ? (
                        <span>{t("settings.agentKeys.list.expires", { time: formatTime(key.expires_at) })}</span>
                      ) : null}
                    </span>
                  </div>
                  {status === "active" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={t("settings.agentKeys.revoke.aria", { label: key.label })}
                      disabled={revokingId === key.id}
                      onClick={() => void handleRevoke(key)}
                    >
                      {t("settings.agentKeys.revoke.button")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Renders the usage sentence with the header and MCP paths as inline code. */
function UsageHint({ template }: { template: string }) {
  const tokens: Record<string, string> = {
    header: AUTH_HEADER_EXAMPLE,
    tools: mcpUrl("/mcp/tools"),
    workflows: mcpUrl("/mcp/workflows"),
  };
  const parts = template.split(/(\{\{\w+\}\})/g);
  return (
    <>
      {parts.map((part, index) => {
        const match = /^\{\{(\w+)\}\}$/.exec(part);
        const value = match ? tokens[match[1]] : undefined;
        return value ? (
          <code key={index} className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[11px] text-foreground">
            {value}
          </code>
        ) : (
          <span key={index}>{part}</span>
        );
      })}
    </>
  );
}
