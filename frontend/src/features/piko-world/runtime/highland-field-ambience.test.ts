// SPDX-License-Identifier: Elastic-2.0
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { zoneVolume } from './environment-audio';
import { PikoEnvironmentSchema } from './map-package-schema';

const environment = (mapId: 'cloudtop-slope' | 'amber-wilds') => PikoEnvironmentSchema.parse(JSON.parse(
  readFileSync(`public/piko/world/maps/${mapId}/data/environment.json`, 'utf8')));

it('keeps cloudtop wind and distant birds broad while insect calls stay near sheltered flowers', () => {
  const zones = environment('cloudtop-slope').audioZones;
  expect(zones).toHaveLength(3);
  const byId = (id: string) => zones.find(zone => zone.id === id)!;
  expect(zoneVolume({ x: 1000, y: 100 }, byId('ridge-wind'))).toBeGreaterThan(0);
  expect(zoneVolume({ x: 1000, y: 100 }, byId('distant-birds'))).toBeGreaterThan(0);
  expect(zoneVolume({ x: 1000, y: 100 }, byId('sheltered-insects'))).toBe(0);
  expect(zoneVolume({ x: 400, y: 700 }, byId('sheltered-insects'))).toBeGreaterThan(0);
});

it('lets grass insects fall silent on the amber field road between the grass patches', () => {
  const zones = environment('amber-wilds').audioZones;
  expect(zones).toHaveLength(3);
  const byId = (id: string) => zones.find(zone => zone.id === id)!;
  expect(zoneVolume({ x: 1050, y: 600 }, byId('grassland-wind'))).toBeGreaterThan(0);
  expect(zoneVolume({ x: 1050, y: 600 }, byId('field-birds'))).toBeGreaterThan(0);
  expect(zoneVolume({ x: 1050, y: 600 }, byId('grass-insects'))).toBe(0);
  expect(zoneVolume({ x: 1700, y: 700 }, byId('grass-insects'))).toBeGreaterThan(0);
});
