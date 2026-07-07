"""NovelVideo CLI (Cognee-only)."""

import asyncio
import json
import os
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn

from novelvideo.backup.cli import backup_app
from novelvideo.cognee import CogneeStore
from novelvideo.config import ensure_project_dirs
from novelvideo.workflows.script_writing import create_script_writing_workflow
from novelvideo.generators import (
    SceneAsset,
    create_image_generator,
    create_tts_generator,
    create_video_composer,
)
from novelvideo.generators.video_composer import normalize_video_title

app = typer.Typer(name="novelvideo", help="小说解说视频自动生成系统（Cognee 版）")
app.add_typer(backup_app, name="backup")
console = Console()

# nest_asyncio 延迟应用标记
_nest_asyncio_applied = False


def _ensure_nest_asyncio():
    """确保 nest_asyncio 已应用（仅对非 UI 命令）。"""
    global _nest_asyncio_applied
    if not _nest_asyncio_applied:
        import nest_asyncio

        nest_asyncio.apply()
        _nest_asyncio_applied = True


async def _resolve_scene_migration_dirs(
    *,
    project_id: str,
    user: str,
    project: str,
    state_dir: str,
    output_dir: str,
) -> tuple[Path, Path, str]:
    if project_id:
        from novelvideo.ports.registry import ensure_bootstrap
        from novelvideo.ports import get_project_registry

        ensure_bootstrap()
        record = await get_project_registry().get_project(project_id)
        if record is None:
            raise typer.BadParameter(f"project-id not found: {project_id}")
        return (
            Path(record.state_dir),
            Path(record.output_dir),
            f"{record.owner_username}/{record.name} ({record.id})",
        )

    if state_dir:
        db_dir = Path(state_dir)
        asset_dir = Path(output_dir) if output_dir else db_dir
        return db_dir, asset_dir, str(db_dir)

    if not user or not project:
        raise typer.BadParameter(
            "provide either --project-id, --state-dir, or both --user and --project"
        )

    from novelvideo.config import OUTPUT_DIR, STATE_DIR

    return (
        Path(STATE_DIR) / user / project,
        Path(output_dir) if output_dir else Path(OUTPUT_DIR) / user / project,
        f"{user}/{project}",
    )


def _print_scene_migration_report(report) -> None:
    data = report.model_dump()
    console.print(
        json.dumps(
            {
                "dry_run": data["dry_run"],
                "backup_path": data["backup_path"],
                "scene_renames": len(data["scene_renames"]),
                "scene_merges": len(data["scene_merges"]),
                "beat_updates": len(data["beat_updates"]),
                "asset_copies": len(data["asset_copies"]),
                "copied_assets": len(data["copied_assets"]),
                "skipped_asset_copies": len(data["skipped_asset_copies"]),
                "failed_asset_copies": len(data["failed_asset_copies"]),
                "field_conflicts": len(data["field_conflicts"]),
                "warnings": data["warnings"],
                "renames": data["scene_renames"],
                "merges": data["scene_merges"],
                "beat_updates_sample": data["beat_updates"][:30],
                "asset_copies_sample": data["asset_copies"][:30],
                "skipped_asset_copies_detail": data["skipped_asset_copies"],
                "failed_asset_copies_detail": data["failed_asset_copies"],
                "field_conflicts_sample": data["field_conflicts"][:30],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


@app.command()
def import_novel(
    novel: str = typer.Option(..., "--novel", "-n", help="小说文件路径"),
    project: str = typer.Option(..., "--project", "-p", help="项目名称"),
):
    """导入小说到 Cognee 图谱。"""
    _ensure_nest_asyncio()
    console.print(f"[bold blue]导入小说[/bold blue]: {novel}")
    console.print(f"[bold blue]项目名称[/bold blue]: {project}")

    if not os.path.exists(novel):
        console.print(f"[red]错误: 文件不存在 {novel}[/red]")
        raise typer.Exit(1)

    ensure_project_dirs(project)

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        console=console,
    ) as progress:
        task = progress.add_task("导入小说并构建索引...", total=None)

        async def do_import():
            store = CogneeStore(project)
            try:
                await store.initialize()
                return await store.ingest_novel(novel)
            finally:
                await store.close()

        try:
            result = asyncio.run(do_import())
            progress.update(task, description="[green]导入完成![/green]")
        except Exception as e:
            console.print(f"[red]导入失败: {e}[/red]")
            raise typer.Exit(1)

    console.print("[bold green]✓ 小说导入成功！[/bold green]")
    console.print(f"  字符数: {result['char_count']}")
    console.print(f"  角色数: {result.get('characters', 0)}")
    console.print(f"  剧集数: {result.get('episodes', 0)}")
    console.print(f"  数据集: {result['dataset']}")
    console.print(f"\n[dim]下一步: novelvideo cognee-profile -p {project}[/dim]")


@app.command()
def cognee_ingest(
    project: str = typer.Option(..., "--project", "-p", help="项目名称"),
    novel: str = typer.Option(..., "--novel", "-n", help="小说文件路径"),
    rebuild: bool = typer.Option(False, "--rebuild", help="重建图谱（清除旧数据）"),
    episodes: int = typer.Option(10, "--episodes", "-e", help="目标剧集数"),
):
    """使用 Cognee 导入小说（一次性完成：原文 + 角色 + 剧集）。"""
    _ensure_nest_asyncio()
    console.print(f"[bold blue]Cognee 统一导入[/bold blue]: {novel} → {project}")

    async def do_ingest():
        store = CogneeStore(project)
        try:
            await store.initialize()
            return await store.ingest_novel(
                novel,
                rebuild=rebuild,
                target_episodes=episodes,
            )
        finally:
            await store.close()

    try:
        result = asyncio.run(do_ingest())
    except Exception as e:
        console.print(f"[red]❌ 导入失败: {e}[/red]")
        raise typer.Exit(1)

    console.print("\n[green]✅ 导入完成[/green]")
    console.print(f"  字符数: {result['char_count']}")
    console.print(f"  角色数: {result.get('characters', 0)}")
    console.print(f"  剧集数: {result.get('episodes', 0)}")
    console.print(f"  数据集: {result['dataset']}")
    console.print(f"\n[dim]下一步: novelvideo cognee-profile -p {project}[/dim]")


@app.command()
def cognee_profile(
    project: str = typer.Option(..., "--project", "-p", help="项目名称"),
):
    """查看图谱中的角色（从图谱查询，无需指定小说）。"""
    _ensure_nest_asyncio()
    console.print(f"[bold blue]Cognee 角色管理[/bold blue]: {project}")

    async def do_profile():
        store = CogneeStore(project)
        await store.initialize()
        # 从图谱查询角色
        return await store.list_characters()

    try:
        characters = asyncio.run(do_profile())
    except Exception as e:
        console.print(f"[red]❌ 加载角色失败: {e}[/red]")
        raise typer.Exit(1)

    if not characters:
        console.print("[yellow]⚠️ 图谱中没有角色数据，请先运行 cognee-ingest[/yellow]")
        raise typer.Exit(1)

    console.print(f"[cyan]图谱中有 {len(characters)} 个角色[/cyan]")
    console.print(f"[green]✅ 提取 {len(characters)} 个角色（未过滤）[/green]")


@app.command()
def cognee_plan(
    project: str = typer.Option(..., "--project", "-p", help="项目名称"),
):
    """查看图谱中的剧集规划（从图谱查询，无需指定小说）。"""
    _ensure_nest_asyncio()
    console.print(f"[bold blue]Cognee 剧集规划[/bold blue]: {project}")

    async def do_plan():
        store = CogneeStore(project)
        await store.initialize()
        # 从图谱查询剧集
        episodes = await store.list_episodes()
        return store, episodes

    try:
        store, episodes = asyncio.run(do_plan())
    except Exception as e:
        console.print(f"[red]❌ 加载剧集失败: {e}[/red]")
        raise typer.Exit(1)

    if not episodes:
        console.print("[yellow]⚠️ 图谱中没有剧集数据，请先运行 cognee-ingest[/yellow]")
        raise typer.Exit(1)

    console.print(f"[green]共 {len(episodes)} 集[/green]\n")

    for ep in sorted(episodes, key=lambda e: e.number):
        console.print(f"[bold]第 {ep.number} 集: {ep.title}[/bold]")
        console.print(
            f"  摘要: {ep.content_summary[:60]}..."
            if len(ep.content_summary) > 60
            else f"  摘要: {ep.content_summary}"
        )
        if ep.cliffhanger:
            console.print(
                f"  悬念: {ep.cliffhanger[:40]}..."
                if len(ep.cliffhanger) > 40
                else f"  悬念: {ep.cliffhanger}"
            )
        console.print()


@app.command()
def cognee_search(
    project: str = typer.Option(..., "--project", "-p", help="项目名称"),
    query: str = typer.Option(..., "--query", "-q", help="查询内容"),
    mode: str = typer.Option("graph", "--mode", "-m", help="查询模式: graph, rag, chunks"),
):
    """使用 Cognee 进行语义检索。"""
    _ensure_nest_asyncio()
    console.print(f"[bold blue]Cognee 搜索[/bold blue]: {query}")

    async def do_search():
        store = CogneeStore(project)
        await store.initialize()
        return await store.search(query, mode=mode)

    try:
        result = asyncio.run(do_search())
    except Exception as e:
        console.print(f"[red]❌ 搜索失败: {e}[/red]")
        raise typer.Exit(1)

    console.print(result)


@app.command()
def generate_script(
    project: str = typer.Option(..., "--project", "-p", help="项目名称"),
    episode: int = typer.Option(..., "--episode", "-e", help="要生成的集数"),
    target_duration: float = typer.Option(60.0, "--duration", "-d", help="目标视频时长(秒)"),
    output_file: Optional[str] = typer.Option(
        None, "--output", "-o", help="已废弃：脚本只写入 SQLite"
    ),
):
    """生成单集解说词脚本（Cognee 版）。"""
    _ensure_nest_asyncio()
    console.print(f"[bold blue]生成脚本[/bold blue]: {project} 第 {episode} 集")

    async def do_generate():
        store = CogneeStore(project)
        try:
            await store.initialize()
            await store.load_graph_state()

            episode_node = await store.get_episode_from_graph(episode)
            if not episode_node:
                console.print(f"[red]错误: 未找到第 {episode} 集的规划[/red]")
                console.print("请先运行: novelvideo cognee-plan")
                return None

            workflow = create_script_writing_workflow(store)
            return await workflow.run(episode_num=episode, target_duration=target_duration)
        finally:
            await store.close()

    try:
        script = asyncio.run(do_generate())
    except Exception as e:
        console.print(f"[red]生成失败: {e}[/red]")
        raise typer.Exit(1)

    if not script:
        raise typer.Exit(1)

    if output_file:
        console.print("[yellow]--output 已废弃：2.0 脚本不再导出 epXXX_script.json[/yellow]")
    console.print(
        f"[green]脚本已写入 SQLite/Cognee: EP{episode}, beats={len(script.beats)}[/green]"
    )


@app.command()
def generate(
    project: str = typer.Option(..., "--project", "-p", help="项目名称"),
    episode: int = typer.Option(..., "--episode", "-e", help="要生成的集数"),
    mock: bool = typer.Option(False, "--mock", "-m", help="使用模拟生成器（测试用）"),
):
    """生成指定集的视频（简化版）。"""
    _ensure_nest_asyncio()
    console.print(f"[bold blue]生成项目[/bold blue]: {project}")
    console.print(f"[bold blue]目标集数[/bold blue]: 第 {episode} 集")

    dirs = ensure_project_dirs(project)

    async def do_generate():
        store = CogneeStore(project)
        try:
            await store.initialize()
            await store.load_graph_state()

            episode_node = await store.get_episode_from_graph(episode)
            if not episode_node:
                console.print(f"[red]错误: 未找到第 {episode} 集的规划[/red]")
                console.print("请先运行: novelvideo cognee-plan")
                return None

            workflow = create_script_writing_workflow(store)
            script = await workflow.run(episode_num=episode)
            console.print(f"  ✓ 生成 {len(script.beats)} 个节拍")

            ep_dir = os.path.join(dirs["videos"], f"ep{episode:03d}")
            images_dir = os.path.join(ep_dir, "images")
            audio_dir = os.path.join(ep_dir, "audio")
            os.makedirs(images_dir, exist_ok=True)
            os.makedirs(audio_dir, exist_ok=True)

            image_gen = create_image_generator(use_mock=mock)
            tts_gen = create_tts_generator(use_mock=mock)
            scene_assets = []

            for beat in script.beats:
                image_path = os.path.join(images_dir, f"beat_{beat.beat_number:02d}.png")
                audio_path = os.path.join(audio_dir, f"beat_{beat.beat_number:02d}.mp3")

                await image_gen.generate(prompt=beat.visual_description, output_path=image_path)
                tts_result = await tts_gen.generate(
                    text=beat.narration_segment, output_path=audio_path
                )

                if tts_result.success:
                    scene_assets.append(
                        SceneAsset(
                            scene_number=beat.beat_number,
                            image_path=image_path,
                            audio_path=audio_path,
                            subtitle_path=tts_result.subtitle_path,
                            duration_seconds=tts_result.duration_seconds,
                            narration_text=beat.narration_segment,
                        )
                    )

            if not scene_assets:
                console.print("[red]未生成任何素材[/red]")
                return None

            video_composer = create_video_composer()
            episode_title = normalize_video_title(episode_node.title)
            output_path = os.path.join(dirs["videos"], f"ep{episode:03d}_{episode_title}.mp4")
            result = await video_composer.compose_episode(
                scenes=scene_assets,
                output_path=output_path,
                title=f"第{episode}集 {episode_title}",
            )

            if result.success:
                console.print(f"[green]✓ 视频生成成功: {output_path}[/green]")
            else:
                console.print(f"[red]✗ 视频生成失败: {result.error}[/red]")
            return result
        finally:
            await store.close()

    try:
        result = asyncio.run(do_generate())
    except Exception as e:
        console.print(f"[red]生成失败: {e}[/red]")
        raise typer.Exit(1)
    if result is None or not result.success:
        raise typer.Exit(1)


@app.command()
def ui(
    port: int = typer.Option(7870, "--port", "-p", help="服务端口"),
    host: Optional[str] = typer.Option(None, "--host", help="监听地址"),
    reload: bool = typer.Option(False, "--reload/--no-reload", help="启用 API 热重载"),
):
    """Deprecated: start the REST API for the React frontend."""
    console.print("[yellow]NiceGUI/Gradio UI 已废弃。[/yellow]")
    console.print("[dim]现在使用 React 前端 + REST API。此命令会启动 API 服务。[/dim]")
    api(port=port, host=host, reload=reload)


@app.command()
def api(
    port: int = typer.Option(8780, "--port", "-p", help="API 服务端口"),
    host: Optional[str] = typer.Option(None, "--host", help="API 监听地址"),
    reload: bool = typer.Option(False, "--reload/--no-reload", help="启用 API 热重载"),
):
    """启动独立的 2.0 REST API 服务。"""
    console.print("[bold blue]启动 NovelVideo API[/bold blue]")
    console.print(f"端口: {port}")

    try:
        import uvicorn
    except ImportError as e:
        console.print(f"[red]❌ 缺少依赖: {e}[/red]")
        console.print("[dim]请运行: pip install uvicorn[/dim]")
        raise typer.Exit(1)

    api_host = host or os.environ.get("NOVELVIDEO_API_HOST", "0.0.0.0")
    api_port = port or int(os.environ.get("NOVELVIDEO_API_PORT", "8780"))
    console.print(f"[green]访问: http://{api_host}:{api_port}/api/v1[/green]")
    uvicorn.run(
        "novelvideo.api.app:app",
        host=api_host,
        port=api_port,
        reload=reload,
    )


@app.command("migrate-scene-names")
def migrate_scene_names_cmd(
    project_id: str = typer.Option("", "--project-id", help="control-plane 项目 ID"),
    user: str = typer.Option("", "--user", help="项目所属用户，例如 admin"),
    project: str = typer.Option("", "--project", "-p", help="项目名，例如 tayuta"),
    state_dir: str = typer.Option("", "--state-dir", help="data.db 所在目录"),
    output_dir: str = typer.Option("", "--output-dir", help="assets/scenes 所在项目目录"),
    apply: bool = typer.Option(False, "--apply", help="实际执行迁移；默认只 dry-run"),
    yes: bool = typer.Option(False, "--yes", help="确认执行 apply；必须与 --apply 同时使用"),
):
    """迁移旧项目中混入时间词的场景名。默认 dry-run，不写入。"""
    from novelvideo.cognee.scene_name_migration import migrate_scene_names

    async def do_migrate():
        db_dir, asset_dir, label = await _resolve_scene_migration_dirs(
            project_id=project_id,
            user=user,
            project=project,
            state_dir=state_dir,
            output_dir=output_dir,
        )
        if apply and not yes:
            raise typer.BadParameter("apply requires --yes")

        console.print(f"[bold blue]Scene name migration[/bold blue]: {label}")
        console.print(f"  data.db dir: {db_dir}")
        console.print(f"  asset dir:   {asset_dir}")
        console.print(f"  mode:        {'APPLY' if apply else 'DRY-RUN'}")

        report = await migrate_scene_names(
            db_dir,
            asset_project_dir=asset_dir,
            dry_run=not apply,
        )
        _print_scene_migration_report(report)

        if report.warnings:
            console.print("[yellow]⚠️  请检查 warnings 后再决定是否 apply。[/yellow]")
        if report.failed_asset_copies:
            console.print("[red]❌  资产复制失败，DB 未迁移。[/red]")
            raise typer.Exit(2)
        if apply and report.backup_path:
            console.print(f"[green]✓ 已创建 DB 备份: {report.backup_path}[/green]")
        if not apply:
            console.print("[dim]执行迁移需显式添加: --apply --yes[/dim]")

    try:
        asyncio.run(do_migrate())
    except typer.BadParameter as exc:
        console.print(f"[red]参数错误: {exc}[/red]")
        raise typer.Exit(1)


def main() -> None:
    app()


if __name__ == "__main__":
    main()
