// SPDX-License-Identifier: Elastic-2.0
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { PikoPrivateChat } from "./PikoPrivateChat";
import type {
  PikoPrivateChatMessage,
  PikoPrivateChatPeer,
  PikoPrivateChatRequest,
} from "./piko-world-client";
import { playPikoUiSound } from "./piko-audio";

vi.mock("./piko-audio", () => ({ playPikoUiSound: vi.fn(), unlockPikoNotifications: vi.fn() }));

const request: PikoPrivateChatRequest = {
  id: "request-one",
  from_character_id: "character-leaf",
  from_nickname: "在线小叶",
  sent_at: "2026-10-09T10:00:00Z",
};
const peer: PikoPrivateChatPeer = {
  request_id: request.id,
  character_id: request.from_character_id,
  nickname: request.from_nickname,
};
const message = (id: string, from: string, to: string, body: string): PikoPrivateChatMessage => ({
  id, from_character_id: from, to_character_id: to,
  from_nickname: from === "character-me" ? "我" : "在线小叶",
  body, sent_at: "2026-10-09T10:01:00Z",
});

beforeEach(() => vi.mocked(playPikoUiSound).mockClear());

it("does not create the old simulated requests", () => {
  render(<PikoPrivateChat active requests={[]} onOpenChange={vi.fn()} />);
  expect(screen.queryByRole("region", { name: "私聊申请" })).toBeNull();
  expect(screen.queryByText(/小苔申请聊天|喜欢散步的小禾申请聊天/)).toBeNull();
});

it("sends the real accept response back through the connection", () => {
  const onRespond = vi.fn(() => true);
  render(<PikoPrivateChat active requests={[request]} onRespond={onRespond}
    onOpenChange={vi.fn()} />);
  expect(screen.getByRole("region", { name: "私聊申请" }))
    .toHaveTextContent("在线小叶申请聊天");
  fireEvent.click(screen.getByRole("button", { name: "接受" }));
  expect(onRespond).toHaveBeenCalledWith(request.id, true);
});

it("opens the same conversation for either participant after server acceptance", () => {
  const onOpenChange = vi.fn();
  render(<PikoPrivateChat active ownCharacterId="character-me" peers={[peer]}
    onOpenChange={onOpenChange} />);
  expect(screen.getByRole("dialog", { name: "在线小叶" })).toBeVisible();
  expect(onOpenChange).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(screen.getByRole("button", { name: "与在线小叶的聊天" })).toBeVisible();
});

it("sends private text through the network callback and renders server messages", () => {
  const onSend = vi.fn(() => true);
  const props = {
    active: true,
    ownCharacterId: "character-me",
    ownNickname: "我",
    peers: [peer],
    onOpenChange: vi.fn(),
    onSend,
  };
  const view = render(<PikoPrivateChat {...props} messages={[]} />);
  const input = screen.getByRole("textbox", { name: "输入私聊消息" });
  fireEvent.change(input, { target: { value: "这是真实私聊" } });
  fireEvent.submit(input.closest("form")!);
  expect(onSend).toHaveBeenCalledWith(peer.character_id, "这是真实私聊");
  expect(input).toHaveValue("");

  view.rerender(<PikoPrivateChat {...props} messages={[
    message("mine", "character-me", peer.character_id, "这是真实私聊"),
    message("theirs", peer.character_id, "character-me", "我收到了"),
  ]} />);
  expect(screen.getByRole("log")).toHaveTextContent("这是真实私聊");
  expect(screen.getByRole("log")).toHaveTextContent("我收到了");
  expect(screen.queryByText(/模拟回复/)).toBeNull();
});

it("ends the real private session through the network callback", () => {
  const onEnd = vi.fn(() => true);
  render(<PikoPrivateChat active ownCharacterId="character-me" peers={[peer]}
    onOpenChange={vi.fn()} onEnd={onEnd} />);
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  fireEvent.click(screen.getByRole("button", { name: "关闭与在线小叶的聊天" }));
  expect(onEnd).toHaveBeenCalledWith(peer.character_id);
});
