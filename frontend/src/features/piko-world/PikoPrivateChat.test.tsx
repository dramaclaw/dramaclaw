// SPDX-License-Identifier: Elastic-2.0
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

it("allows retrying an invitation response after failed confirmation", async () => {
  let finish!: (accepted: boolean) => void;
  const onRespond = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  render(<PikoPrivateChat active requests={[request]} onRespond={onRespond} onOpenChange={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "接受" }));
  expect(screen.getByRole("button", { name: "接受" })).toBeDisabled();
  await act(async () => finish(false));
  expect(screen.getByRole("button", { name: "接受" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "接受" }));
  expect(onRespond).toHaveBeenCalledTimes(2);
  await act(async () => finish(true));
});

it("opens the same conversation for either participant after server acceptance", () => {
  const onOpenChange = vi.fn();
  render(<PikoPrivateChat active ownCharacterId="character-me" peers={[peer]}
    onOpenChange={onOpenChange} />);
  expect(screen.getByRole("dialog", { name: "在线小叶" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "在线小叶" })).toBeVisible();
  expect(onOpenChange).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(screen.getByRole("button", { name: "与在线小叶的聊天" })).toBeVisible();
});

it("hides a portaled conversation while inactive and restores its draft on return", () => {
  const onOpenChange = vi.fn();
  const props = { ownCharacterId: "character-me", peers: [peer], onOpenChange };
  const view = render(<PikoPrivateChat {...props} active />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "未发送的消息" } });
  view.rerender(<PikoPrivateChat {...props} active={false} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
  view.rerender(<PikoPrivateChat {...props} active />);
  expect(screen.getByRole("textbox")).toHaveValue("未发送的消息");
  expect(onOpenChange).toHaveBeenLastCalledWith(true);
});

it("keeps Enter sending enabled while the private request is pending", async () => {
  const user = userEvent.setup();
  const onSend = vi.fn(() => true);
  const props = { active: true, onOpenChange: vi.fn(), onSend, peers: [{ ...peer, status: "draft" as const }] };
  const view = render(<PikoPrivateChat {...props} />);
  expect(screen.queryByRole("button", { name: "发送消息" })).toBeNull();
  await user.type(screen.getByRole("textbox"), "第一条消息{Enter}");
  expect(onSend).toHaveBeenCalledWith(peer.character_id, "第一条消息");
  view.rerender(<PikoPrivateChat {...props} peers={[{ ...peer, status: "pending" }]} />);
  expect(screen.getByRole("textbox")).toBeEnabled();
  await user.type(screen.getByRole("textbox"), "第二条消息{Enter}");
  expect(onSend).toHaveBeenLastCalledWith(peer.character_id, "第二条消息");
  expect(onSend).toHaveBeenCalledTimes(2);
  expect(screen.getByText(/可继续发送消息/)).toBeVisible();
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

it("dismisses only this user's conversation and restores its unread bubble on a new message", () => {
  const props = { active: true, ownCharacterId: "character-me", peers: [peer], onOpenChange: vi.fn() };
  const view = render(<PikoPrivateChat {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  fireEvent.click(screen.getByRole("button", { name: "关闭与在线小叶的聊天" }));
  expect(screen.queryByRole("button", { name: "与在线小叶的聊天" })).toBeNull();
  view.rerender(<PikoPrivateChat {...props} messages={[message("after-close", peer.character_id, "character-me", "对方继续聊天")]} />);
  expect(screen.getByRole("button", { name: /^与在线小叶的聊天/ })).toBeVisible();
  expect(screen.getByLabelText("1 条未读消息")).toBeVisible();
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^与在线小叶的聊天/ }));
  expect(screen.getByRole("log")).toHaveTextContent("对方继续聊天");
});

it("keeps the draft until confirmation and retains it after rejection", async () => {
  let finish!: (accepted: boolean) => void;
  const onSend = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  render(<PikoPrivateChat active ownCharacterId="character-me" peers={[peer]}
    onOpenChange={vi.fn()} onSend={onSend} />);
  const input = screen.getByRole("textbox", { name: "输入私聊消息" });
  fireEvent.change(input, { target: { value: "保留这条消息" } });
  fireEvent.submit(input.closest("form")!);
  fireEvent.submit(input.closest("form")!);
  expect(onSend).toHaveBeenCalledTimes(1);
  expect(input).toHaveValue("保留这条消息");
  await act(async () => finish(false));
  expect(input).toHaveValue("保留这条消息");
  expect(screen.getByRole("alert")).toHaveTextContent("内容已保留");
  fireEvent.submit(input.closest("form")!);
  await act(async () => finish(true));
  expect(input).toHaveValue("");
});

it("keeps a dismissed pending chat closed after acceptance and reopens only on an explicit action", () => {
  const props = { active: true, ownCharacterId: "character-me", onOpenChange: vi.fn() };
  const view = render(<PikoPrivateChat {...props} peers={[{ ...peer, status: "pending", openVersion: 1 }]} />);
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  fireEvent.click(screen.getByRole("button", { name: "关闭与在线小叶的聊天" }));
  const history = [message("buffered", "character-me", peer.character_id, "等待期间的消息")];
  view.rerender(<PikoPrivateChat {...props} peers={[{ ...peer, status: "active", openVersion: 1 }]} messages={history} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button", { name: /^与在线小叶的聊天/ })).toBeNull();
  expect(props.onOpenChange).toHaveBeenLastCalledWith(false);
  view.rerender(<PikoPrivateChat {...props} peers={[{ ...peer, status: "active", openVersion: 2 }]} messages={history} />);
  expect(screen.getByRole("dialog", { name: "在线小叶" })).toBeVisible();
  expect(screen.getByRole("log")).toHaveTextContent("等待期间的消息");
});
