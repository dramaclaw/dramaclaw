"""风格分析器 - 从参考图片自动提取风格预设。"""

import asyncio
import io
import os

from PIL import Image
from pydantic import BaseModel, Field
from pydantic_ai import Agent, ImageUrl


class StyleAnalysisResult(BaseModel):
    """结构化风格分析结果。"""

    style_instructions: str = Field(
        description="Positive prompt for reproducing the visual style."
    )
    avoid_instructions: str = Field(
        description="Negative prompt protecting the visual style."
    )
    style_tag: str = Field(description="Short uppercase medium/finish tag.")
    suggested_name: str = Field(description="Concise English style name.")
    suggested_label: str = Field(description="Chinese display label.")


class StyleAnalyzer:
    """分析参考图片，自动提取风格预设。"""

    ANALYSIS_PROMPT = """You are a visual style analyst for an AI image generation system.

Analyze this image's visual style and generate two sets of prompts for reproducing this style:

1. **style_instructions**: A detailed positive prompt describing how to recreate this visual style.
   Include: rendering technique, color palette, lighting setup, texture quality, camera/lens feel,
   atmosphere/mood. Write as action instructions starting with "Create...".
   Keep it under 100 words — specific enough to anchor the style, concise enough to avoid context dilution.

2. **avoid_instructions**: A negative prompt listing what to FORBID to protect this style.
   Use "FORBIDDEN:" prefix. List conflicting styles, unwanted artifacts, and quality issues.
   Keep it under 60 words.

3. **style_tag**: A short 2-4 word uppercase tag injected near EVERY generated panel.
   Describe ONLY the medium and the grade/finish (lens feel, color grade, rendering quality).
   It must NOT carry era, period, location, wardrobe, ethnicity, or any story content — those
   come from the beat/scene/character/prop, and a per-panel tag would silently override them.
   FORBIDDEN words: PERIOD, REPUBLICAN, ERA, DYNASTY, MODERN, ANCIENT, DRAMA, 古装, 民国.
   Good examples: "CINEMATIC FILMIC REALISM", "NATURAL PHOTOREALISTIC, CLEAN GRADE", "3D GUOMAN FANTASY".

4. **suggested_name**: A concise English name for this style (e.g. "Watercolor Fantasy").

5. **suggested_label**: A Chinese display label (e.g. "水彩幻想风").

Return ONLY valid JSON with no markdown formatting:
{
  "style_instructions": "...",
  "avoid_instructions": "...",
  "style_tag": "...",
  "suggested_name": "...",
  "suggested_label": "..."
}"""

    def __init__(
        self,
        model: str | None = None,
    ):
        from novelvideo.config import get_newapi_text_pydantic_model

        self.model = (
            model
            or os.environ.get("STYLE_ANALYZER_MODEL", "").strip()
            or "gemini-3.5-flash"
        )
        self.agent = Agent(
            get_newapi_text_pydantic_model("STYLE_ANALYZER_MODEL", self.model),
            system_prompt="You analyze reference images and return reusable visual style settings.",
            output_type=StyleAnalysisResult,
            name="Style Analyzer",
        )

    async def analyze(self, image_bytes: bytes, mime_type: str = "image/jpeg") -> dict:
        """分析图片，返回风格预设字段。

        Args:
            image_bytes: 图片二进制数据
            mime_type: MIME 类型

        Returns:
            包含风格字段的字典
        """
        from novelvideo.storage.media_relay import upload_image_bytes

        # 压缩图片以减少 token 消耗
        compressed_bytes, _compressed_mime = self._compress_image(image_bytes)
        image_url = await asyncio.to_thread(upload_image_bytes, compressed_bytes, ext="jpg")

        response = await self.agent.run(
            [
                self.ANALYSIS_PROMPT,
                ImageUrl(url=image_url, media_type="image/jpeg"),
            ]
        )
        return response.output.model_dump()

    @staticmethod
    def _compress_image(
        image_bytes: bytes, max_size: int = 1024, quality: int = 60
    ) -> tuple[bytes, str]:
        """压缩图片用于 API 调用。

        Args:
            image_bytes: 原始图片数据
            max_size: 最大边长（像素）
            quality: JPEG 质量（默认 60，与项目其他 Gemini 调用一致）

        Returns:
            (压缩后数据, MIME 类型)
        """
        img = Image.open(io.BytesIO(image_bytes))
        original_size = len(image_bytes)

        # 缩放到合理尺寸
        if max(img.size) > max_size:
            img.thumbnail((max_size, max_size), Image.LANCZOS)

        # 转为 JPEG
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")

        buffer = io.BytesIO()
        img.save(buffer, format="JPEG", quality=quality, optimize=True)
        compressed_data = buffer.getvalue()

        compressed_size = len(compressed_data)
        ratio = (1 - compressed_size / original_size) * 100
        print(f"[StyleAnalyzer compress] "
              f"{original_size/1024:.0f}KB → {compressed_size/1024:.0f}KB "
              f"({ratio:.0f}% smaller)")

        return compressed_data, "image/jpeg"
