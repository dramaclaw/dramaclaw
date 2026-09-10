// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AuthApiError,
  bindAccountPhone,
  newAuthIdempotencyKey,
  type OtpChallenge,
} from "@/lib/auth-api";

export function PhoneBindingDialog({
  onClose,
  onBound,
}: {
  onClose: () => void;
  onBound: () => void;
}) {
  const { t } = useTranslation();
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<OtpChallenge | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const requestKey = useRef(newAuthIdempotencyKey());
  const verifyKey = useRef(newAuthIdempotencyKey());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(
      () => setCooldown((value) => Math.max(0, value - 1)),
      1000,
    );
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  function showError(exc: unknown) {
    let key = "header.account.phoneBinding.error";
    if (exc instanceof AuthApiError) {
      if (exc.code === "CURRENT_PASSWORD_INCORRECT")
        key = "header.account.passwordDialog.currentIncorrect";
      else if (exc.code === "PHONE_IN_USE")
        key = "header.account.phoneBinding.inUse";
      else if (exc.code === "PHONE_ALREADY_BOUND")
        key = "header.account.phoneBinding.alreadyBound";
      else if (exc.status === 429) key = "auth.otp.rateLimited";
      else if (exc.status === 400 || exc.status === 422)
        key = "auth.otp.invalidPhone";
      else if (
        exc.status === 401 ||
        exc.status === 410 ||
        exc.code === "OTP_CHALLENGE_CONSUMED"
      )
        key = "auth.otp.invalidCode";
      else if (exc.status === 503) key = "auth.otp.unavailable";
    }
    setError(t(key));
  }

  async function sendCode() {
    if (busyRef.current || cooldown > 0 || !phone.trim() || !password) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = (await bindAccountPhone(
        "request",
        { phone, current_password: password },
        requestKey.current,
      )) as OtpChallenge;
      if (!alive.current) return;
      setChallenge(result);
      setCode("");
      setCooldown(60);
      requestKey.current = newAuthIdempotencyKey();
      verifyKey.current = newAuthIdempotencyKey();
      toast.success(t("auth.otp.sent", { phone: result.phone_masked }));
    } catch (exc) {
      if (alive.current) showError(exc);
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busyRef.current || !challenge || !/^\d{6}$/.test(code)) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await bindAccountPhone(
        "verify",
        {
          phone,
          current_password: password,
          code,
          verification_id: challenge.verification_id,
        },
        verifyKey.current,
      );
      if (!alive.current) return;
      toast.success(t("header.account.phoneBinding.success"));
      onBound();
      onClose();
    } catch (exc) {
      if (alive.current) showError(exc);
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  function resetChallenge() {
    setChallenge(null);
    setCode("");
    setError(null);
    requestKey.current = newAuthIdempotencyKey();
    verifyKey.current = newAuthIdempotencyKey();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busyRef.current) onClose();
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("header.account.phoneBinding.title")}</DialogTitle>
          <DialogDescription>
            {t("header.account.phoneBinding.description")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <label className="block space-y-1.5 text-sm">
            <span>{t("header.account.passwordDialog.current")}</span>
            <Input
              type="password"
              autoComplete="current-password"
              maxLength={512}
              value={password}
              disabled={busy}
              onChange={(event) => {
                setPassword(event.target.value);
                resetChallenge();
              }}
            />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>{t("auth.otp.phone")}</span>
            <Input
              type="tel"
              autoComplete="tel"
              maxLength={32}
              value={phone}
              disabled={busy}
              onChange={(event) => {
                setPhone(event.target.value);
                resetChallenge();
              }}
            />
          </label>
          <Button
            type="button"
            variant="outline"
            disabled={busy || cooldown > 0 || !phone.trim() || !password}
            onClick={() => void sendCode()}
          >
            {cooldown > 0
              ? t("auth.otp.resendIn", { seconds: cooldown })
              : t(challenge ? "auth.otp.resend" : "auth.otp.send")}
          </Button>
          {challenge ? (
            <label className="block space-y-1.5 text-sm">
              <span>{t("auth.otp.code")}</span>
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                disabled={busy}
                onChange={(event) =>
                  setCode(event.target.value.replace(/\D/g, ""))
                }
              />
            </label>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={busy || !challenge || !/^\d{6}$/.test(code)}
            >
              {t(
                busy
                  ? "auth.otp.verifying"
                  : "header.account.phoneBinding.submit",
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
