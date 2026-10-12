# F01 direction and motion assets

## Proportions revision v2

The current build uses `directions-candidate-v2.png`, edited with the built-in image generation tool using the original F01 turnaround and M01 south sprite as references. Exact prompt: `proportions-v2-prompt.txt`. Reduced head/hair width, increased torso length and adjusted the shoulder-to-head ratio consistently across four directions. Height and foot baseline remain unchanged. Runtime now uses `frontend/public/piko/world/characters/resident-f01-idle-v1/resident-f01-motion-v2.png` to invalidate cached artwork. The original source candidate remains available. All 13 motion build checks pass; final visual comparison is in the game.

Created 2026-09-08 using the built-in image generation tool. Source candidate: `directions-candidate-v1.png`.

References: `frontend/public/piko/world/residents/resident-f01-front-transparent-v1.png` for character identity and `piko-world/art/review/resident-m01-directions-v1/south-64.png` for the existing actor proportions.

Generation brief: four separated full-body views in south, west, east, north order; preserve F01's brown hair, green floral headband, cream blouse, green skirt and brown shoes; use a neutral standing pose and chunky pixel-game proportions compatible with M01's 64px frame. Requested transparent background. The returned candidate contained a light checkerboard, removed by the build step.

Build: `.venv/bin/python scripts/build_piko_female_motion.py`.

The build normalizes direction masters to a shared 24-color palette and 64×64 frames, then uses the existing arm/leg rig with F01-specific attachment points. The atlas has four rows and eleven columns: three breathing-idle slots (first and third repeat), followed by eight walking poses. Runtime file: `frontend/public/piko/world/characters/resident-f01-idle-v1/resident-f01-motion-v1.png`.

Automated validation covers atlas dimensions, binary alpha, fixed foot baseline, distinct walking frames, connected lower limbs and palette preservation. Visual acceptance remains in the running game.
