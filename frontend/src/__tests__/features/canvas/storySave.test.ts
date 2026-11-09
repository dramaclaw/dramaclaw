import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  storySaveKey,
  readStorySave,
  writeStorySave,
  clearStorySave,
  storySaveFingerprint,
} from '@/features/canvas/story/storySave';

describe('storySave', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('storySaveKey 按画布 + 故事组隔离', () => {
    expect(storySaveKey('cv1', 'g1')).toBe('st.story.save.cv1.g1');
    expect(storySaveKey('cv1', 'g2')).not.toBe(storySaveKey('cv1', 'g1'));
    expect(storySaveKey('cv2', 'g1')).not.toBe(storySaveKey('cv1', 'g1'));
  });

  it('write/read 往返', () => {
    const key = storySaveKey('cv1', 'g1');
    writeStorySave(key, '{"foo":1}');
    expect(readStorySave(key)).toBe('{"foo":1}');
  });

  it('read 不存在的 key 返回 null', () => {
    expect(readStorySave(storySaveKey('cv1', 'missing'))).toBeNull();
  });

  it('带故事指纹的存档只向相同版本返回 Ink 运行态', () => {
    const key = storySaveKey('cv1', 'g1');
    const fingerprint = storySaveFingerprint('story-v1');
    writeStorySave(key, '{"state":1}', fingerprint);
    expect(readStorySave(key, fingerprint)).toBe('{"state":1}');
    expect(readStorySave(key, storySaveFingerprint('story-v2'))).toBeNull();
    expect(readStorySave(key)).toBeTruthy();
  });

  it('旧格式、损坏格式和未知版本都不当作兼容存档', () => {
    for (const raw of ['{"state":1}', 'not-json', 'null', '{"version":2,"storyFingerprint":"v1","inkState":"{}"}']) {
      writeStorySave('key', raw);
      expect(readStorySave('key', 'v1')).toBeNull();
    }
  });

  it('clear 后 read 返回 null', () => {
    const key = storySaveKey('cv1', 'g1');
    writeStorySave(key, '{"foo":1}');
    clearStorySave(key);
    expect(readStorySave(key)).toBeNull();
  });

  it('localStorage 抛错时 read 吞掉返回 null', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(readStorySave('any')).toBeNull();
  });

  it('localStorage 抛错时 write 静默降级不抛', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    expect(() => writeStorySave('any', '{}')).not.toThrow();
  });
});
