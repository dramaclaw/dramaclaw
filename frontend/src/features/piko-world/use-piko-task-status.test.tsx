// SPDX-License-Identifier: Elastic-2.0
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { TaskState } from "@/task-center/types";
import { usePikoTaskStatus } from "./use-piko-task-status";
import { pikoTaskStorageKey, readPikoTaskSession } from "./piko-task-session";
const mocks=vi.hoisted(()=>({navigate:vi.fn(),get:vi.fn(),monitor:vi.fn(),stop:vi.fn(),refresh:vi.fn(),username:"alice",error:vi.fn()}));
vi.mock("@tanstack/react-router",()=>({useNavigate:()=>mocks.navigate}));
vi.mock("react-i18next",()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock("sonner",()=>({toast:{error:mocks.error}}));
vi.mock("@/lib/api",()=>({api:{get:mocks.get}}));
vi.mock("@/stores/auth-store",()=>({useAuthStore:{getState:()=>({username:mocks.username})}}));
vi.mock("./piko-task-monitor",()=>({startPikoTaskMonitor:mocks.monitor}));
const task=(status:TaskState["status"]="running"):TaskState=>({task_id:"run",task_key:"k",username:"alice",project:"p",project_id:"p",task_type:"single_video",episode:1,beat_num:null,scope:null,progress:0,current_task:"",result:null,error:null,logs:[],status,metadata:{canvas_id:"canvas-a"},created_at:new Date().toISOString(),updated_at:new Date().toISOString(),completed_at:status==="completed"?new Date().toISOString():""});
beforeEach(()=>{localStorage.clear();vi.clearAllMocks();mocks.username="alice";mocks.monitor.mockReturnValue({stop:mocks.stop,refresh:mocks.refresh});mocks.get.mockResolvedValue({ok:true,status:200});mocks.navigate.mockResolvedValue(undefined);});
it("returns to the task's own canvas, preserves active monitoring and acknowledges only terminal results",async()=>{
  const {result,unmount}=renderHook(()=>usePikoTaskStatus("alice"));
  const monitor=mocks.monitor.mock.calls[0][0];
  act(()=>monitor.onTasks("p",[task()]));
  expect(result.current.status).toBe("running");
  await act(async()=>{await result.current.open();});
  expect(mocks.navigate).toHaveBeenCalledWith({to:"/projects/p/freezone",search:{canvas:"canvas-a"}});
  expect(readPikoTaskSession(pikoTaskStorageKey("alice",null),Date.now()).tasks[0].acknowledged).toBe(false);
  act(()=>monitor.onTasks("p",[task("completed")]));
  await act(async()=>{await result.current.open();});
  expect(readPikoTaskSession(pikoTaskStorageKey("alice",null),Date.now()).tasks[0].acknowledged).toBe(true);
  unmount();expect(mocks.stop).toHaveBeenCalled();
});
it("keeps unread results on network failure and gives a safe workspace fallback for deleted origins",async()=>{
  const {result}=renderHook(()=>usePikoTaskStatus("alice"));
  act(()=>mocks.monitor.mock.calls[0][0].onTasks("p",[task("completed")]));
  mocks.get.mockRejectedValueOnce(new Error("offline"));
  await act(async()=>{await result.current.open();});
  expect(result.current.status).toBe("completed");expect(mocks.navigate).not.toHaveBeenCalled();
  mocks.get.mockResolvedValueOnce({ok:false,status:404});
  await act(async()=>{await result.current.open();});
  expect(mocks.navigate).toHaveBeenCalledWith({to:"/"});
  expect(mocks.error).toHaveBeenCalledWith("pikoWorld.taskLabel.unavailable");
});
it("isolates accounts and cancels navigation that was checked under a previous login",async()=>{
  const {result,rerender}=renderHook(({owner})=>usePikoTaskStatus(owner),{initialProps:{owner:"alice"}});
  act(()=>mocks.monitor.mock.calls[0][0].onTasks("p",[task()]));
  let resolve!:(value:{ok:boolean;status:number})=>void;
  mocks.get.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
  let pending!:Promise<void>;
  act(()=>{pending=result.current.open();});
  mocks.username="bob";rerender({owner:"bob"});
  expect(result.current.status).toBeNull();
  await act(async()=>{resolve({ok:true,status:200});await pending;});
  expect(mocks.navigate).not.toHaveBeenCalled();
  await waitFor(()=>expect(mocks.monitor).toHaveBeenCalledTimes(2));
});

it.each([false, true])("preserves fresh task snapshots during navigation (failure=%s)", async (fail) => {
  const { result } = renderHook(() => usePikoTaskStatus("alice"));
  const monitor = mocks.monitor.mock.calls[0][0];
  const completed = task("completed");
  act(() => monitor.onTasks("p", [completed]));
  let finish!: () => void;
  mocks.navigate.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
    finish = () => fail ? reject(new Error("navigation failed")) : resolve();
  }));
  let pending!: Promise<void>;
  await act(async () => { pending = result.current.open(); });
  const newer = { ...task(), task_id: "new-run", task_key: "new-task" };
  act(() => monitor.onTasks("p", [completed, newer]));
  await act(async () => { finish(); await pending; });
  expect(result.current.status).toBe("running");
  const saved = readPikoTaskSession(pikoTaskStorageKey("alice", null), Date.now());
  expect(saved.tasks.find(item => item.taskKey === "new-task")?.status).toBe("running");
  expect(saved.tasks.find(item => item.taskKey === "k")?.acknowledged).toBe(!fail);
});
