import { afterEach, expect, it, vi } from "vitest";
import { createGrassFootsteps, GRASS_STEP_SOURCES } from "./footstep-audio";
import { readFileSync } from "node:fs";

afterEach(() => { vi.unstubAllGlobals(); });
it("ships three short PCM recordings", () => {
  for (const src of GRASS_STEP_SOURCES) {
    const file = readFileSync("public" + src);
    expect(file.toString("ascii",0,4)).toBe("RIFF");
    expect(file.length).toBeLessThan(30000);
  }
});
it("waits for unlock, alternates clips, and stops/cleans up", async () => {
  const sources: {buffer: unknown; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>}[] = [];
  let ctx: Context;
  class Context {
    state = "suspended"; destination = {};
    resume = vi.fn(async () => { this.state="running"; });
    close = vi.fn(async () => { this.state="closed"; });
    decodeAudioData = vi.fn(async (data: ArrayBuffer) => data);
    constructor() { ctx=this; }
    createGain() { return {gain:{value:1}, connect:vi.fn(),disconnect:vi.fn()}; }
    createBufferSource() {
      const source = {buffer:undefined as unknown,start:vi.fn(),stop:vi.fn(),connect:(gain:unknown)=>gain,disconnect:vi.fn()};
      sources.push(source); return source;
    }
  }
  vi.stubGlobal("AudioContext",Context);
  vi.stubGlobal("fetch",vi.fn(async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(2)})));
  const audio=createGrassFootsteps();
  await vi.waitFor(()=>expect(ctx!.decodeAudioData).toHaveBeenCalledTimes(3));
  audio.step(); expect(sources).toHaveLength(0);
  audio.unlock(); await Promise.resolve();
  audio.step(); audio.step();
  expect(sources).toHaveLength(2);
  expect(sources[0].buffer).not.toBe(sources[1].buffer);
  audio.stop(); expect(sources[0].stop).toHaveBeenCalled();
  audio.destroy(); expect(ctx!.close).toHaveBeenCalledOnce();
  audio.step(); expect(sources).toHaveLength(2);
});
it("uses remaining clips when one file fails and tolerates device errors", async () => {
  const start = vi.fn();
  const createBufferSource = vi.fn(() => ({start,stop:vi.fn(),connect:(gain:unknown)=>gain,disconnect:vi.fn()}));
  const decodeAudioData = vi.fn(async () => ({}));
  vi.stubGlobal("AudioContext",class {
    state="running"; destination={}; decodeAudioData=decodeAudioData;
    createBufferSource=createBufferSource;
    createGain() {return {gain:{value:1},connect:vi.fn(),disconnect:vi.fn()};}
    close() {return Promise.resolve();}
  });
  vi.stubGlobal("fetch",vi.fn(async (src:string)=>({ok:!src.includes("step-1-"),arrayBuffer:async()=>new ArrayBuffer(2)})));
  const audio=createGrassFootsteps();
  await vi.waitFor(()=>expect(decodeAudioData).toHaveBeenCalledTimes(2));
  audio.step(); expect(start).toHaveBeenCalledOnce();
  createBufferSource.mockImplementationOnce(()=>{throw new Error("device disconnected");});
  expect(()=>audio.step()).not.toThrow();
  audio.destroy();
});
