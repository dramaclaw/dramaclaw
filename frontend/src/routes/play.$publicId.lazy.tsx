import { createLazyFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  AlertCircle,
  LoaderCircle,
  Maximize,
  Play,
} from "lucide-react";
import { StoryLanding } from "@/features/canvas/story/StoryLanding";
import "@/features/canvas/story/publication.css";
import { StoryPlayer } from "@/features/canvas/story/StoryPlayer";
import { useStoryRuntimeStore } from "@/stores/storyRuntimeStore";
import {
  compilePlayback,
  playerSaveKey,
  rememberVersion,
  savedVersion,
  type PlayerVersion,
} from "@/features/canvas/story/publication";
import { readStorySave } from "@/features/canvas/story/storySave";
import {
  loadPublishedVersion,
  PlaybackLoadError,
} from "@/features/canvas/story/publication-ui";
import { Button } from "@/components/ui/button";

export const Route = createLazyFileRoute("/play/$publicId")({
  component: PlayPage,
});
function PlayPage() {
  const { publicId } = Route.useParams();
  return <PublishedStoryPage publicId={publicId} />;
}
export function PublishedStoryPage({ publicId }: { publicId: string }) {
  const { t } = useTranslation();
  const [release, setRelease] = useState<PlayerVersion | null>(null);
  const [sessionRelease, setSessionRelease] = useState<PlayerVersion | null>(null);
  const [error, setError] = useState<"unavailable" | "network" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState(0);
  const stageRef = useRef<HTMLElement>(null);
  const [fullscreenError, setFullscreenError] = useState(false);
  const startRequest = useRef<AbortController | null>(null);
  const previous = savedVersion(publicId);
  const canResume =
    previous && readStorySave(playerSaveKey(publicId, previous));
  useEffect(() => {
    let active = true;
    setRelease(null);
    setError(null);
    setPlaying(false);
    setBusy(false);
    const controller = new AbortController();
    loadPublishedVersion(publicId, undefined, controller.signal)
      .then((data) => {
        if (active) setRelease(data);
      })
      .catch((e) => {
        if (active)
          setError(e instanceof PlaybackLoadError ? e.reason : "network");
      });
    return () => {
      active = false;
      controller.abort();
      startRequest.current?.abort();
      useStoryRuntimeStore.getState().exitPlay();
    };
  }, [publicId, attempt]);
  async function start(resume: boolean) {
    if (!release || busy) return;
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    startRequest.current = controller;
    try {
      const selected = await loadPublishedVersion(
        publicId,
        resume && previous ? previous : undefined,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (!selected.snapshot) throw new Error();
      useStoryRuntimeStore
        .getState()
        .enterPlay(compilePlayback(selected.snapshot), {
          saveKey: playerSaveKey(publicId, selected.version),
        });
      if (resume) useStoryRuntimeStore.getState().resumeSaved();
      else useStoryRuntimeStore.getState().startFresh();
      rememberVersion(publicId, selected.version);
      setSessionRelease(selected);
      if (!resume) setRelease(selected);
      setFullscreenError(false);
      setSession((s) => s + 1);
      setPlaying(true);
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(e instanceof PlaybackLoadError ? e.reason : "network");
      setPlaying(false);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stageRef.current?.requestFullscreen();
    } catch {
      setFullscreenError(true);
    }
  }
  function returnToCover() {
    if (document.fullscreenElement)
      void document.exitFullscreen().catch(() => {});
    useStoryRuntimeStore.getState().exitPlay();
    setPlaying(false);
  }
  if (playing)
    return (
      <main
        ref={stageRef}
        className="publication-surface published-story-stage fixed inset-0"
      >
        <div className="published-story-stage-toolbar">
          <Button variant="ghost" onClick={returnToCover}>
            <ArrowLeft size={16} aria-hidden="true" />
            {t("storyPublication.returnToCover")}
          </Button>
          <span className="published-story-stage-title">{sessionRelease?.title}</span>
          {typeof document.documentElement.requestFullscreen === "function" && (
            <Button
              variant="ghost"
              aria-label={t("storyPublication.fullscreen")}
              onClick={() => void toggleFullscreen()}
            >
              <Maximize size={18} aria-hidden="true" />
            </Button>
          )}
        </div>
        {fullscreenError && (
          <p role="status" className="publication-muted px-4 py-2">
            {t("storyPublication.fullscreenFailed")}
          </p>
        )}
        <div className="published-story-video">
          <StoryPlayer
            t={t}
            revision={session}
            onRestart={() => void start(false)}
          />
        </div>
      </main>
    );
  return (
    <main className="publication-surface min-h-dvh">
      {error && !release ? (
        <div className="published-story-empty">
          <AlertCircle size={24} aria-hidden="true" />
          <h1>
            {t(
              `storyPublication.${error === "unavailable" ? "unavailable" : "networkError"}`,
            )}
          </h1>
          <p className="publication-muted">
            {t(
              `storyPublication.${error === "unavailable" ? "unavailableHint" : "networkHint"}`,
            )}
          </p>
          <Button
            className="publication-primary"
            onClick={() => setAttempt((a) => a + 1)}
          >
            {t("storyPublication.retry")}
          </Button>
        </div>
      ) : !release ? (
        <div className="published-story-empty" role="status">
          <LoaderCircle
            className="motion-safe:animate-spin"
            aria-hidden="true"
          />
          <p>{t("storyPublication.loading")}</p>
        </div>
      ) : (
        <div className="published-story-main" data-cover-mode={release.cover_mode ?? "landscape"}>
          <StoryLanding release={release}>
              {error && (
                <p role="alert" className="publication-note mb-4!">
                  {t("storyPublication.resumeFailed")}
                </p>
              )}
              <div className="published-story-actions">
                <Button
                  className="publication-primary"
                  disabled={busy}
                  onClick={() => void start(Boolean(canResume))}
                >
                  {busy ? (
                    <LoaderCircle
                      className="motion-safe:animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Play size={16} aria-hidden="true" />
                  )}
                  {t(
                    busy
                      ? "storyPublication.starting"
                      : canResume
                        ? "storyPublication.continue"
                        : "storyPublication.start",
                  )}
                </Button>
                {canResume && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void start(false)}
                  >
                    {t("storyPublication.startFresh")}
                  </Button>
                )}
              </div>
          </StoryLanding>
        </div>
      )}
    </main>
  );
}
