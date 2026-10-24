"""Wake the director panel after a saved production fact changes its projection.

Material acceptance can advance a work package without publishing a new
conversation card, so card publication alone cannot tell a browser that
``/production-state`` changed. Every host writer and the automatic observer use
this one broadcast.
"""
from __future__ import annotations


async def broadcast_director_update(ctx, *, canvas_id: str, agent_ids, canvas_changed: bool = False) -> None:
    from novelvideo.chat.live_events import broadcast_chat_scope_event
    from novelvideo.chat.store import ChatScope

    if not getattr(ctx, 'requester_username', None):
        return
    for agent_id in sorted({agent_id or 'main' for agent_id in agent_ids}):
        scope = ChatScope(kind='project', id=ctx.project_id, surface='freezone',
                          canvas_id=canvas_id, agent_id=agent_id)
        await broadcast_chat_scope_event(username=ctx.requester_username, scope=scope,
            payload={'type': 'reference.director.updated', 'scope': scope.to_dict(),
                     'project_id': ctx.project_id, 'canvas_id': canvas_id,
                     'agent_id': agent_id, 'canvas_changed': canvas_changed})
