// SPDX-License-Identifier: Elastic-2.0
import { beforeEach, expect, it, vi } from "vitest";
import type { TaskState } from "@/task-center/types";
import { capturePikoTaskEntry } from "./piko-task-entry";
import { pikoTaskStorageKey, readPikoTaskSession, selectedPikoTask } from "./piko-task-session";
const store=vi.hoisted(()=>({projectId:"p",selectedTaskKey:null as string|null,isHydrated:true,tasks:new Map<string,TaskState>()}));
vi.mock("@/task-center/store",()=>({useTaskCenterStore:{getState:()=>store}}));
beforeEach(()=>{localStorage.clear();store.tasks.clear();store.selectedTaskKey=null;});
it("captures the originating canvas before task-center teardown and filters other authors",()=>{
  for(const [id,canvas,username,created] of [["a","first","alice",1000],["b","second","alice",2000],["c","first","bob",3000]] as const){
    store.tasks.set(id,{task_key:id,task_id:id,project_id:"p",project:"p",episode:0,beat_num:null,scope:null,progress:0,current_task:"",result:null,error:null,logs:[],completed_at:"",username,task_type:"freezone_image",status:"running",created_at:new Date(created).toISOString(),updated_at:new Date(created).toISOString(),metadata:{canvas_id:canvas}});
  }
  capturePikoTaskEntry("alice","http://localhost/projects/p/freezone?canvas=first",4000);
  store.tasks.clear();
  const restored=readPikoTaskSession(pikoTaskStorageKey("alice",null),5000);
  expect(restored.tasks).toHaveLength(2);
  expect(selectedPikoTask(restored)?.canvasId).toBe("first");
});
