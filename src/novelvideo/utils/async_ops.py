import asyncio
import functools
from typing import Any, Callable


async def call_blocking(func: Callable[..., Any], /, *args, **kwargs) -> Any:
    """Run a blocking callable in the default thread pool."""
    bound = functools.partial(func, *args, **kwargs)
    return await asyncio.to_thread(bound)
