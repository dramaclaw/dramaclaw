// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PREVIZ_MAX_AUDIO_CLIPS } from '@/features/previz/domain/audioTrack';
import {
  createDefaultScene,
  type PrevizAudioClip,
  type PrevizScene,
} from '@/features/previz/domain/scene';
import { peakBarHeights, PrevizAudioTrack } from '@/features/previz/ui/PrevizAudioTrack';

const loadAudioPeaks = vi.fn<(src: string) => Promise<Float32Array>>();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
/*
  只换掉 loadAudioPeaks（jsdom 没有 AudioContext），其余从真模块透传。
  之前把 PEAK_BUCKETS_PER_SEC 抄成字面量 120，等于下面那组算术全钉在测试自己编的
  常量上：把 audioPeaks.ts 里的 120 改成 240，一条都不会红。
*/
vi.mock('@/features/canvas/compose/audioPeaks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/canvas/compose/audioPeaks')>()),
  loadAudioPeaks: (src: string) => loadAudioPeaks(src),
}));

function audio(id: string, startFrame: number, endFrame: number): PrevizAudioClip {
  return {
    id,
    kind: 'audio',
    startFrame,
    endFrame,
    audioUrl: `/static/${id}.mp3`,
    sourceName: `${id}.mp3`,
    durationMs: 4000,
    // 非零：偏移写死成 0 也能过的话，这个 prop 等于没接。
    offsetMs: 500,
    sourceNodeId: null,
  };
}

function sceneWith(clips: PrevizAudioClip[]): PrevizScene {
  const base = createDefaultScene();
  return { ...base, timeline: { ...base.timeline, audio: clips } };
}

function props(
  scene: PrevizScene,
  overrides: Partial<Parameters<typeof PrevizAudioTrack>[0]> = {},
) {
  return {
    scene,
    pxPerFrame: 2,
    laneWidthPx: 400,
    selectedClipId: null,
    onSelect: vi.fn(),
    onTrim: vi.fn(),
    upstreamAudio: [],
    pending: null,
    onAddFile: vi.fn(),
    onAddUpstream: vi.fn(),
    ...overrides,
  };
}

const addButton = () => screen.getByRole('button', { name: 'previz.audio.add' });

/** 最小 2D 上下文：只记下调用，什么也不画。 */
function stubCanvas2D() {
  const context = { clearRect: vi.fn(), setTransform: vi.fn(), fillRect: vi.fn(), fillStyle: '' };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  return context;
}

let dprBackup: { descriptor: PropertyDescriptor | undefined } | null = null;

/*
  jsdom 的 devicePixelRatio 恒为 1，乘上去和不乘一模一样——高分屏那一支就等于没验。
  和 clientHeight 撞上兜底值是同一类坑：环境里的常数正好等于生产的默认值。
*/
function stubDevicePixelRatio(ratio: number): void {
  dprBackup ??= { descriptor: Object.getOwnPropertyDescriptor(window, 'devicePixelRatio') };
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: ratio });
}

/*
  jsdom 不排版，clientHeight 恒为 0，绘制永远落在兜底高度上——那一支就等于没验。
  给个高度让它走真分支，值特意取得和兜底的 24 不一样，读错了地方立刻算不对。
*/
function stubClientHeight(px: number): void {
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => px,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  loadAudioPeaks.mockImplementation(async () => new Float32Array(240).fill(0.5));
  // jsdom 没有 canvas 2D 上下文；波形绘制得能在 getContext 返回 null 时安静跳过。
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  // 别把桩留给别的测试文件——两样都挂在全局原型上。
  vi.restoreAllMocks();
  // 删掉自己定义的那一层，clientHeight 就落回 Element.prototype 上原来的取值器。
  delete (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).clientHeight;
  if (dprBackup) {
    const { descriptor } = dprBackup;
    if (descriptor) Object.defineProperty(window, 'devicePixelRatio', descriptor);
    else delete (window as unknown as Record<string, unknown>).devicePixelRatio;
    dprBackup = null;
  }
});

describe('PrevizAudioTrack', () => {
  it('draws each clip with its source name and a waveform', async () => {
    render(<PrevizAudioTrack {...props(sceneWith([audio('a', 0, 60)]))} />);
    expect(screen.getByTestId('previz-audio-track')).toBeInTheDocument();
    expect(screen.getByTestId('previz-clip-a')).toHaveTextContent('a.mp3');
    const wave = screen.getByTestId('previz-audio-wave-a');
    expect(wave).toHaveAttribute('data-state', 'loading');
    await waitFor(() => {
      expect(wave).toHaveAttribute('data-state', 'ready');
    });
    expect(loadAudioPeaks).toHaveBeenCalledWith('/static/a.mp3');
  });

  it('loads the peaks once while the clip window stays put', async () => {
    const clip = audio('a', 0, 60);
    const { rerender } = render(<PrevizAudioTrack {...props(sceneWith([clip]))} />);
    await waitFor(() => {
      expect(screen.getByTestId('previz-audio-wave-a')).toHaveAttribute('data-state', 'ready');
    });
    // 同一个窗口重画一次：effect 的依赖数组要是丢了，这里会把整段音频再解一次码。
    rerender(<PrevizAudioTrack {...props(sceneWith([clip]))} />);
    expect(loadAudioPeaks).toHaveBeenCalledTimes(1);
  });

  it('paints the bars the clip window predicts, centred on the midline', async () => {
    /*
      别的用例把 2D 上下文桩成 null，验的是「拿不到就安静跳过」。这一条反过来给一个
      最小上下文，把每一根柱子的四个参数都钉死：offsetMs / clipMs 写成 0 或对调、
      x 恒取 0（整条波形挤成一列）、y 忘了减半个柱高（柱子挂在中线下面），前面那些
      用例一条都发现不了。
    */
    const { fillRect } = stubCanvas2D();
    stubClientHeight(20);
    // 每桶一个不同的值，窗口挪一格或首尾对调都画得不一样。
    const peaks = Float32Array.from({ length: 720 }, (_, i) => i / 1000);
    loadAudioPeaks.mockResolvedValue(peaks);

    const clip = audio('a', 0, 60);
    render(<PrevizAudioTrack {...props(sceneWith([clip]))} />);
    await waitFor(() => {
      expect(fillRect).toHaveBeenCalled();
    });

    // 120px 宽（60 帧 × 2px/帧）、2000ms 长（60 帧 @30fps）、20px 高，
    // 三个数都直接写死，不借生产代码的换算，免得两边一起错。
    const bars = peakBarHeights(peaks, clip.offsetMs, 2000, 120, 20);
    expect(fillRect.mock.calls).toEqual(bars.map((bar, x) => [x, 10 - bar / 2, 1, bar]));
  });

  it('redraws the moved window without decoding the source again', async () => {
    const { fillRect } = stubCanvas2D();
    stubClientHeight(20);
    const peaks = Float32Array.from({ length: 720 }, (_, i) => i / 1000);
    loadAudioPeaks.mockResolvedValue(peaks);

    const clip = audio('a', 0, 60);
    const { rerender } = render(<PrevizAudioTrack {...props(sceneWith([clip]))} />);
    await waitFor(() => {
      expect(fillRect).toHaveBeenCalled();
    });

    /*
      波形取的那一窗由片段的偏移与长度定，这两个值得真的从片段接到绘制里——写死成 0
      一样画得出东西，只有在片段挪动、裁剪时才露馅：窗口没跟着变，画出来还是老样子。
    */
    fillRect.mockClear();
    rerender(<PrevizAudioTrack {...props(sceneWith([{ ...clip, offsetMs: 1500 }]))} />);
    expect(fillRect.mock.calls.map((call) => call[3])).toEqual(
      peakBarHeights(peaks, 1500, 2000, 120, 20),
    );

    fillRect.mockClear();
    rerender(
      <PrevizAudioTrack {...props(sceneWith([{ ...clip, offsetMs: 1500, endFrame: 90 }]))} />,
    );
    expect(fillRect.mock.calls.map((call) => call[3])).toEqual(
      peakBarHeights(peaks, 1500, 3000, 180, 20),
    );

    // 峰值是整段素材的，与片段怎么裁无关：窗口一动就重解一次码，等于白建那层缓存。
    expect(loadAudioPeaks).toHaveBeenCalledTimes(1);
  });

  it('backs the canvas with device pixels and keeps drawing in CSS ones', async () => {
    const { fillRect, setTransform } = stubCanvas2D();
    stubClientHeight(20);
    stubDevicePixelRatio(2);

    render(<PrevizAudioTrack {...props(sceneWith([audio('a', 0, 60)]))} />);
    const canvas = screen.getByTestId('previz-audio-wave-a') as HTMLCanvasElement;
    await waitFor(() => {
      expect(fillRect).toHaveBeenCalled();
    });

    // CSS 盒子是 120×20（60 帧 × 2px/帧，桩出来的行高 20），位图按 2 倍铺。
    expect([canvas.width, canvas.height]).toEqual([240, 40]);
    expect(setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
    // 坐标系缩回去了，画的还是 120 根柱子——少了这一步就是照着设备像素画，等于放大两遍。
    expect(fillRect).toHaveBeenCalledTimes(120);
  });

  it('redraws at the new resolution when the timeline zooms', async () => {
    const { fillRect } = stubCanvas2D();
    stubClientHeight(20);
    const clip = audio('a', 0, 60);
    const { rerender } = render(<PrevizAudioTrack {...props(sceneWith([clip]))} />);
    const canvas = screen.getByTestId('previz-audio-wave-a') as HTMLCanvasElement;
    await waitFor(() => {
      expect(fillRect).toHaveBeenCalled();
    });
    expect(canvas.width).toBe(120); // 60 帧 × 2px/帧

    /*
      时间线能放大缩小。位图不跟着重画的话，浏览器就把上一档分辨率的图拉伸到新宽度：
      放大四倍，1px 的柱子糊成 4px 一片；缩小四倍，四根柱子挤成一根。
    */
    fillRect.mockClear();
    rerender(<PrevizAudioTrack {...props(sceneWith([clip]), { pxPerFrame: 4 })} />);
    expect(canvas.width).toBe(240);
    expect(fillRect).toHaveBeenCalledTimes(240);
    expect(loadAudioPeaks).toHaveBeenCalledTimes(1);
  });

  it('paints the clips in the audio tone', () => {
    render(<PrevizAudioTrack {...props(sceneWith([audio('a', 0, 60)]))} />);
    expect(screen.getByTestId('previz-clip-a').className).toContain('bg-[#2a8c7a]');
  });

  it('marks the waveform failed when the peaks cannot be loaded', async () => {
    loadAudioPeaks.mockRejectedValueOnce(new Error('decode'));
    render(<PrevizAudioTrack {...props(sceneWith([audio('a', 0, 60)]))} />);
    await waitFor(() => {
      expect(screen.getByTestId('previz-audio-wave-a')).toHaveAttribute('data-state', 'failed');
    });
  });

  it('opens the add menu with a local file entry and the upstream hint', async () => {
    const user = userEvent.setup();
    render(<PrevizAudioTrack {...props(sceneWith([]))} />);
    await user.click(screen.getByRole('button', { name: 'previz.audio.add' }));
    expect(screen.getByRole('menuitem', { name: 'previz.audio.local' })).toBeInTheDocument();
    expect(screen.getByText('previz.audio.noUpstream')).toBeInTheDocument();
  });

  it('lists upstream nodes and hands the picked one back', async () => {
    const user = userEvent.setup();
    const onAddUpstream = vi.fn();
    // 两个来源，挑第二个：只放一个的话，「挑中的那个」和「第一个」看起来一模一样。
    // 第二个的时长为 null——节点没记时长时也得能选，探时长是调用方的事。
    const first = {
      nodeId: 'audio-1',
      displayName: '旁白',
      audioUrl: '/static/vo.mp3',
      durationMs: 3000,
    };
    const second = {
      nodeId: 'audio-2',
      displayName: '环境声',
      audioUrl: '/static/amb.mp3',
      durationMs: null,
    };
    render(
      <PrevizAudioTrack
        {...props(sceneWith([]), { upstreamAudio: [first, second], onAddUpstream })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'previz.audio.add' }));
    expect(screen.getByRole('menuitem', { name: '旁白' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: '环境声' }));
    expect(onAddUpstream).toHaveBeenCalledWith(second);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('forwards a chosen local file', async () => {
    const user = userEvent.setup();
    const onAddFile = vi.fn();
    render(<PrevizAudioTrack {...props(sceneWith([]), { onAddFile })} />);
    await user.click(screen.getByRole('button', { name: 'previz.audio.add' }));
    await user.click(screen.getByRole('menuitem', { name: 'previz.audio.local' }));
    const file = new File(['x'], 'take.mp3', { type: 'audio/mpeg' });
    const input = screen.getByTestId('previz-audio-file') as HTMLInputElement;
    await user.upload(input, file);
    expect(onAddFile).toHaveBeenCalledWith(file);
    // 选完清空 value，同一个文件再选一次才会再触发 change。
    expect(input.value).toBe('');
  });

  it('closes the menu on Escape but not on other keys', async () => {
    const user = userEvent.setup();
    render(<PrevizAudioTrack {...props(sceneWith([]))} />);
    await user.click(screen.getByRole('button', { name: 'previz.audio.add' }));
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes the menu when the pointer goes down outside it', async () => {
    const user = userEvent.setup();
    render(<PrevizAudioTrack {...props(sceneWith([]))} />);
    await user.click(screen.getByRole('button', { name: 'previz.audio.add' }));
    await user.click(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('takes the menu away when the add button goes dead under it', async () => {
    const user = userEvent.setup();
    /*
      disabled 只拦得住加号本身。菜单开着时状态从外部翻过去——撤销恢复出一个装满的
      场景、或者另一段开始上传——菜单还挂在那儿，里头的条目照样点得动，绕开了那道闸。
    */
    const clips = Array.from({ length: PREVIZ_MAX_AUDIO_CLIPS }, (_, i) =>
      audio(`a${i}`, i, i + 1),
    );
    const filled = render(<PrevizAudioTrack {...props(sceneWith([]))} />);
    await user.click(addButton());
    filled.rerender(<PrevizAudioTrack {...props(sceneWith(clips))} />);
    expect(screen.queryByRole('menu')).toBeNull();
    filled.unmount();

    const uploading = render(<PrevizAudioTrack {...props(sceneWith([]))} />);
    await user.click(addButton());
    const pending = { startFrame: 0, endFrame: 10, name: 'take.mp3' };
    uploading.rerender(<PrevizAudioTrack {...props(sceneWith([]), { pending })} />);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('tells assistive tech that the add button opens a menu', async () => {
    const user = userEvent.setup();
    render(<PrevizAudioTrack {...props(sceneWith([]))} />);
    expect(addButton()).toHaveAttribute('aria-haspopup', 'menu');
    expect(addButton()).toHaveAttribute('aria-expanded', 'false');
    await user.click(addButton());
    expect(addButton()).toHaveAttribute('aria-expanded', 'true');
  });

  it('says on the wrapper span why the add button is dead', () => {
    /*
      三种状态的说明都挂在包着按钮的 span 上：禁用的表单控件不派发鼠标事件，
      title 写在按钮自己身上，恰恰在需要解释的那两种状态下弹不出来。
    */
    const idle = render(<PrevizAudioTrack {...props(sceneWith([]))} />);
    expect(addButton().parentElement).toHaveAttribute('title', 'previz.audio.add');
    idle.unmount();

    const clips = Array.from({ length: PREVIZ_MAX_AUDIO_CLIPS }, (_, i) =>
      audio(`a${i}`, i, i + 1),
    );
    const atLimit = render(<PrevizAudioTrack {...props(sceneWith(clips))} />);
    expect(addButton().parentElement).toHaveAttribute('title', 'previz.audio.limit');
    atLimit.unmount();

    const pending = { startFrame: 0, endFrame: 10, name: 'take.mp3' };
    render(<PrevizAudioTrack {...props(sceneWith([]), { pending })} />);
    expect(addButton().parentElement).toHaveAttribute('title', 'previz.audio.uploading');
  });

  it('disables the add button at the clip limit', () => {
    const clips = Array.from({ length: PREVIZ_MAX_AUDIO_CLIPS }, (_, i) =>
      audio(`a${i}`, i, i + 1),
    );
    render(<PrevizAudioTrack {...props(sceneWith(clips))} />);
    expect(screen.getByRole('button', { name: 'previz.audio.add' })).toBeDisabled();
  });

  it('disables the add button while an upload is running', () => {
    const pending = { startFrame: 0, endFrame: 10, name: 'take.mp3' };
    render(<PrevizAudioTrack {...props(sceneWith([]), { pending })} />);
    expect(screen.getByRole('button', { name: 'previz.audio.add' })).toBeDisabled();
  });

  it('shows the pending placeholder while an upload is running', () => {
    render(
      <PrevizAudioTrack
        {...props(sceneWith([]), { pending: { startFrame: 10, endFrame: 40, name: 'take.mp3' } })}
      />,
    );
    const placeholder = screen.getByTestId('previz-audio-pending');
    expect(placeholder).toHaveTextContent('previz.audio.uploading');
    expect(placeholder).toHaveStyle({ left: '20px', width: '60px' });
  });
});

/** 这一组不碰 DOM：jsdom 没有 2D 上下文，波形的算术只能在纯函数这一层验。 */
describe('peakBarHeights', () => {
  it('starts at the bucket the clip offset points into and scales by height', () => {
    const peaks = new Float32Array(240);
    peaks[120] = 1; // 素材第 1 秒的头一桶（120 桶/秒）
    const bars = peakBarHeights(peaks, 1000, 1000, 120, 20);
    expect(bars).toHaveLength(120);
    expect(bars[0]).toBe(20);
    expect(bars[1]).toBe(1);
  });

  it('spreads one bucket over several columns when the window is narrow', () => {
    // 25ms 整 3 桶，铺到 6 列上，每桶占两列。取值都在二进制里存得下，免得 Float32 差末位。
    const peaks = new Float32Array([0.25, 1, 0.5]);
    expect(peakBarHeights(peaks, 0, 25, 6, 8)).toEqual([2, 2, 8, 8, 4, 4]);
  });

  it('keeps a transient when the window is wider than the canvas', () => {
    const peaks = new Float32Array(240).fill(0.5);
    // 一句安静的台词里就一下爆音，落在最后一桶——正是看波形要找的东西。
    // 每列只挑一个取样点的话，它落在两个取样点之间，整条波形画成平的。
    peaks[239] = 1;
    expect(peakBarHeights(peaks, 0, 2000, 2, 10)).toEqual([5, 10]);
  });

  it('flattens a clip shorter than one bucket onto that one bucket', () => {
    const peaks = new Float32Array([1, 0]);
    // 不足一桶时窗口跨度小于 1，每一列都取 first 那一桶——0 长片段也不该画出 NaN。
    expect(peakBarHeights(peaks, 0, 0, 3, 10)).toEqual([10, 10, 10]);
    expect(peakBarHeights(peaks, 0, 4, 3, 10)).toEqual([10, 10, 10]);
  });

  it('reads past the end of the source as silence, still one pixel tall', () => {
    // 片段比素材长：越界的桶是 undefined，不能变成 NaN 高的柱子。
    expect(peakBarHeights(new Float32Array([1]), 0, 4000, 4, 20)).toEqual([20, 1, 1, 1]);
  });
});
