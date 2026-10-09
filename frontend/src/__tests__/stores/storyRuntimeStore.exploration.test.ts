import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileGraphToInk } from '@/features/canvas/story/compileGraphToInk';
import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { STORY_CHOICE_EDGE_TYPE, type CompiledStory } from '@/features/canvas/story/storyTypes';
import { explorationSummary } from '@/features/canvas/story/storyExploration';
import { useStoryRuntimeStore as runtime } from '@/stores/storyRuntimeStore';

const KEY = 'dramaclaw.player.save.work.v1';
const node = (id: string, start = false): CanvasNode => ({ id, type: CANVAS_NODE_TYPES.video, position: { x: 0, y: 0 },
  data: { videoUrl: `/${id}.mp4`, displayName: id, ...(start ? { storyRole: 'start' } : {}) } } as CanvasNode);
const edge = (source: string, target: string, order = 0, extra = {}): CanvasEdge => ({ id: `${source}-${target}`, source, target,
  type: STORY_CHOICE_EDGE_TYPE, data: { choiceText: target, order, ...extra } } as CanvasEdge);
function branch(): CompiledStory {
  return compileGraphToInk([node('intro', true), node('left'), node('right'), node('end')], [
    edge('intro', 'left', 0, { effects: [{ var: 'score', delta: 5 }, { flag: 'key', value: true }] }),
    edge('intro', 'right', 1), edge('left', 'end', 0, { condition: { visitedNodeId: 'left', op: '>=', value: 1 } }), edge('right', 'end'),
  ], [{ name: 'score', label: '好感', initial: 0 }], [{ name: 'key', label: '钥匙', initial: false }]);
}
const state = () => runtime.getState();
beforeEach(() => { localStorage.clear(); state().exitPlay(); });

describe('player exploration and reversible checkpoints', () => {
  it('restores variables, flags, visit counts and route while retaining discoveries', () => {
    state().enterPlay(branch(), { saveKey: KEY });
    expect(state().rewindToNode('right')).toBe(false);
    state().choose(0);
    expect(state().story!.variablesState.$('score')).toBe(5);
    expect(state().story!.variablesState.$('key')).toBe(true);
    expect(state().story!.state.VisitCountAtPathString(branch().knotByNodeId.left)).toBe(1);
    state().completeCurrentNode();
    state().choose(0);
    state().completeCurrentNode();
    expect(state().exploration.totalRuns).toBe(1);
    expect(state().rewindToNode('intro')).toBe(true);
    expect(state().story!.variablesState.$('score')).toBe(0);
    expect(state().story!.variablesState.$('key')).toBe(false);
    expect(state().story!.state.VisitCountAtPathString(branch().knotByNodeId.left)).toBe(0);
    expect(state().exploration.route.map((step) => step.nodeId)).toEqual(['intro']);
    expect(state().exploration.completedNodeIds).toEqual(['intro', 'left', 'end']);
    state().choose(1);
    expect(state().currentNodeId).toBe('right');
    expect(state().story!.variablesState.$('score')).toBe(0);
    expect(state().exploration.route.map((step) => step.nodeId)).toEqual(['intro', 'right']);
    state().completeCurrentNode();
    expect(explorationSummary(state().explorationNodes, state().exploration).percent).toBe(100);
  });

  it('records automatic middle clips and only credits an ending after it is experienced', () => {
    const compiled = compileGraphToInk([node('intro', true), node('middle'), node('end')], [
      edge('intro', 'middle', 0, { transitionMode: 'automatic' }),
      edge('middle', 'end', 0, { transitionMode: 'automatic' }),
    ]);
    state().enterPlay(compiled, { saveKey: KEY });
    state().advanceAutomatic();
    expect(state().exploration.completedNodeIds).toEqual(['intro']);
    state().advanceAutomatic();
    expect(state().exploration.completedNodeIds).toEqual(['intro', 'middle']);
    expect(state().exploration.reachedEndingIds).toEqual([]);
    state().completeCurrentNode();
    state().completeCurrentNode();
    expect(state().exploration.reachedEndingIds).toEqual(['end']);
    expect(state().exploration.totalRuns).toBe(1);
  });

  it('persists checkpoints across reload and restart, isolates versions, and explicitly clears progress', () => {
    state().enterPlay(branch(), { saveKey: KEY });
    state().choose(0);
    state().completeCurrentNode();
    state().exitPlay();
    state().enterPlay(branch(), { saveKey: KEY });
    expect(state().resumeSaved()).toBe(true);
    expect(state().currentNodeId).toBe('left');
    expect(state().rewindToNode('intro')).toBe(true);
    expect(state().exploration.completedNodeIds).toEqual(['intro', 'left']);
    state().restart();
    expect(state().exploration.completedNodeIds).toEqual(['intro', 'left']);
    state().clearProgress();
    expect(state().currentNodeId).toBe('intro');
    expect(state().exploration.completedNodeIds).toEqual([]);
    state().exitPlay();
    state().enterPlay(branch(), { saveKey: 'dramaclaw.player.save.work.v2' });
    expect(state().exploration.completedNodeIds).toEqual([]);
  });

  it('uses the latest arrival when revisiting the same node and does not double-count coverage', () => {
    const compiled = compileGraphToInk([node('intro', true), node('end')], [
      edge('intro', 'intro', 0, { effects: [{ var: 'score', delta: 1 }] }), edge('intro', 'end', 1),
    ], [{ name: 'score', label: '好感', initial: 0 }]);
    state().enterPlay(compiled);
    const firstVisit = state().exploration.route[0].visit;
    state().choose(0);
    state().completeCurrentNode();
    expect(state().exploration.route[state().exploration.route.length - 1].visit).not.toBe(firstVisit);
    state().choose(1);
    expect(state().rewindToNode('intro')).toBe(true);
    expect(state().story!.variablesState.$('score')).toBe(1);
    expect(state().exploration.route.map((step) => step.nodeId)).toEqual(['intro', 'intro']);
    expect(state().exploration.completedNodeIds).toEqual(['intro']);
  });

  it('rejects a corrupt checkpoint without changing the current Ink state or route', () => {
    state().enterPlay(branch(), { saveKey: KEY });
    state().choose(0);
    const before = state().story!.state.toJson();
    const route = state().exploration.route;
    state().exploration.checkpoints.intro.inkState = 'invalid json';
    expect(state().rewindToNode('intro')).toBe(false);
    expect(state().story!.state.toJson()).toBe(before);
    expect(state().exploration.route).toBe(route);
  });

  it('keeps legacy saves playable without inventing historical unlocks or rewind points', () => {
    state().enterPlay(branch(), { saveKey: KEY });
    state().choose(0);
    const saved = JSON.parse(localStorage.getItem(KEY)!);
    delete saved.exploration;
    localStorage.setItem(KEY, JSON.stringify(saved));
    state().exitPlay();
    state().enterPlay(branch(), { saveKey: KEY });
    expect(state().resumeSaved()).toBe(true);
    expect(state().currentNodeId).toBe('left');
    expect(state().exploration.completedNodeIds).toEqual([]);
    expect(state().rewindToNode('intro')).toBe(false);
    state().completeCurrentNode();
    expect(state().rewindToNode('left')).toBe(true);
  });

  it('can explore and rewind in memory when browser storage is unavailable', () => {
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    try {
      state().enterPlay(branch(), { saveKey: KEY });
      state().choose(0);
      expect(state().rewindToNode('intro')).toBe(true);
      expect(state().currentNodeId).toBe('intro');
    } finally { write.mockRestore(); }
  });

  it('returns through each decision in order and preserves checkpoints after a reload', () => {
    state().enterPlay(branch(), { saveKey: KEY });
    state().choose(0);
    state().choose(0);
    state().completeCurrentNode();
    state().exitPlay();
    state().enterPlay(branch(), { saveKey: KEY });
    state().resumeSaved();
    expect(state().rewindToPreviousChoice()).toBe(true);
    expect(state().currentNodeId).toBe('left');
    expect(state().story!.variablesState.$('score')).toBe(5);
    expect(state().rewindToPreviousChoice()).toBe(true);
    expect(state().currentNodeId).toBe('intro');
    expect(state().story!.variablesState.$('score')).toBe(0);
    expect(state().rewindToPreviousChoice()).toBe(false);
    expect(state().exploration.completedNodeIds).toEqual(['intro', 'left', 'end']);
  });

  it('distinguishes earlier choices at the same looping node', () => {
    const compiled = compileGraphToInk([node('intro', true), node('end')], [
      edge('intro', 'intro', 0, { effects: [{ var: 'score', delta: 1 }] }), edge('intro', 'end', 1),
    ], [{ name: 'score', label: '好感', initial: 0 }]);
    state().enterPlay(compiled, { saveKey: KEY });
    state().choose(0);
    state().choose(0);
    expect(state().story!.variablesState.$('score')).toBe(2);
    expect(state().rewindToPreviousChoice()).toBe(true);
    expect(state().story!.variablesState.$('score')).toBe(1);
    expect(state().exploration.route).toHaveLength(2);
    expect(state().rewindToPreviousChoice()).toBe(true);
    expect(state().story!.variablesState.$('score')).toBe(0);
    expect(state().exploration.route).toHaveLength(1);
  });

  it.each([false, true])('restores an old branch decision history (reload: %s)', (reload) => {
    state().enterPlay(branch(), { saveKey: KEY });
    state().choose(0);
    state().choose(0);
    state().completeCurrentNode();
    state().rewindToNode('intro');
    state().choose(1);
    if (reload) {
      state().exitPlay();
      state().enterPlay(branch(), { saveKey: KEY });
      expect(state().resumeSaved()).toBe(true);
    }
    expect(state().rewindToNode('end')).toBe(true);
    expect(state().rewindToPreviousChoice()).toBe(true);
    expect(state().currentNodeId).toBe('left');
    expect(state().story!.variablesState.$('score')).toBe(5);
    expect(state().rewindToPreviousChoice()).toBe(true);
    expect(state().currentNodeId).toBe('intro');
    expect(state().story!.variablesState.$('score')).toBe(0);
  });

  it('restores historical loop visits after newer visits overwrite the node checkpoint', () => {
    const compiled = compileGraphToInk([node('intro', true), node('end')], [
      edge('intro', 'intro', 0, { effects: [{ var: 'score', delta: 1 }] }), edge('intro', 'end', 1),
    ], [{ name: 'score', label: '好感', initial: 0 }]);
    state().enterPlay(compiled, { saveKey: KEY });
    state().choose(0);
    state().choose(1);
    state().completeCurrentNode();
    state().restart();
    state().choose(0);
    state().choose(0);
    state().exitPlay();
    state().enterPlay(compiled, { saveKey: KEY });
    state().resumeSaved();
    expect(state().rewindToNode('end')).toBe(true);
    expect(state().rewindToPreviousChoice()).toBe(true);
    expect(state().story!.variablesState.$('score')).toBe(1);
    expect(state().rewindToPreviousChoice()).toBe(true);
    expect(state().story!.variablesState.$('score')).toBe(0);
    expect(state().rewindToPreviousChoice()).toBe(false);
    const history = state().exploration.checkpoints.end.decisions!;
    expect(history).toHaveLength(2);
    expect(history.every((decision) => !('decisions' in decision))).toBe(true);
  });

  it('reconstructs available old-route decisions from legacy saves without checkpoint histories', () => {
    state().enterPlay(branch(), { saveKey: KEY });
    state().choose(0); state().choose(0); state().completeCurrentNode();
    state().rewindToNode('intro'); state().choose(1);
    const saved = JSON.parse(localStorage.getItem(KEY)!);
    for (const checkpoint of Object.values(saved.exploration.checkpoints)) {
      delete (checkpoint as { decisions?: unknown }).decisions;
    }
    localStorage.setItem(KEY, JSON.stringify(saved));
    state().exitPlay(); state().enterPlay(branch(), { saveKey: KEY }); state().resumeSaved();
    expect(state().rewindToNode('end')).toBe(true);
    expect(state().rewindToPreviousChoice()).toBe(true);
    expect(state().currentNodeId).toBe('left');
  });

  it('prunes abandoned decisions on map rewinds and clears them on restart', () => {
    state().enterPlay(branch(), { saveKey: KEY });
    state().choose(0);
    state().choose(0);
    state().rewindToNode('intro');
    expect(state().exploration.decisions).toEqual([]);
    state().choose(1);
    state().rewindToPreviousChoice();
    expect(state().currentNodeId).toBe('intro');
    expect(state().story!.variablesState.$('key')).toBe(false);
    state().choose(0);
    state().restart();
    expect(state().rewindToPreviousChoice()).toBe(false);
  });
});
