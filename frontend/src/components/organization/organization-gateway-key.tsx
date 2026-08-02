// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, KeyRound, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { queryKeys } from "@/lib/query-keys";
import {
  deleteOrgGatewayKey,
  OrgApiError,
  putOrgGatewayKey,
  useOrgGatewayKeyStatus,
  useOrgMe,
} from "@/lib/queries/org";
import type { GatewayKeyStatus } from "@/types/org";

type ConfirmAction = "bind" | "replace" | "unbind";
type UiState = GatewayKeyStatus["state"] | "validating" | "validation_failed";

export interface OrganizationGatewayKeyProps {
  onForbidden: () => void;
}

export function OrganizationGatewayKey({ onForbidden }: OrganizationGatewayKeyProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const orgMe = useOrgMe();
  const denied = !orgMe.isPending && !hasSafeGatewayCapability(orgMe.data);
  const forbidden = orgMe.error instanceof OrgApiError && orgMe.error.status === 403;
  const reported = useRef(false);

  const convergeForbidden = useCallback(async () => {
    if (reported.current) return;
    reported.current = true;
    await queryClient.cancelQueries({ queryKey: queryKeys.org() });
    queryClient.removeQueries({ queryKey: queryKeys.org() });
    onForbidden();
  }, [onForbidden, queryClient]);

  useEffect(() => {
    if (denied || forbidden) void convergeForbidden();
  }, [convergeForbidden, denied, forbidden]);

  if (orgMe.isPending || orgMe.isFetching) {
    return <Skeleton role="status" aria-label={t("organization.gatewayKey.loading")} className="mx-auto h-72 w-full max-w-3xl" />;
  }
  if (orgMe.isError || denied) {
    return <p role="status">{t("organization.gatewayKey.returning")}</p>;
  }
  return <GatewayKeyManager onForbidden={convergeForbidden} />;
}

function GatewayKeyManager({ onForbidden }: OrganizationGatewayKeyProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const statusQuery = useOrgGatewayKeyStatus();
  const [gatewayKey, setGatewayKey] = useState("");
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [uiState, setUiState] = useState<UiState | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const pending = useRef(false);
  const forbiddenHandled = useRef(false);

  const clearSecret = useCallback(() => {
    setGatewayKey("");
    setReveal(false);
  }, []);

  useEffect(() => clearSecret, [clearSecret]);

  useEffect(() => {
    const error = statusQuery.error instanceof OrgApiError ? statusQuery.error : null;
    if (forbiddenHandled.current || error?.status !== 403) return;
    forbiddenHandled.current = true;
    clearSecret();
    void onForbidden();
  }, [clearSecret, onForbidden, statusQuery.error]);

  if (statusQuery.isPending) {
    return <Skeleton role="status" aria-label={t("organization.gatewayKey.loading")} className="mx-auto h-72 w-full max-w-3xl" />;
  }
  if (statusQuery.isError || !statusQuery.data) {
    return (
      <section className="mx-auto flex max-w-3xl flex-col items-start gap-4 rounded-xl border p-4 sm:p-6">
        <p role="alert">{t("organization.gatewayKey.errors.generic")}</p>
        <Button type="button" variant="outline" onClick={() => statusQuery.refetch()}>
          <RefreshCw />{t("organization.gatewayKey.retry")}
        </Button>
      </section>
    );
  }

  const snapshot = statusQuery.data;
  const displayedState = uiState ?? snapshot.state;
  const isPending = displayedState === "validating";
  const writeAction = snapshot.state === "active" ? "replace" : "bind";

  function openWriteConfirm(event: React.FormEvent) {
    event.preventDefault();
    if (pending.current || gatewayKey.trim().length === 0) return;
    setErrorKey(null);
    setConfirm(writeAction);
  }

  function closeConfirm() {
    if (pending.current) return;
    setConfirm(null);
    clearSecret();
  }

  async function refreshAfterConflict() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.orgGatewayKey() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.orgMe() }),
    ]);
  }

  async function submitConfirmed() {
    if (!confirm || pending.current) return;
    pending.current = true;
    const action = confirm;
    const rawKey = gatewayKey;
    setConfirm(null);
    setErrorKey(null);
    setUiState("validating");
    try {
      let next: GatewayKeyStatus;
      if (action === "unbind") {
        if (
          snapshot.state !== "active" ||
          !isPositiveGatewayVersion(snapshot.key_version)
        ) {
          throw new OrgApiError({ status: null });
        }
        next = await deleteOrgGatewayKey(
          snapshot.key_version,
          nextIdempotencyKey("delete"),
        );
      } else {
        next = await putOrgGatewayKey(
          rawKey,
          snapshot.key_version,
          nextIdempotencyKey("put"),
        );
      }
      queryClient.setQueryData(queryKeys.orgGatewayKey(), next);
      setUiState(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.orgMe() });
    } catch (error) {
      setUiState("validation_failed");
      if (error instanceof OrgApiError && error.status === 403) {
        await onForbidden();
      } else if (
        error instanceof OrgApiError &&
        (error.status === 409 || error.code === "ORG_CREDENTIAL_VERSION_MISMATCH")
      ) {
        setErrorKey("organization.gatewayKey.errors.conflict");
        await refreshAfterConflict();
      } else if (
        error instanceof OrgApiError &&
        error.code === "ORG_KEY_VALIDATION_FAILED"
      ) {
        setErrorKey("organization.gatewayKey.errors.validation");
      } else {
        setErrorKey("organization.gatewayKey.errors.generic");
      }
    } finally {
      clearSecret();
      pending.current = false;
    }
  }

  return (
    <section className="mx-auto w-full max-w-3xl space-y-4 px-3 sm:px-0" aria-busy={isPending}>
      <header>
        <h1 className="text-xl font-semibold sm:text-2xl">{t("organization.gatewayKey.title")}</h1>
      </header>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><KeyRound />{t(`organization.gatewayKey.state.${displayedState}`)}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {snapshot.key_version !== null ? (
            <p className="text-sm text-muted-foreground">v{snapshot.key_version}</p>
          ) : null}
          {snapshot.verified_at ? (
            <p className="text-sm text-muted-foreground">
              {t("organization.gatewayKey.verifiedAt")}: {snapshot.verified_at}
            </p>
          ) : null}
          {snapshot.updated_at ? (
            <p className="text-sm text-muted-foreground">
              {t("organization.gatewayKey.updatedAt")}: {snapshot.updated_at}
            </p>
          ) : null}
          <form className="space-y-3" onSubmit={openWriteConfirm}>
            <Label htmlFor="organization-gateway-key">{t("organization.gatewayKey.input")}</Label>
            <div className="flex min-w-0 gap-2">
              <Input
                id="organization-gateway-key"
                className="min-w-0 flex-1"
                type={reveal ? "text" : "password"}
                value={gatewayKey}
                onChange={(event) => setGatewayKey(event.target.value)}
                autoComplete="new-password"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={65_536}
                disabled={isPending}
              />
              <Button
                type="button"
                variant="outline"
                aria-label={t("organization.gatewayKey.reveal")}
                onPointerDown={() => setReveal(true)}
                onPointerUp={() => setReveal(false)}
                onPointerLeave={() => setReveal(false)}
              ><Eye /></Button>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="submit" disabled={isPending || gatewayKey.trim().length === 0}>
                {t(`organization.gatewayKey.${writeAction}`)}
              </Button>
              {snapshot.state === "active" ? (
                <Button type="button" variant="destructive" disabled={isPending} onClick={() => {
                  setErrorKey(null);
                  clearSecret();
                  setConfirm("unbind");
                }}>{t("organization.gatewayKey.unbind")}</Button>
              ) : null}
            </div>
          </form>
          <div aria-live="polite" aria-atomic="true">
            {errorKey ? <p role="alert" className="text-sm text-destructive">{t(errorKey)}</p> : null}
          </div>
        </CardContent>
      </Card>
      <AlertDialog open={confirm !== null} onOpenChange={(open) => { if (!open) closeConfirm(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm ? t(`organization.gatewayKey.confirm.${confirm}Title`) : ""}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "replace" || confirm === "unbind"
                ? t("organization.gatewayKey.confirm.versionBoundary")
                : null}
              {confirm === "unbind" ? ` ${t("organization.gatewayKey.confirm.noFallback")}` : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>{t("organization.gatewayKey.confirm.cancel")}</AlertDialogCancel>
            <AlertDialogAction disabled={isPending} onClick={() => { void submitConfirmed(); }}>
              {t("organization.gatewayKey.confirm.submit")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function hasSafeGatewayCapability(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  const user = asRecord(data.user);
  const organization = asRecord(data.organization);
  const membership = asRecord(data.membership);
  const capabilities = asRecord(data.capabilities);
  const gatewayKey = asRecord(data.gateway_key);
  return Boolean(
    user && organization && membership && capabilities && gatewayKey &&
    typeof user.user_id === "string" && user.user_id.trim() &&
    typeof user.username === "string" && user.username.trim() &&
    ["platform", "org_sponsored", "disabled"].includes(String(user.model_billing_entitlement)) &&
    typeof organization.org_id === "string" && organization.org_id.trim() &&
    typeof organization.name === "string" && organization.name.trim() &&
    organization.status === "active" &&
    typeof organization.updated_at === "string" && organization.updated_at.trim() &&
    membership.role === "org_admin" && membership.membership_status === "active" &&
    typeof membership.updated_at === "string" && membership.updated_at.trim() &&
    capabilities.manage_gateway_key === true &&
    hasCoherentGatewayStateVersion(gatewayKey.state, gatewayKey.key_version)
  );
}

function hasCoherentGatewayStateVersion(state: unknown, version: unknown): boolean {
  if (state === "never_configured") return version === null;
  if (state === "active" || state === "no_active") {
    return isPositiveGatewayVersion(version);
  }
  return false;
}

function isPositiveGatewayVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nextIdempotencyKey(kind: "put" | "delete"): string {
  const value = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `gateway-${kind}-${value}`;
}
