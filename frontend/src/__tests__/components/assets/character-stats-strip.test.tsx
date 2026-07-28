// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "characters.stats.strip.total": "总角色",
        "characters.stats.strip.mainCharacter": "解说主角",
        "characters.stats.strip.portrait": "头像",
        "characters.stats.strip.identity": "身份",
        "characters.stats.strip.voice": "声线",
        "characters.stats.strip.ariaLabel": "角色统计",
      })[key] ?? key,
  }),
}));

import {
  CharacterStatsStrip,
  deriveCharacterStats,
} from "@/components/assets/character-stats-strip";
import type { Character } from "@/types/character";

const characters: Character[] = [
  {
    name: "Mira",
    role: "主角",
    is_main: true,
    portrait_url: "/static/demo/mira/portrait.png",
    reference_audio_path: "assets/characters/Mira/voice.wav",
  },
  {
    name: "Jun",
    role: "配角",
    portrait_path: "assets/characters/Jun/portrait.png",
    reference_audio_path: "",
  },
  {
    name: "Lio",
    role: "Scout",
    portrait_url: "",
    reference_audio_url: "/static/demo/lio/voice.wav",
  },
];

describe("deriveCharacterStats", () => {
  it("counts portraits, main characters, identities, and ready voice paths", () => {
    expect(deriveCharacterStats(characters, { Mira: 2, Jun: 1 })).toEqual({
      total: 3,
      withPortraits: 2,
      mainCharacters: 1,
      identityReady: 2,
      voiceReady: 1,
    });
  });

  it("defaults identity ready to zero when identityCounts is omitted", () => {
    expect(deriveCharacterStats(characters).identityReady).toBe(0);
  });
});

describe("CharacterStatsStrip", () => {
  it("renders a compact responsive stats strip with accessible stat labels", () => {
    render(
      <CharacterStatsStrip
        characters={characters}
        identityCounts={{ Mira: 2, Jun: 1 }}
        className="custom-strip"
      />,
    );

    const strip = screen.getByRole("list", { name: "角色统计" });
    expect(strip).toHaveClass("custom-strip");
    expect(strip).toHaveTextContent("总角色3");
    expect(strip).toHaveTextContent("解说主角1");
    expect(strip).toHaveTextContent("头像2/3");
    expect(strip).toHaveTextContent("身份2/3");
    expect(strip).toHaveTextContent("声线1/3");

    expect(screen.getByLabelText("总角色: 3")).toBeInTheDocument();
    expect(screen.getByLabelText("头像: 2/3")).toBeInTheDocument();
    expect(screen.getByLabelText("声线: 1/3")).toBeInTheDocument();
  });

  it("uses the supplied main character label for drama projects", () => {
    render(
      <CharacterStatsStrip
        characters={characters}
        mainCharacterLabel="主角"
      />,
    );

    expect(screen.getByLabelText("主角: 1")).toBeInTheDocument();
    expect(screen.queryByLabelText("解说主角: 1")).not.toBeInTheDocument();
  });
});
