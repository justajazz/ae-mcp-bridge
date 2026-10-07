# Tool reference

AE MCP Bridge 0.2.0: 34 tools. Generated from `src/mcp-server.mjs` by `scripts/gen-tools-doc.mjs`; do not edit by hand.

Common conventions:

- `comp`: composition name or numeric item id; omitted = the active composition.
- `layer`: layer name or 1-based index.
- `property`: a path such as `Transform/Position`, `Opacity`, `Effects/Gaussian Blur/Blurriness`, `Text/Animators/Animator 1` (names, matchNames or indices).
- Colors: `#RRGGBB` or `[r, g, b]` in 0..1 (0..255 is accepted too). Times are in seconds.
- Tools marked *one undo step* change the project and are undone with a single Ctrl+Z.

![Property paths through a layer's property tree](images/property-paths.svg)

## Contents

- **Bridge and project**: [ae_health](#ae_health), [ae_guidelines](#ae_guidelines), [ae_list_project](#ae_list_project), [ae_open_project](#ae_open_project), [ae_save_project](#ae_save_project), [ae_get_result](#ae_get_result)
- **Scripting**: [ae_run_jsx](#ae_run_jsx), [ae_run_jsx_file](#ae_run_jsx_file)
- **Looking at the result**: [ae_capture_frame](#ae_capture_frame), [ae_capture_frames](#ae_capture_frames), [ae_render_preview](#ae_render_preview), [ae_get_selection](#ae_get_selection), [ae_inspect](#ae_inspect)
- **Compositions and layers**: [ae_create_comp](#ae_create_comp), [ae_set_comp](#ae_set_comp), [ae_create_layer](#ae_create_layer), [ae_set_layer](#ae_set_layer), [ae_center_layers](#ae_center_layers), [ae_get_layer_timing](#ae_get_layer_timing)
- **Properties and animation**: [ae_set_property](#ae_set_property), [ae_set_keyframes](#ae_set_keyframes), [ae_set_expression](#ae_set_expression), [ae_add_text_animator](#ae_add_text_animator), [ae_copy_animation](#ae_copy_animation)
- **Effects and presets**: [ae_list_available_effects](#ae_list_available_effects), [ae_apply_effect](#ae_apply_effect), [ae_list_layer_effects](#ae_list_layer_effects), [ae_remove_effects](#ae_remove_effects), [ae_list_presets](#ae_list_presets), [ae_apply_preset](#ae_apply_preset)
- **Markers and audio**: [ae_add_markers](#ae_add_markers), [ae_get_audio_info](#ae_get_audio_info), [ae_set_audio_levels](#ae_set_audio_levels), [ae_analyze_audio](#ae_analyze_audio)

## Bridge and project

### ae_health

Check the After Effects bridge: server and panel versions, AE version, open project, active composition, panel status. Changes nothing.

No parameters.

### ae_guidelines

Read the full motion-design and workflow guidelines for this bridge (easing, bounce, text animators, stagger, track mattes, motion blur, review loop, ExtendScript pitfalls). Call it once before designing or animating. Does not contact After Effects.

No parameters.

### ae_list_project

List the open project: compositions with their layers (index, name, type, in/out points) and all other items (folders, footage, solids) with their folder and usedIn count (0 = unused). Changes nothing.

| Parameter | Type | Description |
|---|---|---|
| `items` | boolean | Include non-composition items (default true). |

### ae_open_project

Open an .aep project in After Effects (closing the current one). If the current project has unsaved changes you must choose save: true or discard: true. Use this instead of opening/closing projects in ae_run_jsx, which breaks AE's undo history.

| Parameter | Type | Description |
|---|---|---|
| `path` *(required)* | string | Absolute path to the .aep file. |
| `save` | boolean | Save the current project's changes before closing it. |
| `discard` | boolean | Close the current project without saving its changes. |

### ae_save_project

Save the open project. With no path saves to its current file; with an absolute .aep path saves there (Save As).

| Parameter | Type | Description |
|---|---|---|
| `path` | string | Optional absolute .aep path. |

### ae_get_result

Fetch the result of a command that was still running when its tool call timed out. Never re-sends the command.

| Parameter | Type | Description |
|---|---|---|
| `commandId` *(required)* | string |  |
| `waitMs` | number | Wait up to this long for the result (default 0, max 600000). |

## Scripting

### ae_run_jsx

Run arbitrary ExtendScript (ES3 JavaScript) inside After Effects. The value of the last expression is returned (AE objects come back as short summaries). Pass data through `args` (available as the `args` variable) instead of pasting it into the code. Helpers: mcp.findComp(nameOrId?), mcp.findLayer(comp, nameOrIndex), mcp.activeComp(), mcp.layerType(layer), mcp.projectInfo(); lib.prop(layer, 'Transform/Position'), lib.setValue(prop, value, time?), lib.color('#ff8800'), lib.tree(propertyGroup, depth, withValues). The whole call is one undo step. If it runs longer than the timeout, a commandId is returned: fetch the result with ae_get_result, do not re-send the code.

| Parameter | Type | Description |
|---|---|---|
| `code` *(required)* | string | ExtendScript code. ES3 only: var, no arrow functions, no let/const. |
| `args` | object | Optional data exposed to the code as `args`. |
| `timeoutMs` | number | How long to wait before returning a commandId (default 30000, max 3600000). |

### ae_run_jsx_file

Run an ExtendScript .jsx/.js file from disk (a library of reusable scripts) with optional `args`, like ae_run_jsx. One undo step.

| Parameter | Type | Description |
|---|---|---|
| `path` *(required)* | string | Absolute path to the script. |
| `args` | object |  |
| `timeoutMs` | number |  |

## Looking at the result

### ae_capture_frame

Render one frame of a composition to PNG and return it as an image for visual inspection. Transparent areas are filled with the composition background color by default. Changes nothing.

| Parameter | Type | Description |
|---|---|---|
| `comp` | string \| number | Composition name or numeric item id. Omit to use the active composition. |
| `time` | number | Time in seconds. Omit to use the composition's current time. |
| `background` | string \| array | 'comp' (default: composition background color), 'transparent', or a color '#RRGGBB' / [r,g,b]. |
| `path` | string | Optional absolute PNG path to keep the file (saved as rendered). By default a temporary file is used and deleted. |
| `compareWith` | string | Optional absolute path to a reference image (PNG/JPEG/WebP/GIF), returned next to the frame for comparison. |

### ae_capture_frames

Render several frames of a composition into ONE contact-sheet image (grid with time labels) to judge an animation: timing, easing, overlaps, elements appearing outside their containers. Give explicit times, or start/end with count (default 9 evenly spaced) or step. Changes nothing.

| Parameter | Type | Description |
|---|---|---|
| `comp` | string \| number | Composition name or numeric item id. Omit to use the active composition. |
| `times` | array | Explicit times in seconds. |
| `start` | number | Default 0. |
| `end` | number | Default: last frame of the comp. |
| `count` | number | Number of frames between start and end (default 9, max 36). |
| `step` | number | Seconds between frames, instead of count. |
| `columns` | number | Grid columns (default: square-ish). |
| `maxWidth` | number | Sheet width limit in pixels (default 2048). |
| `background` | string \| array | 'comp' (default), 'transparent' (shown as gray) or a color. |

### ae_render_preview

Render a composition (or a time range) through the Render Queue to an H.264 MP4 or a PNG sequence for the user to watch. Other queued items are paused during the render and restored. Blocks After Effects while rendering; long renders return a commandId for ae_get_result.

| Parameter | Type | Description |
|---|---|---|
| `comp` | string \| number | Composition name or numeric item id. Omit to use the active composition. |
| `format` | string: `mp4`, `png` | Default mp4. |
| `start` | number |  |
| `duration` | number |  |
| `half` | boolean | Render at half resolution (faster). |
| `path` | string | Output file (mp4) or folder (png). Default: <bridge>/renders. |
| `timeoutMs` | number | Default 600000. |

### ae_get_selection

What the user selected in After Effects: project items, layers of the active comp, and selected properties with their paths, values, keyframes (time, value, interpolation, ease) and property trees for selected groups (e.g. a text animator). Use it when the user says 'this', 'the selected layer', 'look at what I selected'. Changes nothing.

| Parameter | Type | Description |
|---|---|---|
| `depth` | number | Tree depth for selected groups (default 3). |

### ae_inspect

Deep property tree of a layer or of one of its groups, with values, keyframes and easing, expressions. By default only modified properties are listed (modifiedOnly: false lists everything). Changes nothing.

| Parameter | Type | Description |
|---|---|---|
| `comp` | string \| number | Composition name or numeric item id. Omit to use the active composition. |
| `layer` *(required)* | string \| number | Layer name or 1-based index. |
| `property` | string \| array | Optional group or property path to start from, e.g. 'Text/Animators/Animator 1'. |
| `depth` | number | Default 6. |
| `modifiedOnly` | boolean | Default true. |
| `values` | boolean | Default true. |
| `keys` | boolean | Include keyframe details (default true). |
| `maxNodes` | number | Default 800. |

## Compositions and layers

### ae_create_comp

Create a composition (and open it in the viewer unless open: false). One undo step.

| Parameter | Type | Description |
|---|---|---|
| `name` | string |  |
| `width` | number | Default 1920. |
| `height` | number | Default 1080. |
| `duration` | number | Seconds, default 10. |
| `frameRate` | number | Default 30. |
| `pixelAspect` | number | Default 1. |
| `bgColor` | string \| array | Color: '#RRGGBB' or [r, g, b] in 0..1 (0..255 also accepted). |
| `motionBlur` | boolean | Composition motion blur switch. |
| `open` | boolean |  |

### ae_set_comp

Change composition settings: name, size, duration, frame rate, background color, motion blur switch and shutter angle, work area, current time; open: true opens it in the viewer. One undo step.

| Parameter | Type | Description |
|---|---|---|
| `comp` | string \| number | Composition name or numeric item id. Omit to use the active composition. |
| `name` | string |  |
| `width` | number |  |
| `height` | number |  |
| `duration` | number |  |
| `frameRate` | number |  |
| `bgColor` | string \| array | Color: '#RRGGBB' or [r, g, b] in 0..1 (0..255 also accepted). |
| `motionBlur` | boolean | Composition motion blur switch. |
| `shutterAngle` | number |  |
| `workAreaStart` | number |  |
| `workAreaDuration` | number |  |
| `time` | number | Move the current-time indicator. |
| `open` | boolean |  |

### ae_create_layer

Create a text, shape, solid, adjustment or null layer. Text is center-justified by default; use ae_center_layers to center any layer visually. One undo step.

| Parameter | Type | Description |
|---|---|---|
| `comp` | string \| number | Composition name or numeric item id. Omit to use the active composition. |
| `type` *(required)* | string: `text`, `shape`, `solid`, `adjustment`, `null` |  |
| `name` | string |  |
| `text` | string | text: the text. |
| `font` | string | text: PostScript font name, e.g. 'Arial-BoldMT'. |
| `fontSize` | number |  |
| `justification` | string: `left`, `center`, `right` |  |
| `color` | string \| array | text fill / shape fill / solid color. |
| `strokeColor` | string \| array | Color: '#RRGGBB' or [r, g, b] in 0..1 (0..255 also accepted). |
| `strokeWidth` | number |  |
| `shape` | string: `rectangle`, `ellipse`, `polygon`, `star` | shape: default rectangle. |
| `size` | array \| number | shape: [w, h] (default 200x200); solid/adjustment: [w, h] (default comp size). |
| `roundness` | number | shape rectangle corner roundness. |
| `points` | number | shape polygon/star points. |
| `fill` | boolean | shape: add a fill (default true). |
| `position` | array | [x, y] in comp pixels. Default: center. |
| `startTime` | number | Time in seconds (composition time). |
| `duration` | number | Layer duration in seconds (default: to the end of the comp). |

### ae_set_layer

Change layer settings and transform: name, enabled, 3D, label, parent, timing, anchorPoint, position, scale, rotation, opacity, and text (text, font, fontSize, fillColor, strokeColor, strokeWidth, justification, tracking, leading). Pass time to write keyframes instead of static values. One undo step.

| Parameter | Type | Description |
|---|---|---|
| `comp` | string \| number | Composition name or numeric item id. Omit to use the active composition. |
| `layer` *(required)* | string \| number | Layer name or 1-based index. |
| `name` | string |  |
| `enabled` | boolean |  |
| `threeD` | boolean |  |
| `label` | number | Label color index 0..16. |
| `parent` | string \| number \| null | Parent layer, or null to unparent. |
| `startTime` | number | Time in seconds (composition time). |
| `inPoint` | number | Time in seconds (composition time). |
| `outPoint` | number | Time in seconds (composition time). |
| `anchorPoint` | array |  |
| `position` | array |  |
| `scale` | array \| number | Percent: 50 or [50, 50]. |
| `rotation` | number | Degrees (Z rotation for 3D layers). |
| `opacity` | number | 0..100. |
| `text` | string |  |
| `font` | string |  |
| `fontSize` | number |  |
| `fillColor` | string \| array | Color: '#RRGGBB' or [r, g, b] in 0..1 (0..255 also accepted). |
| `strokeColor` | string \| array | Color: '#RRGGBB' or [r, g, b] in 0..1 (0..255 also accepted). |
| `strokeWidth` | number |  |
| `justification` | string: `left`, `center`, `right` |  |
| `tracking` | number |  |
| `leading` | number |  |
| `motionBlur` | boolean | Layer motion blur switch; turning it on also enables the comp switch. |
| `trackMatte` | string \| number \| null | Matte layer (AE 2023+), or null to remove the track matte. |
| `trackMatteType` | string: `alpha`, `alphaInverted`, `luma`, `lumaInverted` | Default alpha. |
| `matteVisible` | boolean | Show (true) or hide the matte layer itself after assigning it. |
| `time` | number | Optional: set transform/text values as keyframes at this time. |

### ae_center_layers

Center layers in the composition. By default the anchor point is moved to the visual center of the layer content first (sourceRectAtTime), so text and shapes end up truly centered. One undo step.

| Parameter | Type | Description |
|---|---|---|
| `comp` | string \| number | Composition name or numeric item id. Omit to use the active composition. |
| `layers` | array \| string \| number | Layer names/indices. Omit to use the selected layers. |
| `all` | boolean | Center every layer. |
| `axis` | string: `both`, `horizontal`, `vertical` |  |
| `anchor` | boolean | Move the anchor point to the content center first (default true). |

### ae_get_layer_timing

Layer timing in seconds and frames: start, in/out points, duration, source in/out, stretch. Changes nothing.

| Parameter | Type | Description |
|---|---|---|
| `comp` | string \| number | Composition name or numeric item id. Omit to use the active composition. |
| `layer` *(required)* | string \| number | Layer name or 1-based index. |

## Properties and animation

### ae_set_property

Set any property of a layer or of its effects by path. With time, sets a keyframe; without time the property must have no keyframes. One undo step.

| Parameter | Type | Description |
|---|---|---|
| `comp` | string \| number | Composition name or numeric item id. Omit to use the active composition. |
| `layer` *(required)* | string \| number | Layer name or 1-based index. |
| `property` *(required)* | string \| array | Property path: 'Transform/Position', 'Opacity', 'Source Text', 'Effects/Gaussian Blur/Blurriness' (names, matchNames or 1-based indices, '/'-separated or as an array). |
| `value` *(required)* | any | Number, array, color ('#RRGGBB' for color properties), text or text-style object for Source Text. |
| `time` | number | Time in seconds (composition time). |

### ae_set_keyframes

Add keyframes to a layer or effect property and set their interpolation. ease: linear | hold | bezier | easy (Easy Ease) | easyIn | easyOut; influence 0.1..100 (default 33.3); easeIn/easeOut: { speed, influence } for custom temporal ease; spatial props also accept spatialAutoBezier, spatialContinuous, roving, inTangent, outTangent. One undo step.

| Parameter | Type | Description |
|---|---|---|
| `comp` | string \| number | Composition name or numeric item id. Omit to use the active composition. |
| `layer` *(required)* | string \| number | Layer name or 1-based index. |
| `property` *(required)* | string \| array | Property path: 'Transform/Position', 'Opacity', 'Source Text', 'Effects/Gaussian Blur/Blurriness' (names, matchNames or 1-based indices, '/'-separated or as an array). |
| `keys` *(required)* | array | [{ time, value, ease?, influence?, easeIn?, easeOut?, ... }]. Omit value to only change an existing key's ease. |
| `ease` | string: `linear`, `hold`, `bezier`, `easy`, `easyIn`, `easyOut` | Default ease for all keys. |
| `influence` | number | Default influence for all keys. |
| `replace` | boolean | Remove existing keyframes of this property first. |

### ae_set_expression

Set an expression on a layer or effect property, or remove it with an empty string. Reports expressionError if AE rejects it. One undo step.

| Parameter | Type | Description |
|---|---|---|
| `comp` | string \| number | Composition name or numeric item id. Omit to use the active composition. |
| `layer` *(required)* | string \| number | Layer name or 1-based index. |
| `property` *(required)* | string \| array | Property path: 'Transform/Position', 'Opacity', 'Source Text', 'Effects/Gaussian Blur/Blurriness' (names, matchNames or 1-based indices, '/'-separated or as an array). |
| `expression` *(required)* | string |  |

### ae_add_text_animator

Add a text animator reveal (the motion-design way, instead of animating Transform): offsets such as position [0, 40], opacity 0, blur 16 are applied through a Range Selector that is animated away. shape 'rampUp' (default for characters/words) slides a soft window over the text so letters overlap in a wave; 'square' (default for lines) animates Start 0 -> 100 with strong ease. mode 'out' mirrors the reveal (last units leave first). Several layers can be staggered. One undo step.

| Parameter | Type | Description |
|---|---|---|
| `comp` | string \| number | Composition name or numeric item id. Omit to use the active composition. |
| `layers` | array \| string \| number | Text layers. Omit to use the selected layers. |
| `offsets` | object | { position, anchorPoint, scale, rotation, opacity, blur, tracking, fillColor, skew }. Default { position: [0, 40], opacity: 0, blur: 16 }. |
| `basedOn` | string: `characters`, `charactersExcludingSpaces`, `words`, `lines` | Default characters. |
| `shape` | string: `rampUp`, `square` | rampUp = overlapping wave, square = one unit after another. |
| `waveWidth` | number | rampUp: width of the soft window in % of the text (default 40; larger = more overlap). |
| `start` | number | Start time in seconds (default: layer in-point). |
| `duration` | number | Default 1. |
| `stagger` | number | Frames between layers (default 0). |
| `influence` | number | Ease influence of the selector keys (default 85 for square, 50 for rampUp). |
| `ease` | object | Range Selector Advanced ease: { high, low } in percent. |
| `mode` | string: `in`, `out` |  |
| `name` | string | Animator name (default 'MCP Reveal'). |

### ae_copy_animation

Copy a property or a whole property group with its keyframes, easing and expressions from one layer to other layers (like Ctrl+C / Ctrl+V), optionally staggered. Works for text animators ('Text/Animators/Animator 1'), effects ('Effects/Gaussian Blur'), masks and single properties ('Transform/Position'). Target n (1-based in the given order) is shifted by offset + n * stagger frames. One undo step.

| Parameter | Type | Description |
|---|---|---|
| `comp` | string \| number | Composition name or numeric item id. Omit to use the active composition. |
| `from` *(required)* | string \| number | Source layer. |
| `property` *(required)* | string \| array | Property or group to copy. |
| `to` | array \| string \| number | Target layers. Omit to use the selected layers. |
| `stagger` | number | Frames between consecutive targets (default 0). |
| `offset` | number | Extra time shift in seconds (default 0). |
| `replace` | boolean | For indexed groups (animators, effects): remove a same-named one on the target first. |

## Effects and presets

### ae_list_available_effects

Search effects installed in After Effects by display name, matchName or category. Changes nothing.

| Parameter | Type | Description |
|---|---|---|
| `query` | string |  |
| `max` | number | Default 200. |
| `includeObsolete` | boolean |  |

### ae_apply_effect

Apply an effect to a layer by display name or matchName and optionally set its properties. Returns the effect's properties so they can be adjusted next. One undo step.

| Parameter | Type | Description |
|---|---|---|
| `comp` | string \| number | Composition name or numeric item id. Omit to use the active composition. |
| `layer` *(required)* | string \| number | Layer name or 1-based index. |
| `effect` *(required)* | string | e.g. 'Gaussian Blur' or 'ADBE Gaussian Blur 2'. |
| `name` | string | Optional new name for the effect instance. |
| `settings` | object | { propertyNameOrPath: value }, e.g. { Blurriness: 20 }. |

### ae_list_layer_effects

List the effects on a layer with their property tree and current values. Changes nothing.

| Parameter | Type | Description |
|---|---|---|
| `comp` | string \| number | Composition name or numeric item id. Omit to use the active composition. |
| `layer` *(required)* | string \| number | Layer name or 1-based index. |
| `depth` | number | Property tree depth (default 2). |
| `values` | boolean | Include values (default true). |

### ae_remove_effects

Remove effects from a layer by name, matchName or index (or an array of them), or all. One undo step.

| Parameter | Type | Description |
|---|---|---|
| `comp` | string \| number | Composition name or numeric item id. Omit to use the active composition. |
| `layer` *(required)* | string \| number | Layer name or 1-based index. |
| `effect` | string \| number \| array |  |
| `all` | boolean |  |

### ae_list_presets

Find animation presets (.ffx) in the standard Adobe preset folders or given folders. Words in query must all match the preset path, e.g. 'blur in'. Changes nothing.

| Parameter | Type | Description |
|---|---|---|
| `query` | string |  |
| `roots` | array | Folders to search instead of the defaults. |
| `max` | number | Default 200. |

### ae_apply_preset

Apply an animation preset (.ffx) to a layer. Find presets with ae_list_presets. One undo step.

| Parameter | Type | Description |
|---|---|---|
| `comp` | string \| number | Composition name or numeric item id. Omit to use the active composition. |
| `layer` *(required)* | string \| number | Layer name or 1-based index. |
| `path` *(required)* | string | Absolute path to the .ffx file. |

## Markers and audio

### ae_add_markers

Add one or many markers to a layer, or to the composition when layer is omitted. One undo step.

| Parameter | Type | Description |
|---|---|---|
| `comp` | string \| number | Composition name or numeric item id. Omit to use the active composition. |
| `layer` | string \| number | Layer name or index. Omit for composition markers. |
| `markers` *(required)* | array | [{ time, comment?, duration?, label? (0..16), chapter?, url? }] |

### ae_get_audio_info

Audio info of a layer: source file path, audio levels and their keyframes, existing markers. Changes nothing.

| Parameter | Type | Description |
|---|---|---|
| `comp` | string \| number | Composition name or numeric item id. Omit to use the active composition. |
| `layer` *(required)* | string \| number | Layer name or 1-based index. |

### ae_set_audio_levels

Set Audio Levels (dB) of a layer: static, at a time, or as a list of keyframes. One undo step.

| Parameter | Type | Description |
|---|---|---|
| `comp` | string \| number | Composition name or numeric item id. Omit to use the active composition. |
| `layer` *(required)* | string \| number | Layer name or 1-based index. |
| `level` | number | dB for both channels. |
| `left` | number |  |
| `right` | number |  |
| `time` | number | Time in seconds (composition time). |
| `keys` | array | [{ time, level } or { time, left, right }] |

### ae_analyze_audio

Analyze a WAV file: peak envelope and transient peaks (beats, hits). Pass path, or comp + layer to use the layer's source file (times are then converted to composition time). With addMarkers: true, places a marker at every peak (on that layer, or on the composition when only path is given; one undo step). Only uncompressed PCM/float WAV.

| Parameter | Type | Description |
|---|---|---|
| `path` | string | Absolute path to a .wav file. |
| `comp` | string \| number | Composition name or numeric item id. Omit to use the active composition. |
| `layer` | string \| number | Layer name or 1-based index. |
| `points` | number | Envelope resolution (default 200, max 5000). |
| `threshold` | number | Peak threshold relative to the loudest point, 0..1 (default 0.6). |
| `minGap` | number | Minimum seconds between peaks (default 0.1). |
| `addMarkers` | boolean |  |
| `markerComment` | string | Comment for created markers (default 'peak'). |
| `envelope` | boolean | Include the envelope in the answer (default true). |
