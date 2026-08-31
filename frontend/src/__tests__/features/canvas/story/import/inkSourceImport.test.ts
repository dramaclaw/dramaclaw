import { describe, expect, it } from 'vitest';
import { InkCompileError, parseStory } from '@/features/canvas/story/import';

const INK = `
VAR favor = 0
VAR trust = 0

-> start

=== start ===
深夜寝殿。# video: intro.mp4 # choiceTime: 4 # timeout: 5 # default: 1
+ [接受召见]
    ~ favor += 5
    ~ trust += 1
    -> palace
+ [称病推辞]
    ~ trust += 3
    -> sick

=== palace ===
金殿。# video: palace.mp4
-> judge

=== judge ===
天平。# video: judge.mp4
{
    - favor >= 5 && trust >= 0:
        -> ge
    - trust >= 3:
        -> ne
    - else:
        -> be
}

=== ge ===
宠冠后宫 # ending: GE
-> END

=== ne ===
全身而退 # ending: NE
-> END

=== sick ===
宫墙。# video: sick.mp4
-> judge

=== be ===
幽居冷宫 # ending: BE
-> END
`;

describe('ink 源码导入(inkjs 编译 → JSON 解析)', () => {
  it('解析变量、起点、knot、视频提示', () => {
    const story = parseStory(INK);
    expect(story.variables).toEqual([{ name: 'favor', initial: 0 }, { name: 'trust', initial: 0 }]);
    expect(story.startKnot).toBe('start');
    const start = story.knots.find((k) => k.name === 'start')!;
    expect(start.videoHint).toBe('intro.mp4');
    expect(start.narration).toContain('深夜寝殿');
  });

  it('解析选项的文案、效果、目标', () => {
    const start = parseStory(INK).knots.find((k) => k.name === 'start')!;
    expect(start.outgoing[0]).toMatchObject({ kind: 'choice', text: '接受召见', target: 'palace' });
    expect(start.outgoing[0].effects).toEqual([{ var: 'favor', delta: 5 }, { var: 'trust', delta: 1 }]);
    expect(start.outgoing[1]).toMatchObject({ kind: 'choice', text: '称病推辞', target: 'sick' });
    expect(start.outgoing[1].effects).toEqual([{ var: 'trust', delta: 3 }]);
  });

  it('解析直接跳转 divert', () => {
    const palace = parseStory(INK).knots.find((k) => k.name === 'palace')!;
    expect(palace.outgoing).toEqual([expect.objectContaining({ kind: 'divert', target: 'judge' })]);
  });

  it('条件块解析成 autoConditional 并打 needsReview(else 分支也解析)', () => {
    const judge = parseStory(INK).knots.find((k) => k.name === 'judge')!;
    const auto = judge.outgoing.filter((l) => l.kind === 'autoConditional');
    expect(auto.length).toBe(3);
    auto.forEach((l) => expect(l.needsReview).toBe(true));
    expect(auto.find((l) => l.target === 'ge')!.condition).toBe('favor >= 5 && trust >= 0');
    expect(auto.find((l) => l.target === 'ne')!.condition).toBe('trust >= 3');
    expect(auto.find((l) => l.target === 'be')).toBeTruthy();
  });

  it('结局 knot 标 isEnding + endingLabel', () => {
    const ge = parseStory(INK).knots.find((k) => k.name === 'ge')!;
    expect(ge.isEnding).toBe(true);
    expect(ge.tags).toContain('ending: GE');
    expect(ge.endingLabel).toBe('GE');
  });

  it('解析限时:# choiceTime → choiceTimeLimitSec,# default 标默认选项', () => {
    const start = parseStory(INK).knots.find((k) => k.name === 'start')!;
    // choiceTime 优先于 timeout
    expect(start.choiceTimeLimitSec).toBe(4);
    // # default: 1 → 1-based → 第一条选项(接受召见)为默认
    expect(start.outgoing[0].isDefault).toBe(true);
    expect(start.outgoing[1].isDefault).toBeFalsy();
  });

  it('无 timing tag 的 knot 不带 choiceTimeLimitSec / isDefault', () => {
    const palace = parseStory(INK).knots.find((k) => k.name === 'palace')!;
    expect(palace.choiceTimeLimitSec).toBeUndefined();
    expect(palace.outgoing.every((l) => !l.isDefault)).toBe(true);
  });

  it('只有 # timeout 时用 timeout 作时限', () => {
    const ink = `
-> a
=== a ===
文本。# timeout: 6
+ [去 b] -> b
=== b ===
B # ending: X
-> END
`;
    const a = parseStory(ink).knots.find((k) => k.name === 'a')!;
    expect(a.choiceTimeLimitSec).toBe(6);
  });

  it('单行内联条件跳转 { cond: -> target } 解析成 autoConditional(不当成 narration)', () => {
    const ink = `
VAR trust = 0
-> final_choice
=== final_choice ===
{ trust >= 3: -> high_trust }
-> low_trust
=== high_trust ===
赢了
-> END
=== low_trust ===
输了
-> END
`;
    const fc = parseStory(ink).knots.find((k) => k.name === 'final_choice')!;
    const auto = fc.outgoing.find((l) => l.kind === 'autoConditional');
    expect(auto).toMatchObject({ kind: 'autoConditional', target: 'high_trust', condition: 'trust >= 3' });
    expect(fc.outgoing.find((l) => l.kind === 'divert')).toMatchObject({ target: 'low_trust' });
    expect(fc.narration).not.toContain('high_trust');
  });

  it('单行内联 if/else { cond: -> a | -> b } 解析成两条分支', () => {
    const ink = `
VAR trust = 0
-> fc
=== fc ===
{ trust >= 3: -> a | -> b }
=== a ===
A
-> END
=== b ===
B
-> END
`;
    const fc = parseStory(ink).knots.find((k) => k.name === 'fc')!;
    const auto = fc.outgoing.filter((l) => l.kind === 'autoConditional');
    expect(auto.map((l) => l.target)).toEqual(['a', 'b']);
    expect(auto.find((l) => l.target === 'a')!.condition).toBe('trust >= 3');
    expect(auto.find((l) => l.target === 'b')!.condition).toBeUndefined();
  });
  it('语法错误由 inkjs 编译器拦下,抛 InkCompileError 并带行号', () => {
    // `~` 只能独占一行,inklecate 会报错;旧的手写解析器会静默接受并产出错误图。
    const ink = `-> a
=== a ===
文本
+ [走] ~ x += 1
-> b
`;
    let caught: unknown;
    try {
      parseStory(ink);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InkCompileError);
    expect((caught as InkCompileError).errors.join('\n')).toMatch(/line 4/);
  });

  it('未声明变量会被编译器拦下', () => {
    const ink = `-> a
=== a ===
{ trust >= 3: -> a }
-> END
`;
    expect(() => parseStory(ink)).toThrow(InkCompileError);
  });

  it('编译告警与 TODO 进入 story.warnings', () => {
    const ink = `-> a
=== a ===
TODO 这里要补分支
文本
-> END
`;
    const story = parseStory(ink);
    expect(story.warnings.some((w) => w.includes('这里要补分支'))).toBe(true);
  });

  it('.json 输入不走编译,仍按 story JSON 解析', () => {
    const story = parseStory(INK);
    const json = JSON.stringify({ inkVersion: 21, root: [], listDefs: {} });
    expect(parseStory(json, 'x.json').knots).toEqual([]);
    expect(story.knots.length).toBeGreaterThan(0);
  });
});
