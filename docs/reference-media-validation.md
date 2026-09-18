# Optional reference media validation

Media catalog `config` accepts the following optional fields. They are validated
before enqueueing Freezone image/video generation and before feature billing.
They do not change the generation model, output parameters or prices.

| Media | Fields |
| --- | --- |
| Image | `referenceImageFormats`, `referenceImageMaxMB`, `referenceImageMinWidth`, `referenceImageMaxWidth`, `referenceImageMinHeight`, `referenceImageMaxHeight`, `referenceImageMinAspectRatio`, `referenceImageMaxAspectRatio` |
| Audio | `referenceAudioFormats`, `referenceAudioMaxMB` |
| Video | `referenceVideoFormats`, `referenceVideoMaxMB`, `referenceVideoMinFPS`, `referenceVideoMaxFPS` |

Absent/null numeric fields and absent/null/empty format lists disable the
corresponding new constraint. No provider default is inferred. Numbers must be
positive and finite; pixel dimensions must be integers. Min cannot exceed max.
MB means 1,000,000 bytes. Aspect ratio means width / height. Video frame rate is
the average stream frame rate, falling back to the nominal rate when unavailable.
Formats are container/image formats, not audio/video codecs or file extensions.
JPEG/JPG and TIFF/TIF aliases are normalized. HEIC/HEIF metadata uses the existing
ffprobe tool, as do audio/video probes; no new image decoder dependency is added.
The deployed ffprobe must support HEIF metadata for those formats to be inspected.

The previous Seedance-specific hardcoded image dimension check is replaced by
these optional catalog settings. Configure required limits explicitly before
rollout if that guard must remain active. Existing reference count and duration
configuration/compatibility rules are unchanged. No live catalog or price is
updated by this patch.

Example values for a model with the supplied Seedance 2.5 requirements (apply
only after verifying its actual provider contract):

```json
{
  "referenceImageFormats": ["jpeg", "png", "webp", "bmp", "tiff", "gif", "heic", "heif"],
  "referenceImageMaxMB": 30,
  "referenceImageMinWidth": 300,
  "referenceImageMaxWidth": 6000,
  "referenceImageMinHeight": 300,
  "referenceImageMaxHeight": 6000,
  "referenceImageMinAspectRatio": 0.4,
  "referenceImageMaxAspectRatio": 2.5,
  "referenceAudioFormats": ["wav", "mp3"],
  "referenceAudioMaxMB": 15,
  "referenceVideoFormats": ["mp4", "mov"],
  "referenceVideoMaxMB": 200,
  "referenceVideoMinFPS": 24,
  "referenceVideoMaxFPS": 60
}
```

Configured limits are checked against resolved local files. The validator does
not add URL downloading or trust browser-reported metadata. Unreadable media,
unknown required metadata, and uninspectable remote media fail explicitly when
a relevant new limit is configured. ffprobe subprocesses have a timeout and a
local-only protocol allowlist. Repeated references share probe results within a
request, but each submitted reference retains its own ordinal.

HTTP 400 responses use `detail.code = REFERENCE_MEDIA_INVALID` and `detail.errors`
with `media`, `index` (1-based within media type), `role`, `name`, `reference_key`
(project-relative only), `code`, `actual`, and `expected`. No absolute path or
signed URL is returned. Clients keep a submit-time snapshot to map this identity
back to canvas nodes. The dialog lists every new-constraint violation discovered
in this pass; existing quantity/duration validation can still reject earlier.
Locate is offered only for an unambiguous node match. The list can be reopened
until the next submission, but is not persisted across a page reload.

Deploy backend support before the Admin form and canvas client. The paired Admin
PR only edits catalog metadata; EE uses the existing shared schema and JSON
storage and requires no new table or pricing migration. Check both light and
dark themes and a real configured-model submission before production rollout.
