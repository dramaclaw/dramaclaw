import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  X,
  Check,
  Copy,
  ExternalLink,
  SquarePen,
  EyeOff,
  Eye,
  LoaderCircle,
  Upload,
  Play,
} from "lucide-react";
import { authorPreviewSnapshot, authorPreviewUrl } from "./publication-ui";
import { StoryCover } from "./StoryCover";
import { StoryLanding } from "./StoryLanding";
import "./publication.css";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { apiCall } from "@/api/client";
import { getFreezoneCanvas } from "@/api/canvas";
import { flushFreezoneCanvasRuntime } from "@/features/freezone/canvasSyncRuntime";
import { readUrl } from "@/lib/url-params";
import { StoryPlayer } from "./StoryPlayer";
import { useCanvasStore } from "@/stores/canvasStore";
import { useStoryRuntimeStore } from "@/stores/storyRuntimeStore";
import {
  compilePlayback,
  type Publication,
  type PublishedVersion,
} from "./publication";

function publicationErrorCode(error: unknown): string | null {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length) {
    const value = pending.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (typeof record.code === "string") return record.code;
    pending.push(record.cause, record.body, record.detail, record.data);
  }
  return null;
}

export function StoryPublicationPanel({
  groupId,
  title,
  onClose,
}: {
  groupId: string;
  title: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { project, canvas } = readUrl();
  const base = `projects/${encodeURIComponent(project ?? "")}/canvases/${encodeURIComponent(canvas ?? "")}/stories/${encodeURIComponent(groupId)}/publication`;
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const formEdited = useRef(false);
  const preparedInput = useRef("");
  const recoveringCoverVersion = useRef<string | null>(null);
  const ownsPreviewRuntime = useRef(false);
  const prepareRequest = useRef<{
    input: string;
    body: {
      canvas_id: string; group_id: string; revision: number; request_id: string;
      title: string; description: string; cover: string | null;
      cover_mode: "landscape" | "portrait"; cover_position_x: number; cover_position_y: number;
    };
  } | null>(null);
  const [compiledVersion, setCompiledVersion] = useState<string | null>(null);
  const previewTrigger = useRef<HTMLButtonElement>(null);
  const cancelTakeDownRef = useRef<HTMLButtonElement>(null);
  const actionTrigger = useRef<HTMLButtonElement | null>(null);
  const focusShareHeading = useRef(false);
  const [copied, setCopied] = useState(false);
  const [pendingAction, setPendingAction] = useState<{
    version: string | null;
    listed: boolean;
  } | null>(null);
  const [view, setView] = useState<"edit" | "share">("edit");
  const [work, setWork] = useState<Publication | null>(null);
  const [name, setName] = useState(title);
  const [description, setDescription] = useState("");
  const [cover, setCover] = useState("");
  const [coverMode, setCoverMode] = useState<"landscape" | "portrait">("landscape");
  const [coverX, setCoverX] = useState(50);
  const [coverY, setCoverY] = useState(50);
  const [previewVersion, setPreviewVersion] = useState<PublishedVersion | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [success, setSuccess] = useState(false);
  function loadMetadata(version: PublishedVersion) {
    setName(version.title);
    setDescription(version.description);
    setCover(version.cover ?? "");
    setCoverMode(version.cover_mode ?? "landscape");
    setCoverX(version.cover_position_x ?? 50);
    setCoverY(version.cover_position_y ?? 50);
  }
  function fingerprint(version: PublishedVersion) {
    return JSON.stringify([version.title, version.description, version.cover ?? "",
      version.cover_mode ?? "landscape", version.cover_position_x ?? 50, version.cover_position_y ?? 50]);
  }
  const [prepared, setPrepared] = useState<PublishedVersion | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const returnFromPreview = useRef(false);
  useEffect(() => {
    if (!previewing && returnFromPreview.current) {
      previewTrigger.current?.focus();
      returnFromPreview.current = false;
    }
  }, [previewing]);
  useEffect(() => {
    if (view === "share" && focusShareHeading.current) {
      headingRef.current?.focus();
      focusShareHeading.current = false;
    }
  }, [view, work]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function publicationErrorText(value: unknown) {
    const code = publicationErrorCode(value);
    return code
      ? t(`storyPublication.errors.${code}`, { defaultValue: code })
      : value instanceof Error
        ? value.message
        : t("storyPublication.failed");
  }
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("button")?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.defaultPrevented || !panel?.contains(event.target as Node)) return;
      if (event.key === "Escape") {
        useStoryRuntimeStore.getState().exitPlay();
        onClose();
      }
      if (event.key !== "Tab" || !panel) return;
      const items = Array.from(
        panel.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], summary",
        ),
      ).filter((el) => el.offsetParent !== null);
      const first = items[0],
        last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      if (ownsPreviewRuntime.current) useStoryRuntimeStore.getState().exitPlay();
      previousFocus?.focus();
    };
  }, []);
  async function uploadCover(file: File) {
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const result = await apiCall<{ url: string }>(
        `projects/${encodeURIComponent(project ?? "")}/freezone/upload`,
        { method: "POST", body: form, timeout: false },
      );
      formEdited.current = true;
      recoveringCoverVersion.current = null;
      setCover(result.url);
    } catch (value) {
      setError(publicationErrorText(value));
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    const data = await apiCall<Publication>(base);
    setWork(data);
    const published = data.versions.filter((v) => v.published);
    const lastPublication = Math.max(0, ...published.map((v) =>
      v.published_at ? Date.parse(v.published_at) : 0));
    const newestPublished = published.reduce<PublishedVersion | undefined>(
      (latest, v) => !latest || (v.number ?? 0) > (latest.number ?? 0) ? v : latest,
      undefined,
    );
    const pending = data.versions.find((v, index) => !v.published && (
      lastPublication && v.created_at
        ? Date.parse(v.created_at) > lastPublication
        : !newestPublished || index < data.versions.indexOf(newestPublished)
    ));
    if (pending && !formEdited.current && !prepareRequest.current) {
      setPrepared(pending);
      loadMetadata(pending);
      preparedInput.current = fingerprint(pending);
      recoveringCoverVersion.current = pending.status === "preparing" ? pending.version : null;
      setView(data.active_version ? "share" : "edit");
      return;
    }
    const latest = data.versions.find((v) => v.version === data.active_version);
    if (latest && !formEdited.current && !prepareRequest.current) {
      loadMetadata(latest);
      setView("share");
    }
  }
  useEffect(() => {
    void reload().catch((value) => setError(publicationErrorText(value)));
  }, [base]);
  useEffect(() => {
    if (prepared?.status !== "preparing") return;
    let stopped = false;
    let timer: number;
    async function poll() {
      try {
        const version = await apiCall<PublishedVersion>(
          `${base}/${prepared!.public_id}/versions/${prepared!.version}`,
        );
        if (!stopped) {
          if (version.status === "ready" && recoveringCoverVersion.current === version.version) {
            // A preparing manifest has no archived cover yet. Restore only that
            // field; title, description and framing may have been edited meanwhile.
            setCover(version.cover ?? "");
            preparedInput.current = fingerprint(version);
            recoveringCoverVersion.current = null;
          }
          setPrepared(version);
          setError("");

        }
      } catch (value) {
        if (!stopped) {
          const code = publicationErrorCode(value);
          if (code === "publication_data_invalid" || code === "not_found") {
            const error = code === "not_found" ? "draft_superseded" : code;
            setPrepared((current) => current ? { ...current, status: "failed", error } : current);
          } else setError(t("storyPublication.statusRetry"));
        }
      } finally {
        if (!stopped) timer = window.setTimeout(() => void poll(), 1500);
      }
    }
    timer = window.setTimeout(() => void poll(), 1500);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [base, prepared?.version, prepared?.status]);
  async function prepare() {
    setBusy(true);
    setError("");
    try {
      const input = JSON.stringify([name.trim(), description, cover, coverMode, coverX, coverY]);
      let request = prepareRequest.current;
      if (!request || request.input !== input) {
        if (!project || !canvas ||
          (await flushFreezoneCanvasRuntime(project, canvas)) !== true)
          throw new Error(t("storyPublication.saveFailed"));
        const remote = await getFreezoneCanvas(project, canvas);
        if (typeof remote.revision !== "number" || remote.revision < 1)
          throw new Error(t("storyPublication.saveFailed"));
        request = {
          input,
          body: {
            canvas_id: canvas,
            group_id: groupId,
            revision: remote.revision,
            request_id: crypto.randomUUID(),
            title: name.trim(),
            description,
            cover: cover || null,
            cover_mode: coverMode,
            cover_position_x: coverX,
            cover_position_y: coverY,
          },
        };
      }
      prepareRequest.current = request;
      const result = await apiCall<PublishedVersion>(`${base}/prepare`, {
        method: "POST",
        json: request.body,
      });
      preparedInput.current = input;
      recoveringCoverVersion.current = result.status === "preparing" ? result.version : null;
      if (result.status === "ready") {
        setCover(result.cover ?? "");
        preparedInput.current = fingerprint(result);
      }
      prepareRequest.current = null;
      setCompiledVersion(null);
      setPrepared(result);

    } catch (e) {
      // A definite server rejection can be prepared again against the latest draft.
      // A lost response must retry the exact same request, including its revision.
      if (publicationErrorCode(e)) prepareRequest.current = null;
      setError(publicationErrorText(e));
    } finally {
      setBusy(false);
    }
  }
  function preview(version = prepared) {
    setCompiledVersion(null);
    setError("");
    try {
      if (!version?.snapshot) throw new Error(t("storyPublication.previewUnavailable"));
      const snapshot = authorPreviewSnapshot(version, base);
      ownsPreviewRuntime.current = true;
      useStoryRuntimeStore.getState().enterPlay(compilePlayback(snapshot), { embedded: true });
      const runtime = useStoryRuntimeStore.getState();
      if (runtime.phase === "error")
        throw new Error(runtime.error ?? t("storyPublication.failed"));
      setCompiledVersion(version.version);
      setPreviewVersion(version);
      setPreviewPlaying(false);
      setPreviewing(true);
    } catch (e) {
      useStoryRuntimeStore.getState().exitPlay();
      setPreviewing(false);
      setError(e instanceof Error ? e.message : t("storyPublication.failed"));
    }
  }
  async function activate(version: string | null, listed: boolean) {
    if (version && version === prepared?.version && compiledVersion !== version)
      return;
    const publicId = work?.public_id ?? prepared?.public_id;
    if (!publicId) return;
    setBusy(true);
    setError("");
    try {
      setWork(
        await apiCall<Publication>(`${base}/${publicId}/activate`, {
          method: "POST",
          json: { version, listed },
        }),
      );
      setPendingAction(null);
      if (version && prepared?.version === version) {
        useStoryRuntimeStore.getState().exitPlay();
        setPreviewing(false);
        setPrepared(null);
        setSuccess(true);
      }
      focusShareHeading.current = true;
      setView("share");
    } catch (value) {
      setError(publicationErrorText(value));
    } finally {
      setBusy(false);
    }
  }
  const current = work?.versions.find((v) => v.version === work.active_version);
  const currentCover = current
    ? authorPreviewUrl(current.cover ?? undefined, current, base)
    : undefined;
  const formFingerprint = JSON.stringify([name.trim(), description, cover, coverMode, coverX, coverY]);
  const draftChanged = prepared && preparedInput.current !== formFingerprint;
  const shareUrl = work ? `${window.location.origin}/play/${work.public_id}` : "";
  const close = () => {
    useStoryRuntimeStore.getState().exitPlay();
    onClose();
  };
  function locateIssue(entityId: string) {
    const state = useCanvasStore.getState();
    const edge = state.edges.find((item) => item.id === entityId);
    const nodeId = edge?.source ?? entityId;
    if (!state.nodes.some((node) => node.id === nodeId)) {
      setError(t("storyPublication.issueTargetMissing"));
      return;
    }
    close();
    state.setSelectedNode(edge ? null : nodeId);
    useCanvasStore.setState({ edges: state.edges.map((item) => ({ ...item, selected: item.id === edge?.id })) });
    state.requestFocusNode(nodeId);
  }
  const systemCheckError = prepared?.error && ["publication_data_invalid", "publication_check_failed"].includes(prepared.error);
  function cancelAction() {
    setPendingAction(null);
    actionTrigger.current?.focus();
  }
  return (
    <>
    <div
      ref={panelRef}
      data-canvas-input-modal
      className="publication-overlay"
      data-view={view}
      role="dialog"
      aria-modal="true"
      aria-labelledby="publication-heading"
    >
      <section
        className={`publication-dialog ${previewing ? "publication-dialog-wide" : ""} ${view === "share" ? "publication-dialog-share" : ""}`}
      >
        <header className="publication-dialog-header">
          <div className="publication-heading-row">
            <div>
              <div className="publication-title-row">
              <h2 ref={headingRef} id="publication-heading" tabIndex={-1}>
                {t(
                  previewing
                    ? "storyPublication.publicationPreview"
                    : view === "share"
                      ? "storyPublication.managePublication"
                      : work?.active_version ? "storyPublication.prepareUpdate" : "storyPublication.publish",
                )}
              </h2>
              {!previewing && view === "edit" && current?.number && (
                <span className="publication-title-status">
                  <span aria-hidden="true" className={`publication-dot ${work?.listed ? "" : "publication-dot-off"}`} />
                  {t(work?.listed ? "storyPublication.onlineVersion" : "storyPublication.offlineVersion", { version: current.number })}
                </span>
              )}
              </div>
              {view === "share" && current?.number && (
                <p>
                  {current.title} · v{current.number}
                </p>
              )}
            </div>
          </div>
          <button
            className="publication-icon-button"
            aria-label={t("storyPublication.close")}
            onClick={close}
          >
            <X />
          </button>
        </header>

        <div className="publication-dialog-body">
          {previewing ? (
            <>
              <p className="publication-inline-note">
                {previewVersion?.published
                  ? t("storyPublication.historyPreview", { version: previewVersion.number })
                  : t("storyPublication.pendingPreview")}
              </p>
              {previewPlaying ? (
                <div className="publication-player-frame"><StoryPlayer t={t} /></div>
              ) : previewVersion && (
                <StoryLanding release={previewVersion} preview
                  cover={authorPreviewUrl(previewVersion.cover, previewVersion, base)}>
                  <div className="published-story-actions">
                    <button className="publication-button publication-button-primary"
                      onClick={() => setPreviewPlaying(true)}><Play />{t("storyPublication.start")}</button>
                  </div>
                </StoryLanding>
              )}
            </>
          ) : view === "share" && work?.active_version ? (
            <>
              {success && <p className="publication-inline-note" role="status">{t("storyPublication.publishSuccess")}</p>}
              {current && (
                <section className="publication-release-overview">
                  <StoryCover src={currentCover} mode={current.cover_mode}
                    positionX={current.cover_position_x} positionY={current.cover_position_y} />
                  <div className="publication-release-copy">
                    <div className="publication-release-status">
                      <span
                        className={`publication-dot ${work.listed ? "" : "publication-dot-off"}`}
                      />
                      {t(
                        work.listed
                          ? "storyPublication.online"
                          : "storyPublication.offline",
                      )}
                      <span>v{current.number ?? "—"}</span>
                    </div>
                    <h3>{current.title}</h3>
                    {current.published_at && <p>{t("storyPublication.publishedAt", {
                      time: new Date(current.published_at).toLocaleString(),
                    })}</p>}
                    <p>
                      {current.description ||
                        t(
                          work.listed
                            ? "storyPublication.onlineDescription"
                            : "storyPublication.offlineDescription",
                        )}
                    </p>
                  </div>
                  <div className="publication-availability">
                    <div className="publication-work-actions">
                      <a
                        className="publication-button"
                        href={shareUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink aria-hidden="true" />
                        {t("storyPublication.openPlay")}
                      </a>
                <button
                  className="publication-button"
                  onClick={() => {
                    if (!prepared && current && !formEdited.current) loadMetadata(current);
                    setSuccess(false);
                    setView("edit");
                  }}
                >
                  <SquarePen aria-hidden="true" />
                  {t(prepared ? "storyPublication.continuePreparation" : "storyPublication.publishUpdate")}
                </button>
                    <button
                      className={`publication-button${work.listed ? " publication-button-danger" : ""}`}
                      disabled={busy}
                      onClick={(event) => {
                        if (!work.listed) void activate(null, true);
                        else {
                          setError("");
                          actionTrigger.current = event.currentTarget;
                          setPendingAction({ version: null, listed: false });
                        }
                      }}
                    >
                      {work.listed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                      {t(
                        work.listed
                          ? "storyPublication.takeDown"
                          : "storyPublication.restore",
                      )}
                    </button>
                    </div>
                  </div>
                </section>
              )}
              {!work.listed && <p className="publication-inline-note">{t("storyPublication.offlineHint")}</p>}
              {(
                <section className="publication-share-main">
                  <div>
                    <label className="publication-share-label">
                      {t("storyPublication.shareWithPlayers")}
                    </label>
                    <div className="publication-share-row">
                      <input
                        readOnly
                        value={shareUrl}
                        onFocus={(event) => event.target.select()}
                      />
                      <button
                        className="publication-button publication-button-primary"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(
                              shareUrl,
                            );
                            setCopied(true);
                          } catch {
                            setError(t("storyPublication.copyFailed"));
                          }
                        }}
                      >
                        {copied ? <Check /> : <Copy />}
                        {t(
                          copied
                            ? "storyPublication.copied"
                            : "storyPublication.copy",
                        )}
                      </button>
                    </div>
                  </div>
                </section>
              )}
              <details className="publication-management">
                <summary>
                  {t("storyPublication.versionHistory")}
                </summary>
                <div className="publication-management-body">
                  {work.versions
                    .filter(
                      (item) =>
                        item.status === "ready" &&
                        (item.published ||
                          item.version === work.active_version),
                    )
                    .sort((a, b) => (b.number ?? 0) - (a.number ?? 0))
                    .map((version) => (
                      <div
                        className="publication-version-item"
                        key={version.version}
                      >
                        <div>
                          <strong>{version.title}</strong>
                          <p>
                            {version.number
                              ? `v${version.number}`
                              : version.version.slice(0, 8)}
                            {version.published_at
                              ? ` · ${new Date(version.published_at).toLocaleString()}`
                              : ""}
                          </p>
                        </div>
                        <div className="publication-version-actions">
                        <button className="publication-button" disabled={busy}
                          onClick={() => preview(version)}>{t("storyPublication.previewVersion")}</button>
                        {version.version === work.active_version ? (
                          <span className="publication-version-current">{t("storyPublication.currentVersion")}</span>
                        ) : (
                          <button
                            className="publication-button"
                            disabled={busy}
                            onClick={(event) => {
                              setError("");
                          actionTrigger.current = event.currentTarget;
                              setPendingAction({
                                version: version.version,
                                listed: work.listed,
                              });
                            }}
                          >
                            {t("storyPublication.rollback")}
                          </button>
                        )}
                        </div>
                        {pendingAction?.version === version.version && (
                          <div className="publication-confirm">
                            <p>
                              {t("storyPublication.rollbackConfirm", {
                                version: version.number ?? version.version.slice(0, 8),
                              })}
                            </p>
                            <div>
                              <button
                                className="publication-button"
                                onClick={cancelAction}
                              >
                                {t("storyPublication.cancel")}
                              </button>
                              <button
                                className="publication-button publication-button-primary"
                                disabled={busy}
                                onClick={() =>
                                  void activate(version.version, work.listed)
                                }
                              >
                                {t("storyPublication.rollback")}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              </details>
            </>
          ) : (
            <>
              <label className="publication-label">
                {t("storyPublication.title")}
                <span>{t("storyPublication.required")}</span>
                <input
                  aria-label={t("storyPublication.title")}
                  required
                  maxLength={200}
                  value={name}
                  onChange={(event) => {
                    formEdited.current = true;
                    setName(event.target.value);
                  }}
                />
              </label>
              <label className="publication-label">
                {t("storyPublication.description")}
                <span>{t("storyPublication.optional")}</span>
                <textarea
                  aria-label={t("storyPublication.description")}
                  rows={3}
                  maxLength={4000}
                  value={description}
                  onChange={(event) => {
                    formEdited.current = true;
                    setDescription(event.target.value);
                  }}
                />
              </label>
              <div className="publication-label publication-cover-editor">
                <div className="publication-cover-header">
                  <span>{t("storyPublication.cover")}</span>
                  <div className="publication-cover-modes" role="group" aria-label={t("storyPublication.coverMode")}>
                    {(["landscape", "portrait"] as const).map((mode) => (
                      <button key={mode} className="publication-button" aria-pressed={coverMode === mode}
                        onClick={() => { formEdited.current = true; setCoverMode(mode); }}>
                        {t(`storyPublication.${mode}`)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="publication-cover-row">
                  <StoryCover mode={coverMode} positionX={coverX} positionY={coverY}
                    src={
                      prepared && cover === prepared.cover
                        ? authorPreviewUrl(cover, prepared, base)
                        : current && cover === current.cover
                          ? authorPreviewUrl(cover, current, base)
                          : cover
                    }
                  />
                  <div className="publication-cover-controls">
                    <p className="publication-cover-hint">{t("storyPublication.coverFramingHint")}</p>
                    {cover && <div className="publication-cover-position">
                      <label>{t("storyPublication.coverHorizontal")}
                        <input type="range" min="0" max="100" value={coverX} onChange={(event) => {
                          formEdited.current = true; setCoverX(Number(event.target.value));
                        }} /></label>
                      <label>{t("storyPublication.coverVertical")}
                        <input type="range" min="0" max="100" value={coverY} onChange={(event) => {
                          formEdited.current = true; setCoverY(Number(event.target.value));
                        }} /></label>
                    </div>}
                    <div className="publication-cover-actions">
                      <label className="publication-upload-button">
                        <Upload />
                        {t(
                          cover
                            ? "storyPublication.changeCover"
                            : "storyPublication.uploadCover",
                        )}
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          disabled={busy}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) void uploadCover(file);
                            event.target.value = "";
                          }}
                        />
                      </label>
                      {cover && (
                        <button
                          className="publication-text-button"
                          disabled={busy}
                          onClick={() => {
                            formEdited.current = true;
                            recoveringCoverVersion.current = null;
                            setCover("");
                          }}
                        >
                          {t("storyPublication.removeCover")}
                        </button>
                      )}
                    </div>
                    <p className="publication-cover-formats">PNG / JPG / WebP</p>
                  </div>
                </div>
              </div>
              {prepared && (
                <div className="publication-inline-note" role="status">
                  <div className="publication-check-status">
                    <strong>{t("storyPublication.publicationChecks")}</strong>
                    <span>{t(systemCheckError ? "storyPublication.checkIncomplete" : draftChanged ? "storyPublication.needsRecheck" : `storyPublication.taskStatus.${prepared.status}`)}</span>
                  </div>
                  {prepared.status === "preparing" && <p>{t("storyPublication.preparingHint")}</p>}
                </div>
              )}
              {prepared && (prepared.issues.length > 0 || prepared.error) && (
                <section className="publication-prepared" aria-live="polite">
                  {prepared.issues.length > 0 && (
                    <ul>
                      {prepared.issues.map((issue, index) => (
                        <li
                          key={index}
                          className={
                            issue.severity === "error"
                              ? "publication-error"
                              : ""
                          }
                        >
                          {t(`storyPublication.errors.${issue.code}`, {
                            defaultValue: issue.code,
                          })}
                          {issue.entity_label && <p>{issue.entity_label}</p>}
                          {issue.entity_id && (
                            <button className="publication-button" onClick={() => locateIssue(issue.entity_id!)}>
                              {t("storyPublication.locateIssue")}
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {prepared.error && (prepared.error !== "invalid_story" || prepared.issues.length === 0) && (
                    <div className="publication-inline-note publication-error">
                      <p role="alert">
                        {t(`storyPublication.errors.${prepared.error}`, {
                          defaultValue: prepared.error,
                        })}
                      </p>
                      <button
                        className="publication-button"
                        disabled={busy}
                        onClick={() => {
                          if (prepared.error === "draft_superseded") close();
                          else if (systemCheckError) void prepare();
                          else {
                            close();
                            useCanvasStore.getState().openStoryLint(groupId);
                          }
                        }}
                      >
                        {t(prepared.error === "draft_superseded" ? "storyPublication.close" : systemCheckError ? "storyPublication.retryChecks" : "storyPublication.openChecks")}
                      </button>
                    </div>
                  )}
                </section>
              )}
            </>
          )}
          {error && pendingAction?.version !== null && (
            <div
              role="alert"
              className="publication-inline-note publication-error"
            >
              {error}
              {!prepared && <button className="publication-button" disabled={busy} onClick={async () => {
                setBusy(true);
                setError("");
                try { await reload(); } catch (value) { setError(publicationErrorText(value)); }
                finally { setBusy(false); }
              }}>{t("storyPublication.retry")}</button>}
            </div>
          )}
        </div>

        {(previewing || view !== "share") && <footer className="publication-dialog-footer">
          <p>
            {previewing
              ? t("storyPublication.snapshotNotice")
              : view === "share"
                ? t("storyPublication.playerAccessSummary")
                : t("storyPublication.saveBeforePrepare")}
          </p>
          <div>
            {previewing ? (
              <>
                <button
                  className="publication-button"
                  onClick={() => {
                    useStoryRuntimeStore.getState().exitPlay();
                    returnFromPreview.current = true;
                    setPreviewing(false);
                  }}
                >
                  {t(view === "share" ? "storyPublication.viewSharing" : "storyPublication.back")}
                </button>
                {!previewVersion?.published && <button
                  className="publication-button publication-button-primary"
                  disabled={busy || compiledVersion !== prepared?.version}
                  onClick={() => void activate(prepared!.version, true)}
                >
                  {t(work?.active_version && !work.listed ? "storyPublication.publishAndRestore" : "storyPublication.publishThisVersion")}
                </button>}
              </>
            ) : view === "share" ? null : (
              <>
                {work?.active_version && <button className="publication-button" onClick={() => setView("share")}>
                  {t("storyPublication.viewSharing")}
                </button>}
                {prepared?.status === "preparing" && prepared.progress && (
                  <div className="publication-footer-progress" role="status">
                    <span>{t("storyPublication.checkingMedia")}</span>
                    <progress
                      value={prepared.progress.completed}
                      max={Math.max(1, prepared.progress.total)}
                    />
                    <span>
                      {prepared.progress.completed}/{prepared.progress.total}
                    </span>
                  </div>
                )}
                {prepared?.status === "ready" && !draftChanged && (
                  <button className="publication-button" disabled={busy}
                    onClick={() => void prepare()}>
                    {t("storyPublication.prepareLatest")}
                  </button>
                )}
                <button
                  ref={previewTrigger}
                  className="publication-button publication-button-primary"
                  disabled={
                    busy || prepared?.status === "preparing" || !name.trim()
                  }
                  onClick={() => {
                    if (prepared?.status === "ready" && !draftChanged) preview(prepared);
                    else void prepare();
                  }}
                >
                  {busy || prepared?.status === "preparing" ? (
                    <LoaderCircle className="motion-safe:animate-spin" />
                  ) : (
                    <Play />
                  )}
                  {t(
                    busy || prepared?.status === "preparing"
                      ? "storyPublication.checking"
                      : prepared?.status === "ready" && !draftChanged
                        ? "storyPublication.preview" : "storyPublication.checkAndPreview",
                  )}
                </button>
              </>
            )}
          </div>
        </footer>}
      </section>
    </div>
    <AlertDialog
      open={pendingAction?.version === null}
      onOpenChange={(open) => {
        if (!open && !busy) {
          setPendingAction(null);
          setError("");
        }
      }}
    >
      <AlertDialogContent
        initialFocus={cancelTakeDownRef}
        finalFocus={actionTrigger}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t("storyPublication.takeDownTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("storyPublication.takeDownConfirm")}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelTakeDownRef} disabled={busy}>
            {t("storyPublication.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy}
            onClick={() => void activate(null, false)}>
            {busy && <LoaderCircle className="size-4 motion-safe:animate-spin" />}
            {t("storyPublication.confirmTakeDown")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
