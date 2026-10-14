/**
 * The only spacing values the parts under `src/web/components/screen/` use. A screen has two
 * distances, whatever the screen: between the lines of one thing, and between things. A value
 * nobody can pick is a value two screens cannot pick differently.
 *
 * Only parts import this: routes and the other components lay out nothing, and use no
 * `s-stack`, `s-grid`, `s-box` or spacing prop. A part that seems to need a third distance
 * needs its case argued first.
 */

/** Between the lines of one thing: a label over its value, a row of buttons. */
export const BETWEEN_LINES = "small-300";

/** Between things: a section's banners, its text, its form and its buttons. */
export const BETWEEN_THINGS = "base";
