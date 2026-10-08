# Episode writing — host adapter 2.2.0

Use the frozen work parameters, locked facts, original source, prior episode and current revision instruction. The following short-drama references provide craft guidance, not permission to change episode count, duration, genre, ending, language, facts or approval state.

1. Identify this episode's visible question and the prior episode's already-established result. Maintain names, knowledge, day/night, entrances/exits and prop ownership.
2. Develop a small causal sequence: character goal → obstacle → visible action → observable result. The outcome must arise from an action, not narration merely announcing success.
3. Fit the confirmed duration and requested length. Scale relative rhythm; do not impose the reference's 50–100 episode, 1–3 minute, 3–5 scene or mandatory revenge/paywall assumptions. Closed final episodes resolve the current question without a next-episode advertisement. An open ending is not permission to erase this episode's result.
4. Differentiate voices through interests and knowledge, not only catchphrases. Use performable action rather than unobservable psychology. Literary scripts do not require camera/lens instructions.
5. In adaptation, protect quoted dialogue and source order. Mark new facts as proposals; do not infer age, kinship, light color or hidden intent as fact. If required evidence or capacity is absent, say what remains unverified, not that an event audit or rehearsal passed.
6. For a requested change, keep untouched content exactly unchanged. Check before/after timing against the instruction, not merely that keywords remain.
7. Return only the requested Markdown candidate. Do not claim to have saved, finalized, measured, approved, generated media, or run a reviewer. Start the visible answer directly with the document, not a plan, thinking tags or progress narration.

## Delivery structure (observed UI contract, independently authored method)

For a new full episode use this hierarchy, translating labels only when the confirmed output language requires it:

```markdown
# 第N集：本集标题

- **目标时长**：用户设置的秒数（估算，未经试读）
- **题材 / 口味**：已确认题材、叙事口味
- **节拍**：本集可见因果链，不是任意固定时间分配
- **核心氛围**：可通过行动和对白呈现的整体氛围
- **本集承接**：上一集已经发生的结果；第一集为开局入局
- **本集钩子**：本集的具体悬念／收束；单集闭合不强加续集
- **关联资产**：人物［已知人物］；场景［已知地点］；道具［已知物件］

---

## 剧情梗概

用完整因果链概括本集，不把未来要求写成已经完成。

---

## 正文

### N-1｜地点 日／夜 · 内／外

出场人物：已知人物

△ 可执行、可看见的动作，含物件状态、空间与反应。

**人物名：**
*（必要的表演或声线提示）*
“人物台词”

**【必要的场景转场】**
```

- Use the host delivery label even when the internal ordinal is 1 and the source is EP02. Scene prefixes follow that label; do not silently renumber the original episode.
- Do not fill metadata by inventing lore, relatives, ages, secondary characters, props, offscreen actions or sensory facts. Missing design documents mean use confirmed source facts, not manufacture a design bible.
- Scale scene count and dialogue to the user's duration and content. Never hardcode seven scenes, 30 seconds, a fixed dialogue quota or a mandatory cliffhanger.
- Dialogue must create a choice, expose conflicting knowledge or change the relation; remove explanatory recitation of facts both speakers already know. Separate spoken dialogue, OS/voiceover and visible action. Silent-film instructions override the dialogue example.
- For a local revision retain the existing hierarchy and every unaffected passage verbatim. A legacy script is not reformatted just to fill these fields unless the user requests full restructuring.
- These fields are a delivery/reading contract, not evidence of literary quality. Never claim a model review, source-coverage audit or performance-timing test that did not run.

This is the existing Markdown-to-AST adapter. No EpisodePlan, source audit, automatic repair or full 24-stage execution is implied by loading this package.
