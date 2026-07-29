"""网格分割工具模块。

将 5x5 网格图分割成 25 个独立分镜。
"""

import io
import os
from pathlib import Path
from typing import List, Optional, Tuple, Union

import numpy as np
from PIL import Image


def _trim_outer_border(
    img: Image.Image,
    gray: np.ndarray,
    brightness_threshold: int = 220,
    min_content_ratio: float = 0.15,
) -> Tuple[Image.Image, np.ndarray]:
    """检测并裁掉整张图的外围白边。

    从四边向内扫描，每行/列的暗像素（< threshold）占比
    超过 min_content_ratio 时认为到达内容区域。

    注意：threshold 设为 220 而非 240，因为 JPEG 压缩的白边区域
    亮度在 235-245 之间波动，用 240 会导致 ~30% 的边框像素被误判为暗像素。
    220 可以干净地区分白边（dark<220 ≈ 0）和内容（dark<220 > 0.9）。

    Returns: (cropped_img, cropped_gray)
    """
    h, w = gray.shape

    # 从顶部向下扫描
    top = 0
    for y in range(h):
        dark_ratio = np.mean(gray[y, :] < brightness_threshold)
        if dark_ratio >= min_content_ratio:
            top = y
            break

    # 从底部向上扫描
    bottom = h
    for y in range(h - 1, -1, -1):
        dark_ratio = np.mean(gray[y, :] < brightness_threshold)
        if dark_ratio >= min_content_ratio:
            bottom = y + 1
            break

    # 从左侧向右扫描
    left = 0
    for x in range(w):
        dark_ratio = np.mean(gray[:, x] < brightness_threshold)
        if dark_ratio >= min_content_ratio:
            left = x
            break

    # 从右侧向左扫描
    right = w
    for x in range(w - 1, -1, -1):
        dark_ratio = np.mean(gray[:, x] < brightness_threshold)
        if dark_ratio >= min_content_ratio:
            right = x + 1
            break

    # 安全检查：裁掉的不应超过每边 5%（但至少允许 30px，以支持小面板）
    max_trim = max(max(w, h) * 0.05, 30)
    if top > max_trim:
        top = 0
    if h - bottom > max_trim:
        bottom = h
    if left > max_trim:
        left = 0
    if w - right > max_trim:
        right = w

    if top > 0 or bottom < h or left > 0 or right < w:
        print(f"[GridSplitter] Outer border trimmed: "
              f"top={top}, bottom={h-bottom}, left={left}, right={w-right}")
        cropped = img.crop((left, top, right, bottom))
        return cropped, np.array(cropped.convert("L"))

    return img, gray


def remove_grid_gaps(
    grid_image: Image.Image,
    rows: int,
    cols: int,
    search_radius: int = 15,
    gap_brightness_threshold: int = 200,
    min_gap_width: int = 2,
) -> Image.Image:
    """检测并移除网格图中面板之间的空白/阴影缝隙。

    算法：
    1. 将图片转灰度 numpy 数组
    2. 在每条预期分界线附近 ±search_radius 范围内扫描，找到亮度最高的连续像素带（gap）
    3. 裁剪出各 panel（排除 gap 像素）
    4. 统一 resize 到相同尺寸后无缝拼接

    Args:
        grid_image: PIL Image 对象
        rows: 网格行数
        cols: 网格列数
        search_radius: 在预期分界线附近搜索的像素半径
        gap_brightness_threshold: 亮度高于此值的像素被视为可能的 gap
        min_gap_width: 最小 gap 宽度（像素），低于此值则忽略

    Returns:
        处理后的无缝 PIL Image
    """
    if rows <= 1 and cols <= 1:
        return grid_image

    width, height = grid_image.size
    gray = np.array(grid_image.convert("L"))

    # 裁掉外围白边
    grid_image, gray = _trim_outer_border(grid_image, gray)
    width, height = grid_image.size

    def _find_gap_range(arr_2d: np.ndarray, expected_pos: int, axis: int) -> Tuple[int, int]:
        """在预期分界线附近找到 gap 的起止位置。

        Args:
            arr_2d: 灰度数组
            expected_pos: 预期分界线位置
            axis: 0=水平线(沿y扫描), 1=竖直线(沿x扫描)

        Returns:
            (gap_start, gap_end) 如果未找到 gap 则返回 (expected_pos, expected_pos)
        """
        dim_size = arr_2d.shape[1] if axis == 1 else arr_2d.shape[0]
        lo = max(0, expected_pos - search_radius)
        hi = min(dim_size, expected_pos + search_radius + 1)

        # 计算搜索范围内每条线的平均亮度
        if axis == 1:  # 竖直线：每列沿行方向取平均
            brightness = np.mean(arr_2d[:, lo:hi], axis=0)
        else:  # 水平线：每行沿列方向取平均
            brightness = np.mean(arr_2d[lo:hi, :], axis=1)

        # 找到亮度超过阈值的连续区域
        is_bright = brightness >= gap_brightness_threshold
        if not np.any(is_bright):
            # 没有明显的亮色 gap，退回到使用方差最低的区域
            # 方差低表示颜色均匀（可能是纯色 gap）
            if axis == 1:
                variance = np.var(arr_2d[:, lo:hi].astype(float), axis=0)
            else:
                variance = np.var(arr_2d[lo:hi, :].astype(float), axis=1)

            # 找方差最低的位置附近
            min_var_idx = np.argmin(variance)
            center = lo + min_var_idx

            # 向两侧扩展，找连续的低方差区域
            var_threshold = max(variance[min_var_idx] * 3, 100)  # 方差阈值
            gap_start = center
            gap_end = center

            while gap_start > lo and variance[gap_start - lo - 1] < var_threshold:
                gap_start -= 1
            while gap_end < hi - 1 and variance[gap_end - lo + 1] < var_threshold:
                gap_end += 1

            if gap_end - gap_start + 1 < min_gap_width:
                return (expected_pos, expected_pos)
            return (gap_start, gap_end + 1)

        # 找到包含 expected_pos 附近的最大亮色连续区域
        # 标记连续区域
        regions = []
        start = None
        for i, bright in enumerate(is_bright):
            if bright and start is None:
                start = i
            elif not bright and start is not None:
                regions.append((lo + start, lo + i))
                start = None
        if start is not None:
            regions.append((lo + start, lo + len(is_bright)))

        if not regions:
            return (expected_pos, expected_pos)

        # 选择最接近 expected_pos 的区域
        best_region = min(regions, key=lambda r: abs((r[0] + r[1]) / 2 - expected_pos))

        if best_region[1] - best_region[0] < min_gap_width:
            return (expected_pos, expected_pos)

        return best_region

    # 检测竖直 gap（cols - 1 条）
    v_gaps = []
    for c in range(1, cols):
        expected_x = c * width // cols
        gap_start, gap_end = _find_gap_range(gray, expected_x, axis=1)
        v_gaps.append((gap_start, gap_end))

    # 检测水平 gap（rows - 1 条）
    h_gaps = []
    for r in range(1, rows):
        expected_y = r * height // rows
        gap_start, gap_end = _find_gap_range(gray, expected_y, axis=0)
        h_gaps.append((gap_start, gap_end))

    # 计算各 panel 的裁剪区域（排除 gap）
    # X 边界
    x_boundaries = [0]
    for gap_start, gap_end in v_gaps:
        x_boundaries.append(gap_start)  # 前一个 panel 的右边界
        x_boundaries.append(gap_end)    # 后一个 panel 的左边界
    x_boundaries.append(width)

    # Y 边界
    y_boundaries = [0]
    for gap_start, gap_end in h_gaps:
        y_boundaries.append(gap_start)
        y_boundaries.append(gap_end)
    y_boundaries.append(height)

    # 提取 panels
    panels = []
    for r in range(rows):
        y_start = y_boundaries[r * 2]
        y_end = y_boundaries[r * 2 + 1]
        for c in range(cols):
            x_start = x_boundaries[c * 2]
            x_end = x_boundaries[c * 2 + 1]
            panel = grid_image.crop((x_start, y_start, x_end, y_end))
            panels.append(panel)

    if not panels:
        return grid_image

    # 统一 resize 到相同尺寸
    target_w = width // cols
    target_h = height // rows
    resized_panels = [p.resize((target_w, target_h), Image.Resampling.LANCZOS) for p in panels]

    # 无缝拼接
    result = Image.new(grid_image.mode, (target_w * cols, target_h * rows))
    for idx, panel in enumerate(resized_panels):
        r = idx // cols
        c = idx % cols
        result.paste(panel, (c * target_w, r * target_h))

    print(f"[GridSplitter] Gap removal: {rows}x{cols} grid, "
          f"v_gaps={[(s, e) for s, e in v_gaps if s != e]}, "
          f"h_gaps={[(s, e) for s, e in h_gaps if s != e]}")

    return result


def split_grid(
    grid_image: Union[bytes, str, Path],
    output_dir: Union[str, Path],
    rows: int = 5,
    cols: int = 5,
    output_format: str = "png",
    prefix: str = "",
) -> List[Path]:
    """将网格图分割成独立分镜。

    Args:
        grid_image: 网格图（bytes、文件路径或 Path 对象）
        output_dir: 输出目录
        rows: 行数（默认 5）
        cols: 列数（默认 5）
        output_format: 输出格式（png/jpg）
        prefix: 文件名前缀（用于批量模式区分不同网格）

    Returns:
        分割后的图片路径列表（按顺序 beat_01 到 beat_N）

    Example:
        >>> # 单网格模式
        >>> paths = split_grid(
        ...     grid_image="grid.png",
        ...     output_dir="output/frames/ep001",
        ... )
        >>> print(paths[0])  # output/frames/ep001/panel_01_raw.png

        >>> # 批量模式（带前缀）
        >>> paths = split_grid(
        ...     grid_image="grid_01.png",
        ...     output_dir="output/raw",
        ...     rows=3, cols=3,
        ...     prefix="grid1_",
        ... )
        >>> print(paths[0])  # output/raw/grid1_panel_01_raw.png
    """
    # 加载图像
    if isinstance(grid_image, bytes):
        img = Image.open(io.BytesIO(grid_image))
    else:
        img = Image.open(grid_image)

    # 后处理：移除面板间缝隙
    try:
        img = remove_grid_gaps(img, rows, cols)
    except Exception as e:
        print(f"[GridSplitter] Gap removal failed, using original image: {e}")

    width, height = img.size
    print(f"[GridSplitter] Grid image size: {width}x{height}")

    # 计算每个格子的尺寸
    cell_width = width // cols
    cell_height = height // rows
    print(f"[GridSplitter] Panel size: {cell_width}x{cell_height}, grid: {rows}x{cols}")

    # 确保输出目录存在
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    output_paths = []

    for row in range(rows):
        for col in range(cols):
            beat_num = row * cols + col + 1

            # 计算裁剪区域
            left = col * cell_width
            upper = row * cell_height
            right = left + cell_width
            lower = upper + cell_height

            # 裁剪
            cell = img.crop((left, upper, right, lower))

            # 保存（支持前缀）
            output_path = output_dir / f"{prefix}panel_{beat_num:02d}_raw.{output_format}"
            cell.save(output_path)
            output_paths.append(output_path)

            print(f"[GridSplitter] Panel {beat_num}/{rows * cols}: {output_path}")

    print(f"[GridSplitter] Split complete: {len(output_paths)} panels total")
    return output_paths


def split_grid_with_padding(
    grid_image: Union[bytes, str, Path],
    output_dir: Union[str, Path],
    rows: int = 5,
    cols: int = 5,
    padding: int = 2,
    output_format: str = "png",
) -> List[Path]:
    """将网格图分割成独立分镜（考虑边距）。

    某些网格图生成时会在格子之间有边距，此函数可以处理这种情况。

    Args:
        grid_image: 网格图
        output_dir: 输出目录
        rows: 行数
        cols: 列数
        padding: 格子之间的边距（像素）
        output_format: 输出格式

    Returns:
        分割后的图片路径列表
    """
    # 加载图像
    if isinstance(grid_image, bytes):
        img = Image.open(io.BytesIO(grid_image))
    else:
        img = Image.open(grid_image)

    width, height = img.size

    # 考虑边距后计算每个格子的尺寸
    # 总宽度 = cols * cell_width + (cols - 1) * padding
    # cell_width = (width - (cols - 1) * padding) / cols
    cell_width = (width - (cols - 1) * padding) // cols
    cell_height = (height - (rows - 1) * padding) // rows

    print(f"[GridSplitter] Grid image size: {width}x{height}, padding={padding}")
    print(f"[GridSplitter] Panel size: {cell_width}x{cell_height}")

    # 确保输出目录存在
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    output_paths = []

    for row in range(rows):
        for col in range(cols):
            beat_num = row * cols + col + 1

            # 计算裁剪区域（考虑边距）
            left = col * (cell_width + padding)
            upper = row * (cell_height + padding)
            right = left + cell_width
            lower = upper + cell_height

            # 裁剪
            cell = img.crop((left, upper, right, lower))

            # 保存
            output_path = output_dir / f"beat_{beat_num:02d}_raw.{output_format}"
            cell.save(output_path)
            output_paths.append(output_path)

    print(f"[GridSplitter] Split complete: {len(output_paths)} panels total")
    return output_paths


def detect_grid_layout(
    grid_image: Union[bytes, str, Path],
    expected_rows: int = 5,
    expected_cols: int = 5,
) -> Tuple[int, int, int]:
    """检测网格布局参数。

    通过分析图像尝试检测格子之间的边距。

    Args:
        grid_image: 网格图
        expected_rows: 预期行数
        expected_cols: 预期列数

    Returns:
        (cell_width, cell_height, padding) 元组
    """
    # 加载图像
    if isinstance(grid_image, bytes):
        img = Image.open(io.BytesIO(grid_image))
    else:
        img = Image.open(grid_image)

    width, height = img.size

    # 简单计算：假设无边距
    cell_width = width // expected_cols
    cell_height = height // expected_rows
    padding = 0

    # TODO: 可以通过边缘检测来更精确地识别边距
    # 但对于 NanoBananaPro 生成的网格图，通常无边距

    return (cell_width, cell_height, padding)


def resize_frames_to_portrait(
    input_paths: List[Path],
    output_dir: Union[str, Path],
    target_width: int = 720,
    target_height: int = 1280,
    output_format: str = "png",
) -> List[Path]:
    """将方形分镜调整为竖屏比例。

    网格分割后的分镜通常是方形的，需要调整为竖屏比例（9:16）。
    使用 center crop 或 padding 来调整。

    Args:
        input_paths: 输入图片路径列表
        output_dir: 输出目录
        target_width: 目标宽度
        target_height: 目标高度
        output_format: 输出格式

    Returns:
        调整后的图片路径列表
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    output_paths = []

    for input_path in input_paths:
        img = Image.open(input_path)
        orig_width, orig_height = img.size

        # 计算目标比例
        target_ratio = target_width / target_height  # 0.5625 for 9:16
        orig_ratio = orig_width / orig_height

        if orig_ratio > target_ratio:
            # 原图更宽，需要裁剪左右
            new_width = int(orig_height * target_ratio)
            left = (orig_width - new_width) // 2
            img = img.crop((left, 0, left + new_width, orig_height))
        else:
            # 原图更高，需要裁剪上下
            new_height = int(orig_width / target_ratio)
            top = (orig_height - new_height) // 2
            img = img.crop((0, top, orig_width, top + new_height))

        # 缩放到目标尺寸
        img = img.resize((target_width, target_height), Image.Resampling.LANCZOS)

        # 保存
        output_path = output_dir / f"{input_path.stem}_resized.{output_format}"
        img.save(output_path)
        output_paths.append(output_path)

    print(f"[GridSplitter] Portrait resize complete: {len(output_paths)} images total")
    return output_paths


def combine_to_grid(
    images: List[Union[str, Path, bytes]],
    output_path: Union[str, Path],
    rows: int = 5,
    cols: int = 5,
    cell_size: Optional[Tuple[int, int]] = None,
) -> Path:
    """将多张图片合并成网格图。

    用于调试或预览。

    Args:
        images: 图片列表（路径或 bytes）
        output_path: 输出路径
        rows: 行数
        cols: 列数
        cell_size: 每个格子的尺寸 (width, height)，如果为 None 则自动计算

    Returns:
        输出路径
    """
    # 加载所有图片
    loaded_images = []
    for img_data in images:
        if isinstance(img_data, bytes):
            img = Image.open(io.BytesIO(img_data))
        else:
            img = Image.open(img_data)
        loaded_images.append(img)

    if not loaded_images:
        raise ValueError("没有图片可合并")

    # 确定格子尺寸
    if cell_size is None:
        # 使用第一张图的尺寸
        cell_size = loaded_images[0].size

    cell_width, cell_height = cell_size

    # 创建画布
    grid_width = cols * cell_width
    grid_height = rows * cell_height
    grid_img = Image.new("RGB", (grid_width, grid_height), color=(0, 0, 0))

    # 粘贴图片
    for i, img in enumerate(loaded_images):
        if i >= rows * cols:
            break

        row = i // cols
        col = i % cols

        # 调整尺寸
        img = img.resize((cell_width, cell_height), Image.Resampling.LANCZOS)

        # 粘贴
        x = col * cell_width
        y = row * cell_height
        grid_img.paste(img, (x, y))

    # 保存
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    grid_img.save(output_path)

    print(f"[GridSplitter] Combine complete: {output_path}")
    return output_path
