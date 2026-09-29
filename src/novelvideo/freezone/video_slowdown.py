"""Shared speed factors for video enhancement quotes and execution."""

SLOWDOWN_FACTORS = {"auto": 1, "2x": 2, "3x": 3, "4x": 4, "5x": 5}


def slowdown_factor(value: str) -> int:
    try:
        return SLOWDOWN_FACTORS[value]
    except (KeyError, TypeError) as exc:
        raise ValueError(f"unsupported slowdown: {value}") from exc
