// SPDX-License-Identifier: Elastic-2.0
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { AMBER_WILDS_ANIMALS, ARTISAN_MARKET_ANIMALS, CLOUDTOP_SLOPE_ANIMALS,
  LANTERN_CANAL_ANIMALS, isAnimalPositionNavigable } from './courtyard-animals';
import { PikoMapPackageSchema, PikoNavigationSchema } from './map-package-schema';
import { navigationIssues } from './navigation-editor';

const maps = ['amber-wilds', 'artisan-market', 'cloudtop-slope', 'lantern-canal-street'];
for (const map of maps) it(`${map}: authored geometry and environment assets are valid`, () => {
  const root = `public/piko/world/maps/${map}/`;
  const read = (file: string) => JSON.parse(readFileSync(root + file, 'utf8'));
  const pkg = PikoMapPackageSchema.parse({
    manifest: read('manifest.json'), navigation: read('data/navigation.json'),
    occlusion: read('data/occlusion.json'), environment: read('data/environment.json'),
    interactions: read('data/interactions.json'),
  });
  expect(navigationIssues(pkg.navigation)).toEqual([]);
  for (const occluder of pkg.occlusion.occluders) {
    const points = occluder.outline!.map(p => ({ x: p.x + occluder.position.x, y: p.y + occluder.position.y }));
    expect(navigationIssues({ ...pkg.navigation, walkableAreas: [], colliders: [
      { id: occluder.id, kind: 'prop', points },
    ] }), occluder.id).toEqual([]);
    expect(occluder.frame!.x + occluder.frame!.width).toBeLessThanOrEqual(pkg.manifest.size.width);
    expect(occluder.frame!.y + occluder.frame!.height).toBeLessThanOrEqual(pkg.manifest.size.height);
  }
  for (const item of [...pkg.environment.effects, ...pkg.environment.audioZones]) {
    if (item.src) expect(existsSync(root + item.src), item.src).toBe(true);
  }
});

it.each([
  ['artisan-market', ARTISAN_MARKET_ANIMALS],
  ['lantern-canal-street', LANTERN_CANAL_ANIMALS],
  ['cloudtop-slope', CLOUDTOP_SLOPE_ANIMALS],
  ['amber-wilds', AMBER_WILDS_ANIMALS],
] as const)('places %s ground animals and their routes on navigable ground', (map, animals) => {
  const navigation = PikoNavigationSchema.parse(JSON.parse(readFileSync(
    `public/piko/world/maps/${map}/data/navigation.json`, 'utf8')));
  for (const animal of animals.filter(a => a.kind !== 'butterfly')) {
    const route = [animal.position, ...(animal.route ?? []), animal.position];
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1], b = route[i];
      for (let step = 0; step <= 20; step++) {
        const point = { x: a.x + (b.x - a.x) * step / 20, y: a.y + (b.y - a.y) * step / 20 };
        expect(isAnimalPositionNavigable(point, navigation), animal.id).toBe(true);
      }
    }
  }
});
