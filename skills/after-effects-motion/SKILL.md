---
name: after-effects-motion
description: "After Effects work through the after-effects MCP tools (ae_*) - building a design, animating it, reviewing motion, recreating a reference image, or scripting AE."
---

# After Effects through the bridge

The bridge exposes `ae_*` tools. The motion-design rules live in one place, the `ae_guidelines` tool; this skill is
the working loop around them. Recipes for common moves: [RECIPES.md](RECIPES.md).

## Loop

1. **Orient.** Call `ae_health`. When the user points at something ("this", "the selected layer"), call
   `ae_get_selection`; otherwise `ae_list_project`. Done when you know the target composition and the layers by name.
2. **Load the rules.** Call `ae_guidelines` once per session, before the first design or animation step.
3. **Build the still.** Create or edit with the dedicated tools; give every layer a meaningful name. Check with
   `ae_capture_frame` (add `compareWith` when recreating a reference). Done when the frame matches the brief and the
   user has seen it: agree on the still before animating.
4. **Animate.** Use the recipes; reach for `ae_run_jsx` only for what no tool covers, passing data through `args`.
5. **Review the motion.** Call `ae_capture_frames` over the animated range: 6-12 frames, denser around overshoots
   and overlaps. Walk the review checklist below against the sheet, fix, capture again. Done when every checklist
   item passes on a fresh sheet. Then offer `ae_render_preview` so the user can watch it.
6. **Report.** Say what changed and that each call is one Ctrl+Z; mention the project is unsaved and save only
   when the user asks (`ae_save_project`).

A result with `status: "running"` is still executing in After Effects: collect it with `ae_get_result` (with
`waitMs`) and send nothing new until it returns.

## Review checklist

Read each item off the storyboard frames:

- **Containment**: content stays inside its container while the container opens; clip it with a track matte
  (`ae_set_layer` `trackMatte`, `matteVisible: true` for the container).
- **Hierarchy**: the container moves first, its content follows, the focal element lands last or strongest.
- **Stagger**: related elements arrive a few frames apart, in reading order.
- **Easing**: entrances start fast and land softly; nothing starts from a dead stop unless intended.
- **Overshoot**: momentum carries through it, and the whole object reacts (width or scale too, not only height).
- **Sync**: properties of one object finish on the same frame.
- **Text**: letters overlap in a wave (rampUp) or lines arrive whole; offsets and blur suit the font size.
- **Motion blur**: on for every moving layer.
- **Timing**: entrances 0.4-1.2 s per element; the final state holds long enough to read.
- **Typography and spacing**: one type scale for secondary labels, even padding inside cards.
