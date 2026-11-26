/**
 * The recipes of the map's cases (the purposes of packages/test-catalog
 * src/scenarios), by case id: how each prepares its request on a workspace
 * (scenario-runtime.ts).
 */
import type { ScenarioRecipe } from '../scenario-runtime.js';
import { deviceRecipes } from './device.js';
import { interactionRecipes } from './interaction.js';
import { protocolRecipes } from './protocol.js';
import { tokenRecipes } from './token.js';

export const RECIPES: Readonly<Record<string, ScenarioRecipe>> = { ...protocolRecipes, ...interactionRecipes, ...tokenRecipes, ...deviceRecipes };
