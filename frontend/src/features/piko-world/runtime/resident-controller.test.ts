// SPDX-License-Identifier: Elastic-2.0
import type { Texture, Ticker } from "pixi.js";
import { afterEach, expect, it, vi } from "vitest";
import { createResidentActor } from "./resident-actor";
import type { PikoNavigation } from "./map-package-schema";
const mock=vi.hoisted(()=>({setFrame:vi.fn(),destroy:vi.fn(),step:vi.fn(),stop:vi.fn(),unlock:vi.fn(),audioDestroy:vi.fn()}));
vi.mock("./footstep-audio",()=>({createGrassFootsteps:()=>({step:mock.step,stop:mock.stop,unlock:mock.unlock,destroy:mock.audioDestroy})}));
vi.mock("./character-actor",()=>({createCharacterActor:()=>({
  container:{position:{x:1190,y:485,set(x:number,y:number){this.x=x;this.y=y;}},zIndex:485},
  body:{texture:null,anchor:{set:vi.fn()},scale:{set:vi.fn()}},
  setFrame:mock.setFrame,destroy:mock.destroy,
})}));
afterEach(()=>{document.body.innerHTML="";vi.restoreAllMocks();vi.unstubAllGlobals();vi.clearAllMocks();});
it("moves only with map focus, stops on pause/blur, retains facing and cleans listeners",()=>{
  const host=document.createElement("div");host.tabIndex=0;document.body.append(host);host.focus();
  const motion={matches:false};vi.stubGlobal("matchMedia",()=>motion);
  const nav={walkableAreas:[{id:"ground",points:[{x:0,y:0},{x:2000,y:0},{x:2000,y:1200},{x:0,y:1200}]}],colliders:[]} as unknown as PikoNavigation;
  const ticker={add:vi.fn(),remove:vi.fn()};
  let active=false;
  const actor=createResidentActor({} as Texture,ticker as unknown as Ticker,()=>active,{host,navigation:nav});
  const tick=ticker.add.mock.calls[0][0];
  const key=(code:string)=>window.dispatchEvent(new KeyboardEvent("keydown",{code,bubbles:true,cancelable:true}));
  key("KeyD");tick({deltaMS:16});expect(actor.container.position.x).toBe(1190);
  active=true;key("KeyD");tick({deltaMS:16});expect(actor.container.position.x).toBeGreaterThan(1190);
  expect(mock.setFrame).toHaveBeenLastCalledWith(25);
  expect(mock.step).toHaveBeenCalledOnce();
  expect(mock.unlock).toHaveBeenCalledOnce();
  const interaction = new KeyboardEvent("keydown", {code:"KeyE",cancelable:true});
  window.dispatchEvent(interaction);expect(interaction.defaultPrevented).toBe(false);
  active=false;tick({deltaMS:16});const stopped=actor.container.position.x;
  active=true;tick({deltaMS:16});expect(actor.container.position.x).toBe(stopped);
  expect(mock.setFrame).toHaveBeenLastCalledWith(22);
  expect(mock.step).toHaveBeenCalledOnce();
  expect(mock.stop).toHaveBeenCalled();
  key("KeyD");window.dispatchEvent(new Event("blur"));tick({deltaMS:16});expect(actor.container.position.x).toBe(stopped);
  motion.matches=true;key("KeyD");tick({deltaMS:16});expect(actor.container.position.x).toBeGreaterThan(stopped);
  expect(mock.setFrame).toHaveBeenLastCalledWith(22);
  const input=document.createElement("input");document.body.append(input);input.focus();key("KeyA");tick({deltaMS:16});
  const typing=actor.container.position.x;tick({deltaMS:16});expect(actor.container.position.x).toBe(typing);
  actor.destroy();expect(ticker.remove).toHaveBeenCalledWith(tick);expect(mock.destroy).toHaveBeenCalledOnce();
  expect(mock.audioDestroy).toHaveBeenCalledOnce();
  host.focus();key("KeyD");expect(mock.unlock).toHaveBeenCalledTimes(3);
});

it("drives a simulated resident independently of the player's keyboard and pauses it safely", () => {
  const host = document.createElement("div"); host.tabIndex = 0; document.body.append(host); host.focus();
  const navigation = { walkableAreas: [{ id: "ground", points: [{x:0,y:0},{x:2000,y:0},{x:2000,y:1200},{x:0,y:1200}] }], colliders: [] } as unknown as PikoNavigation;
  const ticker = { add: vi.fn(), remove: vi.fn() };
  let input = { x: 0, y: 0 }, active = true;
  const actor = createResidentActor({} as Texture, ticker as unknown as Ticker, () => active,
    { host, navigation, simulatedInput: () => input });
  const tick = ticker.add.mock.calls[0][0];
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD" }));
  tick({ deltaMS: 16 });
  expect(actor.container.position.x).toBe(1190);
  input = { x: 1, y: 0 };
  tick({ deltaMS: 16 });
  expect(actor.container.position.x).toBeGreaterThan(1190);
  expect(mock.setFrame).toHaveBeenLastCalledWith(25);
  const stopped = actor.container.position.x;
  active = false; tick({ deltaMS: 16 });
  expect(actor.container.position.x).toBe(stopped);
  expect(mock.unlock).not.toHaveBeenCalled();
  expect(mock.step).not.toHaveBeenCalled();
  actor.destroy();
  expect(ticker.remove).toHaveBeenCalledWith(tick);
});

it("uses the player's slower travel speed and distance-based gait without changing residents", () => {
  const host = document.createElement("div"); host.tabIndex = 0; document.body.append(host); host.focus();
  const navigation = { walkableAreas: [{ id: "ground", points: [{x:0,y:0},{x:2000,y:0},{x:2000,y:1200},{x:0,y:1200}] }], colliders: [] } as unknown as PikoNavigation;
  const ticker = { add: vi.fn(), remove: vi.fn() };
  const actor = createResidentActor({} as Texture, ticker as unknown as Ticker, () => true,
    { host, navigation, speed: 135, gaitCycleSourcePixels: 48 });
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD" }));
  const tick = ticker.add.mock.calls[0][0];
  for (let i = 0; i < 30; i++) tick({ deltaMS: 16 });
  expect(actor.container.position.x - 1190).toBeCloseTo(64.8);
  expect(mock.setFrame).toHaveBeenLastCalledWith(30);
  expect(mock.step).toHaveBeenCalledTimes(2);
  actor.destroy();
});

it("lets the player idle cycle run past the resident's 4800 ms loop", () => {
  const host = document.createElement("div"); host.tabIndex = 0; document.body.append(host); host.focus();
  const navigation = { walkableAreas: [{ id: "ground", points: [{x:0,y:0},{x:2000,y:0},{x:2000,y:1200},{x:0,y:1200}] }], colliders: [] } as unknown as PikoNavigation;
  const ticker = { add: vi.fn(), remove: vi.fn() };
  const idleFrameAt = vi.fn((elapsed: number) => elapsed >= 4800 ? 1 : 0);
  const actor = createResidentActor({} as Texture, ticker as unknown as Ticker, () => true,
    { host, navigation, idleFrameAt, idleCycleMs: 8000 });
  const tick = ticker.add.mock.calls[0][0];
  for (let i = 0; i < 100; i++) tick({ deltaMS: 50 });
  expect(idleFrameAt).toHaveBeenLastCalledWith(5000);
  expect(mock.setFrame).toHaveBeenLastCalledWith(1);
  actor.destroy();
});


it("walks to a click without overshoot and lets keyboard and pause cancel the route", () => {
  const host = document.createElement("div"); host.tabIndex = 0; document.body.append(host);
  const navigation = { walkableAreas: [{ id: "ground", points: [{x:0,y:0},{x:2000,y:0},{x:2000,y:1200},{x:0,y:1200}] }], colliders: [] } as unknown as PikoNavigation;
  const ticker = { add: vi.fn(), remove: vi.fn() };
  let active = true;
  const actor = createResidentActor({} as Texture, ticker as unknown as Ticker, () => active, { host, navigation });
  const tick = ticker.add.mock.calls[0][0];
  actor.walkTo({ x: 1200, y: 485 });
  expect(document.activeElement).toBe(host);
  for (let i = 0; i < 20; i++) tick({ deltaMS: 16 });
  expect(actor.container.position.x).toBeCloseTo(1200);
  actor.walkTo({ x: 1300, y: 485 });
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA" }));
  tick({ deltaMS: 16 });
  expect(actor.container.position.x).toBeLessThan(1200);
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyA" }));
  const stopped = actor.container.position.x;
  tick({ deltaMS: 16 });
  expect(actor.container.position.x).toBe(stopped);
  actor.walkTo({ x: 1300, y: 485 });
  active = false; tick({ deltaMS: 16 }); active = true; tick({ deltaMS: 16 });
  expect(actor.container.position.x).toBe(stopped);
  actor.destroy();
});
