"""项目下拉框的纯逻辑。

插件显示项目**名字**，但存下来、拼进投递地址的必须是项目 **id**：投递接口按注册表 id
查项目。以前插件存的是名字，每次投递都是 `Project not found`。

跟 `core/` 下别的模块一样不 import bpy。
"""

from __future__ import annotations

from urllib.parse import quote


def parse_projects(payload: object) -> list[tuple[str, str]]:
    """把 `/blender/projects` 的响应解析成 `[(id, name), ...]`。

    没有 id 的条目一律跳过：投递地址拼的就是 id，选中一个没有 id 的条目只会换来一个
    404。旧后端返回的一串目录名也落在这一类里。
    """
    items = payload.get("projects") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        return []
    projects: list[tuple[str, str]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        project_id = item.get("id")
        if not isinstance(project_id, str) or not project_id:
            continue
        name = item.get("name")
        projects.append((project_id, name if isinstance(name, str) and name else project_id))
    return projects


def reconcile_selection(current_id: str, projects: list[tuple[str, str]]) -> tuple[str, str]:
    """刷新列表之后，偏好里该存哪个 `(id, name)`。

    当前选中的还在：保留它，名字按最新的来（项目可能改过名）。不在了——删了、被撤了
    权限、换了账号，或者是老版本存下的项目名——换成第一个，别留着一个投不进去的值。
    """
    for project_id, name in projects:
        if project_id == current_id:
            return project_id, name
    return projects[0] if projects else ("", "")


def canvas_page_url(*, web_url: str, server_url: str, project_id: str) -> str:
    """投递成功后在浏览器里打开的画布页。

    页面加载完会自己认领收件箱、把节点放到视口中心并聚焦，插件只管把人送到这儿。
    网页地址的取法同 `pairing.approve_page_url`：生产同源留空，开发环境指向 vite。
    """
    base = (web_url.strip() or server_url.strip()).rstrip("/")
    return f"{base}/projects/{quote(project_id, safe='')}/freezone"
