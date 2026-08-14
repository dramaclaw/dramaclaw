// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useTranslation } from "react-i18next";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import styles from "./download.module.css";

/**
 * 桌面端画布界面示意图。
 *
 * 目前是手绘 SVG 而非真实截屏 —— 换成截屏时把整个 <svg> 换成 <img
 * className={styles.shotBody}>,外层窗口框和标题栏都能原样留用。
 *
 * 两处 SMIL 动画(连线流动、渲染中转圈)在 prefers-reduced-motion 下不渲染:
 * SMIL 不受 CSS 的 `animation: none` 管辖,只能在这里显式摘掉。
 */
export function DownloadCanvasPreview() {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();

  return (
    <svg
      className={styles.shotBody}
      viewBox="0 0 1200 660"
      role="img"
      aria-label={t("downloadPage.preview.alt")}
    >
      <defs>
        <pattern id="dcDownloadCanvasDots" width="26" height="26" patternUnits="userSpaceOnUse">
          <circle cx="1.4" cy="1.4" r="1.4" fill="#1c2127" />
        </pattern>
      </defs>

      <rect width="1200" height="660" fill="#0b0c0f" />

      {/* 剧集 tab 条 */}
      <rect x="0" y="0" width="1200" height="38" fill="#15181c" />
      <line x1="0" y1="38" x2="1200" y2="38" stroke="#22272d" strokeWidth="1" />
      <rect x="16" y="8" width="104" height="24" rx="5" fill="#23282f" />
      <rect x="28" y="17" width="62" height="6" rx="3" fill="#98a3ad" />
      <rect x="130" y="8" width="92" height="24" rx="5" fill="#191d22" />
      <rect x="142" y="17" width="52" height="6" rx="3" fill="#4e565e" />
      <rect x="232" y="8" width="92" height="24" rx="5" fill="#191d22" />
      <rect x="244" y="17" width="46" height="6" rx="3" fill="#4e565e" />

      {/* 左:分镜大纲 */}
      <rect x="0" y="38" width="228" height="622" fill="#121519" />
      <line x1="228" y1="38" x2="228" y2="660" stroke="#22272d" strokeWidth="1" />
      <rect x="20" y="62" width="58" height="7" rx="3.5" fill="#4e565e" />

      <rect x="16" y="88" width="196" height="52" rx="6" fill="#1c2127" stroke="#2c333a" />
      <rect x="26" y="100" width="34" height="28" rx="4" fill="#2b333b" />
      <rect x="70" y="103" width="88" height="6" rx="3" fill="#98a3ad" />
      <rect x="70" y="117" width="120" height="5" rx="2.5" fill="#454d55" />

      <rect
        x="16"
        y="150"
        width="196"
        height="52"
        rx="6"
        fill="#1c2127"
        stroke="#d9603a"
        strokeOpacity="0.45"
      />
      <rect x="26" y="162" width="34" height="28" rx="4" fill="#33291f" />
      <rect x="70" y="165" width="72" height="6" rx="3" fill="#d9c0b4" />
      <rect x="70" y="179" width="112" height="5" rx="2.5" fill="#5a4c43" />

      <rect x="16" y="212" width="196" height="52" rx="6" fill="#171b20" />
      <rect x="26" y="224" width="34" height="28" rx="4" fill="#242a31" />
      <rect x="70" y="227" width="94" height="6" rx="3" fill="#5c646d" />
      <rect x="70" y="241" width="104" height="5" rx="2.5" fill="#363d44" />

      <rect x="16" y="274" width="196" height="52" rx="6" fill="#171b20" />
      <rect x="26" y="286" width="34" height="28" rx="4" fill="#242a31" />
      <rect x="70" y="289" width="80" height="6" rx="3" fill="#5c646d" />
      <rect x="70" y="303" width="116" height="5" rx="2.5" fill="#363d44" />

      <rect x="16" y="336" width="196" height="52" rx="6" fill="#171b20" />
      <rect x="26" y="348" width="34" height="28" rx="4" fill="#242a31" />
      <rect x="70" y="351" width="98" height="6" rx="3" fill="#5c646d" />
      <rect x="70" y="365" width="90" height="5" rx="2.5" fill="#363d44" />

      {/* 中:节点画布 */}
      <rect x="229" y="38" width="691" height="622" fill="url(#dcDownloadCanvasDots)" />

      <g fill="none" stroke="#39424b" strokeWidth="1.6">
        <path d="M430 168 C 478 168, 478 262, 526 262" />
        <path d="M430 168 C 478 168, 478 400, 526 400" />
        <path d="M700 262 C 748 262, 748 330, 796 330" />
        <path d="M700 400 C 748 400, 748 330, 796 330" />
      </g>

      {/* 通往「渲染中」节点的那条线在流动,标出任务正在推进 */}
      {!reducedMotion && (
        <path
          d="M430 168 C 478 168, 478 262, 526 262"
          fill="none"
          stroke="#d9603a"
          strokeWidth="1.6"
          strokeDasharray="5 9"
        >
          <animate
            attributeName="stroke-dashoffset"
            values="28;0"
            dur="1.6s"
            repeatCount="indefinite"
          />
        </path>
      )}

      {/* 节点:剧本 */}
      <rect x="290" y="122" width="140" height="92" rx="8" fill="#1a1e23" stroke="#2c333a" />
      <rect x="290" y="122" width="140" height="24" rx="8" fill="#20262c" />
      <rect x="290" y="138" width="140" height="8" fill="#20262c" />
      <rect x="302" y="131" width="42" height="6" rx="3" fill="#8b949e" />
      <rect x="302" y="160" width="112" height="5" rx="2.5" fill="#3a424a" />
      <rect x="302" y="174" width="96" height="5" rx="2.5" fill="#3a424a" />
      <rect x="302" y="188" width="104" height="5" rx="2.5" fill="#2f363d" />

      {/* 节点:首帧(渲染中) */}
      <rect
        x="526"
        y="212"
        width="174"
        height="100"
        rx="8"
        fill="#1a1e23"
        stroke="#d9603a"
        strokeOpacity="0.5"
      />
      <rect x="538" y="224" width="150" height="60" rx="5" fill="#262019" />
      <circle
        cx="613"
        cy="254"
        r="13"
        fill="none"
        stroke="#d9603a"
        strokeWidth="2.4"
        strokeDasharray="52 30"
      >
        {!reducedMotion && (
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 613 254"
            to="360 613 254"
            dur="1.1s"
            repeatCount="indefinite"
          />
        )}
      </circle>
      <rect x="538" y="292" width="62" height="6" rx="3" fill="#d9603a" />
      <rect x="606" y="292" width="34" height="6" rx="3" fill="#3a424a" />

      {/* 节点:参考图 */}
      <rect x="526" y="352" width="174" height="96" rx="8" fill="#1a1e23" stroke="#2c333a" />
      <rect x="538" y="364" width="70" height="52" rx="5" fill="#2a3138" />
      <rect x="614" y="364" width="74" height="52" rx="5" fill="#232930" />
      <rect x="538" y="426" width="88" height="6" rx="3" fill="#3a424a" />

      {/* 节点:视频 */}
      <rect x="796" y="272" width="106" height="118" rx="8" fill="#1a1e23" stroke="#2c333a" />
      <rect x="808" y="284" width="82" height="72" rx="5" fill="#252b32" />
      <path d="M840 308 l20 12 -20 12 z" fill="#6e7880" />
      <rect x="808" y="366" width="54" height="6" rx="3" fill="#3a424a" />

      {/* 右:参数面板 */}
      <rect x="920" y="38" width="280" height="622" fill="#121519" />
      <line x1="920" y1="38" x2="920" y2="660" stroke="#22272d" strokeWidth="1" />
      <rect x="944" y="66" width="72" height="7" rx="3.5" fill="#98a3ad" />
      <rect x="944" y="92" width="232" height="118" rx="6" fill="#1c2127" />

      <g fill="#454d55">
        <rect x="944" y="228" width="52" height="6" rx="3" />
        <rect x="944" y="290" width="60" height="6" rx="3" />
        <rect x="944" y="352" width="44" height="6" rx="3" />
      </g>
      <g fill="#191d22" stroke="#282e35">
        <rect x="944" y="244" width="232" height="30" rx="5" />
        <rect x="944" y="306" width="232" height="30" rx="5" />
        <rect x="944" y="368" width="232" height="30" rx="5" />
      </g>

      <rect x="944" y="428" width="232" height="38" rx="6" fill="#d9603a" />
      <rect x="1024" y="444" width="72" height="7" rx="3.5" fill="#20140f" />
    </svg>
  );
}
