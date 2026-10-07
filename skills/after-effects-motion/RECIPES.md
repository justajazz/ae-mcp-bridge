# Recipes

Concrete tool calls for common moves. Paths use names; names, matchNames and 1-based indices all work.

## Card that opens with a bounce

A rounded rectangle shape layer `Card` (`ae_create_layer` type `shape`, shape `rectangle`, `roundness`).
Animate the **path size**, so corners keep their radius:

1. `ae_set_keyframes` on `Contents/Group 1/Contents/Rectangle Path 1/Size`:
   keys `[{time: 0, value: [W, 0], ease: "easyOut", influence: 20}, {time: 0.4, value: [W, H], ease: "linear"}]`.
   The landing key arrives with speed: the bounce expression turns that speed into the overshoot.
2. `ae_set_expression` on the same property with the inertial-bounce snippet from `ae_guidelines`.
3. For a whole-object feel add a small `Transform/Scale` bounce, or bounce the width as well.

## Text reveal

- Words or characters: `ae_add_text_animator` with defaults (soft wave, offsets position [0, 40], opacity 0, blur 16).
- Lines: `basedOn: "lines"` (square selector, strong ease).
- Several text layers: one call with `layers: [...]` and `stagger: 3-5`.
- Same animator on more layers later: `ae_copy_animation` from the first layer, `property: "Text/Animators/MCP Reveal"`,
  `to: [...]`, `stagger`.

## Number counter

`ae_set_expression` on `Source Text`:

```js
var t0 = inPoint + 0.3, t1 = t0 + 1.2, target = 8412;
var v = Math.round(ease(time, t0, t1, 0, target));
v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
```

## Content clipped by its card

`ae_set_layer` on the content layer: `trackMatte: "Card"`, `matteVisible: true`. Place the content directly above
the card in the layer stack.

## Motion blur

`ae_set_layer` `motionBlur: true` on every moving layer (this also turns on the composition switch);
`ae_set_comp` `shutterAngle: 180` for a natural amount.

## Recreate a reference

1. `ae_create_comp` with the reference's size.
2. Build shapes and text, measuring positions from the reference.
3. `ae_capture_frame` with `compareWith: "<path to the reference>"`; fix differences in spacing, sizes, colors.

## Markers on the beat

`ae_analyze_audio` with `comp`, `layer` (the music layer) and `addMarkers: true`; tune `threshold` (0.5-0.8) and
`minGap` (seconds) until the markers match the beats. Use the marker times as key times.

## Copy a look

`ae_copy_animation` copies effects (`Effects/Drop Shadow`), masks and single properties (`Transform/Position`) with
their keys; `ae_apply_preset` applies a saved `.ffx` (find it with `ae_list_presets`).
