/**
 * 媒体模型目录的类型及其请求形状。镜像后端 `media_model_request_schema.py`：
 * 图片、视频、音频和白模均可在本地目录中管理。
 */
export const MEDIA_MODEL_CATALOG_TYPES = ["image", "video", "audio", "blockout"] as const;

export type MediaModelCatalogType = (typeof MEDIA_MODEL_CATALOG_TYPES)[number];

export type ModelPickerGuide = Partial<Record<"zh" | "en" | "pt" | "vi", {
  summary?: string;
  detail?: string;
  tags?: string[];
}>>;

export interface ModelGuideData {
  pickerGuide?: ModelPickerGuide;
  resolutionOptions?: readonly string[] | null;
  ratioOptions?: readonly string[] | null;
  minDuration?: number | null;
  maxDuration?: number | null;
  referenceImageMax?: number | null;
  referenceVideoMax?: number | null;
  supportsGenerateAudio?: boolean;
}

export type MediaModelType = MediaModelCatalogType;

export const MEDIA_MODEL_REQUEST_ENDPOINTS: Readonly<
  Record<MediaModelCatalogType, string>
> = {
  image: "images/generations",
  video: "video/generations",
  audio: "audio/speech",
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
