// @ts-check
/**
 * Slides: one picture per page, as a PowerPoint deck or a PDF.
 *
 * The deck is written here, OOXML by hand (a blank layout, one full-bleed picture per slide, the scene's name in the
 * speaker notes), zipped with zip.mjs: no library. The PDF is Chromium's own printing of a page with one picture per
 * sheet, each sheet the picture's size.
 */
import { launch } from '../../src/host.mjs';
import { zipFiles } from './zip.mjs';

/** @typedef {{ jpeg: Buffer, w: number, h: number, label: string }} SlidePage */

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument';

/** @param {string} text */
const esc = (text) => text
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/** @param {[string, string, string][]} rels Id, type (after the officeDocument relationships base), target */
const relsXml = (rels) => `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
  rels.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type.startsWith('http') ? type : `${REL}/${type}`}" Target="${target}"/>`).join('')
}</Relationships>`;

const GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const CLR_MAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';

/** The Office theme, as small as PowerPoint accepts: colors, fonts and the three-of-each format lists. */
function themeXml(/** @type {string} */ name) {
  const colors = [['dk1', '<a:srgbClr val="000000"/>'], ['lt1', '<a:srgbClr val="FFFFFF"/>'], ['dk2', '<a:srgbClr val="1F2937"/>'], ['lt2', '<a:srgbClr val="F3F4F6"/>'],
    ['accent1', '<a:srgbClr val="2F9E63"/>'], ['accent2', '<a:srgbClr val="3CBC93"/>'], ['accent3', '<a:srgbClr val="55BFD0"/>'], ['accent4', '<a:srgbClr val="1A93FE"/>'],
    ['accent5', '<a:srgbClr val="D97706"/>'], ['accent6', '<a:srgbClr val="DC2626"/>'], ['hlink', '<a:srgbClr val="1A93FE"/>'], ['folHlink', '<a:srgbClr val="7A7A7A"/>']]
    .map(([k, v]) => `<a:${k}>${v}</a:${k}>`).join('');
  const font = (/** @type {string} */ face) => `<a:latin typeface="${face}"/><a:ea typeface=""/><a:cs typeface=""/>`;
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const line = (/** @type {number} */ w) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr">${fill}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
  return `${HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${esc(name)}"><a:themeElements>`
    + `<a:clrScheme name="OpenFilm">${colors}</a:clrScheme>`
    + `<a:fontScheme name="OpenFilm"><a:majorFont>${font('Helvetica Neue')}</a:majorFont><a:minorFont>${font('Helvetica Neue')}</a:minorFont></a:fontScheme>`
    + `<a:fmtScheme name="OpenFilm"><a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst><a:lnStyleLst>${line(6350)}${line(12700)}${line(19050)}</a:lnStyleLst>`
    + '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
    + `<a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst></a:fmtScheme>`
    + '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';
}

/** A placeholder shape: `type`, an `idx`, where it sits (EMU), and text in it. */
function placeholder(/** @type {number} */ id, /** @type {string} */ name, /** @type {string} */ ph, /** @type {[number, number, number, number] | null} */ box, /** @type {string | null} */ text) {
  const locks = ph.includes('sldImg') ? '<a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/>' : '<a:spLocks noGrp="1"/>';
  const xfrm = box ? `<a:xfrm><a:off x="${box[0]}" y="${box[1]}"/><a:ext cx="${box[2]}" cy="${box[3]}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` : '';
  const body = text == null ? '' : `<p:txBody><a:bodyPr/><a:lstStyle/>${text
    ? text.split('\n').map((l) => `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${esc(l)}</a:t></a:r></a:p>`).join('')
    : '<a:p><a:endParaRPr lang="en-US"/></a:p>'}</p:txBody>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr>${locks}</p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${xfrm}</p:spPr>${body}</p:sp>`;
}

/**
 * A PowerPoint deck: one slide per page, the picture filling it on black, the page's label in the speaker notes. The
 * slide has the pictures' shape, its long side 13.333 inches (PowerPoint's widescreen).
 * @param {readonly SlidePage[]} pages @param {string} title
 * @returns {{ name: string, data: Buffer }[]} the parts of the deck, as zip entries
 */
export function pptxParts(pages, title) {
  const first = pages[0] ?? { w: 1920, h: 1080 };
  const long = 12_192_000;
  const clamp = (/** @type {number} */ n) => Math.max(914_400, Math.min(51_206_400, Math.round(n)));
  const cx = clamp(first.w >= first.h ? long : (long * first.w) / first.h);
  const cy = clamp(first.w >= first.h ? (long * first.h) / first.w : long);
  /* the notes page: portrait letter, the slide's picture above the notes */
  const nW = 6_858_000, nH = 9_144_000;
  const imgW = nW - 2 * 685_800, imgH = Math.round((imgW * cy) / cx);
  const xml = (/** @type {string} */ s) => Buffer.from(s, 'utf8');
  /** @type {{ name: string, data: Buffer }[]} */
  const parts = [];

  const overrides = [
    ['/ppt/presentation.xml', `${CT}.presentationml.presentation.main+xml`],
    ['/ppt/slideMasters/slideMaster1.xml', `${CT}.presentationml.slideMaster+xml`],
    ['/ppt/slideLayouts/slideLayout1.xml', `${CT}.presentationml.slideLayout+xml`],
    ['/ppt/notesMasters/notesMaster1.xml', `${CT}.presentationml.notesMaster+xml`],
    ['/ppt/theme/theme1.xml', `${CT}.theme+xml`],
    ['/ppt/theme/theme2.xml', `${CT}.theme+xml`],
    ['/ppt/presProps.xml', `${CT}.presentationml.presProps+xml`],
    ['/ppt/viewProps.xml', `${CT}.presentationml.viewProps+xml`],
    ['/ppt/tableStyles.xml', `${CT}.presentationml.tableStyles+xml`],
    ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
    ['/docProps/app.xml', `${CT}.extended-properties+xml`],
    ...pages.flatMap((_, i) => [
      [`/ppt/slides/slide${i + 1}.xml`, `${CT}.presentationml.slide+xml`],
      [`/ppt/notesSlides/notesSlide${i + 1}.xml`, `${CT}.presentationml.notesSlide+xml`],
    ]),
  ];
  parts.push({
    name: '[Content_Types].xml',
    data: xml(`${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/>'
      + `${overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join('')}</Types>`),
  });
  parts.push({
    name: '_rels/.rels',
    data: xml(relsXml([
      ['rId1', 'officeDocument', 'ppt/presentation.xml'],
      ['rId2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'],
      ['rId3', 'extended-properties', 'docProps/app.xml'],
    ])),
  });
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  parts.push({
    name: 'docProps/core.xml',
    data: xml(`${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
      + `<dc:title>${esc(title)}</dc:title><dc:creator>OpenFilm</dc:creator>`
      + `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`),
  });
  parts.push({
    name: 'docProps/app.xml',
    data: xml(`${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>OpenFilm</Application><Slides>${pages.length}</Slides><Notes>${pages.length}</Notes></Properties>`),
  });

  parts.push({
    name: 'ppt/presentation.xml',
    data: xml(`${HEAD}<p:presentation ${NS} saveSubsetFonts="1">`
      + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
      + '<p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>'
      + `<p:sldIdLst>${pages.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${10 + i}"/>`).join('')}</p:sldIdLst>`
      + `<p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="${nW}" cy="${nH}"/></p:presentation>`),
  });
  parts.push({
    name: 'ppt/_rels/presentation.xml.rels',
    data: xml(relsXml([
      ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
      ['rId2', 'notesMaster', 'notesMasters/notesMaster1.xml'],
      ['rId3', 'theme', 'theme/theme1.xml'],
      ['rId4', 'presProps', 'presProps.xml'],
      ['rId5', 'viewProps', 'viewProps.xml'],
      ['rId6', 'tableStyles', 'tableStyles.xml'],
      ...pages.map((_, i) => /** @type {[string, string, string]} */ ([`rId${10 + i}`, 'slide', `slides/slide${i + 1}.xml`])),
    ])),
  });
  parts.push({ name: 'ppt/presProps.xml', data: xml(`${HEAD}<p:presentationPr ${NS}/>`) });
  parts.push({
    name: 'ppt/viewProps.xml',
    data: xml(`${HEAD}<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`),
  });
  parts.push({ name: 'ppt/tableStyles.xml', data: xml(`${HEAD}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`) });
  parts.push({ name: 'ppt/theme/theme1.xml', data: xml(themeXml('OpenFilm')) });
  parts.push({ name: 'ppt/theme/theme2.xml', data: xml(themeXml('OpenFilm Notes')) });

  parts.push({
    name: 'ppt/slideMasters/slideMaster1.xml',
    data: xml(`${HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}</p:spTree></p:cSld>`
      + `${CLR_MAP}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>`
      + '<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>'),
  });
  parts.push({ name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: xml(relsXml([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']])) });
  parts.push({
    name: 'ppt/slideLayouts/slideLayout1.xml',
    data: xml(`${HEAD}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GROUP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`),
  });
  parts.push({ name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: xml(relsXml([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']])) });

  const notesImage = /** @type {[number, number, number, number]} */ ([685_800, 685_800, imgW, imgH]);
  const notesBody = /** @type {[number, number, number, number]} */ ([685_800, 685_800 + imgH + 457_200, imgW, Math.max(914_400, nH - imgH - 2 * 685_800 - 457_200)]);
  parts.push({
    name: 'ppt/notesMasters/notesMaster1.xml',
    data: xml(`${HEAD}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}`
      + placeholder(2, 'Slide Image Placeholder 1', '<p:ph type="sldImg" idx="2"/>', notesImage, null)
      + placeholder(3, 'Notes Placeholder 2', '<p:ph type="body" sz="quarter" idx="3"/>', notesBody, '')
      + `</p:spTree></p:cSld>${CLR_MAP}</p:notesMaster>`),
  });
  parts.push({ name: 'ppt/notesMasters/_rels/notesMaster1.xml.rels', data: xml(relsXml([['rId1', 'theme', '../theme/theme2.xml']])) });

  pages.forEach((page, i) => {
    const n = i + 1;
    const label = page.label || `Slide ${n}`;
    parts.push({
      name: `ppt/slides/slide${n}.xml`,
      data: xml(`${HEAD}<p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${GROUP}`
        + `<p:pic><p:nvPicPr><p:cNvPr id="2" name="Picture 1" descr="${esc(label)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>`
        + '<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
        + `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
        + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'),
    });
    parts.push({
      name: `ppt/slides/_rels/slide${n}.xml.rels`,
      data: xml(relsXml([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'image', `../media/image${n}.jpeg`], ['rId3', 'notesSlide', `../notesSlides/notesSlide${n}.xml`]])),
    });
    parts.push({ name: `ppt/media/image${n}.jpeg`, data: page.jpeg });
    parts.push({
      name: `ppt/notesSlides/notesSlide${n}.xml`,
      data: xml(`${HEAD}<p:notes ${NS}><p:cSld><p:spTree>${GROUP}`
        + placeholder(2, 'Slide Image Placeholder 1', '<p:ph type="sldImg"/>', null, null)
        + placeholder(3, 'Notes Placeholder 2', '<p:ph type="body" idx="1"/>', null, page.label)
        + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>'),
    });
    parts.push({ name: `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`, data: xml(relsXml([['rId1', 'notesMaster', '../notesMasters/notesMaster1.xml'], ['rId2', 'slide', `../slides/slide${n}.xml`]])) });
  });
  return parts;
}

/** Write a PowerPoint deck of `pages` to `out`. @param {string} out @param {readonly SlidePage[]} pages @param {string} title @param {AbortSignal} [signal] */
export function writePptx(out, pages, title, signal) {
  return zipFiles(out, pptxParts(pages, title), signal);
}

/**
 * A PDF of `pages`, one per sheet, each sheet the size of its picture (CSS pixels, 96 to the inch), printed by
 * Chromium. All pages take the first one's size (a film's stills all have one shape).
 * @param {readonly SlidePage[]} pages @returns {Promise<Buffer>}
 */
export async function slidesPdf(pages) {
  const { w, h } = pages[0] ?? { w: 1920, h: 1080 };
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:${w}px ${h}px;margin:0}html,body{margin:0;padding:0;background:#000}`
    + `img{display:block;width:${w}px;height:${h}px;object-fit:contain;break-after:page}img:last-child{break-after:auto}</style></head><body>`
    + pages.map((p) => `<img alt="" src="data:image/jpeg;base64,${p.jpeg.toString('base64')}">`).join('')
    + '</body></html>';
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => Promise.all([...document.images].map((img) => img.decode().catch(() => {}))));
    return await page.pdf({ width: `${w}px`, height: `${h}px`, printBackground: true, preferCSSPageSize: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
  } finally {
    await browser.close();
  }
}
