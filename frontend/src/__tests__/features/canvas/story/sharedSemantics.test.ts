import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Compiler } from 'inkjs/full';
import type { CanvasNode, CanvasEdge } from '@/features/canvas/domain/canvasNodes';
import type { StoryConditionExpr, StoryVariable, StoryFlag } from '@/features/canvas/story/storyTypes';
import { lintStory } from '@/features/canvas/story/lintStory';
import { compileStoryGroup } from '@/features/canvas/story/compileStoryGroup';

type Leaf =
  | { kind: 'variable'; variable: string; operator: '<' | '<=' | '==' | '>=' | '>'; value: number }
  | { kind: 'flag'; flag: string; value: boolean }
  | { kind: 'visited'; segment_id: string; operator: '<' | '<=' | '==' | '>=' | '>'; value: number };
type Condition = Leaf | { kind: 'group'; join: 'and' | 'or'; items: Leaf[] };
interface Case {
  story: {
    story_id: string; start_segment_id: string;
    variables: StoryVariable[]; flags: StoryFlag[];
    segments: Array<{ id: string; script: string; ending_label?: string; media: { url: string } }>;
    choices: Array<{
      id: string; source_segment_id: string; target_segment_id: string;
      mode: 'visible' | 'automatic'; text: string; order: number; condition?: Condition;
      effects?: Array<{ kind: 'increment'; variable: string; delta: number } | { kind: 'set_flag'; flag: string; value: boolean }>;
    }>;
  };
  expectedIssues: Array<{ code: string; severity: string; entityId: string | null }>;
  playthroughs: Array<{ choices: string[]; expectedSegments: string[]; expectedVariables: Record<string, number | boolean>; expectedChoices?: string[]; expectedRuntimeErrors?: string[]; restoreBeforeChoice?: number }>;
}

// Test-only field adapter: no condition evaluation or expected-result generation.
// Domain IDs remain unchanged so both languages report the same fixture entities.
function condition(value: Condition): StoryConditionExpr {
  switch (value.kind) {
    case 'group': return { join: value.join, items: value.items.map(condition) } as StoryConditionExpr;
    case 'variable': return { var: value.variable, op: value.operator, value: value.value };
    case 'visited': return { visitedNodeId: value.segment_id, op: value.operator, value: value.value };
    case 'flag': return { flag: value.flag, value: value.value };
  }
}
function canvas(story: Case['story']) {
  const groupId = `group-${story.story_id}`;
  const nodes = [
    { id: groupId, type: 'groupNode', position: { x: 0, y: 0 }, data: {
      storyGroup: true, storyVariableDefinitions: story.variables, storyFlags: story.flags,
    } },
    ...story.segments.map(segment => ({
      id: segment.id, type: 'videoNode', parentId: groupId, position: { x: 0, y: 0 },
      data: { narration: segment.script, videoUrl: segment.media.url,
        endingLabel: segment.ending_label,
        storyRole: segment.id === story.start_segment_id ? 'start' : undefined },
    })),
  ] as CanvasNode[];
  const edges = story.choices.map(choice => ({
    id: choice.id, type: 'storyChoiceEdge', source: choice.source_segment_id, target: choice.target_segment_id,
    data: { choiceText: choice.text, transitionMode: choice.mode, order: choice.order,
      condition: choice.condition ? condition(choice.condition) : undefined,
      effects: (choice.effects ?? []).map(effect => effect.kind === 'set_flag'
        ? { flag: effect.flag, value: effect.value } : { var: effect.variable, delta: effect.delta }),
    },
  })) as CanvasEdge[];
  return { groupId, nodes, edges };
}
const directory = resolve(__dirname, '../../../../../../tests/fixtures/interactive_story/cases');
const files = readdirSync(directory).filter(file => file.endsWith('.json')).sort();
const canonical = (issues: Case['expectedIssues']) => issues.map(issue => JSON.stringify([issue.code, issue.severity, issue.entityId])).sort();

it('discovers shared fixtures', () => expect(files.length).toBeGreaterThan(0));
for (const file of files) {
  const fixture = JSON.parse(readFileSync(`${directory}/${file}`, 'utf8')) as Case;
  describe(file, () => {
    const { story } = fixture;
    const { groupId, nodes, edges } = canvas(story);
    it('matches backend semantic findings, including severity and entity', () => {
      const issues = lintStory(nodes.filter(node => node.parentId === groupId), edges, story.variables, story.flags);
      expect(canonical(issues.map(issue => ({ code: issue.code, severity: issue.severity,
        entityId: issue.edgeId ?? issue.nodeId ?? null })))).toEqual(canonical(fixture.expectedIssues));
    });
    if (fixture.expectedIssues.some(issue => issue.severity === 'error')) {
      it('blocks invalid graphs at the production compile gate', () => {
        expect(() => compileStoryGroup(groupId, nodes, edges)).toThrow();
        expect(fixture.playthroughs).toEqual([]);
      });
    }
    for (const [index, trace] of fixture.playthroughs.entries()) {
      const execute = () => {
        const compiled = compileStoryGroup(groupId, nodes, edges);
        let runtime = new Compiler(compiled.ink).Compile();
        const errors: string[] = [];
        runtime.onError = message => { errors.push(message); };
        const visited: string[] = [];
        let continuations = 0;
        const advance = () => {
          while (runtime.canContinue) {
            // Protect the suite against accidental automatic loops.
            expect(++continuations).toBeLessThan(100);
            runtime.Continue();
            for (const tag of runtime.currentTags ?? []) {
              if (tag.startsWith('clip:')) visited.push(tag.slice(5).trim());
            }
          }
        };
        advance();
        for (const [choiceIndex, id] of trace.choices.entries()) {
          if (trace.restoreBeforeChoice === choiceIndex) {
            const saved = runtime.state.ToJson();
            runtime = new Compiler(compiled.ink).Compile();
            runtime.onError = message => { errors.push(message); };
            runtime.state.LoadJson(saved);
          }
          const choice = story.choices.find(item => item.id === id)!;
          expect(choice).toBeDefined();
          expect(choice.source_segment_id).toBe(visited[visited.length - 1]);
          const options = runtime.currentChoices.filter(item => item.text === choice.text);
          expect(options, JSON.stringify({ id, visited, choices: runtime.currentChoices.map(c => c.text), ink: compiled.ink })).toHaveLength(1);
          runtime.ChooseChoiceIndex(options[0].index);
          advance();
        }
        expect(visited).toEqual(trace.expectedSegments);
        expect(errors).toHaveLength((trace.expectedRuntimeErrors ?? []).length);
        for (const [i, message] of (trace.expectedRuntimeErrors ?? []).entries()) {
          expect(errors[i]).toContain(message);
        }
        for (const [name, value] of Object.entries(trace.expectedVariables)) {
          expect(runtime.variablesState!.$(name)).toBe(value);
        }
        return runtime.currentChoices.map(choice => choice.text);
      };
      it(`executes Ink trace ${index + 1}`, () => {
        expect(execute()).toEqual(trace.expectedChoices ?? []);
      });

    }
  });
}
