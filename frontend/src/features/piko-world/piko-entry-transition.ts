// SPDX-License-Identifier: Elastic-2.0
let entering = false;
/** Cover the workbench before changing routes; the cinema reveals its first frame. */
export async function enterPikoWorld(navigate: () => Promise<unknown>) {
  if (entering) return;
  entering = true;
  const veil = document.createElement("div");
  veil.setAttribute("aria-hidden", "true");
  Object.assign(veil.style, { position: "fixed", inset: "0", background: "#000", zIndex: "2147483646", opacity: "0", pointerEvents: "auto" });
  document.body.append(veil);
  try {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!reduced && typeof veil.animate === "function") {
      await veil.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 800, fill: "forwards" }).finished;
    }
    veil.style.opacity = "1";
    await navigate();
  } finally {
    veil.remove(); entering = false;
  }
}
