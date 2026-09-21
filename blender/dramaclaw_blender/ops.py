"""面板上的四个按钮。

这个文件里所有的复杂度都来自一条约束：**不许冻住 Blender**。用户在渲染 250 帧
的时候界面卡死几分钟，他会以为崩了然后强杀进程。所以渲染走 `INVOKE_DEFAULT` 加
回调，上传走后台线程加 modal 轮询，配对的等待走定时器——三个耗时大头都不占主线程。

但要说清楚：**配对的每一次请求、以及拉项目列表，仍然是主线程里的同步调用**
（`bpy.app.timers` 的回调也跑在主线程）。它们收发的都是几百字节，走 `core.http`
的短超时（`CONTROL_TIMEOUT_SECONDS`），最坏情况是卡十秒而不是十分钟。把它们也挪
进线程是另一件事，这里没做。
"""

from __future__ import annotations

import datetime
import os
import threading
import time
from urllib.parse import quote

import bpy
from bpy_extras.io_utils import ImportHelper

from . import render
from .core import naming
from .core.http import ApiError, get_json, post_json, post_multipart
from .core.limits import (
    MAX_IMAGE_BYTES,
    MAX_VIDEO_BYTES,
    LimitError,
    check_frame_range,
)
from .core.pairing import PairingSession, approve_page_url
from .core.projects import parse_projects, reconcile_selection
from .prefs import api_url, get_prefs


def _timestamp() -> str:
    return datetime.datetime.now().strftime("%Y%m%d%H%M%S")


def _report_error(operator, message: str) -> None:
    operator.report({"ERROR"}, f"DramaClaw：{message}")


class DRAMACLAW_OT_connect(bpy.types.Operator):
    bl_idname = "dramaclaw.connect"
    bl_label = "连接 DramaClaw"
    bl_description = "取一个配对码，在浏览器里确认后完成连接"

    def execute(self, context):
        prefs = get_prefs(context)
        prefs.last_error = ""
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
        # 先落到偏好设置，面板才画得出来。状态栏那条消息一闪就没，不能当唯一出口。
        prefs.pending_code = session.code
        bpy.ops.wm.url_open(
            url=approve_page_url(
                web_url=prefs.web_url,
                server_url=prefs.server_url,
                code=session.code,
            )
        )
        self.report({"INFO"}, f"DramaClaw：在浏览器里确认配对码 {session.code}")

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
    prefs.pending_code = ""
    if session.token:
        prefs.token = session.token
        prefs.last_error = ""
    else:
        # 失败（过期、被用过、连着连不上）只有这一个出口。不写出去的话，面板上
        # 一个字都不会变，用户只会反复点「连接」。
        prefs.last_error = session.error or "配对没有完成，请重新点「连接」"
    for window in bpy.context.window_manager.windows:
        for area in window.screen.areas:
            if area.type == "VIEW_3D":
                area.tag_redraw()


class DRAMACLAW_OT_disconnect(bpy.types.Operator):
    bl_idname = "dramaclaw.disconnect"
    bl_label = "断开连接"
    bl_description = "清掉本机保存的令牌。服务器上的授权在设置页里吊销"

    def execute(self, context):
        prefs = get_prefs(context)
        prefs.token = ""
        prefs.pending_code = ""
        self.report({"INFO"}, "DramaClaw：已断开")
        return {"FINISHED"}


# `(id, name)`：下拉框显示名字，选中后存 id。
PROJECT_CACHE: list[tuple[str, str]] = []


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

        PROJECT_CACHE[:] = parse_projects(payload)
        if not PROJECT_CACHE:
            self.report({"WARNING"}, "DramaClaw：这个账号下还没有能投递的项目")
        prefs.project, prefs.project_name = reconcile_selection(prefs.project, PROJECT_CACHE)
        return {"FINISHED"}


class DRAMACLAW_OT_set_project(bpy.types.Operator):
    bl_idname = "dramaclaw.set_project"
    bl_label = "选择项目"

    project_id: bpy.props.StringProperty()
    project_name: bpy.props.StringProperty()

    def execute(self, context):
        prefs = get_prefs(context)
        prefs.project = self.project_id
        prefs.project_name = self.project_name
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
        # 只有 id 没有名字，是老版本存下的项目名，投出去必然 `Project not found`。
        if not prefs.project or not prefs.project_name:
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
        self._upload_thread = None
        self._upload_error = ""
        self._upload_result = None
        bpy.app.handlers.render_complete.append(self._on_render_complete)
        bpy.app.handlers.render_cancel.append(self._on_render_cancel)

        try:
            bpy.ops.render.render(
                "INVOKE_DEFAULT",
                animation=self.animation,
                write_still=not self.animation,
                scene=self._scene.name,
            )
        except Exception as exc:
            # 渲染压根没起来（输出目录不可写、引擎不可用……）。此刻 modal 还没挂上，
            # `_cleanup` 永远不会被调到，handler、副本场景、临时目录都得当场收掉。
            self._abort_before_modal()
            _report_error(self, f"渲染没能启动：{exc}")
            return {"CANCELLED"}

        self._timer = context.window_manager.event_timer_add(0.5, window=context.window)
        context.window_manager.modal_handler_add(self)
        return {"RUNNING_MODAL"}

    def _abort_before_modal(self) -> None:
        """invoke 里失败时的收尾。跟 `_cleanup` 的区别是这里还没有 timer 和 modal。"""
        self._detach_handlers()
        render.discard_blockout_scene(self._scene)
        self._scene = None
        render.discard_output_dir(self._output)
        self._output = ""

    def _on_render_complete(self, scene=None, *args):
        # handler 是全局的：投递进行中用户另起一次渲染，也会打到这里来。只认自己
        # 那个副本场景，别把别人的完成当成自己的。
        if self._scene is not None and scene == self._scene:
            self._render_done = True

    def _on_render_cancel(self, scene=None, *args):
        if self._scene is not None and scene == self._scene:
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
            problem = self._start_upload(context, path)
            if problem:
                return self._cleanup(context, {"CANCELLED"}, message=problem)
            return {"RUNNING_MODAL"}

        if self._upload_thread is not None and not self._upload_thread.is_alive():
            if self._upload_error:
                return self._cleanup(context, {"CANCELLED"}, message=self._upload_error)
            if not isinstance(self._upload_result, dict) or not self._upload_result.get("filename"):
                # 线程跑完了、没报错、也没拿回像样的回应。硬取下标就是一个
                # traceback 弹到用户脸上，不如说人话。
                return self._cleanup(
                    context, {"CANCELLED"}, message="服务端没有返回投递结果，请重试"
                )
            self.report({"INFO"}, f"DramaClaw：已导入 {self._upload_result['filename']}")
            return self._cleanup(context, {"FINISHED"})

        return {"RUNNING_MODAL"}

    def _start_upload(self, context, path: str) -> str:
        """读出渲染结果、起上传线程。返回空串表示起成功，否则是给用户看的原因。"""
        prefs = get_prefs(context)
        scene = context.scene
        url = (
            f"{prefs.server_url.rstrip('/')}"
            f"/api/v1/projects/{quote(prefs.project, safe='')}/blender/deliver"
        )
        with open(path, "rb") as handle:
            payload = handle.read()

        limit = MAX_VIDEO_BYTES if self.animation else MAX_IMAGE_BYTES
        if len(payload) > limit:
            # 本地视频那条入口一直查这个，渲染这条一直没查。渲了几分钟再吃一个
            # 服务端 413 是最亏的结局——超了就别发。
            return (
                f"渲出来 {len(payload) // (1024 * 1024)} MB，"
                f"超过 {limit // (1024 * 1024)} MB 上限，没有发送"
            )

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
            except Exception as exc:
                # 线程里的异常不会传播到 modal。漏一个，`_upload_error` 就还是空、
                # `_upload_result` 还是 None，modal 一取下标就崩。非 JSON 的 2xx
                # 回应（nginx 错误页、强制门户）就正好长这样。
                self._upload_error = str(exc) or type(exc).__name__

        self._upload_thread = threading.Thread(target=_work, daemon=True)
        self._upload_thread.start()
        return ""

    def _cleanup(self, context, status, *, message: str = ""):
        self._detach_handlers()
        if self._timer is not None:
            context.window_manager.event_timer_remove(self._timer)
            self._timer = None
        render.discard_blockout_scene(self._scene)
        self._scene = None
        # 能走到这儿，渲染结果要么已经被 `_start_upload` 整个读进内存（上传线程用的
        # 是 bytes，不再碰磁盘），要么根本没渲出来。两种情况下临时目录都没人要了。
        render.discard_output_dir(self._output)
        self._output = ""
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
        if not prefs.token or not prefs.project or not prefs.project_name:
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
            f"/api/v1/projects/{quote(prefs.project, safe='')}/blender/deliver"
        )
        token = prefs.token
        self._error = ""
        self._result = None

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
            except Exception as exc:
                # 同 `_DeliverBase._work`：线程里漏掉的异常会变成 modal 里的
                # `'NoneType' object is not subscriptable`。
                self._error = str(exc) or type(exc).__name__

        self._thread = threading.Thread(target=_work, daemon=True)
        self._thread.start()
        self._timer = context.window_manager.event_timer_add(0.5, window=context.window)
        context.window_manager.modal_handler_add(self)
        return {"RUNNING_MODAL"}

    def modal(self, context, event):
        if event.type != "TIMER":
            return {"PASS_THROUGH"}
        if self._thread is not None and self._thread.is_alive():
            return {"RUNNING_MODAL"}

        if self._timer is not None:
            context.window_manager.event_timer_remove(self._timer)
            self._timer = None
        if self._error:
            _report_error(self, self._error)
            return {"CANCELLED"}
        if not isinstance(self._result, dict) or not self._result.get("filename"):
            _report_error(self, "服务端没有返回投递结果，请重试")
            return {"CANCELLED"}
        self.report({"INFO"}, f"DramaClaw：已导入 {self._result['filename']}")
        return {"FINISHED"}
