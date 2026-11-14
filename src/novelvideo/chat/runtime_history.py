"""Parse Codex history items without chat storage or media lookup."""


def _split_trace_contents(content: str) -> list[str]:
    raw_lines = str(content or "").rstrip().splitlines()
    blocks: list[list[str]] = []
    current: list[str] = []
    for line in raw_lines:
        if not line.strip():
            if current:
                blocks.append(current)
                current = []
            continue
        current.append(line)
    if current:
        blocks.append(current)
    return ["\n".join(block) for block in blocks if block]
