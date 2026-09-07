"""Bounded, condition-aware reachability analysis for interactive stories."""

from __future__ import annotations

from dataclasses import dataclass

from novelvideo.interactive_story.models import (
    InteractiveStoryIssue,
    StoryChoice,
    StoryCondition,
    StoryConditionGroup,
    StoryDraftV2,
    StoryEffect,
    StoryFlagCondition,
    StorySetFlagEffect,
    StoryVariableCondition,
    StoryVisitCondition,
)

MAX_ANALYSIS_STATES = 2_000
MAX_AUTOMATIC_CHAIN = 100


@dataclass(frozen=True)
class _RuntimeState:
    segment_id: str
    variables: tuple[int, ...]
    flags: tuple[bool, ...]
    visits: tuple[int, ...]


def analyze_story_paths(story: StoryDraftV2) -> list[InteractiveStoryIssue]:
    """Explore reachable runtime states without mutating the story.

    The exploration is exact while it stays below ``MAX_ANALYSIS_STATES``.
    Visit counters are saturated above the largest threshold referenced by the
    story because larger values are equivalent for the supported comparisons.
    """

    segment_ids = [segment.id for segment in story.segments]
    segment_index = {segment_id: index for index, segment_id in enumerate(segment_ids)}
    variable_index = {variable.name: index for index, variable in enumerate(story.variables)}
    flag_index = {flag.name: index for index, flag in enumerate(story.flags)}
    variable_by_name = {variable.name: variable for variable in story.variables}
    visit_caps = [1 for _ in segment_ids]
    for choice in story.choices:
        for leaf in _condition_leaves(choice.condition):
            if isinstance(leaf, StoryVisitCondition):
                visit_caps[segment_index[leaf.segment_id]] = max(
                    visit_caps[segment_index[leaf.segment_id]], leaf.value + 1
                )

    choices_by_source: dict[str, list[StoryChoice]] = {}
    for choice in story.choices:
        choices_by_source.setdefault(choice.source_segment_id, []).append(choice)
    for choices in choices_by_source.values():
        choices.sort(key=lambda choice: choice.order)

    initial_visits = [0 for _ in segment_ids]
    initial_index = segment_index[story.start_segment_id]
    initial_visits[initial_index] = 1
    initial = _RuntimeState(
        segment_id=story.start_segment_id,
        variables=tuple(variable.initial for variable in story.variables),
        flags=tuple(flag.initial for flag in story.flags),
        visits=tuple(initial_visits),
    )
    queue: list[tuple[_RuntimeState, frozenset[_RuntimeState], int]] = [
        (initial, frozenset(), 0)
    ]
    seen: set[_RuntimeState] = set()
    reached_segments: set[str] = set()
    reached_choices: set[str] = set()
    issues: list[InteractiveStoryIssue] = []
    issue_keys: set[tuple[str, str | None]] = set()
    complete = True

    def add_issue(issue: InteractiveStoryIssue) -> None:
        key = (issue.code, issue.entity_id)
        if key not in issue_keys:
            issue_keys.add(key)
            issues.append(issue)

    while queue:
        if len(seen) >= MAX_ANALYSIS_STATES:
            complete = False
            break
        state, automatic_chain, automatic_depth = queue.pop(0)
        if state in seen:
            continue
        seen.add(state)
        reached_segments.add(state.segment_id)
        source_choices = choices_by_source.get(state.segment_id, [])
        automatic = [choice for choice in source_choices if choice.mode == "automatic"]
        visible = [choice for choice in source_choices if choice.mode == "visible"]
        selected_automatic = next(
            (choice for choice in automatic if _condition_matches(choice.condition, state, variable_index, flag_index, segment_index)),
            None,
        )
        transitions = [selected_automatic] if selected_automatic else [
            choice
            for choice in visible
            if _condition_matches(choice.condition, state, variable_index, flag_index, segment_index)
        ]
        for choice in transitions:
            reached_choices.add(choice.id)
            next_state = _apply_choice(
                story,
                state,
                choice,
                variable_index,
                flag_index,
                segment_index,
                visit_caps,
                variable_by_name,
                add_issue,
            )
            if next_state is None:
                continue
            if choice.mode == "automatic":
                next_depth = automatic_depth + 1
                if next_state in automatic_chain or next_state == state:
                    add_issue(
                        InteractiveStoryIssue(
                            severity="error",
                            code="automatic_cycle",
                            message="自动跳转形成了无法等待玩家输入的循环。",
                            entity_type="choice",
                            entity_id=choice.id,
                        )
                    )
                    continue
                if next_depth > MAX_AUTOMATIC_CHAIN:
                    complete = False
                    continue
                queue.append((next_state, automatic_chain | {state}, next_depth))
            else:
                queue.append((next_state, frozenset(), 0))

    if not complete:
        add_issue(
            InteractiveStoryIssue(
                severity="warning",
                code="path_analysis_incomplete",
                message="故事状态组合过多，条件路径分析未能完整覆盖。",
                entity_type="story",
                entity_id=story.story_id,
            )
        )
        return issues

    structurally_reached = _structurally_reached_segments(story)
    for segment_id in structurally_reached - reached_segments:
        add_issue(
            InteractiveStoryIssue(
                severity="warning",
                code="runtime_unreachable",
                message="节点在连线图中可达，但现有状态和条件下无法进入。",
                entity_type="segment",
                entity_id=segment_id,
            )
        )
    for choice in story.choices:
        if choice.source_segment_id in reached_segments and choice.id not in reached_choices:
            add_issue(
                InteractiveStoryIssue(
                    severity="warning",
                    code="condition_unreachable",
                    message="该分支在现有状态变化下永远不会触发。",
                    entity_type="choice",
                    entity_id=choice.id,
                )
            )
    return issues


def _apply_choice(
    story: StoryDraftV2,
    state: _RuntimeState,
    choice: StoryChoice,
    variable_index: dict[str, int],
    flag_index: dict[str, int],
    segment_index: dict[str, int],
    visit_caps: list[int],
    variable_by_name: dict,
    add_issue,
) -> _RuntimeState | None:
    values = list(state.variables)
    flags = list(state.flags)
    for effect in choice.effects:
        if isinstance(effect, StoryEffect):
            index = variable_index[effect.variable]
            next_value = values[index] + effect.delta
            variable = variable_by_name[effect.variable]
            if (
                variable.minimum is not None
                and next_value < variable.minimum
                or variable.maximum is not None
                and next_value > variable.maximum
            ):
                add_issue(
                    InteractiveStoryIssue(
                        severity="error",
                        code="variable_out_of_bounds",
                        message=f"分支会让“{variable.label}”超出声明范围。",
                        entity_type="choice",
                        entity_id=choice.id,
                    )
                )
                return None
            values[index] = next_value
        elif isinstance(effect, StorySetFlagEffect):
            flags[flag_index[effect.flag]] = effect.value
    visits = list(state.visits)
    target_index = segment_index[choice.target_segment_id]
    visits[target_index] = min(visit_caps[target_index], visits[target_index] + 1)
    return _RuntimeState(
        segment_id=choice.target_segment_id,
        variables=tuple(values),
        flags=tuple(flags),
        visits=tuple(visits),
    )


def _condition_matches(
    condition: StoryCondition | None,
    state: _RuntimeState,
    variable_index: dict[str, int],
    flag_index: dict[str, int],
    segment_index: dict[str, int],
) -> bool:
    if condition is None:
        return True
    if isinstance(condition, StoryConditionGroup):
        results = [
            _leaf_matches(item, state, variable_index, flag_index, segment_index)
            for item in condition.items
        ]
        return all(results) if condition.join == "and" else any(results)
    return _leaf_matches(condition, state, variable_index, flag_index, segment_index)


def _leaf_matches(leaf, state, variable_index, flag_index, segment_index) -> bool:
    if isinstance(leaf, StoryVariableCondition):
        return _compare(state.variables[variable_index[leaf.variable]], leaf.operator, leaf.value)
    if isinstance(leaf, StoryFlagCondition):
        return state.flags[flag_index[leaf.flag]] is leaf.value
    if isinstance(leaf, StoryVisitCondition):
        return _compare(state.visits[segment_index[leaf.segment_id]], leaf.operator, leaf.value)
    return False


def _compare(left: int, operator: str, right: int) -> bool:
    return {
        ">=": left >= right,
        "<=": left <= right,
        "==": left == right,
        ">": left > right,
        "<": left < right,
    }[operator]


def _condition_leaves(condition: StoryCondition | None):
    if condition is None:
        return []
    return condition.items if isinstance(condition, StoryConditionGroup) else [condition]


def _structurally_reached_segments(story: StoryDraftV2) -> set[str]:
    outgoing: dict[str, list[str]] = {}
    for choice in story.choices:
        outgoing.setdefault(choice.source_segment_id, []).append(choice.target_segment_id)
    reached: set[str] = set()
    queue = [story.start_segment_id]
    while queue:
        segment_id = queue.pop(0)
        if segment_id in reached:
            continue
        reached.add(segment_id)
        queue.extend(outgoing.get(segment_id, []))
    return reached
