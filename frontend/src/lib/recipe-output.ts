/** User-facing deliverables; HTML still uses the text Recipe execution path. */
export const RECIPE_OUTPUT_CHOICES = ['image', 'video', 'audio', 'text', 'html'] as const;
export type RecipeOutputChoice = typeof RECIPE_OUTPUT_CHOICES[number];

export function recipeOutputChoice(recipe: Record<string, unknown> | null | undefined): RecipeOutputChoice {
  if (recipe?.output_kind === 'text' && recipe.output_format === 'html') return 'html';
  return RECIPE_OUTPUT_CHOICES.includes(recipe?.output_kind as RecipeOutputChoice)
    ? recipe!.output_kind as RecipeOutputChoice
    : 'image';
}

export function recipeOutputFields(choice: RecipeOutputChoice) {
  return {
    output_kind: choice === 'html' ? 'text' : choice,
    // Explicitly clear an earlier HTML format when changing the deliverable.
    output_format: choice === 'html' ? 'html' as const : undefined,
  };
}
