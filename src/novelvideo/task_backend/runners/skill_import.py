"""Background native Skill conversion; independent from chat agent lifetime."""
from pathlib import Path
import asyncio

from novelvideo.freezone.skill_import import convert_record, get_record, save_record
from novelvideo.task_backend.registry import register_project_task_runner
from novelvideo.task_backend.runners.freezone import _run_cancellable, _call_freezone_leaf, _update


def run_skill_import(envelope, ctx):
    payload = envelope.get('payload') or {}
    import_id = str(payload['import_id'])
    username = str(payload['username'])
    if username != ctx.requester_username:
        raise ValueError('Import requester mismatch')
    root = Path(ctx.state_dir)

    async def run():
        from novelvideo.config import get_effective_newapi_text_model_name
        record = get_record(root, username, import_id)
        record['model_route'] = get_effective_newapi_text_model_name('FREEZONE_TEXT_WRITER_MODEL')
        save_record(root, username, record)
        from novelvideo.freezone.text_node import generate_freezone_text
        async def generate(prompt):
            _, text = await asyncio.wait_for(_call_freezone_leaf(
                envelope, generate_freezone_text, 'generate_freezone_text', prompt=prompt), timeout=180)
            return text
        return await convert_record(root, username, import_id, generate,
                                    lambda progress, stage: _update(ctx, 'freezone_skill_import', import_id, progress, stage))
    try:
        result = _run_cancellable(envelope, run())
        return {'ok': True, 'import_id': import_id, 'status': result['status']}
    except BaseException as exc:
        record = get_record(root, username, import_id)
        record.update(status='failed', error=f'{type(exc).__name__}: {str(exc)[:500]}')
        save_record(root, username, record)
        raise


register_project_task_runner('freezone_skill_import', run_skill_import, requires_home_node=True)
