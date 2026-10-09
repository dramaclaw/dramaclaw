export type ImageGenerationCompletionMode = "submitted" | "completed";

export function resolveImageGenerationCompletionMode(
  requestedMode: ImageGenerationCompletionMode,
  totalImages: number,
): ImageGenerationCompletionMode {
  void totalImages;
  return requestedMode;
}
