// SPDX-License-Identifier: Elastic-2.0
import { beforeEach, expect, it } from "vitest";
import type { TaskState } from "@/task-center/types";
import { newPikoTaskSession, pikoTaskDestination, pikoTaskStorageKey, readPikoTaskSession, reconcilePikoTasks, selectedPikoTask, writePikoTaskSession } from "./piko-task-session";
const iso = (time: number) => new Date(time).toISOString();
const task = (overrides: Partial<TaskState> = {}): TaskState => ({
  task_id: "run1", task_key: "video", task_type: "single_video", username: "alice", project: "display-name", project_id: "p1", episode: 2,
  beat_num: 1, scope: null, status: "running", progress: 25, current_task: "", result: null, error: null, logs: [],
  created_at: iso(1000), updated_at: iso(2000), completed_at: "", ...overrides,
});
beforeEach(() => localStorage.clear());
it("tracks existing active tasks and new fast completions but never old results or another author", () => {
  const session = reconcilePikoTasks(newPikoTaskSession(1500), "p1", "alice", [task(), task({task_key:"other", username:"bob"}),
    task({task_key:"old", status:"failed"}), task({task_key:"quick", task_id:"r2", status:"completed", created_at:iso(1600)})]);
  expect(session.tasks.map(item => item.taskKey)).toEqual(["video", "quick"]);
});
it("keeps a tracked completion through refresh, stores no logs or result data, and separates accounts/regions", () => {
  let session = reconcilePikoTasks(newPikoTaskSession(1500), "p1", "alice", [task()]);
  session = reconcilePikoTasks(session, "p1", "alice", [task({status:"completed",updated_at:iso(3000),completed_at:iso(3000),logs:["private prompt"],result:{url:"private"}})]);
  const key = pikoTaskStorageKey("alice", "eu");
  writePikoTaskSession(key,session);
  expect(selectedPikoTask(readPikoTaskSession(key,4000))?.status).toBe("completed");
  expect(localStorage.getItem(key)).not.toContain("private");
  expect(readPikoTaskSession(pikoTaskStorageKey("bob","eu"),4000).tasks).toEqual([]);
  expect(readPikoTaskSession(pikoTaskStorageKey("alice","us"),4000).tasks).toEqual([]);
});
it("uses a run identity for retry, clears old unread results on a new run, and rejects stale updates", () => {
  let session = reconcilePikoTasks(newPikoTaskSession(0),"p1","alice",[task({status:"failed"})]);
  session = reconcilePikoTasks(session,"p1","alice",[task({status:"failed"}),task({task_id:"run2",task_key:"audio",created_at:iso(3000),updated_at:iso(3000)})]);
  expect(session.tasks.find(item=>item.taskKey==="video")?.acknowledged).toBe(true);
  session = reconcilePikoTasks(session,"p1","alice",[task({task_id:"run2",task_key:"audio",created_at:iso(3000),updated_at:iso(2500),status:"failed"})]);
  expect(selectedPikoTask(session)?.status).toBe("running");
});
it("removes missing tasks without turning absence into failure", () => {
  const initial = reconcilePikoTasks(newPikoTaskSession(0),"p1","alice",[task()]);
  expect(reconcilePikoTasks(initial,"p1","alice",[]).tasks).toEqual([]);
});
it("constructs canvas and episode destinations from real provenance and falls back to project tasks", () => {
  expect(pikoTaskDestination("a/b",task({metadata:{canvas_id:"c&x"}}))).toBe("/projects/a%2Fb/freezone?canvas=c%26x");
  expect(pikoTaskDestination("p1",task())).toBe("/projects/p1/episodes/2/video");
  expect(pikoTaskDestination("p1",task({task_type:"unknown",episode:0}))).toBe("/projects/p1/tasks");
});
it("rejects corrupt persistence and external destinations", () => {
  const key=pikoTaskStorageKey("alice",null);
  localStorage.setItem(key,'broken');
  expect(readPikoTaskSession(key,4000).tasks).toEqual([]);
  const session=reconcilePikoTasks(newPikoTaskSession(0),"p1","alice",[task()]);
  session.tasks[0].destination="https://example.com";
  localStorage.setItem(key,JSON.stringify(session));
  expect(readPikoTaskSession(key,4000).tasks).toEqual([]);
});
