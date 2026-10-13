// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { PIKO_NICKNAME_MAX, isValidPikoProfile, normalizePikoProfile } from "./piko-profile";
import { PIKO_INTRO_VIDEO, PIKO_ONBOARDING_BACKGROUND, PIKO_PLAYER_ART, type PikoPlayerGender } from "./piko-player";
import { PikoCreationBackground } from "./PikoCreationBackground";
import { playPikoUiSound } from "./piko-audio";
import { startPikoMusic } from "./piko-bgm";
import { PIKO_MAP_MUSIC } from "./piko-map-music";
import styles from "./piko-onboarding.module.css";
import { usePikoCursors } from "./use-piko-cursors";

type Stage = "intro" | "hold" | "invitation" | "out" | "reveal" | "create" | "depart";
export function PikoOnboarding({ initialNickname, onSave, onEnter, onMusicStart }: {
  initialNickname: string; onMusicStart?: () => void; onSave: (gender: PikoPlayerGender, nickname: string) => boolean | Promise<boolean>; onEnter: () => void;
}) {
  usePikoCursors();
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage>("intro");
  const [gender, setGender] = useState<PikoPlayerGender>("female");
  const [nickname, setNickname] = useState(initialNickname);
  const [formError, setFormError] = useState("");
  const [mediaError, setMediaError] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [firstFrame, setFirstFrame] = useState(false);
  const [muted, setMuted] = useState(false);
  const soundMuted = useRef(false);
  const [waiting, setWaiting] = useState(true);
  const [slow, setSlow] = useState(false);
  const [assets, setAssets] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const invitation = useRef<HTMLButtonElement>(null);
  const loopVideo = useRef<HTMLVideoElement>(null);
  const [loopPlaying, setLoopPlaying] = useState(false);
  const [videoRatio, setVideoRatio] = useState(16 / 9);
  const input = useRef<HTMLInputElement>(null);
  const entered = useRef(false);
  const savePending = useRef(false);
  const stageRef = useRef(stage); stageRef.current = stage;
  const onEnterRef = useRef(onEnter); onEnterRef.current = onEnter;
  const reduce = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  useEffect(() => {
    let cancelled = false;
    setAssets("loading");
    const images = [PIKO_ONBOARDING_BACKGROUND, ...Object.values(PIKO_PLAYER_ART).map(a => a.src)].map(src => {
      const img = new Image(); return { img, src };
    });
    const timeout = window.setTimeout(() => { if (!cancelled) setAssets("error"); }, 15000);
    Promise.all(images.map(({ img, src }) => new Promise<void>((resolve, reject) => {
      img.onload = () => resolve(); img.onerror = () => reject(new Error("image")); img.src = src;
    }))).then(() => { if (!cancelled) { clearTimeout(timeout); setAssets("ready"); } }, () => {
      if (!cancelled) { clearTimeout(timeout); setAssets("error"); }
    });
    return () => { cancelled = true; clearTimeout(timeout); images.forEach(({ img }) => { img.onload = null; img.onerror = null; }); };
  }, [attempt]);

  useEffect(() => {
    if (!waiting || stage !== "intro") { setSlow(false); return; }
    const timer = window.setTimeout(() => setSlow(true), 10000);
    return () => clearTimeout(timer);
  }, [waiting, stage]);

  useEffect(() => {
    const element = video.current;
    if (!element || stage !== "intro") return;
    let active = true;
    // A route entry is normally still within the entrance gesture. If audible
    // autoplay is denied, continue silently and expose the existing sound control.
    const start = async () => {
      if (!active || document.hidden) return;
      try { await element.play(); }
      catch {
        if (!active || document.hidden) return;
        element.muted = true; setMuted(true);
        try { await element.play(); }
        catch { if (active) { setBlocked(true); setWaiting(false); } }
      }
      if (!active || document.hidden) element.pause();
    };
    const timer = window.setTimeout(() => { void start(); }, reduce() ? 0 : 800);
    const hide = () => { if (document.hidden) { element.pause(); setPlaying(false); setWaiting(false); setBlocked(true); } };
    document.addEventListener("visibilitychange", hide);
    return () => { active = false; clearTimeout(timer); element.pause(); document.removeEventListener("visibilitychange", hide); };
  }, [stage]);

  const waitingForAssets = stage === "out" && assets !== "ready";
  useEffect(() => {
    if (stage === "intro" || stage === "invitation" || stage === "create" || waitingForAssets) return;
    const timer = window.setTimeout(() => {
      if (stage === "hold") setStage("invitation");
      else if (stage === "out") setStage("reveal");
      else if (stage === "reveal") setStage("create");
      else if (stage === "depart" && !entered.current) { entered.current = true; onEnterRef.current(); }
    }, stage === "hold" ? 500 : reduce() ? 0 : 800);
    return () => clearTimeout(timer);
  }, [stage, waitingForAssets]);

  useEffect(() => { if (stage === "create") input.current?.focus(); if (stage === "invitation") invitation.current?.focus(); }, [stage]);

  const loopActive = stage === "invitation" || stage === "out";
  useEffect(() => {
    const element = loopVideo.current;
    if (!loopActive || !element) return;
    let active = true;
    const sync = () => {
      if (document.hidden) element.pause();
      else void element.play().then(() => {
        if (!active || document.hidden) element.pause();
      }, () => { if (active) setLoopPlaying(false); });
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      active = false;
      element.pause();
      document.removeEventListener("visibilitychange", sync);
    };
  }, [loopActive]);

  const creationMusicActive = stage === "reveal" || stage === "create";
  useEffect(() => {
    if (!creationMusicActive || soundMuted.current) return;
    if (onMusicStart) { onMusicStart(); return; }
    return startPikoMusic(PIKO_MAP_MUSIC["welcome-courtyard"]!);
  }, [creationMusicActive, onMusicStart]);

  const finishVideo = () => {
    if (stageRef.current !== "invitation" && !(stageRef.current === "intro" && mediaError)) return;
    stageRef.current = "out";
    if (!soundMuted.current) playPikoUiSound("open");
    video.current?.pause(); setStage("out");
  };
  const play = () => {
    const element = video.current; if (!element) return;
    setMediaError(false); setBlocked(false); setWaiting(true);
    if (element.error) element.load();
    void element.play().catch(() => { if (stageRef.current === "intro") { setPlaying(false); setWaiting(false); setBlocked(true); } });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (stage !== "create" || savePending.current) return;
    const normalized = normalizePikoProfile({ nickname, bio: "" });
    if (!isValidPikoProfile(normalized)) { setFormError(t("pikoWorld.onboarding.nameError")); input.current?.focus(); return; }
    if (!soundMuted.current) playPikoUiSound("open");
    savePending.current = true;
    const completeSave = (saved: boolean) => {
      if (!saved) { savePending.current = false; setFormError(t("pikoWorld.onboarding.saveError")); return; }
      setStage("depart");
    };
    const saved = onSave(gender, normalized.nickname);
    if (typeof saved === "object" && saved && "then" in saved) {
      void saved.then(completeSave).catch(() => completeSave(false));
    } else {
      completeSave(saved);
    }
  };
  const showVideo = stage === "intro" || stage === "hold" || stage === "invitation" || stage === "out";
  const art = PIKO_PLAYER_ART[gender];
  return <main id="main-content" className={styles.screen}>
    <link rel="preload" as="image" href="/piko/world/onboarding/invitation-wordmark.png" />
    <div className={styles.scene} aria-hidden={stage !== "create"} inert={stage !== "create"}>
      <PikoCreationBackground active={stage === "reveal" || stage === "create" || stage === "depart"} />
      <h1 className={styles.title}><img src="/piko/world/onboarding/create-character-title-v3.png" alt={t("pikoWorld.onboarding.createTitle")} /></h1>
      <Link to="/" className={styles.back}>{t("pikoWorld.returnToWorkbench")}</Link>

      <div className={styles.creation}>
        <div className={styles.portrait} style={{ "--player-visible-ratio": (art.baseline - art.top) / 1476 } as CSSProperties}>
          <img style={{ height: `calc(var(--portrait-height) * ${PIKO_PLAYER_ART[gender].height / 1476})`, transform: `translateY(${(PIKO_PLAYER_ART[gender].height - PIKO_PLAYER_ART[gender].baseline) / PIKO_PLAYER_ART[gender].height * 100}%)` }} src={PIKO_PLAYER_ART[gender].src} alt={t(`pikoWorld.onboarding.${gender}`)} draggable={false} />
          {nickname.trim() && <span className={styles.name}>{nickname.trim()}</span>}
        </div>
        <form className={styles.form} onSubmit={submit}>
          <h2 className={styles.formTitle}>{t("pikoWorld.onboarding.appearance")}</h2>
          <fieldset><legend>{t("pikoWorld.onboarding.appearance")}</legend><div className={styles.gender}>
            {(["female", "male"] as const).map(value => <label key={value} data-selected={gender === value}>
              <input type="radio" name="gender" value={value} checked={gender === value} onChange={() => { if (gender !== value) { if (!soundMuted.current) playPikoUiSound("open"); setGender(value); } }} />
              {t(`pikoWorld.onboarding.${value}`)}
            </label>)}
          </div></fieldset>
          <label className={styles.field}>{t("pikoWorld.onboarding.nickname")}
            <input ref={input} value={nickname} maxLength={PIKO_NICKNAME_MAX} autoComplete="off" aria-invalid={!!formError} aria-describedby="piko-name-feedback"
              onChange={event => { setNickname(event.target.value); setFormError(""); }} placeholder={t("pikoWorld.onboarding.namePlaceholder")} />
          </label>
          <p id="piko-name-feedback" className={styles.feedback} role={formError ? "alert" : undefined}>{formError || t("pikoWorld.onboarding.nameHint")}</p>
          <button className={styles.primary} type="submit" disabled={stage !== "create"}>{t("pikoWorld.onboarding.enter")}</button>
        </form>
      </div>
    </div>
    {showVideo && <div className={styles.cinema} aria-hidden={stage === "out"} inert={stage === "out"}>
      <div className={styles.videoViewport} style={{ "--video-ratio": videoRatio } as CSSProperties}>
      <video ref={video} src={PIKO_INTRO_VIDEO} playsInline preload="auto" muted={muted} className={styles.video} data-ready={firstFrame || playing}
        onLoadedMetadata={event => { const v = event.currentTarget; if (v.videoWidth && v.videoHeight) setVideoRatio(v.videoWidth / v.videoHeight); }}
        onLoadedData={() => setFirstFrame(true)}
        onEnded={() => { if (stageRef.current !== "intro") return; stageRef.current = "hold"; setPlaying(false); setWaiting(false); setBlocked(false); setStage("hold"); }} onPlaying={() => { if (stageRef.current !== "intro") { video.current?.pause(); return; } setPlaying(true); setBlocked(false); setFirstFrame(true); setWaiting(false); }}
        onWaiting={() => setWaiting(true)} onPause={() => setPlaying(false)} onError={() => { setMediaError(true); setWaiting(false); setPlaying(false); }} />
      {stage === "intro" && (blocked || mediaError || slow) && <div className={styles.playPrompt}>
        <p role="status">{t(mediaError ? "pikoWorld.onboarding.videoError" : slow ? "pikoWorld.onboarding.videoSlow" : "pikoWorld.onboarding.resumeHint")}</p>
        <button type="button" onClick={play} className={styles.primary}>{t(mediaError ? "pikoWorld.onboarding.retry" : "pikoWorld.onboarding.resume")}</button>
        {mediaError && <button type="button" className={styles.primary} onClick={finishVideo}>{t("pikoWorld.onboarding.join")}</button>}
      </div>}
      <video ref={loopVideo} src="/piko/world/onboarding/invitation-loop-v1.mp4"
        className={`${styles.video} ${styles.invitationVideo}`} data-ready={loopPlaying}
        playsInline preload="auto" muted loop aria-hidden="true"
        onPlaying={() => setLoopPlaying(true)} onError={() => setLoopPlaying(false)} />
      <div className={styles.videoControls}>
        {stage === "intro" && <button type="button" onClick={() => {
          if (stageRef.current !== "intro") return;
          stageRef.current = "invitation";
          video.current?.pause();
          setPlaying(false); setWaiting(false); setBlocked(false);
          setStage("invitation");
        }}>{t("pikoWorld.onboarding.skipAnimation")}</button>}
        <button type="button" onClick={() => { soundMuted.current = !muted; setMuted(value => !value); }}>{t(muted ? "pikoWorld.onboarding.unmute" : "pikoWorld.onboarding.mute")}</button>

      </div>
      {stage === "invitation" && <div className={styles.invitation}><button ref={invitation} type="button" className={styles.invitationButton} onClick={finishVideo} aria-label={t("pikoWorld.onboarding.join")}><img src="/piko/world/onboarding/invitation-wordmark.png" alt="" width={1019} height={233} draggable={false} /></button></div>}
      </div>
    </div>}
    <div className={styles.blackout} data-visible={stage === "out" || stage === "depart"} aria-hidden="true" />
    {stage === "out" && assets !== "ready" && <div className={styles.assetStatus} role="status">
      <p>{t(assets === "error" ? "pikoWorld.onboarding.assetError" : "pikoWorld.onboarding.preparing")}</p>
      {assets === "error" && <button className={styles.primary} onClick={() => setAttempt(value => value + 1)}>{t("pikoWorld.onboarding.retry")}</button>}
      <Link to="/">{t("pikoWorld.returnToWorkbench")}</Link>
    </div>}
  </main>;
}
