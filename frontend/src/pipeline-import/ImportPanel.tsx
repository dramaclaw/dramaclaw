// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFn } from "@/lib/i18n-types";
import { isAutoEpisodeTitle } from "@/lib/episode-title";
import {
  listCharacters,
  listEpisodes,
  listBeats,
  deriveSketchUrl,
  deriveDirectorRenderUrl,
  type SupertaleCharacter,
  type SupertaleEpisodeSummary,
  type SupertaleBeat,
} from "@/api/projects";
import {
  UiButton,
  UiCheckbox,
  UiChipButton,
  UiModal,
  UiSelect,
} from "@/components/ui/primitives";

export type AssetKind =
  | "identity"
  | "portrait"
  | "frame"
  | "sketch"
  | "director_render";

export interface ImportableAsset {
  /** Stable id for dedup. */
  id: string;
  kind: AssetKind;
  url: string;
  label: string;
  /** Original beat / character context, kept for downstream Push targeting. */
  meta: {
    project: string;
    episode?: number;
    beat?: number;
    character?: string;
    identity_id?: string;
  };
}

interface ImportPanelProps {
  project: string;
  onClose: () => void;
  onImport: (assets: ImportableAsset[]) => void;
}

interface KindToggles {
  identity: boolean;
  portrait: boolean;
  frame: boolean;
  sketch: boolean;
  director_render: boolean;
}

const DEFAULT_KIND_TOGGLES: KindToggles = {
  identity: true,
  portrait: false,
  frame: true,
  sketch: false,
  director_render: false,
};

export function ImportPanel({ project, onClose, onImport }: ImportPanelProps) {
  const { t } = useTranslation();
  const [characters, setCharacters] = useState<SupertaleCharacter[]>([]);
  const [episodes, setEpisodes] = useState<SupertaleEpisodeSummary[]>([]);
  const [selectedCharacters, setSelectedCharacters] = useState<Set<string>>(new Set());
  const [selectedEpisode, setSelectedEpisode] = useState<number | null>(null);
  const [beats, setBeats] = useState<SupertaleBeat[]>([]);
  const [selectedBeats, setSelectedBeats] = useState<Set<number>>(new Set());
  const [kinds, setKinds] = useState<KindToggles>(DEFAULT_KIND_TOGGLES);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Fetch characters + episodes once.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([listCharacters(project), listEpisodes(project)])
      .then(([chars, eps]) => {
        if (cancelled) return;
        setCharacters(chars);
        setEpisodes(eps);
        setSelectedCharacters(new Set(chars.map((c) => c.name)));
        if (eps.length > 0) {
          const firstEp =
            typeof eps[0].episode_num === "number" ? eps[0].episode_num : 1;
          setSelectedEpisode(firstEp);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t("pipelineImport.import.loadFailed"));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project, t]);

  useEffect(() => {
    let cancelled = false;
    if (selectedEpisode === null) {
      setBeats([]);
      setSelectedBeats(new Set());
      return;
    }
    listBeats(project, selectedEpisode)
      .then((bts) => {
        if (cancelled) return;
        setBeats(bts);
        setSelectedBeats(
          new Set(bts.map((_, idx) => idx + 1).filter((n) => Number.isFinite(n))),
        );
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("[freezone] listBeats failed:", err);
        setBeats([]);
        setSelectedBeats(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [project, selectedEpisode]);

  const previewAssets = useMemo(
    () =>
      collectAssets({
        project,
        characters,
        selectedCharacters,
        beats,
        selectedBeats,
        episode: selectedEpisode,
        kinds,
        t,
      }),
    [project, characters, selectedCharacters, beats, selectedBeats, selectedEpisode, kinds, t],
  );

  const handleSubmit = () => {
    if (previewAssets.length === 0) return;
    setSubmitting(true);
    try {
      onImport(previewAssets);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const footer = (
    <>
      <div className="mr-auto text-xs text-text-muted self-center">
        {t("pipelineImport.import.willImport", { count: previewAssets.length })}
      </div>
      <UiButton variant="ghost" size="sm" onClick={onClose}>
        {t("common.cancel")}
      </UiButton>
      <UiButton
        variant="primary"
        size="sm"
        onClick={handleSubmit}
        disabled={previewAssets.length === 0 || submitting}
      >
        {submitting ? t("pipelineImport.import.submitting") : t("pipelineImport.import.submit")}
      </UiButton>
    </>
  );

  return (
    <UiModal
      isOpen
      title={t("pipelineImport.import.title")}
      onClose={onClose}
      footer={footer}
      widthClassName="w-[640px]"
    >
      <div className="text-xs text-text-muted -mt-1 mb-3">
        {t("pipelineImport.import.project", { project })}
      </div>

      <div className="ui-scrollbar max-h-[60vh] overflow-y-auto space-y-5 -mx-1 px-1">
        {loading ? (
          <div className="text-sm text-text-muted py-8 text-center">{t("common.loading")}</div>
        ) : error ? (
          <div className="text-sm text-red-400 py-8 text-center">{error}</div>
        ) : (
          <>
            <Section title={t("pipelineImport.import.assetKinds")}>
              <KindToggleRow
                label={t("pipelineImport.import.kind.identity")}
                checked={kinds.identity}
                onChange={(v) => setKinds({ ...kinds, identity: v })}
              />
              <KindToggleRow
                label={t("pipelineImport.import.kind.portrait")}
                checked={kinds.portrait}
                onChange={(v) => setKinds({ ...kinds, portrait: v })}
              />
              <KindToggleRow
                label={t("pipelineImport.import.kind.frame")}
                checked={kinds.frame}
                onChange={(v) => setKinds({ ...kinds, frame: v })}
              />
              <KindToggleRow
                label={t("pipelineImport.import.kind.sketch")}
                checked={kinds.sketch}
                onChange={(v) => setKinds({ ...kinds, sketch: v })}
              />
              <KindToggleRow
                label={t("pipelineImport.import.kind.directorRender")}
                checked={kinds.director_render}
                onChange={(v) => setKinds({ ...kinds, director_render: v })}
              />
            </Section>

            {(kinds.identity || kinds.portrait) && (
              <Section title={t("pipelineImport.createIdentity.character")}>
                {characters.length === 0 ? (
                  <div className="text-xs text-text-muted">{t("pipelineImport.import.noCharacters")}</div>
                ) : (
                  <CharactersList
                    characters={characters}
                    selected={selectedCharacters}
                    onToggle={(name) => {
                      const next = new Set(selectedCharacters);
                      if (next.has(name)) next.delete(name);
                      else next.add(name);
                      setSelectedCharacters(next);
                    }}
                  />
                )}
              </Section>
            )}

            {(kinds.frame || kinds.sketch || kinds.director_render) && (
              <Section title={t("pipelineImport.import.episodeBeat")}>
                <EpisodePicker
                  episodes={episodes}
                  selectedEpisode={selectedEpisode}
                  onSelect={setSelectedEpisode}
                />
                {beats.length > 0 && (
                  <BeatRange
                    total={beats.length}
                    selected={selectedBeats}
                    onChange={setSelectedBeats}
                  />
                )}
              </Section>
            )}
          </>
        )}
      </div>
    </UiModal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-semibold text-text-muted mb-2 uppercase tracking-wide">
        {title}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function KindToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      className="flex items-center gap-2 cursor-pointer text-sm text-text-dark rounded px-1 py-1 hover:bg-bg-dark/40 transition"
      onClick={() => onChange(!checked)}
    >
      <UiCheckbox
        checked={checked}
        onCheckedChange={onChange}
        onClick={(e) => e.stopPropagation()}
      />
      <span className="select-none">{label}</span>
    </div>
  );
}

function CharactersList({
  characters,
  selected,
  onToggle,
}: {
  characters: SupertaleCharacter[];
  selected: Set<string>;
  onToggle: (name: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-1">
      {characters.map((c) => {
        const idCount = c.identities?.length ?? 0;
        return (
          <div
            key={c.name}
            className="flex items-center gap-2 cursor-pointer text-sm text-text-dark px-2 py-1 rounded hover:bg-bg-dark/40 transition"
            onClick={() => onToggle(c.name)}
          >
            <UiCheckbox
              checked={selected.has(c.name)}
              onCheckedChange={() => onToggle(c.name)}
              onClick={(e) => e.stopPropagation()}
            />
            <span className="truncate select-none">{c.display_name || c.name}</span>
            {idCount > 0 && (
              <span className="text-xs text-text-muted ml-auto shrink-0">{idCount}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function EpisodePicker({
  episodes,
  selectedEpisode,
  onSelect,
}: {
  episodes: SupertaleEpisodeSummary[];
  selectedEpisode: number | null;
  onSelect: (ep: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 text-sm text-text-dark">
      <span className="text-text-muted text-xs shrink-0">
        {t("pipelineImport.import.episodeLabel")}
      </span>
      <div className="flex-1">
        <UiSelect
          value={selectedEpisode ?? ""}
          onChange={(e) => onSelect(Number(e.target.value))}
        >
          {episodes.map((ep) => (
            <option key={ep.episode_num} value={ep.episode_num}>
              ep{ep.episode_num}{" "}
              {ep.title && !isAutoEpisodeTitle(ep.title, ep.episode_num)
                ? `- ${ep.title}`
                : ""}
            </option>
          ))}
        </UiSelect>
      </div>
    </div>
  );
}

function BeatRange({
  total,
  selected,
  onChange,
}: {
  total: number;
  selected: Set<number>;
  onChange: (v: Set<number>) => void;
}) {
  const { t } = useTranslation();
  const allSelected = selected.size === total;
  const noneSelected = selected.size === 0;
  const setAll = () => onChange(new Set(Array.from({ length: total }, (_, i) => i + 1)));
  const setNone = () => onChange(new Set());

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-text-muted">
          Beats ({selected.size}/{total}):
        </span>
        <UiButton
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={setAll}
          disabled={allSelected}
        >
          {t("pipelineImport.import.selectAll")}
        </UiButton>
        <UiButton
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={setNone}
          disabled={noneSelected}
        >
          {t("pipelineImport.import.selectNone")}
        </UiButton>
      </div>
      <div className="ui-scrollbar grid grid-cols-8 gap-1 max-h-32 overflow-y-auto pr-1">
        {Array.from({ length: total }, (_, i) => {
          const beatNum = i + 1;
          const isSelected = selected.has(beatNum);
          return (
            <UiChipButton
              key={beatNum}
              active={isSelected}
              className="h-8 px-0 justify-center text-xs"
              onClick={() => {
                const next = new Set(selected);
                if (next.has(beatNum)) next.delete(beatNum);
                else next.add(beatNum);
                onChange(next);
              }}
            >
              {beatNum}
            </UiChipButton>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Preview computation ---------- //

interface CollectArgs {
  project: string;
  characters: SupertaleCharacter[];
  selectedCharacters: Set<string>;
  beats: SupertaleBeat[];
  selectedBeats: Set<number>;
  episode: number | null;
  kinds: KindToggles;
  t: TFn;
}

function collectAssets(args: CollectArgs): ImportableAsset[] {
  const out: ImportableAsset[] = [];

  // Identity / portrait — character-driven
  for (const c of args.characters) {
    if (!args.selectedCharacters.has(c.name)) continue;
    if (args.kinds.identity && c.identities) {
      for (const id of c.identities) {
        const url = id.url || id.image_url;
        if (!url) continue;
        const idKey = id.identity_id || id.id || id.name || "";
        out.push({
          id: `identity:${args.project}:${c.name}:${idKey}`,
          kind: "identity",
          url,
          label: `${c.display_name || c.name} · ${idKey || args.t("pipelineImport.import.identityFallbackLabel")}`,
          meta: {
            project: args.project,
            character: c.name,
            identity_id: idKey,
          },
        });
      }
    }
    if (args.kinds.portrait && c.portrait_url) {
      out.push({
        id: `portrait:${args.project}:${c.name}`,
        kind: "portrait",
        url: c.portrait_url,
        label: `${c.display_name || c.name} · ${args.t("pipelineImport.import.portraitLabel")}`,
        meta: { project: args.project, character: c.name },
      });
    }
  }

  // Frame / sketch / director_render — beat-driven
  if (args.episode !== null) {
    for (let i = 0; i < args.beats.length; i++) {
      const beat = args.beats[i];
      const beatNum = beat.beat_number ?? i + 1;
      if (!args.selectedBeats.has(beatNum)) continue;
      if (args.kinds.frame && beat.frame_url) {
        out.push({
          id: `frame:${args.project}:ep${args.episode}:beat${beatNum}`,
          kind: "frame",
          url: beat.frame_url,
          label: `ep${args.episode} · beat ${beatNum} · frame`,
          meta: { project: args.project, episode: args.episode, beat: beatNum },
        });
      }
      const anchorUrl = beat.frame_url || beat.video_url || beat.audio_url;
      if (args.kinds.sketch) {
        const sketchUrl = deriveSketchUrl(anchorUrl, args.episode, beatNum);
        if (sketchUrl) {
          out.push({
            id: `sketch:${args.project}:ep${args.episode}:beat${beatNum}`,
            kind: "sketch",
            url: sketchUrl,
            label: `ep${args.episode} · beat ${beatNum} · sketch`,
            meta: { project: args.project, episode: args.episode, beat: beatNum },
          });
        }
      }
      if (args.kinds.director_render) {
        const drUrl = deriveDirectorRenderUrl(anchorUrl, args.episode, beatNum);
        if (drUrl) {
          out.push({
            id: `director_render:${args.project}:ep${args.episode}:beat${beatNum}`,
            kind: "director_render",
            url: drUrl,
            label: `ep${args.episode} · beat ${beatNum} · ${args.t("pipelineImport.import.directorRenderLabel")}`,
            meta: { project: args.project, episode: args.episode, beat: beatNum },
          });
        }
      }
    }
  }

  return out;
}
