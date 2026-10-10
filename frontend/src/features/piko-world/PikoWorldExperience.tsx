// SPDX-License-Identifier: Elastic-2.0
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { usePikoTaskStatus } from "./use-piko-task-status";
import { PikoWorldShell } from "./PikoWorldShell";
import { resetPikoMusicSession, useMapMusic } from "./piko-bgm";
import type { PikoMapId } from "./piko-map-transitions";
import { PikoOnboarding } from "./PikoOnboarding";
import { usePikoProfile } from "./piko-profile";
import { savePikoPlayer, type PikoPlayer } from "./piko-player";
import { fetchPikoCharacter, savePikoCharacter, type PikoCharacter } from "./piko-world-client";

export function PikoWorldExperience() {
  const owner = useAuthStore(state => state.username);
  // A different account never inherits another account's in-flight form or completion.
  return <AccountExperience key={JSON.stringify(owner)} owner={owner} />;
}
function AccountExperience({ owner }: { owner: string | null }) {
  const taskStatus = usePikoTaskStatus(owner);
  const [character, setCharacter] = useState<PikoCharacter | null | undefined>(undefined);
  const [musicMap, setMusicMap] = useState<PikoMapId | null>(null);
  const { saveProfile } = usePikoProfile(owner);
  useEffect(() => { resetPikoMusicSession(); }, []);
  useEffect(() => {
    let active = true;
    void fetchPikoCharacter().then(value => {
      if (!active) return;
      if (value) {
        saveProfile({ nickname: value.nickname, bio: value.bio });
        savePikoPlayer(owner, value.gender, value.nickname);
      }
      setCharacter(value);
    })
      .catch(() => { if (active) setCharacter(null); });
    return () => { active = false; };
  }, []);
  useMapMusic(musicMap);
  const startCreationMusic = useCallback(() => setMusicMap("welcome-courtyard"), []);
  const pending = useRef<PikoCharacter | null>(null);
  if (character === undefined) return null;
  if (character) return <PikoWorldShell taskStatus={taskStatus} character={character} playerGender={character.gender} onMusicMapChange={setMusicMap} />;
  const save = async (gender: PikoPlayer["gender"], nickname: string) => {
    try {
      const saved = await savePikoCharacter(gender, nickname);
      saveProfile({ nickname, bio: "" });
      savePikoPlayer(owner, gender, nickname);
      pending.current = saved;
      return true;
    } catch {
      return false;
    }
  };
  return <PikoOnboarding onMusicStart={startCreationMusic} initialNickname="" onSave={save} onEnter={() => {
    if (pending.current) setCharacter(pending.current);
  }} />;
}
