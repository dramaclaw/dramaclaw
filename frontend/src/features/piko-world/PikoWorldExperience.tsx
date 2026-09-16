// SPDX-License-Identifier: Elastic-2.0
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { PikoWorldShell } from "./PikoWorldShell";
import { resetPikoMusicSession, useMapMusic } from "./piko-bgm";
import type { PikoMapId } from "./piko-map-transitions";
import { PikoOnboarding } from "./PikoOnboarding";
import { usePikoProfile } from "./piko-profile";
import { clearPikoPlayer, savePikoPlayer, type PikoPlayer, type PikoPlayerGender } from "./piko-player";

export function PikoWorldExperience() {
  const owner = useAuthStore(state => state.username);
  // A different account never inherits another account's in-flight form or completion.
  return <AccountExperience key={JSON.stringify(owner)} owner={owner} />;
}
function AccountExperience({ owner }: { owner: string | null }) {
  const [player, setPlayer] = useState<PikoPlayer | null>(null);
  const [musicMap, setMusicMap] = useState<PikoMapId | null>(null);
  useEffect(() => { resetPikoMusicSession(); }, []);
  useMapMusic(musicMap);
  const startCreationMusic = useCallback(() => setMusicMap("welcome-courtyard"), []);
  const { saveProfile } = usePikoProfile(owner);
  const pending = useRef<PikoPlayer | null>(null);
  useEffect(() => { clearPikoPlayer(owner); }, [owner]);
  if (player) return <PikoWorldShell playerGender={player.gender} onMusicMapChange={setMusicMap} />;
  const save = (gender: PikoPlayerGender, nickname: string) => {
    if (!saveProfile({ nickname, bio: "" }) || !savePikoPlayer(owner, gender, nickname)) return false;
    pending.current = { version: 1, gender, nickname };
    return true;
  };
  return <PikoOnboarding onMusicStart={startCreationMusic} initialNickname="" onSave={save} onEnter={() => {
    if (pending.current) setPlayer(pending.current);
  }} />;
}
