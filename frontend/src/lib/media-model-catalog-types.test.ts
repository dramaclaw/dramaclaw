import { describe, expect, it } from "vitest";

import {
  MEDIA_MODEL_CATALOG_TYPES,
  defaultMediaModelRequest,
  isMediaModelCatalogType,
  mediaModelChannelCapability,
} from "./media-model-catalog-types";

describe("media model catalog types", () => {
  it("lists the three catalog types the backend validates", () => {
    expect([...MEDIA_MODEL_CATALOG_TYPES]).toEqual(["image", "video", "blockout"]);
    expect(isMediaModelCatalogType("blockout")).toBe(true);
    expect(isMediaModelCatalogType("audio")).toBe(false);
    expect(isMediaModelCatalogType(undefined)).toBe(false);
  });

  it("gives each type the request endpoint the backend expects", () => {
    expect(defaultMediaModelRequest("image")).toEqual({
      endpoint: "images/generations",
      parameters: [],
    });
    expect(defaultMediaModelRequest("video")).toEqual({
      endpoint: "video/generations",
      parameters: [],
    });
    expect(defaultMediaModelRequest("blockout")).toEqual({
      endpoint: "chat/completions",
      parameters: [],
    });
  });

  it("maps blockout models to vision-capable channels", () => {
    expect(mediaModelChannelCapability("image")).toBe("image");
    expect(mediaModelChannelCapability("video")).toBe("video");
    expect(mediaModelChannelCapability("blockout")).toBe("vision");
    expect(mediaModelChannelCapability("audio")).toBe("audio");
  });
});
