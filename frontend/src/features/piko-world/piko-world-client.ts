// SPDX-License-Identifier: Elastic-2.0
import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "@/api/client";
import type { PikoPlayerGender } from "./piko-player";

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
  speech?: { id: string; body: string; expiresAt: number };
};
export type PikoWorldChatMessage = {
  id: string;
  character_id: string;
  nickname: string;
  body: string;
  sent_at: string;
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
};
export type PikoPrivateChatMessage = {
  id: string;
  from_character_id: string;
  to_character_id: string;
  from_nickname: string;
  body: string;
  sent_at: string;
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
    && typeof player.scene_id === "string" && typeof player.x === "number"
    && typeof player.y === "number"
    && ["north", "south", "east", "west"].includes(String(player.facing));
}

export function usePikoWorldConnection(character: PikoCharacter | null, sceneId: string) {
  const [remotePlayers, setRemotePlayers] = useState<PikoRemotePlayer[]>([]);
  const [chatMessages, setChatMessages] = useState<PikoWorldChatMessage[]>([]);
  const [chatRequests, setChatRequests] = useState<PikoPrivateChatRequest[]>([]);
  const [privateChatPeers, setPrivateChatPeers] = useState<PikoPrivateChatPeer[]>([]);
  const [privateChatMessages, setPrivateChatMessages] = useState<PikoPrivateChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const sceneRef = useRef(sceneId);
  const reconnectRef = useRef<number | undefined>(undefined);
  const closedRef = useRef(false);
  const lastPositionRef = useRef({
    x: character?.position_x ?? 1270,
    y: character?.position_y ?? 480,
    facing: character?.facing ?? "south" as PikoFacing,
  });
  sceneRef.current = sceneId;

  const send = useCallback((payload: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }, []);

  useEffect(() => {
    if (!character) return;
    closedRef.current = false;
    const connect = () => {
      if (closedRef.current) return;
      const socket = new WebSocket(worldSocketUrl());
      socketRef.current = socket;
      socket.onopen = () => {
        if (socketRef.current !== socket) return;
        setConnected(true);
        send({ type: "scene.join", scene_id: sceneRef.current, ...lastPositionRef.current });
      };
      socket.onmessage = event => {
        if (socketRef.current !== socket) return;
        let frame: Record<string, unknown>;
        try { frame = JSON.parse(String(event.data)) as Record<string, unknown>; } catch { return; }
        if (frame.type === "world.snapshot" && Array.isArray(frame.players)) {
          setRemotePlayers(frame.players.filter(validPlayer));
          return;
        }
        if ((frame.type === "player.joined" || frame.type === "player.moved") && validPlayer(frame.player)) {
          const next = frame.player;
          setRemotePlayers(players => [...players.filter(player => player.character_id !== next.character_id), next]);
          return;
        }
        if (frame.type === "player.left" && typeof frame.character_id === "string") {
          setRemotePlayers(players => players.filter(player => player.character_id !== frame.character_id));
          return;
        }
        if (frame.type === "chat.message" && frame.message && typeof frame.message === "object") {
          const message = frame.message as PikoWorldChatMessage;
          if (!message.id || !message.character_id || !message.body) return;
          setChatMessages(messages => [...messages.slice(-99), message]);
          if (message.character_id !== character.id) {
            setRemotePlayers(players => players.map(player => player.character_id === message.character_id
              ? { ...player, speech: { id: message.id, body: message.body, expiresAt: Date.now() + 5000 } }
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
        if (frame.type === "chat.request.responded" && typeof frame.request_id === "string"
          && frame.peer && typeof frame.peer === "object") {
          const peer = frame.peer as { character_id?: unknown; nickname?: unknown };
          setChatRequests(requests => requests.filter(item => item.id !== frame.request_id));
          if (frame.accepted !== true || typeof peer.character_id !== "string"
            || typeof peer.nickname !== "string") return;
          const acceptedPeer: PikoPrivateChatPeer = {
            request_id: frame.request_id,
            character_id: peer.character_id,
            nickname: peer.nickname,
          };
          setPrivateChatPeers(peers => [
            ...peers.filter(item => item.character_id !== acceptedPeer.character_id),
            acceptedPeer,
          ]);
          return;
        }
        if (frame.type === "chat.private.message" && frame.message
          && typeof frame.message === "object") {
          const message = frame.message as PikoPrivateChatMessage;
          if (!message.id || !message.from_character_id || !message.to_character_id
            || !message.body) return;
          setPrivateChatMessages(messages => messages.some(item => item.id === message.id)
            ? messages
            : [...messages.slice(-199), message]);
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
        socketRef.current = null;
        setConnected(false);
        setRemotePlayers([]);
        setChatRequests([]);
        setPrivateChatPeers([]);
        setPrivateChatMessages([]);
        if (!closedRef.current && event.code !== 1008 && event.code !== 4001) {
          reconnectRef.current = window.setTimeout(connect, 1500);
        }
      };
    };
    connect();
    return () => {
      closedRef.current = true;
      if (reconnectRef.current !== undefined) window.clearTimeout(reconnectRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [character, send]);

  useEffect(() => {
    setRemotePlayers([]);
    if (character) send({ type: "scene.join", scene_id: sceneId, ...lastPositionRef.current });
  }, [character, sceneId, send]);

  const move = useCallback((x: number, y: number, facing: PikoFacing) => {
    lastPositionRef.current = { x, y, facing };
    send({ type: "player.move", x, y, facing });
  }, [send]);
  const chat = useCallback((body: string) => send({ type: "chat.send", body }), [send]);
  const requestChat = useCallback((targetCharacterId: string) => send({
    type: "chat.request", target_character_id: targetCharacterId,
  }), [send]);
  const respondToChatRequest = useCallback((requestId: string, accepted: boolean) => send({
    type: "chat.request.respond", request_id: requestId, accepted,
  }), [send]);
  const sendPrivateChat = useCallback((targetCharacterId: string, body: string) => send({
    type: "chat.private.send", target_character_id: targetCharacterId, body,
  }), [send]);
  const endPrivateChat = useCallback((targetCharacterId: string) => {
    const sent = send({
      type: "chat.private.end", target_character_id: targetCharacterId,
    });
    if (sent) setPrivateChatPeers(peers => peers.filter(
      peer => peer.character_id !== targetCharacterId,
    ));
    return sent;
  }, [send]);
  return {
    remotePlayers, chatMessages, chatRequests, privateChatPeers, privateChatMessages,
    connected, move, chat, requestChat, respondToChatRequest, sendPrivateChat,
    endPrivateChat,
  };
}
