import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import Lenis from "lenis";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { ChevronUp } from "lucide-react";
import { LoginModal } from "@/components/login/login-modal";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { LoginCinematicHero } from "./LoginCinematicHero";
import { IntroRitualScreen } from "./IntroRitualScreen";
import { FifthScreenVideo } from "./FifthScreenVideo";
import { FourthScreen } from "./FourthScreen";
import { SixthShowcaseScreen } from "./SixthShowcaseScreen";
import { SeventhPipelineScreen } from "./SeventhPipelineScreen";
import { EighthControlScreen } from "./EighthControlScreen";
import { EleventhFaqScreen } from "./EleventhFaqScreen";
import { NinthWorkflowScreen } from "./NinthWorkflowScreen";
import { TenthTestimonialsScreen } from "./TenthTestimonialsScreen";
import { TwelfthFinalScreen } from "./TwelfthFinalScreen";
import { SecondScreenVideo } from "./SecondScreenVideo";
import { ThirdScreenVideo } from "./ThirdScreenVideo";
import styles from "@/components/login/login.module.css";
import layout from "./hero-layout.module.css";

gsap.registerPlugin(ScrollTrigger);

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

const segment = (position: number, start: number, duration: number) =>
  clamp((position - start) / duration);

export function LoginCinematicPage() {
  const mainRef = useRef<HTMLElement | null>(null);
  const introRef = useRef<HTMLElement | null>(null);
  const lenisRef = useRef<Lenis | null>(null);
  const heroReadyTimerRef = useRef<number | null>(null);
  const introFlowTimerRef = useRef<number | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [introComplete, setIntroComplete] = useState(false);
  const [introHeroReady, setIntroHeroReady] = useState(false);
  const [introFlowReady, setIntroFlowReady] = useState(false);
  const [pageScrolled, setPageScrolled] = useState(false);
  const [sceneUnits, setSceneUnits] = useState(0);
  const reducedMotion = useReducedMotion();
  const heroReady = introHeroReady || reducedMotion;
  const flowReady = introFlowReady || reducedMotion;

  const scrollToTop = useCallback(() => {
    const lenis = lenisRef.current;
    if (lenis) {
      const distance = Math.max(0, lenis.scroll);
      const duration = reducedMotion
        ? 0
        : clamp(distance / ((window.innerHeight || 1) * 9), 1.25, 3.2);
      lenis.scrollTo(0, {
        duration,
        easing: (t) => 1 - Math.pow(1 - t, 3),
      });
      return;
    }
    mainRef.current?.scrollTo({
      top: 0,
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, [reducedMotion]);

  const completeIntro = useCallback(() => {
    setIntroComplete(true);
    if (heroReadyTimerRef.current === null) {
      heroReadyTimerRef.current = window.setTimeout(() => {
        setIntroHeroReady(true);
        heroReadyTimerRef.current = null;
      }, 120);
    }

    if (introFlowTimerRef.current === null) {
      introFlowTimerRef.current = window.setTimeout(() => {
        setIntroFlowReady(true);
        introFlowTimerRef.current = null;
      }, 820);
    }
  }, []);

  useEffect(() => {
    if (reducedMotion) {
      setIntroComplete(true);
      setIntroHeroReady(true);
      setIntroFlowReady(true);
    }
  }, [reducedMotion]);

  useEffect(() => {
    return () => {
      if (heroReadyTimerRef.current !== null) {
        window.clearTimeout(heroReadyTimerRef.current);
      }
      if (introFlowTimerRef.current !== null) {
        window.clearTimeout(introFlowTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("preauth-shell");
    root.style.backgroundColor = "#181818";
    return () => {
      root.classList.remove("preauth-shell");
      root.style.backgroundColor = "";
    };
  }, []);

  useEffect(() => {
    const scroller = mainRef.current;
    const intro = introRef.current;
    if (!scroller || !intro) return;

    const updateProgress = (progress: number) => {
      const maxUnits = Math.max(
        0,
        (intro.scrollHeight - scroller.clientHeight) / (window.innerHeight || 1),
      );
      const nextUnits = progress * maxUnits;
      setSceneUnits(nextUnits);
      setPageScrolled(nextUnits * (window.innerHeight || 1) > 12);
    };

    const lenis = new Lenis({
      wrapper: scroller,
      content: intro,
      lerp: 0.12,
      smoothWheel: true,
      wheelMultiplier: 1,
    });
    lenisRef.current = lenis;
    lenis.on("scroll", ScrollTrigger.update);

    const ticker = (time: number) => {
      lenis.raf(time * 1000);
    };
    gsap.ticker.add(ticker);
    gsap.ticker.lagSmoothing(0);

    ScrollTrigger.scrollerProxy(scroller, {
      scrollTop(value) {
        if (typeof value === "number") {
          lenis.scrollTo(value, { immediate: true });
        }
        return lenis.scroll;
      },
      getBoundingClientRect() {
        return {
          top: 0,
          left: 0,
          width: window.innerWidth,
          height: window.innerHeight,
        };
      },
    });

    const trigger = ScrollTrigger.create({
      trigger: intro,
      scroller,
      start: "top top",
      end: "bottom bottom",
      scrub: true,
      onUpdate: (self) => updateProgress(self.progress),
      onRefresh: (self) => updateProgress(self.progress),
    });

    ScrollTrigger.refresh();

    return () => {
      trigger.kill();
      gsap.ticker.remove(ticker);
      lenis.destroy();
      if (lenisRef.current === lenis) {
        lenisRef.current = null;
      }
      ScrollTrigger.scrollerProxy(scroller, {
        scrollTop(value) {
          if (typeof value === "number") scroller.scrollTop = value;
          return scroller.scrollTop;
        },
        getBoundingClientRect() {
          return scroller.getBoundingClientRect();
        },
      });
    };
  }, []);

  useEffect(() => {
    const scroller = mainRef.current;
    if (!scroller) return;
    scroller.style.overflowY = flowReady ? "" : "hidden";
    return () => {
      scroller.style.overflowY = "";
    };
  }, [flowReady]);

  const heroExitProgress = segment(sceneUnits, 0.42, 1.03);
  const copyProgress = segment(sceneUnits, 1.56, 0.46);
  const videoOpacity = segment(sceneUnits, 2.06, 0.48);
  const secondCopyExitProgress = segment(sceneUnits, 3.56, 0.42);
  const secondVideoExitProgress = segment(sceneUnits, 3.72, 0.5);
  const thirdVideoOpacity = segment(sceneUnits, 4.46, 0.48);
  const thirdCopyProgress = segment(sceneUnits, 5.02, 0.5);
  const thirdCopyExitProgress = segment(sceneUnits, 6.42, 0.44);
  const thirdVideoExitProgress = segment(sceneUnits, 6.58, 0.52);
  const fourthProgress = segment(sceneUnits, 7.32, 0.38);
  const fourthSequenceProgress = segment(sceneUnits, 7.58, 1.72);
  const fourthExitProgress = segment(sceneUnits, 9.55, 0.48);
  const fifthVideoOpacity = segment(sceneUnits, 10.22, 0.48);
  const fifthVideoDimProgress = segment(sceneUnits, 11.02, 0.46);
  const fifthCopyProgress = segment(sceneUnits, 11.18, 0.64);
  const fifthExitProgress = segment(sceneUnits, 12.18, 0.48);
  const sixthProgress = segment(sceneUnits, 12.92, 0.58);
  const sixthSequenceProgress = segment(sceneUnits, 13.34, 2.9);
  const sixthExitProgress = segment(sceneUnits, 16.35, 0.5);
  const seventhProgress = segment(sceneUnits, 17.12, 0.68);
  const seventhSequenceProgress = segment(sceneUnits, 17.62, 1.9);
  const seventhExitProgress = segment(sceneUnits, 19.88, 0.58);
  const seventhShouldMount = sceneUnits >= 16.05;
  const eighthProgress = segment(sceneUnits, 20.62, 0.72);
  const eighthSequenceProgress = segment(sceneUnits, 21.08, 1.62);
  const eighthExitProgress = segment(sceneUnits, 23.02, 0.54);
  const ninthProgress = segment(sceneUnits, 23.72, 0.72);
  const ninthSequenceProgress = segment(sceneUnits, 24.16, 1.8);
  const ninthExitProgress = segment(sceneUnits, 26.42, 0.56);
  const tenthProgress = segment(sceneUnits, 27.14, 0.72);
  const tenthExitProgress = segment(sceneUnits, 29.5, 0.56);
  const eleventhProgress = segment(sceneUnits, 30.24, 0.72);
  const eleventhExitProgress = segment(sceneUnits, 32.0, 0.5);
  const twelfthProgress = segment(sceneUnits, 32.46, 0.72);
  const secondVideoActive = videoOpacity > 0.08 && secondVideoExitProgress < 0.95;
  const thirdVideoActive = thirdVideoOpacity > 0.08 && thirdVideoExitProgress < 0.95;
  const fifthVideoActive = fifthVideoOpacity > 0.08;
  const heroExitStyle = {
    "--hero-stage-opacity": `${Math.max(0, 1 - heroExitProgress)}`,
    "--hero-exit-offset": `${heroExitProgress * 32}px`,
    "--hero-exit-scale": `${1 - heroExitProgress * 0.045}`,
    "--hero-exit-opacity": `${Math.max(0, 1 - heroExitProgress)}`,
    "--hero-exit-blur": `${heroExitProgress * 5}px`,
    pointerEvents: heroExitProgress < 0.12 ? "auto" : "none",
  } as CSSProperties;

  return (
    <main
      ref={mainRef}
      className={`${styles.page} ${pageScrolled ? styles.pageScrolled : ""}`}
    >
      <section ref={introRef} className={layout.introScene}>
        <div className={layout.introSticky}>
          <section
            className={`${styles.stage} ${layout.heroStage}`}
            style={heroExitStyle}
          >
            {heroReady ? (
              <LoginCinematicHero
                heroExitProgress={heroExitProgress}
                onStart={() => setLoginOpen(true)}
              />
            ) : null}
          </section>

          <SecondScreenVideo
            copyExitProgress={secondCopyExitProgress}
            copyProgress={copyProgress}
            isActive={secondVideoActive}
            videoExitProgress={secondVideoExitProgress}
            videoOpacity={videoOpacity}
          />

          <ThirdScreenVideo
            copyExitProgress={thirdCopyExitProgress}
            copyProgress={thirdCopyProgress}
            isActive={thirdVideoActive}
            videoExitProgress={thirdVideoExitProgress}
            videoOpacity={thirdVideoOpacity}
          />

          <FourthScreen
            exitProgress={fourthExitProgress}
            progress={fourthProgress}
            sequenceProgress={fourthSequenceProgress}
          />

          <FifthScreenVideo
            exitProgress={fifthExitProgress}
            isActive={fifthVideoActive}
            textProgress={fifthCopyProgress}
            videoDimProgress={fifthVideoDimProgress}
            videoOpacity={fifthVideoOpacity}
          />

          <SixthShowcaseScreen
            exitProgress={sixthExitProgress}
            progress={sixthProgress}
            sequenceProgress={sixthSequenceProgress}
          />

          <SeventhPipelineScreen
            exitProgress={seventhExitProgress}
            progress={seventhProgress}
            sequenceProgress={seventhSequenceProgress}
            shouldMount={seventhShouldMount}
          />

          <EighthControlScreen
            exitProgress={eighthExitProgress}
            progress={eighthProgress}
            sequenceProgress={eighthSequenceProgress}
          />

          <NinthWorkflowScreen
            exitProgress={ninthExitProgress}
            progress={ninthProgress}
            sequenceProgress={ninthSequenceProgress}
          />

          <TenthTestimonialsScreen
            exitProgress={tenthExitProgress}
            progress={tenthProgress}
          />

          <EleventhFaqScreen
            exitProgress={eleventhExitProgress}
            progress={eleventhProgress}
          />

          <TwelfthFinalScreen
            progress={twelfthProgress}
            onStart={() => setLoginOpen(true)}
          />
        </div>
      </section>

      {!introComplete && !reducedMotion ? (
        <IntroRitualScreen
          reducedMotion={reducedMotion}
          onComplete={completeIntro}
        />
      ) : null}

      {introComplete && !flowReady && !reducedMotion ? (
        <div className={layout.cinemaTransition} aria-hidden="true" />
      ) : null}

      <button
        type="button"
        className={`${layout.backToTop} ${pageScrolled ? layout.backToTopVisible : ""}`}
        aria-label="回到顶部"
        title="回到顶部"
        onClick={scrollToTop}
      >
        <ChevronUp aria-hidden="true" />
      </button>

      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
    </main>
  );
}
