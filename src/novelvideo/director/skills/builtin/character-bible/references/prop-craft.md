# Routed short-drama prop craft

Host adaptation of short-drama episode-writing, ai-producibility, adaptation-core
and event-coverage (MIT). The visible five-field mapping comes from observed
LibTV documents, not its private Skill. Do not add schema fields from this note.

## Identify objects before projecting fields

Read the complete confirmed source/outline and existing prop document. Trace the
concrete causal chain: person → action → object → visible result. Include objects
that carry an action, obstacle, evidence or emotional turn, not every background
decoration. Preserve distinct physical objects even when their names or functions
match. Two people's phones are two objects; a phone and the video on it are not
automatically two separate physical props. A document's copy is not its original.
Use distinguishing names grounded in the source (holder, title, mark). Keep IDs
when supplied, and maintain narrative order rather than alphabetical sorting.

Before writing each entry, track established holder/location/state before and
after each action. Holding does not prove legal ownership. Reading or showing a
document is not handing it over; recording, replaying, sending and receipt are
different events. Do not invent a handoff, signature, transmission or destruction
to bridge an unknown. An instruction about future delivery is not a completed
delivery. An object shown inside a TV/video remains there unless transfer into
the real scene is explicitly established. Source uncertainties remain unknown.

## Visible five-field projection

- type: a concise category in output_language (e.g. evidence or technology), based
  on its actual dramatic role. Categories are not a closed taxonomy. Do not imply
  a magical power simply by categorizing an ordinary object as symbolic.
- dramaticFunction: the specific action/result the object enables in this story.
  Include the causal handoff when relevant, not abstract statements such as
  "drives the plot". Do not paste the whole story into every entry.
- usageBoundary: its established ability and limits, who holds/uses it, relevant
  location and state changes, final state if known, and the actual scope of what
  evidence shows. Put continuity here, not in extra visible columns. Missing
  color/material/owner/end state is unestablished, not permission to invent it.
- firstEpisodeId: the first established appearance using the host episode ID,
  including an explicitly labeled screen-only appearance. An offscreen mention
  does not establish possession or an appearance in a real location.
- keyEpisodeIds: ordered unique host IDs where this object has a confirmed role;
  do not copy every episode onto every object. First appearance can precede a key
  episode. Neither source episode labels nor array positions are host IDs.

Do not mistake an observed restriction for a universal power rule. "A key opens
this box" does not establish "this key cannot open any other box". "The recording
is not sent in this episode" does not mean "the phone cannot send videos". An
unknown destination is not a secret location; a prop need not gain backstory,
symbolism, extra damage, color, powers or future payoff just to fill the form.
For adaptation extract confirmed events; for original work propose additions
only within the user's creative allowance and label proposals explicitly.

Check every causal object, holder, transfer and state against the source, outline
and supplied existing documents. Avoid contradictions across fields. If there
are genuinely no story-relevant props, return props=[] and an honest emptyReason
in output_language; otherwise emptyReason=null. Never invent a prop to avoid an
empty list. This self-check is not independent verification or permission to
adopt, finalize, generate media or make another model call.
