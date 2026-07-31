// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { acceptOrgInvite, getOrgInvitePreview, OrgApiError } from "@/lib/queries/org";
import type { InviteAcceptResult, InvitePreview } from "@/types/org";

export interface InviteAcceptanceProps {
  token: string;
  onExistingAccepted: (path: "/organization") => void;
}

type PreviewState =
  | { status: "loading"; token: string }
  | { status: "ready"; token: string; data: InvitePreview }
  | { status: "error"; token: string; error: unknown };

export function InviteAcceptance(_props: InviteAcceptanceProps) {
  const props = _props;
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const generation = useRef(0);
  const activeSubmit = useRef(false);
  const [preview, setPreview] = useState<PreviewState>({
    status: "loading",
    token: props.token,
  });
  const [mode, setMode] = useState<"existing" | "create" | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState(false);
  const [success, setSuccess] = useState<"existing" | "create" | null>(null);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    let active = true;
    activeSubmit.current = false;
    setPreview({ status: "loading", token: props.token });
    setMode(null);
    setUsername("");
    setPassword("");
    setPending(false);
    setErrorKey(null);
    setTerminalError(false);
    setSuccess(null);

    void getOrgInvitePreview(props.token).then(
      (data) => {
        if (!active || generation.current !== requestGeneration) return;
        setPreview(isSafePreview(data) ? { status: "ready", token: props.token, data } : {
          status: "error",
          token: props.token,
          error: null,
        });
      },
      (error: unknown) => {
        if (!active || generation.current !== requestGeneration) return;
        setPreview({ status: "error", token: props.token, error });
      },
    );

    return () => {
      active = false;
      setPassword("");
    };
  }, [props.token]);

  function changeMode(next: "existing" | "create") {
    setPassword("");
    setUsername("");
    setErrorKey(null);
    setMode(next);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!mode || activeSubmit.current) return;
    if (mode === "create" && (!username.trim() || !password)) return;

    const requestGeneration = generation.current;
    const requestMode = mode;
    const requestToken = props.token;
    const idempotencyKey = nextAcceptKey();
    const body = requestMode === "existing"
      ? ({ mode: "existing" } as const)
      : ({ mode: "create", username: username.trim(), password } as const);
    activeSubmit.current = true;
    setPassword("");
    setPending(true);
    setErrorKey(null);
    try {
      const result = await acceptOrgInvite(requestToken, { body, idempotencyKey });
      if (generation.current !== requestGeneration) return;
      if (!isSafeAcceptResult(result)) {
        setTerminalError(true);
        return;
      }
      setSuccess(requestMode);
      if (requestMode === "existing") {
        await queryClient.invalidateQueries({ queryKey: ["org", "me"] });
        if (generation.current === requestGeneration) {
          props.onExistingAccepted("/organization");
        }
      }
    } catch (error) {
      if (generation.current === requestGeneration) {
        if (
          error instanceof OrgApiError &&
          error.status !== null &&
          error.status >= 200 &&
          error.status < 300
        ) {
          setTerminalError(true);
        } else {
          setErrorKey(safeAcceptanceErrorKey(error));
        }
      }
    } finally {
      if (generation.current === requestGeneration) {
        activeSubmit.current = false;
        setPending(false);
      }
    }
  }

  if (preview.token !== props.token || preview.status === "loading") {
    return (
      <section role="status" aria-label={t("invite.loading")}>
        <Skeleton className="mx-auto h-72 max-w-xl" />
      </section>
    );
  }
  if (preview.status === "error") {
    return <SafeResult message={t(safePreviewErrorKey(preview.error))} />;
  }
  if (terminalError) {
    return <SafeResult message={t("invite.errors.generic")} />;
  }
  if (success === "create") {
    return (
      <SafeResult message={t("invite.successCreate")}>
        <a className="underline" href="/login">{t("invite.login")}</a>
      </SafeResult>
    );
  }
  if (success === "existing") return <SafeResult message={t("invite.successExisting")} />;

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-xl items-center px-4 py-10">
      <Card className="w-full">
        <CardHeader><CardTitle>{t("invite.title")}</CardTitle></CardHeader>
        <CardContent className="space-y-5">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt>{t("invite.organization")}</dt><dd>{preview.data.org_name}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>{t("invite.target")}</dt><dd>{preview.data.target_masked}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>{t("invite.expires")}</dt>
              <dd><time dateTime={preview.data.expires_at}>{preview.data.expires_at}</time></dd>
            </div>
          </dl>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              type="button"
              variant={mode === "existing" ? "default" : "outline"}
              onClick={() => changeMode("existing")}
            >
              {t("invite.existing")}
            </Button>
            <Button
              type="button"
              variant={mode === "create" ? "default" : "outline"}
              onClick={() => changeMode("create")}
            >
              {t("invite.create")}
            </Button>
          </div>
          {mode ? (
            <form className="space-y-4" onSubmit={submit}>
              {mode === "create" ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="invite-username">{t("invite.username")}</Label>
                    <Input
                      id="invite-username"
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      autoComplete="username"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="invite-password">{t("invite.password")}</Label>
                    <Input
                      id="invite-password"
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="new-password"
                    />
                  </div>
                </>
              ) : null}
              {errorKey ? <p role="alert">{t(errorKey)}</p> : null}
              <Button
                type="submit"
                disabled={pending || (mode === "create" && (!username.trim() || !password))}
              >
                {t("invite.accept")}
              </Button>
            </form>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}

function isSafePreview(value: unknown): value is InvitePreview {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "org_name",
    "target_masked",
    "role",
    "status",
    "expires_at",
  ])) return false;
  return typeof value.org_name === "string" &&
    value.org_name.trim().length > 0 &&
    typeof value.target_masked === "string" &&
    value.target_masked.trim().length > 0 &&
    (value.role === undefined || value.role === "org_member") &&
    value.status === "pending" &&
    isDateTime(value.expires_at);
}

function isSafeAcceptResult(value: unknown): value is InviteAcceptResult {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "user_id",
    "org_id",
    "role",
    "membership_status",
    "model_billing_entitlement",
  ])) return false;
  return typeof value.user_id === "string" &&
    value.user_id.trim().length > 0 &&
    typeof value.org_id === "string" &&
    value.org_id.trim().length > 0 &&
    value.role === "org_member" &&
    value.membership_status === "active" &&
    ["platform", "org_sponsored", "disabled"].includes(
      String(value.model_billing_entitlement),
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

function nextAcceptKey(): string {
  const value = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `accept-${value}`;
}

function safePreviewErrorKey(error: unknown): string {
  if (!(error instanceof OrgApiError)) return "invite.errors.generic";
  if (error.code === "ORG_INVITE_UNAVAILABLE") return "invite.errors.unavailable";
  if (error.code === "ORG_INVITE_ALREADY_USED") return "invite.errors.used";
  if (error.code === "ORG_INVITE_TARGET_MISMATCH") return "invite.errors.mismatch";
  if (error.code === "ORG_RATE_LIMITED") return "invite.errors.rateLimited";
  return "invite.errors.generic";
}

function safeAcceptanceErrorKey(error: unknown): string {
  if (!(error instanceof OrgApiError)) return "invite.errors.generic";
  if (error.code === "ORG_INVITE_UNAVAILABLE") return "invite.errors.unavailable";
  if (error.code === "ORG_INVITE_ALREADY_USED") return "invite.errors.used";
  if (error.code === "ORG_INVITE_TARGET_MISMATCH") return "invite.errors.mismatch";
  if (error.code === "ORG_RATE_LIMITED") return "invite.errors.rateLimited";
  return "invite.errors.generic";
}

function SafeResult({ message, children }: { message: string; children?: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-xl px-4 py-16">
      <Card>
        <CardContent className="space-y-4 pt-4">
          <p role="alert">{message}</p>
          {children}
        </CardContent>
      </Card>
    </main>
  );
}
