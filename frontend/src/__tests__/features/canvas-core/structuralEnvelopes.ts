// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasChatCommandEnvelope } from "@/features/canvas/core/commands/types";

/** One envelope that creates, chains, moves, renames and disconnects nodes. */
export function structuralEnvelopes(): CanvasChatCommandEnvelope[] {
  return [
    {
      schema_version: "canvas_chat_commands.v1",
      commands: [
        {
          type: "create_node",
          client_id: "first",
          node_type: "textAnnotationNode",
          position: { x: 10, y: 20 },
          data: { content: "Start" },
        },
        {
          type: "add_next_node",
          client_id: "second",
          source_node_id: "first",
          node_type: "imageGenNode",
          data: { prompt: "A night harbor" },
          connect: true,
        },
        {
          type: "create_node",
          client_id: "third",
          node_type: "textAnnotationNode",
          position: { x: 900, y: 40 },
        },
        { type: "move_nodes", deltas: { first: { x: 5, y: 5 } } },
        { type: "update_node_data", node_id: "first", data: { displayName: "Renamed" } },
        { type: "delete_edges", pairs: [{ source: "first", target: "second" }] },
      ],
    },
  ];
}
