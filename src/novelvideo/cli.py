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

app = typer.Typer(name="novelvideo", help="Automated novel-narration video generation system (Cognee edition)")
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
    novel: str = typer.Option(..., "--novel", "-n", help="Path to the novel file"),
    project: str = typer.Option(..., "--project", "-p", help="Project name"),
):
    """导入小说到 Cognee 图谱。"""
    _ensure_nest_asyncio()
    console.print(f"[bold blue]Importing novel[/bold blue]: {novel}")
    console.print(f"[bold blue]Project name[/bold blue]: {project}")

    if not os.path.exists(novel):
        console.print(f"[red]Error: file not found {novel}[/red]")
        raise typer.Exit(1)

    ensure_project_dirs(project)

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        console=console,
    ) as progress:
        task = progress.add_task("Importing novel and building index...", total=None)

        async def do_import():
            store = CogneeStore(project)
            try:
                await store.initialize()
                return await store.ingest_novel(novel)
            finally:
                await store.close()

        try:
            result = asyncio.run(do_import())
            progress.update(task, description="[green]Import complete![/green]")
        except Exception as e:
            console.print(f"[red]Import failed: {e}[/red]")
            raise typer.Exit(1)

    console.print("[bold green]✓ Novel imported successfully![/bold green]")
    console.print(f"  Characters: {result['char_count']}")
    console.print(f"  Roles: {result.get('characters', 0)}")
    console.print(f"  Episodes: {result.get('episodes', 0)}")
    console.print(f"  Dataset: {result['dataset']}")
    console.print(f"\n[dim]Next step: novelvideo cognee-profile -p {project}[/dim]")


@app.command()
def cognee_ingest(
    project: str = typer.Option(..., "--project", "-p", help="Project name"),
    novel: str = typer.Option(..., "--novel", "-n", help="Path to the novel file"),
    rebuild: bool = typer.Option(False, "--rebuild", help="Rebuild the graph (clears old data)"),
    episodes: int = typer.Option(10, "--episodes", "-e", help="Target episode count"),
):
    """使用 Cognee 导入小说（一次性完成：原文 + 角色 + 剧集）。"""
    _ensure_nest_asyncio()
    console.print(f"[bold blue]Cognee unified import[/bold blue]: {novel} → {project}")

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
        console.print(f"[red]❌ Import failed: {e}[/red]")
        raise typer.Exit(1)

    console.print("\n[green]✅ Import complete[/green]")
    console.print(f"  Characters: {result['char_count']}")
    console.print(f"  Roles: {result.get('characters', 0)}")
    console.print(f"  Episodes: {result.get('episodes', 0)}")
    console.print(f"  Dataset: {result['dataset']}")
    console.print(f"\n[dim]Next step: novelvideo cognee-profile -p {project}[/dim]")


@app.command()
def cognee_profile(
    project: str = typer.Option(..., "--project", "-p", help="Project name"),
):
    """查看图谱中的角色（从图谱查询，无需指定小说）。"""
    _ensure_nest_asyncio()
    console.print(f"[bold blue]Cognee character management[/bold blue]: {project}")

    async def do_profile():
        store = CogneeStore(project)
        await store.initialize()
        # 从图谱查询角色
        return await store.list_characters()

    try:
        characters = asyncio.run(do_profile())
    except Exception as e:
        console.print(f"[red]❌ Failed to load characters: {e}[/red]")
        raise typer.Exit(1)

    if not characters:
        console.print("[yellow]⚠️ No character data in the graph; run cognee-ingest first[/yellow]")
        raise typer.Exit(1)

    console.print(f"[cyan]Graph contains {len(characters)} characters[/cyan]")
    console.print(f"[green]✅ Extracted {len(characters)} characters (unfiltered)[/green]")


@app.command()
def cognee_plan(
    project: str = typer.Option(..., "--project", "-p", help="Project name"),
):
    """查看图谱中的剧集规划（从图谱查询，无需指定小说）。"""
    _ensure_nest_asyncio()
    console.print(f"[bold blue]Cognee episode planning[/bold blue]: {project}")

    async def do_plan():
        store = CogneeStore(project)
        await store.initialize()
        # 从图谱查询剧集
        episodes = await store.list_episodes()
        return store, episodes

    try:
        store, episodes = asyncio.run(do_plan())
    except Exception as e:
        console.print(f"[red]❌ Failed to load episodes: {e}[/red]")
        raise typer.Exit(1)

    if not episodes:
        console.print("[yellow]⚠️ No episode data in the graph; run cognee-ingest first[/yellow]")
        raise typer.Exit(1)

    console.print(f"[green]{len(episodes)} episodes total[/green]\n")

    for ep in sorted(episodes, key=lambda e: e.number):
        console.print(f"[bold]Episode {ep.number}: {ep.title}[/bold]")
        console.print(
            f"  Summary: {ep.content_summary[:60]}..."
            if len(ep.content_summary) > 60
            else f"  Summary: {ep.content_summary}"
        )
        if ep.cliffhanger:
            console.print(
                f"  Cliffhanger: {ep.cliffhanger[:40]}..."
                if len(ep.cliffhanger) > 40
                else f"  Cliffhanger: {ep.cliffhanger}"
            )
        console.print()


@app.command()
def cognee_search(
    project: str = typer.Option(..., "--project", "-p", help="Project name"),
    query: str = typer.Option(..., "--query", "-q", help="Query text"),
    mode: str = typer.Option("graph", "--mode", "-m", help="Query mode: graph, rag, chunks"),
):
    """使用 Cognee 进行语义检索。"""
    _ensure_nest_asyncio()
    console.print(f"[bold blue]Cognee search[/bold blue]: {query}")

    async def do_search():
        store = CogneeStore(project)
        await store.initialize()
        return await store.search(query, mode=mode)

    try:
        result = asyncio.run(do_search())
    except Exception as e:
        console.print(f"[red]❌ Search failed: {e}[/red]")
        raise typer.Exit(1)

    console.print(result)


@app.command()
def generate_script(
    project: str = typer.Option(..., "--project", "-p", help="Project name"),
    episode: int = typer.Option(..., "--episode", "-e", help="Episode number to generate"),
    target_duration: float = typer.Option(60.0, "--duration", "-d", help="Target video duration (seconds)"),
    output_file: Optional[str] = typer.Option(
        None, "--output", "-o", help="Deprecated: the script is only written to SQLite"
    ),
):
    """生成单集解说词脚本（Cognee 版）。"""
    _ensure_nest_asyncio()
    console.print(f"[bold blue]Generating script[/bold blue]: {project} episode {episode}")

    async def do_generate():
        store = CogneeStore(project)
        try:
            await store.initialize()
            await store.load_graph_state()

            episode_node = await store.get_episode_from_graph(episode)
            if not episode_node:
                console.print(f"[red]Error: no plan found for episode {episode}[/red]")
                console.print("Run first: novelvideo cognee-plan")
                return None

            workflow = create_script_writing_workflow(store)
            return await workflow.run(episode_num=episode, target_duration=target_duration)
        finally:
            await store.close()

    try:
        script = asyncio.run(do_generate())
    except Exception as e:
        console.print(f"[red]Generation failed: {e}[/red]")
        raise typer.Exit(1)

    if not script:
        raise typer.Exit(1)

    if output_file:
        console.print("[yellow]--output is deprecated: 2.0 scripts no longer export epXXX_script.json[/yellow]")
    console.print(
        f"[green]Script written to SQLite/Cognee: EP{episode}, beats={len(script.beats)}[/green]"
    )


@app.command()
def generate(
    project: str = typer.Option(..., "--project", "-p", help="Project name"),
    episode: int = typer.Option(..., "--episode", "-e", help="Episode number to generate"),
    mock: bool = typer.Option(False, "--mock", "-m", help="Use the mock generator (for testing)"),
):
    """生成指定集的视频（简化版）。"""
    _ensure_nest_asyncio()
    console.print(f"[bold blue]Generating project[/bold blue]: {project}")
    console.print(f"[bold blue]Target episode[/bold blue]: episode {episode}")

    dirs = ensure_project_dirs(project)

    async def do_generate():
        store = CogneeStore(project)
        try:
            await store.initialize()
            await store.load_graph_state()

            episode_node = await store.get_episode_from_graph(episode)
            if not episode_node:
                console.print(f"[red]Error: no plan found for episode {episode}[/red]")
                console.print("Run first: novelvideo cognee-plan")
                return None

            workflow = create_script_writing_workflow(store)
            script = await workflow.run(episode_num=episode)
            console.print(f"  ✓ Generated {len(script.beats)} beats")

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
                console.print("[red]No assets were generated[/red]")
                return None

            video_composer = create_video_composer()
            episode_title = normalize_video_title(episode_node.title)
            output_path = os.path.join(dirs["videos"], f"ep{episode:03d}_{episode_title}.mp4")
            result = await video_composer.compose_episode(
                scenes=scene_assets,
                output_path=output_path,
                title=f"Episode {episode} {episode_title}",
            )

            if result.success:
                console.print(f"[green]✓ Video generated successfully: {output_path}[/green]")
            else:
                console.print(f"[red]✗ Video generation failed: {result.error}[/red]")
            return result
        finally:
            await store.close()

    try:
        result = asyncio.run(do_generate())
    except Exception as e:
        console.print(f"[red]Generation failed: {e}[/red]")
        raise typer.Exit(1)
    if result is None or not result.success:
        raise typer.Exit(1)


@app.command()
def ui(
    port: int = typer.Option(7870, "--port", "-p", help="Service port"),
    host: Optional[str] = typer.Option(None, "--host", help="Listen address"),
    reload: bool = typer.Option(False, "--reload/--no-reload", help="Enable API hot reload"),
):
    """Deprecated: start the REST API for the React frontend."""
    console.print("[yellow]The NiceGUI/Gradio UI is deprecated.[/yellow]")
    console.print("[dim]The app now uses a React frontend + REST API. This command starts the API service.[/dim]")
    api(port=port, host=host, reload=reload)


@app.command()
def api(
    port: int = typer.Option(8780, "--port", "-p", help="API service port"),
    host: Optional[str] = typer.Option(None, "--host", help="API listen address"),
    reload: bool = typer.Option(False, "--reload/--no-reload", help="Enable API hot reload"),
):
    """启动独立的 2.0 REST API 服务。"""
    console.print("[bold blue]Starting NovelVideo API[/bold blue]")
    console.print(f"Port: {port}")

    try:
        import uvicorn
    except ImportError as e:
        console.print(f"[red]❌ Missing dependency: {e}[/red]")
        console.print("[dim]Run: pip install uvicorn[/dim]")
        raise typer.Exit(1)

    api_host = host or os.environ.get("NOVELVIDEO_API_HOST", "0.0.0.0")
    api_port = port or int(os.environ.get("NOVELVIDEO_API_PORT", "8780"))
    console.print(f"[green]Access: http://{api_host}:{api_port}/api/v1[/green]")
    uvicorn.run(
        "novelvideo.api.app:app",
        host=api_host,
        port=api_port,
        reload=reload,
    )


@app.command("migrate-scene-names")
def migrate_scene_names_cmd(
    project_id: str = typer.Option("", "--project-id", help="Control-plane project ID"),
    user: str = typer.Option("", "--user", help="Project owner username, e.g. admin"),
    project: str = typer.Option("", "--project", "-p", help="Project name, e.g. tayuta"),
    state_dir: str = typer.Option("", "--state-dir", help="Directory containing data.db"),
    output_dir: str = typer.Option("", "--output-dir", help="Project directory containing assets/scenes"),
    apply: bool = typer.Option(False, "--apply", help="Actually run the migration; defaults to dry-run only"),
    yes: bool = typer.Option(False, "--yes", help="Confirm apply; must be used together with --apply"),
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
            console.print("[yellow]⚠️  Review the warnings before deciding whether to apply.[/yellow]")
        if report.failed_asset_copies:
            console.print("[red]❌  Asset copy failed; the DB was not migrated.[/red]")
            raise typer.Exit(2)
        if apply and report.backup_path:
            console.print(f"[green]✓ DB backup created: {report.backup_path}[/green]")
        if not apply:
            console.print("[dim]To run the migration, explicitly add: --apply --yes[/dim]")

    try:
        asyncio.run(do_migrate())
    except typer.BadParameter as exc:
        console.print(f"[red]Invalid argument: {exc}[/red]")
        raise typer.Exit(1)


def main() -> None:
    app()


if __name__ == "__main__":
    main()
