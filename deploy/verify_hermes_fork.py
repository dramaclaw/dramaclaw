"""Fail the image build unless the installed Hermes is the fork we need.

`hermes --version` is not enough. The fork keeps the upstream version string —
it is a fork, not a release — so a stock PyPI install and ours print the same
line. An image built with the default install spec would therefore look correct
and then, at runtime, drop every `_meta` extension it is handed: no per-turn
credential, no capability, no evidence. The turn still answers, so nothing
downstream complains.

Checked by capability rather than by version or by commit hash. A hash would
have to be updated in lockstep with every fork commit and would fail the build
for changes that do not matter; what the image actually depends on is that these
functions exist and behave.
"""
from __future__ import annotations

import inspect
import sys

REQUIRED = [
    ("acp_adapter.server", "_recover_turn_meta",
     "the ACP router splats _meta into kwargs; without this recovery every "
     "per-turn credential and capability is silently dropped"),
    ("agent.gateway_credential", "apply_to_headers",
     "per-turn credentials cannot be applied without it"),
    ("agent.gateway_credential", "refuse_foreign_endpoint",
     "a per-turn worker would be free to reach any host"),
    ("agent.control_capability", "attach_to_headers",
     "no capability would ever reach the gateway"),
]


def main() -> int:
    failures: list[str] = []
    for module_name, attribute, why in REQUIRED:
        try:
            module = __import__(module_name, fromlist=[attribute])
        except ImportError as error:
            failures.append(f"{module_name} is not importable: {error}")
            continue
        if not hasattr(module, attribute):
            failures.append(f"{module_name}.{attribute} is missing — {why}")

    # Behaviour, not just presence: a stub with the right name would pass the
    # check above and fail in production exactly as the stock build does.
    if not failures:
        from acp_adapter.server import _recover_turn_meta

        recovered = _recover_turn_meta({"session_id": "s", "dramaclaw.probe": "v"})
        if recovered != {"dramaclaw.probe": "v"}:
            failures.append(
                "_recover_turn_meta does not recover splatted _meta keys; "
                f"got {recovered!r}")

        from agent.gateway_credential import per_turn_credential_required
        if not callable(per_turn_credential_required):
            failures.append("per_turn_credential_required is not callable")

    if failures:
        print("This image does not contain the DramaClaw Hermes fork:", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        print("\nBuild with --build-arg HERMES_INSTALL_SPEC pointing at the fork.",
              file=sys.stderr)
        return 1

    source = inspect.getsourcefile(__import__("acp_adapter.server", fromlist=["x"]))
    print(f"hermes fork verified ({source})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
