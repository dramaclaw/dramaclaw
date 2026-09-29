"""Keep provider reasoning out of durable, user-visible text even across chunks."""

from __future__ import annotations


class VisibleText:
    """Some compatible gateways emit literal think tags instead of ThinkingParts."""

    def __init__(self) -> None:
        self.pending = ""
        self.thinking = False

    def feed(self, chunk: str, *, final: bool = False) -> str:
        self.pending += chunk
        output = []
        while self.pending:
            tags = ("</think>",) if self.thinking else ("<think>", "</think>")
            matches = [(self.pending.find(tag), tag) for tag in tags]
            matches = [(position, tag) for position, tag in matches if position >= 0]
            if matches:
                position, tag = min(matches)
                if not self.thinking:
                    output.append(self.pending[:position])
                self.pending = self.pending[position + len(tag):]
                self.thinking = tag == "<think>"
                continue
            keep = max(
                (size for tag in tags for size in range(1, len(tag))
                 if self.pending.endswith(tag[:size])), default=0,
            )
            # An incomplete tag at EOF is not a publishable answer fragment.
            visible = self.pending[:-keep] if keep else self.pending
            if not self.thinking:
                output.append(visible)
            self.pending = "" if final or not keep else self.pending[-keep:]
            break
        return "".join(output)
