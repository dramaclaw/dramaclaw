import { describe, expect, it } from 'vitest';
import { parseInkJson } from '@/features/canvas/story/import/parseInkJson';

// 真实 ~/Downloads/story.js.json 全文(inkjs v21 runtime container),作为解析锚。
const JSON_TEXT = `{"inkVersion":21,"root":[[{"->":"start"},["done",{"#f":5,"#n":"g-0"}],null],"done",{"start":[["^深夜，苏鸾寝殿。烛火摇曳，匕首映出一张冷汗涔涔的脸。","#","^video: intro.mp4 ","/#","#","^choiceTime: 4 ","/#","#","^timeout: 5 ","/#","#","^default: 1","/#","\\n","ev","str","^接受召见","/str","/ev",{"*":".^.c-0","flg":4},"ev","str","^称病推辞","/str","/ev",{"*":".^.c-1","flg":4},{"c-0":["\\n","ev",{"VAR?":"favor"},5,"+",{"VAR=":"favor","re":true},"/ev","ev",{"VAR?":"trust"},1,"+",{"VAR=":"trust","re":true},"/ev",{"->":"palace"},{"#f":5}],"c-1":["\\n","ev",{"VAR?":"trust"},3,"+",{"VAR=":"trust","re":true},"/ev",{"->":"sick"},{"#f":5}]}],{"#f":1}],"palace":["^苏鸾随侍入宫，金殿之上，圣意难测。","#","^video: palace.mp4","/#","\\n",{"->":"judge"},{"#f":1}],"sick":["^苏鸾托病不出，宫墙之内，暗流涌动。","#","^video: sick.mp4","/#","\\n",{"->":"judge"},{"#f":1}],"judge":["^命运的天平，终将倾向何方。","#","^video: judge.mp4","/#","\\n",["ev",{"VAR?":"favor"},5,">=",{"VAR?":"trust"},0,">=","&&","/ev",{"->":".^.b","c":true},{"b":["\\n",{"->":"ge"},{"->":"judge.8"},null]}],["ev",{"VAR?":"trust"},3,">=","/ev",{"->":".^.b","c":true},{"b":["\\n",{"->":"ne"},{"->":"judge.8"},null]}],[{"->":".^.b"},{"b":["\\n",{"->":"be"},{"->":"judge.8"},null]}],"nop","\\n",{"#f":1}],"ge":["^宠冠后宫 ","#","^ending: GE","/#","\\n","end",{"#f":1}],"ne":["^全身而退 ","#","^ending: NE","/#","\\n","end",{"#f":1}],"be":["^幽居冷宫 ","#","^ending: BE","/#","\\n","end",{"#f":1}],"global decl":["ev",0,{"VAR=":"favor"},0,{"VAR=":"trust"},"/ev","end",null],"#f":1}],"listDefs":{}}`;

describe('parseInkJson', () => {
  it('解析出 knot、起点、视频提示', () => {
    const story = parseInkJson(JSON_TEXT);
    expect(story.startKnot).toBe('start');
    const names = story.knots.map((k) => k.name).sort();
    expect(names).toEqual(['be', 'ge', 'judge', 'ne', 'palace', 'sick', 'start'].sort());
    expect(story.knots.find((k) => k.name === 'start')!.videoHint).toBe('intro.mp4');
  });

  it('从 global decl 解析变量与初值', () => {
    const story = parseInkJson(JSON_TEXT);
    expect(story.variables).toEqual([{ name: 'favor', initial: 0 }, { name: 'trust', initial: 0 }]);
  });

  it('解析选项文案、效果、目标', () => {
    const start = parseInkJson(JSON_TEXT).knots.find((k) => k.name === 'start')!;
    const c0 = start.outgoing.find((l) => l.text === '接受召见')!;
    expect(c0).toMatchObject({ kind: 'choice', target: 'palace' });
    expect(c0.effects).toEqual([{ var: 'favor', delta: 5 }, { var: 'trust', delta: 1 }]);
    const c1 = start.outgoing.find((l) => l.text === '称病推辞')!;
    expect(c1).toMatchObject({ kind: 'choice', target: 'sick' });
    expect(c1.effects).toEqual([{ var: 'trust', delta: 3 }]);
  });

  it('解析 divert', () => {
    const story = parseInkJson(JSON_TEXT);
    expect(story.knots.find((k) => k.name === 'palace')!.outgoing)
      .toEqual([expect.objectContaining({ kind: 'divert', target: 'judge' })]);
  });

  it('解析条件分支为 autoConditional + needsReview + 重建条件文本', () => {
    const judge = parseInkJson(JSON_TEXT).knots.find((k) => k.name === 'judge')!;
    const auto = judge.outgoing.filter((l) => l.kind === 'autoConditional');
    expect(auto.map((l) => l.target).sort()).toEqual(['be', 'ge', 'ne']);
    auto.forEach((l) => expect(l.needsReview).toBe(true));
    expect(auto.find((l) => l.target === 'ge')!.condition).toBe('favor >= 5 && trust >= 0');
    expect(auto.find((l) => l.target === 'ne')!.condition).toBe('trust >= 3');
  });

  it('ge 标 isEnding', () => {
    expect(parseInkJson(JSON_TEXT).knots.find((k) => k.name === 'ge')!.isEnding).toBe(true);
  });
});
