# Prompt bước portraits — dự án tesla_pov_short

Sinh bằng dry run các hàm dựng prompt (không gọi model). Style `chinese_period_drama`, ethnicity `Chinese` (mặc định của dự án, chưa chỉnh).

```text
=====PORTRAIT=====
Generate a face-only character identity reference portrait for identity locking.

CHARACTER: [Nikola Tesla_cd2d] (Nikola Tesla)

DEFAULT ETHNICITY (FALLBACK ONLY):
Default ethnicity for unspecified people: Chinese. Use this only when the character description and reference images do not specify ethnicity, nationality, or regional appearance. If the character description says Western, Persian, Japanese, mixed-race, foreign, or any other explicit origin, follow that explicit description.

FRAMING & CAMERA (CRITICAL):
- FRONT-FACING: subject facing camera DIRECTLY, looking STRAIGHT at camera, symmetrical composition
- Head-and-shoulders close-up, face fills 60-70% of the frame
- Neutral expression, mouth closed
- Solid matte gray seamless studio background — NO environment, NO scenery, NO props
- Plain simple dark top (like a basic t-shirt), MINIMAL clothing visible
- Do NOT show elaborate costumes, accessories, or period clothing
- This should follow the project visual style while remaining clear enough for identity locking.

FACIAL FEATURES TO CAPTURE (from character description):
Nikola Tesla in his late twenties, 1880s, tall and thin, high forehead, sharp cheekbones, neat dark mustache, intense bright eyes, dark hair parted to the side, period Victorian clothing, realistic cinematic portrait

VISUAL STYLE:
Create a live-action Chinese period drama image with grounded historical realism when the beat or scene context calls for a period setting. Use natural lighting appropriate to the time of day with soft realistic falloff and restrained contrast. Ensure realistic skin texture with visible pores, subtle imperfections, and no beauty-retouching. Use a natural 50mm cinematic lens feel with moderate depth of field, not glossy fashion photography. Follow the beat, scene, character, and prop descriptions for exact era, wardrobe, architecture, technology, and materials; do not override explicit modern, foreign, or traversal-story details. Keep color grading restrained and filmic, avoiding poster-like polish or painterly haze.

STRICT REQUIREMENTS:
- This is a CHARACTER IDENTITY ANCHOR — face must be perfectly front-facing and clearly visible
- High-quality, 4K resolution
- Maintain strict facial fidelity to the character description
- Keep facial structure, hairstyle, skin tone, and expression readable for downstream identity matching

MUST AVOID:
NOT anime, NOT cartoon, NOT illustration. No plastic skin or airbrushed texture. No AI artifacts or oversaturated HDR. No extra limbs, mutated hands, or deformed faces. No text, watermarks, or labels on image.
- Do NOT turn the face to any side — must be perfectly FRONTAL
- Do not include elaborate clothing or costumes
- Do not show full body or lower body
- Do NOT add ANY background: no rooms, no scenery, no furniture, no props — plain solid color only
- Do not add text, watermarks, or signatures
- Do not include multiple characters
- Do NOT create beauty-filter skin, glamor retouching, fashion-magazine polish, doll-like skin, or cosmetic-ad aesthetics
=====IDENTITY_SHEET=====
Character identity reference sheet. Neutral studio setup.
PLAIN SOLID WHITE or LIGHT GRAY background ONLY — no environment, no scenery, no props. Create a live-action Chinese period drama image with grounded historical realism when the beat or scene context calls for a period setting. Use natural lighting appropriate to the time of day with soft realistic falloff and restrained contrast. Ensure realistic skin texture with visible pores, subtle imperfections, and no beauty-retouching. Use a natural 50mm cinematic lens feel with moderate depth of field, not glossy fashion photography. Follow the beat, scene, character, and prop descriptions for exact era, wardrobe, architecture, technology, and materials; do not override explicit modern, foreign, or traversal-story details. Keep color grading restrained and filmic, avoiding poster-like polish or painterly haze.

Using the reference image as IDENTITY ANCHOR for [Nikola Tesla_cd2d] (Nikola Tesla),
create a 4-panel character reference sheet arranged LEFT to RIGHT:

- Panel 1 (LEFT): FACE CLOSEUP — head and shoulders, filling the panel. This is a zoomed-in crop of Panel 2's head: SAME hairstyle, SAME visible clothing (neckline, collar, shoulders)
- Panel 2 (CENTER-LEFT): FRONT full body — head to feet, standing pose, facing camera
- Panel 3 (CENTER-RIGHT): THREE-QUARTER VIEW full body — head to feet, body rotated approximately 45 degrees from the left, both eyes still visible, standing pose
- Panel 4 (RIGHT): BACK VIEW full body — head to feet, facing away from camera, showing back of head and body

IDENTITY LOCKING (CRITICAL):
Preserve the facial structure, facial proportions, and overall likeness
of [Nikola Tesla_cd2d] EXACTLY as in the reference image, allowing NO alteration,
stylization, or reinterpretation of the face under any circumstance.

MUST PRESERVE (from reference):
- Facial structure and bone structure
- Eye shape, size, spacing, color
- Nose shape and size
- Lip shape and fullness
- Skin tone
- Hair color, style, texture
- Preserve the reference identity exactly; do not change face structure, skin tone, hair identity, or silhouette.

DO NOT PRESERVE FROM REFERENCE:
- Beauty-filter smoothing or retouching
- Plastic / waxy / overly perfect skin treatment
- Any rendering finish that conflicts with the selected project style preset
- The final rendering medium should follow the project style preset, not the reference image

CHARACTER DETAILS (CRITICAL - use this for clothing and appearance):
<identity.appearance_details>

BACKGROUND (CRITICAL — STRICTLY ENFORCED):
- ALL 4 panels MUST have a PLAIN SOLID-COLOR background (white, light gray, or soft neutral gradient)
- Do NOT render ANY environment: no rooms, no furniture, no walls, no floors, no scenery
- This is a production character identity reference sheet, not a fashion catalog, not a glossy poster

FULL BODY FRAMING (Panels 2-4):
- MUST show COMPLETE figure from top of head to bottom of feet including shoes
- Standing in neutral pose on a visible ground line
- Ample space above head and below feet
- Do NOT crop any body part

CONSISTENCY:
- ALL 4 panels = SAME person, SAME outfit, SAME hair
- Panel 1 is a ZOOMED-IN CROP of Panel 2's head area — hairstyle, neckline, collar, and shoulder clothing MUST be identical
- Panel 1 face MUST match Panels 2-3 face exactly
- Panel 4 shows the SAME person from behind — SAME hair, SAME outfit, SAME body proportions
- Only viewing angle changes between Panel 2 (front), Panel 3 (three-quarter), and Panel 4 (back)

STRICT REQUIREMENTS (MUST AVOID):
NOT anime, NOT cartoon, NOT illustration. No plastic skin or airbrushed texture. No AI artifacts or oversaturated HDR. No extra limbs, mutated hands, or deformed faces. No text, watermarks, or labels on image.
- Do not allow ANY facial feature drift from reference.
- Do not mix styles or reinterpret the character.
- Do not include multiple characters.
- No text, labels, or panel numbers on the image
- Do NOT create beauty-retouched, glamorized, cosmetic-ad, or fashion-editorial output
- Keep the project style consistent across all 4 panels
```
