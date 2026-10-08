# Routed short-drama scene craft

Host-adapted from short-drama episode-writing, ai-producibility, adaptation-core
and event-coverage. This is not LibTV's private Skill. The host schema defines
the output; these are methods for grounding spatial choices, not extra fields.

Visible fields in order: name (concrete place, not a scene number), type
(interior/exterior/mixed/unknown), dramaticFunction, spatialConstraints,
reusablePositions, keyEpisodeIds (ordered unique host episode IDs).

1. Read the complete confirmed outline and supplied source before listing places.
   List each story location once in narrative order. Distinct rooms with different
   action constraints remain distinct; a corridor is not silently merged into an
   office. Preserve established names, whether inside/outside, time and access.
2. Trace person → action → object → visible result. For each place ask why the
   event happens there and what the space permits or prevents: who enters from
   where, who can see/hear whom, where a prop starts and ends, and how a person
   leaves. Carry spatial facts forward; a shut door cannot become an open passage
   without an action. Psychological explanation alone is not a spatial design.
3. Put the established event in dramaticFunction, the enabling constraint in
   spatialConstraints, and concrete actor/object positions in reusablePositions.
   A one-off appearance stays one-off; multiple episodes require the actual host
   IDs. Keep time-of-day and physical continuity inside these fields when known.
4. Adaptation preserves locations and causal events. Do not infer a full floor
   plan from a room name, call a courtyard interior merely because it is walled,
   turn a letter's destination into a visited scene, or turn a television image
   into the protagonist's physical location. Explicitly mark unknowns in the
   output language. Proposed additions require the user's allowance and must be
   labeled as proposals, never disguised as source facts.
5. Original work may propose specific spatial arrangements only within the
   confirmed creative allowance. More decoration is not more useful: an obstacle
   should affect the established goal/action, not introduce a new subplot or
   hidden premise. No mandatory villain or expanded episode count.
6. Before returning, check coverage against every established place and episode,
   then check entrances, exits, visibility, time and prop movement for conflicts.
   Source uncertainties remain uncertainties. This self-check does not replace
   independent review or the user's adoption, and cannot certify runtime quality.

## Grounding counterexamples from retained tests

- "There is a door" does NOT mean "there is only one door". Preserve the stated
  door and leave the number of other doors unknown. "Must open the closed door"
  does not imply that every person always opens it personally.
- "Chen does not open the box for Lin" does NOT mean "Chen cannot touch the box".
  A table of unspecified position is not central; unspecified posture is not
  "standing or sitting on one side". Omitting an invented detail is preferable to
  presenting alternatives or adding a prohibition. Avoid words like only/never
  unless the source itself establishes that limit.
- A visible television carriage is a separate scene-list entry, e.g. "Carriage
  on the television (screen image only)". Its dramatic function and constraints
  state the exact shown image and unknown narrative role; no real character
  enters it. Never hide a separately visible place inside another entry's prose.
  By contrast, a bridge named only in a letter is not a shown scene: record that
  mention in the letter's current scene without inventing a bridge visit/design.
- Each field should add its own useful information. Do not retell the whole plot
  three times or fill the design with administrative bans. State unknown layout
  once; distinguish physical constraints from the user's creative constraints.
