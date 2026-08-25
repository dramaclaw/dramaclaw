// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMemo, useState } from "react";
import { Copy, Loader2, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useAddProjectGrant,
  useDeleteProjectGrant,
  useProjectGrants,
  useUpdateProjectGrant,
  useUserSearch,
  type ProjectGrant,
  type UserSearchResult,
} from "@/lib/queries/projects";
import { projectRoleLabel } from "@/lib/project-permissions";
import { isCeRuntime } from "@/lib/runtime-config";
import { cn } from "@/lib/utils";
import type { ProjectRole, ProjectSummary } from "@/types/project";

type GrantRole = Exclude<ProjectRole, "owner">;

const GRANT_ROLES: GrantRole[] = ["viewer", "editor", "admin"];

function grantDisplayName(grant: ProjectGrant): string {
  return grant.principal_username || grant.principal_id;
}

function grantIsEffective(grant: ProjectGrant): boolean {
  return grant.effective !== false;
}

function roleCaption(role: GrantRole, t: (key: string) => string): string {
  switch (role) {
    case "viewer":
      return t("project.shareDialog.roleViewer");
    case "editor":
      return t("project.shareDialog.roleEditor");
    case "admin":
      return t("project.shareDialog.roleAdmin");
  }
}

function projectLink(project: ProjectSummary): string {
  if (typeof window === "undefined") return `/projects/${project.id}/ingest`;
  return `${window.location.origin}/projects/${project.id}/ingest`;
}

export function ShareProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: ProjectSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [selectedUser, setSelectedUser] = useState<UserSearchResult | null>(null);
  const [role, setRole] = useState<GrantRole>("editor");
  const projectId = project?.id ?? "";
  const grants = useProjectGrants(projectId, open && Boolean(projectId));
  const users = useUserSearch(projectId, query);
  const addGrant = useAddProjectGrant(projectId);
  const updateGrant = useUpdateProjectGrant(projectId);
  const deleteGrant = useDeleteProjectGrant(projectId);

  const searchResults = users.data?.data ?? [];
  const grantRows = grants.data?.data ?? [];
  const existingPrincipalIds = useMemo(
    () => new Set(grantRows.map((grant) => grant.principal_id)),
    [grantRows],
  );

  const handleAdd = async () => {
    const username = selectedUser?.username || query.trim();
    if (!username || username.length < 3) return;
    try {
      await addGrant.mutateAsync({ principal_username: username, role });
      toast.success(t("project.shareDialog.toastMemberUpdated"));
      setQuery("");
      setSelectedUser(null);
      setRole("editor");
    } catch {
      toast.error(t("project.shareDialog.toastShareFailed"));
    }
  };

  const handleCopyLink = async () => {
    if (!project) return;
    try {
      await navigator.clipboard.writeText(projectLink(project));
      toast.success(t("project.shareDialog.toastLinkCopied"));
    } catch {
      toast.error(t("project.shareDialog.toastCopyFailed"));
    }
  };

  const handleRoleChange = async (grant: ProjectGrant, nextRole: GrantRole) => {
    if (grant.role === nextRole) return;
    try {
      await updateGrant.mutateAsync({ grantId: grant.id, role: nextRole });
      toast.success(t("project.shareDialog.toastPermissionUpdated"));
    } catch {
      toast.error(t("project.shareDialog.toastPermissionUpdateFailed"));
    }
  };

  const handleRevoke = async (grant: ProjectGrant) => {
    try {
      await deleteGrant.mutateAsync(grant.id);
      toast.success(t("project.shareDialog.toastMemberRemoved"));
    } catch {
      toast.error(t("project.shareDialog.toastRemoveFailed"));
    }
  };

  // EE-only 入口：CE 运行时直接不渲染（防御性兜底，主门控在 canManageProjectGrants）。
  // 守卫放在所有 hooks 之后，避免违反 Rules of Hooks。
  if (isCeRuntime()) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(42rem,calc(100vh-2rem))] flex-col overflow-hidden rounded-[16px] border border-white/8 bg-background/82 p-0 shadow-2xl backdrop-blur-3xl sm:max-w-2xl">
        <DialogHeader className="px-6 pb-2 pt-5">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Users className="size-5 text-primary" />
            {t("project.shareDialog.title")}
          </DialogTitle>
          <DialogDescription>
            {project
              ? t("project.shareDialog.descriptionWithOwner", {
                  name: project.name,
                  owner: project.ownerUsername || t("project.shareDialog.currentUserFallback"),
                })
              : t("project.shareDialog.descriptionFallback")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto px-6 pb-5 pt-2">
          <section className="rounded-[12px] border border-border/70 bg-card/45 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-foreground">{t("project.shareDialog.addMember")}</div>
                <div className="mt-1 text-xs text-muted-foreground">{t("project.shareDialog.addMemberHint")}</div>
              </div>
              <Button variant="outline" size="sm" onClick={handleCopyLink} disabled={!project}>
                <Copy className="size-3.5" />
                {t("project.shareDialog.copyLink")}
              </Button>
            </div>
            <div className="grid gap-3 md:grid-cols-[1fr_9rem_auto]">
              <div className="relative">
                <Input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setSelectedUser(null);
                  }}
                  placeholder={t("project.shareDialog.searchPlaceholder")}
                  className="h-9 rounded-[8px] focus-visible:ring-1"
                />
                {query.trim().length >= 3 && searchResults.length > 0 && !selectedUser && (
                  <div className="absolute left-0 right-0 top-10 z-10 rounded-[8px] border border-border bg-popover p-1 shadow-xl">
                    {searchResults.map((user) => {
                      const disabled = existingPrincipalIds.has(user.id) || user.id === project?.ownerId;
                      return (
                        <button
                          key={user.id}
                          type="button"
                          disabled={disabled}
                          onClick={() => {
                            setSelectedUser(user);
                            setQuery(user.username);
                          }}
                          className={cn(
                            "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45",
                          )}
                        >
                          <span>{user.username}</span>
                          {disabled && <span className="text-xs text-muted-foreground">{t("project.shareDialog.alreadyInProject")}</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <Select value={role} onValueChange={(value) => setRole(value as GrantRole)}>
                <SelectTrigger className="h-9 w-full rounded-[8px]">
                  <SelectValue>
                    {(value: string) => projectRoleLabel(value as ProjectRole)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  {GRANT_ROLES.map((item) => (
                    <SelectItem key={item} value={item}>
                      {projectRoleLabel(item)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={handleAdd} disabled={addGrant.isPending || query.trim().length < 3}>
                {addGrant.isPending ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}
                {t("project.shareDialog.add")}
              </Button>
            </div>
          </section>

          <section className="rounded-[12px] border border-border/70 bg-card/45 p-4">
            <div className="mb-3 text-sm font-medium text-foreground">{t("project.shareDialog.members")}</div>
            <div className="space-y-2">
              {project && (
                <div className="flex items-center gap-3 rounded-[10px] border border-border/60 bg-background/45 px-3 py-2.5">
                  <ShieldCheck className="size-4 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{project.ownerUsername || t("project.shareDialog.owner")}</div>
                    <div className="text-xs text-muted-foreground">{t("project.shareDialog.projectOwner")}</div>
                  </div>
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">{t("project.shareDialog.owner")}</span>
                </div>
              )}
              {grants.isLoading && (
                <div className="flex items-center gap-2 rounded-[10px] border border-border/60 bg-background/45 px-3 py-3 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {t("project.shareDialog.loadingMembers")}
                </div>
              )}
              {!grants.isLoading && grantRows.map((grant) => {
                const effective = grantIsEffective(grant);
                return (
                  <div key={grant.id} className="flex items-center gap-3 rounded-[10px] border border-border/60 bg-background/45 px-3 py-2.5">
                    <Users className="size-4 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{grantDisplayName(grant)}</div>
                      <div className="text-xs text-muted-foreground">
                        {effective
                          ? roleCaption(grant.role, t)
                          : t("project.shareDialog.inactiveScopeChanged")}
                      </div>
                    </div>
                    {!effective ? (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {t("project.shareDialog.inactive")}
                      </span>
                    ) : null}
                    <Select
                      value={grant.role}
                      onValueChange={(value) => void handleRoleChange(grant, value as GrantRole)}
                      disabled={!effective || updateGrant.isPending}
                    >
                      <SelectTrigger size="sm" className="w-24 rounded-[8px]">
                        <SelectValue>
                          {(value: string) => projectRoleLabel(value as ProjectRole)}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent alignItemWithTrigger={false}>
                        {GRANT_ROLES.map((item) => (
                          <SelectItem key={item} value={item}>
                            {projectRoleLabel(item)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => void handleRevoke(grant)}
                      disabled={deleteGrant.isPending}
                      aria-label={t("project.shareDialog.removeMember")}
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
