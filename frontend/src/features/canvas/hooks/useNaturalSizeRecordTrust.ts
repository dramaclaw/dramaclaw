// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 节点数据里那组 imageNaturalWidth/Height，什么时候不能信。
 *
 * 记录存的是原图真实像素尺寸，主体图靠它决定能不能喂降采样副本。但记录没有和任
 * 何 URL 绑定，而节点的图是会被换掉的（画册选主图、从历史恢复、生成完成回填，
 * 三条路都只改 imageUrl/previewImageUrl，没人清这组数）。信着旧记录去喂副本，
 * onLoad 就会把一组属于别的图的数字当成真尺寸写回去，角标和自动尺寸一起错。
 *
 * 光看副本认不出来这件事：副本的长边被钉死在预算上，原图有多大这个信息在降采样
 * 时就丢了，5504x3072 和 2752x1536 的 card 副本都是 1280x714。所以判据是「换图」
 * 本身，不是「副本看起来对不对」——subject 一变就当场不信任，这一轮改喂原图，量
 * 到真尺寸落库之后再回到副本。
 *
 * 每个 subject 只退这一次。退回去了也未必能落库（手动调过尺寸的节点在 onLoad 里
 * 提前 return，走不到写数据那一步），没有这道闸就成了 副本→原图→副本 的死循环。
 */
export function useNaturalSizeRecordTrust(subject: string | null): {
  /** 这一轮要不要绕开副本、直接喂原图。 */
  distrusted: boolean;
  /** 记录对不上眼下这张图；退回原图重测一次。同一个 subject 第二次调用无效。 */
  distrustRecord: () => void;
  /** 原图已经量到，可以回到副本了。 */
  trustAgain: () => void;
} {
  const [distrustedSubject, setDistrustedSubject] = useState<string | null>(null);
  const retriedSubject = useRef<string | null>(null);
  const knownSubject = useRef<string | null>(null);

  const distrustRecord = useCallback(() => {
    if (subject === null || retriedSubject.current === subject) return;
    retriedSubject.current = subject;
    setDistrustedSubject(subject);
  }, [subject]);

  const trustAgain = useCallback(() => {
    setDistrustedSubject((current) => (current === null ? current : null));
  }, []);

  useEffect(() => {
    const previous = knownSubject.current;
    knownSubject.current = subject;
    // 首次挂载没有「上一张」可比：记录是持久化下来的，只能先信。真存歪了还有
    // nodeBodyRecordDescribesImage 当兜底，它认得出比例对不上的那一类。
    if (previous === null || previous === subject) return;
    distrustRecord();
  }, [distrustRecord, subject]);

  return {
    distrusted: distrustedSubject !== null && distrustedSubject === subject,
    distrustRecord,
    trustAgain,
  };
}
