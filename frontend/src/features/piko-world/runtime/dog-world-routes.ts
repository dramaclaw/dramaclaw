// SPDX-License-Identifier: Elastic-2.0
import type { PikoPoint } from './navigation-geometry';
export const DOG_MAPS = ['whispering-meadow', 'wind-garden-gate', 'artisan-market', 'welcome-courtyard', 'lantern-canal-street', 'starlight-dock'] as const;
export type DogMap = typeof DOG_MAPS[number];
/** Logical 2048×1152 coordinates. Corridors follow paths; only named stops permit rest. */
export const DOG_MAP_STOPS: Record<DogMap, readonly PikoPoint[]> = {
  'welcome-courtyard': [{ x:1185,y:684 },{ x:450,y:780 }],
  'artisan-market': [{ x:900,y:650 },{ x:440,y:800 }],
  'wind-garden-gate': [{ x:1200,y:780 },{ x:800,y:440 }],
  'whispering-meadow': [{ x:1250,y:680 },{ x:650,y:430 }],
  'lantern-canal-street': [{ x:530,y:650 },{ x:1450,y:650 }],
  'starlight-dock': [{ x:450,y:560 },{ x:800,y:550 }],
};
export const DOG_CORRIDORS: Record<DogMap, readonly PikoPoint[]> = {
  'welcome-courtyard': [{x:190,y:275},{x:180,y:480},{x:420,y:550},{x:450,y:780},{x:450,y:550},{x:680,y:490},{x:800,y:640},{x:1185,y:684},{x:1500,y:640},{x:1750,y:545},{x:1890,y:510}],
  'artisan-market': [{x:190,y:550},{x:300,y:650},{x:440,y:800},{x:650,y:850},{x:900,y:650},{x:1150,y:580},{x:1500,y:540},{x:1870,y:550}],
  'wind-garden-gate': [{x:610,y:280},{x:745,y:400},{x:800,y:440},{x:960,y:600},{x:1050,y:700},{x:1200,y:780},{x:1450,y:710},{x:1700,y:640},{x:1820,y:640}],
  'whispering-meadow': [{x:650,y:430},{x:950,y:540},{x:1250,y:680},{x:1550,y:780},{x:1820,y:790}],
  'lantern-canal-street': [{x:190,y:570},{x:530,y:650},{x:650,y:590},{x:820,y:550},{x:1000,y:540},{x:1200,y:600},{x:1450,y:650},{x:1650,y:750},{x:1890,y:635}],
  'starlight-dock': [{x:305,y:565},{x:450,y:560},{x:650,y:530},{x:800,y:550}],
};
