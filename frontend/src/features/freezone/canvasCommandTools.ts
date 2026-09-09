export const FREEZONE_CANVAS_WRITE_TOOL_NAMES = [
  "freezone_emit_canvas_command",
  "freezone_confirm_workflow_draft",
  "freezone_create_node",
  "freezone_add_next_node",
  "freezone_update_node_data",
  "freezone_create_edge",
  "freezone_delete_nodes",
  "freezone_delete_edges",
  "freezone_move_nodes",
  "freezone_layout_nodes",
  "freezone_group_nodes",
  "freezone_select_nodes",
  "freezone_run_node_action",
  "freezone_open_mainline_projection",
] as const;

export const FREEZONE_CANVAS_WRITE_TOOL_NAME_SET = new Set<string>(FREEZONE_CANVAS_WRITE_TOOL_NAMES);
