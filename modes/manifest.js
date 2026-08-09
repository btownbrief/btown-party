// BTOWN PARTY — mode registry. A mode lives entirely in modes/<slug>/ and
// registers here with ONE import line + ONE entry line. Nothing else in
// the shell changes when a mode lands. See MODE-INTEGRATION.md for the
// contract a mode module must satisfy.

import * as roomKnows from './room-knows/mode.js';
import * as tallTales from './tall-tales/mode.js';
import * as flatlander from './flatlander/mode.js';
import * as twoHeads from './two-heads/mode.js';

export const MODES = {
  [roomKnows.slug]: roomKnows,
  [tallTales.slug]: tallTales,
  [flatlander.slug]: flatlander,
  [twoHeads.slug]: twoHeads,
};
