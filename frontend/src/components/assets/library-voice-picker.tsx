// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AssetLibraryModal } from "@/features/canvas/ui/AssetLibraryModal";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useApplyLibraryCharacterVoice } from "@/lib/queries/characters";
import { VoiceDesignApiError } from "@/lib/queries/voice-design";
import type {
  ApplyLibraryCharacterVoice,
  VoiceDesignLibraryAsset,
} from "@/types/voice-design";
import type { CharacterVoiceSlot } from "@/types/character";

type Operation =
  | { kind: "browse" }
  | { kind: "confirm"; asset: VoiceDesignLibraryAsset }
  | {
      kind: "pending";
      asset: VoiceDesignLibraryAsset;
      input: ApplyLibraryCharacterVoice;
    }
  | {
      kind: "failed";
      asset: VoiceDesignLibraryAsset;
      input: ApplyLibraryCharacterVoice;
      error: string;
      refreshRequired: boolean;
    };

export function LibraryVoicePicker({
  project,
  character,
  slot,
  onClose,
  onRefresh,
}: {
  project: string;
  character: string;
  slot: CharacterVoiceSlot;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const mutation = useApplyLibraryCharacterVoice(project, character);
  const [operation, setOperation] = useState<Operation>({ kind: "browse" });
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const publish = async (
    asset: VoiceDesignLibraryAsset,
    input?: ApplyLibraryCharacterVoice,
  ) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const request = input ?? {
      save_request_id: crypto.randomUUID(),
      asset_id: asset.asset_id,
      expected_slot: {
        path: slot.path,
        sha256: slot.sha256,
        updated_at: slot.updated_at,
      },
      replace_existing: Boolean(slot.path),
    };
    setOperation({ kind: "pending", asset, input: request });
    try {
      await mutation.mutateAsync({ ...request, slot: String(slot.slot) });
      if (mounted.current) onClose();
    } catch (error) {
      if (mounted.current)
        setOperation({
          kind: "failed",
          asset,
          input: request,
          error:
            error instanceof Error
              ? error.message
              : "voiceDesign.errors.network",
          refreshRequired:
            error instanceof VoiceDesignApiError &&
            ["slot_changed", "slot_occupied"].includes(error.code),
        });
    } finally {
      inFlight.current = false;
    }
  };
  return (
    <>
      <AssetLibraryModal
        mode="manage"
        open={operation.kind === "browse"}
        project={project}
        allowedMedia={["audio"]}
        onClose={onClose}
        onSelectVoiceAsset={(asset) => {
          if (slot.path) setOperation({ kind: "confirm", asset });
          else void publish(asset);
        }}
      />
      <Dialog
        open={operation.kind !== "browse"}
        onOpenChange={(open) => {
          if (!open && operation.kind !== "pending") onClose();
        }}
      >
        <DialogContent className="bg-[var(--ui-surface-modal)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t(
                operation.kind === "confirm"
                  ? "voiceDesign.replaceTitle"
                  : "voiceDesign.applyProjectVoice",
              )}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm">
            {character} · {slot.label}
          </p>
          {operation.kind !== "browse" && (
            <p className="text-sm text-muted-foreground">
              {operation.asset.name}
            </p>
          )}
          {operation.kind === "confirm" && (
            <p className="text-sm text-muted-foreground">
              {t("voiceDesign.replaceHint")}
            </p>
          )}
          {operation.kind === "pending" && (
            <p role="status">{t("voiceDesign.applyingProjectVoice")}</p>
          )}
          {operation.kind === "failed" && (
            <p role="alert" className="text-sm text-destructive">
              {t(operation.error, { defaultValue: operation.error })}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={operation.kind === "pending"}
              onClick={onClose}
            >
              {t("common.cancel")}
            </Button>
            {operation.kind === "failed" && (
              <Button
                variant="outline"
                onClick={() =>
                  void onRefresh()
                    .then(() => {
                      if (mounted.current) setOperation({ kind: "browse" });
                    })
                    .catch((error) => {
                      if (mounted.current)
                        setOperation({
                          ...operation,
                          error:
                            error instanceof Error
                              ? error.message
                              : "voiceDesign.errors.network",
                        });
                    })
                }
              >
                {t("voiceDesign.refreshTarget")}
              </Button>
            )}
            {operation.kind === "confirm" && (
              <Button onClick={() => void publish(operation.asset)}>
                {t("voiceDesign.replace")}
              </Button>
            )}
            {operation.kind === "failed" && !operation.refreshRequired && (
              <Button
                onClick={() => void publish(operation.asset, operation.input)}
              >
                {t("voiceDesign.retrySave")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
