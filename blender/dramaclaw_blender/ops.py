"""面板上的四个按钮。

这个文件里所有的复杂度都来自一条约束：**不许冻住 Blender**。用户在渲染 250 帧
的时候界面卡死几分钟，他会以为崩了然后强杀进程。所以配对走定时器、渲染走
`INVOKE_DEFAULT` 加回调、上传走后台线程加 modal 轮询——没有一处是同步等待。
"""

from __future__ import annotations

import datetime
import os
import threading
import time

import bpy
from bpy_extras.io_utils import ImportHelper

from . import render
from .core import naming
from .core.http import ApiError, get_json, post_json, post_multipart
from .core.limits import MAX_VIDEO_BYTES, LimitError, check_frame_range
from .core.pairing import PairingSession
from .prefs import api_url, get_prefs


def _timestamp() -> str:
    return datetime.datetime.now().strftime("%Y%m%d%H%M%S")


def _report_error(operator, message: str) -> None:
    operator.report({"ERROR"}, f"DramaClaw：{message}")


class DRAMACLAW_OT_connect(bpy.types.Operator):
    bl_idname = "dramaclaw.connect"
    bl_label = "连接 DramaClaw"
    bl_description = "取一个配对码，在浏览器里确认后完成连接"

    _session: PairingSession | None = None

    def execute(self, context):
        try:
            started = post_json(api_url(context, "/blender/pairing/start"), {})
        except ApiError as exc:
            _report_error(self, str(exc))
            return {"CANCELLED"}

        session = PairingSession(
            pairing_id=started["pairing_id"],
            code=started["code"],
            deadline=time.time() + float(started["expires_in"]),
        )
        DRAMACLAW_OT_connect._session = session

        prefs = get_prefs(context)
        approve_url = f"{prefs.server_url.rstrip('/')}/blender-pairing"
        bpy.ops.wm.url_open(url=approve_url)
        self.report({"INFO"}, f"DramaClaw：在浏览器里输入配对码 {session.code}")

        server_url = prefs.server_url
        addon_key = __package__

        def _poll():
            now = time.time()
            if not session.should_poll(now=now):
                _finish(session, addon_key)
                return None
            try:
                payload = get_json(f"{server_url.rstrip('/')}/api/v1/blender/pairing/{session.pairing_id}")
            except ApiError as exc:
                session.fail_once(str(exc))
            else:
                session.apply(payload, now=now)
            if session.finished:
                _finish(session, addon_key)
                return None
            return PairingSession.POLL_INTERVAL_SECONDS

        bpy.app.timers.register(_poll, first_interval=PairingSession.POLL_INTERVAL_SECONDS)
        return {"FINISHED"}


def _finish(session: PairingSession, addon_key: str) -> None:
    """把配对结果写回偏好设置。定时器里没有 operator 可以 report，所以只能写状态。"""
    prefs = bpy.context.preferences.addons[addon_key].preferences
    if session.token:
        prefs.token = session.token
    for window in bpy.context.window_manager.windows:
        for area in window.screen.areas:
            if area.type == "VIEW_3D":
                area.tag_redraw()


class DRAMACLAW_OT_disconnect(bpy.types.Operator):
    bl_idname = "dramaclaw.disconnect"
    bl_label = "断开连接"
    bl_description = "清掉本机保存的令牌。服务器上的授权在设置页里吊销"

    def execute(self, context):
        get_prefs(context).token = ""
        self.report({"INFO"}, "DramaClaw：已断开")
        return {"FINISHED"}


PROJECT_CACHE: list[str] = []


class DRAMACLAW_OT_refresh_projects(bpy.types.Operator):
    bl_idname = "dramaclaw.refresh_projects"
    bl_label = "刷新项目列表"
    bl_description = "从 DramaClaw 拉取这个账号下的项目"

    def execute(self, context):
        prefs = get_prefs(context)
        try:
            payload = get_json(
                api_url(context, "/blender/projects"), token=prefs.token
            )
        except ApiError as exc:
            _report_error(self, str(exc))
            return {"CANCELLED"}

        PROJECT_CACHE[:] = [str(name) for name in payload.get("projects", [])]
        if not PROJECT_CACHE:
            self.report({"WARNING"}, "DramaClaw：这个账号下还没有项目")
        elif prefs.project not in PROJECT_CACHE:
            # 之前选的项目没了（改名、删了、换了账号）。别留着一个投不进去的名字。
            prefs.project = PROJECT_CACHE[0]
        return {"FINISHED"}


class DRAMACLAW_OT_set_project(bpy.types.Operator):
    bl_idname = "dramaclaw.set_project"
    bl_label = "选择项目"

    name: bpy.props.StringProperty()

    def execute(self, context):
        get_prefs(context).project = self.name
        return {"FINISHED"}


class _DeliverBase(bpy.types.Operator):
    """渲染 + 上传的公共骨架。

    modal 的三个阶段：等渲染（靠 handler 置 flag）→ 等上传（靠线程置 flag）→ 收尾。
    """

    animation = False

    _timer = None
    _scene = None
    _output = ""
    _render_done = False
    _render_cancelled = False
    _upload_thread = None
    _upload_error = ""
    _upload_result = None

    def invoke(self, context, event):
        prefs = get_prefs(context)
        if not prefs.token:
            _report_error(self, "还没连接，先点「连接 DramaClaw」")
            return {"CANCELLED"}
        if not prefs.project:
            _report_error(self, "先在面板里选一个项目")
            return {"CANCELLED"}

        scene = context.scene
        camera = scene.camera
        if camera is None:
            _report_error(self, "场景里没有激活的相机")
            return {"CANCELLED"}

        if self.animation:
            try:
                check_frame_range(
                    scene.frame_start, scene.frame_end, fps=render.scene_fps(scene)
                )
            except LimitError as exc:
                _report_error(self, str(exc))
                return {"CANCELLED"}

        self._scene, self._output = render.make_blockout_scene(
            scene,
            camera=camera,
            short_side=int(scene.dramaclaw_short_side),
            frame_start=scene.frame_start,
            frame_end=scene.frame_end,
            animation=self.animation,
        )
        self._render_done = False
        self._render_cancelled = False
        bpy.app.handlers.render_complete.append(self._on_render_complete)
        bpy.app.handlers.render_cancel.append(self._on_render_cancel)

        bpy.ops.render.render(
            "INVOKE_DEFAULT",
            animation=self.animation,
            write_still=not self.animation,
            scene=self._scene.name,
        )

        self._timer = context.window_manager.event_timer_add(0.5, window=context.window)
        context.window_manager.modal_handler_add(self)
        return {"RUNNING_MODAL"}

    def _on_render_complete(self, *args):
        self._render_done = True

    def _on_render_cancel(self, *args):
        self._render_cancelled = True

    def _detach_handlers(self):
        for handlers, callback in (
            (bpy.app.handlers.render_complete, self._on_render_complete),
            (bpy.app.handlers.render_cancel, self._on_render_cancel),
        ):
            if callback in handlers:
                handlers.remove(callback)

    def modal(self, context, event):
        if event.type != "TIMER":
            return {"PASS_THROUGH"}

        if self._render_cancelled:
            return self._cleanup(context, {"CANCELLED"}, message="渲染已取消")

        if self._render_done and self._upload_thread is None:
            path = render.find_rendered_file(self._output, animation=self.animation)
            if path is None:
                return self._cleanup(context, {"CANCELLED"}, message="没找到渲染输出")
            self._start_upload(context, path)
            return {"RUNNING_MODAL"}

        if self._upload_thread is not None and not self._upload_thread.is_alive():
            if self._upload_error:
                return self._cleanup(context, {"CANCELLED"}, message=self._upload_error)
            self.report({"INFO"}, f"DramaClaw：已导入 {self._upload_result['filename']}")
            return self._cleanup(context, {"FINISHED"})

        return {"RUNNING_MODAL"}

    def _start_upload(self, context, path: str):
        prefs = get_prefs(context)
        scene = context.scene
        url = (
            f"{prefs.server_url.rstrip('/')}"
            f"/api/v1/projects/{prefs.project}/blender/deliver"
        )
        with open(path, "rb") as handle:
            payload = handle.read()

        camera_name = scene.camera.name
        stamp = _timestamp()
        width = self._scene.render.resolution_x
        height = self._scene.render.resolution_y
        if self.animation:
            filename = naming.video_filename(
                camera_name, scene.frame_start, scene.frame_end, stamp
            )
            fields = {
                "kind": "video",
                "camera": camera_name,
                "frame_start": str(scene.frame_start),
                "frame_end": str(scene.frame_end),
                "fps": str(render.scene_fps(scene)),
                "width": str(width),
                "height": str(height),
            }
            mime = "video/mp4"
        else:
            filename = naming.still_filename(camera_name, scene.frame_current, stamp)
            fields = {
                "kind": "image",
                "camera": camera_name,
                "frame": str(scene.frame_current),
                "width": str(width),
                "height": str(height),
            }
            mime = "image/png"

        token = prefs.token

        def _work():
            try:
                self._upload_result = post_multipart(
                    url,
                    fields=fields,
                    filename=filename,
                    payload=payload,
                    mime=mime,
                    token=token,
                )
            except ApiError as exc:
                self._upload_error = str(exc)

        self._upload_thread = threading.Thread(target=_work, daemon=True)
        self._upload_thread.start()

    def _cleanup(self, context, status, *, message: str = ""):
        self._detach_handlers()
        if self._timer is not None:
            context.window_manager.event_timer_remove(self._timer)
            self._timer = None
        render.discard_blockout_scene(self._scene)
        self._scene = None
        if message:
            _report_error(self, message)
        return status


class DRAMACLAW_OT_deliver_still(_DeliverBase):
    bl_idname = "dramaclaw.deliver_still"
    bl_label = "渲染并导入图片"
    bl_description = "用当前相机渲染当前帧的白模，并导入 DramaClaw"
    animation = False


class DRAMACLAW_OT_deliver_video(_DeliverBase):
    bl_idname = "dramaclaw.deliver_video"
    bl_label = "渲染并导入视频"
    bl_description = "用当前相机渲染帧范围内的白模视频，并导入 DramaClaw"
    animation = True


class DRAMACLAW_OT_deliver_local_video(bpy.types.Operator, ImportHelper):
    """投递一个已经渲好的视频文件。

    这个入口**什么都不知道**：相机、帧范围、帧率都读不出来（插件不打包 FFmpeg，
    Blender 的 Python 也没有现成的解析器）。所以元数据留空，而不是编几个看起来
    合理的数字塞进去——收件箱里一条假的 fps 比没有 fps 更糟。
    """

    bl_idname = "dramaclaw.deliver_local_video"
    bl_label = "导入本地视频"
    bl_description = "把一个已经渲好的视频文件直接投递到 DramaClaw"

    filename_ext = ".mp4"
    filter_glob: bpy.props.StringProperty(default="*.mp4;*.mov", options={"HIDDEN"})

    _timer = None
    _thread = None
    _error = ""
    _result = None

    def execute(self, context):
        prefs = get_prefs(context)
        if not prefs.token or not prefs.project:
            _report_error(self, "先连接并选好项目")
            return {"CANCELLED"}

        path = self.filepath
        if not path.lower().endswith((".mp4", ".mov")):
            _report_error(self, "只接受 .mp4 或 .mov")
            return {"CANCELLED"}

        size = os.path.getsize(path)
        if size > MAX_VIDEO_BYTES:
            _report_error(
                self, f"文件 {size // (1024 * 1024)} MB，超过 {MAX_VIDEO_BYTES // (1024 * 1024)} MB 上限"
            )
            return {"CANCELLED"}

        with open(path, "rb") as handle:
            payload = handle.read()
        filename = naming.video_filename("local", 0, 0, _timestamp())
        url = (
            f"{prefs.server_url.rstrip('/')}"
            f"/api/v1/projects/{prefs.project}/blender/deliver"
        )
        token = prefs.token

        def _work():
            try:
                self._result = post_multipart(
                    url,
                    # camera / frame / fps 一律不发。见类文档。
                    fields={"kind": "video"},
                    filename=filename,
                    payload=payload,
                    mime="video/mp4",
                    token=token,
                )
            except ApiError as exc:
                self._error = str(exc)

        self._thread = threading.Thread(target=_work, daemon=True)
        self._thread.start()
        self._timer = context.window_manager.event_timer_add(0.5, window=context.window)
        context.window_manager.modal_handler_add(self)
        return {"RUNNING_MODAL"}

    def modal(self, context, event):
        if event.type != "TIMER" or self._thread.is_alive():
            return {"PASS_THROUGH"} if event.type != "TIMER" else {"RUNNING_MODAL"}

        context.window_manager.event_timer_remove(self._timer)
        self._timer = None
        if self._error:
            _report_error(self, self._error)
            return {"CANCELLED"}
        self.report({"INFO"}, f"DramaClaw：已导入 {self._result['filename']}")
        return {"FINISHED"}
