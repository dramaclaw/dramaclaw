import { describe, expect, it } from 'vitest';
import { convertLiblibCanvasDetail, mergeLiblibCanvasGraph, parseLiblibShareUrl } from '@/features/freezone/liblibCanvasImport';
import { liblibImageThumbnailUrl, liblibVideoPosterUrl } from '@/features/canvas/domain/liblibMediaUrl';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { extractUpstreamImages } from '@/features/canvas/application/graphImageResolver';
import { suggestedProjectNameForLiblibShare } from '@/features/freezone/createProjectLiblibImport';

const shareUrl = 'https://www.liblib.tv/canvas/share?spaceId=42&projectId=0123456789abcdef0123456789abcdef';

describe('LibTV canvas import', () => {
  it('derives a valid default project name from any valid share link', () => {
    expect(suggestedProjectNameForLiblibShare(shareUrl)).toBe(
      'liblib_0123456789abcdef0123456789abcdef',
    );
    expect(() => suggestedProjectNameForLiblibShare('https://example.test/canvas/share')).toThrow();
  });

  it('keeps card coordinates, dimensions, assets and valid connections', () => {
    const detail = {
      projectMeta: { uuid: '0123456789abcdef0123456789abcdef', projectSpaceId: 42, name: 'Example' },
      nodeList: [
        {
          nodeKey: 'image-1', name: 'Image', type: 2,
          position: { positionX: '125', positionY: '-20' },
          measured: { width: '622', height: '350' },
          data: JSON.stringify({ type: 'image', url: ['https://assets.example.test/one.png'], action: 'image_resource' }),
        },
        {
          nodeKey: 'video-1', name: 'Video', type: 3,
          position: { positionX: '2000', positionY: '10' },
          measured: { width: '817', height: '350' },
          data: JSON.stringify({ type: 'video', url: ['https://assets.example.test/two.mp4'] }),
        },
        {
          nodeKey: 'audio-1', name: 'Audio', type: 4,
          position: { positionX: '4000', positionY: '15' },
          measured: { width: '350', height: '148' },
          data: JSON.stringify({ type: 'audio', url: ['https://assets.example.test/three.mp3'] }),
        },
      ],
      connectionList: [
        { connectionId: 'edge-1', source: 'image-1', target: 'video-1' },
        { connectionId: 'edge-deleted', source: 'deleted-node', target: 'video-1' },
      ],
    };
    const graph = convertLiblibCanvasDetail(detail, shareUrl, { width: 1200, height: 700 });
    expect(graph.name).toBe('Example');
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toHaveLength(1);
    expect(graph.nodes[0]).toMatchObject({
      id: 'image-1', type: CANVAS_NODE_TYPES.imageGen, position: { x: 125, y: -20 }, width: 622, height: 350,
      data: { imageUrl: 'https://assets.example.test/one.png', liblibImport: { sourceUrl: 'https://assets.example.test/one.png' } },
    });
    expect(graph.nodes[1]).toMatchObject({ type: CANVAS_NODE_TYPES.video, data: { videoUrl: 'https://assets.example.test/two.mp4' } });
    expect(graph.nodes[2]).toMatchObject({ type: CANVAS_NODE_TYPES.audio, data: { audioUrl: 'https://assets.example.test/three.mp3' } });
    expect(graph.edges[0]).toMatchObject({ source: 'image-1', target: 'video-1', sourceHandle: 'source', targetHandle: 'target' });
    expect(graph.viewport.zoom).toBeGreaterThanOrEqual(0.1);
  });

  it('rejects a non-share host and mismatched response project', () => {
    expect(() => parseLiblibShareUrl(shareUrl.replace('www.liblib.tv', 'www.liblib.tv.evil.test'))).toThrow();
    expect(() => convertLiblibCanvasDetail({
      projectMeta: { uuid: 'different', projectSpaceId: 42 }, nodeList: [], connectionList: [],
    }, shareUrl, { width: 800, height: 600 })).toThrow('response_mismatch');
  });

  it('keeps full prompts, ordered media references and local originals', () => {
    const image = 'https://libtv-res.liblib.art/example/image.png';
    const video = 'https://libtv-res.liblib.art/example/video.mp4';
    const localImage = '/static/projects/project-1/freezone/import/image.png';
    const localPoster = '/static/projects/project-1/freezone/import/poster.jpg';
    const detail = {
      projectMeta: { uuid: '0123456789abcdef0123456789abcdef', projectSpaceId: 42 },
      assetMap: {
        [image]: localImage,
        [liblibImageThumbnailUrl(image)!]: '/static/projects/project-1/freezone/import/thumb.png',
        [liblibVideoPosterUrl(video)!]: localPoster,
      },
      nodeList: [
        { nodeKey: 'image-1', type: 2, position: { positionX: 0, positionY: 0 }, data: JSON.stringify({ url: [image] }) },
        { nodeKey: 'video-1', type: 3, position: { positionX: 1000, positionY: 0 }, data: JSON.stringify({
          url: [video], params: {
            prompt: '风格前缀：\nStyle: 8K IMAX，真实电影质感', model: 'test-model',
            mixedList: [
              { nodeId: 'image-1', url: image, label: '角色', mediaType: 'image' },
              { nodeId: 'audio-1', url: 'https://libtv-res.liblib.art/example/voice.mp3', mediaType: 'audio' },
            ],
            mixedListOrder: ['audio-1', 'image-1'],
          },
        }) },
      ],
      connectionList: [{ connectionId: 'edge-1', source: 'image-1', target: 'video-1' }],
    };
    const graph = convertLiblibCanvasDetail(
      detail,
      shareUrl,
      { width: 800, height: 600 },
      { imageModelId: 'local-image-model', videoModelId: 'local-video-model' },
    );
    expect(graph.nodes[0].data).toMatchObject({ imageUrl: localImage, liblibImport: { importedLocalUrl: localImage, sourceUrl: image } });
    expect(extractUpstreamImages(graph.nodes[0])).toEqual([localImage]);
    expect(graph.nodes[1].data).toMatchObject({
      previewImageUrl: localPoster, prompt: '风格前缀：\nStyle: 8K IMAX，真实电影质感', model: 'local-video-model',
      genMode: 'allReference', referenceOrder: ['audio-1', 'image-1'],
      liblibImport: { references: [
        { nodeId: 'audio-1', mediaKind: 'audio' },
        { nodeId: 'image-1', mediaKind: 'image', url: localImage },
      ] },
    });
    expect(graph.nodes[0].data).toMatchObject({
      model: 'local-image-model',
      liblibImport: { originalModel: '', importedModel: 'local-image-model' },
    });
    expect(graph.nodes[1].data).toMatchObject({
      model: 'local-video-model',
      liblibImport: { originalModel: 'test-model', importedModel: 'local-video-model' },
    });
    expect(graph.edges).toHaveLength(1);
  });

  it('refreshes LibTV nodes without discarding native image edits', () => {
    const graph = convertLiblibCanvasDetail({
      projectMeta: { uuid: '0123456789abcdef0123456789abcdef', projectSpaceId: 42 },
      nodeList: [{ nodeKey: 'image-1', type: 2, position: { positionX: 0, positionY: 0 }, data: JSON.stringify({ url: ['https://libtv-res.liblib.art/example/image.png'] }) }],
      connectionList: [],
    }, shareUrl, { width: 800, height: 600 });
    const native = { id: 'edit-1', type: CANVAS_NODE_TYPES.imageEdit, position: { x: 700, y: 0 }, data: {} } as CanvasNode;
    const previousImported = { ...graph.nodes[0], position: { x: 50, y: 100 }, data: {
      ...graph.nodes[0].data,
      prompt: '本地修改提示词',
      imageUrl: '/static/projects/project-1/edited.png',
      model: 'local-user-choice',
    } } as CanvasNode;
    const merged = mergeLiblibCanvasGraph([previousImported, native], [{ id: 'edit-edge', source: 'image-1', target: 'edit-1' }], graph);
    expect(merged.nodes).toHaveLength(2);
    expect(merged.nodes[0].position).toEqual({ x: 50, y: 100 });
    expect(merged.nodes[0].data).toMatchObject({
      prompt: '本地修改提示词',
      imageUrl: '/static/projects/project-1/edited.png',
      model: 'local-user-choice',
    });
    expect(merged.edges).toMatchObject([{ id: 'edit-edge', source: 'image-1', target: 'edit-1' }]);
  });

  it('replaces legacy LibTV model ids with a usable local catalog model', () => {
    const graph = convertLiblibCanvasDetail({
      projectMeta: { uuid: '0123456789abcdef0123456789abcdef', projectSpaceId: 42 },
      nodeList: [{
        nodeKey: 'image-1', type: 2, position: { positionX: 0, positionY: 0 },
        data: JSON.stringify({ url: ['https://libtv-res.liblib.art/example/image.png'], params: { model: 'nebula-ultra' } }),
      }],
      connectionList: [],
    }, shareUrl, { width: 800, height: 600 }, { imageModelId: 'Qwen-Image-local' });
    const legacy = structuredClone(graph.nodes[0]);
    legacy.data.model = 'nebula-ultra';
    const legacyImport = legacy.data.liblibImport as { importedModel?: string | null };
    delete legacyImport.importedModel;
    const merged = mergeLiblibCanvasGraph([legacy], [], graph);
    expect(merged.nodes[0].data).toMatchObject({
      model: 'Qwen-Image-local',
      liblibImport: { originalModel: 'nebula-ultra', importedModel: 'Qwen-Image-local' },
    });
  });

  it('renders a LibTV text node as an editable text card, body and instruction apart', () => {
    const body = '### 呱比\n\n- **外貌特征：** 呆萌的青蛙';
    const instruction = '你是专业电影导演，请根据画面内容生成 15S 电影片段脚本。';
    const graph = convertLiblibCanvasDetail({
      projectMeta: { uuid: '0123456789abcdef0123456789abcdef', projectSpaceId: 42 },
      nodeList: [
        {
          nodeKey: 't-1', name: '文本节点 2', type: 1,
          position: { positionX: '100', positionY: '20' },
          measured: { width: '570', height: '341' },
          data: JSON.stringify({ type: 'text', action: 'text_resource', content: [body], params: { model: 'aurora-3-prime', prompt: '' } }),
        },
        {
          nodeKey: 't-2', name: '文本节点 3', type: 1,
          position: { positionX: '800', positionY: '20' },
          measured: { width: '553', height: '346' },
          data: JSON.stringify({
            type: 'text', action: 'text_generate', content: ['【00:00 - 00:02】镜号：1'],
            params: {
              model: 'aurora-3-prime', prompt: instruction,
              imageList: [{ nodeId: 'i-1', url: 'https://libtv-res.liblib.art/example/one.png', label: '图片节点 1' }],
              imageListOrder: ['i-1'],
              textList: [{ nodeId: 't-1', content: [body] }],
            },
          }),
        },
      ],
      connectionList: [{ connectionId: 'e-1', source: 't-1', target: 't-2' }],
    }, shareUrl, { width: 1200, height: 700 });

    expect(graph.nodes[0]).toMatchObject({
      id: 't-1', type: CANVAS_NODE_TYPES.textAnnotation,
      position: { x: 100, y: 20 }, width: 570, height: 341,
      data: {
        displayName: '文本节点 2', content: body, instruction: '',
        mode: 'writing', pickerDismissed: true,
        liblibImport: { liblibKind: 'text', liblibAction: 'text_resource', originalModel: 'aurora-3-prime', importedContent: body },
      },
    });
    // The LibTV generator id must not leak into the local model field.
    expect((graph.nodes[0].data as { model?: string }).model).not.toBe('aurora-3-prime');
    expect(graph.nodes[1].data).toMatchObject({
      content: '【00:00 - 00:02】镜号：1',
      instruction,
      liblibImport: {
        liblibAction: 'text_generate',
        references: [
          { nodeId: 'i-1', mediaKind: 'image' },
          { nodeId: 't-1', mediaKind: 'text', text: body },
        ],
      },
    });
    expect(graph.edges).toMatchObject([{ source: 't-1', target: 't-2' }]);
  });

  it('rebuilds LibTV groups so members keep their parent-relative placement', () => {
    const graph = convertLiblibCanvasDetail({
      projectMeta: { uuid: '0123456789abcdef0123456789abcdef', projectSpaceId: 42 },
      nodeList: [
        // Deliberately listed before its group: React Flow resolves parentId by
        // array order, so the converter has to reorder.
        {
          nodeKey: 'i-1', name: '图片节点 1', type: 2, parentKey: 'g-1',
          position: { positionX: '53', positionY: '206' },
          measured: { width: '627', height: '350' },
          data: JSON.stringify({ type: 'image', url: ['https://libtv-res.liblib.art/example/one.png'] }),
        },
        {
          nodeKey: 'g-1', name: '分组 2 个节点', type: 5,
          position: { positionX: '-1642', positionY: '1758' },
          measured: { width: '6210', height: '624' },
          data: JSON.stringify({ type: 'group', name: '分组 2 个节点', childNodeIds: ['i-1', 't-1'] }),
        },
        {
          nodeKey: 't-1', name: '文本节点 2', type: 1, parentKey: 'g-1',
          position: { positionX: '4018', positionY: '182' },
          measured: { width: '570', height: '341' },
          data: JSON.stringify({ type: 'text', content: ['组内文本'] }),
        },
        {
          nodeKey: 'i-2', name: '图片节点 2', type: 2, parentKey: 'missing-group',
          position: { positionX: '-3506', positionY: '2922' },
          measured: { width: '627', height: '350' },
          data: JSON.stringify({ type: 'image', url: ['https://libtv-res.liblib.art/example/two.png'] }),
        },
      ],
      // An edge onto the group box would anchor to a node that has no handles.
      connectionList: [
        { connectionId: 'e-1', source: 'i-1', target: 't-1' },
        { connectionId: 'e-group', source: 'i-1', target: 'g-1' },
      ],
    }, shareUrl, { width: 1440, height: 900 });

    const ids = graph.nodes.map((node) => node.id);
    expect(ids.indexOf('g-1')).toBeLessThan(ids.indexOf('i-1'));
    expect(ids.indexOf('g-1')).toBeLessThan(ids.indexOf('t-1'));
    const group = graph.nodes.find((node) => node.id === 'g-1')!;
    expect(group).toMatchObject({
      type: CANVAS_NODE_TYPES.group,
      position: { x: -1642, y: 1758 }, width: 6210, height: 624,
      style: { width: 6210, height: 624 },
      data: { label: '分组 2 个节点', displayName: '分组 2 个节点', liblibImport: { liblibKind: 'group' } },
    });
    // Relative offsets are preserved verbatim; React Flow adds the parent origin.
    expect(graph.nodes.find((node) => node.id === 'i-1')).toMatchObject({
      parentId: 'g-1', position: { x: 53, y: 206 },
    });
    expect(graph.nodes.find((node) => node.id === 't-1')).toMatchObject({
      parentId: 'g-1', position: { x: 4018, y: 182 },
    });
    // A dangling parentKey would make React Flow drop the node entirely.
    expect(graph.nodes.find((node) => node.id === 'i-2')!.parentId).toBeUndefined();
    expect(graph.edges.map((edge) => edge.id)).toEqual(['e-1']);
    // The viewport must frame absolute coordinates: 4018 is a group offset, not
    // a canvas column, so the fitted zoom stays well above the 10% floor.
    expect(graph.viewport.zoom).toBeGreaterThan(0.1);
  });

  it('drops a self-referencing or circular LibTV group link', () => {
    const graph = convertLiblibCanvasDetail({
      projectMeta: { uuid: '0123456789abcdef0123456789abcdef', projectSpaceId: 42 },
      nodeList: [
        { nodeKey: 'g-a', type: 5, parentKey: 'g-b', position: { positionX: '0', positionY: '0' }, measured: { width: '800', height: '400' }, data: JSON.stringify({ type: 'group' }) },
        { nodeKey: 'g-b', type: 5, parentKey: 'g-a', position: { positionX: '10', positionY: '10' }, measured: { width: '600', height: '300' }, data: JSON.stringify({ type: 'group' }) },
        { nodeKey: 'g-c', type: 5, parentKey: 'g-c', position: { positionX: '20', positionY: '20' }, measured: { width: '400', height: '200' }, data: JSON.stringify({ type: 'group' }) },
      ],
      connectionList: [],
    }, shareUrl, { width: 800, height: 600 });
    const parents = graph.nodes.map((node) => [node.id, node.parentId] as const);
    expect(parents.filter(([, parent]) => parent).length).toBeLessThanOrEqual(1);
    expect(graph.nodes.find((node) => node.id === 'g-c')!.parentId).toBeUndefined();
  });

  it('keeps a locally edited text body and group name across a refresh', () => {
    const detail = {
      projectMeta: { uuid: '0123456789abcdef0123456789abcdef', projectSpaceId: 42 },
      nodeList: [
        { nodeKey: 'g-1', name: '分组', type: 5, position: { positionX: '0', positionY: '0' }, measured: { width: '900', height: '500' }, data: JSON.stringify({ type: 'group' }) },
        {
          nodeKey: 't-1', name: '文本节点', type: 1, parentKey: 'g-1',
          position: { positionX: '40', positionY: '40' }, measured: { width: '500', height: '300' },
          data: JSON.stringify({ type: 'text', content: ['LibTV 原文'], params: { prompt: '原指令' } }),
        },
      ],
      connectionList: [],
    };
    const graph = convertLiblibCanvasDetail(detail, shareUrl, { width: 800, height: 600 });
    const previousText = {
      ...graph.nodes[1],
      position: { x: 90, y: 90 },
      data: { ...graph.nodes[1].data, content: '我改过的正文', instruction: '原指令' },
    } as CanvasNode;
    const previousGroup = {
      ...graph.nodes[0],
      data: { ...graph.nodes[0].data, label: '我的分组', displayName: '我的分组' },
    } as CanvasNode;
    const merged = mergeLiblibCanvasGraph([previousGroup, previousText], [], graph);
    expect(merged.nodes.find((node) => node.id === 't-1')).toMatchObject({
      parentId: 'g-1',
      position: { x: 90, y: 90 },
      data: { content: '我改过的正文', instruction: '原指令' },
    });
    expect(merged.nodes.find((node) => node.id === 'g-1')!.data).toMatchObject({
      label: '我的分组', displayName: '我的分组',
    });
    expect(merged.nodes.map((node) => node.id)).toEqual(['g-1', 't-1']);
  });

  it('标出没能本地保存的素材并带上原因，而不是让整张画布导入失败', () => {
    const remote = 'https://xla-persist.xingliu.art/agent_images/agent_search/a.jpg';
    const local = 'https://libtv-res.liblib.art/example/one.png';
    const detail = {
      projectMeta: { uuid: '0123456789abcdef0123456789abcdef', projectSpaceId: 42 },
      assetMap: { [local]: '/static/projects/p/one.png' },
      // 后端不再因为陌生域名否决整张画布，而是把跳过的素材和原因报上来。
      skippedMedia: [{ url: remote, reason: 'liblib_media_unavailable' }],
      nodeList: [
        {
          nodeKey: 'i-local', type: 2, position: { positionX: 0, positionY: 0 },
          data: JSON.stringify({ type: 'image', url: [local] }),
        },
        {
          nodeKey: 'i-remote', type: 2, position: { positionX: 800, positionY: 0 },
          data: JSON.stringify({ type: 'image', url: [remote] }),
        },
      ],
      connectionList: [],
    };
    const graph = convertLiblibCanvasDetail(detail, shareUrl, { width: 1200, height: 700 });

    const localNode = graph.nodes.find((node) => node.id === 'i-local')!;
    const remoteNode = graph.nodes.find((node) => node.id === 'i-remote')!;

    // 本地化成功的节点不该被打标记。
    expect((localNode.data as { imageUrl?: string }).imageUrl).toBe('/static/projects/p/one.png');
    expect((localNode.data as { liblibImport?: { remoteMedia?: unknown } }).liblibImport?.remoteMedia)
      .toBeUndefined();

    // 没本地化的节点：图仍然指向远端（所以画布可用），但带着标记和原因。
    expect((remoteNode.data as { imageUrl?: string }).imageUrl).toBe(remote);
    expect((remoteNode.data as { liblibImport?: { remoteMedia?: unknown } }).liblibImport?.remoteMedia)
      .toEqual([{ url: remote, reason: 'liblib_media_unavailable' }]);
  });

  it('后端没报跳过清单时不给任何节点打远端标记', () => {
    // 预览调用（download_assets=false）assetMap 是空的，那不代表素材有问题。
    const graph = convertLiblibCanvasDetail({
      projectMeta: { uuid: '0123456789abcdef0123456789abcdef', projectSpaceId: 42 },
      nodeList: [{
        nodeKey: 'i-1', type: 2, position: { positionX: 0, positionY: 0 },
        data: JSON.stringify({ type: 'image', url: ['https://libtv-res.liblib.art/example/one.png'] }),
      }],
      connectionList: [],
    }, shareUrl, { width: 800, height: 600 });
    expect((graph.nodes[0].data as { liblibImport?: { remoteMedia?: unknown } }).liblibImport?.remoteMedia)
      .toBeUndefined();
  });
});

describe('_resourceMeta 带进原图像素尺寸', () => {
  // 没有 imageNaturalWidth/Height 时，nodeBodyImageSrc 会拒绝挑降采样副本——
  // 那一次加载兼着「量原图」的职责，必须是原图。一张 3840x2160 的远端图就是约 33MB 解码，
  // 而源数据里明明带着这个数字。
  const detailWith = (type: number, meta: unknown) => ({
    projectMeta: { uuid: '0123456789abcdef0123456789abcdef', projectSpaceId: 42 },
    connectionList: [],
    nodeList: [
      {
        nodeKey: 'n1',
        name: 'N',
        type,
        position: { positionX: '0', positionY: '0' },
        measured: { width: '622', height: '350' },
        data: JSON.stringify({
          url: ['https://libtv-res.liblib.art/a/x.png'],
          _resourceMeta: meta,
          params: {},
        }),
      },
    ],
  });

  it('图片节点写入 imageNaturalWidth / imageNaturalHeight', () => {
    const graph = convertLiblibCanvasDetail(
      detailWith(2, { items: [{ kind: 'image', width: 3840, height: 2160 }] }),
      shareUrl,
      { width: 1200, height: 700 },
    );
    const data = graph.nodes[0].data as Record<string, unknown>;
    expect(data.imageNaturalWidth).toBe(3840);
    expect(data.imageNaturalHeight).toBe(2160);
  });

  it('视频节点写入像素尺寸与时长', () => {
    const graph = convertLiblibCanvasDetail(
      detailWith(3, { items: [{ kind: 'video', width: 1280, height: 720, durationSec: 10.08 }] }),
      shareUrl,
      { width: 1200, height: 700 },
    );
    const data = graph.nodes[0].data as Record<string, unknown>;
    expect(data.widthPx).toBe(1280);
    expect(data.heightPx).toBe(720);
    expect(data.durationMs).toBe(10080);
  });

  // 源数据里 28 个图片节点有 8 个压根没有 _resourceMeta，不能因此写进 0 或 NaN——
  // 那会让下游以为「已经量过了」而永远不再重量。
  it('没有 meta 或尺寸非正数时什么都不写', () => {
    for (const meta of [undefined, { items: [] }, { items: [{ kind: 'image', width: 0, height: 2160 }] }]) {
      const graph = convertLiblibCanvasDetail(detailWith(2, meta), shareUrl, { width: 1200, height: 700 });
      const data = graph.nodes[0].data as Record<string, unknown>;
      expect(data.imageNaturalWidth).toBeUndefined();
      expect(data.imageNaturalHeight).toBeUndefined();
    }
  });

  // LibTV 的 NodeType 有 14 种，我们只有前五种的对应节点。认不出来的类型——
  // 智能剪辑(35) / 参考(40) / 拉片(45) 这些——身上大多挂着素材，按素材落成
  // 普通图片/视频节点才用得上；全落成惰性卡片等于把画布里最有用的部分丢掉。
  describe('认不出来的节点类型按素材落', () => {
    for (const [type, kind, nodeType] of [
      [35, 'video', 'videoNode'],
      [40, 'image', 'imageGenNode'],
      [45, 'image', 'imageGenNode'],
    ] as const) {
      it(`type ${type} 带 ${kind} 素材时落成 ${nodeType}`, () => {
        const graph = convertLiblibCanvasDetail(
          detailWith(type, { items: [{ kind, width: 1280, height: 720 }] }),
          shareUrl,
          { width: 1200, height: 700 },
        );
        expect(graph.nodes[0].type).toBe(nodeType);
      });
    }

    it('什么素材都没有时才落成 LibTV 素材卡', () => {
      const graph = convertLiblibCanvasDetail(
        {
          projectMeta: { uuid: '0123456789abcdef0123456789abcdef', projectSpaceId: 42 },
          connectionList: [],
          nodeList: [
            {
              nodeKey: 'n1',
              name: 'N',
              type: 15,
              position: { positionX: '0', positionY: '0' },
              measured: { width: '400', height: '200' },
              data: JSON.stringify({ params: {} }),
            },
          ],
        },
        shareUrl,
        { width: 1200, height: 700 },
      );
      expect(graph.nodes[0].type).toBe('liblibMediaNode');
    });
  });
});
