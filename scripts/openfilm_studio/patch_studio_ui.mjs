#!/usr/bin/env node
/* Applies Dramaclaw's thin patches to the vendored OpenFilm Studio editor bundle.
 *
 * The editor ships as one minified chunk, so every patch is an exact-string swap with a
 * count assertion: if upstream renames or reshapes the code, this script fails loudly
 * instead of silently producing a half-patched UI. Re-run after any vendor update.
 *
 *   node scripts/openfilm_studio/patch_studio_ui.mjs          # patch (idempotent)
 *   node scripts/openfilm_studio/patch_studio_ui.mjs --check   # verify only, exit 1 if stale
 *
 * The patched chunk is written under a new name and index.html is repointed, because the
 * Studio serves /assets/* as `immutable` — keeping the old name would let a returning
 * browser run the pre-patch bundle out of its cache.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* revendor.mjs patches a staged build through this before it touches vendor/. */
const DIST = process.env.OPENFILM_STUDIO_DIST
  ? resolve(process.env.OPENFILM_STUDIO_DIST)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../../vendor/openfilm/studio/ui/dist');
const ASSETS = join(DIST, 'assets');
const SOURCE_CHUNK = 'index-D1xgKltC.js';
const PATCHED_CHUNK = 'index-D1xgKltC.dramaclaw12.js';
const INDEX = join(DIST, 'index.html');

/** The OpenFilm "F" wordmark, wherever it is drawn (top bar, splash, about). */
const LOGO_MARK = 'function z0({size:e=18}){const t=`openfilm-gap-${j.useId().replace(/:/g,"")}`;return a.jsxs("svg",{width:e,height:e,viewBox:TD,fill:"currentColor",className:"block shrink-0",role:"img","aria-label":"OpenFilm",children:[a.jsxs("mask",{id:t,maskUnits:"userSpaceOnUse",x:"0",y:"0",width:"100",height:"100",children:[a.jsx("rect",{width:"100",height:"100",fill:"#fff"}),a.jsx("path",{d:FC,stroke:"#000",strokeWidth:"7",strokeLinejoin:"round"})]}),a.jsxs("g",{mask:`url(#${t})`,children:[a.jsx("rect",{x:"22",y:"12",width:"64",height:"20",rx:"5"}),a.jsx("rect",{x:"25",y:"44",width:"47",height:"19",rx:"5"})]}),a.jsx("path",{d:FC})]})}';

/** A Lucide settings gear, stroked in currentColor like every other toolbar icon. */
const LOGO_SETTINGS =
  'function z0({size:e=18}){return a.jsxs("svg",{width:e,height:e,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"2",strokeLinecap:"round",strokeLinejoin:"round",className:"block shrink-0","aria-hidden":!0,children:[a.jsx("path",{d:"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"}),a.jsx("circle",{cx:"12",cy:"12",r:"3"})]})}';

/** The anchor behind the Properties panel's "Download" button. */
const DOWNLOAD_ANCHOR =
  'a.jsxs("a",{href:t,download:e.name,className:"flex items-center gap-1.5 rounded-md bg-[var(--fill-tsp)] px-2.5 py-2 hover:bg-[var(--bg-hover)]",children:[a.jsx(up,{size:13}),i("assets.download")]})';

const DOWNLOAD_SAVE =
  'a.jsxs("a",{href:t,download:e.name,onClick:async(ev)=>{ev.preventDefault();try{const r=await fetch(t);if(!r.ok)throw new Error(String(r.status));const u=URL.createObjectURL(await r.blob()),link=document.createElement("a");link.href=u,link.download=e.name,document.body.appendChild(link),link.click(),link.remove(),setTimeout(()=>URL.revokeObjectURL(u),1e4)}catch{window.open(t,"_blank","noopener")}},className:"flex items-center gap-1.5 rounded-md bg-[var(--fill-tsp)] px-2.5 py-2 hover:bg-[var(--bg-hover)]",children:[a.jsx(up,{size:13}),i("assets.download")]})';

/**
 * The patches, in order. Each `find` must appear exactly `count` times.
 */
const PATCHES = [
  {
    id: 'hide-desktop-promo',
    why: 'The "Desktop" chip sells the OpenFilm desktop app; Dramaclaw is the host, so it never applies.',
    find: '!Et&&a.jsx(on,{label:r("desktop.title"),side:"bottom",children:a.jsxs("button"',
    replace: '!1&&a.jsx(on,{label:r("desktop.title"),side:"bottom",children:a.jsxs("button"',
    count: 1,
  },
  {
    id: 'settings-mark',
    why: 'The top-left mark opens Settings and must not carry OpenFilm branding.',
    find: LOGO_MARK,
    replace: LOGO_SETTINGS,
    count: 1,
  },
  {
    id: 'download-via-blob',
    why: 'Media is served from the film origin (a separate site on purpose), so Chrome drops the download '
      + 'attribute and navigates the editor into its native video viewer. Fetch and save from a same-origin blob.',
    find: DOWNLOAD_ANCHOR,
    replace: DOWNLOAD_SAVE,
    count: 1,
  },
  {
    id: 'host-language',
    why: 'The editor picks its language from navigator.languages, which browsers reduce to the alternative '
      + 'locale (en-US) inside a cross-site iframe — so the embed always came up English. Read the language the '
      + 'host put in the address first; a language chosen in the editor still wins.',
    find: 'function Pk(){try{const e=localStorage.getItem(wv);return cx.some(t=>t.code===e)?e:"system"}catch{return"system"}}',
    replace: 'function Pk(){try{const e=localStorage.getItem(wv);if(cx.some(t=>t.code===e))return e;'
      + 'const q=new URLSearchParams(location.search).get("lang");if(cx.some(t=>t.code===q))return q;'
      + 'return"system"}catch{return"system"}}',
    count: 1,
  },
  {
    id: 'keep-host-language',
    why: 'Studio rewrites its own address as the user moves around (history.pushState through keepKey). That '
      + 'kept the key, hostBack and its label but dropped the host\'s ?lang=, so the next reload re-resolved the '
      + 'language from the browser and the embed came back English.',
    find: 'for(const i of["hostBack","hostBackLabel"]){const l=t.get(i);l&&r.searchParams.set(i,l)}',
    replace: 'for(const i of["hostBack","hostBackLabel","lang"]){const l=t.get(i);l&&r.searchParams.set(i,l)}',
    count: 1,
  },
  {
    id: 'error-state-goes-back',
    why: 'When the project fails to load the editor renders a bare "Projects" button and no toolbar, so an '
      + 'embedded user lands on OpenFilm\'s own project list with no way home. Send it to the host instead.',
    find: 'if(x)return a.jsxs("div",{className:"workspace-shell flex flex-col items-center justify-center gap-3 bg-[var(--dock-shell)] text-[13px] text-[var(--text-muted)]",children:[a.jsx("p",{children:x}),a.jsx("button",{type:"button",onClick:s,className:"rounded-lg border border-[var(--border)] px-3 py-1.5 hover:bg-[var(--bg-hover)]",children:r("nav.projects")})]});',
    replace: 'if(x){const _q=new URLSearchParams(location.search),_b=_q.get("hostBack"),'
      + '_l=_b?_q.get("hostBackLabel")||r("nav.projects"):r("nav.projects");'
      + 'return a.jsxs("div",{className:"workspace-shell flex flex-col items-center justify-center gap-3 bg-[var(--dock-shell)] text-[13px] text-[var(--text-muted)]",children:'
      + '[a.jsx("p",{children:x}),a.jsx("button",{type:"button",onClick:()=>{if(!_b){s();return}'
      + 'if(window.parent!==window){window.parent.postMessage({type:"dramaclaw:studio-back"},"*");return}'
      + 'window.location.assign(_b)},className:"rounded-lg border border-[var(--border)] px-3 py-1.5 hover:bg-[var(--bg-hover)]",children:_l})]})}',
    count: 1,
  },
  {
    id: 'project-gone-goes-back',
    why: 'onLeave is how the project panel reports a film that no longer exists: standalone it navigates to '
      + '"/" and the router then auto-opens the first project it finds. Inside the embed that would drop the '
      + 'user into another project, so hand the turn back to the host instead.',
    find: 'i=()=>{Wu?Wu.report({gone:!0}):s("/",!0)}',
    replace: 'i=()=>{if(Wu){Wu.report({gone:!0});return}'
      + 'const _b=new URLSearchParams(location.search).get("hostBack");'
      + 'if(_b&&window.parent!==window){window.parent.postMessage({type:"dramaclaw:studio-back"},"*");return}'
      + 'if(_b){window.location.assign(_b);return}'
      + 's("/",!0)}',
    count: 1,
  },
  {
    id: 'no-foreign-loading-splash',
    why: 'The boot splash carries OpenFilm\'s wordmark and its own 「正在打开项目」 copy, and it paints right '
      + 'after the host\'s loading surface is gone — so a refresh flashes another product\'s loading screen. '
      + 'In the embed keep only the neutral indeterminate bar for the film fetch.',
    find: 'function ME({labelKey:e}){const t=Be();return a.jsxs("div",{role:"status","aria-live":"polite","aria-busy":!0,'
      + 'className:"workspace-shell z-[9000] flex flex-col items-center justify-center bg-[var(--panel)]",children:'
      + '[a.jsx("span",{className:"text-[var(--text)]",children:a.jsx(z0,{size:34})}),e?a.jsx("p",{className:"mt-6 '
      + 'text-[14px] font-medium tracking-[-0.01em] text-[var(--text)]",children:t(e)}):null,',
    replace: 'function ME({labelKey:e}){const t=Be();const _h=!!new URLSearchParams(location.search).get("hostBack");'
      + 'return a.jsxs("div",{role:"status","aria-live":"polite","aria-busy":!0,'
      + 'className:"workspace-shell z-[9000] flex flex-col items-center justify-center bg-[var(--panel)]",children:'
      + '[!_h&&a.jsx("span",{className:"text-[var(--text)]",children:a.jsx(z0,{size:34})}),!_h&&e?a.jsx("p",{className:"mt-6 '
      + 'text-[14px] font-medium tracking-[-0.01em] text-[var(--text)]",children:t(e)}):null,',
    count: 1,
  },
  {
    id: 'no-settings-footer-links',
    why: 'The settings sidebar footer links to the upstream repo, its examples repo and its website: three doors '
      + 'out of the embed and onto OpenFilm. They are the product\'s own front door, not the film being edited.',
    find: 'children:P$.map(E=>a.jsx("a",{href:E.href,target:"_blank",rel:"noreferrer"',
    replace: 'children:!new URLSearchParams(location.search).get("hostBack")&&P$.map(E=>a.jsx("a",{href:E.href,target:"_blank",rel:"noreferrer"',
    count: 1,
  },
  {
    id: 'no-about-and-self-update',
    why: 'Settings → General ends in an About row that prints the vendored editor\'s version, a 检查更新 button, '
      + 'and — once npm reports something newer — an 「npx -y openfilm@latest update」 row that rewrites vendor/openfilm '
      + 'and these very patches. None of it is a Dramaclaw concept.',
    find: 'Et?.update?.onState?a.jsx(K$,{}):a.jsx(U$,{})',
    replace: 'Et?.update?.onState?a.jsx(K$,{}):new URLSearchParams(location.search).get("hostBack")?null:a.jsx(U$,{})',
    count: 1,
  },
  {
    id: 'no-whats-new-dialog',
    why: 'The dialog fires by itself when the bundled version outranks the one in prefs, prints upstream release '
      + 'notes (CLI flags, the desktop app) under that version, and its footer links to OpenFilm\'s GitHub releases.',
    find: ',[s,u]),!s||typeof document>"u")return null;const p=s[0]',
    replace: ',[s,u]),!s||typeof document>"u")return null;if(new URLSearchParams(location.search).get("hostBack"))return null;const p=s[0]',
    count: 1,
  },
  {
    id: 'no-studio-start-command',
    why: 'When the editor loses its server the banner offers `openfilm open` to copy into a terminal. An embedded '
      + 'user has no terminal and no such command — the host restarts the editor for them.',
    find: 'i&&!Et?a.jsx("button",{type:"button",onClick:()=>{navigator.clipboard?.writeText(l)',
    replace: 'i&&!Et&&!new URLSearchParams(location.search).get("hostBack")?a.jsx("button",{type:"button",onClick:()=>{navigator.clipboard?.writeText(l)',
    count: 1,
  },
  {
    id: 'no-locked-start-command',
    why: 'The full-screen "this browser is not signed in" dialog offers the same terminal command, and its '
      + 'clipboard button hands the user a keyed localhost address they have no business copying. The host '
      + 'opens that address itself; the dialog is left as the explanation it is.',
    find: 'Et?null:a.jsxs("div",{className:"mt-4 flex items-center gap-2 text-[12.5px] text-[var(--text-muted)]",children:[a.jsx("span",{children:e("connection.lockedHow")})',
    replace: 'Et||new URLSearchParams(location.search).get("hostBack")?null:a.jsxs("div",{className:"mt-4 flex items-center gap-2 text-[12.5px] text-[var(--text-muted)]",children:[a.jsx("span",{children:e("connection.lockedHow")})',
    count: 1,
  },
  {
    id: 'no-version-history-entry',
    why: 'Version history is the vendored editor\'s local git: commit the film, branch it, roll back to an older '
      + 'snapshot. It asks the person cutting a video for commit messages, branch names and megabytes of held '
      + 'files — project vocabulary the host owns, not the user. The history API stays; the toolbar entry goes.',
    find: 'function EG({open:e,onClick:t,className:s}){const r=Be();return a.jsx(on,',
    replace: 'function EG({open:e,onClick:t,className:s}){const r=Be();return new URLSearchParams(location.search).get("hostBack")?null:a.jsx(on,',
    count: 1,
  },
  {
    id: 'no-version-history-dialog',
    why: 'The same surface as a dialog, reachable through the toolbar entry alone — guard it too so a future '
      + 'opener cannot bring 「提交」「分支」 into the embed.',
    find: 'function AG({projectId:e,history:t,open:s,anchor:r,onClose:i}){const l=Be(),',
    replace: 'function AG({projectId:e,history:t,open:s,anchor:r,onClose:i}){if(new URLSearchParams(location.search).get("hostBack"))return null;const l=Be(),',
    count: 1,
  },
  {
    id: 'no-dev-release-notes',
    why: 'Settings → Developer ends in a Releases group that previews the vendored editor\'s own release notes. '
      + 'It prints the upstream version (0.2.4) and opens the dialog the embed already suppresses. The editor '
      + 'ships with the host image, so there is nothing here for a user to preview.',
    find: 'rb()?a.jsx(jo,{title:e("settings.developer.releaseGroup")',
    replace: 'rb()&&!new URLSearchParams(location.search).get("hostBack")?a.jsx(jo,{title:e("settings.developer.releaseGroup")',
    count: 1,
  },
  {
    id: 'title-is-read-only',
    why: 'The heading is Studio\'s rename box, and renaming a project moves its folder — the id the host '
      + 'looks the film up by. Enter then looked like a save that had not taken (the name came straight back, '
      + 'because it is read from the film\'s <title>) while the next open built a fresh cut at the old path and '
      + 'orphaned every manual edit. The canvas node owns the name, so the embed shows it and does not edit it.',
    find: 'children:oc?a.jsx("input",{autoFocus:!0,value:Cm,onChange:C=>sl(C.target.value)',
    replace: 'children:new URLSearchParams(location.search).get("hostBack")'
      + '?a.jsx("span",{className:"min-w-0 truncate px-2 text-[13px] font-medium text-[var(--text-muted)]",'
      + 'children:WY(Ko||r("project.untitled"))})'
      + ':oc?a.jsx("input",{autoFocus:!0,value:Cm,onChange:C=>sl(C.target.value)',
    count: 1,
  },
  {
    id: 'shortcut-scheme-label',
    why: 'Settings → Keyboard shortcuts names the keymap after the vendored product. The label is a constant '
      + 'outside the catalogues, so it follows the resolved language by hand.',
    find: 'const T$={openfilm:"OpenFilm",premiere:"Premiere Pro",fcp:"Final Cut Pro X"}',
    replace: 'const T$={openfilm:v0()==="zh-CN"?"虾画":"Dramaclaw",premiere:"Premiere Pro",fcp:"Final Cut Pro X"}',
    count: 1,
  },
];

/** What the editor calls itself, per catalogue. 虾画 is what the host is named in Chinese. */
const BRAND = { en: 'Dramaclaw', 'zh-CN': '虾画', ja: 'Dramaclaw', ko: 'Dramaclaw', es: 'Dramaclaw' };

/**
 * The five inline i18n catalogues, located by the minified names of their assignments and the
 * language table that follows them. Everything user-visible is inside one of these spans; the
 * tokens outside them (package name, CSS classes, storage keys, URLs, release notes) stay put.
 */
const CATALOGUES = [
  { lang: 'en', start: '$k={nav:{', end: 'cz={nav:{' },
  { lang: 'es', start: 'cz={nav:{', end: 'uz={nav:{' },
  { lang: 'ja', start: 'uz={nav:{', end: 'dz={nav:{' },
  { lang: 'ko', start: 'dz={nav:{', end: 'pz={nav:{' },
  { lang: 'zh-CN', start: 'pz={nav:{', end: 'cx=[' },
];

/**
 * Copy the sweep cannot rename: it pointed at the OpenFilm logo the host replaced with a gear,
 * or told the user to run a terminal command that the embed never shows. `match` pins the
 * upstream value so a reworded string fails loudly instead of being silently skipped — some
 * keys repeat across namespaces (`gone` is also 「这条字幕已经不在了」).
 */
const COPY_OVERRIDES = [
  { lang: 'en', key: 'gone', match: 'Studio has stopped', value: 'Dramaclaw has stopped. Ask your agent to open the editor again; this page reconnects by itself.' },
  { lang: 'es', key: 'gone', match: 'se ha detenido', value: 'Dramaclaw se ha detenido. Pide a tu agente que vuelva a abrir el editor; esta página se reconecta sola.' },
  { lang: 'ja', key: 'gone', match: 'が停止しました', value: 'Dramaclaw が停止しました。エージェントにエディターを開き直してもらってください。このページは自動で再接続します。' },
  { lang: 'ko', key: 'gone', match: '멈췄습니다', value: 'Dramaclaw가 멈췄습니다. 에이전트에게 에디터를 다시 열어 달라고 하세요. 이 페이지는 자동으로 다시 연결됩니다.' },
  { lang: 'zh-CN', key: 'gone', match: '已停止运行', value: '虾画已停止运行。请让智能体重新打开编辑器，这个页面会自动重新连上。' },
  { lang: 'en', key: 'engineDown', match: 'local engine', value: 'The local engine is not responding. Reopen the editor and try again.' },
  { lang: 'es', key: 'engineDown', match: 'motor local', value: 'El motor local no responde. Vuelve a abrir el editor e inténtalo de nuevo.' },
  { lang: 'ja', key: 'engineDown', match: 'ローカルエンジン', value: 'ローカルエンジンが応答しません。エディターを開き直してもう一度お試しください。' },
  { lang: 'ko', key: 'engineDown', match: '로컬 엔진', value: '로컬 엔진이 응답하지 않습니다. 에디터를 다시 연 뒤 다시 시도하세요.' },
  { lang: 'zh-CN', key: 'engineDown', match: '本地引擎', value: '本地引擎没有响应。请重新打开编辑器后再试。' },
  { lang: 'en', key: 'subtitlesConnect', match: 'logo at the top left', value: 'Making subtitles needs a service that transcribes: connect one in Settings → Providers' },
  { lang: 'es', key: 'subtitlesConnect', match: 'logotipo', value: 'Para crear subtítulos hace falta un servicio de transcripción: conecta uno en Configuración → Proveedores' },
  { lang: 'ja', key: 'subtitlesConnect', match: 'ロゴ', value: '字幕の作成には文字起こしサービスが必要です。設定 → プロバイダーで接続してください' },
  { lang: 'ko', key: 'subtitlesConnect', match: '로고', value: '자막을 만들려면 음성 인식 서비스가 필요합니다. 설정 → 제공업체에서 연결하세요' },
  { lang: 'zh-CN', key: 'subtitlesConnect', match: '标志', value: '生成字幕需要一个语音转写服务：请在设置 → 服务商中连接一个' },
  { lang: 'en', key: 'subtitleTranslateConnect', match: 'logo at the top left', value: 'Connect a service that translates in Settings → Providers.' },
  { lang: 'es', key: 'subtitleTranslateConnect', match: 'logotipo', value: 'Conecta un servicio de traducción en Configuración → Proveedores.' },
  { lang: 'ja', key: 'subtitleTranslateConnect', match: 'ロゴ', value: '設定 → プロバイダーで翻訳サービスを接続してください。' },
  { lang: 'ko', key: 'subtitleTranslateConnect', match: '로고', value: '설정 → 제공업체에서 번역 서비스를 연결하세요.' },
  { lang: 'zh-CN', key: 'subtitleTranslateConnect', match: '标志', value: '请在设置 → 服务商中连接一个翻译服务。' },
  { lang: 'en', key: 'lockedBody', match: 'openfilm open', value: 'Dramaclaw is running, but this browser never opened it with its key. Go back to the Dramaclaw canvas and reopen the editor from the video node — the host passes the key over for you.' },
  { lang: 'es', key: 'lockedBody', match: 'openfilm open', value: 'Dramaclaw está en marcha, pero este navegador nunca lo abrió con su clave. Vuelve al lienzo de Dramaclaw y abre de nuevo el editor desde el nodo de vídeo; la clave se añade sola.' },
  { lang: 'ja', key: 'lockedBody', match: 'openfilm open', value: 'Dramaclaw は動いていますが、このブラウザーはキー付きのアドレスで一度も開いていません。Dramaclaw のキャンバスに戻って映像ノードからエディターを開き直してください。キーは自動で渡されます。' },
  { lang: 'ko', key: 'lockedBody', match: 'openfilm open', value: 'Dramaclaw가 실행 중이지만 이 브라우저는 키가 붙은 주소로 한 번도 열지 않았습니다. Dramaclaw 캔버스로 돌아가 영상 노드에서 에디터를 다시 여세요. 키는 자동으로 전달됩니다.' },
  { lang: 'zh-CN', key: 'lockedBody', match: 'openfilm open', value: '虾画正在运行，但这个浏览器还没有用带密钥的地址打开过它。请回到虾画画布，从视频节点重新打开编辑器，密钥会由平台自动带上。' },
];

const BRAND_TOKENS = ['OpenFilm', 'Studio'];
const JS_STRING_VALUE = '((?:[^"\\\\]|\\\\.)*)';

/**
 * The product's own name outside the catalogues: fallbacks the fetch helpers throw into a toast when
 * the server answers without a message, and the labels of the Settings → Developer diagnostic report.
 * Written in code, not copy, so `sweepBrand` cannot reach them. Each count is asserted, so a
 * re-vendor that adds or rewords one fails loudly instead of leaking a quieter name.
 */
const CODE_BRAND = [
  { find: 'Studio answered ', replace: 'Dramaclaw answered ', count: 9 },
  { find: 'Studio did not answer', replace: 'Dramaclaw did not answer', count: 1 },
  { find: "is Studio's list of", replace: "is Dramaclaw's list of", count: 1 },
  { find: 'Studio does not set "', replace: 'Dramaclaw does not set "', count: 1 },
  { find: 'a src Studio can play', replace: 'a src Dramaclaw can play', count: 1 },
  { find: 'open Studio in Chrome, Edge or the desktop app', replace: 'open Dramaclaw in Chrome, Edge or the desktop app', count: 1 },
  { find: 'or open Studio in its own tab', replace: 'or open Dramaclaw in its own tab', count: 1 },
  { find: 'Browser Studio is open in', replace: 'Browser Dramaclaw is open in', count: 1 },
  { find: '"OpenFilm Project "', replace: '"Dramaclaw Project "', count: 1 },
];

function sweepCodeBrand(text) {
  const problems = [];
  let out = text;
  for (const rule of CODE_BRAND) {
    const hits = out.split(rule.find).length - 1;
    if (hits === rule.count) {
      out = out.split(rule.find).join(rule.replace);
      continue;
    }
    if (out.split(rule.replace).length - 1 === rule.count) continue;
    problems.push(`code brand "${rule.find.trim()}": found ${hits}, expected ${rule.count}`);
  }
  return { text: out, problems };
}

/** The i18n catalogues as ordered [start, end) offsets, or null when a re-vendor moved them. */
function catalogueRanges(text) {
  const ranges = [];
  let from = 0;
  for (const catalogue of CATALOGUES) {
    const start = text.indexOf(catalogue.start, from);
    const end = start < 0 ? -1 : text.indexOf(catalogue.end, start + 1);
    if (start < 0 || end < 0) return null;
    ranges.push({ ...catalogue, start, end });
    from = end;
  }
  return ranges;
}

function escapeForJsString(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Rewrite one catalogue entry's value, accepting the patched text as already applied. */
function applyCopyOverride(segment, rule) {
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_$])${rule.key}:"${JS_STRING_VALUE}"`,
    'g',
  );
  const escaped = escapeForJsString(rule.value);
  let applied = 0;
  let already = 0;
  const out = segment.replace(pattern, (whole, value) => {
    if (value === rule.value) {
      already += 1;
      return whole;
    }
    if (!value.includes(rule.match)) return whole;
    applied += 1;
    return `${rule.key}:"${escaped}"`;
  });
  if (applied + already !== 1) {
    return { segment, problem: `copy ${rule.lang}.${rule.key}: matched ${applied} upstream value(s) and ${already} patched, expected 1` };
  }
  return { segment: out, problems: [] };
}

/** Rename the vendored product throughout one catalogue. */
function sweepBrand(segment, lang) {
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_$])(?:${BRAND_TOKENS.join('|')})(?![A-Za-z0-9_$])`,
    'g',
  );
  const name = BRAND[lang];
  const out = segment.replace(pattern, name);
  /* Upstream padded the Latin wordmark with spaces on both sides, which is correct CJK typography
     around a foreign word but reads as a typo around 虾画. */
  if (!/[\u3400-\u9fff]/.test(name)) return out;
  return out
    .replace(new RegExp(`(?<=[\\u3000-\\u9fff]) (?=${name})`, 'g'), '')
    .replace(new RegExp(`(?<=${name}) (?=[\\u3000-\\u9fff])`, 'g'), '');
}

/** Rewrite the catalogues: overrides first (they pin upstream wording), then the sweep. */
function applyBrand(text) {
  const ranges = catalogueRanges(text);
  if (!ranges) {
    return { text, problems: ['i18n catalogues not found — the minified names moved, re-derive CATALOGUES'] };
  }
  const problems = [];
  let out = text;
  /* Patch back to front so earlier splices do not shift the offsets still to be written. */
  for (const range of [...ranges].reverse()) {
    let segment = out.slice(range.start, range.end);
    for (const rule of COPY_OVERRIDES.filter((entry) => entry.lang === range.lang)) {
      const result = applyCopyOverride(segment, rule);
      if (result.problem) {
        problems.push(result.problem);
        continue;
      }
      segment = result.segment;
    }
    segment = sweepBrand(segment, range.lang);
    out = out.slice(0, range.start) + segment + out.slice(range.end);
  }
  return { text: out, problems };
}

/**
 * The shell the editor is served in. Its title and favicon come from the build, and a browser
 * that keeps the frame in its history — or a direct link — shows both.
 */
const EDITOR_TITLE = 'Dramaclaw';
const EDITOR_FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'
  + '<style>.a{fill:#111}.b{fill:#fff}@media (prefers-color-scheme:dark){.a{fill:#fff}.b{fill:#111}}</style>'
  + '<rect class="a" x="2" y="4" width="20" height="16" rx="4"/>'
  + '<path class="b" d="M10 9v6l5-3z"/></svg>';

/** Repoint the bundle, then strip the vendored branding from the shell. */
function patchIndexHtml(html, chunkName) {
  return html
    /* Match the stem, not one exact name: index.html may still point at the stock chunk (first
       run) or at whichever patched chunk last round (every run after a cache-bust). */
    .replace(/\/assets\/index-[^"/]+\.js/g, `/assets/${chunkName}`)
    .replace(/<title>[^<]*<\/title>/, `<title>${EDITOR_TITLE}</title>`)
    .replace(
      /<link rel="icon"[^>]*>/,
      `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(EDITOR_FAVICON_SVG)}">`,
    );
}

const check = process.argv.includes('--check');
const source = join(ASSETS, SOURCE_CHUNK);
const patched = join(ASSETS, PATCHED_CHUNK);

/** Apply every patch to `text`, refusing to guess when an anchor moved. */
function applyAll(text) {
  const problems = [];
  let out = text;
  for (const patch of PATCHES) {
    const hits = out.split(patch.find).length - 1;
    if (hits === patch.count) {
      out = out.replace(patch.find, () => patch.replace);
      continue;
    }
    const already = out.split(patch.replace).length - 1;
    if (already === patch.count) continue;
    problems.push(`${patch.id}: anchor found ${hits} times, expected ${patch.count}`);
  }
  const brand = applyBrand(out);
  const code = sweepCodeBrand(brand.text);
  return { text: code.text, problems: [...problems, ...brand.problems, ...code.problems] };
}

function indexHtmlPointsAt(chunkName) {
  return readFileSync(INDEX, 'utf8').includes(`/assets/${chunkName}`);
}

/** Patched chunks from an earlier round — the base to re-patch, and the debris to remove. */
function staleChunks() {
  if (!existsSync(ASSETS)) return [];
  return readdirSync(ASSETS).filter(
    (name) => /^index-.+\.dramaclaw\d+\.js$/.test(name) && name !== PATCHED_CHUNK,
  );
}

if (check) {
  if (!existsSync(patched) || !indexHtmlPointsAt(PATCHED_CHUNK)) {
    console.error(`studio ui is unpatched (missing ${PATCHED_CHUNK} or index.html still points at the stock chunk)`);
    process.exit(1);
  }
  if (readFileSync(INDEX, 'utf8').includes('OpenFilm')) {
    console.error('index.html still carries the vendored title or favicon');
    process.exit(1);
  }
  const { problems } = applyAll(readFileSync(patched, 'utf8'));
  if (problems.length) {
    for (const line of problems) console.error(`studio ui patch out of date: ${line}`);
    process.exit(1);
  }
  console.log(`studio ui ok — ${PATCHES.length} patches, ${COPY_OVERRIDES.length} copy overrides, ${CODE_BRAND.length} code renames in place`);
  process.exit(0);
}

if (!existsSync(source) && !existsSync(patched) && !staleChunks().length) {
  console.error(`no editor chunk under ${ASSETS}`);
  process.exit(1);
}

/* The chunk index.html tells the browser to load. A vendored build installed without bumping
   SOURCE_CHUNK lands here: the base would silently be the last round's patched chunk, upstream's
   new code would never enter, and the bundle nobody loads would ship. */
const htmlChunk = (readFileSync(INDEX, 'utf8').match(/\/assets\/(index-[^"/]+\.js)/) || [])[1];
if (htmlChunk && !htmlChunk.includes('.dramaclaw') && htmlChunk !== SOURCE_CHUNK) {
  console.error(
    `index.html loads ${htmlChunk} but this script patches ${SOURCE_CHUNK} — ` +
      'point SOURCE_CHUNK at the chunk the vendored dist ships, or re-run revendor.mjs',
  );
  process.exit(1);
}

/* Re-running reads the stock chunk when it is still there, so upstream edits re-enter cleanly;
   once it has been replaced, the newest patched chunk is the base and the anchors above simply no-op. */
const base = readFileSync(
  existsSync(source) ? source : existsSync(patched) ? patched : join(ASSETS, staleChunks()[0]),
  'utf8',
);
const { text, problems } = applyAll(base);
if (problems.length) {
  for (const line of problems) console.error(`cannot patch: ${line}`);
  console.error('the vendored bundle no longer matches these anchors — re-derive them against the new build');
  process.exit(1);
}

writeFileSync(patched, text);
writeFileSync(INDEX, patchIndexHtml(readFileSync(INDEX, 'utf8'), PATCHED_CHUNK));
if (existsSync(source) && patched !== source) rmSync(source);
/* /assets/* is immutable, so a superseded chunk is not just dead weight: leaving it around
   hides the fact that index.html no longer matches what a returning browser will run. */
for (const stale of staleChunks()) rmSync(join(ASSETS, stale));

console.log(`patched studio ui → ${PATCHED_CHUNK} (${PATCHES.length} patches, ${COPY_OVERRIDES.length} copy overrides, ${CODE_BRAND.length} code renames, index.html repointed)`);
