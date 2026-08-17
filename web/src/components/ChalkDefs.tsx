/**
 * The board's SVG filter definitions — chalk wobble and deckled paper edges — declared once.
 *
 * A 0×0 svg holding nothing but `<defs>`. Filter ids are DOCUMENT-GLOBAL: every `filter: url(#…)`
 * in every stylesheet resolves against the one document, so these must exist exactly once and must
 * never unmount while anything referencing them is on screen. App renders this as its first child
 * because App is the one component that never leaves; a panel that carried its own defs would take
 * every chalk line in the window with it when it unmounted.
 *
 * TWO KINDS OF FILTER, TWO GEOMETRIES, and the difference is load-bearing:
 *
 *   - The DECKLE filters displace a sticky note's edge. Their region is a percentage box a little
 *     larger than the element, because a sheet of paper is a small closed shape and the torn edge
 *     must be allowed to wobble outside it.
 *   - The CHALK filters displace strokes — box borders, rules, wires. Their region is
 *     `userSpaceOnUse` over a huge fixed rectangle, because an edge path in the graph's svg can be
 *     thousands of units long and a percentage region would clip a long wire's displacement at its
 *     bounding box. The fixed rectangle also anchors the NOISE in each element's own space, so
 *     every consumer samples the same turbulence and two boxes side by side wobble differently only
 *     by their seed.
 *
 * SEEDS ARE VARIETY, NOT RANDOMNESS. Three deckles and three chalk boxes, chosen by components from
 * a hash of a stable key (see `noteDeckle` in state/notes.ts): the same note tears the same way on
 * every render, and no random number is ever drawn while drawing.
 *
 * Displacement scales are small single digits on purpose — this is the difference between "drawn by
 * a hand" and "seen through water", and readability outranks charm everywhere text is involved. The
 * filters land only on inert layers (a sheet, a border overlay, a wire); never on an ancestor of
 * text. That rule lives with the consumers, but it is stated here because this file is where
 * somebody hunting a blurry glyph will look first.
 */

import type { ReactElement } from "react";

export function ChalkDefs(): ReactElement {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <defs>
        <filter id="deckle0" x="-10%" y="-15%" width="120%" height="130%">
          <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="4" seed="3" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="9" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id="deckle1" x="-10%" y="-15%" width="120%" height="130%">
          <feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="4" seed="7" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="8" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id="deckle2" x="-10%" y="-15%" width="120%" height="130%">
          <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="4" seed="11" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="10" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id="chalkline" filterUnits="userSpaceOnUse" x="-4000" y="-4000" width="12000" height="12000">
          <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="3" seed="5" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="4" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id="chalkbox" filterUnits="userSpaceOnUse" x="-4000" y="-4000" width="12000" height="12000">
          <feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="3" seed="9" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="3" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id="chalkbox1" filterUnits="userSpaceOnUse" x="-4000" y="-4000" width="12000" height="12000">
          <feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="3" seed="17" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="3" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id="chalkbox2" filterUnits="userSpaceOnUse" x="-4000" y="-4000" width="12000" height="12000">
          <feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="3" seed="23" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="3" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    </svg>
  );
}
