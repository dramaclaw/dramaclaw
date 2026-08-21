# EE Config and CE Provisioner Isolation Design

## Context

`GET /api/v1/model-gateway/config` is a shared settings endpoint. Both editions need its effective platform gateway and media-relay status, but its `provisioner` section describes CE-only local NewAPI state: database configuration, provider channels, local media-model mappings, and embedding-model settings.

The endpoint currently calls `build_provisioner_status()` for every edition. In EE this reaches `get_model_gateway_settings()` and can open or create `STATE_DIR/local/settings.db`. That violates the edition boundary even when the filesystem is writable, and can return HTTP 500 when the EE state mount is read-only.

## Required behavior

- EE requests to `/model-gateway/config` must continue returning effective deployment gateway and media-relay status.
- EE must not call the CE provisioner builder or any CE-local settings accessor while serving that endpoint.
- The response must preserve the existing `provisioner` object contract so the shared settings frontend can render without an edition-specific API shape.
- The EE `provisioner` object must report the CE subsystem as disabled and expose empty channels, media models, and embedding settings.
- CE requests must retain the current provisioner status behavior and continue reading their local settings database.

## Design

Add an edition-aware status composition boundary in `api/routes/model_gateway.py`:

- In effective CE, call `build_provisioner_status()` unchanged.
- In EE, return a static platform-safe provisioner status with `enabled: false`, blank admin/token/relay fields, `dbConfigured: false`, `database.configured: false`, `database.available: false`, and empty provider/channel/media-model/embedding-model collections. Do not import or call CE settings readers to construct this object.

Add a defensive read boundary in `get_model_gateway_settings()`:

- In effective EE, return the normal default settings shape without calling `_read_all()`.
- In effective CE, retain the existing `_read_all()` behavior.

The route-level split is the primary fix. The low-level guard is defense against future accidental EE callers; it is not the intended EE execution path.

## Data flow

```text
GET /model-gateway/config
  ├─ EE
  │   ├─ build deployment gateway status
  │   ├─ return static disabled CE provisioner status
  │   └─ build environment-backed media-relay status
  └─ CE
      ├─ build CE gateway status
      ├─ build CE provisioner status from settings.db
      └─ build CE media-relay status
```

## Error handling

The EE path avoids CE SQLite by construction; it must not catch or hide filesystem failures. CE remains responsible for its local database, so genuine CE storage failures continue to surface normally.

## Verification

Use TDD with a regression test that configures effective EE, makes both `build_provisioner_status()` and `_connect()` fail if invoked, requests `/model-gateway/config`, and verifies:

- HTTP 200;
- environment-derived gateway and media-relay fields remain present;
- `provisioner.enabled` is false;
- CE database, provider channels, media models, and embedding model are empty/unconfigured;
- no state directory is created.

Keep a CE control test proving the same endpoint still calls the real provisioner builder and returns its result. Run the complete model-gateway settings tests and focused API regressions.

## Scope

No frontend change, database migration, deployment configuration change, or CE provisioner refactor is included. The change only separates shared EE status from CE-local provisioner state.
