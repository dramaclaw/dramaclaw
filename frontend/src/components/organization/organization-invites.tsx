// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, RefreshCw, Send, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { normalizeInviteSearch } from "@/components/organization/invite-search";
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { queryKeys } from "@/lib/query-keys";
import {
  createOrgInvite,
  OrgApiError,
  revokeOrgInvite,
  useOrgInvites,
  useOrgMe,
} from "@/lib/queries/org";
import type { Invite, InviteListParams } from "@/types/org";

const DEFAULT_LIMIT = 20;

export interface OrganizationInvitesProps {
  params: InviteListParams;
  onParamsChange: (params: InviteListParams) => void;
  onForbidden: () => void;
}

export function OrganizationInvites(_props: OrganizationInvitesProps) {
  const props = _props;
  const { t } = useTranslation();
  const orgMe = useOrgMe();
  const queryClient = useQueryClient();
  const denied = !orgMe.isPending && !hasSafeInviteCapability(orgMe.data);
  const orgMeForbidden = orgMe.error instanceof OrgApiError && orgMe.error.status === 403;
  const reported = useRef(false);
  const convergeForbidden = useCallback(async () => {
    if (reported.current) return;
    reported.current = true;
    await queryClient.cancelQueries({ queryKey: queryKeys.org() });
    queryClient.removeQueries({ queryKey: queryKeys.org() });
    props.onForbidden();
  }, [props.onForbidden, queryClient]);

  useEffect(() => {
    if (!denied && !orgMeForbidden) return;
    void convergeForbidden();
  }, [convergeForbidden, denied, orgMeForbidden]);

  if (orgMe.isPending || orgMe.isFetching) {
    return (
      <section role="status" aria-label={t("organization.invites.loading")}>
        <Skeleton className="h-72 w-full" />
      </section>
    );
  }
  if (orgMe.isError || denied) {
    return <p role="status">{t("organization.invites.returning")}</p>;
  }
  return <OrganizationInviteList {...props} onForbidden={convergeForbidden} />;
}

function hasSafeInviteCapability(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  const user = data.user as Record<string, unknown> | null;
  const organization = data.organization as Record<string, unknown> | null;
  const membership = data.membership as Record<string, unknown> | null;
  const capabilities = data.capabilities as Record<string, unknown> | null;
  return Boolean(
    user &&
      organization &&
      membership &&
      capabilities &&
      typeof user.user_id === "string" &&
      user.user_id.trim() &&
      typeof user.username === "string" &&
      user.username.trim() &&
      ["platform", "org_sponsored", "disabled"].includes(
        String(user.model_billing_entitlement),
      ) &&
      typeof organization.org_id === "string" &&
      organization.org_id.trim() &&
      typeof organization.name === "string" &&
      organization.name.trim() &&
      organization.status === "active" &&
      typeof organization.updated_at === "string" &&
      organization.updated_at.trim() &&
      membership.role === "org_admin" &&
      membership.membership_status === "active" &&
      typeof membership.updated_at === "string" &&
      membership.updated_at.trim() &&
      typeof capabilities.manage_members === "boolean" &&
      capabilities.manage_invites === true
  );
}

function isSafeInvite(value: unknown): value is Invite {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "invite_id",
    "target_masked",
    "role",
    "status",
    "expires_at",
    "accepted_at",
    "created_at",
  ])) return false;
  const invite = value as Record<string, unknown>;
  return (
    typeof invite.invite_id === "string" &&
    invite.invite_id.trim().length > 0 &&
    typeof invite.target_masked === "string" && invite.target_masked.trim().length > 0 &&
    (invite.role === undefined || invite.role === "org_member") &&
    typeof invite.status === "string" &&
    ["pending", "expired", "revoked", "accepted"].includes(invite.status) &&
    isDateTime(invite.expires_at) &&
    isOptionalDateTime(invite.accepted_at) &&
    isOptionalDateTime(invite.created_at)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function isOptionalDateTime(value: unknown): boolean {
  return value === undefined || value === null || isDateTime(value);
}

function nextIdempotencyKey(): string {
  const value =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `invite-${value}`;
}

function OrganizationInviteList({
  params,
  onParamsChange,
  onForbidden,
}: OrganizationInvitesProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const safeParams = useMemo(() => {
    const normalized = normalizeInviteSearch(params as Record<string, unknown>);
    return {
      ...normalized,
      limit: normalized.limit ?? DEFAULT_LIMIT,
      offset: normalized.offset ?? 0,
    };
  }, [params]);
  const invites = useOrgInvites(safeParams);
  const forbiddenHandled = useRef(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [secretLink, setSecretLink] = useState<string | null>(null);
  const [secretUnavailable, setSecretUnavailable] = useState(false);
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<Invite | null>(null);
  const safeRows = isSafeInviteList(invites.data);

  const closeTransientUi = useCallback(() => {
    setCreateOpen(false);
    setSecretLink(null);
    setSecretUnavailable(false);
    setTarget("");
    setErrorKey(null);
    setRevoke(null);
  }, []);

  const convergeForbidden = useCallback(async () => {
    closeTransientUi();
    await onForbidden();
  }, [closeTransientUi, onForbidden]);

  useEffect(() => {
    const error = invites.error instanceof OrgApiError ? invites.error : null;
    if (forbiddenHandled.current || error?.status !== 403) return;
    forbiddenHandled.current = true;
    void convergeForbidden();
  }, [convergeForbidden, invites.error]);

  useEffect(() => {
    if (!invites.isFetching && safeRows) return;
    setCreateOpen(false);
    setRevoke(null);
  }, [invites.isFetching, safeRows]);

  async function submitCreate(event: React.FormEvent) {
    event.preventDefault();
    if (pending || !target.trim()) return;
    const idempotencyKey = nextIdempotencyKey();
    const body = { target_username: target.trim(), expires_in_hours: 24 } as const;
    setPending(true);
    setErrorKey(null);
    let token: unknown = null;
    try {
      const created = await createOrgInvite({
        body,
        idempotencyKey,
        consumeToken: (value) => {
          token = value;
        },
      });
      if (
        !isSafeInvite(created) ||
        (token !== null && (typeof token !== "string" || token.trim().length === 0))
      ) {
        setCreateOpen(false);
        setTarget("");
        setErrorKey("organization.errors.generic");
        return;
      }
      setTarget("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.orgInvites() });
      if (token) {
        setSecretLink(
          new URL(`/invite/${encodeURIComponent(token)}`, window.location.origin).toString(),
        );
        setCreateOpen(false);
      } else {
        setCreateOpen(false);
        setSecretUnavailable(true);
      }
    } catch (error) {
      if (error instanceof OrgApiError && error.status === 403) {
        await convergeForbidden();
        return;
      }
      setErrorKey(safeInviteErrorKey(error));
    } finally {
      setPending(false);
    }
  }

  async function confirmRevoke() {
    if (!revoke || pending) return;
    setPending(true);
    setErrorKey(null);
    try {
      const revoked = await revokeOrgInvite(revoke.invite_id);
      if (!isSafeInvite(revoked)) {
        setRevoke(null);
        setErrorKey("organization.errors.generic");
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.orgMe() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.orgInvites() }),
      ]);
      setRevoke(null);
    } catch (error) {
      if (error instanceof OrgApiError && error.status === 403) {
        await convergeForbidden();
        return;
      }
      setErrorKey(safeInviteErrorKey(error));
    } finally {
      setPending(false);
    }
  }

  if (invites.isPending) {
    return (
      <section role="status" aria-label={t("organization.invites.loading")}>
        <Skeleton className="h-72 w-full" />
      </section>
    );
  }
  if (invites.isError || !invites.data || !safeRows) {
    if (invites.error instanceof OrgApiError && invites.error.status === 403) {
      return <p role="status">{t("organization.invites.returning")}</p>;
    }
    return (
      <section className="mx-auto flex max-w-xl flex-col items-start gap-4 rounded-xl border p-6">
        <h1>{t("organization.invites.title")}</h1>
        <p role="alert">{t("organization.errors.generic")}</p>
        <Button type="button" variant="outline" onClick={() => invites.refetch()}>
          <RefreshCw className="size-4" />
          {t("organization.retry")}
        </Button>
      </section>
    );
  }

  const offset = safeParams.offset;
  const limit = safeParams.limit;
  const changeFilter = (change: Partial<InviteListParams>) =>
    onParamsChange({ ...safeParams, ...change, offset: 0 });

  return (
    <section className="mx-auto max-w-6xl space-y-5" aria-busy={invites.isFetching}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t("organization.invites.title")}</h1>
          <p>{t("organization.invites.total", { count: invites.data.total })}</p>
        </div>
        <Button
          type="button"
          disabled={invites.isFetching || !safeRows}
          onClick={() => setCreateOpen(true)}
        >
          <Send className="size-4" />
          {t("organization.invites.create")}
        </Button>
      </header>
      {errorKey ? <p role="alert">{t(errorKey)}</p> : null}
      <label className="block max-w-xs">
        {t("organization.invites.status")}
        <select
          className="h-9 w-full rounded-md border bg-background px-3"
          value={safeParams.status ?? ""}
          onChange={(event) =>
            changeFilter({
              status: (event.target.value || undefined) as InviteListParams["status"],
            })
          }
        >
          <option value="">{t("organization.invites.allStatuses")}</option>
          {(["pending", "expired", "revoked", "accepted"] as const).map((status) => (
            <option key={status} value={status}>{t(`organization.invites.statuses.${status}`)}</option>
          ))}
        </select>
      </label>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <caption className="sr-only">{t("organization.invites.title")}</caption>
          <thead><tr>
            <th>{t("organization.invites.target")}</th>
            <th>{t("organization.fields.status")}</th>
            <th>{t("organization.invites.expires")}</th>
            <th>{t("organization.invites.actions")}</th>
          </tr></thead>
          <tbody>
            {invites.data.items.map((invite) => (
              <tr key={invite.invite_id} className="border-t">
                <td>{invite.target_masked}</td>
                <td>{t(`organization.invites.statuses.${invite.status}`)}</td>
                <td><time dateTime={invite.expires_at}>{formatDate(invite.expires_at, i18n.language)}</time></td>
                <td>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={invite.status !== "pending" || invites.isFetching}
                    onClick={() => setRevoke(invite)}
                  >
                    <Trash2 className="size-4" />
                    {t("organization.invites.revoke")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {invites.data.items.length === 0 ? <p>{t("organization.invites.empty")}</p> : null}
      <nav className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={offset === 0} onClick={() => onParamsChange({ ...safeParams, offset: Math.max(0, offset - limit) })}>
          {t("organization.invites.previous")}
        </Button>
        <Button type="button" variant="outline" disabled={offset + limit >= invites.data.total} onClick={() => onParamsChange({ ...safeParams, offset: offset + limit })}>
          {t("organization.invites.next")}
        </Button>
      </nav>

      <Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) { setTarget(""); setErrorKey(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("organization.invites.create")}</DialogTitle>
            <DialogDescription>{t("organization.invites.createDescription")}</DialogDescription>
          </DialogHeader>
          <form onSubmit={submitCreate} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="invite-target">{t("organization.invites.target")}</Label>
              <Input id="invite-target" value={target} onChange={(event) => setTarget(event.target.value)} autoComplete="off" />
            </div>
            {errorKey ? <p role="alert">{t(errorKey)}</p> : null}
            <DialogFooter>
              <Button type="submit" disabled={pending || !target.trim()}>{t("organization.invites.submit")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={secretUnavailable} onOpenChange={setSecretUnavailable}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("organization.invites.secretUnavailableTitle")}</DialogTitle>
            <DialogDescription>{t("organization.invites.secretUnavailableDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" onClick={() => setSecretUnavailable(false)}>
              {t("organization.invites.closeSecret")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={secretLink !== null} onOpenChange={(open) => { if (!open) setSecretLink(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("organization.invites.secretTitle")}</DialogTitle>
            <DialogDescription>{t("organization.invites.secretDescription")}</DialogDescription>
          </DialogHeader>
          {secretLink ? <p className="break-all font-mono text-sm">{secretLink}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => secretLink && navigator.clipboard.writeText(secretLink)}>
              <Copy className="size-4" />{t("organization.invites.copy")}
            </Button>
            <Button type="button" onClick={() => setSecretLink(null)}>{t("organization.invites.closeSecret")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={revoke !== null} onOpenChange={(open) => { if (!open) setRevoke(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("organization.invites.revoke")}</AlertDialogTitle>
            <AlertDialogDescription>{t("organization.invites.revokeDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction disabled={pending} onClick={confirmRevoke}>{t("organization.invites.confirmRevoke")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function isSafeInviteList(value: unknown): value is { items: Invite[]; total: number } {
  return isRecord(value) &&
    hasOnlyKeys(value, ["items", "total"]) &&
    Array.isArray(value.items) &&
    value.items.every(isSafeInvite) &&
    typeof value.total === "number" &&
    Number.isFinite(value.total) &&
    Number.isInteger(value.total) &&
    value.total >= 0;
}

function safeInviteErrorKey(error: unknown): string {
  if (!(error instanceof OrgApiError)) return "organization.errors.generic";
  if (error.code === "ORG_INVITE_ALREADY_EXISTS") return "organization.invites.errors.duplicate";
  if (error.code === "ORG_RATE_LIMITED") return "organization.invites.errors.rateLimited";
  if (error.status === 403) return "organization.invites.errors.forbidden";
  return "organization.errors.generic";
}

function formatDate(value: string, language: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
