// SPDX-License-Identifier: Elastic-2.0
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { playPikoUiSound, unlockPikoNotifications } from "./piko-audio";
import type {
  PikoPrivateChatMessage,
  PikoPrivateChatPeer,
  PikoPrivateChatRequest,
} from "./piko-world-client";
import { PikoChatTranslation } from "./PikoChatTranslation";
import inputStyles from "./piko-input.module.css";
import styles from "./piko-private-chat.module.css";
import popup from "./piko-popup.module.css";
import icon from "./piko-icon-button.module.css";

const ROOT = "/piko/world/ui/private-chat-request/piko-private-chat-request-";

function RequestSkin({ children, state = "open" }: {
  children: React.ReactNode;
  state?: "open" | "closing";
}) {
  return <section data-state={state} aria-hidden={state === "closing" || undefined}
    inert={state === "closing"}
    className={`${styles.notification} ${icon.button} relative w-max max-w-full shrink-0 text-[#08214b]`}>
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 flex h-9 drop-shadow-md">
      <img src={`${ROOT}left-v1.png`} alt="" draggable={false} className="h-full w-auto shrink-0 [image-rendering:pixelated]" />
      <img src={`${ROOT}middle-v1.png`} alt="" draggable={false} className="h-full min-w-0 flex-1 [image-rendering:pixelated]" />
      <img src={`${ROOT}right-v1.png`} alt="" draggable={false} className="h-full w-auto shrink-0 [image-rendering:pixelated]" />
    </div>
    {children}
  </section>;
}

function IncomingRequest({ request, onRespond }: {
  request: PikoPrivateChatRequest;
  onRespond: (requestId: string, accepted: boolean) => boolean;
}) {
  const { t } = useTranslation();
  const [responding, setResponding] = useState(false);
  useEffect(() => { playPikoUiSound("notification"); }, []);
  const respond = (accepted: boolean) => {
    if (responding || !onRespond(request.id, accepted)) return;
    setResponding(true);
    playPikoUiSound(accepted ? "open" : "close");
  };
  return <RequestSkin>
    <div role="region" aria-label={t("pikoWorld.privateRequestTitle")}
      className="relative flex h-9 items-center justify-center gap-1 whitespace-nowrap pb-1 pl-4 pr-6 text-[11px]">
      <p role="status" className="m-0 mr-2 font-semibold">
        {t("pikoWorld.privateRequestFrom", { nickname: request.from_nickname })}
      </p>
      <button disabled={responding}
        className="rounded px-0.5 py-0.5 font-semibold text-[#276337] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#08214b] disabled:opacity-50"
        onClick={() => respond(true)}>{t("pikoWorld.privateAccept")}</button>
      <button disabled={responding}
        className="rounded px-0.5 py-0.5 font-normal text-[#826044] focus-visible:outline-2 focus-visible:outline-[#08214b] disabled:opacity-50"
        onClick={() => respond(false)}>{t("pikoWorld.privateDecline")}</button>
    </div>
  </RequestSkin>;
}

function PrivateConversation({ peer, messages, ownCharacterId, ownNickname, onOpenChange,
  onSend, onEnd }: {
  peer: PikoPrivateChatPeer;
  messages: PikoPrivateChatMessage[];
  ownCharacterId: string;
  ownNickname: string;
  onOpenChange: (characterId: string, open: boolean) => void;
  onSend: (characterId: string, body: string) => boolean;
  onEnd: (characterId: string) => boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const openRef = useRef(true);
  openRef.current = open;
  const [unread, setUnread] = useState(0);
  const [draft, setDraft] = useState("");
  const seenMessages = useRef(new Set(messages.map(message => message.id)));
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { playPikoUiSound("open"); }, []);
  useEffect(() => {
    onOpenChange(peer.character_id, open);
    return () => onOpenChange(peer.character_id, false);
  }, [onOpenChange, open, peer.character_id]);
  useEffect(() => {
    let incoming = 0;
    for (const message of messages) {
      if (seenMessages.current.has(message.id)) continue;
      seenMessages.current.add(message.id);
      if (message.from_character_id !== ownCharacterId) incoming += 1;
    }
    if (incoming && !openRef.current) {
      setUnread(count => count + incoming);
      playPikoUiSound("notification");
    }
  }, [messages, ownCharacterId]);
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [messages, open]);
  const send = () => {
    const body = draft.trim();
    if (!body || Array.from(body).length > 80 || !onSend(peer.character_id, body)) return;
    setDraft("");
  };
  return <>
    <RequestSkin>
      <div className="relative flex h-9 items-center gap-1 pb-1 pl-4 pr-5">
        <button type="button"
          className="inline-flex items-center gap-1.5 whitespace-nowrap text-center text-[11px] font-semibold text-[#08214b]"
          onClick={() => { setUnread(0); setOpen(true); playPikoUiSound("open"); }}>
          {t("pikoWorld.privateReopen", { nickname: peer.nickname })}
          {unread > 0 && <span aria-label={t("pikoWorld.privateUnread", { count: unread })}
            className="inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-amber-950/45 bg-amber-400 px-1 text-[10px] font-bold leading-none text-amber-950">
            {unread > 99 ? "99+" : unread}
          </span>}
        </button>
        <button type="button" aria-label={t("pikoWorld.privateEndChat", { nickname: peer.nickname })}
          className="ml-1 inline-flex size-4 items-center justify-center rounded leading-none text-[#08214b]/55 focus-visible:outline-1 focus-visible:outline-[#08214b]"
          onClick={() => { if (onEnd(peer.character_id)) playPikoUiSound("close"); }}>
          <svg aria-hidden="true" viewBox="0 0 16 16" className="block size-3" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="m4 4 8 8m0-8-8 8" />
          </svg>
        </button>
      </div>
    </RequestSkin>
    <Dialog open={open} onOpenChange={value => {
      setOpen(value);
      if (!value) playPikoUiSound("close");
    }}>
      <DialogContent showCloseButton={false} aria-describedby={undefined}
        finalFocus={() => document.getElementById("piko-map-control")}
        overlayClassName="!bg-black/25 !backdrop-blur-none"
        className={`${popup.surface} ${styles.dialog} w-[min(24rem,calc(100vw-6rem))] max-w-[calc(100%-6rem)] gap-0 overflow-visible sm:max-w-96`}>
        <DialogTitle className="sr-only">{peer.nickname}</DialogTitle>
        <div ref={log} role="log" aria-label={t("pikoWorld.privateMessages")} aria-live="polite"
          className={styles.messages}>
          {messages.map(message => {
            const mine = message.from_character_id === ownCharacterId;
            return <article key={message.id}
              className={`flex max-w-[88%] flex-col gap-1 ${mine ? "self-end items-end" : "self-start items-start"}`}>
              <div className="flex items-center gap-2 px-1 text-[10px] leading-4 text-amber-950/55">
                <span className="font-medium">{mine ? ownNickname : peer.nickname}</span>
                <time>{new Date(message.sent_at).toLocaleTimeString([], {
                  hour: "2-digit", minute: "2-digit", hour12: false,
                })}</time>
              </div>
              <PikoChatTranslation text={message.body} conversation={`private:${peer.character_id}`}>
                <p className={`m-0 whitespace-pre-wrap break-words rounded-[min(var(--radius-sm),8px)] border px-2.5 py-1.5 text-xs leading-4 text-amber-950/80 [overflow-wrap:anywhere] ${mine ? "border-amber-900/15 bg-amber-100/55" : "border-amber-950/10 bg-white/55"}`}>
                  {message.body}
                </p>
              </PikoChatTranslation>
            </article>;
          })}
        </div>
        <form className={styles.composer} onSubmit={event => { event.preventDefault(); send(); }}>
          <input aria-label={t("pikoWorld.privateMessageInput")} value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
            }} className={inputStyles.input} />
          <p className="mb-0 mt-2 text-[10px] leading-4 text-amber-950/55">
            {t("pikoWorld.privateSendHint")} · {Array.from(draft.trim()).length}/80
          </p>
        </form>
        <DialogClose render={<button aria-label={t("common.close")}
          className={`${popup.close} ${icon.button}`} />}>
          <img src="/piko/world/ui/piko-world-close-icon-v1.png" alt="" draggable={false} />
        </DialogClose>
      </DialogContent>
    </Dialog>
  </>;
}

export function PikoPrivateChat({ active, onOpenChange, ownNickname = "你",
  ownCharacterId = "", requests = [], peers = [], messages = [], onRespond,
  onSend, onEnd }: {
  active: boolean;
  onOpenChange: (open: boolean) => void;
  ownNickname?: string;
  ownCharacterId?: string;
  requests?: PikoPrivateChatRequest[];
  peers?: PikoPrivateChatPeer[];
  messages?: PikoPrivateChatMessage[];
  onRespond?: (requestId: string, accepted: boolean) => boolean;
  onSend?: (characterId: string, body: string) => boolean;
  onEnd?: (characterId: string) => boolean;
}) {
  useEffect(() => {
    document.addEventListener("pointerdown", unlockPikoNotifications, true);
    document.addEventListener("keydown", unlockPikoNotifications, true);
    return () => {
      document.removeEventListener("pointerdown", unlockPikoNotifications, true);
      document.removeEventListener("keydown", unlockPikoNotifications, true);
    };
  }, []);
  const [openConversations, setOpenConversations] = useState<Record<string, boolean>>({});
  const handleConversationOpen = useCallback((characterId: string, open: boolean) => {
    setOpenConversations(current => current[characterId] === open
      ? current
      : { ...current, [characterId]: open });
  }, []);
  useEffect(() => {
    onOpenChange(Object.values(openConversations).some(Boolean));
  }, [onOpenChange, openConversations]);
  useEffect(() => () => onOpenChange(false), [onOpenChange]);
  return <div aria-hidden={!active || undefined} inert={!active}
    style={{ display: active ? undefined : "none" }}
    className="absolute right-4 top-[6.5rem] z-30 flex w-max max-w-[calc(100%-2rem)] flex-col items-end">
    {requests.map(request => <IncomingRequest key={request.id} request={request}
      onRespond={onRespond ?? (() => false)} />)}
    {peers.map(peer => <PrivateConversation key={peer.character_id} peer={peer}
      ownCharacterId={ownCharacterId} ownNickname={ownNickname}
      messages={messages.filter(message => message.from_character_id === peer.character_id
        || message.to_character_id === peer.character_id)}
      onOpenChange={handleConversationOpen} onSend={onSend ?? (() => false)}
      onEnd={onEnd ?? (() => false)} />)}
  </div>;
}
