"""Copy LibTV canvas media into project-local static storage."""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import socket
from functools import lru_cache
import json
import os
import uuid
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from novelvideo.freezone.liblib_import import LiblibImportError, LiblibShareLink
from novelvideo.utils import thumbnails
from novelvideo.utils.static_urls import project_static_url

# 不再按厂商域名做白名单:LibTV 自己就不止一个素材域(除 libtv-res.liblib.art 外,
# 「AI 搜图」带进来的素材落在 xla-persist.xingliu.art),白名单永远补不全,而补不全的
# 代价是整张画布导不进来。改为「能镜像就镜像,镜像不了就跳过、保留远端地址」。
#
# 但 host 校验不能整个删掉——后端会真的去 GET 这些地址,而地址来自第三方画布数据,
# 等于把「让本机发任意请求」的能力交了出去(SSRF)。所以保留的是**安全**护栏而不是
# **厂商**护栏:只走 https、不带凭据、且目标不能是内网/回环地址。
MAX_MEDIA_FILES = 256
MAX_MEDIA_BYTES = 256 * 1024 * 1024
MAX_TOTAL_MEDIA_BYTES = 1024 * 1024 * 1024
MEDIA_BATCH_SIZE = 4
MEDIA_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov", ".mp3", ".wav", ".m4a", ".aac"}


def _is_never_routable(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """回环 / 链路本地 / 未指定 / 组播——不可能是公网 CDN,任何情况下都不去。"""
    return (
        address.is_loopback
        or address.is_link_local
        or address.is_unspecified
        or address.is_multicast
    )


def _is_private_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return _is_never_routable(address) or address.is_private or address.is_reserved


@lru_cache(maxsize=256)
def _is_internal_host(hostname: str) -> bool:
    """目标是否指向本机/内网。

    字面量 IP 和域名用**不同**的尺子,这是这段代码最容易踩错的地方:

    * URL 里直接写 IP:按「内网」从严拦。画布数据里出现 `https://10.0.0.5/x.png`
      没有任何正当理由,而且 https 证书也不可能是为私有 IP 签的。
    * URL 里写域名:只拦回环这类绝无可能的地址,**不**按私有段拦。scheme 已经限死
      https 且 httpx 默认校验证书——内网服务拿不出 LibTV 域名的合法证书,SSRF 在
      TLS 那一层就断了;反过来按私有段拦的代价极大:国内代理软件的 fake-IP
      (198.18.0.0/15,Python 归类为 is_private)、企业 split-DNS,都会让完全正常的
      CDN 域名解析到私有段。802b3f40 那次导入 99/99 条素材全部 internal_host、
      一张图都没能本地化,就是这么来的。

    按主机名缓存:一张画布有上百条素材但通常只有一两个域名,不缓存就是上百次
    阻塞式 getaddrinfo 压在事件循环上。
    """
    try:
        ip = ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        return _is_private_address(ip)
    try:
        infos = socket.getaddrinfo(hostname, None)
    except OSError:
        # 解析不了**不**拦:后端可能通过 HTTP 代理出网,本地解析不了是常态。
        # 真解析不了的域名,下载那步自己会失败并按「未本地保存」跳过。
        return False
    for info in infos:
        candidate = str(info[4][0]).split("%", 1)[0]
        try:
            address = ipaddress.ip_address(candidate)
        except ValueError:
            # 认不出来的候选地址跳过,交给其它候选判断。
            continue
        if _is_never_routable(address):
            return True
    return False


def _media_url_rejection(value: object) -> str | None:
    """不能安全下载到本地时返回原因码,可以下载则返回 None。

    原因码会一路传到界面上:用户要知道这张图为什么只能走远端——远端素材喂不进本地
    模型、也不能当作编辑的参考图,不说清楚他只会以为是随机故障。
    """
    if not isinstance(value, str):
        return "bad_url"
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        return "bad_url"
    if parsed.scheme != "https" or port not in {None, 443}:
        return "not_https"
    if parsed.username or parsed.password:
        return "has_credentials"
    if parsed.fragment or not parsed.path.startswith("/"):
        return "bad_url"
    if not parsed.hostname:
        return "bad_url"
    if _is_internal_host(parsed.hostname):
        return "internal_host"
    return None


def _mirrorable_media_url(value: object) -> str | None:
    """能安全下载到本地的地址返回原值,否则返回 None(调用方跳过,不再中断导入)。"""
    return value if isinstance(value, str) and _media_url_rejection(value) is None else None


def _transformed_url(value: str, transform: str) -> str:
    parsed = urlsplit(value)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query["x-oss-process"] = transform
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), ""))


def _node_data(value: object) -> dict:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return {}
    return value if isinstance(value, dict) else {}


def canvas_media_urls(detail: dict) -> tuple[list[str], dict[str, str]]:
    """返回 (可镜像的地址, 跳过的地址)。

    任何一条素材都不该否决整张画布:镜像不了就跳过,前端 `assetUrl()` 会自动回落到
    远端地址,画布照样导入、图照样显示。跳过清单回给调用方,用来提示「N 个素材未本地
    保存」。
    """
    urls: set[str] = set()
    skipped: dict[str, str] = {}
    for node in detail.get("nodeList", []):
        if not isinstance(node, dict):
            continue
        data = _node_data(node.get("data"))
        kind = {2: "image", 3: "video", 4: "audio"}.get(node.get("type"))
        # Group/text nodes do not own media and therefore have no `url` field.
        # Generated media nodes may also be saved before their first result.
        # Neither case should abort an otherwise valid canvas import.
        if kind is not None:
            sources = data.get("url")
            for value in sources if isinstance(sources, list) else [sources]:
                if value is None:
                    continue
                url = _mirrorable_media_url(value)
                if not url:
                    if isinstance(value, str):
                        skipped[value] = _media_url_rejection(value) or "bad_url"
                    continue
                urls.add(url)
                if kind == "image":
                    urls.add(_transformed_url(url, "image/resize,w_320"))
                elif kind == "video":
                    urls.add(_transformed_url(url, "video/snapshot,t_1000,f_jpg,w_320"))
        params = data.get("params")
        if not isinstance(params, dict):
            continue
        for list_key in ("imageList", "videoList", "audioList", "mixedList"):
            items = params.get(list_key)
            if not isinstance(items, list):
                continue
            for item in items:
                if not isinstance(item, dict):
                    continue
                value = item.get("url")
                if value is None:
                    continue
                url = _mirrorable_media_url(value)
                if not url:
                    if isinstance(value, str):
                        skipped[value] = _media_url_rejection(value) or "bad_url"
                    continue
                urls.add(url)
                media_type = item.get("mediaType") or list_key.removesuffix("List")
                if media_type == "image":
                    urls.add(_transformed_url(url, "image/resize,w_320"))
                elif media_type == "video":
                    urls.add(_transformed_url(url, "video/snapshot,t_1000,f_jpg,w_320"))
    ordered = sorted(urls)
    if len(ordered) > MAX_MEDIA_FILES:
        # 超上限也不否决整张画布:镜像前 N 个,其余按「未本地保存」处理。
        for url in ordered[MAX_MEDIA_FILES:]:
            skipped[url] = "too_many_assets"
        ordered = ordered[:MAX_MEDIA_FILES]
    return ordered, skipped


def _media_target(media_dir: Path, url: str) -> Path | None:
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
    parsed = urlsplit(url)
    transform = dict(parse_qsl(parsed.query)).get("x-oss-process", "")
    suffix = ".jpg" if transform.startswith("video/snapshot") else Path(parsed.path).suffix.lower()
    if suffix not in MEDIA_EXTENSIONS:
        # 不认识的扩展名只说明我们存不了它,不代表这张画布不能导入。
        return None
    return media_dir / f"{digest}{suffix}"


def _detected_media_suffix(path: Path, *, preferred: str) -> str | None:
    with path.open("rb") as file:
        header = file.read(32)
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if header.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return ".webp"
    if header.startswith((b"GIF87a", b"GIF89a")):
        return ".gif"
    if header[4:8] == b"ftyp":
        return preferred if preferred in {".mp4", ".mov", ".m4a"} else ".mp4"
    if header.startswith(b"ID3") or (len(header) >= 2 and header[0] == 0xFF and header[1] & 0xE0 == 0xE0):
        return ".mp3"
    if header.startswith(b"RIFF") and header[8:12] == b"WAVE":
        return ".wav"
    if len(header) >= 2 and header[0] == 0xFF and header[1] & 0xF6 == 0xF0:
        return ".aac"
    return None


async def _download_media(client: httpx.AsyncClient, url: str, target: Path) -> tuple[Path, int]:
    # A LibTV URL can say .jpg while its bytes are PNG. Search by the stable
    # URL digest and reuse the correctly named local file on refresh.
    for suffix in [target.suffix, *(MEDIA_EXTENSIONS - {target.suffix})]:
        candidate = target.with_suffix(suffix)
        if not candidate.is_file() or not 0 < candidate.stat().st_size <= MAX_MEDIA_BYTES:
            continue
        detected = _detected_media_suffix(candidate, preferred=suffix)
        if detected == suffix or (detected == ".jpg" and suffix == ".jpeg"):
            return candidate, candidate.stat().st_size
    temporary = target.with_name(f"{target.name}.{uuid.uuid4().hex}.tmp")
    size = 0
    try:
        async with client.stream("GET", url) as response:
            response.raise_for_status()
            length = response.headers.get("content-length")
            if length and length.isdecimal() and int(length) > MAX_MEDIA_BYTES:
                raise LiblibImportError("liblib_media_too_large", "LibTV 单个素材超过本地导入上限", 413)
            with temporary.open("wb") as file:
                async for chunk in response.aiter_bytes(256 * 1024):
                    size += len(chunk)
                    if size > MAX_MEDIA_BYTES:
                        raise LiblibImportError("liblib_media_too_large", "LibTV 单个素材超过本地导入上限", 413)
                    file.write(chunk)
        if size == 0:
            raise LiblibImportError("liblib_media_empty", "LibTV 返回了空素材", 502)
        detected = _detected_media_suffix(temporary, preferred=target.suffix)
        if detected is None:
            raise LiblibImportError("liblib_media_type_invalid", "LibTV 返回的素材不是图片、视频或音频", 502)
        actual_target = target.with_suffix(detected)
        os.replace(temporary, actual_target)
        return actual_target, size
    except (httpx.HTTPError, OSError) as exc:
        raise LiblibImportError("liblib_media_unavailable", "无法下载 LibTV 素材，请稍后重试", 502) from exc
    finally:
        temporary.unlink(missing_ok=True)


async def _download_media_or_reason(
    client: httpx.AsyncClient, url: str, target: Path
) -> tuple[Path, int] | str:
    """下载单个素材。成功返回 (路径, 字节数),失败返回原因码——只影响这一条。

    源站 404/超时/限流、单个文件超限、返回的不是媒体——这些都是**这条素材**的问题,
    而不是这张画布的问题。此前任何一条失败都会让整个导入 raise 掉。
    """
    try:
        return await _download_media(client, url, target)
    except LiblibImportError as exc:
        # 把失败原因(超大/空/不是媒体/取不到)原样带出去,最终显示在节点上。
        return exc.code


async def _mirror_urls(
    urls: list[str],
    skipped: dict[str, str],
    media_dir: Path,
    project_dir: Path,
    project_id: str,
) -> tuple[dict[str, str], list[dict[str, str]]]:
    """把一批地址镜像到 media_dir。全程不因为单条失败而中断。"""
    media_dir.mkdir(parents=True, exist_ok=True)
    result: dict[str, str] = {}
    total_bytes = 0
    budget_exhausted = False
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=20.0), follow_redirects=False) as client:
        for start in range(0, len(urls), MEDIA_BATCH_SIZE):
            batch = urls[start:start + MEDIA_BATCH_SIZE]
            if budget_exhausted:
                for url in batch:
                    skipped.setdefault(url, "total_size_limit")
                continue
            targets = [_media_target(media_dir, url) for url in batch]
            pairs = [(url, target) for url, target in zip(batch, targets) if target is not None]
            for url, target in zip(batch, targets):
                if target is None:
                    skipped.setdefault(url, "unsupported_file_type")
            if not pairs:
                continue
            downloaded = await asyncio.gather(
                *(_download_media_or_reason(client, url, target) for url, target in pairs)
            )
            total_bytes += sum(item[1] for item in downloaded if not isinstance(item, str))
            for (url, _target), item in zip(pairs, downloaded):
                if isinstance(item, str):
                    skipped.setdefault(url, item)
                    continue
                actual_target, _size = item
                # 排队生成降采样副本。导入进来的素材走不到「生成历史写入」那条预热路径,
                # 而 `fresh_thumbnail` 从不按需构建——不在这里排队,这些图就永远只有原图
                # 可用,画布上一张 3840x2160 会被解码进 169x95 的框里(约 33MB 位图)。
                # prewarm 不阻塞、不抛异常,队列满了丢掉也只是下次仍然冷。
                thumbnails.prewarm(project_dir, actual_target)
                relative = actual_target.relative_to(project_dir).as_posix()
                result[url] = project_static_url(project_id, relative, local_path=actual_target)
            if total_bytes > MAX_TOTAL_MEDIA_BYTES:
                # 总量到顶:停止继续下载,剩下的按「未本地保存」处理,已下好的照常生效。
                budget_exhausted = True
    # 已经镜像成功的地址不算跳过(同一地址可能先失败后在别处成功)。
    return result, [
        {"url": url, "reason": reason}
        for url, reason in sorted(skipped.items())
        if url not in result
    ]


def _liblib_media_dir(project_dir: Path, source_project_id: str) -> Path:
    return project_dir / "freezone" / "liblib_import" / source_project_id / "media"


async def localize_media_urls(
    candidates: list[str],
    project_dir: Path,
    project_id: str,
    source_project_id: str,
) -> tuple[dict[str, str], list[dict[str, str]]]:
    """「一键本地化」用:把画布上仍指向远端的地址补下载到本地。

    和导入时走的是同一套护栏和同一个落盘目录,所以之前因为环境问题(代理 fake-IP、
    源站限流…)没存下来的素材,环境修好后按原样重跑就能补齐,不需要重新导入整张画布。
    """
    urls: list[str] = []
    skipped: dict[str, str] = {}
    seen: set[str] = set()
    for value in candidates:
        if not isinstance(value, str) or value in seen:
            continue
        seen.add(value)
        reason = _media_url_rejection(value)
        if reason is not None:
            skipped[value] = reason
            continue
        urls.append(value)
    urls.sort()
    if len(urls) > MAX_MEDIA_FILES:
        for url in urls[MAX_MEDIA_FILES:]:
            skipped[url] = "too_many_assets"
        urls = urls[:MAX_MEDIA_FILES]
    if not urls:
        return {}, [{"url": url, "reason": reason} for url, reason in sorted(skipped.items())]
    return await _mirror_urls(
        urls, skipped, _liblib_media_dir(project_dir, source_project_id), project_dir, project_id
    )


async def mirror_liblib_canvas_assets(
    detail: dict,
    share: LiblibShareLink,
    project_dir: Path,
    project_id: str,
) -> tuple[dict[str, str], list[dict[str, str]]]:
    """把画布素材镜像到项目本地。

    返回 (远端地址 → 本地地址, [{url, reason}])。第二项是未能本地保存的素材及原因,
    一路传到界面:远端素材喂不进本地模型、也不能当编辑的参考图,得让用户知道为什么。

    全程不因为单条素材失败而中断导入:镜像不了的素材保留远端地址,前端 `assetUrl()`
    自动回落,画布照常可用。
    """
    urls, skipped = canvas_media_urls(detail)
    return await _mirror_urls(
        urls, skipped, _liblib_media_dir(project_dir, share.project_id), project_dir, project_id
    )
