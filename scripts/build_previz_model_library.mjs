// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 把 Kenney 的 CC0 素材包整理成预演台模型库：glb + 缩略图上 CDN，清单与名称进仓库。
 *
 * 用法（依赖只装在临时目录，不进 frontend 的 lockfile）：
 *
 *     mkdir -p /tmp/previz-lib && cd /tmp/previz-lib && npm init -y >/dev/null
 *     npm i @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions sharp
 *     node <repo>/scripts/build_previz_model_library.mjs \
 *         --kenney ~/Downloads/kenney \
 *         --out /tmp/previz-lib/out \
 *         --repo <repo>
 *
 * --kenney 下每个素材包解压成一个目录，目录名即 PACKS 的键（furniture-kit、car-kit……），
 * 均取自 https://kenney.nl/assets/<目录名>，授权 CC0-1.0（包内 License.txt）。
 *
 * 产物：
 * - `--out/<分类>/<名字>.glb|.webp`：整个目录传 CDN 的 `PREVIZ_MODEL_LIBRARY_VERSION`
 *   那一层（见 `modelLibrary.ts`）。模型或尺寸有变就换版本号整目录重传，别覆盖旧的——
 *   已经摆进场景的物件记的是带版本号的完整 URL。
 * - `--repo` 下写两处：`frontend/src/features/previz/domain/libraryModels.ts`（清单）
 *   与三份 locale 里的 `previz.library.model` 块（名称）。
 *
 * 每个模型做三件事：挪成底面贴地、XZ 以原点居中（与基础几何体同一约定，占位方块换成
 * 模型时不跳位）；按素材包的比例换算成真实尺寸（Kenney 各包单位不统一，家具包一把椅子
 * 0.47、道路包一格路 1.0）；外链贴图内嵌进 glb，CDN 上一个文件就是一个模型。
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 依赖从当前目录解析（见用法），而不是从脚本所在的仓库目录。
const requireFromCwd = createRequire(pathToFileURL(path.join(process.cwd(), '/')));
const load = (name) => import(pathToFileURL(requireFromCwd.resolve(name)).href);
const { NodeIO } = await load('@gltf-transform/core');
const { ALL_EXTENSIONS } = await load('@gltf-transform/extensions');
const { getBounds, prune, dedup } = await load('@gltf-transform/functions');
const sharp = (await load('sharp')).default;

/**
 * 素材包：模型目录、缩略图怎么找、默认比例。
 *
 * scale 是「素材单位 → 米」：拿包里几件尺寸确定的东西（门洞、冰箱、路灯、汽车）对着
 * 真实尺寸定的，定完再以 1.75 m 的人物为参照目测一遍。个别件与包内比例不一致的，在
 * 条目上单独覆盖。
 */
const PACKS = {
  'furniture-kit': { models: 'Models/GLTF format', preview: (f) => `Isometric/${f}_SW.png`, scale: 1.9 },
  'nature-kit': { models: 'Models/GLTF format', preview: (f) => `Isometric/${f}_SW.png`, scale: 4 },
  'building-kit': { models: 'Models/GLB format', preview: (f) => `Previews/${f}.png`, scale: 1 },
  'car-kit': { models: 'Models/GLB format', preview: (f) => `Previews/${f}.png`, scale: 1.2 },
  'city-kit-roads': { models: 'Models/GLB format', preview: (f) => `Previews/${f}.png`, scale: 8 },
  'city-kit-commercial': { models: 'Models/GLB format', preview: (f) => `Previews/${f}.png`, scale: 8 },
  'city-kit-suburban': { models: 'Models/GLB format', preview: (f) => `Previews/${f}.png`, scale: 8 },
  'city-kit-industrial': { models: 'Models/GLB format', preview: (f) => `Previews/${f}.png`, scale: 8 },
  'survival-kit': { models: 'Models/GLB format', preview: (f) => `Previews/${f}.png`, scale: 2.4 },
};

/**
 * 分类 → 条目。条目：[名字, 素材包, 源文件名（不带扩展名）, 中文名, 英文名, 选项]。
 * 选项里 scale 覆盖素材包默认比例，tags 是额外的英文搜索词。
 * 顺序即模型库里的展示顺序；名字在分类内唯一，CDN 路径与 id 都由它派生，改名等于换模型。
 */
const F = 'furniture-kit';
const N = 'nature-kit';
const B = 'building-kit';
const C = 'car-kit';
const R = 'city-kit-roads';
const CM = 'city-kit-commercial';
const S = 'city-kit-suburban';
const I = 'city-kit-industrial';
const SV = 'survival-kit';

const CATALOG = {
  furniture: [
    ['chair', F, 'chair', '椅子', 'Chair'],
    ['sofa', F, 'loungeSofa', '沙发', 'Sofa', { tags: ['couch'] }],
    ['dining-table', F, 'table', '餐桌', 'Dining table'],
    ['desk', F, 'desk', '书桌', 'Desk'],
    ['bed-double', F, 'bedDouble', '双人床', 'Double bed'],
    ['bookshelf', F, 'bookcaseOpen', '书架', 'Bookshelf'],
    ['nightstand', F, 'cabinetBedDrawer', '床头柜', 'Nightstand'],
    ['bar-stool', F, 'stoolBar', '吧椅', 'Bar stool'],
    ['floor-lamp', F, 'lampRoundFloor', '落地灯', 'Floor lamp'],
    ['bathtub', F, 'bathtub', '浴缸', 'Bathtub'],
    ['armchair', F, 'loungeChair', '扶手椅', 'Armchair'],
    ['coffee-table', F, 'tableCoffee', '茶几', 'Coffee table'],
    ['console-table', F, 'sideTable', '玄关桌', 'Console table', { tags: ['side table'] }],
    ['bed-single', F, 'bedSingle', '单人床', 'Single bed'],
    ['bunk-bed', F, 'bedBunk', '双层床', 'Bunk bed'],
    ['bookcase-closed', F, 'bookcaseClosedDoors', '封闭书柜', 'Closed bookcase', { tags: ['cabinet'] }],
    ['bench', F, 'bench', '长凳', 'Bench'],
    ['office-chair', F, 'chairDesk', '办公椅', 'Office chair'],
    ['fridge', F, 'kitchenFridge', '冰箱', 'Fridge', { tags: ['refrigerator'] }],
    ['toilet', F, 'toilet', '马桶', 'Toilet'],
    ['bathroom-cabinet', F, 'bathroomCabinet', '浴室柜', 'Bathroom cabinet'],
    ['bathroom-sink', F, 'bathroomSink', '洗手台', 'Bathroom sink', { tags: ['basin'] }],
    ['shower', F, 'shower', '淋浴间', 'Shower'],
    ['kitchen-cabinet', F, 'kitchenCabinet', '厨房柜', 'Kitchen cabinet'],
    ['kitchen-sink', F, 'kitchenSink', '厨房水槽', 'Kitchen sink'],
    ['stove', F, 'kitchenStove', '炉灶', 'Stove', { tags: ['cooker', 'oven'] }],
    ['kitchen-bar', F, 'kitchenBar', '吧台', 'Kitchen bar', { tags: ['counter'] }],
    ['hexagonal-table', F, 'tableRound', '六角桌', 'Hexagonal table'],
    ['glass-table', F, 'tableGlass', '玻璃桌', 'Glass table'],
    ['lounge-chair', F, 'loungeChairRelax', '躺椅', 'Lounge chair', { tags: ['recliner'] }],
    ['design-sofa', F, 'loungeDesignSofa', '设计沙发', 'Design sofa', { tags: ['couch'] }],
    ['ottoman', F, 'loungeSofaOttoman', '脚凳', 'Ottoman', { tags: ['footstool'] }],
    ['cushion-chair', F, 'chairCushion', '软垫椅', 'Cushioned chair'],
    ['modern-chair', F, 'chairModernCushion', '现代椅', 'Modern chair'],
    ['table-lamp', F, 'lampRoundTable', '台灯', 'Table lamp'],
    ['wall-lamp', F, 'lampWall', '壁灯', 'Wall lamp', { tags: ['sconce'] }],
    ['ceiling-lamp', F, 'lampSquareCeiling', '吊灯', 'Ceiling lamp', { tags: ['pendant'] }],
    ['rug', F, 'rugRectangle', '地毯', 'Rug', { tags: ['carpet'] }],
    ['tv-cabinet', F, 'cabinetTelevision', '电视柜', 'TV cabinet'],
    ['loveseat', F, 'loungeDesignChair', '双人沙发', 'Loveseat', { tags: ['couch', 'sofa'] }],
  ],
  architecture: [
    ['wall', B, 'wall', '墙体', 'Wall'],
    ['wall-half', B, 'wall-half', '半墙', 'Half wall'],
    ['wall-low', B, 'wall-low', '矮墙', 'Low wall'],
    ['wall-corner', B, 'wall-corner', '转角墙', 'Corner wall'],
    ['wall-corner-diagonal', B, 'wall-corner-diagonal', '斜角墙', 'Diagonal corner wall'],
    ['wall-corner-round', B, 'wall-corner-round', '圆角墙', 'Rounded corner wall'],
    ['doorway', B, 'wall-doorway-square', '门洞', 'Doorway'],
    ['doorway-arch', B, 'wall-doorway-round', '拱形门洞', 'Arched doorway'],
    ['doorway-wide', B, 'wall-doorway-wide-square', '宽门洞', 'Wide doorway', { tags: ['garage'] }],
    ['doorway-wide-arch', B, 'wall-doorway-wide-round', '宽拱门洞', 'Wide arched doorway'],
    ['window-wall', B, 'wall-window-square', '窗墙', 'Window wall'],
    ['window-wall-wide', B, 'wall-window-wide-square', '宽窗墙', 'Wide window wall'],
    ['window-wall-arch', B, 'wall-window-round', '拱窗墙', 'Arched window wall'],
    ['door', B, 'door-rotate-square-a', '门', 'Door'],
    ['door-arch', B, 'door-rotate-round-a', '拱门', 'Arched door'],
    ['floor', B, 'floor', '地板模块', 'Floor tile'],
    ['floor-half', B, 'floor-half', '半块地板', 'Half floor tile'],
    ['column', B, 'column', '立柱', 'Column', { tags: ['pillar'] }],
    ['column-wide', B, 'column-wide', '宽立柱', 'Wide column', { tags: ['pillar'] }],
    ['stairs', B, 'stairs-closed', '楼梯', 'Stairs', { tags: ['steps'] }],
    ['stairs-open', B, 'stairs-open', '开放楼梯', 'Open stairs', { tags: ['steps'] }],
    ['stairs-short', B, 'stairs-closed-short', '矮楼梯', 'Short stairs', { tags: ['steps'] }],
    ['stairs-narrow', B, 'stairs-center', '窄楼梯', 'Narrow stairs', { tags: ['steps'] }],
    ['roof-flat', B, 'roof-flat-square', '平屋顶', 'Flat roof'],
  ],
  city: [
    ['building-a', CM, 'building-a', '城市建筑 A', 'City building A'],
    ['building-c', CM, 'building-c', '城市建筑 B', 'City building B'],
    ['building-f', CM, 'building-f', '城市建筑 C', 'City building C'],
    ['building-h', CM, 'building-h', '城市建筑 D', 'City building D'],
    ['skyscraper-a', CM, 'building-skyscraper-a', '摩天楼 A', 'Skyscraper A', { tags: ['tower'] }],
    ['skyscraper-c', CM, 'building-skyscraper-c', '摩天楼 B', 'Skyscraper B', { tags: ['tower'] }],
    ['house-a', S, 'building-type-a', '郊区住宅 A', 'Suburban house A', { tags: ['home'] }],
    ['house-f', S, 'building-type-f', '郊区住宅 B', 'Suburban house B', { tags: ['home'] }],
    ['house-k', S, 'building-type-k', '郊区住宅 C', 'Suburban house C', { tags: ['home'] }],
    ['factory-a', I, 'building-a', '工厂 A', 'Factory A', { tags: ['industrial'] }],
    ['factory-d', I, 'building-d', '工厂 B', 'Factory B', { tags: ['industrial'] }],
    ['road', R, 'road-straight', '道路模块', 'Road', { tags: ['street'] }],
    ['crosswalk', R, 'road-crossing', '人行横道', 'Crosswalk', { tags: ['crossing', 'zebra'] }],
    ['road-bend', R, 'road-bend', '弯道路段', 'Road bend', { tags: ['street'] }],
    ['road-curve', R, 'road-curve', '宽幅弯道', 'Wide road curve', { tags: ['street'] }],
    ['crossroad', R, 'road-crossroad', '十字路口', 'Crossroad', { tags: ['intersection'] }],
    ['t-junction', R, 'road-intersection', 'T形路口', 'T-junction', { tags: ['intersection'] }],
    ['roundabout', R, 'road-roundabout', '环岛', 'Roundabout'],
    ['road-end', R, 'road-end-round', '尽头路段', 'Dead end', { tags: ['street'] }],
    ['road-barrier', R, 'road-straight-barrier', '护栏道路', 'Road with barrier', { tags: ['guardrail'] }],
    ['road-side', R, 'road-side', '路侧车道', 'Roadside lane'],
    ['sidewalk-corner', R, 'road-bend-sidewalk', '人行道弯角', 'Sidewalk corner'],
    ['road-bridge', R, 'road-bridge', '公路桥', 'Road bridge'],
    ['bridge-pillar', R, 'bridge-pillar', '桥梁立柱', 'Bridge pillar'],
    ['bridge-pillar-wide', R, 'bridge-pillar-wide', '宽桥梁立柱', 'Wide bridge pillar'],
    ['street-light', R, 'light-curved', '路灯', 'Street light', { tags: ['lamp'] }],
    ['street-light-double', R, 'light-curved-double', '双臂路灯', 'Double street light', { tags: ['lamp'] }],
    ['street-light-square', R, 'light-square', '方形路灯', 'Square street light', { tags: ['lamp'] }],
    ['street-light-square-double', R, 'light-square-double', '双臂方形路灯', 'Double square street light', { tags: ['lamp'] }],
    ['traffic-light', R, 'traffic-light', '交通灯', 'Traffic light'],
    ['traffic-light-hanging', R, 'traffic-light-hanging', '悬挂交通灯', 'Hanging traffic light'],
    ['stop-sign', R, 'road-sign-stop', '停车标志', 'Stop sign'],
    ['warning-sign', R, 'road-sign-warning', '道路警告牌', 'Warning sign'],
    ['street-sign', R, 'road-sign-street', '街道路牌', 'Street sign'],
    ['highway-sign', R, 'sign-highway', '高速路牌', 'Highway sign'],
    ['highway-sign-wide', R, 'sign-highway-wide', '宽型高速路牌', 'Wide highway sign'],
    ['construction-barrier', R, 'construction-barrier', '施工围挡', 'Construction barrier'],
    ['construction-fence', R, 'construction-fence', '施工围栏', 'Construction fence'],
    ['construction-light', R, 'construction-light', '施工警示灯', 'Construction light'],
    ['dumpster', R, 'dumpster', '大型垃圾箱', 'Dumpster', { tags: ['trash', 'bin'] }],
    ['power-pole', R, 'electricity-pole', '电线杆', 'Power pole', { scale: 14, tags: ['utility pole'] }],
    ['power-pole-wide', R, 'electricity-pole-wide', '宽型电线杆', 'Wide power pole', { scale: 14, tags: ['utility pole'] }],
    ['power-lines', R, 'electricity-wires', '架空电线', 'Power lines', { scale: 14, tags: ['wires'] }],
    ['parasol', CM, 'detail-parasol-a', '户外遮阳伞', 'Parasol', { tags: ['umbrella'] }],
    ['awning', CM, 'detail-awning', '遮阳篷', 'Awning'],
    ['fence', S, 'fence', '郊区围栏', 'Fence'],
    ['fence-low', S, 'fence-low', '低围栏', 'Low fence'],
    ['fence-long', S, 'fence-1x4', '长围栏', 'Long fence'],
    ['fence-wide', S, 'fence-3x3', '宽围栏', 'Wide fence'],
    ['driveway-long', S, 'driveway-long', '长车道', 'Long driveway'],
    ['driveway-short', S, 'driveway-short', '短车道', 'Short driveway'],
    ['path-long', S, 'path-long', '长步道', 'Long path', { tags: ['walkway'] }],
    ['path-short', S, 'path-short', '短步道', 'Short path', { tags: ['walkway'] }],
    ['path-stones', S, 'path-stones-long', '石板步道', 'Stepping stones'],
    ['planter', S, 'planter', '户外花箱', 'Planter'],
    ['chimney-large', I, 'chimney-large', '大型工业烟囱', 'Large chimney', { tags: ['smokestack'] }],
    ['chimney-medium', I, 'chimney-medium', '中型工业烟囱', 'Medium chimney', { tags: ['smokestack'] }],
    ['tank', I, 'detail-tank', '工业储罐', 'Storage tank'],
    ['water-tower', I, 'water-tower', '水塔', 'Water tower'],
    ['shipping-container', I, 'shipping-container-a', '集装箱', 'Shipping container'],
  ],
  vehicle: [
    ['sedan', C, 'sedan', '轿车', 'Sedan', { tags: ['car'] }],
    ['truck', C, 'truck', '货车', 'Truck', { tags: ['lorry'] }],
    ['taxi', C, 'taxi', '出租车', 'Taxi', { tags: ['cab', 'car'] }],
    ['police', C, 'police', '警车', 'Police car', { tags: ['car'] }],
    ['ambulance', C, 'ambulance', '救护车', 'Ambulance'],
    ['firetruck', C, 'firetruck', '消防车', 'Fire truck'],
    ['van', C, 'van', '厢式车', 'Van'],
    ['delivery', C, 'delivery', '配送车', 'Delivery van'],
    ['suv', C, 'suv', '越野车', 'SUV', { tags: ['car'] }],
    ['sports-car', C, 'sedan-sports', '跑车', 'Sports car', { tags: ['car'] }],
    ['hatchback', C, 'hatchback-sports', '两厢车', 'Hatchback', { tags: ['car'] }],
    ['tractor', C, 'tractor', '拖拉机', 'Tractor'],
    ['garbage-truck', C, 'garbage-truck', '垃圾清运车', 'Garbage truck'],
    ['race-car', C, 'race', '赛车', 'Race car', { tags: ['car'] }],
    ['suv-luxury', C, 'suv-luxury', '豪华越野车', 'Luxury SUV', { tags: ['car'] }],
    ['flatbed-truck', C, 'truck-flat', '平板货车', 'Flatbed truck'],
    ['loader', C, 'tractor-shovel', '装载机', 'Wheel loader', { tags: ['bulldozer'] }],
    ['race-car-future', C, 'race-future', '未来赛车', 'Future race car', { tags: ['car'] }],
    ['kart', C, 'kart-oobi', '卡丁车', 'Kart', { tags: ['go-kart'] }],
    ['canoe', N, 'canoe', '独木舟', 'Canoe', { scale: 3, tags: ['boat'] }],
  ],
  prop: [
    ['crate', SV, 'box-large', '木箱', 'Crate', { tags: ['box'] }],
    ['monitor', F, 'computerScreen', '电脑显示器', 'Computer monitor', { tags: ['screen'] }],
    ['cardboard-box', F, 'cardboardBoxClosed', '纸箱', 'Cardboard box', { tags: ['box'] }],
    ['cardboard-box-open', F, 'cardboardBoxOpen', '开口纸箱', 'Open cardboard box', { tags: ['box'] }],
    ['laptop', F, 'laptop', '笔记本电脑', 'Laptop'],
    ['television', F, 'televisionModern', '电视机', 'Television', { tags: ['tv'] }],
    ['television-vintage', F, 'televisionVintage', '复古电视机', 'Vintage television', { tags: ['tv'] }],
    ['radio', F, 'radio', '收音机', 'Radio'],
    ['books', F, 'books', '书籍', 'Books'],
    ['keyboard', F, 'computerKeyboard', '键盘', 'Keyboard'],
    ['mouse', F, 'computerMouse', '鼠标', 'Mouse'],
    ['speaker', F, 'speaker', '音箱', 'Speaker'],
    ['toaster', F, 'toaster', '烤面包机', 'Toaster'],
    ['coffee-machine', F, 'kitchenCoffeeMachine', '咖啡机', 'Coffee machine'],
    ['microwave', F, 'kitchenMicrowave', '微波炉', 'Microwave'],
    ['blender', F, 'kitchenBlender', '搅拌机', 'Blender'],
    ['pillow', F, 'pillow', '抱枕', 'Pillow', { tags: ['cushion'] }],
    ['mirror', F, 'bathroomMirror', '壁镜', 'Wall mirror'],
    ['ceiling-fan', F, 'ceilingFan', '吊扇', 'Ceiling fan'],
    ['coat-rack', F, 'coatRackStanding', '衣帽架', 'Coat rack'],
    ['teddy-bear', F, 'bear', '玩具熊', 'Teddy bear', { tags: ['toy'] }],
    ['potted-plant', F, 'pottedPlant', '盆栽', 'Potted plant'],
    ['trash-can', F, 'trashcan', '垃圾桶', 'Trash can', { tags: ['bin'] }],
    ['washing-machine', F, 'washer', '洗衣机', 'Washing machine'],
    ['traffic-cone', R, 'construction-cone', '交通锥', 'Traffic cone'],
    ['tent-closed', N, 'tent_detailedClosed', '封闭露营帐篷', 'Closed tent', { scale: 2.5 }],
    ['tent-open', N, 'tent_detailedOpen', '开放露营帐篷', 'Open tent', { scale: 2.5 }],
    ['campfire-stones', N, 'campfire_stones', '石圈篝火', 'Campfire with stones', { scale: 2.5 }],
    ['campfire-logs', N, 'campfire_logs', '原木篝火', 'Log campfire', { scale: 2.5 }],
    ['paddle', N, 'canoe_paddle', '独木舟桨', 'Paddle', { scale: 3, tags: ['oar'] }],
    ['barrel', SV, 'barrel', '木桶', 'Barrel'],
    ['chest', SV, 'chest', '宝箱', 'Chest', { tags: ['treasure'] }],
    ['bucket', SV, 'bucket', '水桶', 'Bucket'],
    ['axe', SV, 'tool-axe', '斧头', 'Axe', { tags: ['tool'] }],
    ['shovel', SV, 'tool-shovel', '铁锹', 'Shovel', { tags: ['tool'] }],
    ['hammer', SV, 'tool-hammer', '锤子', 'Hammer', { tags: ['tool'] }],
    ['pickaxe', SV, 'tool-pickaxe', '镐', 'Pickaxe', { tags: ['tool'] }],
    ['workbench', SV, 'workbench', '工作台', 'Workbench'],
    ['signpost', SV, 'signpost', '路标', 'Signpost'],
  ],
  nature: [
    ['bush', N, 'plant_bush', '灌木', 'Bush', { scale: 2, tags: ['shrub'] }],
    ['bush-small', N, 'plant_bushSmall', '小灌木', 'Small bush', { scale: 2, tags: ['shrub'] }],
    ['bush-large', N, 'plant_bushLarge', '大型灌木', 'Large bush', { scale: 2, tags: ['shrub'] }],
    ['bush-triangle', N, 'plant_bushTriangle', '三角灌木', 'Triangle bush', { scale: 2, tags: ['shrub'] }],
    ['bush-triangle-large', N, 'plant_bushLargeTriangle', '大型三角灌木', 'Large triangle bush', { scale: 2, tags: ['shrub'] }],
    ['tree-oak', N, 'tree_oak', '橡树', 'Oak tree'],
    ['tree-default', N, 'tree_default', '阔叶树', 'Broadleaf tree'],
    ['tree-fat', N, 'tree_fat', '阔冠树', 'Wide-crown tree'],
    ['tree-blocks', N, 'tree_blocks', '积木树', 'Blocky tree'],
    ['tree-cone', N, 'tree_cone', '锥形树', 'Cone tree'],
    ['tree-pine', N, 'tree_pineDefaultA', '松树', 'Pine tree'],
    ['tree-pine-tall', N, 'tree_pineTallA_detailed', '高松', 'Tall pine'],
    ['tree-pine-small', N, 'tree_pineSmallA', '矮松', 'Small pine'],
    ['tree-fir', N, 'tree_pineRoundA', '冷杉', 'Fir tree'],
    ['tree-palm', N, 'tree_palm', '棕榈树', 'Palm tree'],
    ['tree-palm-bend', N, 'tree_palmBend', '弯曲棕榈树', 'Bent palm tree'],
    ['tree-palm-detailed', N, 'tree_palmDetailedTall', '精细棕榈树', 'Detailed palm tree'],
    ['tree-suburban-large', S, 'tree-large', '郊区大树', 'Large suburban tree'],
    ['tree-suburban-small', S, 'tree-small', '郊区小树', 'Small suburban tree'],
    ['grass', N, 'grass', '草丛', 'Grass', { scale: 2 }],
    ['grass-leafy', N, 'grass_leafsLarge', '宽叶草丛', 'Leafy grass', { scale: 2 }],
    ['reeds', N, 'plant_flatTall', '芦苇', 'Reeds', { scale: 2 }],
    ['flower-red', N, 'flower_redA', '花卉', 'Flowers', { scale: 2 }],
    ['flower-yellow', N, 'flower_yellowA', '黄花', 'Yellow flowers', { scale: 2 }],
    ['flower-purple', N, 'flower_purpleA', '紫花', 'Purple flowers', { scale: 2 }],
    ['mushroom', N, 'mushroom_red', '蘑菇', 'Mushroom', { scale: 2 }],
    ['mushroom-tall', N, 'mushroom_redTall', '高脚蘑菇', 'Tall mushroom', { scale: 2 }],
    ['cactus', N, 'cactus_tall', '仙人掌', 'Cactus'],
    ['cactus-short', N, 'cactus_short', '矮仙人掌', 'Short cactus'],
    ['boulder', N, 'rock_largeA', '巨石', 'Boulder', { tags: ['rock'] }],
    ['rock-tall', N, 'rock_tallA', '立岩', 'Standing rock', { tags: ['rock'] }],
    ['rock-flat', N, 'rock_smallFlatA', '扁平岩石', 'Flat rock', { scale: 2, tags: ['stone'] }],
    ['pebbles', N, 'rock_smallA', '碎石', 'Pebbles', { scale: 2, tags: ['stone', 'rock'] }],
    ['cliff', N, 'cliff_block_rock', '岩壁模块', 'Cliff block', { tags: ['rock'] }],
    ['stump', N, 'stump_round', '树桩', 'Stump', { scale: 2.5 }],
    ['stump-detailed', N, 'stump_roundDetailed', '圆树桩', 'Round stump', { scale: 2.5 }],
    ['log', N, 'log', '倒木', 'Fallen log', { scale: 2.5 }],
    ['log-stack', N, 'log_stack', '原木堆', 'Log pile', { scale: 2.5 }],
    ['log-stack-large', N, 'log_stackLarge', '大型原木堆', 'Large log pile', { scale: 2.5 }],
  ],
};

const THUMBNAIL_EDGE = 128;
const LOCALES = { zh: 'zh', en: 'en', vi: 'en' };

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  for (const key of ['kenney', 'out', 'repo']) {
    if (!args[key]) throw new Error(`missing --${key}`);
  }
  return args;
}

/** 数三角面：按节点实例计，一份网格挂在两个节点上算两份。 */
function countTriangles(scene) {
  let total = 0;
  scene.traverse((node) => {
    const mesh = node.getMesh();
    if (!mesh) return;
    for (const primitive of mesh.listPrimitives()) {
      const indices = primitive.getIndices();
      const count = indices ? indices.getCount() : primitive.getAttribute('POSITION').getCount();
      total += count / 3;
    }
  });
  return total;
}

/** 整个场景包一层根节点：先挪到底面贴地、XZ 居中，再乘比例。 */
function standOnOrigin(doc, scene, scale) {
  const { min, max } = getBounds(scene);
  const root = doc.createNode('previz-root');
  for (const child of scene.listChildren()) {
    scene.removeChild(child);
    root.addChild(child);
  }
  root.setScale([scale, scale, scale]);
  root.setTranslation([
    (-(min[0] + max[0]) / 2) * scale,
    -min[1] * scale,
    (-(min[2] + max[2]) / 2) * scale,
  ]);
  scene.addChild(root);
  return max.map((value, axis) => (value - min[axis]) * scale);
}

async function buildModel(io, kenneyDir, outDir, category, entry) {
  const [name, pack, file, , , options = {}] = entry;
  const spec = PACKS[pack];
  const packDir = path.join(kenneyDir, pack);
  const doc = await io.read(path.join(packDir, spec.models, `${file}.glb`));
  const scene = doc.getRoot().listScenes()[0];
  const size = standOnOrigin(doc, scene, options.scale ?? spec.scale);
  await doc.transform(prune(), dedup());
  const triangles = countTriangles(scene);

  const target = path.join(outDir, category);
  await mkdir(target, { recursive: true });
  // writeBinary 把外链贴图一并塞进 glb 的 BIN 块。
  await writeFile(path.join(target, `${name}.glb`), await io.writeBinary(doc));
  await sharp(path.join(packDir, spec.preview(file)))
    .resize(THUMBNAIL_EDGE, THUMBNAIL_EDGE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85, alphaQuality: 90 })
    .toFile(path.join(target, `${name}.webp`));
  return { triangles, size };
}

function renderCatalog(models) {
  const rows = models.map(
    (model) =>
      `  { id: '${model.id}', category: '${model.category}', path: '${model.path}', triangles: ${model.triangles}, tags: [${model.tags.map((tag) => `'${tag}'`).join(', ')}] },`,
  );
  return `// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 由 scripts/build_previz_model_library.mjs 生成，勿手改；改清单去改脚本里的 CATALOG 再重跑。
// 模型取自 Kenney（https://kenney.nl）的 CC0-1.0 素材包，文件在 CDN 上，不进仓库。

export interface PrevizLibraryModel {
  /** 也是名称 key 的末段：\`previz.library.model.<id>\`。 */
  id: string;
  category: 'furniture' | 'architecture' | 'city' | 'vehicle' | 'prop' | 'nature';
  /** 相对模型库 CDN 根的路径，不带扩展名：\`.glb\` 是模型，\`.webp\` 是缩略图。 */
  path: string;
  triangles: number;
  /** 搜索用的英文词。 */
  tags: readonly string[];
}

export const PREVIZ_LIBRARY_MODELS: readonly PrevizLibraryModel[] = [
${rows.join('\n')}
];
`;
}

/** 只替换 `previz.library.model` 这一块，别的行一个字节不动（整份重新序列化会改动无关行的格式）。 */
async function writeLocaleNames(repo, models) {
  for (const [locale, language] of Object.entries(LOCALES)) {
    const file = path.join(repo, 'frontend/public/locales', locale, 'translation.json');
    const text = await readFile(file, 'utf8');
    const anchor = text.match(/\n( *)"primitive": \{\n[^}]*\}/);
    if (!anchor) throw new Error(`${file}: previz.library.primitive block not found`);
    const indent = anchor[1];
    const body = models
      .map((model) => `${indent}  ${JSON.stringify(model.id)}: ${JSON.stringify(model.names[language])}`)
      .join(',\n');
    const block = `"model": {\n${body}\n${indent}}`;
    const existing = text.match(new RegExp(`\\n${indent}"model": \\{\\n[^}]*\\}`));
    const next = existing
      ? text.replace(existing[0], `\n${indent}${block}`)
      : text.replace(anchor[0], `${anchor[0]},\n${indent}${block}`);
    JSON.parse(next);
    await writeFile(file, next);
  }
}

const args = parseArgs(process.argv.slice(2));
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const models = [];
for (const [category, entries] of Object.entries(CATALOG)) {
  for (const entry of entries) {
    const [name, pack, file, zh, en, options = {}] = entry;
    const { triangles, size } = await buildModel(io, args.kenney, args.out, category, entry);
    const id = `${category}-${name}`;
    models.push({
      id,
      category,
      path: `${category}/${name}`,
      triangles,
      tags: [...name.split('-'), ...(options.tags ?? [])].filter((tag, i, all) => all.indexOf(tag) === i),
      names: { zh, en },
    });
    console.log(`${id.padEnd(40)} ${String(triangles).padStart(6)} tris  ${size.map((v) => v.toFixed(2)).join(' x ')} m  (${pack}/${file})`);
  }
}
// 素材包的授权原文随模型一起上 CDN。
await access(path.join(args.kenney, 'furniture-kit/License.txt'));
await copyFile(path.join(args.kenney, 'furniture-kit/License.txt'), path.join(args.out, 'LICENSE-Kenney.txt'));

await writeFile(
  path.join(args.repo, 'frontend/src/features/previz/domain/libraryModels.ts'),
  renderCatalog(models),
);
await writeLocaleNames(args.repo, models);
console.log(`\n${models.length} models → ${args.out}`);
