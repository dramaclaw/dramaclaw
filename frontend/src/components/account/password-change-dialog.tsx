// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

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

const MIN_PASSWORD_LENGTH = 8;

type PasswordErrorBody = {
  detail?: string | { code?: string; message?: string };
};

export function PasswordChangeDialog({
  open,
  onOpenChange,
  onPasswordChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPasswordChanged: () => void;
}) {
  const { t } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const unchanged = newPassword.length > 0 && newPassword === currentPassword;
  const submitDisabled =
    saving ||
    currentPassword.length === 0 ||
    newPassword.length < MIN_PASSWORD_LENGTH ||
    confirmPassword.length === 0 ||
    mismatch ||
    unchanged;

  const resetSecrets = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setSaving(false);
    setError(null);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (saving) return;
    onOpenChange(nextOpen);
    if (!nextOpen) resetSecrets();
  };

  const finishPasswordChange = (partial: boolean) => {
    onOpenChange(false);
    resetSecrets();
    if (partial) {
      toast.warning(t("header.account.passwordDialog.partialSuccess"));
    } else {
      toast.success(t("header.account.passwordDialog.success"));
    }
    onPasswordChanged();
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitDisabled) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as PasswordErrorBody;
      const detail = body.detail;
      const code = typeof detail === "object" ? detail.code : undefined;
      if (response.status === 503 && code === "PASSWORD_CHANGED_CACHE_PARTIAL") {
        finishPasswordChange(true);
        return;
      }
      if (!response.ok) {
        setError(
          response.status === 401
            ? t("header.account.passwordDialog.currentIncorrect")
            : t("header.account.passwordDialog.error"),
        );
        setSaving(false);
        return;
      }
      finishPasswordChange(false);
    } catch {
      setError(t("header.account.passwordDialog.error"));
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="w-[380px] gap-0 rounded-xl border border-border bg-popover p-0 text-popover-foreground shadow-lg"
        overlayClassName="bg-black/55"
      >
        <DialogHeader className="px-5 pb-3 pt-5">
          <DialogTitle>{t("header.account.passwordDialog.title")}</DialogTitle>
          <DialogDescription className="text-xs leading-5">
            {t("header.account.passwordDialog.description")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="space-y-3 px-5 pb-5">
            <PasswordField
              autoComplete="current-password"
              label={t("header.account.passwordDialog.current")}
              value={currentPassword}
              onChange={setCurrentPassword}
            />
            <PasswordField
              autoComplete="new-password"
              label={t("header.account.passwordDialog.new")}
              value={newPassword}
              onChange={setNewPassword}
            />
            <PasswordField
              autoComplete="new-password"
              label={t("header.account.passwordDialog.confirm")}
              value={confirmPassword}
              onChange={setConfirmPassword}
            />

            {mismatch ? (
              <p className="text-xs text-destructive" role="alert">
                {t("header.account.passwordDialog.mismatch")}
              </p>
            ) : unchanged ? (
              <p className="text-xs text-destructive" role="alert">
                {t("header.account.passwordDialog.unchanged")}
              </p>
            ) : error ? (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("header.account.passwordDialog.requirement")}
              </p>
            )}
          </div>

          <DialogFooter className="p-4 pt-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={saving}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={submitDisabled}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {saving
                ? t("header.account.passwordDialog.saving")
                : t("header.account.passwordDialog.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PasswordField({
  autoComplete,
  label,
  onChange,
  value,
}: {
  autoComplete: "current-password" | "new-password";
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="block space-y-1.5 text-sm">
      <span>{label}</span>
      <Input
        type="password"
        autoComplete={autoComplete}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}
