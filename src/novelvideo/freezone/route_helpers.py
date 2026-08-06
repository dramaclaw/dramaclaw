"""Freezone 路由辅助函数。

把 `src/novelvideo/api/routes/freezone.py` 里的纯辅助逻辑抽离出来，
让路由文件更聚焦于接口本身。
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Optional

from fastapi import HTTPException

from novelvideo.api.schemas import (
    FreezoneCharacterMultiViewRequest,
    FreezoneImageCameraConfig,
    FreezoneImageStyleConfig,
    FreezoneRelightRequest,
    FreezoneTemplateEditRequest,
)
from novelvideo.config import IMAGE_GENERATION_SELECTIONS
from novelvideo.freezone.paths import resolve_static_url_to_path, safe_upload_filename, uploads_dir
from novelvideo.freezone.video_node import load_video_character_library
from novelvideo.task_identity import task_state_key

FREEZONE_DEFAULT_IMAGE_SELECTION = "newapi_gpt_image2"
FREEZONE_DEFAULT_IMAGE_MODEL = FREEZONE_DEFAULT_IMAGE_SELECTION
SUPPORTED_FREEZONE_IMAGE_PROVIDERS = {"huimeng", "newapi", "openrouter", "openai"}
FREEZONE_IMAGE_CAMERA_OPTIONS = {
    "camera_bodies": [
        {"id": "panavision_dxl2", "label": "Panavision DXL2"},
        {"id": "arri_alexa_65", "label": "ARRI ALEXA 65"},
        {"id": "red_vraptor_xl", "label": "RED V-Raptor XL"},
        {"id": "sony_venice_2", "label": "Sony Venice 2"},
    ],
    "lenses": [
        {"id": "arri_signature_prime", "label": "Arri Signature Prime"},
        {"id": "cooke_s4i", "label": "Cooke S4/i"},
        {"id": "zeiss_supreme_prime", "label": "Zeiss Supreme Prime"},
        {"id": "panavision_primo_70", "label": "Panavision Primo 70"},
    ],
    "focal_lengths_mm": [8, 14, 24, 35, 50, 75, 125],
    "apertures": ["f/1.4", "f/2", "f/2.8", "f/4", "f/5.6", "f/8"],
}
FREEZONE_IMAGE_STYLE_TEMPLATES = [
    {
        "id": "period_idol",
        "label": "古装偶像",
        "category": "古装",
        "cover": "period_idol/cover.webp",
        "samples": [
            "period_idol/female.webp",
            "period_idol/youth.webp",
            "period_idol/male.webp",
            "period_idol/elder.webp"
        ],
        "style_prompt": "古偶唯美柔光风格，东方新古典写意浪漫，古装言情影像，ARRI Alexa Mini LF大画幅摄影机拍摄，[50/85/135mm]大光圈定焦镜头，1/8黑柔焦镜+薄雾滤镜效果。低饱和东方传统色盘，包裹式柔光布光，侧逆柔光勾勒轮廓，光比1:2低反差，高调柔影调，明暗过渡丝滑，宋式雅致美学，高通透度，强空气感，薄烟氤氲氛围，奶油焦外虚化，极细腻微胶片颗粒，宽动态范围，中低锐度边缘柔和，电影级古偶唯美质感"
    },
    {
        "id": "palace_intrigue",
        "label": "宫廷权谋",
        "category": "古装",
        "cover": "palace_intrigue/cover.webp",
        "samples": [
            "palace_intrigue/female.webp",
            "palace_intrigue/youth.webp",
            "palace_intrigue/male.webp",
            "palace_intrigue/elder.webp"
        ],
        "style_prompt": "古装宫廷权谋正剧，冷峻肃杀风格，东方写实主义极简美学，ARRI Alexa 35 摄影机拍摄，Super35 画幅，电影级质感。低明度低饱和冷调色盘；大光比硬光布光，侧逆光伦勃朗光，人物半明半暗，硬朗阴影边界，低调硬调高反差，整体压暗曝光，暗部沉实保留层次。庄重肃穆宫廷美术，哑光做旧质感，细腻中灰胶片颗粒，低通透度，淡淡焚香薄烟空气感，宽动态范围，中等偏高锐度，材质纹理清晰。整体氛围沉郁压抑，静水流深暗流涌动，权力博弈的宿命感，高级电影质感。"
    },
    {
        "id": "wuxia",
        "label": "武侠江湖",
        "category": "古装",
        "cover": "wuxia/cover.webp",
        "samples": [
            "wuxia/female.webp",
            "wuxia/youth.webp",
            "wuxia/male.webp",
            "wuxia/elder.webp"
        ],
        "style_prompt": "写实武侠江湖题材，新现实主义武侠风格，沉郁凛冽的江湖烟火气质，院线电影级画面，采用ARRI Alexa 35数字电影摄影机拍摄，Super 35画幅，库克S4/i定焦镜头，35mm柯达Vision3胶片扫描质感，自然主义光源，侧逆低调布光，伦勃朗光型，中高反差硬调影调，宽动态范围，暗部细节丰富。，粗粝写实美术，史实级中式古代场景与服饰，中等胶片颗粒，中低通透度，自然空气感与丁达尔效应，中等偏上锐度，焦外柔润，整体厚重沉稳，电影级叙事感"
    },
    {
        "id": "cn_urban",
        "label": "国产都市",
        "category": "都市",
        "cover": "cn_urban/cover.webp",
        "samples": [
            "cn_urban/female.webp",
            "cn_urban/youth.webp",
            "cn_urban/male.webp",
            "cn_urban/elder.webp"
        ],
        "style_prompt": "中国新写实主义都市剧情片，纪实美学风格，克制粗粝的本土都市质感，蔡司 CP.3 定焦镜头，35mm 焦段，自然景深；低饱和冷灰基底，小面积高饱和霓虹点缀，中低反差影调，实景自然光源布光，7-9 档明暗层级，暗部留细节高光不溢出，阴天散射光质感；低程度数字底噪，中低通透度带轻微灰雾，14 档高动态范围，中低锐度保留皮肤纹理，沉静疏离的日常氛围"
    },
    {
        "id": "urban_romance",
        "label": "都市情感",
        "category": "都市",
        "cover": "urban_romance/cover.webp",
        "samples": [
            "urban_romance/female.webp",
            "urban_romance/youth.webp",
            "urban_romance/male.webp",
            "urban_romance/elder.webp"
        ],
        "style_prompt": "韩国当代都市情感剧集影像，韩剧都市柔光风格，日常浪漫主义美学，暖柔治愈基调；ARRI Alexa Mini LF 全画幅数字摄影机，35mm 大光圈定焦镜头，1/8 黑柔焦镜，浅景深；低饱和暖调基底，奶杏米棕主色调，莫兰迪冷色点缀，软质散射光，平柔布光，低反差中高调，明暗过渡顺滑，高光柔化自然溢出，暗部保留灰阶细节；韩式简约现代美术，哑光柔润质感，圆润线条造型，细腻数字微颗粒，中高通透度，轻微空气感，宽动态范围，中低锐度，温柔治愈都市氛围感"
    },
    {
        "id": "crime_suspense",
        "label": "现实悬疑",
        "category": "都市",
        "cover": "crime_suspense/cover.webp",
        "samples": [
            "crime_suspense/female.webp",
            "crime_suspense/youth.webp",
            "crime_suspense/male.webp",
            "crime_suspense/elder.webp"
        ],
        "style_prompt": "国产社会派现实主义悬疑，冷峻克制的写实影像风格，沉郁压抑的冷调悬疑气质,ARRI Alexa Mini LF全画幅数字电影机，35mm定焦镜头，电影级浅景深,整体色彩偏沉偏冷,低调布光，大光比，侧逆光塑造人物，大面积阴影制造悬念，明暗高反差，硬调影调，暗部扎实厚重,现实主义粗粝质感，轻微均匀胶片颗粒，低通透度带轻微雾感，弱空气感，高动态范围，中等偏低锐度，厚重写实画质"
    },
    {
        "id": "korean_muted",
        "label": "韩国冷淡",
        "category": "都市",
        "cover": "korean_muted/cover.webp",
        "samples": [
            "korean_muted/female.webp",
            "korean_muted/youth.webp",
            "korean_muted/male.webp",
            "korean_muted/elder.webp"
        ],
        "style_prompt": "新现实主义写实美学，清冷克制的疏离感，ARRI Alexa Mini 拍摄，Super 35mm 传感器，35mm 定焦人文视角，克制虚化。低饱和冷灰调基底，阴天漫射侧光，低光比平柔布光，低反差中灰影调，整体欠曝 0.5 档，明暗过渡平缓。全画面哑光质感，元素精简，细腻轻微胶片颗粒，中低通透度带轻微雾感，弱空气透视，高动态范围，中等偏低锐度，边缘柔和温润。"
    },
    {
        "id": "nineties",
        "label": "90年代",
        "category": "年代",
        "cover": "nineties/cover.webp",
        "samples": [
            "nineties/female.webp",
            "nineties/youth.webp",
            "nineties/male.webp",
            "nineties/elder.webp"
        ],
        "style_prompt": "90年代新写实主义电影，现实题材纪实感，Super 16mm胶片拍摄，柯达Vision 500T 5279胶片，Arriflex SR3摄影机，手持拍摄轻微呼吸感，蔡司25mm/35mm/50mm定焦镜头，低饱和度色彩，自然光+实用光源布光，现有光效，中低反差，中间调丰富，暗部带灰雾，高光柔和暖溢，中等16mm胶片颗粒，暗部颗粒更明显，低通透度，空气带浮尘薄雾，窄动态范围，中低锐度，边缘柔和，纯胶片质感\n构图平实自然，无刻意形式感，无数码感，年代感准确"
    },
    {
        "id": "golden_age",
        "label": "黄金时代",
        "category": "年代",
        "cover": "golden_age/cover.webp",
        "samples": [
            "golden_age/female.webp",
            "golden_age/youth.webp",
            "golden_age/male.webp",
            "golden_age/elder.webp"
        ],
        "style_prompt": "美式复古好莱坞黄金时代风格，古典制片厂美学，1930s-1960s年代感，强电影叙事感，浪漫与戏剧张力并存，35mm醋酸纤维胶片，Mitchell BNC摄影机，Cooke Speed Panchro定焦镜头，模拟Technicolor特艺彩冲印工艺，中高反差影调，伦勃朗三点布光，菲涅尔聚光灯主光，高光暖调柔化，暗部沉实带灰雾，肤色暖橙细腻，Art Deco装饰艺术置景，微做旧质感，环境烟雾空气透视，中等细度35mm胶片颗粒，中低通透度薄雾感，胶片级动态范围，中等偏柔柔化锐度，优雅怀旧电影质感"
    },
    {
        "id": "documentary_realism",
        "label": "纪实写实",
        "category": "年代",
        "cover": "documentary_realism/cover.webp",
        "samples": [
            "documentary_realism/female.webp",
            "documentary_realism/youth.webp",
            "documentary_realism/male.webp",
            "documentary_realism/elder.webp"
        ],
        "style_prompt": "复古叙事电影风格，35mm胶片拍摄，ARRICAM摄影机，Cooke经典定焦镜头，诗意现实主义风格，年代剧情片质感，整体暖棕基调，低饱和中低明度色彩，侧逆柔光，伦勃朗布光，中等柔反差，中低调影调，高光柔化带暖溢，暗部保留丰富细节，灰阶过渡平滑，年代写实美术，质朴生活质感，中等细腻胶片颗粒，轻微雾感，空气透视，自然暗角，高光柔化，中等偏柔锐度，高动态范围，复古电影质感，叙事氛围感"
    },
    {
        "id": "retro_narrative",
        "label": "复古叙事",
        "category": "年代",
        "cover": "retro_narrative/cover.webp",
        "samples": [
            "retro_narrative/female.webp",
            "retro_narrative/youth.webp",
            "retro_narrative/male.webp",
            "retro_narrative/elder.webp"
        ],
        "style_prompt": "现实主义纪实风格，35mm柯达Vision彩色胶片拍摄，Arri BL4胶片摄影机，35mm标准定焦镜头，自然空间透视，纪实自然光效，中等偏粗胶片颗粒，低通透度，空气浮尘朦胧感，强空气透视纵深感，中等动态范围，偏低锐度，胶片温润质感，原生年代真实感"
    },
    {
        "id": "american_nineties",
        "label": "美式90",
        "category": "年代",
        "cover": "american_nineties/cover.webp",
        "samples": [
            "american_nineties/female.webp",
            "american_nineties/youth.webp",
            "american_nineties/male.webp",
            "american_nineties/elder.webp"
        ],
        "style_prompt": "经典复古剧情片视觉，古典好莱坞摄影美学，35mm胶片质感，沉静叙事感，怀旧厚重氛围，35mm柯达Vision3彩色电影胶片，Arriflex 535B摄影机，180°快门角度，Panavision C系列变形镜头，自然运动模糊，低饱和复古色盘，古典三点布光，低光比柔化光影，中低反差影调，暗部保留细节，高光柔和滚降，暖调高光偏移，哑光写实质感，年代经典造型，35mm胶片自然细颗粒，中等通透度，轻微空气透视，宽动态范围，中等锐度边缘柔化，电影级最终放映质感"
    },
    {
        "id": "showa_monochrome",
        "label": "昭和黑白",
        "category": "年代",
        "cover": "showa_monochrome/cover.webp",
        "samples": [
            "showa_monochrome/female.webp",
            "showa_monochrome/youth.webp",
            "showa_monochrome/male.webp",
            "showa_monochrome/elder.webp"
        ],
        "style_prompt": "日本昭和黑白电影风格，35mm黑白负片胶片拍摄，机械式胶片电影摄影机，，50mm标准定焦镜头，f/4.0中等光圈，日式写实主义，物哀美学，沉静克制的视觉基调，留白式构图，纯黑白灰阶影调，中高反差，全灰阶过渡自然，侧光与侧逆光为主，单主光+弱环境补光，柔和自然光效，暗部保留细节、亮部不过曝，写实质朴美术，35mm自然银盐颗粒，中等锐度，柔润结像，宽动态范围，自然空气透视，复古胶片质感"
    },
    {
        "id": "vintage_industrial",
        "label": "老式工业",
        "category": "年代",
        "cover": "vintage_industrial/cover.webp",
        "samples": [
            "vintage_industrial/female.webp",
            "vintage_industrial/youth.webp",
            "vintage_industrial/male.webp",
            "vintage_industrial/elder.webp"
        ],
        "style_prompt": "20 世纪中期重工业纪实影像，胶片工业美学，冷峻厚重的工业力量感；35mm 柯达 Ektachrome 彩色反转胶片，Arriflex 35 II 摄影机，Cooke Speed Panchro 镜头；低饱和度低明度；高位顶光与侧逆光结合，现场固有光源布光，硬调中高反差，暗部扎实高光柔和溢出；中等偏粗胶片颗粒，中低通透度，空间弥漫粉尘雾气带轻微丁达尔效应，中等动态范围，柔和中等锐度，真实工业纪实质感"
    },
    {
        "id": "healing_life",
        "label": "生活治愈",
        "category": "生活",
        "cover": "healing_life/cover.webp",
        "samples": [
            "healing_life/female.webp",
            "healing_life/youth.webp",
            "healing_life/male.webp",
            "healing_life/elder.webp"
        ],
        "style_prompt": "日式生活流治愈影像，整体基调静谧松弛温润，自然主义日常美学；16mm彩色负片拍摄，35mm/50mm/85mm定焦镜头组，漫射自然光为主、暖柔光为辅，软调低反差影调，明暗过渡平缓；侘寂质朴美术，细腻胶片颗粒，空气感强，宽动态范围，氛围平缓治愈，影视专业标准"
    },
    {
        "id": "youth_film",
        "label": "青春胶片",
        "category": "生活",
        "cover": "youth_film/cover.webp",
        "samples": [
            "youth_film/female.webp",
            "youth_film/youth.webp",
            "youth_film/male.webp",
            "youth_film/elder.webp"
        ],
        "style_prompt": "日式青春胶片风格，135 彩色负片，富士 C200 质感，大光圈定焦拍摄，平成青春映画美学，清新写实风格,低饱和高明度色彩，阴影青蓝色偏高光暖黄调，中低反差高调影调，宽动态范围，明暗过渡顺滑，黄金时段侧逆光，柔和自然光，漫射软光，发丝轮廓光，空气丁达尔效应,中等细腻胶片颗粒，中低锐度边缘柔和，强空气透视感，奶油焦外虚化，画面通透有呼吸感,治愈懵懂青春情绪，怀旧怅惘氛围，日常诗意感"
    },
    {
        "id": "atompunk",
        "label": "原子朋克",
        "category": "科幻",
        "cover": "atompunk/cover.webp",
        "samples": [
            "atompunk/female.webp",
            "atompunk/youth.webp",
            "atompunk/male.webp",
            "atompunk/elder.webp"
        ],
        "style_prompt": "原子朋克复古科幻，黄金时代科幻美学，1950 年代复古未来主义，前数字时代的未来幻想，冷峻工业感与浪漫人文感交织；35mm 电影胶片，Panavision C 系列变形宽银幕镜头，柯达反转片质感，轻微镜头眩光与边缘色散；高反差硬调影调，中等细度胶片颗粒，中低通透度，淡雾空气感，12 档动态范围，中等偏柔锐度，空间纵深感强，复古胶片光学质感"
    },
    {
        "id": "neon_punk",
        "label": "霓虹朋克",
        "category": "科幻",
        "cover": "neon_punk/cover.webp",
        "samples": [
            "neon_punk/female.webp",
            "neon_punk/youth.webp",
            "neon_punk/male.webp",
            "neon_punk/elder.webp"
        ],
        "style_prompt": "科幻反乌托邦赛博朋克风格，新黑色电影叙事逻辑，高科技低生活二元对立气质，冷峻迷幻的反乌托邦都市基调，ARRI Alexa Mini LF 大画幅摄影机拍摄，变形宽银幕镜头，带水平眩光与拉丝散景，14 档宽动态范围，冷暖强对冲，高饱和霓虹与低饱和环境形成对比，全人工霓虹环境光为主，蓝调时刻弱天光为辅，逆光霓虹勾勒轮廓，人物面部弱漫反射光，高反差低调影调，霓虹高光带柔和光晕，16mm 细腻胶片颗粒，中低通透度，强空气感，中等锐度，近实远虚空气透视，电影级质感"
    },
    {
        "id": "psychological_horror",
        "label": "心理恐怖",
        "category": "类型",
        "cover": "psychological_horror/cover.webp",
        "samples": [
            "psychological_horror/female.webp",
            "psychological_horror/youth.webp",
            "psychological_horror/male.webp",
            "psychological_horror/elder.webp"
        ],
        "style_prompt": "院线级恐怖电影，写实主义恐怖风格，哥特暗黑美学，日常空间异化，心理惊悚氛围，35mm胶片拍摄，ARRICAM ST摄影机，老式电影镜头，轻微暗角与呼吸效应，高反差硬调，大面积纯黑暗部，局部高光溢出，侧逆光+顶光布光，整体欠曝，衰败日常美学，恐怖元素半遮半露，中等胶片颗粒，暗部颗粒加重，低通透度，轻微灰雾，窄动态范围，中等偏低锐度，边缘柔化"
    },
    {
        "id": "cult_film",
        "label": "邪典cult",
        "category": "类型",
        "cover": "cult_film/cover.webp",
        "samples": [
            "cult_film/female.webp",
            "cult_film/youth.webp",
            "cult_film/male.webp",
            "cult_film/elder.webp"
        ],
        "style_prompt": "美式复古怪诞邪典风格，50-70年代美式复古背景，林奇式超现实悬疑，乡村哥特怪核美学，克制型心理惊悚，平静下的诡异感，35mm彩色胶片拍摄，Arriflex 35mm胶片摄影机，老式定焦镜头，轻微镜头漏光与眩光，胶片齿孔边缘，低调布光，中高反差，大面积死黑暗部，50-70年代美式复古美术，搪植入微小违和怪异细节，中等偏粗胶片颗粒，暗部颗粒加重，低通透薄雾感，窄动态范围，中心锐度中等边缘柔化，轻微胶片划痕与印片污渍，老胶片胶转磁质感"
    },
    {
        "id": "modern_warfare",
        "label": "现代战争",
        "category": "类型",
        "cover": "modern_warfare/cover.webp",
        "samples": [
            "modern_warfare/female.webp",
            "modern_warfare/youth.webp",
            "modern_warfare/male.webp",
            "modern_warfare/elder.webp"
        ],
        "style_prompt": "写实复古战争史诗画面，35mm 柯达电影胶片拍摄，潘纳维申复古变形镜头，自然胶片颗粒，轻微镜头眩光与焦外拉丝；低饱和低明度影调，高反差低调硬调，侧逆光硬光布光，冷暖光影对比；中等偏粗胶片颗粒，低通透度，强空气透视，硝烟扬尘空气介质，中等动态范围，中等锐度边缘柔化，沉郁冷峻的战场氛围，沉浸式临场感，影视级画面质感"
    },
    {
        "id": "wasteland_road",
        "label": "荒野公路",
        "category": "类型",
        "cover": "wasteland_road/cover.webp",
        "samples": [
            "wasteland_road/female.webp",
            "wasteland_road/youth.webp",
            "wasteland_road/male.webp",
            "wasteland_road/elder.webp"
        ],
        "style_prompt": "荒野叙事电影质感，新写实主义融合史诗气质，粗粝冷峻的旷野美学，ARRI Alexa Mini LF大画幅数字摄影机，变形宽银幕定焦镜头成像，14档宽动态范围，自然光效主导，黄金时刻侧逆光，中高反差硬调，暗部扎实有层次，亮部保留高光肌理，整体曝光偏沉，风化写实美术风格，中等偏粗有机胶片颗粒，中低通透度，空气尘雾感，强空气透视，自然中等锐度，电影级画面质感，氛围孤寂蛮荒"
    },
    {
        "id": "neo_chinese",
        "label": "新兴中式",
        "category": "写意",
        "cover": "neo_chinese/cover.webp",
        "samples": [
            "neo_chinese/female.webp",
            "neo_chinese/youth.webp",
            "neo_chinese/male.webp",
            "neo_chinese/elder.webp"
        ],
        "style_prompt": "电影级画面，新中式诗意写实风格，东方人文意境，阿莱Alexa Mini LF拍摄，蔡司电影定焦镜头，35mm柯达夜景胶片质感，霁蓝灰蓝冷蓝辉光，低饱和冷暖对冲，柔光布光，半明半暗留白布光，中低调影调，宽动态范围，明暗过渡柔和，细腻中等胶片颗粒，中高通透度，微弱薄雾空气感，蓝辉轻度丁达尔散射，中等柔化锐度，焦外柔和，整体静谧悠远东方禅意氛围"
    },
    {
        "id": "high_key_absurd",
        "label": "高调荒诞",
        "category": "写意",
        "cover": "high_key_absurd/cover.webp",
        "samples": [
            "high_key_absurd/female.webp",
            "high_key_absurd/youth.webp",
            "high_key_absurd/male.webp",
            "high_key_absurd/elder.webp"
        ],
        "style_prompt": "35mm胶片质感，高调荒诞美学，超现实怪诞风格，ARRICAM胶片摄影机，潘纳维申C系列变形镜头，柯达Vision3 50D彩色负片，高短调影调，大面积柔光照明，光比1:2，高明度马卡龙主色系，高饱和点缀色，明暗过渡顺滑，高光保留细节，暗部极浅无死黑，洁净规整哑光质感，几何化夸张造型，秩序化陈设，比例失调的荒诞细节，中等细腻胶片颗粒，高通透度，轻微空气感，高动态范围，中等偏高锐度，变形宽银幕散景光晕"
    }
]


def resolve_freezone_image_provider(provider: Optional[str], *, strict: bool = True) -> str:
    """把 Freezone 图片 provider 归一化到当前支持的 SuperTale 范围内。"""
    if provider and provider.strip():
        normalized = provider.strip().lower()
        if normalized not in SUPPORTED_FREEZONE_IMAGE_PROVIDERS:
            if not strict:
                return "newapi"
            raise HTTPException(
                400,
                "unsupported freezone image provider: "
                f"{provider}; expected one of {sorted(SUPPORTED_FREEZONE_IMAGE_PROVIDERS)}",
            )
        return normalized

    return "newapi"


def new_freezone_job_id() -> str:
    return uuid.uuid4().hex[:16]


def resolve_url_list(project_dir: Path, urls: list[str]) -> list[str]:
    out: list[str] = []
    for u in urls:
        if not u:
            continue
        try:
            out.append(resolve_static_url_to_path(u, project_dir).as_posix())
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    return out


def ensure_existing_paths(paths: list[str], *, field_name: str) -> None:
    """Fail fast when request URLs resolve but files do not exist on disk."""
    for path_text in paths:
        path = Path(path_text)
        if not path.exists():
            raise HTTPException(404, f"{field_name} file not found: {path}")


def accepted_job_response(
    *,
    task_type: str,
    username: str,
    project: str,
    job_id: str,
) -> dict:
    return {
        "ok": True,
        "data": {
            "task_type": task_type,
            "job_id": job_id,
            "task_key": task_state_key(task_type, username, project, episode=0, scope=job_id),
        },
    }


def get_freezone_image_camera_options() -> dict:
    return FREEZONE_IMAGE_CAMERA_OPTIONS


def get_freezone_image_style_templates() -> list[dict]:
    return list(FREEZONE_IMAGE_STYLE_TEMPLATES)


def build_camera_prompt(camera: Optional[FreezoneImageCameraConfig]) -> str:
    if camera is None:
        return ""

    parts: list[str] = []
    if str(camera.camera_body or "").strip():
        parts.append(str(camera.camera_body).strip())
    if str(camera.lens or "").strip():
        parts.append(str(camera.lens).strip())
    if camera.focal_length_mm:
        parts.append(f"{int(camera.focal_length_mm)}mm")
    if str(camera.aperture or "").strip():
        parts.append(str(camera.aperture).strip())
    if not parts:
        return ""

    return (
        "Camera setup:\n"
        f"- {' | '.join(parts)}\n"
        "- Preserve this camera language in framing, lens feel, depth rendition, and overall optical character where applicable."
    )


def merge_prompt_with_camera(prompt: str, camera: Optional[FreezoneImageCameraConfig]) -> str:
    camera_block = build_camera_prompt(camera)
    base = (prompt or "").strip()
    if base and camera_block:
        return f"{base}\n\n{camera_block}"
    if camera_block:
        return camera_block
    return base


def resolve_freezone_image_style_template(style: Optional[FreezoneImageStyleConfig]) -> Optional[dict]:
    if style is None:
        return None
    template_id = str(style.template_id or "").strip()
    if not template_id:
        return None
    for item in FREEZONE_IMAGE_STYLE_TEMPLATES:
        if item["id"] == template_id:
            return item
    raise HTTPException(400, f"unknown image style template: {template_id}")


def build_style_prompt(style: Optional[FreezoneImageStyleConfig]) -> str:
    template = resolve_freezone_image_style_template(style)
    if template is None:
        return ""
    return (
        "风格模板:\n"
        f"- {template['label']}\n"
        f"- {template['style_prompt']}"
    )


def merge_prompt_with_style_and_camera(
    prompt: str,
    style: Optional[FreezoneImageStyleConfig],
    camera: Optional[FreezoneImageCameraConfig],
) -> str:
    base = (prompt or "").strip()
    style_block = build_style_prompt(style)
    camera_block = build_camera_prompt(camera)
    parts = [part for part in [base, style_block, camera_block] if part]
    return "\n\n".join(parts)


def load_video_character_items_by_ids(project_dir: Path, ids: list[str]) -> list[dict]:
    if not ids:
        return []
    items = load_video_character_library(project_dir)
    mapping = {str(item.get("id")): item for item in items}
    missing = [item_id for item_id in ids if item_id not in mapping]
    if missing:
        raise HTTPException(404, f"video character library item not found: {missing[0]}")
    return [mapping[item_id] for item_id in ids]


def split_provider_and_model(
    provider: Optional[str],
    model: Optional[str],
    *,
    fallback_model: Optional[str] = None,
) -> tuple[Optional[str], Optional[str]]:
    """解析 Freezone 图片模型。"""
    model_text = str(model or "").strip()
    if model_text:
        if model_text in IMAGE_GENERATION_SELECTIONS:
            entry = IMAGE_GENERATION_SELECTIONS[model_text]
            return entry["provider"], entry["model"]

    if provider:
        return provider, model_text or fallback_model
    if model_text and "/" in model_text:
        provider_token, model_token = model_text.split("/", 1)
        if provider_token in SUPPORTED_FREEZONE_IMAGE_PROVIDERS:
            return provider_token, model_token or fallback_model
    return provider, model_text or fallback_model


def start_freezone_gen_job(
    *,
    username: str,
    project: str,
    project_dir: Path,
    output_dir: Path,
    prompt: str,
    aspect_ratio: str,
    image_size: str,
    reference_urls: list[str],
    camera: Optional[FreezoneImageCameraConfig],
    style: Optional[FreezoneImageStyleConfig],
    provider: Optional[str],
    model: Optional[str],
    quality: Optional[str],
    canvas_id: Optional[str] = None,
    node_id: Optional[str] = None,
) -> dict:
    reference_paths = resolve_url_list(project_dir, reference_urls)
    ensure_existing_paths(reference_paths, field_name="reference")

    raise HTTPException(503, "freezone gen task requires project task backend（当前 runner: Celery）")


def start_freezone_edit_job(
    *,
    username: str,
    project: str,
    project_dir: Path,
    output_dir: Path,
    prompt: str,
    base_url: str,
    extra_reference_urls: list[str],
    aspect_ratio: str,
    image_size: str,
    camera: Optional[FreezoneImageCameraConfig],
    style: Optional[FreezoneImageStyleConfig],
    provider: Optional[str],
    model: Optional[str],
    quality: Optional[str],
    canvas_id: Optional[str] = None,
    node_id: Optional[str] = None,
) -> dict:
    base_paths = resolve_url_list(project_dir, [base_url])
    if not base_paths:
        raise HTTPException(400, "base_url is required")
    ensure_existing_paths(base_paths, field_name="base")
    extra_paths = resolve_url_list(project_dir, extra_reference_urls)
    ensure_existing_paths(extra_paths, field_name="reference")

    raise HTTPException(503, "freezone edit task requires project task backend（当前 runner: Celery）")


def notes_suffix(*, style: str, notes: str, user_prompt: str) -> str:
    lines = [f"Style: {style}."]
    if notes.strip():
        lines.append(f"Extra notes: {notes.strip()}.")
    if user_prompt.strip():
        lines.append(f"User prompt:\n{user_prompt.strip()}")
    lines.extend(
        [
            "",
            "Hard requirements:",
            "- Production-ready SuperTale asset candidate.",
            "- No text, watermark, UI frame, contact sheet, or collage unless explicitly requested.",
            "- Preserve useful identity / scene / prop cues from references.",
        ]
    )
    return "\n".join(lines)


def infer_scene_id_from_master_path(path: Path, project_dir: Path) -> str:
    try:
        rel_parts = path.relative_to(project_dir).parts
    except ValueError:
        rel_parts = path.parts
    for index in range(len(rel_parts) - 1):
        if rel_parts[index] == "scenes" and index + 1 < len(rel_parts):
            return rel_parts[index + 1]
    return path.parent.name or "the target scene"


def build_scene_360_prompt(scene_id: str) -> str:
    normalized_scene_id = (scene_id or "").strip() or "the target scene"
    return (
        f"Generate a 360-degree equirectangular panorama image in exact 2:1 "
        f"aspect ratio for scene `{normalized_scene_id}`.\n\n"
        "INPUT IMAGE ROLE:\n"
        "- Reference image 1 = MASTER VISUAL BIBLE.\n"
        "- It controls art style, material style, linework, color palette, lighting mood, and fixed scene design.\n"
        "- Reference image 1 is NOT the final camera view.\n"
        "- Do NOT copy its single frontal composition. Use it only as visual/style/material evidence while constructing a full 360-degree continuous environment.\n\n"
        "LAYER MODE: FULL ENVIRONMENT\n"
        "- Generate the complete environment and fixed fixtures only.\n"
        "- No people, no characters, no story action, and no temporary story props.\n\n"
        "PROJECTION REQUIREMENTS:\n"
        "- Correct equirectangular spherical panorama projection.\n"
        "- Output must be one continuous 2:1 panorama, suitable for a VR/360 panorama viewer.\n"
        "- Camera is fixed at the center of the scene at normal human eye height.\n"
        "- Full 360-degree environment around the camera.\n"
        "- Left and right edges must connect seamlessly with no visible seam.\n"
        "- Horizon must be level and centered.\n"
        "- Use normal VR panorama projection: no single flat wide shot, no cubemap atlas, no borders, no multi-panel sheet.\n"
        "- Geometry must remain stable after spherical wrapping.\n"
        "- Ceiling and floor poles must be clean continuous surfaces, with no black holes, labels, mirrors, sliced objects, or heavy stretching.\n\n"
        "NEGATIVE REQUIREMENTS:\n"
        "- Not a normal wide-angle illustration.\n"
        "- Not fisheye lens.\n"
        "- Not cubemap faces.\n"
        "- No labels, no UI, no watermark.\n"
        "- No broken seam, no duplicated doorway at seam, no mirrored left/right halves.\n"
        "- No photorealism drift if the reference is stylized."
    )


def build_multi_view_prompt(body: FreezoneCharacterMultiViewRequest) -> str:
    preset_map = {
        "custom": "custom camera reposition",
        "fisheye": "fisheye angle",
        "oblique": "oblique angle",
        "front": "front-facing shot",
        "front_up": "front low-angle shot",
        "full_body": "full-body shot",
        "back": "back view shot",
    }
    shot_size_map = {
        "extreme_close_up": "extreme close-up",
        "close_up": "close-up",
        "medium_close": "medium close-up",
        "medium": "medium shot",
        "full_body": "full-body shot",
        "wide": "wide shot",
        "extreme_wide": "extreme wide shot",
    }
    preset_text = preset_map.get(body.preset, "custom camera reposition")
    shot_size_text = shot_size_map.get(body.shot_size, "medium shot")
    user_block = f"\nUser prompt:\n{body.prompt.strip()}" if body.prompt.strip() else ""
    return (
        "Reframe the provided source image into a new camera angle while preserving the same scene, "
        "same characters, same identities, same costume continuity, and same lighting logic unless explicitly changed.\n\n"
        f"Preset target: {preset_text}.\n"
        f"Horizontal rotation: {body.yaw_degrees:.1f} degrees.\n"
        f"Vertical tilt: {body.pitch_degrees:.1f} degrees.\n"
        f"Shot size: {shot_size_text}.\n"
        f"{user_block}\n\n"
        "Output requirements:\n"
        "- Keep the image as one single final frame, not a contact sheet.\n"
        "- Preserve facial identity and scene continuity.\n"
        "- Infer plausible unseen content when the requested angle reveals new areas.\n"
        "- Do not add text, UI, borders, watermark, or collage layout.\n"
        "- Keep the result production-ready and visually coherent."
    )


def _describe_color_temperature(kelvin: int | None) -> str | None:
    if kelvin is None:
        return None
    if kelvin < 2400:
        tone = "very warm candlelight / firelight"
    elif kelvin < 3500:
        tone = "warm tungsten / amber practical light"
    elif kelvin < 5000:
        tone = "soft warm white light"
    elif kelvin < 6200:
        tone = "neutral daylight-balanced white light"
    elif kelvin < 8000:
        tone = "cool white daylight"
    else:
        tone = "very cool blue-hour / overcast light"
    return f"{kelvin}K ({tone})"


def build_relight_prompt(body: FreezoneRelightRequest) -> str:
    base = (body.prompt or "").strip()
    reference_block = (
        "- Reference image 2 = lighting reference image.\n"
        "- Use it to transfer the lighting mood, contrast, exposure logic, shadow behavior, and color temperature.\n"
        if body.lighting_reference_url
        else "- No lighting reference image is attached. Infer the lighting design from the requested controls.\n"
    )
    smart_block = "enabled" if body.smart_mode else "disabled"
    rim_block = "enabled" if body.rim_light else "disabled"
    color_temperature = _describe_color_temperature(body.color_temperature_kelvin)
    color_temperature_control = (
        f"\n- Color temperature: {color_temperature}." if color_temperature else ""
    )
    prefix = f"""Relight the provided source image.

INPUT IMAGE ROLES:
- Reference image 1 = source image to be relit.
{reference_block}

RELIGHT CONTROLS:
- Scope: {body.scope}.
- Smart mode: {smart_block}.
- Brightness: {body.brightness}/100.
- Key light color / overall color tone: {body.color_hex}.{color_temperature_control}
- Key light direction: {body.key_light_direction}.
- Rim light: {rim_block}.

RELIGHTING CONTRACT:
- Keep the same scene, same subjects, same camera framing, and same composition.
- Preserve facial identity, costume continuity, and environment layout.
- Transfer or infer only the lighting characteristics: light direction, softness/hardness, contrast ratio, color temperature, shadow density, highlight behavior, and overall mood.
- Do not turn the image into a different scene.
- Do not add text, watermark, UI, borders, or collage layout.
- Keep the result production-ready and visually coherent."""
    return f"{prefix}\n\n{base}" if base else prefix


def build_template_edit_prompt(body: FreezoneTemplateEditRequest) -> str:
    user_block = f"\n\nUser prompt:\n{body.prompt.strip()}" if body.prompt.strip() else ""
    templates: dict[str, tuple[str, str]] = {
        "multi_camera_nine_grid": (
            "original",
            "Generate a libtv-style 3x3 director multi-camera contact sheet from the source image.\n\n"
            "Output requirements:\n"
            "- Final output must be one readable 3x3 grid contact sheet, not nine separate images.\n"
            "- Keep the same primary subject, same costume, same scene, same time moment, and same action.\n"
            "- Do not add new characters, new dialogue, new story events, or unrelated props.\n"
            "- Each cell must preserve the source image aspect ratio and orientation.\n"
            "- Do not crop each camera view into a different ratio.\n"
            "- Vary only camera coverage: shot size, camera height, lens distance, and angle.\n"
            "- Each panel must look like a usable director coverage frame from the same shot setup.\n"
            "- Add a small white label in the upper-left corner of every cell.\n"
            "- Use exactly these nine labels and shot types in reading order:\n"
            "  [KF1 | 3s | ELS] extreme long shot / full environment,\n"
            "  [KF2 | 2s | LS] long shot / full body,\n"
            "  [KF3 | 2s | MLS] medium long shot,\n"
            "  [KF4 | 2s | MS] medium shot,\n"
            "  [KF5 | 2s | MCU] medium close-up,\n"
            "  [KF6 | 2s | CU] close-up,\n"
            "  [KF7 | 1s | ECU] extreme close-up of the key hand/object/detail,\n"
            "  [KF8 | 2s | High-Angle] high-angle view,\n"
            "  [KF9 | 2s | Low-Angle] low-angle view.\n"
            "- Use thin dark grid lines between cells; no large white gutters, no decorative border.\n"
            "- Fill the whole output canvas; do not add black bars, letterboxing, UI, or watermark.\n"
            "- Preserve identity, costume, lighting mood, color tone, and scene continuity across all cells.",
        ),
        "story_pitch_four_grid": (
            "original",
            "Generate a 2x2 story pitch board from the source image.\n\n"
            "Output requirements:\n"
            "- Create four consecutive pitch frames that expand the current story moment.\n"
            "- Keep the same characters, scene, and dramatic context.\n"
            "- Emphasize clear story progression and emotional beats.\n"
            "- Each cell must preserve the source image aspect ratio and orientation.\n"
            "- Do not crop each story frame into a different ratio.\n"
            "- Arrange the four same-ratio frames in a clean 2x2 grid with thin dividers.\n"
            "- Fill the whole output canvas; do not add black bars, letterboxing, UI, or watermark.",
        ),
        "character_face_three_view": (
            "3:2",
            "Generate a clean three-view face sheet from the source image.\n\n"
            "Output requirements:\n"
            "- Show front view, three-quarter view, and side view of the same face.\n"
            "- Preserve facial identity, age, hairstyle, skin tone, and expression logic.\n"
            "- Use a clean reference-sheet style.\n"
            "- Final output must be a compact three-view face layout.",
        ),
        "product_three_view": (
            "3:2",
            "Generate a clean three-view product reference sheet from the source image.\n\n"
            "Output requirements:\n"
            "- Show front, side, and back/alternate view of the same product.\n"
            "- Preserve materials, silhouette, proportions, and key details.\n"
            "- Use a clean product reference layout with neutral presentation.\n"
            "- Final output must be a three-view sheet.",
        ),
        "storyboard_25_grid": (
            "original",
            "Generate a libtv-style 5x5 cinematic storyboard shot sequence from the source image.\n\n"
            "Output requirements:\n"
            "- Final output must be one readable 5x5 storyboard contact sheet, not 25 separate images.\n"
            "- Build a coherent shot progression around the same core event in the source image.\n"
            "- Do not create random variants, unrelated future scenes, or a new ending.\n"
            "- Preserve the visible subjects, identities, costumes/materials, environment, lighting mood, "
            "and key objects from the source image.\n"
            "- Adapt the sequence to the actual source content. Do not invent dialogue, extra characters, "
            "paper, weapons, vehicles, or props that are not visible or strongly implied.\n"
            "- Organize the 25 cells like an editable film sequence:\n"
            "  1-3 establishing coverage of the location, subject placement, and spatial relationship,\n"
            "  4-6 primary subject close-ups, detail views, or reaction shots when characters exist,\n"
            "  7-10 alternate angles, over-the-shoulder or eye-line coverage only when applicable,\n"
            "  11-15 step-by-step progression of the visible key action or the most plausible next micro-action,\n"
            "  16-19 inserts and extreme close-ups of visible key details: hands, face, eyes, object, "
            "texture, signage, machinery, landscape feature, or environment clue,\n"
            "  20-22 pause, reaction, consequence, or atmospheric detail beats,\n"
            "  23-25 restrained resolution frames that stay in the same scene and subject context.\n"
            "- Mix shot types deliberately: wide, medium, close-up, extreme close-up, insert, reaction/detail. "
            "Use OTS only when the source contains a valid over-shoulder relationship.\n"
            "- Avoid repeating the same two-shot or portrait composition across many cells.\n"
            "- Number each cell unobtrusively in the upper-left corner from 1 to 25.\n"
            "- Each cell must preserve the source image aspect ratio and orientation.\n"
            "- Do not crop each storyboard frame into a different ratio.\n"
            "- Arrange the twenty-five same-ratio frames in a clean 5x5 grid with thin dividers.\n"
            "- Fill the whole output canvas; do not add black bars, letterboxing, UI, or watermark.",
        ),
        "cinematic_light_correction": (
            "original",
            "Cinematically refine the source image lighting.\n\n"
            "Output requirements:\n"
            "- Improve light hierarchy, shadow structure, exposure balance, and atmosphere.\n"
            "- Preserve the source image aspect ratio, canvas dimensions, and orientation exactly.\n"
            "- Keep the same scene, same characters, and same camera framing.\n"
            "- Do not turn the image into a different composition.\n"
            "- Fill the whole existing canvas; do not add black bars, borders, or letterboxing.\n"
            "- Final output must remain a single frame with no collage, UI, watermark, or text.",
        ),
        "character_three_view_generation": (
            "16:9",
            "Generate a clean character three-view sheet from the source image.\n\n"
            "Output requirements:\n"
            "- Show front, side, and back/full-figure view of the same character.\n"
            "- Preserve face identity, body proportions, costume details, and style.\n"
            "- Keep the presentation clean and reference-friendly.\n"
            "- Final output must be a three-view character sheet.",
        ),
        "image_projection_after_3s": (
            "original",
            "Create a future keyframe from the source image, as if this is a libtv-style "
            "frame projection 3 seconds later in a video.\n\n"
            "Output requirements:\n"
            "- Preserve character identity, costume, environment, art style, and story continuity.\n"
            "- Preserve the source image aspect ratio, canvas dimensions, and orientation exactly.\n"
            "- Fill the whole existing canvas; do not add black bars, borders, or letterboxing.\n"
            "- Do not make a near-duplicate or simple retouch of the source image.\n"
            "- Create a clear time jump: the subject must be in a different action phase, "
            "body pose, walking position, hand position, gaze, and object placement.\n"
            "- Within the same frame size, use plausible camera pan, tilt, push, pull, or subject "
            "relocation to make the temporal change obvious.\n"
            "- Allow doors, props, cloth, hair, shadows, and nearby environment details to change "
            "according to the action, while keeping spatial continuity coherent.\n"
            "- The projected moment should feel like a real adjacent video frame, not a retouched still.\n"
            "- Final output must be one single frame with no collage, UI, watermark, or text.",
        ),
        "image_projection_before_5s": (
            "original",
            "Create a past keyframe from the source image, as if this is a libtv-style "
            "frame projection 5 seconds before in a video.\n\n"
            "Output requirements:\n"
            "- Preserve character identity, costume, environment, art style, and story continuity.\n"
            "- Preserve the source image aspect ratio, canvas dimensions, and orientation exactly.\n"
            "- Fill the whole existing canvas; do not add black bars, borders, or letterboxing.\n"
            "- Do not make a near-duplicate or simple retouch of the source image.\n"
            "- Create a clear earlier setup: the subject must be in a different action phase, "
            "body pose, walking position, hand position, gaze, and object placement.\n"
            "- Within the same frame size, use plausible camera pan, tilt, push, pull, or subject "
            "relocation to make the earlier moment obvious.\n"
            "- Allow doors, props, cloth, hair, shadows, and nearby environment details to change "
            "according to the preceding action, while keeping spatial continuity coherent.\n"
            "- The projected moment should feel like a real adjacent video frame, not a retouched still.\n"
            "- Final output must be one single frame with no collage, UI, watermark, or text.",
        ),
    }
    template = templates.get(body.mode)
    if not template:
        raise HTTPException(400, f"unsupported template edit mode: {body.mode}")
    _, prompt = template
    return f"{prompt}{user_block}"


def template_edit_aspect_ratio(mode: str) -> str:
    ratios: dict[str, str] = {
        "multi_camera_nine_grid": "original",
        "story_pitch_four_grid": "original",
        "character_face_three_view": "3:2",
        "product_three_view": "3:2",
        "storyboard_25_grid": "original",
        "cinematic_light_correction": "original",
        "character_three_view_generation": "16:9",
        "image_projection_after_3s": "original",
        "image_projection_before_5s": "original",
    }
    return ratios.get(mode, "16:9")


def parse_aspect_ratio(value: str) -> tuple[int, int]:
    text = str(value or "").strip().replace("-", ":").replace(" ", "")
    try:
        w_text, h_text = text.split(":", 1)
        w = int(w_text)
        h = int(h_text)
    except (AttributeError, TypeError, ValueError) as exc:
        raise HTTPException(400, f"invalid aspect_ratio: {value!r}") from exc
    if w <= 0 or h <= 0:
        raise HTTPException(400, f"invalid aspect_ratio: {value!r}")
    return w, h


def prepare_padded_outpaint_base(
    *,
    source_path: Path,
    project_dir: Path,
    target_aspect_ratio: str,
) -> Path:
    """先给原图补白到更大的画布，再让基于 edit 的 outpaint 能向外扩展。"""
    from PIL import Image

    src = source_path
    if not src.exists():
        raise HTTPException(404, f"source not found: {src}")

    target_w_ratio, target_h_ratio = parse_aspect_ratio(target_aspect_ratio)
    with Image.open(src) as image:
        image_rgba = image.convert("RGBA")
        width, height = image_rgba.size
        if width <= 0 or height <= 0:
            raise HTTPException(400, f"invalid source image size: {src}")

        current_ratio = width / height
        target_ratio = target_w_ratio / target_h_ratio
        if abs(current_ratio - target_ratio) < 1e-4:
            return src

        if current_ratio > target_ratio:
            canvas_width = width
            canvas_height = max(height, round(width / target_ratio))
        else:
            canvas_height = height
            canvas_width = max(width, round(height * target_ratio))

        canvas = Image.new("RGBA", (canvas_width, canvas_height), (255, 255, 255, 0))
        offset_x = (canvas_width - width) // 2
        offset_y = (canvas_height - height) // 2
        canvas.alpha_composite(image_rgba, (offset_x, offset_y))

        padded_name = safe_upload_filename(f"outpaint_base_{src.stem}.png")
        padded_path = uploads_dir(project_dir) / padded_name
        padded_path.parent.mkdir(parents=True, exist_ok=True)
        canvas.save(padded_path, format="PNG")
        return padded_path


def resolve_outpaint_aspect_ratio(source_path: Path, target_aspect_ratio: str) -> str:
    if str(target_aspect_ratio or "").strip().lower() != "original":
        return target_aspect_ratio
    from math import gcd

    from PIL import Image

    with Image.open(source_path) as image:
        width, height = image.size
    if width <= 0 or height <= 0:
        raise HTTPException(400, f"invalid source image size: {source_path}")

    normalized_gcd = gcd(width, height)
    normalized_ratio = f"{width // normalized_gcd}:{height // normalized_gcd}"
    supported_ratios = {
        "1:1",
        "3:2",
        "2:3",
        "16:9",
        "9:16",
        "5:4",
        "4:5",
        "4:3",
        "3:4",
        "21:9",
        "9:21",
        "1:3",
        "3:1",
        "2:1",
        "1:2",
    }
    if normalized_ratio in supported_ratios:
        return normalized_ratio

    current_ratio = width / height
    closest_ratio = min(
        supported_ratios,
        key=lambda ratio: abs((parse_aspect_ratio(ratio)[0] / parse_aspect_ratio(ratio)[1]) - current_ratio),
    )
    return closest_ratio


def build_outpaint_prompt() -> str:
    return (
        "Extend the existing image outward beyond its current borders. "
        "Preserve the original composition, subject identity, style, and camera framing in the center. "
        "Fill only the newly added outer canvas areas naturally and seamlessly. "
        "Do not crop, stretch, or replace the original visible content."
    )


def build_redraw_prompt(prompt: str) -> str:
    base = (prompt or "").strip()
    prefix = (
        "Redraw and refine the provided image while preserving the core composition, subject identity, "
        "camera angle, and scene intent unless the prompt explicitly asks for changes."
    )
    return f"{prefix}\n\n{base}" if base else prefix


def build_erase_prompt() -> str:
    return (
        "Remove the content inside the masked region and fill it in naturally. "
        "Preserve the surrounding composition, subject identity, lighting, perspective, and image style. "
        "The regenerated area must blend seamlessly with nearby pixels and should not leave obvious "
        "repair traces, repeated textures, or artifacts."
    )


def build_upscale_prompt() -> str:
    return (
        "Upscale and restore the image while preserving the original composition, subject identity, "
        "lighting, perspective, and style. Improve sharpness, edge definition, material detail, "
        "skin and fabric texture fidelity, and overall clarity naturally. Do not redesign the image, "
        "change the framing, alter the subject, or introduce extra objects, text, watermark, or artifacts."
    )


def resolve_upscale_dimensions(source_path: Path, scale_factor: int) -> tuple[int, int]:
    from PIL import Image

    with Image.open(source_path) as image:
        width, height = image.size
    if width <= 0 or height <= 0:
        raise HTTPException(400, f"invalid source image size: {source_path}")
    return width * scale_factor, height * scale_factor
