# Routed short-drama character craft

Adapted from short-drama `/characters` and `references/villain-design.md` (MIT,
0xsline). This is a maintained adaptation, not a verbatim upstream snapshot.

For each character establish public versus real identity only when the story
supports that distinction; visible appearance, a few personality traits, core
motivation, biggest conflict, dramatic function, and distinguishable speech.
Age is not mandatory when the source has not established it. A memorable prop
must not acquire new ownership or powers simply to enrich a biography.

Build the relationship graph from actual interactions. Where applicable, trace
first conflict, a revelation, emotional turning point and confrontation to the
confirmed episodes. A flat arc is valid; do not invent a romance or reconciliation
to satisfy a template. The hidden motive belongs only to characters who know it.

An adversary's motive, resources and restraint should explain why they act now
and this way. The four-level escalation is a long-form option, not a quota.
Hidden villains require prior evidence, never a last-minute biography invention.

Check the resulting roster against the outline: whose choice changes the next
event, what action makes each trait observable, whose voice could be identified
without their name, and what remains genuinely unknown? Report unknowns honestly
instead of adding surnames, family ties, dialects or histories not authorized by
the source/brief. Preserve the user's cast size, duration and ending.

## Host biography field mapping

Use one character per identity with names[0] the display name and remaining names genuine aliases. Keep existing identity IDs where supplied. Characters stay in story prominence/order, not alphabetic order. role is protagonist/main/supporting, not a moral judgement. Assign firstEpisodeId and chronologically ordered keyEpisodeIds only from the host episodes list. Source episode numbers are not delivery IDs.

Visible roster fields in order:
- role; setting (identity, established age/appearance, personality, goal/obstacle and relevant relationships in coherent prose); dramaticFunction (their concrete contribution to this story, not a generic archetype); tags (few distinct traits).
- For protagonists/main characters: voice (rhythm, diction, dialect and a grounded line/behavior, or explicitly silent); speechFlaw (a tell supported by the story, otherwise null); memorableDetail (specific repeatable action or visible feature); arc (starting strategy → pressure/choice → actual endpoint, flat arcs allowed); pressureResponse (what they actually do when cornered); addressRules (who calls whom what, if relevant, otherwise null).
- firstEpisodeId; keyEpisodeIds. Supporting roles have a compact visible roster but still record honest voice/arc/pressure unknowns for downstream writing.

Keep the short-drama reasoning fields appearance, motive and knowledge concise and consistent with setting and the outline. These internal fields are not new visible headings: incorporate essential visible facts into setting/dramaticFunction; integrate each established relation into the relevant characters' setting/addressRules. Relations use valid character IDs and describe direction/limits, not unexplained romance. Distinguish a desired change from an observed change; no growth that requires events outside the confirmed story. A believable adversary has motive, means and restraint, but a quiet short need not acquire an adversary.
