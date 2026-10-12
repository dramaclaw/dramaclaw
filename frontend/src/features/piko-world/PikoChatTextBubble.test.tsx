// SPDX-License-Identifier: Elastic-2.0
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { PikoChatTextBubble } from "./PikoChatTextBubble";

it("sizes short messages to their text and lets wrapped messages grow vertically", () => {
  render(<PikoChatTextBubble body={"短消息\n第二行"} />);

  const bubble = screen.getByText(/短消息/);
  expect(bubble).toHaveClass(
    "h-auto",
    "w-fit",
    "max-w-full",
    "whitespace-pre-wrap",
    "break-words",
    "[overflow-wrap:anywhere]",
  );
  expect(bubble).toHaveTextContent("短消息 第二行");
});
