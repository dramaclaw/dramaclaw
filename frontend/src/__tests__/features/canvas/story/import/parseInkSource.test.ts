import { describe, expect, it } from 'vitest';
import { parseInkSource } from '@/features/canvas/story/import/parseInkSource';

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

describe('parseInkSource', () => {
  it('解析变量、起点、knot、视频提示', () => {
    const story = parseInkSource(INK);
    expect(story.variables).toEqual([{ name: 'favor', initial: 0 }, { name: 'trust', initial: 0 }]);
    expect(story.startKnot).toBe('start');
    const start = story.knots.find((k) => k.name === 'start')!;
    expect(start.videoHint).toBe('intro.mp4');
    expect(start.narration).toContain('深夜寝殿');
  });

  it('解析选项的文案、效果、目标', () => {
    const start = parseInkSource(INK).knots.find((k) => k.name === 'start')!;
    expect(start.outgoing[0]).toMatchObject({ kind: 'choice', text: '接受召见', target: 'palace' });
    expect(start.outgoing[0].effects).toEqual([{ var: 'favor', delta: 5 }, { var: 'trust', delta: 1 }]);
    expect(start.outgoing[1]).toMatchObject({ kind: 'choice', text: '称病推辞', target: 'sick' });
    expect(start.outgoing[1].effects).toEqual([{ var: 'trust', delta: 3 }]);
  });

  it('解析直接跳转 divert', () => {
    const palace = parseInkSource(INK).knots.find((k) => k.name === 'palace')!;
    expect(palace.outgoing).toEqual([expect.objectContaining({ kind: 'divert', target: 'judge' })]);
  });

  it('条件块解析成 autoConditional 并打 needsReview(else 分支也解析)', () => {
    const judge = parseInkSource(INK).knots.find((k) => k.name === 'judge')!;
    const auto = judge.outgoing.filter((l) => l.kind === 'autoConditional');
    expect(auto.length).toBe(3);
    auto.forEach((l) => expect(l.needsReview).toBe(true));
    expect(auto.find((l) => l.target === 'ge')!.condition).toBe('favor >= 5 && trust >= 0');
    expect(auto.find((l) => l.target === 'ne')!.condition).toBe('trust >= 3');
    expect(auto.find((l) => l.target === 'be')).toBeTruthy();
  });

  it('结局 knot 标 isEnding + endingLabel', () => {
    const ge = parseInkSource(INK).knots.find((k) => k.name === 'ge')!;
    expect(ge.isEnding).toBe(true);
    expect(ge.tags).toContain('ending: GE');
    expect(ge.endingLabel).toBe('GE');
  });

  it('解析限时:# choiceTime → choiceTimeLimitSec,# default 标默认选项', () => {
    const start = parseInkSource(INK).knots.find((k) => k.name === 'start')!;
    // choiceTime 优先于 timeout
    expect(start.choiceTimeLimitSec).toBe(4);
    // # default: 1 → 1-based → 第一条选项(接受召见)为默认
    expect(start.outgoing[0].isDefault).toBe(true);
    expect(start.outgoing[1].isDefault).toBeFalsy();
  });

  it('无 timing tag 的 knot 不带 choiceTimeLimitSec / isDefault', () => {
    const palace = parseInkSource(INK).knots.find((k) => k.name === 'palace')!;
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
    const a = parseInkSource(ink).knots.find((k) => k.name === 'a')!;
    expect(a.choiceTimeLimitSec).toBe(6);
  });

  it('单行内联条件跳转 { cond: -> target } 解析成 autoConditional(不当成 narration)', () => {
    const ink = `
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
    const fc = parseInkSource(ink).knots.find((k) => k.name === 'final_choice')!;
    const auto = fc.outgoing.find((l) => l.kind === 'autoConditional');
    expect(auto).toMatchObject({ kind: 'autoConditional', target: 'high_trust', condition: 'trust >= 3' });
    expect(fc.outgoing.find((l) => l.kind === 'divert')).toMatchObject({ target: 'low_trust' });
    expect(fc.narration).not.toContain('high_trust');
  });

  it('单行内联 if/else { cond: -> a | -> b } 解析成两条分支', () => {
    const ink = `
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
    const fc = parseInkSource(ink).knots.find((k) => k.name === 'fc')!;
    const auto = fc.outgoing.filter((l) => l.kind === 'autoConditional');
    expect(auto.map((l) => l.target)).toEqual(['a', 'b']);
    expect(auto.find((l) => l.target === 'a')!.condition).toBe('trust >= 3');
    expect(auto.find((l) => l.target === 'b')!.condition).toBeUndefined();
  });
});
