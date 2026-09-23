# DramaClaw Blender 插件

把 Blender 里的白模（Workbench 实体着色）渲成图片或视频，直接投递到 DramaClaw 项目；
网页画布打开着时，投递会自动落成画布节点。

- 最低支持 Blender 3.6，真机验证过 5.2。
- 只用标准库，不打包任何第三方依赖（Blender 自带 FFmpeg）。

## 目录

```
blender/
├── build.py                 打安装包 → dist/dramaclaw_blender-<版本>.zip
├── dist/                    构建产物（gitignored）
├── dramaclaw_blender/       插件本体（zip 里的顶层目录）
│   ├── __init__.py          bl_info + register()；顶层不 import bpy
│   ├── registry.py          注册所有 bpy 类；从这里往下才依赖 bpy
│   ├── prefs.py / panel.py / ops.py / render.py
│   └── core/                纯逻辑，不许 import bpy
└── tests/                   pytest，不需要 Blender
```

**`core/` 不许 import bpy。** 测试在没有 Blender 的 CI 里跑，能测到的只有 `core/`
和顶层 `__init__.py`；要加逻辑，尽量写进 `core/`，`ops.py` / `render.py` 只做 bpy 胶水。
`tests/test_package_imports_without_bpy.py` 守着这条线。

## 测试

仓库根的 `pyproject.toml` 已把 `blender/tests` 列进 `testpaths`、`blender` 列进
`pythonpath`，所以跟后端一起跑，CI 也会跑：

```bash
uv run pytest blender/tests          # 只跑插件
ruff check blender/
```

## 本地装进 Blender 调试

```bash
python3 blender/build.py             # 产出 blender/dist/dramaclaw_blender-x.y.z.zip
```

Blender → 偏好设置 → 插件 → 从磁盘安装 → 选这个 zip。侧边栏（N）里出现「DramaClaw」页签。

- 直接装 `dist/` 里的 zip 没有随包配置，服务地址是出厂值 `http://127.0.0.1:19081`，
  需要在插件偏好设置里改成实际地址。
- 从网页「下载插件」拿到的 zip 会带 `config.json`（见下文），装上即用。
- **覆盖安装**：Blender 只 reload 顶层 `__init__.py`，不重载子模块。`__init__.py` 里的
  `_purge_stale_submodules()` 会先清掉旧子模块再 import，所以覆盖装新版无需重启；
  改这段逻辑前先读它的注释和 `tests/test_addon_reload.py`。

## 发版

```bash
# 1. 改版本号：dramaclaw_blender/__init__.py 里的 bl_info["version"]
# 2. 打包
python3 blender/build.py            # → blender/dist/dramaclaw_blender-x.y.z.zip
# 3. 上传 OSS（ossutil 先 `ossutil config` 配好 AK/SK）
V=x.y.z
ossutil cp blender/dist/dramaclaw_blender-$V.zip \
  oss://dramaclaw-dl/blender-addon/dramaclaw_blender-$V.zip        # 留档，不覆盖
ossutil cp -f blender/dist/dramaclaw_blender-$V.zip \
  oss://dramaclaw-dl/blender-addon/dramaclaw_blender-latest.zip \
  --meta "Cache-Control:no-cache"                                 # 网页下载的就是这份
# 4. 刷新 CDN 缓存：阿里云 CDN 控制台「刷新预热」→ URL 刷新
#    https://dramaclaw-dl.cdnfg.com/blender-addon/dramaclaw_blender-latest.zip
```

bucket 是私有的，OSS 直连地址一律 403，对外只走 CDN 域名 `dramaclaw-dl.cdnfg.com`。
`-latest.zip` 名字不变、内容会变，覆盖后不刷新 CDN，后端可能还拿到旧包。

回滚：把旧版本那份再 `cp` 一遍覆盖 `-latest.zip`，再刷新 CDN。后端不用重新部署。

### 网页上的「下载插件」怎么拿到包

浏览器请求后端 `GET /api/v1/blender/addon`，后端取原包、注入 `dramaclaw_blender/config.json`
后返回：

```json
{"server_url": "https://…", "web_url": "https://…"}
```

原包的来源，按顺序：

1. **本地 `blender/dist/`**（或 `DRAMACLAW_BLENDER_ADDON_DIST` 指定的目录）里有
   `dramaclaw_blender-x.y.z.zip`，就取版本号最大的那个。开发机跑过 `build.py`，下载到的就是刚打的包。
2. 否则经 CDN 从 OSS 下载：`DRAMACLAW_BLENDER_ADDON_URL`，默认是
   `https://dramaclaw-dl.cdnfg.com/blender-addon/dramaclaw_blender-latest.zip`。
   下载文件名按包里 `bl_info` 的版本号命名。OSS 取不到时返回 502，**不会**回落到本地。

注入的两个地址：

- `server_url`：优先 `DRAMACLAW_PUBLIC_BASE_URL`，否则按转发头推断。反代后面请务必配这个变量。
- `web_url`：取自下载请求的 Referer，用来在浏览器里打开配对页。
- **只放地址，绝不放 token。** 配对走浏览器里输配对码，凭据只存在用户本机的 Blender 偏好设置里。
  所以 OSS 上的原包可以公开读。
- 插件只在偏好设置为空或还是出厂值时才用随包配置，用户手改过的地址覆盖安装后不会被冲掉。

## Blender 版本差异

- **5.x 的输出格式拆成了两级**：先设 `image_settings.media_type`（`IMAGE` / `VIDEO`），
  `file_format` 的可选项才跟着变。不先设 `VIDEO` 就赋 `FFMPEG` 会 `TypeError: enum "FFMPEG" not found`。
  3.6–4.x 没有 `media_type`。统一走 `render._set_output_format()`。
- 渲染在 `scene.copy()` 出来的副本场景上做，渲完删掉，不改用户场景的任何设置。
