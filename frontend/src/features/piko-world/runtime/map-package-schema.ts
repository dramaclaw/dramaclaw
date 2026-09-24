// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { z } from "zod";

const MapIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const RelativePackagePathSchema = z
  .string()
  .min(1)
  .refine((value) => {
    if (value.startsWith("/") || value.includes("://")) return false;
    return !value.split("/").includes("..");
  }, "路径必须位于当前地图运行包内");

export const PikoPointSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const PikoPolygonSchema = z.strictObject({
  id: z.string().min(1),
  points: z.array(PikoPointSchema).min(3),
});

export const PikoMapManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mapId: MapIdSchema,
  revision: z.number().int().positive(),
  coordinateSpace: z.literal("map-pixels-top-left"),
  size: z.strictObject({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  baseTexture: z.strictObject({
    src: RelativePackagePathSchema,
    sampling: z.literal("nearest"),
  }),
  data: z.strictObject({
    navigation: RelativePackagePathSchema,
    occlusion: RelativePackagePathSchema,
    interactions: RelativePackagePathSchema,
    environment: RelativePackagePathSchema,
  }),
});

export const PikoNavigationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mapId: MapIdSchema,
  walkableAreas: z.array(PikoPolygonSchema),
  colliders: z.array(
    PikoPolygonSchema.extend({
      kind: z.enum(["boundary", "building", "vegetation", "water", "prop"]),
    }),
  ),
  spawnPoints: z.array(
    z.strictObject({
      id: z.string().min(1),
      position: PikoPointSchema,
      facing: z.enum(["north", "east", "south", "west"]),
    }),
  ),
  exits: z.array(
    z.strictObject({
      id: z.string().min(1),
      trigger: PikoPolygonSchema,
      targetMapId: MapIdSchema,
      targetSpawnId: z.string().min(1),
    }),
  ),
});

export const PikoOccluderSchema = z.strictObject({
  id: z.string().min(1),
  src: RelativePackagePathSchema,
  position: PikoPointSchema,
  depthY: z.number().finite(),
  // Optional atlas crop and local silhouette; standalone transparent PNGs still work.
  frame: z.strictObject({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }).optional(),
  outline: z.array(PikoPointSchema).min(3).optional(),
}).superRefine((occluder, context) => {
  if (!occluder.outline) return;
  const points = occluder.outline;
  const area = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  if (Math.abs(area) < 1) {
    context.addIssue({ code: "custom", path: ["outline"], message: "遮挡轮廓不能退化" });
  }
  if (occluder.frame && points.some(point => point.x < 0 || point.y < 0
    || point.x > occluder.frame!.width || point.y > occluder.frame!.height)) {
    context.addIssue({ code: "custom", path: ["outline"], message: "遮挡轮廓必须位于切片内" });
  }
});

export const PikoOcclusionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mapId: MapIdSchema,
  occluders: z.array(PikoOccluderSchema),
}).superRefine(({ occluders }, context) => {
  const ids = new Set<string>();
  occluders.forEach((occluder, index) => {
    if (ids.has(occluder.id)) {
      context.addIssue({ code: "custom", path: ["occluders", index, "id"], message: "遮挡对象 ID 不能重复" });
    }
    ids.add(occluder.id);
  });
});

export const PikoInteractionsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mapId: MapIdSchema,
  interactions: z.array(
    z.strictObject({
      id: z.string().min(1),
      kind: z.enum(["npc", "seat", "sign", "landmark", "custom"]),
      trigger: PikoPolygonSchema,
      actionId: z.string().min(1),
    }),
  ),
});

export const PikoEnvironmentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mapId: MapIdSchema,
  globalLighting: z.strictObject({
    preset: z.string().min(1),
    intensity: z.number().min(0).max(1),
  }),
  effects: z.array(
    z.strictObject({
      id: z.string().min(1),
      kind: z.enum(["sprite", "particle", "light", "weather", "filter"]),
      src: RelativePackagePathSchema.optional(),
      region: PikoPolygonSchema.optional(),
      layer: z.enum(["water", "behind-scenery", "front-scenery"]).optional(),
      opacity: z.number().min(0).max(1).optional(),
      animation: z.strictObject({
        columns: z.number().int().positive(), rows: z.number().int().positive(),
        frames: z.number().int().positive(), fps: z.number().positive().max(60),
        inset: z.number().nonnegative().default(0),
        playback: z.enum(["loop", "ping-pong"]).optional(),
        startStep: z.number().int().nonnegative().optional(),
        sequence: z.array(z.number().int().nonnegative()).min(1).optional(),
        clock: z.enum(["local", "courtyard-wind"]).optional(),
        loopSeconds: z.number().positive().optional(),
        phaseSeconds: z.number().finite().optional(),
      }).superRefine((animation, context) => {
        if (animation.sequence?.some(frame => frame >= animation.frames)) {
          context.addIssue({ code: "custom", path: ["sequence"], message: "序列帧索引不能超出图集帧数" });
        }
      }).optional(),
      reducedMotion: z.enum(["keep", "simplify", "disable"]),
    }),
  ),
  audioZones: z.array(
    z.strictObject({
      id: z.string().min(1),
      src: RelativePackagePathSchema,
      region: PikoPolygonSchema,
      additionalRegions: z.array(PikoPolygonSchema).optional(),
      volume: z.number().min(0).max(1),
      fadeDistance: z.number().positive().optional(),
      repeatDelay: z.number().nonnegative().optional(),
    }),
  ),
});

export const PikoMapPackageSchema = z
  .strictObject({
    manifest: PikoMapManifestSchema,
    navigation: PikoNavigationSchema,
    occlusion: PikoOcclusionSchema,
    interactions: PikoInteractionsSchema,
    environment: PikoEnvironmentSchema,
  })
  .superRefine((mapPackage, context) => {
    const expectedMapId = mapPackage.manifest.mapId;
    const documents = [
      ["navigation", mapPackage.navigation.mapId],
      ["occlusion", mapPackage.occlusion.mapId],
      ["interactions", mapPackage.interactions.mapId],
      ["environment", mapPackage.environment.mapId],
    ] as const;

    for (const [documentName, mapId] of documents) {
      if (mapId === expectedMapId) continue;
      context.addIssue({
        code: "custom",
        path: [documentName, "mapId"],
        message: `mapId 必须与 manifest 的 ${expectedMapId} 一致`,
      });
    }
  });

export type PikoMapManifest = z.infer<typeof PikoMapManifestSchema>;
export type PikoNavigation = z.infer<typeof PikoNavigationSchema>;
export type PikoOcclusion = z.infer<typeof PikoOcclusionSchema>;
export type PikoOccluder = z.infer<typeof PikoOccluderSchema>;
export type PikoInteractions = z.infer<typeof PikoInteractionsSchema>;
export type PikoEnvironment = z.infer<typeof PikoEnvironmentSchema>;
export type PikoMapPackage = z.infer<typeof PikoMapPackageSchema>;
