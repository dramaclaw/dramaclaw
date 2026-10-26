// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { Brand } from "@/components/login/login-stage";
import { LoginModal } from "@/components/login/login-modal";
import { WatchPlayer } from "@/components/login/watch-player";
import { loginCommunityWorks } from "@/lib/login-community";
import styles from "@/components/login/login.module.css";

const WATCH_RAIL_DRAG_THRESHOLD_PX = 8;
const watchRailEntries = loginCommunityWorks.map((work) => ({
  railId: work.id,
  work,
}));

function findWatchRailEntry(id: string) {
  return watchRailEntries.find((entry) => entry.railId === id);
}

function WatchPage() {
  const { work: workId } = Route.useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [selectedRailId, setSelectedRailId] = useState(workId);
  const activeEntry = findWatchRailEntry(selectedRailId) ?? findWatchRailEntry(workId);
  const activeWork = activeEntry?.work;
  const [loginOpen, setLoginOpen] = useState(false);
  const [playerOpen, setPlayerOpen] = useState(false);
  // Fit mode is aspect-dependent: landscape (16:9) fills the full width
  // edge-to-edge (cover); portrait (9:16) shows the whole frame centered
  // (contain). Resolved from the clip's real dimensions on loadedmetadata.
  // Defaults to cover (the common landscape case) to avoid a first-frame flash.
  const [videoFit, setVideoFit] = useState<"cover" | "contain">("cover");

  const railRef = useRef<HTMLElement | null>(null);
  const activeRailItemRef = useRef<HTMLButtonElement | null>(null);
  const railDragRef = useRef({
    isDragging: false,
    moved: false,
    startX: 0,
    startY: 0,
    scrollLeft: 0,
  });
  const activeIndex = activeEntry
    ? watchRailEntries.findIndex((entry) => entry.railId === activeEntry.railId)
    : -1;
  const previousWork =
    activeIndex >= 0
      ? watchRailEntries[(activeIndex - 1 + watchRailEntries.length) % watchRailEntries.length]
      : null;
  const nextWork =
    activeIndex >= 0 ? watchRailEntries[(activeIndex + 1) % watchRailEntries.length] : null;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("preauth-shell");
    root.style.backgroundColor = "#181818";
    return () => {
      root.classList.remove("preauth-shell");
      root.style.backgroundColor = "";
    };
  }, []);

  const centerActiveRailItem = (behavior: ScrollBehavior = "smooth") => {
    const rail = railRef.current;
    const item = activeRailItemRef.current;
    if (!rail || !item) return;

    rail.scrollTo({
      left: item.offsetLeft + item.offsetWidth / 2 - rail.clientWidth / 2,
      behavior,
    });
  };

  useEffect(() => {
    requestAnimationFrame(() => centerActiveRailItem("smooth"));
  }, [activeEntry?.railId]);

  useEffect(() => {
    if (findWatchRailEntry(workId)) {
      setSelectedRailId(workId);
    }
  }, [workId]);

  const selectRailEntry = (railId: string) => {
    setSelectedRailId(railId);
    void navigate({
      to: "/watch/$work",
      params: { work: railId },
      replace: true,
    });
  };

  const handleRailPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    railDragRef.current = {
      isDragging: true,
      moved: false,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: event.currentTarget.scrollLeft,
    };
  };

  const handleRailPointerMove = (event: PointerEvent<HTMLElement>) => {
    const drag = railDragRef.current;
    if (!drag.isDragging) return;

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    const isHorizontalDrag =
      Math.abs(deltaX) > WATCH_RAIL_DRAG_THRESHOLD_PX &&
      Math.abs(deltaX) > Math.abs(deltaY);

    if (isHorizontalDrag) {
      drag.moved = true;
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      event.currentTarget.scrollLeft = drag.scrollLeft - deltaX * 1.4;
      event.preventDefault();
    }
  };

  const handleRailPointerEnd = (event: PointerEvent<HTMLElement>) => {
    const didDrag = railDragRef.current.moved;
    railDragRef.current.isDragging = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (didDrag) {
      window.setTimeout(() => {
        railDragRef.current.moved = false;
      }, 0);
    }
  };

  if (!activeWork) {
    return <Navigate to="/login" replace />;
  }

  return (
    <main className={styles.watchPage}>
      <div className={styles.watchBackdrop} aria-hidden="true">
        <img src={activeWork.cover} alt="" />
      </div>

      <header className={styles.watchHeader}>
        <div className={styles.watchBrandGroup}>
          <Brand className={styles.watchBrand} />
          <div className={styles.watchMeta}>
            <h1>{activeWork.title}</h1>
          </div>
        </div>
        <div className={styles.watchActions}>
          <button
            type="button"
            className={styles.watchPlayCta}
            onClick={() => setPlayerOpen(true)}
          >
            <span>{t("auth.watch.watchNow")}</span>
          </button>
          <button
            type="button"
            className={styles.watchCreateCta}
            onClick={() => setLoginOpen(true)}
          >
            {t("auth.watch.createNow")}
          </button>
        </div>
      </header>

      <section className={styles.watchStage} aria-label={activeWork.title}>
        <video
          key={activeEntry.railId}
          className={styles.watchVideo}
          style={{ objectFit: videoFit }}
          src={activeWork.preview}
          poster={activeWork.cover}
          autoPlay
          muted
          loop
          playsInline
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            // Portrait 9:16 → contain (whole frame, centered, blurred bars);
            // landscape 16:9 → cover (fills the full width, minor top/bottom crop).
            setVideoFit(video.videoHeight > video.videoWidth ? "contain" : "cover");
          }}
        />
      </section>

      <div className={styles.watchRailWrap}>
        {previousWork ? (
          <button
            type="button"
            className={`${styles.watchRailControl} ${styles.watchRailControlPrev}`}
            aria-label={t("auth.watch.previous")}
            onClick={() => selectRailEntry(previousWork.railId)}
          >
            <ChevronLeft strokeWidth={1.9} aria-hidden="true" />
          </button>
        ) : null}
        <nav
          className={styles.watchRail}
          aria-label={t("auth.community.label")}
          ref={railRef}
          onPointerDown={handleRailPointerDown}
          onPointerMove={handleRailPointerMove}
          onPointerUp={handleRailPointerEnd}
          onPointerCancel={handleRailPointerEnd}
        >
          {watchRailEntries.map((entry) => {
            const isActive = entry.railId === activeEntry.railId;
            return (
              <button
                key={entry.railId}
                type="button"
                className={styles.watchRailItem}
                data-active={isActive ? "true" : undefined}
                aria-current={isActive ? "true" : undefined}
                ref={isActive ? activeRailItemRef : undefined}
                onClick={(event) => {
                  if (railDragRef.current.moved) {
                    event.preventDefault();
                    railDragRef.current.moved = false;
                    return;
                  }
                  selectRailEntry(entry.railId);
                }}
              >
                <img
                  src={entry.work.cover}
                  alt=""
                  loading="lazy"
                  aria-hidden="true"
                />
              </button>
            );
          })}
        </nav>
        {nextWork ? (
          <button
            type="button"
            className={`${styles.watchRailControl} ${styles.watchRailControlNext}`}
            aria-label={t("auth.watch.next")}
            onClick={() => selectRailEntry(nextWork.railId)}
          >
            <ChevronRight strokeWidth={1.9} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />

      {playerOpen ? (
        <WatchPlayer
          src={activeWork.preview}
          poster={activeWork.cover}
          title={activeWork.title}
          onClose={() => setPlayerOpen(false)}
        />
      ) : null}
    </main>
  );
}

export const Route = createFileRoute("/watch/$work")({
  component: WatchPage,
});
