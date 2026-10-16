---
version: alpha
name: Runwai-design-analysis
description: An inspired interpretation of Runwai's design language — an editorial, gallery-grade marketing system for an AI creative-tools company. Cinematic photographic heroes give way to crisp white reading surfaces, a tight monochrome neutral ladder, and a single proprietary sans (abcNormal) carrying every level of the hierarchy. The system reads like a film festival programme more than a SaaS site: black ink on paper-white, generous air, hairline dividers, and reserved use of restrained slate-blue for secondary text. Pure black solid pills serve every primary action, with no accent colour competing for attention.

colors:
  primary: "#000000"
  on-primary: "#ffffff"
  ink: "#030303"
  ink-soft: "#1a1a1a"
  graphite: "#404040"
  slate: "#676f7b"
  slate-soft: "#727a85"
  mute: "#6b7280"
  stone: "#939393"
  ash: "#999999"
  hairline: "#e7eaf0"
  hairline-soft: "#c9ccd1"
  surface-cool: "#d0d4d4"
  canvas: "#ffffff"
  canvas-warm: "#fefefe"
  scrim: "#1a1a1a"
  footer: "#030303"

typography:
  display:
    fontFamily: abcNormal
    fontSize: 48px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: -1.2px
  display-sm:
    fontFamily: abcNormal
    fontSize: 40px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: -1px
  heading-md:
    fontFamily: abcNormal
    fontSize: 36px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: -0.9px
  heading-sm:
    fontFamily: abcNormal
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1
  subtitle:
    fontFamily: abcNormal
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1
  body:
    fontFamily: abcNormal
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
  body-strong:
    fontFamily: abcNormal
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.5
  body-tight:
    fontFamily: abcNormal
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: -0.16px
  link-sm:
    fontFamily: abcNormal
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.43
  meta:
    fontFamily: abcNormal
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: -0.26px
  eyebrow:
    fontFamily: abcNormal
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.43
    letterSpacing: 0.35px
  micro-caps:
    fontFamily: abcNormal
    fontSize: 11px
    fontWeight: 450
    lineHeight: 1.3
    letterSpacing: 0.2px
  button:
    fontFamily: abcNormal
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.43

rounded:
  none: 0px
  xs: 4px
  sm: 6px
  md: 8px
  lg: 16px
  full: 9999px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px
  section: 64px
  section-lg: 96px

components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.full}"
    padding: 12px
    height: 40px
  button-primary-on-dark:
    backgroundColor: "{colors.on-primary}"
    textColor: "{colors.primary}"
    typography: "{typography.button}"
    rounded: "{rounded.full}"
    padding: 12px
    height: 40px
  button-ghost:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.full}"
    padding: 12px
    height: 40px
  button-text-link:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.link-sm}"
    rounded: "{rounded.xs}"
    padding: 4px
  nav-bar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.link-sm}"
    height: 64px
    padding: 24px
  nav-link:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.link-sm}"
    padding: 8px
  pricing-card:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: 24px
    width: 224px
  pricing-card-featured:
    backgroundColor: "{colors.hairline}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: 24px
    width: 224px
  pricing-tier-name:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.heading-md}"
  pricing-amount:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.display}"
  research-card:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 16px
  media-thumbnail:
    backgroundColor: "{colors.surface-cool}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
  hero-photo:
    backgroundColor: "{colors.scrim}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.lg}"
    padding: 48px
  studios-tile:
    backgroundColor: "{colors.canvas-warm}"
    textColor: "{colors.ink}"
    typography: "{typography.body-tight}"
    rounded: "{rounded.md}"
    padding: 16px
  studios-tag:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.slate}"
    typography: "{typography.micro-caps}"
    rounded: "{rounded.full}"
    padding: 6px
  form-field:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: 12px
  form-field-focused:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: 12px
  alert-banner:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-tight}"
    rounded: "{rounded.lg}"
    padding: 16px
  footer:
    backgroundColor: "{colors.footer}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body}"
    padding: 64px
  footer-link:
    backgroundColor: "{colors.footer}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body}"
  footer-eyebrow:
    backgroundColor: "{colors.footer}"
    textColor: "{colors.stone}"
    typography: "{typography.eyebrow}"
---

## Overview

Runwai treats its marketing site as a curatorial space — closer in feeling to the programme guide of a film festival than to a typical AI-tooling site. Photography sets the temperature: cinematic, atmospheric stills (a forest at dusk, a lone figure under an indigo night sky) anchor full-bleed hero modules in `{colors.scrim}`, while the rest of the document drops onto pure `{colors.canvas}` for unbroken reading. The colour story is restraint to the point of austerity — black ink on paper-white, with five tiers of grey carrying every nuance from caption to divider, and a single slate-blue (`{colors.slate-soft}` / `{colors.slate}`) reserved for secondary text on rare occasions.

Typography does almost all of the heavy lifting. A single proprietary sans, `abcNormal`, carries every level from 11px micro-caps to 48px editorial display, with negative letter-spacing on every heading (`-0.9px` to `-1.2px`) tightening the headline silhouette into something that reads as deliberate and quiet rather than punchy. There is no decorative ornament, no card glow, no gradient buttons — every primary action is a black solid pill (`{colors.primary}` background, `{colors.on-primary}` text, `{rounded.full}` corners), reused with absolute consistency across hero CTAs, pricing subscriptions, and form submissions.

The layout discipline is editorial: hairline dividers (`{colors.hairline}`), uppercase eyebrows (`{typography.eyebrow}`), and an 8-px spacing grid that resolves to large 64–96px section gutters. Sections cycle through a tight rhythm — dark photographic hero → white reading band → research grid on canvas → photographic full-width interlude → dark CTA strip → black footer — letting black ink and black-and-white photography do the dramatic work that other sites delegate to colour.

**Key Characteristics:**
- Cinematic dark photographic heroes (`{colors.scrim}` over editorial stills) bookending crisp `{colors.canvas}` reading bands
- A single proprietary sans (`abcNormal`) covering every typographic role, with tight negative tracking on display sizes
- Black-only primary action language: every CTA is `{button-primary}` (`{colors.primary}` pill with `{rounded.full}` corners and 14px/600 button text)
- Five-tier neutral ladder (`{colors.ink}` → `{colors.graphite}` → `{colors.slate}` → `{colors.stone}` → `{colors.hairline}`) carries the entire UI without accent colour
- 5-column pricing grid where the featured tier is signalled by a `{colors.hairline}` infill rather than a coloured border
- Hairline dividers and uppercase `{typography.eyebrow}` lock-ups give marketing sections an editorial, exhibition-catalogue cadence
- Photography is treated as content, not decoration — full-bleed, cinematic, and tonal rather than vivid

## Colors

### Brand & Accent
- **Black** (`{colors.primary}`): The single brand action colour. Every primary CTA, every pricing-tier subscription button, every form submit pill resolves to this exact black. Used as the footer canvas as well, which extends the brand voice through the bottom of every page.
- **Paper White** (`{colors.on-primary}`): Type colour on `{colors.primary}` surfaces; canvas of every reading section.

### Surface
- **Canvas** (`{colors.canvas}`): Primary reading-page background.
- **Canvas Warm** (`{colors.canvas-warm}`): Near-imperceptible off-white used to lift studios-page tiles a half-tone above pure white without losing the paper feel.
- **Featured Surface** (`{colors.hairline}`): The infill behind the featured pricing tier ("Pro") and behind certain table-style banners — chosen for its near-zero saturation so it reads as a tonal step rather than a fill.
- **Hairline Soft** (`{colors.hairline-soft}`): 1-pixel column dividers in the pricing grid and table separators.
- **Cool Surface** (`{colors.surface-cool}`): Default placeholder fill for media thumbnails and image-loading frames before the asset paints.
- **Scrim** (`{colors.scrim}`): The atmospheric dark layer that cinematic hero photography is laid into; behaves as the "stage" colour for full-bleed image modules.
- **Footer** (`{colors.footer}`): Near-pure black footer canvas, one notch warmer than `{colors.primary}` so it sits visually distinct when the two stack.

### Text
- **Ink** (`{colors.ink}`): Primary heading and body text on `{colors.canvas}`; closest the system gets to absolute black for type.
- **Ink Soft** (`{colors.ink-soft}`): Nav links, secondary headings, body emphasis — one click softer than ink.
- **Graphite** (`{colors.graphite}`): Standard body copy across marketing sections, balancing readability with calm.
- **Slate** (`{colors.slate}`) / **Slate Soft** (`{colors.slate-soft}`): The system's only tinted neutrals — barely-blue greys reserved for tertiary metadata, footer-section headings on dark, and small-caps labels.
- **Mute** (`{colors.mute}`): Lighter neutral for inline disabled or fine-print copy.
- **Stone** (`{colors.stone}`): Footer eyebrow caps and field placeholders.
- **Ash** (`{colors.ash}`): The lightest readable neutral — captions on tiles, pricing fine-print.

### Semantic
The system does not introduce signal colours (red, green, yellow). Validation states in forms rely on borders and copy rather than colour shifts. Where the contact form indicates a required field, the only visual cue is an asterisk in `{colors.ink}` paired with helper text in `{colors.graphite}`.

## Typography

### Font Family
The entire system runs on a single proprietary sans, **abcNormal**, with `abcNormal Fallback` declared as the substitute. It is a humanist neo-grotesque in the lineage of ABC Diatype — uniform stroke contrast, flat terminals, slightly compressed counters, and a confident lowercase that suits Runwai's all-lowercase wordmark. The face is used at every level; there is no second display font, no monospace, no italic specimen across marketing pages.

### Hierarchy

| Token | Size | Weight | Line Height | Letter Spacing | Use |
|---|---|---|---|---|---|
| `{typography.display}` | 48px | 400 | 1.0 | -1.2px | Page-level editorial display ("Runwai Pricing", "Looking to get in touch?") |
| `{typography.display-sm}` | 40px | 400 | 1.0 | -1px | Pricing tier amount, hero secondary headlines |
| `{typography.heading-md}` | 36px | 400 | 1.0 | -0.9px | Section headlines ("Our latest Research and Products"), tier names |
| `{typography.heading-sm}` | 24px | 400 | 1.0 | 0 | Card titles, sub-section heads, link text in featured cards |
| `{typography.subtitle}` | 20px | 400 | 1.0 | 0 | Hero sub-copy and lead paragraphs |
| `{typography.body}` | 16px | 400 | 1.5 | 0 | Default body copy, form fields, footer link list |
| `{typography.body-strong}` | 16px | 600 | 1.5 | 0 | Inline emphasis, "Get Started"-class label text |
| `{typography.body-tight}` | 16px | 400 | 1.3 | -0.16px | Tight-leading body for marketing cards and CTA cards |
| `{typography.link-sm}` | 14px | 600 | 1.43 | 0 | Nav links, button labels, "Learn More" text links |
| `{typography.eyebrow}` | 14px | 500 | 1.43 | 0.35px | Uppercase eyebrows above section headings |
| `{typography.meta}` | 13px | 400 | 1.3 | -0.26px | Tertiary metadata (dates, fine print, table footnotes) |
| `{typography.micro-caps}` | 11px | 450 | 1.3 | 0.2px | Footer column headings, small-caps tags ("PRESS", "RESOURCES") |
| `{typography.button}` | 14px | 600 | 1.43 | 0 | Every button label across the system |

### Principles
- **One face, every level.** Hierarchy is articulated through size, weight, and tracking — never through a contrasting display family. The result is a uniform editorial cadence that reads as confident rather than expressive.
- **Negative tracking on display, neutral tracking on body.** Headings 24–48px sit at -0.9 to -1.2px to tighten silhouettes; body copy stays at 0 for legibility.
- **Tight leading on display, generous leading on body.** Display sizes lock to `line-height: 1.0`; body relaxes to `1.5`. The contrast gives sections a clear "headline-then-paragraph" rhythm.
- **Uppercase reserved for two roles.** `{typography.eyebrow}` for section labels, `{typography.micro-caps}` for footer columns and small tags. Body copy is never set in uppercase.

### Note on Font Substitutes
If `abcNormal` is unavailable, the closest open-source substitutes are **ABC Diatype** (commercial) or **Inter** at -0.02em tracking on display sizes. When using Inter, lift display sizes by ~1px and pull `letter-spacing` slightly tighter (-1.4px at 48px) to recover the compressed silhouette of the original.

## Layout

### Spacing System
- **Base unit**: 8px (with 4px and 6px micro-steps for inline element gaps).
- **Tokens (front matter)**: `{spacing.xxs}` 4px · `{spacing.xs}` 8px · `{spacing.sm}` 12px · `{spacing.md}` 16px · `{spacing.lg}` 24px · `{spacing.xl}` 32px · `{spacing.xxl}` 48px · `{spacing.section}` 64px · `{spacing.section-lg}` 96px.
- Card internal padding sits at `{spacing.lg}` (24px). Section vertical rhythm alternates between `{spacing.section}` (64px) for tight reading bands and `{spacing.section-lg}` (96px) for editorial breaks between major modules. Inline button padding is `{spacing.sm}` vertical / `{spacing.lg}` horizontal.

### Grid & Container
- Marketing pages render inside a centred container that caps near 1280px on widescreen breakpoints; the document maintains generous left/right gutters (~`{spacing.xxl}`) at every breakpoint above 1024px.
- The pricing surface is a 5-column equal-width grid (Free / Standard / Pro / Unlimited / Enterprise) on widescreen; each column is a vertical strip separated by 1-pixel `{colors.hairline-soft}` rules rather than gaps.
- Research/products listings use a 12-column underlying grid where each row presents a 5/7 split: media thumbnail on the left (5 columns), aligned text block on the right (7 columns).
- Studios pages break the discipline deliberately: a dense, irregular masonry of editorial poster tiles, captioned in `{typography.body-tight}`, with no consistent column count — the page is meant to read as a programme grid.

### Whitespace Philosophy
Whitespace at Runwai is structural, not decorative. Sections are separated by 64–96px verticals; cards inside a section are separated by 16–24px gaps. There are no card shadows or coloured surfaces standing in for layout — `{colors.canvas}` carries through, and rhythm comes from line-height and section spacing alone. The studios pages are the exception; their dense poster grids feel almost cluttered by contrast, which is the point — they read like a printed catalogue.

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| Flat | No shadow, optional 1px `{colors.hairline}` divider | Default state for cards, pricing columns, research rows, footer surfaces |
| Photographic | Full-bleed image laid into `{colors.scrim}`, no border, `{rounded.lg}` corners on contained variants | Hero modules, "We are building foundational simulation World Models" interlude, mid-page CTA panels |
| Subtle Surface Lift | `{colors.hairline}` infill behind a card on a `{colors.canvas}` page | The featured pricing tier ("Pro") — the only "elevation" cue in the entire pricing module |

The system avoids drop shadows entirely. Depth is created by photographic layering and tonal surface shifts, never by blurred shadows. This is a deliberate aesthetic choice — Runwai communicates polish through editorial restraint, not material affordance.

### Decorative Depth
- **Cinematic photography as backdrop.** The hero on the homepage uses an indigo night-sky photograph; the mid-page interlude uses a fog-and-trees forest scene rendered into `{colors.scrim}`. Both function as atmospheric surfaces that the next white reading band breaks against, creating a perceived "stage" depth without any CSS effect.
- **Tonal surface stepping.** Pricing's featured-tier infill (`{colors.hairline}` against `{colors.canvas}`) is the system's quietest possible "this one is special" cue — perceptible, never loud.

## Shapes

### Border Radius Scale

| Token | Value | Use |
|---|---|---|
| `{rounded.none}` | 0px | Pricing-grid cells, table rows, form fields, footer link blocks |
| `{rounded.xs}` | 4px | Small inline accents, focus rings, secondary link chips |
| `{rounded.sm}` | 6px | Tag chips, secondary link buttons |
| `{rounded.md}` | 8px | Research-card thumbnails, studios poster tiles, media containers |
| `{rounded.lg}` | 16px | Alert banners, hero-photograph containers, full-bleed CTA panels |
| `{rounded.full}` | 9999px | Every primary button (CTA pills), studios tag pills |

### Photography Geometry
- **Hero stills** are full-bleed, no rounding — they extend to the page edges to feel cinematic rather than card-like.
- **Contained hero panels** (mid-page interludes) take `{rounded.lg}` corners, signalling "module" rather than "page".
- **Research thumbnails** are 16:9 with `{rounded.md}` corners and a `{colors.surface-cool}` placeholder fill.
- **Studios poster tiles** vary in aspect ratio (square, 4:5, landscape) and use `{rounded.md}` corners; the deliberate aspect-ratio inconsistency is what gives the studios grid its programme-catalogue feel.
- **Avatar/logo lockups** in the partner row are rendered without rounding, in flat black wordmarks on `{colors.canvas}`, evenly spaced.

## Components

### Buttons

**`button-primary`** — every primary CTA across the marketing surface ("Try Runwai", "Get Started", "Subscribe Now", "Send Message", "Learn More" filled variant)
- Background `{colors.primary}`, text `{colors.on-primary}`, type `{typography.button}`, padding `{spacing.sm}` × `{spacing.lg}`, rounded `{rounded.full}`, height 40px.
- The system uses the same pill at every scale; no large/small distinction.

**`button-primary-on-dark`** — the inverse used when the surface itself is `{colors.scrim}` (dark hero CTAs)
- Background `{colors.on-primary}`, text `{colors.primary}`, otherwise identical token set to `{button-primary}`.

**`button-ghost`** — secondary actions on light surfaces ("Schedule a Demo", "Sign Up" on the Free tier)
- Background `{colors.canvas}`, text `{colors.ink}`, type `{typography.button}`, rounded `{rounded.full}`, with a 1px `{colors.ink}` border.

**`button-text-link`** — inline secondary actions, table-row "Subscribe Now" labels, and "View More" links
- Background `{colors.canvas}`, text `{colors.ink}`, underline-on-active, type `{typography.link-sm}`.

### Navigation

**`nav-bar`** — the persistent top bar
- Background `{colors.canvas}`, height ~64px, padding `{spacing.lg}` horizontal, `{typography.link-sm}` for menu items.
- Layout: lowercase `runwai` wordmark left → centred 5-item primary menu (Research, Product, Resources, Solutions, Company) → right cluster (`Enterprise Sales` text link, `Log In` text link, `Try Runwai` `{button-primary}` pill).
- The bar sits flush against the document top and is divided from the page only by spacing, not by a hairline.

**`nav-link`** — top-bar menu items
- Background `{colors.canvas}`, text `{colors.ink-soft}`, type `{typography.link-sm}`, padding `{spacing.xs}` vertical.

### Cards & Containers

**`pricing-card`** — every standard tier (Free, Standard, Unlimited, Enterprise)
- Background `{colors.canvas}`, text `{colors.ink}`, padding `{spacing.lg}`, no rounding, separated from neighbouring tiers by 1px `{colors.hairline-soft}` column rules.
- Internal stack: tier name (`{typography.heading-md}`) → one-line description (`{typography.body}` in `{colors.graphite}`) → amount (`{typography.display-sm}`) → unit caption (`{typography.meta}` in `{colors.stone}`) → action button (`{button-primary}` for paid tiers, `{button-ghost}` for Free) → feature list (`{typography.body}` bullets).

**`pricing-card-featured`** — the "Pro" tier
- Identical structure to `{pricing-card}` but the column infill is `{colors.hairline}` instead of `{colors.canvas}`. No coloured border, no badge, no shadow — just the surface-step.

**`pricing-tier-name`** — header line of each pricing column
- Background `{colors.canvas}`, text `{colors.ink}`, type `{typography.heading-md}` set in title-case ("Free", "Standard", "Pro").

**`pricing-amount`** — large monetary display in each pricing card
- Background `{colors.canvas}`, text `{colors.ink}`, type `{typography.display}` paired with a `{typography.meta}` "per user/month" caption beside it.

**`research-card`** — each row of "Our latest Research and Products"
- Layout: `{media-thumbnail}` left (16:9) + text block right.
- Right block: title (`{typography.heading-sm}`) → description (`{typography.body}` in `{colors.graphite}`) → footer link (`{typography.link-sm}`, underlined on active).

**`studios-tile`** — poster cards on the studios index
- Background `{colors.canvas-warm}`, image fills the tile, optional caption strip below in `{typography.body-tight}` (`{colors.graphite}`).
- Tiles are deliberately heterogeneous in aspect ratio.

**`studios-tag`** — small-caps category pills on studios cards
- Background `{colors.canvas}`, text `{colors.slate}`, type `{typography.micro-caps}`, padding `{spacing.xxs}` × `{spacing.sm}`, rounded `{rounded.full}`.

**`hero-photo`** — full-bleed cinematic hero blocks
- `{colors.scrim}` background carrying a photographic still, padding `{spacing.xxl}`, rounded `{rounded.lg}` on contained variants and `{rounded.none}` on edge-to-edge variants.
- Internal stack: optional eyebrow (`{typography.eyebrow}` in `{colors.on-primary}` at 70% opacity) → display headline (`{typography.display}` in `{colors.on-primary}`) → optional sub-copy (`{typography.subtitle}` in `{colors.on-primary}`) → `{button-primary-on-dark}` CTA.

**`media-thumbnail`** — image placeholder
- Background `{colors.surface-cool}`, rounded `{rounded.md}`, ratio 16:9 by default, image lazy-loads on top.

### Inputs & Forms

**`form-field`** — every contact-form input (select, text, textarea)
- Background `{colors.canvas}`, text `{colors.ink}`, label above field in `{typography.body}` `{colors.ink}`, helper text in `{typography.meta}` `{colors.stone}`.
- The field itself is a 1px bottom rule in `{colors.hairline-soft}` (no full-border box) — placeholder ("Type your full name") sits in `{colors.stone}`.
- Padding `{spacing.sm}` vertical, no rounding.

**`form-field-focused`** — focused state
- Bottom rule deepens to `{colors.ink}`. No glow, no colour shift on the field background.

**`alert-banner`** — privacy/cookie disclosure copy
- Background `{colors.canvas}`, text `{colors.ink}`, `{typography.body-tight}`, padding `{spacing.md}`, rounded `{rounded.lg}`, 1px `{colors.hairline-soft}` border.

### Footer

**`footer`** — the system's terminal surface
- Background `{colors.footer}`, text `{colors.on-primary}`, padding `{spacing.section}` vertical, `{spacing.lg}` horizontal.
- Layout: 6-column link grid → bottom strip with the lowercase `runwai` wordmark left and legal/copyright links right.

**`footer-eyebrow`** — small-caps column headings ("Product", "Initiatives", "Company")
- Background `{colors.footer}`, text `{colors.stone}`, type `{typography.eyebrow}`.

**`footer-link`** — link-list items
- Background `{colors.footer}`, text `{colors.on-primary}`, type `{typography.body}`.

### Signature Components

**Pricing 5-Column Slab** — Runwai's pricing module is unusually flat: a 5-tier slab with no coloured borders, no shadow, no badge ribbon. The featured tier is signalled by a single tonal step (`{colors.hairline}` infill) and a slightly heavier action button. The decision to render Free → Enterprise as one continuous slab instead of separate floating cards is the page's central design move.

**Editorial Eyebrow + Display Lockup** — Across the site, headline modules follow a fixed three-part rhythm: uppercase `{typography.eyebrow}` label → 36–48px `{typography.display}` headline → `{typography.body}` lead paragraph. Section spacing locks to `{spacing.section}` between modules. The lockup is what gives marketing pages their festival-programme cadence.

**Cinematic Atmospheric Interlude** — Mid-document interludes (the "We are building foundational simulation World Models" forest scene, the "We are building AI to simulate the world…" closing strip) use a contained `{hero-photo}` panel with `{rounded.lg}` corners. They function as pacing breaks between research grids and CTA bands rather than promotional units.

## Do's and Don'ts

### Do
- Reserve `{colors.primary}` for primary actions and the footer; use `{button-primary}` for every primary CTA without varying corner radius or fill.
- Stack uppercase `{typography.eyebrow}` over `{typography.display}` for every major section opener — it is the system's signature lockup.
- Use `{colors.hairline}` infill — never a coloured border — when one item in a comparison must read as featured.
- Set body copy in `{colors.graphite}` against `{colors.canvas}` for paragraphs, and reserve `{colors.ink}` for headings and emphasis only.
- Treat photography as content: full-bleed, cinematic, aligned to the page edge in heroes; `{rounded.lg}` only when the photo is contained inside a section.
- Lock display headings to negative letter-spacing (`-0.9px` to `-1.2px`) — the tight tracking is core to the brand voice.
- Use `{rounded.full}` pills for buttons and `{rounded.none}` for table/grid cells. Never mix.

### Don't
- Don't introduce accent colours (blue, green, red) into marketing surfaces — Runwai's voice is monochrome plus photography.
- Don't apply drop shadows or glows to cards. Depth is photographic and tonal, not material.
- Don't badge the featured pricing tier with a coloured ribbon or border — the surface step is the badge.
- Don't break headings into bold + light contrast; every heading is regular weight (`400`) with tight tracking.
- Don't centre body paragraphs longer than one sentence — the system uses left-aligned reading bands almost exclusively.
- Don't use uppercase for body or button copy. Uppercase is reserved for `{typography.eyebrow}` (14px) and `{typography.micro-caps}` (11px).
- Don't render the runwai wordmark in title-case or with a brand colour. It is always lowercase, in `{colors.ink}` on light surfaces and `{colors.on-primary}` on dark.

## Responsive Behavior

### Breakpoints

| Name | Width | Key Changes |
|---|---|---|
| 2xl | 1600px | Full editorial container; pricing 5-up; research rows 5/7 split |
| xl | 1536px | Same layout, marginally tighter gutters |
| lg | 1280px | Default desktop reading view |
| md | 1200px | Pricing grid still 5-up but tier text tightens |
| sm | 1024px | Pricing collapses to 3 → 2 tier rows; research rows stack at certain breakpoints |
| xs | 768px | Top nav collapses to a hamburger; section padding drops to `{spacing.section}` |
| xxs | 640px | Single-column reading; hero display drops to `{typography.display-sm}`; pricing tiers stack 1-up |

### Touch Targets
- Every `{button-primary}` is 40px tall — at the lower edge of the 44×44 WCAG target. On mobile the buttons grow to 48px height (still `{rounded.full}`, still `{typography.button}`).
- `{nav-link}` items get `{spacing.sm}` vertical padding inside the mobile menu, expanding the tap target without changing typography.
- Pricing-tier `{button-primary}` extends full-column-width on mobile.

### Collapsing Strategy
- **Nav.** Centred desktop menu collapses into a single hamburger that opens an overlay sheet; the right-side `{button-primary}` "Try Runwai" stays visible above the hamburger as the persistent action.
- **Pricing.** 5-column slab collapses to single-column stacked cards at xxs; the featured `{colors.hairline}` infill is preserved on the Pro card so the tonal cue survives the stack.
- **Research grid.** 5/7 split collapses to image-on-top, text-below at sm; thumbnail rounding (`{rounded.md}`) is preserved.
- **Footer.** 6-column link grid collapses to 2-column at sm and 1-column at xxs; the lowercase `runwai` wordmark stays bottom-left, legal links stack underneath.

### Image Behavior
- Hero photographs swap to a tighter crop on mobile (vertical-leaning) so the focal subject stays centred at xxs widths.
- `{media-thumbnail}` containers preserve their 16:9 ratio at every breakpoint; the `{colors.surface-cool}` placeholder fill paints during lazy-load.
- Studios poster tiles preserve their original aspect ratios at every breakpoint — the masonry simply re-flows into fewer columns.

## Iteration Guide

1. Focus on ONE component at a time. Start with `{button-primary}` and `{nav-bar}` — they appear on every page and anchor the system.
2. Reference component names and tokens directly (`{colors.ink}`, `{button-primary-on-dark}`, `{rounded.full}`) — do not paraphrase or substitute hex values.
3. Run `npx @google/design.md lint DESIGN.md` after edits — `broken-ref`, `contrast-ratio`, and `orphaned-tokens` warnings flag drift automatically.
4. Add new variants as separate `components:` entries (`-pressed`, `-disabled`, `-focused`) — never bury them inside prose.
5. Default body copy to `{typography.body}` and emphasis to `{typography.body-strong}`. Reserve `{typography.eyebrow}` and `{typography.micro-caps}` for their two specific roles (section openers and footer columns).
6. Keep `{colors.primary}` scarce — if more than one black-pill action appears in a single viewport, neutralise the secondary one to `{button-ghost}`.
7. When introducing photography, lay it into `{colors.scrim}` and let the next white band break against it. Avoid mid-section photographic accents that don't span the full content width — they read as off-system.
