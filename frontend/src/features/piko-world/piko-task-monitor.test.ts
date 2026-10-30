// SPDX-License-Identifier: Elastic-2.0
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startPikoTaskMonitor, type PikoTaskTransport } from "./piko-task-monitor";
import { newPikoTaskSession, type PikoTaskSession } from "./piko-task-session";
vi.mock("@/lib/api", () => ({ api: {} }));
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100000); });
afterEach(() => vi.useRealTimers());
function setup(transport: PikoTaskTransport, session: PikoTaskSession = newPikoTaskSession(0)) {
  const options = { transport, session:()=>session, onProjects:vi.fn(), onTasks:vi.fn(), onRevoked:vi.fn(), onUnauthorized:vi.fn() };
  return {...options, monitor:startPikoTaskMonitor(options)};
}
it("limits concurrency to three projects and cancels in-flight callbacks on stop", async () => {
  const resolvers: (()=>void)[]=[];
  const transport={projects:vi.fn().mockResolvedValue(["a","b","c","d"]),tasks:vi.fn(()=>new Promise<never[]>(resolve=>resolvers.push(()=>resolve([]))))};
  const test=setup(transport);
  await vi.advanceTimersByTimeAsync(0);
  expect(transport.tasks).toHaveBeenCalledTimes(3);
  test.monitor.stop();
  resolvers.forEach(resolve=>resolve());
  await vi.advanceTimersByTimeAsync(0);
  expect(test.onTasks).not.toHaveBeenCalled();
  expect(transport.tasks).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});
it("preserves last confirmed state on network errors, but removes revoked project access", async () => {
  const transport={projects:vi.fn().mockResolvedValue(["a","b"]),tasks:vi.fn((p:string)=>Promise.reject(p==="a"?new Error("offline"):{response:{status:403}}))};
  const test=setup(transport);
  await vi.advanceTimersByTimeAsync(0);
  expect(test.onTasks).not.toHaveBeenCalled();
  expect(test.onRevoked.mock.calls).toEqual([["b"]]);
  test.monitor.stop();
});
it("stops polling on expired authentication", async () => {
  const transport={projects:vi.fn().mockRejectedValue({response:{status:401}}),tasks:vi.fn()};
  const test=setup(transport);
  await vi.advanceTimersByTimeAsync(60000);
  expect(test.onUnauthorized).toHaveBeenCalledOnce();
  expect(transport.projects).toHaveBeenCalledOnce();
  expect(transport.tasks).not.toHaveBeenCalled();
});
it("checks active projects every five seconds and idle projects every thirty seconds", async () => {
  const session=newPikoTaskSession(0);
  session.tasks=[{id:"r",projectId:"a",taskKey:"k",status:"running",createdAt:0,updatedAt:0,completedAt:null,acknowledged:false,destination:"/projects/a/tasks",canvasId:null}];
  const transport={projects:vi.fn().mockResolvedValue(["a","b"]),tasks:vi.fn().mockResolvedValue([])};
  const test=setup(transport,session);
  await vi.advanceTimersByTimeAsync(10000);
  expect(transport.tasks.mock.calls.map(call=>call[0])).toEqual(["a","b","a","a"]);
  test.monitor.stop();
});

it("ignores discovery rejection after the monitor has stopped", async () => {
  let reject!: (error: unknown) => void;
  const transport = { projects: vi.fn(() => new Promise<string[]>((_, fail) => { reject = fail; })), tasks: vi.fn() };
  const test = setup(transport);
  test.monitor.stop();
  reject({ response: { status: 401 } });
  await vi.advanceTimersByTimeAsync(0);
  expect(test.onUnauthorized).not.toHaveBeenCalled();
  expect(test.onProjects).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
