// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// 资产库的条目模型与类目定义。弹窗(AssetLibraryModal，选参考图用)和 Freezone 左侧
// 面板的「资产库」tab 共用这里，类目和归一化逻辑只有一份，避免两边漂移。
// 这里只放纯数据推导，调接口的写操作(上传/改名/删除/同步)一律留在各自组件里。
import type {
  FreezoneAssetLibraryCategory,
  FreezoneAssetLibraryFolder,
  FreezoneAssetLibraryMedia,
  FreezoneAssetLibrarySource,
} from '@/api/ops';

export const ASSET_LIBRARY_CARD_CLASS =
  'overflow-hidden rounded-sm border border-border bg-muted/30 transition-colors';
export const ASSET_LIBRARY_CARD_HOVER_CLASS =
  'hover:border-primary/35 hover:bg-accent';

export type AssetLibraryMedia = FreezoneAssetLibraryMedia;

export interface LibraryItem {
  id: string | null;
  name: string;
  media: AssetLibraryMedia;
  source: FreezoneAssetLibrarySource;
  /** 用途类目（标签）。老条目后端不返回时按 source/media 兜底推导，见 deriveCategory。 */
  category: AssetCategory;
  /** 保存位置（文件夹 key）。老条目没有该字段时按类目归位，见 deriveFolder。 */
  folder: AssetFolderKey;
  /** 该条目在其 media 类型下的主展示 / 引用地址。 */
  url: string;
  raw: Record<string, unknown>;
}

/** 资产名长度上限，与后端 LIBRARY_ITEM_NAME_MAX_LEN 一致。 */
export const LIBRARY_ITEM_NAME_MAX_LEN = 60;

const FILE_EXTENSION_PATTERN = /\.([a-z0-9]{2,5})$/i;
const MEDIA_FALLBACK_EXTENSION: Record<AssetLibraryMedia, string> = {
  image: 'png',
  video: 'mp4',
  audio: 'mp3',
};

/**
 * 下载时给素材起的文件名：资产名 + 从 URL 推出来的后缀。
 *
 * 资产名是用户随手填的，可能带 `/`、`\`、`:` 之类会被系统当路径分隔符的字符，
 * 一律换成 `_`；名字整个被洗空时退回媒介名，总之不能生成一个空文件名。
 */
export function libraryItemDownloadFilename(entry: LibraryItem): string {
  const path = entry.url.split(/[?#]/, 1)[0] ?? '';
  const extension =
    FILE_EXTENSION_PATTERN.exec(path)?.[1]?.toLowerCase() ??
    MEDIA_FALLBACK_EXTENSION[entry.media];
  const base =
    entry.name.replace(/[\\/:*?"<>|]+/g, '_').trim() || entry.media;
  // 名字自己就带对后缀时不再叠一层（「封面.png」不该下成「封面.png.png」）。
  return base.toLowerCase().endsWith(`.${extension}`)
    ? base
    : `${base}.${extension}`;
}

/**
 * 资产类目。分类不再按媒介（图片/视频/音频）切，而是按用途切——同一个类目下
 * 图片、视频、音频都可能有。`audio`（音效）是唯一天然只装音频的类目。
 */
export type AssetCategory = FreezoneAssetLibraryCategory;

export interface AssetCategoryDef {
  key: AssetCategory;
  label: string;
  /** 该类目收哪些媒介的文件——决定上传时的 accept 与提示文案。 */
  media: AssetLibraryMedia[];
}

export const ASSET_CATEGORIES: AssetCategoryDef[] = [
  { key: 'other', label: '其它', media: ['image', 'video'] },
  { key: 'character', label: '人物', media: ['image', 'video'] },
  { key: 'scene', label: '场景', media: ['image', 'video'] },
  { key: 'prop', label: '物品', media: ['image', 'video'] },
  { key: 'style', label: '风格', media: ['image', 'video'] },
  { key: 'audio', label: '音效', media: ['audio'] },
];

/** 「全部」页签的 key，和类目 key 同处一个 tab 条上，所以单独留一个字面量。 */
export const ALL_CATEGORY_KEY = 'all';
export type AssetLibraryTabKey = typeof ALL_CATEGORY_KEY | AssetCategory;

/** 从 File 的 MIME 判断它属于哪种媒介；认不出来返回 null（直接丢弃该文件）。 */
export function mediaOfFile(file: File): AssetLibraryMedia | null {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return null;
}

const CATEGORY_KEYS = new Set<string>(ASSET_CATEGORIES.map((c) => c.key));

/**
 * 老条目没有 category 字段，按它的来源/媒介兜底推一个：主线同步来的人物/场景/
 * 道具直接对号入座，音频归音效，剩下的本地上传归「其它」。
 */
export function deriveCategory(
  raw: unknown,
  source: FreezoneAssetLibrarySource,
  media: AssetLibraryMedia,
): AssetCategory {
  if (typeof raw === 'string' && CATEGORY_KEYS.has(raw)) {
    return raw as AssetCategory;
  }
  if (source === 'character' || source === 'scene' || source === 'prop') {
    return source;
  }
  return media === 'audio' ? 'audio' : 'other';
}

export const SOURCE_LABEL: Record<FreezoneAssetLibrarySource, string> = {
  upload: '上传',
  character: '人物',
  scene: '场景',
  prop: '道具',
};

/**
 * 文件夹（保存位置）和类目（标签）是两个独立维度：类目只说「这素材是干嘛的」，
 * 文件夹说「它放在哪」。key 的取值有三种——
 *   - `mainline`：主线同步来的资产的固定去处，不接受上传；
 *   - 类目 key（other/character/…）：同名系统文件夹，老条目没有 folder 字段时
 *     按类目落进来，所以不需要数据迁移；
 *   - 其余：用户自建文件夹的 id（后端随机生成，不会和上面撞）。
 * 与后端 video_node.py 的 RESERVED_FOLDER_KEYS / _resolve_library_folder 对应。
 */
export type AssetFolderKey = string;

export const MAINLINE_FOLDER_KEY = 'mainline';
/** 没归类的本地上传落在「其它」类目，文件夹上换个更直白的名字。 */
export const UNSORTED_FOLDER_LABEL = '待分类资产';
/** 与后端 FOLDER_NAME_MAX_LEN 一致。 */
export const FOLDER_NAME_MAX_LEN = 20;

const SYSTEM_FOLDER_LABELS: Record<string, string> = {
  [MAINLINE_FOLDER_KEY]: '主线',
  ...Object.fromEntries(
    ASSET_CATEGORIES.map((category) => [
      category.key,
      category.key === 'other' ? UNSORTED_FOLDER_LABEL : category.label,
    ]),
  ),
};

/** 系统文件夹的显示名；不是系统 key（自建文件夹的 id）时返回 null。 */
export function systemFolderLabel(key: AssetFolderKey): string | null {
  return SYSTEM_FOLDER_LABELS[key] ?? null;
}

/** 用户建不出来的名字（会和系统文件夹撞），与后端 RESERVED_FOLDER_NAMES 一致。 */
export const RESERVED_FOLDER_NAMES = Object.values(SYSTEM_FOLDER_LABELS).concat(
  ASSET_CATEGORIES.map((category) => category.label),
);

export interface AssetFolder {
  key: AssetFolderKey;
  label: string;
  items: LibraryItem[];
  /** 系统文件夹不可重命名/删除/改封面——它们是按标签派生的，没有实体记录。 */
  system: boolean;
  /** 能否作为上传的保存位置。主线是同步产物，只读。 */
  uploadable: boolean;
  /** 用户设的封面图 URL；没设过时按文件夹里第一张图兜底，都没有就画图标。 */
  cover?: string | null;
  /** 建夹时间（ISO）。系统文件夹是按标签派生的，没有这个字段。 */
  createdAt?: string | null;
}

/** 建夹日期，只取到天：卡片上够用，也免得时区把时分秒显示歪。 */
export function formatFolderDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 文件夹封面：用户指定的优先，否则拿文件夹里第一张图顶上（音频没有可用画面）。 */
export function folderCoverUrl(folder: AssetFolder): string | null {
  if (folder.cover) return folder.cover;
  const firstImage = folder.items.find(
    (entry) => entry.media === 'image' && entry.url,
  );
  return firstImage?.url ?? null;
}

/** 老条目没有 folder 字段：主线的进主线，本地上传的按类目进同名系统文件夹。 */
export function deriveFolder(
  raw: unknown,
  source: FreezoneAssetLibrarySource,
  category: AssetCategory,
): AssetFolderKey {
  if (typeof raw === 'string' && raw) return raw;
  return source === 'upload' ? category : MAINLINE_FOLDER_KEY;
}

/**
 * 把条目摆进文件夹。【主线】和【待分类资产】恒在——库是空的时候也得有地方可点；
 * 其余系统文件夹有内容才出现；自建文件夹一律出现（刚建完还是空的也要看得见）。
 */
export function buildAssetFolders(
  items: LibraryItem[],
  customFolders: FreezoneAssetLibraryFolder[] = [],
): AssetFolder[] {
  const own = (key: AssetFolderKey) =>
    items.filter((entry) => entry.folder === key);
  const folders: AssetFolder[] = [
    {
      key: MAINLINE_FOLDER_KEY,
      label: SYSTEM_FOLDER_LABELS[MAINLINE_FOLDER_KEY],
      items: items.filter(
        (entry) =>
          entry.folder === MAINLINE_FOLDER_KEY || entry.source !== 'upload',
      ),
      system: true,
      uploadable: false,
    },
  ];
  for (const category of ASSET_CATEGORIES) {
    const owned = own(category.key);
    if (category.key !== 'other' && owned.length === 0) continue;
    folders.push({
      key: category.key,
      label: SYSTEM_FOLDER_LABELS[category.key],
      items: owned,
      system: true,
      uploadable: true,
    });
  }
  for (const folder of customFolders) {
    folders.push({
      key: folder.id,
      label: folder.name,
      items: own(folder.id),
      system: false,
      uploadable: true,
      cover: folder.cover ?? null,
      createdAt: folder.created_at ?? null,
    });
  }
  return folders;
}

function itemUrl(media: AssetLibraryMedia, it: Record<string, unknown>): string {
  if (media === 'video') return typeof it.video_url === 'string' ? it.video_url : '';
  if (media === 'audio') return typeof it.audio_url === 'string' ? it.audio_url : '';
  const urls = it.image_urls ?? it.imageUrls ?? it.images;
  if (Array.isArray(urls)) {
    const first = urls.find((u): u is string => typeof u === 'string');
    if (first) return first;
  }
  return typeof it.cover_url === 'string' ? it.cover_url : '';
}

export function normalizeLibraryList(payload: unknown): LibraryItem[] {
  let arr: unknown[] = [];
  if (Array.isArray(payload)) {
    arr = payload;
  } else if (payload && typeof payload === 'object') {
    const rec = payload as Record<string, unknown>;
    for (const key of ['items', 'data', 'characters', 'list', 'records']) {
      if (Array.isArray(rec[key])) {
        arr = rec[key] as unknown[];
        break;
      }
    }
  }
  return arr
    .filter(
      (it): it is Record<string, unknown> =>
        Boolean(it && typeof it === 'object' && !Array.isArray(it)),
    )
    .map((it) => {
      const idRaw = it.id ?? it.item_id ?? it.itemId ?? null;
      const id =
        typeof idRaw === 'string' ? idRaw : idRaw != null ? String(idRaw) : null;
      const name = typeof it.name === 'string' ? it.name : '';
      // 缺省 image 兼容老数据（历史条目没有 media 字段）。
      const mediaRaw = typeof it.media === 'string' ? it.media : 'image';
      const media: AssetLibraryMedia =
        mediaRaw === 'video' || mediaRaw === 'audio' ? mediaRaw : 'image';
      const sourceRaw = typeof it.source === 'string' ? it.source : 'upload';
      const source: FreezoneAssetLibrarySource =
        sourceRaw === 'character' ||
        sourceRaw === 'scene' ||
        sourceRaw === 'prop'
          ? sourceRaw
          : 'upload';
      const category = deriveCategory(it.category, source, media);
      return {
        id,
        name,
        media,
        source,
        category,
        folder: deriveFolder(it.folder, source, category),
        url: itemUrl(media, it),
        raw: it,
      };
    })
    .filter((it) => Boolean(it.url));
}
