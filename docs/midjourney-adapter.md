# Midjourney via RelayClaw

The image generator supports the explicit `relayclaw_midjourney` catalog adapter.
Models and credit prices are managed manually in Admin; this feature does not seed
models, aliases or prices through database migrations.

## Catalog and upstream capabilities

Declare only operations available through the configured gateway and supplier:

| Operation | Gateway route | Required inputs |
| --- | --- | --- |
| Imagine | `/mj/submit/imagine` | Prompt; optionally reference images |
| Reference upload | `/mj/submit/upload-discord-images` | JSON `base64Array` of image Data URLs |
| Blend | `/mj/submit/blend` | 2–5 image Data URLs; no prompt required |
| Edit | `/mj/submit/edits` | Source images and editing prompt |
| Upscale | `/mj/submit/action` | Original task ID and returned U1–U4 custom ID |

Reference modes are Imagine content references, style references and subject
references, plus separate Edit/Blend operations. Reference counts and catalog
`supportedOperations` constrain the UI and backend. Image Prompt, Style Reference
and Omni Reference require a working upload route. Basic Edit transport is not a
mask editor or a complete Inpaint/Modal workflow; do not advertise it as such.
Supplier availability must be verified separately from local contract tests.

Blend preserves supplier defaults: its default body contains only `base64Array`.
Explicitly configured `mode`, `dimensions` and `botType` are validated and forwarded;
the client does not force RELAX or infer Blend dimensions from Imagine controls.
Configure supplier-specific route prefixes in the gateway, not in Dramaclaw code.

## Pricing and canvas interaction

Use independent `operation=imagine|edit|blend|upscale` model price rules. Quote and
task reservation both use the operation, not an unqualified default price.

Hover a quadrant to reveal its explicit Upscale button and credit quote. Clicking
the image itself does not submit a billable action. Completed U candidates reuse
their persisted results without another supplier call. New results retain their
source task/buttons, including after refresh; old image-only records cannot be
reliably associated with upstream actions.

The top-right full-image preview opens the existing viewer without generating,
changing resolution or spending credits. Labels support Chinese, English and
Vietnamese. Real supplier generation, settlement and refunds still require
deployment-specific end-to-end validation.
