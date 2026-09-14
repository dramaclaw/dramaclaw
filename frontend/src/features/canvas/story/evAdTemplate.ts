import type { CanvasNode, CanvasEdge } from '@/features/canvas/domain/canvasNodes';

/** Production-ready graph with explicitly unproduced media and an unconfigured booking destination. */
export function buildEvAdTemplate(center = { x: 0, y: 0 }, namespace: string = crypto.randomUUID()) {
  const groupId = `ev-${namespace}`;
  const id = (name: string) => `${groupId}-${name}`;
  const specs = [
    ['idle', '一次启动，选择你的路', '新能源汽车互动广告 · 素材占位预演\n驾驶舱安静，中控屏未亮。长按下方按钮启动。', 0, 180, 2,
      '固定驾驶位机位，屏幕与大灯关闭，车身设计沿用品牌参考。尾帧稳定，等待阶段使用独立环境循环。'],
    ['launch', '启动反馈', '中控亮起、大灯闪两次，低沉电驱声响起。仪表完成自检。零百 3.9 秒为创意示例，正式发布前替换为品牌确认参数。', 620, 180, 5,
      '与静置画面同机位同车辆，先屏幕点亮再切大灯细节。声浪随启动同步。精确文字后期合成，避免生成模型绘制参数。'],
    ['route', '这次，你想去哪里？', '城市夜色铺开。点击选择“上班通勤”或“周末跑山”。', 1240, 180, 3,
      '夜景固定镜头，尾帧保留左右路线的可读区域。选择层由播放器绘制，等待时使用独立夜景循环。'],
    ['commute', '把下一程，留给真实试驾', '你选择了上班通勤。\n制作画面：城市夜路，安静座舱与平顺起步。体验结束后预约到店试驾。\n当前为占位预演，未收集任何个人信息。', 1860, 0, 12,
      '沿用同一车辆与内饰参考，城市道路平顺行驶，最后停在稳定品牌落版。不要暗示未确认的自动驾驶能力。'],
    ['mountain', '把下一程，留给真实试驾', '你选择了周末跑山。\n制作画面：封闭测试道路，弯道跟拍、车身姿态与驾驶反馈。体验结束后预约到店试驾。\n当前为占位预演，未收集任何个人信息。', 1860, 420, 12,
      '沿用同一车辆参考，封闭测试道路的合规驾驶镜头，最后停在稳定品牌落版。避免夸张失控或竞速画面。'],
  ] as const;
  const nodes: CanvasNode[] = [{ id: groupId, type: 'groupNode', position: center,
    style: { width: 2460, height: 840 }, data: { label: '新能源汽车 · 30 秒互动广告', storyGroup: true,
      interactiveStoryId: groupId, interactiveStorySchemaVersion: 'story_draft.v2', storyVariableDefinitions: [], storyFlags: [], storyCharacters: [] } },
    ...specs.map(([name, title, script, x, y, seconds, notes]): CanvasNode => ({
      id: id(name), type: 'videoNode', parentId: groupId, position: { x: x + 60, y: y + 60 }, width: 460, height: 300,
      data: { displayName: title, narration: script, storySegmentId: name, videoUrl: null, aspectRatio: '16:9',
        storyProductionNotes: `目标时长 ${seconds} 秒；全路径素材约 22 秒，手势与选择预留约 8 秒。${notes}`,
        prompt: notes, storyMedia: { source: 'placeholder', status: 'missing', version: 1 },
        ...(name === 'idle' ? { storyRole: 'start' as const } : {}),
        ...(['idle', 'route'].includes(name) ? { storyChoiceLoop: { description: notes, productionNotes: '制作 2–4 秒独立无缝等待循环，绑定后替代主视频尾帧。' } } : {}),
        ...(['commute', 'mountain'].includes(name) ? { endingLabel: name === 'commute' ? '通勤体验' : '周末体验',
          storyCta: { label: name === 'commute' ? '预约通勤试驾' : '预约周末试驾', url: '' } } : {}),
      },
    })),
  ];
  const edges: CanvasEdge[] = [
    { id: id('start'), source: id('idle'), target: id('launch'), type: 'storyChoiceEdge', data: {
      storyChoiceId: 'start', choiceText: '长按 1 秒启动', order: 0, transitionMode: 'visible',
      interaction: { presentation: 'overlay', trigger: 'hold', holdMs: 1000, transition: 'cut' },
      feedbackText: '启动完成。中控亮起，大灯闪两次。',
    } },
    { id: id('next'), source: id('launch'), target: id('route'), type: 'storyChoiceEdge', data: {
      storyChoiceId: 'next', choiceText: '', order: 0, transitionMode: 'automatic',
    } },
    ...(['commute', 'mountain'] as const).map((name, order): CanvasEdge => ({
      id: id(`choose-${name}`), source: id('route'), target: id(name), type: 'storyChoiceEdge', data: {
        storyChoiceId: `choose-${name}`, choiceText: name === 'commute' ? '上班通勤' : '周末跑山',
        order, transitionMode: 'visible', interaction: { presentation: 'overlay', trigger: 'click' },
      },
    })),
  ];
  return { groupId, nodes, edges };
}
