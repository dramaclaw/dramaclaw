import { expect, it } from "vitest";
import { advanceGait, gaitColumn, crossesFootContact } from "./character-gait";
it("plays all eight poses and wraps by distance", () => {
  expect(Array.from({length:8},(_,i)=>gaitColumn(i*10,80))).toEqual([3,4,5,6,7,8,9,10]);
  expect(advanceGait(75,5,80)).toBe(0);
});
it("triggers contacts at start, half-cycle and wrap, never while blocked", () => {
  expect(crossesFootContact(0,2,80,false)).toBe(true);
  expect(crossesFootContact(2,2,80,true)).toBe(false);
  expect(crossesFootContact(39,2,80,true)).toBe(true);
  expect(crossesFootContact(79,2,80,true)).toBe(true);
  expect(crossesFootContact(0,0,80,false)).toBe(false);
});
it("does not step while blocked and is independent of frame subdivision", () => {
  expect(advanceGait(20,0,80)).toBe(20);
  expect(advanceGait(20,NaN,80)).toBe(20);
  expect(advanceGait(advanceGait(0,15,80),15,80)).toBe(advanceGait(0,30,80));
});
