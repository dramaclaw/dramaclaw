import { useAuthStore } from "@/stores/auth-store";

export function accountCanvasId(username: string | null | undefined): string {
  return (username ?? "").trim() || "user";
}

export function currentAccountCanvasId(): string {
  return accountCanvasId(useAuthStore.getState().username);
}

export function isLegacyDefaultCanvasId(canvasId: string | null | undefined): boolean {
  return (canvasId ?? "").trim() === "default";
}

export function fallbackCanvasId(canvasId: string | null | undefined): string {
  return isLegacyDefaultCanvasId(canvasId) || !canvasId ? currentAccountCanvasId() : canvasId;
}
