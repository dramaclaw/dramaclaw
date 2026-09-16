// SPDX-License-Identifier: Elastic-2.0
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { PIKO_SIMULATED_RESIDENT } from "./piko-simulated-resident";
import { playPikoUiSound, unlockPikoNotifications } from "./piko-audio";
import inputStyles from "./piko-input.module.css";
import styles from "./piko-private-chat.module.css";
import popup from "./piko-popup.module.css";
import icon from "./piko-icon-button.module.css";

const ROOT = "/piko/world/ui/private-chat-request/piko-private-chat-request-";
function PikoPrivateConversation({ active, onOpenChange, nickname, delay, ownNickname }: {
  active: boolean; onOpenChange: (open: boolean) => void; nickname: string; delay: number; ownNickname: string;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<"waiting" | "requested" | "accepted" | "declined" | "closed">("waiting");
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const [unread, setUnread] = useState(0);
  const [removed, setRemoved] = useState(false);
  const fading = phase === "declined" || phase === "closed";
  useEffect(() => {
    if (!fading) return;
    const timer = window.setTimeout(() => setRemoved(true), 950);
    return () => window.clearTimeout(timer);
  }, [fading]);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<{ id: number; body: string; mine: boolean; time: string }[]>([]);
  const [pendingReply, setPendingReply] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const sequence = useRef(0);
  useEffect(() => {
    if (!active || phase !== "waiting") return;
    const timer = window.setTimeout(() => { setPhase("requested"); playPikoUiSound("notification"); }, delay);
    return () => window.clearTimeout(timer);
  }, [active, phase, delay]);
  useEffect(() => {
    onOpenChange(open);
    return () => onOpenChange(false);
  }, [open, onOpenChange]);
  useEffect(() => {
    if (!pendingReply) return;
    const timer = window.setTimeout(() => {
      setMessages(current => [...current, { id: ++sequence.current, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }), mine: false, body: t("pikoWorld.privateMockReply", { nickname }) }]);
      if (!openRef.current) setUnread(count => count + 1);
      setPendingReply(false);
      playPikoUiSound("notification");
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [pendingReply, t, nickname]);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [messages, open]);
  const respond = (accept: boolean) => {
    if (phase !== "requested") return;
    playPikoUiSound(accept ? "open" : "close");
    setPhase(accept ? "accepted" : "declined");
    if (accept) {
      setMessages([{ id: ++sequence.current, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }), body: t("pikoWorld.privateMockGreeting"), mine: false }]);
      setOpen(true);
    }
  };
  const send = () => {
    const body = draft.trim();
    if (!body || Array.from(body).length > 80 || pendingReply) return;
    setMessages(current => [...current, { id: ++sequence.current, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }), body, mine: true }]);
    setDraft(""); setPendingReply(true);
  };
  return <>
    {(phase === "requested" || phase === "accepted" || (fading && !removed)) && <section
      role={phase === "requested" ? "region" : undefined}
      aria-label={phase === "requested" ? t("pikoWorld.privateRequestTitle") : undefined}
      data-state={fading ? "closing" : "open"} aria-hidden={fading || undefined} inert={fading}
      className={`${styles.notification} ${icon.button} relative w-max max-w-full shrink-0 text-[#08214b]`}>
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 flex h-9 drop-shadow-md">
        <img src={`${ROOT}left-v1.png`} alt="" draggable={false} className="h-full w-auto shrink-0 [image-rendering:pixelated]" />
        <img src={`${ROOT}middle-v1.png`} alt="" draggable={false} className="h-full min-w-0 flex-1 [image-rendering:pixelated]" />
        <img src={`${ROOT}right-v1.png`} alt="" draggable={false} className="h-full w-auto shrink-0 [image-rendering:pixelated]" />
      </div>
      {phase !== "accepted" && phase !== "closed" ? <div className="relative flex h-9 items-center justify-center gap-1 whitespace-nowrap pb-1 pl-4 pr-6 text-[11px]">
        <p role="status" className="m-0 mr-2 font-semibold">{t("pikoWorld.privateRequestFrom", { nickname })}</p>
        <button className="rounded px-0.5 py-0.5 font-semibold text-[#276337] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#08214b]" onClick={() => respond(true)}>{t("pikoWorld.privateAccept")}</button>
        <button className="rounded px-0.5 py-0.5 font-normal text-[#826044] focus-visible:outline-2 focus-visible:outline-[#08214b]" onClick={() => respond(false)}>{t("pikoWorld.privateDecline")}</button>
      </div> : <div className="relative flex h-9 items-center gap-1 pb-1 pl-4 pr-5"><button type="button" className={`inline-flex items-center gap-1.5 whitespace-nowrap text-center text-[11px] font-semibold text-[#08214b]`}
        onClick={() => { setUnread(0); setOpen(true); playPikoUiSound("open"); }}>{t("pikoWorld.privateReopen", { nickname })}
          {unread > 0 && <span aria-label={t("pikoWorld.privateUnread", { count: unread })} className="inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-amber-950/45 bg-amber-400 px-1 text-[10px] font-bold leading-none text-amber-950">{unread > 99 ? "99+" : unread}</span>}
        </button>
        <button type="button" aria-label={t("pikoWorld.privateEndChat", { nickname })}
          className="ml-1 inline-flex size-4 items-center justify-center rounded leading-none text-[#08214b]/55 focus-visible:outline-1 focus-visible:outline-[#08214b]"
          onClick={() => { setOpen(false); setPendingReply(false); setUnread(0); setPhase("closed"); playPikoUiSound("close"); }}><svg aria-hidden="true" viewBox="0 0 16 16" className="block size-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="m4 4 8 8m0-8-8 8" /></svg></button>
      </div>}
    </section>}
    <Dialog open={open} onOpenChange={value => { setOpen(value); if (!value) playPikoUiSound("close"); }}>
      <DialogContent showCloseButton={false} aria-describedby={undefined} finalFocus={() => document.getElementById("piko-map-control")}
        overlayClassName="!bg-black/25 !backdrop-blur-none"
        className={`${popup.surface} ${styles.dialog} w-[min(24rem,calc(100vw-6rem))] max-w-[calc(100%-6rem)] gap-0 overflow-visible sm:max-w-96`}>
        <DialogTitle className="sr-only">{nickname}</DialogTitle>
        <div ref={log} role="log" aria-label={t("pikoWorld.privateMessages")} aria-live="polite" className={styles.messages}>
          {messages.map(message => <article key={message.id} className={`flex max-w-[88%] flex-col gap-1 ${message.mine ? "self-end items-end" : "self-start items-start"}`}>
            <div className="flex items-center gap-2 px-1 text-[10px] leading-4 text-amber-950/55"><span className="font-medium">{message.mine ? ownNickname : nickname}</span><time>{message.time}</time></div>
            <p className={`m-0 whitespace-pre-wrap break-words rounded-[min(var(--radius-sm),8px)] border px-2.5 py-1.5 text-xs leading-4 text-amber-950/80 [overflow-wrap:anywhere] ${message.mine ? "border-amber-900/15 bg-amber-100/55" : "border-amber-950/10 bg-white/55"}`}>{message.body}</p>
          </article>)}
        </div>
        <form className={styles.composer} onSubmit={event => { event.preventDefault(); send(); }}>
          <input aria-label={t("pikoWorld.privateMessageInput")} value={draft} onChange={event => setDraft(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }}
            className={inputStyles.input} />
          <p className="mb-0 mt-2 text-[10px] leading-4 text-amber-950/55">{pendingReply ? t("pikoWorld.privateReplying") : t("pikoWorld.privateSendHint")} · {Array.from(draft.trim()).length}/80</p>
        </form>
        <DialogClose render={<button aria-label={t("common.close")} className={`${popup.close} ${icon.button}`} />}>
          <img src="/piko/world/ui/piko-world-close-icon-v1.png" alt="" draggable={false} />
        </DialogClose>
      </DialogContent>
    </Dialog>
  </>;
}


export function PikoPrivateChat({ active, onOpenChange, ownNickname = "你" }: { active: boolean; onOpenChange: (open: boolean) => void; ownNickname?: string }) {
  useEffect(() => {
    document.addEventListener("pointerdown", unlockPikoNotifications, true);
    document.addEventListener("keydown", unlockPikoNotifications, true);
    return () => {
      document.removeEventListener("pointerdown", unlockPikoNotifications, true);
      document.removeEventListener("keydown", unlockPikoNotifications, true);
    };
  }, []);
  const [firstOpen, setFirstOpen] = useState(false);
  const [secondOpen, setSecondOpen] = useState(false);
  const onFirstOpen = useCallback((value: boolean) => setFirstOpen(value), []);
  const onSecondOpen = useCallback((value: boolean) => setSecondOpen(value), []);
  useEffect(() => { onOpenChange(firstOpen || secondOpen); }, [firstOpen, secondOpen, onOpenChange]);
  useEffect(() => () => onOpenChange(false), [onOpenChange]);
  // Map transitions hide the shared tray without remounting its notifications.
  return <div aria-hidden={!active || undefined} inert={!active} style={{ display: active ? undefined : "none" }}
    className="absolute right-4 top-[6.5rem] z-30 flex w-max max-w-[calc(100%-2rem)] flex-col items-end">
    <PikoPrivateConversation active={active} onOpenChange={onFirstOpen} nickname={PIKO_SIMULATED_RESIDENT.nickname} delay={5000} ownNickname={ownNickname} />
    <PikoPrivateConversation active={active} onOpenChange={onSecondOpen} nickname="喜欢散步的小禾" delay={8000} ownNickname={ownNickname} />
  </div>;
}
