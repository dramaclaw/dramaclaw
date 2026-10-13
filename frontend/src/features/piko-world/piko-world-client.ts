// SPDX-License-Identifier: Elastic-2.0
import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "@/api/client";
import type { PikoPlayerGender } from "./piko-player";
import { PIKO_CHAT_BUBBLE_MS } from "./piko-public-chat";
import { PRIVATE_CHAT_HISTORY_LIMIT, PUBLIC_CHAT_HISTORY_LIMIT } from "./piko-chat-history";
import { isPlayerAccessorySelection, type PlayerAccessorySelection } from "./piko-player-accessories";

const PIKO_HEARTBEAT_MS = 15_000;
const MESSAGE_CONFIRMATION_TIMEOUT_MS = 8_000;

export type PikoCharacter = {
  id: string;
  nickname: string;
  gender: PikoPlayerGender;
  bio: string;
  scene_id: string;
  position_x: number;
  position_y: number;
  facing: PikoFacing;
};
export type PikoFacing = "north" | "south" | "east" | "west";
export type PikoRemotePlayer = {
  character_id: string;
  nickname: string;
  bio?: string;
  gender: PikoPlayerGender;
  scene_id: string;
  x: number;
  y: number;
  facing: PikoFacing;
  seat_id?: string | null;
  accessory_id?: PlayerAccessorySelection;
  speech?: { id: string; body: string; expiresAt: number };
};
export type PikoWorldChatMessage = {
  id: string;
  character_id: string;
  nickname: string;
  body: string;
  sent_at: string;
  client_message_id?: string;
};
export type PikoPrivateChatRequest = {
  id: string;
  from_character_id: string;
  from_nickname: string;
  sent_at: string;
};
export type PikoPrivateChatPeer = {
  request_id: string;
  character_id: string;
  nickname: string;
  status?: "draft" | "pending" | "declined" | "active";
  openVersion?: number;
};
export type PikoPrivateChatMessage = {
  id: string;
  from_character_id: string;
  to_character_id: string;
  from_nickname: string;
  body: string;
  sent_at: string;
  client_message_id?: string;
};

export async function fetchPikoCharacter(): Promise<PikoCharacter | null> {
  const response = await apiClient.get("piko/character").json<{ character: PikoCharacter | null }>();
  return response.character;
}

export async function savePikoCharacter(
  gender: PikoPlayerGender,
  nickname: string,
  bio = "",
): Promise<PikoCharacter> {
  const response = await apiClient.put("piko/character", {
    json: { gender, nickname, bio },
  }).json<{ character: PikoCharacter }>();
  return response.character;
}

function worldSocketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/v1/piko/world/ws`;
}

function validPlayer(value: unknown): value is PikoRemotePlayer {
  if (!value || typeof value !== "object") return false;
  const player = value as Record<string, unknown>;
  return typeof player.character_id === "string" && typeof player.nickname === "string"
    && (player.gender === "male" || player.gender === "female")
    && typeof player.scene_id === "string" && typeof player.x === "number" && Number.isFinite(player.x)
    && typeof player.y === "number" && Number.isFinite(player.y)
    && (player.seat_id === undefined || player.seat_id === null || typeof player.seat_id === "string")
    && (player.accessory_id === undefined || isPlayerAccessorySelection(player.accessory_id))
    && ["north", "south", "east", "west"].includes(String(player.facing));
}

function validPrivateMessage(value: unknown): value is PikoPrivateChatMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return ["id", "from_character_id", "to_character_id", "body"].every(key =>
    typeof message[key] === "string" && message[key].length > 0)
    && typeof message.from_nickname === "string"
    && typeof message.sent_at === "string" && Number.isFinite(Date.parse(message.sent_at));
}

function mergePrivateMessages(
  messages: PikoPrivateChatMessage[], incoming: unknown[], ownCharacterId: string, livePeerId?: string,
) {
  const byId = new Map(messages.map(message => [message.id, message]));
  for (const message of incoming) {
    if (validPrivateMessage(message)
      && (message.from_character_id === ownCharacterId || message.to_character_id === ownCharacterId)) {
      byId.set(message.id, message);
    }
  }
  const merged = [...byId.values()].sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at));
  if (!livePeerId) return merged;
  // Limit only the live conversation; another peer's pending queue must stay intact.
  const history = merged.filter(message => message.from_character_id === livePeerId
    || message.to_character_id === livePeerId);
  const dropped = new Set(history.slice(0, -PRIVATE_CHAT_HISTORY_LIMIT).map(message => message.id));
  return merged.filter(message => !dropped.has(message.id));
}

export function upsertRemotePlayer(
  players: PikoRemotePlayer[],
  next: PikoRemotePlayer,
  now = Date.now(),
) {
  const previous = players.find(player => player.character_id === next.character_id);
  const speech = previous?.speech && previous.speech.expiresAt > now
    ? previous.speech
    : undefined;
  return [
    ...players.filter(player => player.character_id !== next.character_id),
    speech ? { ...next, speech } : next,
  ];
}

export function usePikoWorldConnection(character: PikoCharacter | null, sceneId: string, accessory: PlayerAccessorySelection = null) {
  const characterRef = useRef(character);
  characterRef.current = character;
  const accessoryRef = useRef(accessory);
  accessoryRef.current = accessory;
  const characterId = character?.id ?? null;
  const [remotePlayers, setRemotePlayers] = useState<PikoRemotePlayer[]>([]);
  const [chatMessages, setChatMessages] = useState<PikoWorldChatMessage[]>([]);
  const [chatRequests, setChatRequests] = useState<PikoPrivateChatRequest[]>([]);
  const [privateChatPeers, setPrivateChatPeers] = useState<PikoPrivateChatPeer[]>([]);
  const [privateChatMessages, setPrivateChatMessages] = useState<PikoPrivateChatMessage[]>([]);
  const privateChatPeersRef = useRef(privateChatPeers);
  privateChatPeersRef.current = privateChatPeers;
  const remotePlayersRef = useRef(remotePlayers);
  remotePlayersRef.current = remotePlayers;
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const sceneRef = useRef(sceneId);
  const reconnectRef = useRef<number | undefined>(undefined);
  const closedRef = useRef(false);
  const profileSentRef = useRef<string | null>(null);
  const sendSequenceRef = useRef(0);
  const pendingSendsRef = useRef(new Map<string, { resolve: (accepted: boolean) => void; timer: number }>());
  const lastPositionRef = useRef({
    x: character?.position_x ?? 1270,
    y: character?.position_y ?? 480,
    facing: character?.facing ?? "south" as PikoFacing,
    seat_id: null as string | null,
  });
  sceneRef.current = sceneId;
  // The connection belongs to the character id; profile and equipment updates
  // are synchronized over the existing socket without reopening private chats.

  const send = useCallback((payload: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }, []);

  const finishSend = useCallback((identifier: string, accepted: boolean) => {
    const pending = pendingSendsRef.current.get(identifier);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingSendsRef.current.delete(identifier);
    pending.resolve(accepted);
  }, []);
  const failPendingSends = useCallback(() => {
    for (const identifier of pendingSendsRef.current.keys()) finishSend(identifier, false);
  }, [finishSend]);
  const sendConfirmed = useCallback((payload: Record<string, unknown>): Promise<boolean> => {
    const identifier = globalThis.crypto?.randomUUID?.()
      ?? `${Date.now()}-${++sendSequenceRef.current}`;
    return new Promise(resolve => {
      const timer = window.setTimeout(() => finishSend(identifier, false), MESSAGE_CONFIRMATION_TIMEOUT_MS);
      pendingSendsRef.current.set(identifier, { resolve, timer });
      if (!send({ ...payload, client_message_id: identifier })) finishSend(identifier, false);
    });
  }, [finishSend, send]);
  const syncProfile = useCallback(() => {
    const current = characterRef.current;
    if (!current) return;
    const signature = JSON.stringify([current.nickname, current.bio, current.gender, accessoryRef.current]);
    if (profileSentRef.current !== signature && send({ type: "profile.update", accessory_id: accessoryRef.current })) {
      profileSentRef.current = signature;
    }
  }, [send]);

  useEffect(() => {
    const character = characterRef.current;
    setConnected(false);
    setRemotePlayers([]);
    setChatMessages([]);
    setChatRequests([]);
    setPrivateChatPeers([]);
    setPrivateChatMessages([]);
    if (!character) return;
    lastPositionRef.current = {
      x: character.position_x, y: character.position_y, facing: character.facing,
      seat_id: null,
    };
    profileSentRef.current = null;
    closedRef.current = false;
    let heartbeatTimer: number | undefined;
    let pageIsLeaving = false;
    const stopHeartbeat = () => {
      if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    };
    const leaveWorld = () => {
      pageIsLeaving = true;
      failPendingSends();
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) send({ type: "client.leave" });
      socket?.close(1000, "page_exit");
    };
    const connect = () => {
      if (closedRef.current) return;
      const socket = new WebSocket(worldSocketUrl());
      socketRef.current = socket;
      socket.onopen = () => {
        if (socketRef.current !== socket) return;
        if (pageIsLeaving || closedRef.current) {
          socket.close(1000, "page_exit");
          return;
        }
        setConnected(true);
        profileSentRef.current = null;
        send({ type: "scene.join", scene_id: sceneRef.current, ...lastPositionRef.current });
        syncProfile();
        stopHeartbeat();
        heartbeatTimer = window.setInterval(() => {
          if (socketRef.current === socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "ping" }));
          }
        }, PIKO_HEARTBEAT_MS);
      };
      socket.onmessage = event => {
        if (socketRef.current !== socket) return;
        let frame: Record<string, unknown>;
        try { frame = JSON.parse(String(event.data)) as Record<string, unknown>; } catch { return; }
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
        if (frame.type === "error" && frame.code === "chat_request_unavailable" && typeof frame.request_id === "string") {
          setChatRequests(requests => requests.filter(request => request.id !== frame.request_id));
          setPrivateChatPeers(peers => peers.map(peer => peer.status === "pending" && peer.request_id === frame.request_id
            ? { ...peer, status: "draft", request_id: "" } : peer));
        }
        if (typeof frame.client_message_id === "string" && (frame.type === "chat.sent" || frame.type === "error")) {
          finishSend(frame.client_message_id, frame.type === "chat.sent");
          return;
        }
        if (frame.type === "world.snapshot" && Array.isArray(frame.players)) {
          setRemotePlayers(frame.players.filter(validPlayer));
          return;
        }
        if ((frame.type === "player.joined" || frame.type === "player.moved" || frame.type === "player.updated") && validPlayer(frame.player)) {
          const next = frame.player;
          setRemotePlayers(players => upsertRemotePlayer(players, next));
          setPrivateChatPeers(peers => peers.map(peer => peer.character_id === next.character_id
            ? { ...peer, nickname: next.nickname } : peer));
          return;
        }
        if (frame.type === "player.left" && typeof frame.character_id === "string") {
          setRemotePlayers(players => players.filter(player => player.character_id !== frame.character_id));
          return;
        }
        if (frame.type === "chat.message" && frame.message && typeof frame.message === "object") {
          const message = frame.message as PikoWorldChatMessage;
          if (!message.id || !message.character_id || !message.body) return;
          if (message.character_id === character.id && message.client_message_id) finishSend(message.client_message_id, true);
          setChatMessages(messages => messages.some(item => item.id === message.id)
            ? messages : [...messages.slice(-(PUBLIC_CHAT_HISTORY_LIMIT - 1)), message]);
          if (message.character_id !== character.id) {
            setRemotePlayers(players => players.map(player => player.character_id === message.character_id
              ? { ...player, speech: {
                  id: message.id,
                  body: message.body,
                  expiresAt: Date.now() + PIKO_CHAT_BUBBLE_MS,
                } }
              : player));
          }
          return;
        }
        if (frame.type === "chat.request" && frame.request && typeof frame.request === "object") {
          const request = frame.request as PikoPrivateChatRequest;
          if (!request.id || !request.from_character_id || !request.from_nickname) return;
          setChatRequests(requests => requests.some(item => item.id === request.id)
            ? requests
            : [...requests.slice(-19), request]);
          return;
        }
        if ((frame.type === "chat.request.sent" || frame.type === "chat.request.message.sent") && typeof frame.target_character_id === "string"
          && typeof frame.request_id === "string") {
          // A fast response on another worker may arrive before the sender's receipt.
          setPrivateChatPeers(peers => peers.map(peer => peer.character_id === frame.target_character_id
            && peer.status !== "active"
            && !(peer.request_id === frame.request_id && peer.status === "declined")
            ? { ...peer, request_id: frame.request_id as string, status: "pending" } : peer));
          if (frame.message) setPrivateChatMessages(messages => mergePrivateMessages(messages, [frame.message], character.id));
          if (typeof frame.client_message_id === "string") finishSend(frame.client_message_id, true);
          return;
        }
        if (frame.type === "chat.request.responded" && typeof frame.request_id === "string"
          && frame.peer && typeof frame.peer === "object") {
          const peer = frame.peer as { character_id?: unknown; nickname?: unknown };
          if (typeof peer.character_id !== "string" || typeof peer.nickname !== "string"
            || typeof frame.accepted !== "boolean") return;
          setChatRequests(requests => requests.filter(item => item.id !== frame.request_id));
          if (typeof frame.client_message_id === "string") finishSend(frame.client_message_id, true);
          if (frame.accepted !== true) {
            setPrivateChatPeers(peers => peers.map(item => item.character_id === peer.character_id
              && item.status !== "active" && (item.request_id === frame.request_id || item.status === "draft")
              ? { ...item, request_id: frame.request_id as string, status: "declined" } : item));
            return;
          }
          const acceptedPeer: PikoPrivateChatPeer = {
            request_id: frame.request_id,
            character_id: peer.character_id,
            nickname: peer.nickname,
            status: "active",
            openVersion: 1,
          };
          setPrivateChatPeers(peers => {
            const previous = peers.find(item => item.character_id === acceptedPeer.character_id);
            return [...peers.filter(item => item.character_id !== acceptedPeer.character_id),
              { ...acceptedPeer, openVersion: previous?.openVersion ?? acceptedPeer.openVersion }];
          });
          const buffered = (Array.isArray(frame.messages) ? frame.messages
            : frame.message ? [frame.message] : []);
          if (buffered.length) setPrivateChatMessages(messages => mergePrivateMessages(messages, buffered, character.id));
          return;
        }
        if (frame.type === "chat.private.message" && validPrivateMessage(frame.message)) {
          const message = frame.message;
          if (message.from_character_id === character.id && message.client_message_id) finishSend(message.client_message_id, true);
          const peerId = message.from_character_id === character.id ? message.to_character_id : message.from_character_id;
          setPrivateChatMessages(messages => mergePrivateMessages(messages, [message], character.id, peerId));
          return;
        }
        if (frame.type === "chat.private.ended" && typeof frame.character_id === "string") {
          setPrivateChatPeers(peers => peers.filter(
            peer => peer.character_id !== frame.character_id,
          ));
        }
      };
      socket.onclose = event => {
        if (socketRef.current !== socket) return;
        stopHeartbeat();
        socketRef.current = null;
        setConnected(false);
        setRemotePlayers([]);
        setChatRequests([]);
        setPrivateChatPeers([]);
        setPrivateChatMessages([]);
        failPendingSends();
        if (!closedRef.current && !pageIsLeaving
          && event.code !== 1008 && event.code !== 4001) {
          reconnectRef.current = window.setTimeout(connect, 1500);
        }
      };
    };
    const resumeWorld = (event: PageTransitionEvent) => {
      if (!event.persisted || closedRef.current) return;
      pageIsLeaving = false;
      const state = socketRef.current?.readyState;
      if (state !== WebSocket.OPEN && state !== WebSocket.CONNECTING) connect();
    };
    window.addEventListener("pagehide", leaveWorld);
    window.addEventListener("beforeunload", leaveWorld);
    window.addEventListener("pageshow", resumeWorld);
    connect();
    return () => {
      closedRef.current = true;
      failPendingSends();
      leaveWorld();
      window.removeEventListener("pagehide", leaveWorld);
      window.removeEventListener("beforeunload", leaveWorld);
      window.removeEventListener("pageshow", resumeWorld);
      stopHeartbeat();
      if (reconnectRef.current !== undefined) window.clearTimeout(reconnectRef.current);
      socketRef.current = null;
      // onclose ignores a socket this cleanup already detached, so drop what it owned here.
      setConnected(false);
      setRemotePlayers([]);
      setChatRequests([]);
      setPrivateChatPeers([]);
      setPrivateChatMessages([]);
    };
  }, [characterId, failPendingSends, finishSend, send, syncProfile]);

  useEffect(syncProfile, [characterId, character?.nickname, character?.bio, character?.gender, accessory, syncProfile]);

  useEffect(() => {
    setRemotePlayers([]);
    lastPositionRef.current.seat_id = null;
    if (characterId) send({ type: "scene.join", scene_id: sceneId, ...lastPositionRef.current });
  }, [characterId, sceneId, send]);

  const move = useCallback((x: number, y: number, facing: PikoFacing, seatId: string | null = null) => {
    lastPositionRef.current = { x, y, facing, seat_id: seatId };
    send({ type: "player.move", ...lastPositionRef.current });
  }, [send]);
  const chat = useCallback((body: string) => sendConfirmed({ type: "chat.send", body }), [sendConfirmed]);
  const openPrivateChat = useCallback((targetCharacterId: string) => {
    const target = remotePlayersRef.current.find(player => player.character_id === targetCharacterId);
    if (!target || socketRef.current?.readyState !== WebSocket.OPEN) return false;
    setPrivateChatPeers(peers => {
      const existing = peers.find(peer => peer.character_id === targetCharacterId);
      return [...peers.filter(peer => peer.character_id !== targetCharacterId), {
        ...(existing ?? { request_id: "", character_id: targetCharacterId, status: "draft" as const }),
        nickname: target.nickname,
        openVersion: (existing?.openVersion ?? 0) + 1,
      }];
    });
    return true;
  }, []);
  const respondToChatRequest = useCallback((requestId: string, accepted: boolean) => sendConfirmed({
    type: "chat.request.respond", request_id: requestId, accepted,
  }), [sendConfirmed]);
  const sendPrivateChat = useCallback((targetCharacterId: string, body: string) => {
    const peer = privateChatPeersRef.current.find(item => item.character_id === targetCharacterId);
    return sendConfirmed({
      type: peer?.status === "pending" ? "chat.request.message"
        : peer?.status === "draft" || peer?.status === "declined" ? "chat.request" : "chat.private.send",
      ...(peer?.status === "pending" ? { request_id: peer.request_id } : {}),
      target_character_id: targetCharacterId, body,
    });
  }, [sendConfirmed]);
  return {
    remotePlayers, chatMessages, chatRequests, privateChatPeers, privateChatMessages,
    connected, move, chat, openPrivateChat, respondToChatRequest, sendPrivateChat,
  };
}
