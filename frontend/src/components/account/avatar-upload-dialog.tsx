// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImagePlus, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth-store";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function AvatarUploadDialog({
  avatarInitial,
  displayName,
  open,
  onOpenChange,
}: {
  avatarInitial: string;
  displayName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentAvatarUrl = useAuthStore((s) => s.avatarUrl);
  const setAvatarUrl = useAuthStore((s) => s.setAvatarUrl);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return;

    setError(null);
    setSelectedFile(file);
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return URL.createObjectURL(file);
    });
    setFileName(file.name);
  };

  const resetState = () => {
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
    setFileName(null);
    setSelectedFile(null);
    setSaving(false);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (saving) return;
    onOpenChange(nextOpen);
    if (!nextOpen) resetState();
  };

  const handleSave = async () => {
    if (!selectedFile || saving) return;
    setSaving(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", selectedFile);
      const res = await fetch("/api/v1/account/avatar", {
        method: "POST",
        credentials: "include",
        body: form,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || t("header.account.avatarDialog.error"));
      }
      const body = await res.json();
      setAvatarUrl(body.data?.avatar_url ?? null);
      onOpenChange(false);
      resetState();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("header.account.avatarDialog.error"));
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="w-[380px] gap-0 rounded-[18px] border border-white/[0.08] bg-[#171719]/86 p-0 text-slate-100 shadow-[0_22px_70px_rgba(0,0,0,0.42)] backdrop-blur-xl"
        closeButtonClassName="top-3 right-3 text-slate-300 hover:bg-white/[0.06] hover:text-white"
        overlayClassName="bg-black/55 backdrop-blur-sm"
      >
        <DialogHeader className="px-5 pb-3 pt-5">
          <DialogTitle className="text-[17px] font-medium tracking-normal text-white">
            {t("header.account.avatarDialog.title")}
          </DialogTitle>
          <DialogDescription className="text-[12px] leading-5 text-slate-400">
            {t("header.account.avatarDialog.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 pb-5">
          <div className="flex items-center gap-4 rounded-[14px] border border-white/[0.07] bg-white/[0.035] p-4">
            <div className="flex size-[84px] shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/[0.10] bg-white/[0.07] text-[26px] font-normal text-white/72">
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt=""
                  className="size-full object-cover"
                />
              ) : currentAvatarUrl ? (
                <img
                  src={currentAvatarUrl}
                  alt=""
                  className="size-full object-cover"
                />
              ) : (
                avatarInitial
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-medium text-white">
                {displayName}
              </p>
              <p
                className={`mt-1 line-clamp-2 break-all text-[12px] leading-5 ${
                  error ? "text-red-400" : "text-slate-400"
                }`}
              >
                {error ?? fileName ?? t("header.account.avatarDialog.previewHint")}
              </p>
            </div>
          </div>

          <button
            type="button"
            className="mt-3 flex h-[96px] w-full flex-col items-center justify-center rounded-[14px] border border-dashed border-white/[0.14] bg-white/[0.025] text-center transition-colors duration-150 hover:border-cyan-200/35 hover:bg-white/[0.045]"
            onClick={() => inputRef.current?.click()}
          >
            {previewUrl ? (
              <Upload className="size-5 text-white" />
            ) : (
              <ImagePlus className="size-5 text-white" />
            )}
            <span className="mt-2 text-[13px] font-medium text-slate-100">
              {previewUrl
                ? t("header.account.avatarDialog.replace")
                : t("header.account.avatarDialog.choose")}
            </span>
            <span className="mt-1 text-[11px] text-slate-500">
              {t("header.account.avatarDialog.fileHint")}
            </span>
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(event) => handleFile(event.currentTarget.files?.[0])}
          />
        </div>

        <DialogFooter className="p-4 pt-0">
          <Button
            type="button"
            variant="outline"
            className="h-9 rounded-[9px] border-white/[0.10] bg-white/[0.03] px-4 text-[13px] font-normal text-slate-200 hover:bg-white/[0.06] hover:text-white"
            onClick={() => handleOpenChange(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={!selectedFile || saving}
            onClick={handleSave}
            className="h-9 rounded-[9px] px-4 text-[13px] font-normal"
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            {saving
              ? t("header.account.avatarDialog.saving")
              : t("header.account.avatarDialog.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
