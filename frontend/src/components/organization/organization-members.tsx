// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, RefreshCw, UserPlus, UsersRound } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { queryKeys } from "@/lib/query-keys";
import {
  addOrgMember,
  addOrgMembersBatch,
  OrgApiError,
  useOrgMe,
  useOrgMembers,
  usePatchOrgMember,
} from "@/lib/queries/org";
import type {
  BatchMemberResultItem,
  Member,
  MemberListParams,
  MembershipStatus,
  OrgRole,
} from "@/types/org";
import {
  parseBatchMemberInput,
  safeBatchResultCode,
  safeBatchResultStatus,
  safeOrgErrorKey,
} from "@/components/organization/member-input";

const DEFAULT_LIMIT = 20;

type PendingChange = {
  member: Member;
  role?: OrgRole;
  membershipStatus?: MembershipStatus;
  highRisk: boolean;
};

export interface OrganizationMembersProps {
  params: MemberListParams;
  onParamsChange: (params: MemberListParams) => void;
  onForbidden: () => void;
}

function nextIdempotencyKey(prefix: "member" | "batch"): string {
  const value =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${value}`;
}

function hasSafeManageCapability(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  const organization = data.organization as Record<string, unknown> | null;
  const membership = data.membership as Record<string, unknown> | null;
  const capabilities = data.capabilities as Record<string, unknown> | null;
  return Boolean(
    organization &&
      membership &&
      capabilities &&
      typeof organization.org_id === "string" &&
      organization.org_id.trim().length > 0 &&
      organization.status === "active" &&
      typeof organization.updated_at === "string" &&
      organization.updated_at.trim().length > 0 &&
      membership.role === "org_admin" &&
      membership.membership_status === "active" &&
      typeof membership.updated_at === "string" &&
      membership.updated_at.trim().length > 0 &&
      capabilities.manage_members === true,
  );
}

function isSafeMemberSnapshot(value: unknown): value is Member {
  if (!value || typeof value !== "object") return false;
  const member = value as Record<string, unknown>;
  return (
    typeof member.user_id === "string" &&
    member.user_id.trim().length > 0 &&
    typeof member.username === "string" &&
    member.username.trim().length > 0 &&
    (member.role === "org_admin" || member.role === "org_member") &&
    (member.membership_status === "active" ||
      member.membership_status === "suspended" ||
      member.membership_status === "left") &&
    (member.model_billing_entitlement === "platform" ||
      member.model_billing_entitlement === "org_sponsored" ||
      member.model_billing_entitlement === "disabled") &&
    typeof member.updated_at === "string" &&
    member.updated_at.trim().length > 0
  );
}

export function OrganizationMembers(props: OrganizationMembersProps) {
  const { t } = useTranslation();
  const orgMe = useOrgMe();
  const denied = !orgMe.isPending && !hasSafeManageCapability(orgMe.data);
  const reported = useRef(false);

  useEffect(() => {
    if (!denied || reported.current) return;
    reported.current = true;
    props.onForbidden();
  }, [denied, props]);

  if (orgMe.isPending || orgMe.isFetching) {
    return (
      <section role="status" aria-label={t("organization.members.loading")}>
        <Skeleton className="h-72 w-full" />
      </section>
    );
  }
  if (orgMe.isError || denied) {
    return (
      <section role="status" className="rounded-xl border p-6 text-sm text-muted-foreground">
        {t("organization.members.returning")}
      </section>
    );
  }
  return <OrganizationMembersList {...props} />;
}

function OrganizationMembersList({
  params,
  onParamsChange,
  onForbidden,
}: OrganizationMembersProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const safeParams = useMemo(
    () => ({
      ...params,
      limit: params.limit ?? DEFAULT_LIMIT,
      offset: params.offset ?? 0,
    }),
    [params],
  );
  const members = useOrgMembers(safeParams);
  const handledForbidden = useRef(false);
  const [singleOpen, setSingleOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const memberSnapshotsAreSafe = Boolean(
    members.data?.items.every(isSafeMemberSnapshot),
  );

  useEffect(() => {
    const error = members.error instanceof OrgApiError ? members.error : null;
    if (handledForbidden.current || error?.status !== 403) return;
    handledForbidden.current = true;
    void queryClient.cancelQueries({ queryKey: queryKeys.org() }).then(() => {
      queryClient.removeQueries({ queryKey: queryKeys.org() });
      onForbidden();
    });
  }, [members.error, onForbidden, queryClient]);

  useEffect(() => {
    if (!members.data || (memberSnapshotsAreSafe && !members.isFetching)) return;
    setSingleOpen(false);
    setBatchOpen(false);
    setPendingChange(null);
  }, [memberSnapshotsAreSafe, members.data, members.isFetching]);

  if (members.isPending) {
    return (
      <section
        role="status"
        aria-label={t("organization.members.loading")}
        className="space-y-4"
      >
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-72 w-full" />
      </section>
    );
  }
  if (members.isError) {
    if (members.error instanceof OrgApiError && members.error.status === 403) {
      return <p role="status">{t("organization.members.returning")}</p>;
    }
    return (
      <section className="mx-auto flex max-w-xl flex-col items-start gap-4 rounded-xl border p-6">
        <h1>{t("organization.members.title")}</h1>
        <p role="alert">{t(safeOrgErrorKey((members.error as OrgApiError).code))}</p>
        <Button type="button" variant="outline" onClick={() => members.refetch()}>
          <RefreshCw className="size-4" />
          {t("organization.retry")}
        </Button>
      </section>
    );
  }

  const page = members.data;
  const offset = safeParams.offset;
  const limit = safeParams.limit;
  const activeAdminCount = page.items.filter(
    (item) =>
      isSafeMemberSnapshot(item) &&
      item.role === "org_admin" &&
      item.membership_status === "active",
  ).length;
  const changeFilter = (change: Partial<MemberListParams>) =>
    onParamsChange({ ...safeParams, ...change, offset: 0 });

  return (
    <section className="mx-auto max-w-7xl space-y-5" aria-busy={members.isFetching}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <UsersRound className="size-6" />
            {t("organization.members.title")}
          </h1>
          <p>{t("organization.members.total", { count: page.total })}</p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!memberSnapshotsAreSafe || members.isFetching}
            onClick={() => setBatchOpen(true)}
          >
            {t("organization.members.batch")}
          </Button>
          <Button
            type="button"
            disabled={!memberSnapshotsAreSafe || members.isFetching}
            onClick={() => setSingleOpen(true)}
          >
            <UserPlus className="size-4" />
            {t("organization.members.add")}
          </Button>
        </div>
      </header>
      {message ? <p role="status">{message}</p> : null}
      <label className="block">
        {t("organization.members.search")}
        <Input
          aria-label={t("organization.members.search")}
          value={safeParams.q ?? ""}
          onChange={(event) => changeFilter({ q: event.target.value || undefined })}
        />
      </label>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <caption className="sr-only">{t("organization.members.title")}</caption>
          <thead>
            <tr>
              <th>{t("organization.fields.user")}</th>
              <th>{t("organization.fields.role")}</th>
              <th>{t("organization.fields.status")}</th>
              <th>{t("organization.fields.entitlement")}</th>
              <th>{t("organization.fields.updated")}</th>
              <th>{t("organization.members.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((item, index) => (
              <MemberRow
                key={item.user_id || `invalid-member-${index}`}
                member={item}
                lastActiveAdmin={
                  activeAdminCount === 1 &&
                  item.role === "org_admin" &&
                  item.membership_status === "active"
                }
                language={i18n.language}
                refreshing={members.isFetching || !memberSnapshotsAreSafe}
                onChange={setPendingChange}
              />
            ))}
          </tbody>
        </table>
      </div>
      {page.items.length === 0 ? (
        <p>{t("organization.members.filteredEmpty")}</p>
      ) : null}
      <nav className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={offset === 0}
          onClick={() =>
            onParamsChange({ ...safeParams, offset: Math.max(0, offset - limit) })
          }
        >
          {t("organization.members.previous")}
        </Button>
        <Button
          type="button"
          variant="outline"
          aria-label={t("organization.members.next")}
          disabled={offset + limit >= page.total}
          onClick={() =>
            onParamsChange({ ...safeParams, offset: offset + limit })
          }
        >
          {t("organization.members.next")}
        </Button>
      </nav>
      <SingleMemberDialog
        open={memberSnapshotsAreSafe && singleOpen}
        writeAllowed={memberSnapshotsAreSafe && !members.isFetching}
        onOpenChange={setSingleOpen}
        onMessage={setMessage}
      />
      <BatchMemberDialog
        open={memberSnapshotsAreSafe && batchOpen}
        writeAllowed={memberSnapshotsAreSafe && !members.isFetching}
        onOpenChange={setBatchOpen}
        onMessage={setMessage}
      />
      <MemberChangeDialog
        change={memberSnapshotsAreSafe && !members.isFetching ? pendingChange : null}
        writeAllowed={memberSnapshotsAreSafe && !members.isFetching}
        onChange={setPendingChange}
        onMessage={setMessage}
        onRefresh={() => members.refetch()}
      />
    </section>
  );
}

function MemberRow({
  member,
  lastActiveAdmin,
  language,
  refreshing,
  onChange,
}: {
  member: Member;
  lastActiveAdmin: boolean;
  language: string;
  refreshing: boolean;
  onChange: (change: PendingChange) => void;
}) {
  const { t } = useTranslation();
  const editable = !refreshing && Boolean(member.updated_at);
  return (
    <tr className="border-t">
      <td><div>{member.username}</div><small>{member.user_id}</small></td>
      <td>{labelRole(member.role, t)}</td>
      <td>{labelStatus(member.membership_status, t)}</td>
      <td>{labelEntitlement(member.model_billing_entitlement, t)}</td>
      <td>
        <time dateTime={member.updated_at ?? undefined}>
          {formatDate(member.updated_at, language)}
        </time>
      </td>
      <td>
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={!editable}
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={
                  editable
                    ? t("organization.members.change")
                    : t("organization.members.refreshBeforeEdit")
                }
              />
            }
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {lastActiveAdmin ? (
              <p className="max-w-56 px-2 py-1.5 text-xs text-muted-foreground">
                {t("organization.members.lastAdminProtected")}
              </p>
            ) : null}
            {member.role === "org_member" ? (
              <DropdownMenuItem
                onClick={() =>
                  onChange({ member, role: "org_admin", highRisk: false })
                }
              >
                {t("organization.members.action.promote")}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                disabled={lastActiveAdmin}
                onClick={() =>
                  onChange({ member, role: "org_member", highRisk: true })
                }
              >
                {t("organization.members.action.demote")}
              </DropdownMenuItem>
            )}
            {member.membership_status === "active" ? (
              <DropdownMenuItem
                disabled={lastActiveAdmin}
                onClick={() =>
                  onChange({
                    member,
                    membershipStatus: "suspended",
                    highRisk: true,
                  })
                }
              >
                {t("organization.members.action.suspend")}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                onClick={() =>
                  onChange({
                    member,
                    membershipStatus: "active",
                    highRisk: false,
                  })
                }
              >
                {t("organization.members.action.restore")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              variant="destructive"
              disabled={lastActiveAdmin}
              onClick={() =>
                onChange({ member, membershipStatus: "left", highRisk: true })
              }
            >
              {t("organization.members.action.remove")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
    </tr>
  );
}

function SingleMemberDialog({
  open,
  writeAllowed,
  onOpenChange,
  onMessage,
}: {
  open: boolean;
  writeAllowed: boolean;
  onOpenChange: (open: boolean) => void;
  onMessage: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const keyRef = useRef<string | null>(null);
  const [mode, setMode] = useState<"existing" | "create">("existing");
  const [userId, setUserId] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reset = () => {
    setMode("existing");
    setUserId("");
    setUsername("");
    setPassword("");
    setError(null);
    keyRef.current = null;
  };
  const changeOpen = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };
  const changeMode = (next: string | number) => {
    setMode(next === "create" ? "create" : "existing");
    setUserId("");
    setUsername("");
    setPassword("");
    setError(null);
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!writeAllowed) return;
    keyRef.current ??= nextIdempotencyKey("member");
    const body =
      mode === "existing"
        ? ({ mode, user_id: userId.trim() } as const)
        : ({ mode, username: username.trim(), password } as const);
    setPassword("");
    setPending(true);
    setError(null);
    try {
      await addOrgMember({ body, idempotencyKey: keyRef.current });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.orgMe() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.orgMembers() }),
      ]);
      onMessage(t("organization.members.added"));
      changeOpen(false);
    } catch (caught) {
      const apiError = caught instanceof OrgApiError ? caught : null;
      setError(t(safeOrgErrorKey(apiError?.code)));
    } finally {
      setPassword("");
      keyRef.current = null;
      setPending(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("organization.members.add")}</DialogTitle>
          <DialogDescription>{t("organization.members.addDescription")}</DialogDescription>
        </DialogHeader>
        <Tabs value={mode} onValueChange={changeMode}>
          <TabsList>
            <TabsTrigger value="existing">{t("organization.members.existing")}</TabsTrigger>
            <TabsTrigger value="create">{t("organization.members.create")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <form onSubmit={submit}>
          {mode === "existing" ? (
            <>
              <Label htmlFor="org-user-id">{t("organization.members.userId")}</Label>
              <Input
                id="org-user-id"
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
                required
              />
            </>
          ) : (
            <>
              <Label htmlFor="org-username">{t("organization.members.username")}</Label>
              <Input
                id="org-username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                minLength={3}
                required
              />
              <Label htmlFor="org-password">{t("organization.members.password")}</Label>
              <Input
                id="org-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={8}
                required
              />
            </>
          )}
          {error ? <p role="alert">{error}</p> : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => changeOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={pending}>
              {mode === "create"
                ? t("organization.members.createAndAdd")
                : t("organization.members.addExisting")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BatchMemberDialog({
  open,
  writeAllowed,
  onOpenChange,
  onMessage,
}: {
  open: boolean;
  writeAllowed: boolean;
  onOpenChange: (open: boolean) => void;
  onMessage: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const keyRef = useRef<string | null>(null);
  const [input, setInput] = useState("");
  const [preview, setPreview] = useState<ReturnType<typeof parseBatchMemberInput> | null>(null);
  const [results, setResults] = useState<BatchMemberResultItem[]>([]);
  const [pending, setPending] = useState(false);
  const hasValidPreview = Boolean(
    preview?.items.length && preview.issues.length === 0,
  );
  const reset = () => {
    setInput("");
    setPreview(null);
    setResults([]);
    keyRef.current = null;
  };
  const changeOpen = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };
  const createPreview = () => {
    const parsed = parseBatchMemberInput(input);
    setPreview(parsed);
    if (parsed.items.length && parsed.issues.length === 0) setInput("");
  };
  const submit = async () => {
    if (!writeAllowed || !preview?.items.length || preview.issues.length) return;
    keyRef.current ??= nextIdempotencyKey("batch");
    const body = { items: preview.items };
    setInput("");
    setPreview(null);
    setPending(true);
    try {
      const result = await addOrgMembersBatch({
        body,
        idempotencyKey: keyRef.current,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.orgMe() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.orgMembers() }),
      ]);
      setResults(result.items);
      onMessage(t("organization.members.batchFinished"));
    } catch (caught) {
      const apiError = caught instanceof OrgApiError ? caught : null;
      onMessage(t(safeOrgErrorKey(apiError?.code)));
    } finally {
      setInput("");
      setPreview(null);
      keyRef.current = null;
      setPending(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("organization.members.batch")}</DialogTitle>
          <DialogDescription>{t("organization.members.batchDescription")}</DialogDescription>
        </DialogHeader>
        {results.length ? (
          <div>
            {results.map((item) => (
              <div key={item.client_item_id}>
                <code>{item.client_item_id}</code>{" "}
                <span>
                  {t(
                    `organization.members.result.${safeBatchResultStatus(item.status)}`,
                  )}
                </span>
                {item.code ? <code>{safeBatchResultCode(item.code)}</code> : null}
              </div>
            ))}
          </div>
        ) : (
          <>
            {!hasValidPreview ? (
              <>
                <Label htmlFor="org-batch">{t("organization.members.batchRows")}</Label>
                <Textarea
                  id="org-batch"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                />
              </>
            ) : null}
            {preview ? (
              <div>
                {preview.items.map((item) => (
                  <div key={item.client_item_id}>
                    <code>{item.client_item_id}</code>{" "}
                    <span>{item.mode === "existing" ? item.user_id : item.username}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => changeOpen(false)}
          >
            {t("common.cancel")}
          </Button>
          {!results.length && preview?.items.length && !preview.issues.length ? (
            <Button type="button" disabled={pending} onClick={submit}>
              {t("organization.members.submitBatch")}
            </Button>
          ) : !results.length ? (
            <Button
              type="button"
              onClick={createPreview}
            >
              {t("organization.members.previewRows")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MemberChangeDialog({
  change,
  writeAllowed,
  onChange,
  onMessage,
  onRefresh,
}: {
  change: PendingChange | null;
  writeAllowed: boolean;
  onChange: (change: PendingChange | null) => void;
  onMessage: (message: string | null) => void;
  onRefresh: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const mutation = usePatchOrgMember();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirm = async () => {
    if (!writeAllowed || !change?.member.updated_at) return;
    try {
      await mutation.mutateAsync({
        userId: change.member.user_id,
        body: {
          ...(change.role ? { role: change.role } : {}),
          ...(change.membershipStatus ? { membership_status: change.membershipStatus } : {}),
          expected_updated_at: change.member.updated_at,
        },
      });
      onMessage(t("organization.members.changed"));
      onChange(null);
    } catch (caught) {
      const apiError = caught instanceof OrgApiError ? caught : null;
      onChange(null);
      onMessage(t(safeOrgErrorKey(apiError?.code)));
      if (apiError?.status === 409) {
        try {
          await onRefresh();
        } catch {
          // The old PendingChange is already gone and must never be restored.
        }
      }
    }
  };
  return (
    <AlertDialog open={Boolean(change)} onOpenChange={(open) => !open && onChange(null)}>
      <AlertDialogContent initialFocus={cancelRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("organization.members.confirm.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("organization.members.confirm.sessions")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} disabled={mutation.isPending}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={change?.highRisk ? "destructive" : "default"}
            disabled={mutation.isPending}
            onClick={confirm}
          >
            {t("common.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function labelRole(value: string, t: (key: string) => string) {
  return t(value === "org_admin" ? "organization.roles.admin" : "organization.roles.member");
}
function labelStatus(value: string, t: (key: string) => string) {
  return t(`organization.status.${value}`);
}
function labelEntitlement(value: string, t: (key: string) => string) {
  return t(`organization.entitlement.${value === "org_sponsored" ? "orgSponsored" : value}`);
}
function formatDate(value: string | null | undefined, language: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(Date.parse(value));
}
