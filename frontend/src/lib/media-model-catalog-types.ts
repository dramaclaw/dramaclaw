/**
 * 媒体模型目录的类型及其请求形状。镜像后端 `media_model_request_schema.py`：
 * 图片 / 视频 / 白模三种类型共用一套目录，音频只做名称映射，不进目录。
 */
export const MEDIA_MODEL_CATALOG_TYPES = ["image", "video", "blockout"] as const;

export type MediaModelCatalogType = (typeof MEDIA_MODEL_CATALOG_TYPES)[number];

/** 设置页媒体模型映射可声明的类型：目录类型加上只做映射的音频。 */
export type MediaModelType = MediaModelCatalogType | "audio";

export const MEDIA_MODEL_REQUEST_ENDPOINTS: Readonly<
  Record<MediaModelCatalogType, string>
> = {
  image: "images/generations",
  video: "video/generations",
  blockout: "chat/completions",
};

export function isMediaModelCatalogType(
  value: unknown,
): value is MediaModelCatalogType {
  return (MEDIA_MODEL_CATALOG_TYPES as readonly unknown[]).includes(value);
}

export function defaultMediaModelRequest(type: MediaModelCatalogType): {
  endpoint: string;
  parameters: unknown[];
} {
  return { endpoint: MEDIA_MODEL_REQUEST_ENDPOINTS[type], parameters: [] };
}

/** 白模模型是看图写程序的对话模型，所以要的是渠道的 vision 能力，不是出图能力。 */
export function mediaModelChannelCapability(
  type: MediaModelType,
): "image" | "video" | "audio" | "vision" {
  return type === "blockout" ? "vision" : type;
}
