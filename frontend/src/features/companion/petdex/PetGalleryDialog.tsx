// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { CheckCircle2, ChevronRight, FileJson, ImageUp, Loader2, Trash2, UploadCloud, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { PikoActionFigure } from "@/features/companion/PikoActionFigure";
import { SpritePetCompanion } from "@/features/companion/petdex/SpritePetCompanion";
import {
  PIKO_ACCESSORIES,
  PIKO_ACCESSORY_DISPLAY_OPTIONS,
  type PikoAccessoryDisplayId,
} from "@/features/companion/piko-accessories";
import {
  fetchLocalPets,
  PETDEX_GRID_COLS,
  PETDEX_GRID_ROWS,
  PIKO_COMPANION_KIND,
  type PetdexCatalogEntry,
} from "@/features/companion/petdex/petdex-pets";
import {
  deletePetRecord,
  loadImportedPets,
  savePetRecord,
} from "@/features/companion/petdex/petdex-storage";
import { PetSpriteThumbnail } from "@/features/companion/petdex/PetSpriteThumbnail";
import "./petdex-pet.css";

export type CompanionSelection =
  | { kind: typeof PIKO_COMPANION_KIND; pet: null }
  | { kind: string; pet: PetdexCatalogEntry };

type ViewMode = "gallery" | "import";

type AccessoryFeedback = {
  id: number;
  textKey: string;
};

type AccessoryPreview = { src: string };

const ACCESSORY_PREVIEW_WIDTH = 76;
const ACCESSORY_PREVIEW_HEIGHT = 76;
const ACCESSORY_PREVIEW_GAP = 8;
const EMPTY_ACCESSORY_PREVIEW_SRC = "/piko/accessories/emperor-new-clothes-preview.png";
const PRIMARY_ACTION_BUTTON_CLASS =
  "rounded-[9px] bg-primary text-primary-foreground shadow-none hover:bg-primary/90 active:bg-primary/80 disabled:bg-primary disabled:text-primary-foreground";

function getAccessoryPreviewSrc(accessory: PikoAccessoryDisplayId) {
  if (accessory === "none") return EMPTY_ACCESSORY_PREVIEW_SRC;
  return PIKO_ACCESSORIES[accessory].src;
}

const PIKO_ACCESSORY_FEEDBACK_KEYS: Record<PikoAccessoryDisplayId, string> = {
  none: "myBuddy.debug.accessoryFeedback.none",
  "piko-accessory-golden-hoop-staff": "myBuddy.debug.accessoryFeedback.goldenHoopStaff",
  "piko-accessory-little-king": "myBuddy.debug.accessoryFeedback.littleKing",
  "piko-accessory-bubble-balloon": "myBuddy.debug.accessoryFeedback.bubbleBalloon",
  "piko-accessory-cyan-energy-sword": "myBuddy.debug.accessoryFeedback.cyanEnergySword",
  "piko-accessory-mengnan-wand": "myBuddy.debug.accessoryFeedback.mengnanWand",
  "piko-accessory-odin-hammer": "myBuddy.debug.accessoryFeedback.odinHammer",
  "piko-accessory-fire-tipped-spear": "myBuddy.debug.accessoryFeedback.fireTippedSpear",
  "piko-accessory-dumbbell": "myBuddy.debug.accessoryFeedback.dumbbell",
  "piko-accessory-thumbs-up": "myBuddy.debug.accessoryFeedback.thumbsUp",
  "piko-accessory-code-ling": "myBuddy.debug.accessoryFeedback.codeLing",
  "piko-accessory-code-yu": "myBuddy.debug.accessoryFeedback.codeYu",
  "piko-accessory-code-xia": "myBuddy.debug.accessoryFeedback.codeXia",
  "piko-accessory-code-ning": "myBuddy.debug.accessoryFeedback.codeNing",
  "piko-accessory-founder-medal": "myBuddy.debug.accessoryFeedback.founderMedal",
  "piko-accessory-red-star": "myBuddy.debug.accessoryFeedback.redStar",
  "piko-accessory-dark-knight-mask": "myBuddy.debug.accessoryFeedback.darkKnightMask",
  "piko-accessory-azu-mask": "myBuddy.debug.accessoryFeedback.azuMask",
  "piko-accessory-red-bow": "myBuddy.debug.accessoryFeedback.redBow",
  "piko-accessory-minion-goggles": "myBuddy.debug.accessoryFeedback.minionGoggles",
  "piko-accessory-diver-goggles": "myBuddy.debug.accessoryFeedback.diverGoggles",
  "piko-accessory-gourd": "myBuddy.debug.accessoryFeedback.gourd",
  "piko-accessory-judy-carrot": "myBuddy.debug.accessoryFeedback.judyCarrot",
  "piko-accessory-pacifier": "myBuddy.debug.accessoryFeedback.pacifier",
  "piko-accessory-wizard-hat": "myBuddy.debug.accessoryFeedback.wizardHat",
  "piko-accessory-bamboo-hat": "myBuddy.debug.accessoryFeedback.bambooHat",
  "piko-accessory-asgard-horns": "myBuddy.debug.accessoryFeedback.asgardHorns",
  "piko-accessory-gary-snail": "myBuddy.debug.accessoryFeedback.garySnail",
  "piko-accessory-captain-shield": "myBuddy.debug.accessoryFeedback.captainShield",
  "piko-accessory-luban-compass": "myBuddy.debug.accessoryFeedback.lubanCompass",
  "piko-accessory-luban-talisman": "myBuddy.debug.accessoryFeedback.lubanTalisman",
  "piko-accessory-red-cape": "myBuddy.debug.accessoryFeedback.redCape",
  "piko-accessory-ufo-pet": "myBuddy.debug.accessoryFeedback.ufoPet",
  "piko-accessory-ghost-pet": "myBuddy.debug.accessoryFeedback.ghostPet",
};

const PIKO_ACCESSORY_MENU_GROUPS = [
  [
    "none",
    "piko-accessory-golden-hoop-staff",
    "piko-accessory-little-king",
    "piko-accessory-bubble-balloon",
    "piko-accessory-ufo-pet",
    "piko-accessory-ghost-pet",
  ],
  [
    "piko-accessory-cyan-energy-sword",
    "piko-accessory-mengnan-wand",
    "piko-accessory-odin-hammer",
    "piko-accessory-fire-tipped-spear",
    "piko-accessory-dumbbell",
    "piko-accessory-thumbs-up",
    "piko-accessory-code-ling",
    "piko-accessory-code-yu",
    "piko-accessory-code-xia",
    "piko-accessory-code-ning",
  ],
  [
    "piko-accessory-founder-medal",
    "piko-accessory-red-star",
    "piko-accessory-dark-knight-mask",
    "piko-accessory-azu-mask",
    "piko-accessory-red-bow",
    "piko-accessory-minion-goggles",
    "piko-accessory-diver-goggles",
    "piko-accessory-gourd",
    "piko-accessory-judy-carrot",
    "piko-accessory-pacifier",
  ],
  [
    "piko-accessory-wizard-hat",
    "piko-accessory-bamboo-hat",
    "piko-accessory-asgard-horns",
    "piko-accessory-gary-snail",
    "piko-accessory-captain-shield",
    "piko-accessory-luban-compass",
    "piko-accessory-luban-talisman",
    "piko-accessory-red-cape",
  ],
] as const satisfies readonly (readonly PikoAccessoryDisplayId[])[];

type PetGalleryDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentKind: string;
  currentPet: PetdexCatalogEntry | null;
  currentAccessory: PikoAccessoryDisplayId;
  onConfirm: (selection: CompanionSelection, accessory: PikoAccessoryDisplayId) => void;
};

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `pet-${Date.now()}`;
}

function FileDrop({
  icon,
  title,
  hint,
  accept,
  file,
  onFile,
  matchFile,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  accept: string;
  file: File | null;
  onFile: (file: File | null) => void;
  matchFile: (file: File) => boolean;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    const dropped = Array.from(event.dataTransfer.files).find(matchFile);
    if (dropped) onFile(dropped);
  };

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={cn(
        "flex items-center gap-3 rounded-lg border border-dashed px-3 py-2.5 transition-colors",
        dragOver
          ? "border-[#d7ae5f] bg-[#d7ae5f]/10"
          : file
            ? "border-white/[0.14] bg-white/[0.055]"
            : "border-white/[0.1] bg-white/[0.025]",
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-white/[0.06] text-text-muted">
        {children ?? icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-text-dark">{file ? file.name : title}</span>
        <span className="truncate text-[11px] text-text-muted">
          {file ? `${Math.round(file.size / 1024)} KB` : hint}
        </span>
      </span>
      {file && <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 shrink-0 rounded-full border-white/[0.12] bg-white/[0.04] text-xs"
        onClick={() => inputRef.current?.click()}
      >
        {file ? t("myBuddy.import.replace") : t("myBuddy.import.choose")}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="sr-only"
        onChange={(event) => onFile(event.target.files?.[0] ?? null)}
      />
    </div>
  );
}

type CompanionCardProps = {
  title: string;
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
  accessoryControl?: React.ReactNode;
  onDelete?: () => void;
  contentClassName?: string;
};

function CompanionCard({
  title,
  selected,
  onSelect,
  children,
  accessoryControl,
  onDelete,
  contentClassName,
}: CompanionCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group relative flex h-[132px] min-w-0 cursor-pointer flex-col overflow-hidden rounded-[8px] border bg-white/[0.045] p-3 text-left transition-colors",
        selected
          ? "border-[#d7ae5f]/70 bg-[#d7ae5f]/[0.055]"
          : "border-white/[0.1] hover:border-white/[0.18] hover:bg-white/[0.06]",
      )}
      aria-pressed={selected}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0 truncate text-[13px] font-semibold leading-6 text-text-dark">{title}</div>
        <div className="flex shrink-0 items-center gap-1 overflow-visible">
          {accessoryControl}
          {onDelete && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
              className="flex h-7 w-7 items-center justify-center rounded-full text-text-muted opacity-0 transition-colors hover:bg-white/[0.08] hover:text-rose-300 group-hover:opacity-100"
              title="删除"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className={cn("flex min-h-0 flex-1 items-center justify-center pt-4", contentClassName)}>
        {children}
      </div>
    </div>
  );
}

export function PetGalleryDialog({
  open,
  onOpenChange,
  currentKind,
  currentPet,
  currentAccessory,
  onConfirm,
}: PetGalleryDialogProps) {
  const { t } = useTranslation();
  const companionHidden = useAppStore((state) => state.companionHidden);
  const setCompanionHidden = useAppStore((state) => state.setCompanionHidden);
  const [mode, setMode] = useState<ViewMode>("gallery");
  const [localPets, setLocalPets] = useState<PetdexCatalogEntry[]>([]);
  const [importedPets, setImportedPets] = useState<PetdexCatalogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [draftSelection, setDraftSelection] = useState<CompanionSelection>({
    kind: PIKO_COMPANION_KIND,
    pet: null,
  });
  const [draftAccessory, setDraftAccessory] =
    useState<PikoAccessoryDisplayId>(currentAccessory);
  const [accessoryMenuOpen, setAccessoryMenuOpen] = useState(false);
  const [accessoryPreview, setAccessoryPreview] = useState<AccessoryPreview | null>(null);
  const [accessoryFeedback, setAccessoryFeedback] = useState<AccessoryFeedback | null>(null);
  const accessoryFeedbackKeyRef = useRef(0);
  const accessoryFeedbackTimerRef = useRef<number | null>(null);
  const accessoryFeedbackStartTimerRef = useRef<number | null>(null);
  const accessoryButtonRef = useRef<HTMLButtonElement | null>(null);
  const selectedAccessoryOptionRef = useRef<HTMLButtonElement | null>(null);
  const [accessoryMenuPos, setAccessoryMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const importedUrlsRef = useRef<string[]>([]);

  const [spriteFile, setSpriteFile] = useState<File | null>(null);
  const [jsonFile, setJsonFile] = useState<File | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [spriteDims, setSpriteDims] = useState<{ w: number; h: number } | null>(null);

  const applyImported = useCallback((next: PetdexCatalogEntry[]) => {
    const previous = importedUrlsRef.current;
    importedUrlsRef.current = next.map((p) => p.spritesheetUrl);
    setImportedPets(next);
    previous.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  useEffect(() => {
    if (!open) return;
    setMode("gallery");
    setAccessoryMenuOpen(false);
    setDraftSelection(
      currentKind === PIKO_COMPANION_KIND || !currentPet
        ? { kind: PIKO_COMPANION_KIND, pet: null }
        : { kind: currentKind, pet: currentPet },
    );
    setDraftAccessory(currentAccessory);
    setAccessoryFeedback(null);
    if (accessoryFeedbackStartTimerRef.current !== null) {
      window.clearTimeout(accessoryFeedbackStartTimerRef.current);
      accessoryFeedbackStartTimerRef.current = null;
    }
  }, [open, currentKind, currentPet, currentAccessory]);

  useEffect(
    () => () => {
      if (accessoryFeedbackStartTimerRef.current !== null) {
        window.clearTimeout(accessoryFeedbackStartTimerRef.current);
      }
      if (accessoryFeedbackTimerRef.current !== null) {
        window.clearTimeout(accessoryFeedbackTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    Promise.all([loadImportedPets(), fetchLocalPets(controller.signal)])
      .then(([imported, local]) => {
        if (cancelled) {
          imported.forEach((p) => URL.revokeObjectURL(p.spritesheetUrl));
          return;
        }
        applyImported(imported);
        setLocalPets(local);
      })
      .catch(() => {
        if (cancelled) return;
        applyImported([]);
        setLocalPets([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, refreshKey, applyImported]);

  useEffect(
    () => () => {
      importedUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );

  useEffect(() => {
    if (!spriteFile) {
      setPreviewUrl(null);
      setSpriteDims(null);
      return;
    }
    const url = URL.createObjectURL(spriteFile);
    setPreviewUrl(url);
    setSpriteDims(null);
    const image = new Image();
    image.onload = () => setSpriteDims({ w: image.naturalWidth, h: image.naturalHeight });
    image.src = url;
    return () => URL.revokeObjectURL(url);
  }, [spriteFile]);

  const resetImport = useCallback(() => {
    setSpriteFile(null);
    setJsonFile(null);
    setImportError(null);
  }, []);

  const handleRequestClose = useCallback(() => {
    setAccessoryMenuOpen(false);
    if (mode === "import") {
      resetImport();
      setMode("gallery");
      return;
    }
    onOpenChange(false);
  }, [mode, onOpenChange, resetImport]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleRequestClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, handleRequestClose]);

  const updateAccessoryMenuPosition = useCallback(() => {
    const button = accessoryButtonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(520, window.innerWidth - margin * 2);
    const height = 316;
    const canOpenRight = rect.right + 6 + width <= window.innerWidth - margin;
    const maxTop = Math.max(margin, window.innerHeight - height - margin);
    setAccessoryMenuPos({
      top: Math.round(Math.min(Math.max(rect.top - 4, margin), maxTop)),
      width: Math.round(width),
      left: Math.round(
        canOpenRight
          ? rect.right + 6
          : Math.max(margin, rect.left - width - 6),
      ),
    });
  }, []);

  useEffect(() => {
    if (!accessoryMenuOpen) {
      setAccessoryPreview(null);
      return;
    }
    updateAccessoryMenuPosition();

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (accessoryButtonRef.current?.contains(target)) return;
      const menu = document.getElementById("piko-accessory-menu");
      if (menu?.contains(target)) return;
      setAccessoryMenuOpen(false);
    };
    const handleReposition = () => {
      setAccessoryPreview(null);
      updateAccessoryMenuPosition();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
    };
  }, [accessoryMenuOpen, updateAccessoryMenuPosition]);

  useEffect(() => {
    if (!accessoryMenuOpen) return;
    const frame = window.requestAnimationFrame(() => {
      selectedAccessoryOptionRef.current?.scrollIntoView({ block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [accessoryMenuOpen, draftAccessory]);

  const handleImport = async () => {
    if (!spriteFile) return;
    setImportBusy(true);
    setImportError(null);
    try {
      let displayName = spriteFile.name.replace(/\.[^.]+$/, "");
      let slug = slugify(spriteFile.name);
      let submittedBy: string | undefined;
      let cols: number | undefined;
      let rows: number | undefined;
      if (jsonFile) {
        const meta = JSON.parse(await jsonFile.text()) as Record<string, unknown>;
        const id = meta.id ?? meta.slug;
        if (typeof id === "string" && id.trim()) slug = slugify(id);
        const dn = meta.displayName ?? meta.name;
        if (typeof dn === "string" && dn.trim()) displayName = dn.trim();
        if (typeof meta.submittedBy === "string") submittedBy = meta.submittedBy;
        if (typeof meta.cols === "number") cols = meta.cols;
        if (typeof meta.rows === "number") rows = meta.rows;
      }
      const gridCols = cols ?? PETDEX_GRID_COLS;
      const gridRows = rows ?? PETDEX_GRID_ROWS;
      if (spriteDims && (spriteDims.w % gridCols !== 0 || spriteDims.h % gridRows !== 0)) {
        setImportError(
          t("myBuddy.import.gridError", {
            cols: gridCols,
            rows: gridRows,
            w: spriteDims.w,
            h: spriteDims.h,
          }),
        );
        setImportBusy(false);
        return;
      }
      await savePetRecord({ slug, displayName, submittedBy, cols, rows, blob: spriteFile, addedAt: Date.now() });
      window.dispatchEvent(new Event("mybuddy-imported-pets-changed"));
      resetImport();
      setMode("gallery");
      setRefreshKey((key) => key + 1);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImportBusy(false);
    }
  };

  const handleDelete = useCallback(
    async (slug: string) => {
      await deletePetRecord(slug);
      window.dispatchEvent(new Event("mybuddy-imported-pets-changed"));
      const next = await loadImportedPets();
      applyImported(next);
      if (draftSelection.kind === slug) {
        setDraftSelection({ kind: PIKO_COMPANION_KIND, pet: null });
      }
    },
    [applyImported, draftSelection.kind],
  );

  const pets = useMemo(() => [...localPets, ...importedPets], [localPets, importedPets]);

  const handleAccessorySelect = useCallback(
    (accessory: PikoAccessoryDisplayId) => {
      const shouldFeedback = accessory !== draftAccessory;
      setDraftAccessory(accessory);
      setAccessoryMenuOpen(false);

      if (!shouldFeedback) return;
      if (accessoryFeedbackStartTimerRef.current !== null) {
        window.clearTimeout(accessoryFeedbackStartTimerRef.current);
      }
      if (accessoryFeedbackTimerRef.current !== null) {
        window.clearTimeout(accessoryFeedbackTimerRef.current);
      }
      setAccessoryFeedback(null);
      accessoryFeedbackStartTimerRef.current = window.setTimeout(() => {
        accessoryFeedbackStartTimerRef.current = null;
        accessoryFeedbackKeyRef.current += 1;
        setAccessoryFeedback({
          id: accessoryFeedbackKeyRef.current,
          textKey: PIKO_ACCESSORY_FEEDBACK_KEYS[accessory],
        });
        accessoryFeedbackTimerRef.current = window.setTimeout(() => {
          setAccessoryFeedback(null);
          accessoryFeedbackTimerRef.current = null;
        }, 1800);
      }, 100);
    },
    [draftAccessory],
  );

  const showAccessoryPreview = useCallback(
    (nextAccessory: PikoAccessoryDisplayId) => {
      const previewSrc = getAccessoryPreviewSrc(nextAccessory);
      if (!previewSrc) {
        setAccessoryPreview(null);
        return;
      }
      setAccessoryPreview({ src: previewSrc });
    },
    [],
  );

  if (!open) return null;

  const accessoryLabel =
    PIKO_ACCESSORY_DISPLAY_OPTIONS.find((option) => option.id === draftAccessory)?.labelKey ??
    "myBuddy.debug.accessories.none";

  const content = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/48 p-6 backdrop-blur-md"
      onClick={handleRequestClose}
    >
      <div
        className="relative flex max-h-[88vh] w-full max-w-[760px] flex-col rounded-[12px] border border-white/[0.08] bg-[#121212]/82 shadow-[0_18px_58px_rgba(0,0,0,0.56)] backdrop-blur-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        {mode === "gallery" ? (
          <div className="petdex-gallery-title-badge pointer-events-none absolute left-[14px] -top-[56px] z-10 h-[119px] w-[238px] -rotate-5">
            <img
              src="/images/companion-title-ok-buddy.png"
              alt={t("myBuddy.companion.titleBadgeAlt")}
              className="petdex-gallery-title-badge__image h-full w-full object-contain object-left drop-shadow-[0_12px_18px_rgba(0,0,0,0.45)]"
              draggable={false}
            />
          </div>
        ) : null}
        <header
          className={cn(
            "flex items-start justify-between pl-5 pr-3",
            mode === "gallery" ? "pb-1 pt-2" : "pb-3 pt-4",
          )}
        >
          {mode === "gallery" ? <span aria-hidden="true" /> : (
            <h2 className="pt-1 text-[15px] font-semibold text-text-dark">
              {t("myBuddy.import.title")}
            </h2>
          )}
          <div className="flex translate-x-1 translate-y-[2px] items-center gap-2 pt-2">
            {mode === "gallery" ? (
              <button
                type="button"
                role="switch"
                aria-checked={!companionHidden}
                onClick={() => setCompanionHidden(!companionHidden)}
                title={t("myBuddy.companion.toggleVisibility")}
                className="flex h-7 items-center gap-2 rounded-full px-2.5 text-[11px] text-text-dark/88 transition-colors hover:bg-white/[0.08] hover:text-white"
              >
                <span>{t("myBuddy.companion.toggleVisibility")}</span>
                <span
                  className={cn(
                    "relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full transition-colors",
                    companionHidden ? "bg-white/20" : "bg-[rgb(var(--accent-rgb))]",
                  )}
                >
                  <span
                    className={cn(
                      "absolute h-2.5 w-2.5 rounded-full bg-white transition-transform",
                      companionHidden ? "translate-x-0.5" : "translate-x-[13px]",
                    )}
                  />
                </span>
              </button>
            ) : null}
            {mode === "gallery" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 rounded-full !border-white/[0.16] !bg-white/[0.035] px-2.5 text-[11px] !text-text-dark/88 shadow-none hover:!border-white/[0.28] hover:!bg-white/[0.08] hover:!text-white"
                onClick={() => setMode("import")}
              >
                {t("myBuddy.companion.importCta")}
              </Button>
            ) : null}
            <button
              type="button"
              onClick={handleRequestClose}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-dark/70 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
              title={t("common.close")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        {mode === "gallery" ? (
          <div className="ui-scrollbar min-h-0 overflow-y-auto px-5 pb-4 pt-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              <CompanionCard
                title="Piko"
                selected={draftSelection.kind === PIKO_COMPANION_KIND}
                contentClassName="pt-1"
                onSelect={() => setDraftSelection({ kind: PIKO_COMPANION_KIND, pet: null })}
                accessoryControl={
                  <div
                    className="relative"
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <button
                      ref={accessoryButtonRef}
                      type="button"
                      className="flex h-5 max-w-[76px] items-center gap-1 rounded-full border border-white/[0.1] bg-white/[0.08] px-1.5 text-[10px] leading-none text-text-dark transition-colors hover:border-white/[0.2] hover:bg-white/[0.12] hover:text-white"
                      aria-label={t("myBuddy.debug.accessoryPreview")}
                      aria-expanded={accessoryMenuOpen}
                      aria-controls={accessoryMenuOpen ? "piko-accessory-menu" : undefined}
                      onClick={() => {
                        updateAccessoryMenuPosition();
                        setAccessoryMenuOpen((value) => !value);
                      }}
                    >
                      <span className="truncate">{t(accessoryLabel)}</span>
                      <ChevronRight className="size-3 shrink-0 text-text-muted" />
                    </button>
                  </div>
                }
              >
                <div className="petdex-piko-accessory-feedback">
                  <PikoActionFigure
                    action="idle"
                    accessory={draftAccessory}
                    className="mybuddy-companion-anchor--preview"
                    style={{ transform: "translateY(20px)" }}
                  />
                  {accessoryFeedback ? (
                    <>
                      <div
                        key={`burst-${accessoryFeedback.id}`}
                        className="petdex-piko-accessory-flash"
                        aria-hidden="true"
                      >
                        <span />
                        <span />
                        <span />
                        <span />
                      </div>
                      <div
                        key={`bubble-${accessoryFeedback.id}`}
                        className="petdex-piko-accessory-bubble"
                      >
                        {t(accessoryFeedback.textKey)}
                      </div>
                    </>
                  ) : null}
                </div>
              </CompanionCard>

              {loading && (
                <div className="col-span-full flex items-center justify-center gap-2 py-12 text-[13px] text-text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" /> {t("myBuddy.gallery.loading")}
                </div>
              )}

              {!loading &&
                pets.map((pet) => (
                  <CompanionCard
                    key={pet.slug}
                    title={pet.displayName}
                    selected={draftSelection.kind === pet.slug}
                    onSelect={() => setDraftSelection({ kind: pet.slug, pet })}
                    onDelete={pet.imported ? () => void handleDelete(pet.slug) : undefined}
                  >
                    <SpritePetCompanion
                      pet={pet}
                      action="idle"
                      style={{
                        position: "relative",
                        top: "auto",
                        left: "auto",
                        transform: "translateY(-2px) scale(0.86)",
                        transformOrigin: "center center",
                      }}
                    />
                  </CompanionCard>
                ))}

              {!loading && pets.length === 0 && (
                <div className="col-span-full flex items-center justify-center py-12 text-center text-[13px] text-text-muted">
                  {t("myBuddy.gallery.empty")}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-4 px-5 pb-3">
            <p className="max-w-[560px] text-[12px] leading-relaxed text-text-muted">
              {t("myBuddy.import.desc")}
            </p>
            <div className="flex flex-col gap-2.5">
              <FileDrop
                icon={<ImageUp className="size-4" />}
                title={t("myBuddy.import.spritesheetTitle")}
                hint={t("myBuddy.import.spritesheetHint")}
                accept=".webp,.png,image/webp,image/png"
                file={spriteFile}
                onFile={setSpriteFile}
                matchFile={(file) => /\.(webp|png)$/i.test(file.name) || file.type.startsWith("image/")}
              >
                {previewUrl ? (
                  <PetSpriteThumbnail url={previewUrl} className="size-9 rounded-md" />
                ) : undefined}
              </FileDrop>
              <FileDrop
                icon={<FileJson className="size-4" />}
                title={t("myBuddy.import.jsonTitle")}
                hint={t("myBuddy.import.jsonHint")}
                accept=".json,application/json"
                file={jsonFile}
                onFile={setJsonFile}
                matchFile={(file) => /\.json$/i.test(file.name) || file.type === "application/json"}
              />
              {importError && <p className="text-xs text-destructive">{importError}</p>}
              <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-text-muted">
                <UploadCloud className="mt-0.5 size-3.5 shrink-0" />
                {t("myBuddy.import.hint")}
              </p>
            </div>
          </div>
        )}

        <footer
          className={cn(
            "flex shrink-0 items-center justify-end gap-2 bg-transparent px-5",
            mode === "gallery" ? "pb-3 pt-2" : "py-3",
          )}
        >
          {mode === "import" ? (
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  resetImport();
                  setMode("gallery");
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button
                className={PRIMARY_ACTION_BUTTON_CLASS}
                disabled={!spriteFile || importBusy}
                onClick={handleImport}
              >
                {t("myBuddy.import.confirm")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                className={PRIMARY_ACTION_BUTTON_CLASS}
                onClick={() => {
                  onConfirm(draftSelection, draftAccessory);
                  onOpenChange(false);
                }}
              >
                {t("common.confirm")}
              </Button>
            </>
          )}
        </footer>
      </div>
    </div>
  );

  return (
    <>
      {createPortal(content, document.body)}
      {accessoryMenuOpen && accessoryMenuPos
        ? createPortal(
            <div
              id="piko-accessory-menu"
              className="petdex-accessory-menu-scroll fixed z-[150] max-h-[316px] overflow-y-auto rounded-[10px] border border-white/[0.12] bg-[#202326]/88 p-2 text-xs text-slate-100 shadow-[0_14px_34px_rgba(0,0,0,0.42)] backdrop-blur-2xl"
              style={{ top: accessoryMenuPos.top, left: accessoryMenuPos.left, width: accessoryMenuPos.width }}
              onPointerLeave={() => setAccessoryPreview(null)}
              onScroll={() => setAccessoryPreview(null)}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="grid grid-cols-[repeat(auto-fit,minmax(108px,1fr))] gap-1.5">
                {PIKO_ACCESSORY_MENU_GROUPS.map((group, groupIndex) => (
                  <div
                    key={group.join("-")}
                    className={cn("flex min-w-0 flex-col gap-1", groupIndex > 0 && "pl-1.5")}
                  >
                    {group.map((id) => {
                      const option = PIKO_ACCESSORY_DISPLAY_OPTIONS.find((item) => item.id === id);
                      if (!option) return null;
                      return (
                        <button
                          type="button"
                          key={option.id}
                          ref={option.id === draftAccessory ? selectedAccessoryOptionRef : undefined}
                          className={cn(
                            "flex h-7 w-full min-w-0 items-center rounded-[6px] px-2 text-left text-xs leading-none text-slate-100 transition-colors hover:bg-white/[0.08] hover:text-white",
                            draftAccessory === option.id && "bg-white/[0.1] text-white",
                          )}
                          onPointerEnter={() => showAccessoryPreview(option.id)}
                          onFocus={() => showAccessoryPreview(option.id)}
                          onClick={() => handleAccessorySelect(option.id)}
                        >
                          <span className="truncate">{t(option.labelKey)}</span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
      {accessoryMenuOpen && accessoryPreview
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[151] flex h-[76px] w-[76px] items-center justify-center rounded-[8px] border border-white/[0.08] bg-[#151719]/84 shadow-[0_8px_18px_rgba(0,0,0,0.26)] backdrop-blur-md"
              style={
                accessoryMenuPos
                  ? {
                      top: Math.min(
                        Math.max(8, accessoryMenuPos.top + 8),
                        window.innerHeight - ACCESSORY_PREVIEW_HEIGHT - 8,
                      ),
                      left:
                        Math.min(
                          accessoryMenuPos.left +
                            accessoryMenuPos.width +
                            ACCESSORY_PREVIEW_GAP,
                          window.innerWidth - ACCESSORY_PREVIEW_WIDTH - 8,
                        ),
                    }
                  : undefined
              }
              aria-hidden="true"
            >
              <img
                src={accessoryPreview.src}
                alt=""
                className="h-14 w-14 object-contain [image-rendering:pixelated]"
                draggable={false}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
