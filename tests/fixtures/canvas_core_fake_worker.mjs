// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import readline from 'node:readline';
import fs from 'node:fs';

let count = 0;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const { id, op, payload = {} } = JSON.parse(line);
  count++;
  let result;
  switch (op) {
    case 'slow_ping':
      await new Promise(resolve => setTimeout(resolve, 40));
      result = { pid: process.pid, count };
      break;
    case 'ping': result = { pid: process.pid, count }; break;
    case 'env': result = { keys: Object.keys(process.env) }; break;
    case 'argv': result = { argv: process.execArgv }; break;
    case 'stderr_line': console.error('worker diagnostic'); result = {}; break;
    case 'sleep': await new Promise(() => {}); break;
    case 'crash': process.exit(1); break;
    case 'garbage': console.log('not-json'); continue;
    case 'null_result': result = null; break;
    case 'bool_result': result = true; break;
    case 'no_result': console.log(JSON.stringify({ id, ok: true })); continue;
    case 'wrong_id': console.log(JSON.stringify({ id: 'wrong', ok: true, result: {} })); continue;
    case 'fail':
      console.log(JSON.stringify({ id, ok: false,
        error: { code: 'bad_input', message: 'bad input' } }));
      continue;
    case 'invalid_request':
      console.log(JSON.stringify({ id, ok: false,
        error: { code: 'invalid_request', message: 'invalid request' } }));
      continue;
    case 'readfile':
      try { fs.readFileSync(payload.path); result = { code: 'allowed' }; }
      catch (error) { result = { code: error.code }; }
      break;
    case 'apply_commands':
      result = {
        status: 'applied',
        canvas: { nodes: [...payload.canvas.nodes, { id: 'n-' + count }],
          edges: payload.canvas.edges },
        changes: { created_node_ids: ['n-' + count], updated_node_ids: [], deleted_node_ids: [],
          created_edge_ids: [], deleted_edge_ids: [] },
        receipt: { canvas_apply_status: 'applied' },
      };
      break;
    default: result = {};
  }
  console.log(JSON.stringify({ id, ok: true, result }));
}
