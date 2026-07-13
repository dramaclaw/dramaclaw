// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMemo, useState } from "react";
import { Copy, Loader2, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
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

function roleCaption(role: GrantRole): string {
  switch (role) {
    case "viewer":
      return "只读查看";
    case "editor":
      return "可编辑与运行任务";
    case "admin":
      return "可管理共享成员";
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
  const [query, setQuery] = useState("");
  const [selectedUser, setSelectedUser] = useState<UserSearchResult | null>(null);
  const [role, setRole] = useState<GrantRole>("editor");
  const projectId = project?.id ?? "";
  const grants = useProjectGrants(projectId, open && Boolean(projectId));
  const users = useUserSearch(query);
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
      toast.success("已更新共享成员");
      setQuery("");
      setSelectedUser(null);
      setRole("editor");
    } catch {
      toast.error("共享失败，请确认用户存在且你有权限");
    }
  };

  const handleCopyLink = async () => {
    if (!project) return;
    try {
      await navigator.clipboard.writeText(projectLink(project));
      toast.success("项目链接已复制");
    } catch {
      toast.error("复制失败");
    }
  };

  const handleRoleChange = async (grant: ProjectGrant, nextRole: GrantRole) => {
    if (grant.role === nextRole) return;
    try {
      await updateGrant.mutateAsync({ grantId: grant.id, role: nextRole });
      toast.success("权限已更新");
    } catch {
      toast.error("更新权限失败");
    }
  };

  const handleRevoke = async (grant: ProjectGrant) => {
    try {
      await deleteGrant.mutateAsync(grant.id);
      toast.success("已移除共享成员");
    } catch {
      toast.error("移除失败");
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
            共享项目
          </DialogTitle>
          <DialogDescription>
            {project ? `${project.name} · ${project.ownerUsername || "当前用户"}` : "管理项目成员"}
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto px-6 pb-5 pt-2">
          <section className="rounded-[12px] border border-border/70 bg-card/45 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-foreground">添加成员</div>
                <div className="mt-1 text-xs text-muted-foreground">输入用户名，选择权限后加入项目。</div>
              </div>
              <Button variant="outline" size="sm" onClick={handleCopyLink} disabled={!project}>
                <Copy className="size-3.5" />
                复制链接
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
                  placeholder="搜索用户名"
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
                          {disabled && <span className="text-xs text-muted-foreground">已在项目中</span>}
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
                添加
              </Button>
            </div>
          </section>

          <section className="rounded-[12px] border border-border/70 bg-card/45 p-4">
            <div className="mb-3 text-sm font-medium text-foreground">成员</div>
            <div className="space-y-2">
              {project && (
                <div className="flex items-center gap-3 rounded-[10px] border border-border/60 bg-background/45 px-3 py-2.5">
                  <ShieldCheck className="size-4 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{project.ownerUsername || "所有者"}</div>
                    <div className="text-xs text-muted-foreground">项目所有者</div>
                  </div>
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">所有者</span>
                </div>
              )}
              {grants.isLoading && (
                <div className="flex items-center gap-2 rounded-[10px] border border-border/60 bg-background/45 px-3 py-3 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  加载成员
                </div>
              )}
              {!grants.isLoading && grantRows.map((grant) => (
                <div key={grant.id} className="flex items-center gap-3 rounded-[10px] border border-border/60 bg-background/45 px-3 py-2.5">
                  <Users className="size-4 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{grantDisplayName(grant)}</div>
                    <div className="text-xs text-muted-foreground">{roleCaption(grant.role)}</div>
                  </div>
                  <Select
                    value={grant.role}
                    onValueChange={(value) => void handleRoleChange(grant, value as GrantRole)}
                    disabled={updateGrant.isPending}
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
                    aria-label="移除成员"
                  >
                    <Trash2 className="size-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
