// SPDX-License-Identifier: Elastic-2.0
import type { Texture, Ticker } from "pixi.js";
import { afterEach, expect, it, vi } from "vitest";
import { createResidentActor } from "./resident-actor";
import { PIKO_PLAYER_SPEED, PIKO_PLAYER_GAIT_CYCLE_SOURCE_PIXELS, PIKO_PLAYER_MOTION_COLUMNS, PIKO_PLAYER_WALK_COLUMNS } from "../piko-player";
import type { PikoNavigation } from "./map-package-schema";
const mock=vi.hoisted(()=>({setFrame:vi.fn(),setStaticTexture:vi.fn(),destroy:vi.fn(),step:vi.fn(),stop:vi.fn(),unlock:vi.fn(),audioDestroy:vi.fn()}));
vi.mock("./footstep-audio",()=>({createGrassFootsteps:()=>({step:mock.step,stop:mock.stop,unlock:mock.unlock,destroy:mock.audioDestroy})}));
vi.mock("./character-actor",()=>({createCharacterActor:()=>({
  container:{position:{x:1190,y:485,set(x:number,y:number){this.x=x;this.y=y;}},zIndex:485},
  body:{texture:null,anchor:{set:vi.fn()},scale:{set:vi.fn()}},
  setFrame:mock.setFrame,setStaticTexture:mock.setStaticTexture,destroy:mock.destroy,
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

it("uses the configured player travel speed with distance-based walking and footsteps", () => {
  const host = document.createElement("div"); host.tabIndex = 0; document.body.append(host); host.focus();
  const navigation = { walkableAreas: [{ id: "ground", points: [{x:0,y:0},{x:2000,y:0},{x:2000,y:1200},{x:0,y:1200}] }], colliders: [] } as unknown as PikoNavigation;
  const ticker = { add: vi.fn(), remove: vi.fn() };
  const actor = createResidentActor({} as Texture, ticker as unknown as Ticker, () => true,
    { host, navigation, speed: PIKO_PLAYER_SPEED, gaitCycleSourcePixels: PIKO_PLAYER_GAIT_CYCLE_SOURCE_PIXELS,
      motionColumns: PIKO_PLAYER_MOTION_COLUMNS, walkColumns: PIKO_PLAYER_WALK_COLUMNS });
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD" }));
  const tick = ticker.add.mock.calls[0][0];
  for (let i = 0; i < 30; i++) tick({ deltaMS: 16 });
  expect(actor.container.position.x - 1190).toBeCloseTo(73.872);
  expect(mock.setFrame).toHaveBeenLastCalledWith(17);
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
  expect(idleFrameAt).toHaveBeenLastCalledWith(5000, "south");
  expect(mock.setFrame).toHaveBeenLastCalledWith(1);
  actor.destroy();
});


it("walks to a click without overshoot and lets keyboard and pause cancel the route", () => {
  const host = document.createElement("div"); host.tabIndex = 0; document.body.append(host);
  const navigation = { walkableAreas: [{ id: "ground", points: [{x:0,y:0},{x:2000,y:0},{x:2000,y:1200},{x:0,y:1200}] }], colliders: [] } as unknown as PikoNavigation;
  const ticker = { add: vi.fn(), remove: vi.fn() };
  let active = true;
  const actor = createResidentActor({} as Texture, ticker as unknown as Ticker, () => active, { host, navigation, speed: PIKO_PLAYER_SPEED });
  const tick = ticker.add.mock.calls[0][0];
  const arrived = vi.fn();
  actor.walkTo({ x: 1200, y: 485 }, arrived);
  expect(document.activeElement).toBe(host);
  for (let i = 0; i < 20; i++) tick({ deltaMS: 16 });
  expect(actor.container.position.x).toBeCloseTo(1200);
  expect(arrived).toHaveBeenCalledOnce();
  const cancelled = vi.fn();
  actor.walkTo({ x: 1300, y: 485 }, cancelled);
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA" }));
  tick({ deltaMS: 16 });
  expect(actor.container.position.x).toBeLessThan(1200);
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyA" }));
  const stopped = actor.container.position.x;
  tick({ deltaMS: 16 });
  expect(actor.container.position.x).toBe(stopped);
  expect(cancelled).not.toHaveBeenCalled();
  actor.walkTo({ x: 1300, y: 485 });
  active = false; tick({ deltaMS: 16 }); active = true; tick({ deltaMS: 16 });
  expect(actor.container.position.x).toBe(stopped);
  actor.destroy();
});

it("holds the supplied sit texture and releases the seat before walking", () => {
  const host = document.createElement("div"); host.tabIndex = 0; document.body.append(host);
  const navigation = { walkableAreas: [{ id: "ground", points: [{x:0,y:0},{x:2000,y:0},{x:2000,y:1200},{x:0,y:1200}] }], colliders: [] } as unknown as PikoNavigation;
  const ticker = { add: vi.fn(), remove: vi.fn() };
  const actor = createResidentActor({} as Texture, ticker as unknown as Ticker, () => true, { host, navigation });
  const sitTexture = {} as Texture;
  expect(actor.sit(sitTexture, { x: 1210, y: 490 })).toBe(true);
  expect(actor.isSeated()).toBe(true);
  ticker.add.mock.calls[0][0]({ deltaMS: 16 });
  expect(actor.container.zIndex).toBeGreaterThan(actor.container.position.y + 40);
  expect(mock.setStaticTexture).toHaveBeenLastCalledWith(sitTexture, { x: 32, y: 32 });
  actor.walkTo({ x: 1300, y: 485 });
  expect(actor.isSeated()).toBe(false);
  expect(actor.container.position).toMatchObject({ x: 1210, y: 490 });
  expect(mock.setStaticTexture).toHaveBeenLastCalledWith(null);
  actor.destroy();
});

it("reports the same idle clock used by raised-hand poses and resets it after walking", () => {
  const host = document.createElement("div"); host.tabIndex = 0; document.body.append(host); host.focus();
  const navigation = { walkableAreas: [{ id: "ground", points: [{x:0,y:0},{x:2000,y:0},{x:2000,y:1200},{x:0,y:1200}] }], colliders: [] } as unknown as PikoNavigation;
  const ticker = { add: vi.fn(), remove: vi.fn() };
  const onPose = vi.fn();
  const actor = createResidentActor({} as Texture, ticker as unknown as Ticker, () => true,
    { host, navigation, idleCycleMs: 8000, onPose });
  const tick = ticker.add.mock.calls[0][0];
  for (let i = 0; i < 62; i++) tick({ deltaMS: 50 });
  expect(onPose.mock.lastCall?.[2]).toBe(3100);
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD" }));
  tick({ deltaMS: 50 }); expect(onPose.mock.lastCall?.[2]).toBeNull();
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyD" }));
  tick({ deltaMS: 50 }); expect(onPose.mock.lastCall?.[2]).toBe(50);
  actor.destroy();
});

it("uses a seat's authored depth only while seated and restores normal depth on exit", () => {
  const host = document.createElement("div"); host.tabIndex = 0; document.body.append(host); host.focus();
  const navigation = { walkableAreas: [{ id: "ground", points: [{x:0,y:0},{x:2000,y:0},{x:2000,y:1200},{x:0,y:1200}] }], colliders: [] } as unknown as PikoNavigation;
  const ticker = { add: vi.fn(), remove: vi.fn() };
  const actor = createResidentActor({} as Texture, ticker as unknown as Ticker, () => true, { host, navigation });
  const tick = ticker.add.mock.calls[0][0];
  actor.sit({} as Texture, { x: 1330, y: 757 }, null, 784);
  actor.container.position.set(1330, 694);
  tick({ deltaMS: 16 });
  expect(actor.container.zIndex).toBe(784);
  expect(actor.container.position).toMatchObject({ x: 1330, y: 694 });
  actor.walkTo({ x: 1400, y: 757 });
  tick({ deltaMS: 16 });
  expect(actor.isSeated()).toBe(false);
  expect(actor.container.zIndex).toBe(actor.container.position.y);
  actor.sit({} as Texture, { x: 1400, y: 757 });
  actor.container.position.set(560, 730);
  tick({ deltaMS: 16 });
  expect(actor.container.zIndex).toBeGreaterThan(770);
  expect(actor.container.zIndex).toBeLessThan(780);
  actor.destroy();
});

it("animates seated idle without moving its anchor and restores standing on exit", () => {
  const host=document.createElement('div');host.tabIndex=0;document.body.append(host);host.focus();
  const motion={matches:false};vi.stubGlobal('matchMedia',()=>motion);
  const navigation={walkableAreas:[{id:'ground',points:[{x:0,y:0},{x:2000,y:0},{x:2000,y:1200},{x:0,y:1200}]}],colliders:[]} as unknown as PikoNavigation;
  const ticker={add:vi.fn(),remove:vi.fn()};let active=true;
  const actor=createResidentActor({} as Texture,ticker as unknown as Ticker,()=>active,{host,navigation});
  const base={label:'base'} as Texture,idle={label:'idle'} as Texture;
  actor.sit(base,{x:1210,y:490},idle);
  const tick=ticker.add.mock.calls[0][0],position={x:actor.container.position.x,y:actor.container.position.y};
  for(let i=0;i<36;i++)tick({deltaMS:50});
  expect(mock.setStaticTexture).toHaveBeenLastCalledWith(idle,{x:32,y:32});
  expect(actor.container.position).toMatchObject(position);
  active=false;for(let i=0;i<200;i++)tick({deltaMS:50});
  expect(mock.setStaticTexture).toHaveBeenLastCalledWith(idle,{x:32,y:32});
  active=true;for(let i=0;i<3;i++)tick({deltaMS:50});
  expect(mock.setStaticTexture).toHaveBeenLastCalledWith(idle,{x:32,y:32});
  tick({deltaMS:30});
  expect(mock.setStaticTexture).toHaveBeenLastCalledWith(base,{x:32,y:32});
  for(let i=0;i<76;i++)tick({deltaMS:50});
  tick({deltaMS:20});
  expect(mock.setStaticTexture).toHaveBeenLastCalledWith(idle,{x:32,y:32});
  motion.matches=true;for(let i=0;i<160;i++)tick({deltaMS:50});
  expect(mock.setStaticTexture).toHaveBeenLastCalledWith(base,{x:32,y:32});
  window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyD'}));tick({deltaMS:16});
  expect(actor.isSeated()).toBe(false);
  expect(mock.setStaticTexture).toHaveBeenLastCalledWith(null);
  actor.destroy();
});

it("uses compact player rows while retaining facing on stopping", () => {
  const host = document.createElement("div"); host.tabIndex = 0; document.body.append(host); host.focus();
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const navigation = { walkableAreas: [{ id: "ground", points: [{ x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 1200 }, { x: 0, y: 1200 }] }], colliders: [] } as unknown as PikoNavigation;
  const ticker = { add: vi.fn(), remove: vi.fn() };
  const actor = createResidentActor({} as Texture, ticker as unknown as Ticker, () => true, {
    host, navigation, facing: "east", motionColumns: 6, walkColumns: [3, 4, 5, 4], idleFrameAt: () => 0,
  });
  expect(mock.setFrame).toHaveBeenLastCalledWith(12);
  const tick = ticker.add.mock.calls[0][0];
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD" }));
  tick({ deltaMS: 16 });
  expect(mock.setFrame).toHaveBeenLastCalledWith(15);
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyD" }));
  tick({ deltaMS: 16 });
  expect(mock.setFrame).toHaveBeenLastCalledWith(12);
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }));
  tick({ deltaMS: 16 });
  expect(mock.setFrame).toHaveBeenLastCalledWith(21);
  actor.setFacing("west");
  expect(mock.setFrame).toHaveBeenLastCalledWith(6);
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyW" }));
  tick({ deltaMS: 16 });
  expect(mock.setFrame).toHaveBeenLastCalledWith(6);
  actor.destroy();
});
