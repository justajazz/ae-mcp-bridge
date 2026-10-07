// JSX (ExtendScript, ES3) templates for AE MCP Bridge tools.
//
// Every template runs inside After Effects with:
//   args - data from the tool call (never spliced into the code)
//   mcp  - panel helpers (findComp, findLayer, layerType, projectInfo, ensureFolder, ...)
//   lib  - the helper library below, prepended to each template
// ES3 only: no let/const, arrow functions, template literals, Array.forEach/map/indexOf.
// tests/panel.test.mjs lints every string in this file.
//
// Parts of the effect/keyframe/marker/audio logic are adapted from
// TheLlamainator/after-effects-mcp (MIT, (c) 2025 Dakkshin).

// LIB is collapsed to a single line before use, so line numbers of errors in user code
// passed to ae_run_jsx stay correct. Keep explicit semicolons and no // comments inside.
const LIB_SOURCE = String.raw`var lib = (function () {
    function has(v) { return v !== undefined && v !== null; }
    function isArr(v) { return v instanceof Array; }
    function trim(s) { return String(s).replace(/^\s+|\s+$/g, ""); }

    function color(v) {
        if (!has(v)) return undefined;
        if (typeof v === "string") {
            var hex = trim(v).replace(/^#/, "");
            if (hex.length === 3) hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
            if (!/^[0-9a-fA-F]{6}$/.test(hex)) throw new Error("Bad color '" + v + "': use [r,g,b] 0..1 or '#RRGGBB'");
            return [parseInt(hex.substr(0, 2), 16) / 255, parseInt(hex.substr(2, 2), 16) / 255, parseInt(hex.substr(4, 2), 16) / 255];
        }
        if (isArr(v) && v.length >= 3) {
            var c = [Number(v[0]), Number(v[1]), Number(v[2])];
            if (c[0] > 1 || c[1] > 1 || c[2] > 1) c = [c[0] / 255, c[1] / 255, c[2] / 255];
            return c;
        }
        throw new Error("Bad color '" + v + "': use [r,g,b] 0..1 or '#RRGGBB'");
    }

    function comp(ref) { return mcp.findComp(ref); }

    function layer(c, ref) {
        if (!has(ref)) throw new Error("layer is required: name or 1-based index");
        return mcp.findLayer(c, ref);
    }

    function layers(c, refs, all) {
        var out = [], i;
        if (all) { for (i = 1; i <= c.numLayers; i++) out.push(c.layer(i)); return out; }
        if (has(refs)) {
            if (!isArr(refs)) refs = [refs];
            for (i = 0; i < refs.length; i++) out.push(mcp.findLayer(c, refs[i]));
            return out;
        }
        var selected = c.selectedLayers;
        for (i = 0; i < selected.length; i++) out.push(selected[i]);
        if (!out.length) throw new Error("No layers given and none selected in '" + c.name + "'");
        return out;
    }

    function isGroup(p) {
        return p.propertyType === PropertyType.NAMED_GROUP || p.propertyType === PropertyType.INDEXED_GROUP;
    }

    function child(group, token) {
        var p = null, i, lower;
        if (!group || !group.numProperties) return null;
        if (typeof token === "number") { try { p = group.property(token); } catch (e0) { p = null; } return p; }
        try { p = group.property(token); } catch (e1) { p = null; }
        if (p) return p;
        lower = String(token).toLowerCase();
        for (i = 1; i <= group.numProperties; i++) {
            p = group.property(i);
            if (p.name.toLowerCase() === lower || p.matchName.toLowerCase() === lower) return p;
        }
        return null;
    }

    function deep(group, token, depth) {
        var found = child(group, token), i, sub;
        if (found || depth <= 0) return found;
        for (i = 1; i <= group.numProperties; i++) {
            sub = group.property(i);
            if (isGroup(sub)) { found = deep(sub, token, depth - 1); if (found) return found; }
        }
        return null;
    }

    function tokens(path) {
        var list = isArr(path) ? path : String(path).split("/"), out = [], i, t;
        for (i = 0; i < list.length; i++) {
            t = list[i];
            if (typeof t === "string") { t = trim(t); if (/^\d+$/.test(t)) t = Number(t); }
            if (t !== "") out.push(t);
        }
        if (!out.length) throw new Error("Empty property path");
        return out;
    }

    var SHORTCUT_GROUPS = ["ADBE Transform Group", "ADBE Text Properties", "ADBE Audio Group", "ADBE Effect Parade"];

    function prop(lay, path) {
        var parts = tokens(path), p = child(lay, parts[0]), i, g;
        for (i = 0; !p && i < SHORTCUT_GROUPS.length; i++) {
            g = lay.property(SHORTCUT_GROUPS[i]);
            if (g) p = child(g, parts[0]);
        }
        if (!p && parts.length === 1) { g = lay.property("ADBE Effect Parade"); if (g) p = deep(g, parts[0], 3); }
        if (!p) throw new Error("Property '" + parts[0] + "' not found on layer '" + lay.name + "'. Use a path like 'Transform/Position' or 'Effects/Gaussian Blur/Blurriness'.");
        for (i = 1; i < parts.length; i++) {
            g = child(p, parts[i]);
            if (!g) throw new Error("Property '" + parts[i] + "' not found in '" + p.name + "'");
            p = g;
        }
        return p;
    }

    function propIn(group, path) {
        var parts = tokens(path), p = group, i, next;
        for (i = 0; i < parts.length; i++) {
            next = (i === 0 && parts.length === 1) ? deep(p, parts[i], 3) : child(p, parts[i]);
            if (!next) throw new Error("Property '" + parts[i] + "' not found in '" + p.name + "'");
            p = next;
        }
        return p;
    }

    function readValue(p) {
        try {
            if (isGroup(p) || p.propertyValueType === PropertyValueType.NO_VALUE) return undefined;
            return p.value;
        } catch (e) { return undefined; }
    }

    function tree(p, depth, withValues) {
        var info = { name: p.name, matchName: p.matchName, index: p.propertyIndex }, i, v;
        if (isGroup(p)) {
            if (depth > 0) {
                info.children = [];
                for (i = 1; i <= p.numProperties; i++) {
                    if (!isPlaceholder(p, p.property(i))) info.children.push(tree(p.property(i), depth - 1, withValues));
                }
            } else {
                info.numProperties = p.numProperties;
            }
            try { if (p.propertyType === PropertyType.INDEXED_GROUP || p.parentProperty.matchName === "ADBE Effect Parade") info.enabled = p.enabled; } catch (e0) {}
        } else {
            if (withValues) { v = readValue(p); if (v !== undefined) info.value = v; }
            try { if (p.numKeys) info.numKeys = p.numKeys; } catch (e1) {}
            try { if (p.expressionEnabled) info.expression = p.expression; } catch (e2) {}
        }
        return info;
    }

    var JUSTIFY = { left: "LEFT_JUSTIFY", center: "CENTER_JUSTIFY", right: "RIGHT_JUSTIFY" };

    function textDocument(doc, v) {
        if (typeof v === "string") { doc.text = v; return doc; }
        if (has(v.text)) doc.text = String(v.text);
        if (has(v.font)) doc.font = String(v.font);
        if (has(v.fontSize)) doc.fontSize = Number(v.fontSize);
        if (has(v.fillColor)) { doc.applyFill = true; doc.fillColor = color(v.fillColor); }
        if (has(v.strokeColor)) { doc.applyStroke = true; doc.strokeColor = color(v.strokeColor); }
        if (has(v.strokeWidth)) doc.strokeWidth = Number(v.strokeWidth);
        if (has(v.applyFill)) doc.applyFill = !!v.applyFill;
        if (has(v.applyStroke)) doc.applyStroke = !!v.applyStroke;
        if (has(v.tracking)) doc.tracking = Number(v.tracking);
        if (has(v.leading)) doc.leading = Number(v.leading);
        if (has(v.justification)) {
            var j = JUSTIFY[String(v.justification).toLowerCase()];
            if (!j) throw new Error("justification must be left, center or right");
            doc.justification = ParagraphJustification[j];
        }
        return doc;
    }

    function toValue(p, v) {
        var type = p.propertyValueType, cur, out, i;
        if (type === PropertyValueType.TEXT_DOCUMENT) return textDocument(p.value, v);
        if (type === PropertyValueType.COLOR) { out = color(v); return [out[0], out[1], out[2], 1]; }
        if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(trim(v))) v = Number(v);
        cur = readValue(p);
        if (isArr(cur) && typeof v === "number") { out = []; for (i = 0; i < cur.length; i++) out.push(v); return out; }
        if (isArr(cur) && isArr(v) && v.length < cur.length) {
            out = v.slice(0);
            for (i = v.length; i < cur.length; i++) out.push(cur[i]);
            return out;
        }
        return v;
    }

    function setValue(p, v, time) {
        if (isGroup(p)) throw new Error("'" + p.name + "' is a group, not a value property");
        var value = toValue(p, v);
        if (has(time)) {
            if (!p.canVaryOverTime) throw new Error("'" + p.name + "' cannot be keyframed");
            p.setValueAtTime(Number(time), value);
        } else {
            if (p.numKeys > 0) throw new Error("'" + p.name + "' has keyframes: pass time, or use ae_set_keyframes");
            p.setValue(value);
        }
        return p;
    }

    function easeCount(p) {
        if (p.propertyValueType === PropertyValueType.TwoD) return 2;
        if (p.propertyValueType === PropertyValueType.ThreeD) return 3;
        return 1;
    }

    function easeList(p, spec, influence) {
        var n = easeCount(p), out = [], i;
        var speed = (spec && has(spec.speed)) ? Number(spec.speed) : 0;
        var infl = (spec && has(spec.influence)) ? Number(spec.influence) : influence;
        infl = Math.max(0.1, Math.min(100, infl));
        for (i = 0; i < n; i++) out.push(new KeyframeEase(speed, infl));
        return out;
    }

    function applyEase(p, k, key) {
        var mode = key.ease, infl = has(key.influence) ? Number(key.influence) : 33.333;
        var B = KeyframeInterpolationType.BEZIER, L = KeyframeInterpolationType.LINEAR, H = KeyframeInterpolationType.HOLD;
        if (mode === "linear") p.setInterpolationTypeAtKey(k, L, L);
        else if (mode === "hold") p.setInterpolationTypeAtKey(k, H, H);
        else if (mode === "bezier") p.setInterpolationTypeAtKey(k, B, B);
        else if (mode === "easy") { p.setInterpolationTypeAtKey(k, B, B); p.setTemporalEaseAtKey(k, easeList(p, null, infl), easeList(p, null, infl)); }
        else if (mode === "easyIn") { p.setInterpolationTypeAtKey(k, B, p.keyOutInterpolationType(k)); p.setTemporalEaseAtKey(k, easeList(p, null, infl), p.keyOutTemporalEase(k)); }
        else if (mode === "easyOut") { p.setInterpolationTypeAtKey(k, p.keyInInterpolationType(k), B); p.setTemporalEaseAtKey(k, p.keyInTemporalEase(k), easeList(p, null, infl)); }
        else if (has(mode)) throw new Error("Unknown ease '" + mode + "': use linear, hold, bezier, easy, easyIn, easyOut");
        if (has(key.easeIn) || has(key.easeOut)) {
            p.setInterpolationTypeAtKey(k, has(key.easeIn) ? B : p.keyInInterpolationType(k), has(key.easeOut) ? B : p.keyOutInterpolationType(k));
            p.setTemporalEaseAtKey(k,
                has(key.easeIn) ? easeList(p, key.easeIn, 33.333) : p.keyInTemporalEase(k),
                has(key.easeOut) ? easeList(p, key.easeOut, 33.333) : p.keyOutTemporalEase(k));
        }
        if (p.isSpatial) {
            if (has(key.spatialAutoBezier)) p.setSpatialAutoBezierAtKey(k, !!key.spatialAutoBezier);
            if (has(key.spatialContinuous)) p.setSpatialContinuousAtKey(k, !!key.spatialContinuous);
            if (has(key.inTangent) || has(key.outTangent)) {
                p.setSpatialTangentsAtKey(k, has(key.inTangent) ? key.inTangent : p.keyInSpatialTangent(k), has(key.outTangent) ? key.outTangent : p.keyOutSpatialTangent(k));
            }
            if (has(key.roving)) { try { p.setRovingAtKey(k, !!key.roving); } catch (e) {} }
        }
    }

    function keyAt(p, time, frame) {
        if (!p.numKeys) return 0;
        var k = p.nearestKeyIndex(time);
        return Math.abs(p.keyTime(k) - time) <= frame / 2 ? k : 0;
    }

    function effectId(ref) {
        var lower = String(ref).toLowerCase(), list = app.effects, n = list.length, i;
        for (i = 0; i < n; i++) if (list[i].matchName === ref) return ref;
        for (i = 0; i < n; i++) if (String(list[i].displayName).toLowerCase() === lower) return list[i].matchName;
        return String(ref);
    }

    function findEffect(lay, ref) {
        var parade = lay.property("ADBE Effect Parade"), fx;
        if (!parade || !parade.numProperties) throw new Error("Layer '" + lay.name + "' has no effects");
        fx = child(parade, ref);
        if (!fx) throw new Error("Effect '" + ref + "' not found on layer '" + lay.name + "'");
        return fx;
    }

    function isPlaceholder(group, p) {
        try {
            return group.propertyType === PropertyType.NAMED_GROUP && !isGroup(p) && !p.canSetExpression && group.canAddProperty(p.matchName);
        } catch (e) { return false; }
    }

    function propPath(p) {
        var names = [], matchNames = [], cur = p;
        while (cur && cur.propertyDepth > 0) {
            names.unshift(cur.name);
            matchNames.unshift(cur.matchName);
            cur = cur.parentProperty;
        }
        return { path: names.join("/"), matchPath: matchNames.join("/") };
    }

    var INTERP = {};
    INTERP[KeyframeInterpolationType.LINEAR] = "linear";
    INTERP[KeyframeInterpolationType.BEZIER] = "bezier";
    INTERP[KeyframeInterpolationType.HOLD] = "hold";

    function easeOut(list) {
        var out = [], i;
        for (i = 0; i < list.length; i++) out.push({ speed: Math.round(list[i].speed * 1000) / 1000, influence: Math.round(list[i].influence * 100) / 100 });
        return out;
    }

    function keys(p, max) {
        var out = [], n = Math.min(p.numKeys, max || 100), k, key;
        for (k = 1; k <= n; k++) {
            key = { index: k, time: p.keyTime(k), value: p.keyValue(k),
                interpolation: [INTERP[p.keyInInterpolationType(k)], INTERP[p.keyOutInterpolationType(k)]] };
            try { key.easeIn = easeOut(p.keyInTemporalEase(k)); key.easeOut = easeOut(p.keyOutTemporalEase(k)); } catch (e0) {}
            try { if (p.isSpatial) { key.inTangent = p.keyInSpatialTangent(k); key.outTangent = p.keyOutSpatialTangent(k); } } catch (e1) {}
            out.push(key);
        }
        return out;
    }

    function inspect(p, depth, opts, budget) {
        var info = { name: p.name, matchName: p.matchName }, i, v, kids;
        budget.left--;
        if (isGroup(p)) {
            try { if (p.propertyType === PropertyType.INDEXED_GROUP) info.indexed = true; } catch (e0) {}
            try { if (p.canSetEnabled) info.enabled = p.enabled; } catch (e1) {}
            if (depth > 0 && budget.left > 0) {
                kids = [];
                for (i = 1; i <= p.numProperties && budget.left > 0; i++) {
                    var c = p.property(i);
                    if (isPlaceholder(p, c)) continue;
                    if (opts.modifiedOnly && !c.isModified) continue;
                    kids.push(inspect(c, depth - 1, opts, budget));
                }
                info.children = kids;
            } else {
                info.numProperties = p.numProperties;
            }
            return info;
        }
        if (opts.values) { v = readValue(p); if (v !== undefined) info.value = v; }
        try { if (p.numKeys) { info.numKeys = p.numKeys; if (opts.keys) info.keys = keys(p, 50); } } catch (e2) {}
        try { if (p.expressionEnabled) info.expression = p.expression; } catch (e3) {}
        try { if (p.dimensionsSeparated) info.dimensionsSeparated = true; } catch (e4) {}
        return info;
    }

    function layerInfo(l) {
        var info = { index: l.index, name: l.name, type: mcp.layerType(l), inPoint: l.inPoint, outPoint: l.outPoint, startTime: l.startTime };
        try { info.position = l.property("ADBE Transform Group").property("ADBE Position").value; } catch (e) {}
        return info;
    }

    return {
        has: has, isArr: isArr, color: color, comp: comp, layer: layer, layers: layers,
        isGroup: isGroup, child: child, prop: prop, propIn: propIn, readValue: readValue, tree: tree,
        textDocument: textDocument, toValue: toValue, setValue: setValue, applyEase: applyEase, keyAt: keyAt,
        effectId: effectId, findEffect: findEffect, layerInfo: layerInfo,
        propPath: propPath, keys: keys, inspect: inspect, interpName: INTERP, isPlaceholder: isPlaceholder
    };
})();`;

// One line: errors in templates/user code keep their own line numbers.
export const LIB = LIB_SOURCE.replace(/\s*\n\s*/g, " ");

export const JSX = {
  health: String.raw`(function () {
    var info = { app: app.name, version: app.version, build: app.buildName, os: $.os,
        panelVersion: mcp.version, bridgeDir: mcp.bridgeDir, project: mcp.projectInfo(), activeComp: null };
    var item = app.project ? app.project.activeItem : null;
    if (item instanceof CompItem) info.activeComp = { id: item.id, name: item.name, time: item.time, numLayers: item.numLayers };
    return info;
})()`,

  listProject: String.raw`(function () {
    if (!app.project) throw new Error("No project is open");
    var comps = [];
    for (var i = 1; i <= app.project.numItems; i++) {
        var item = app.project.item(i);
        if (!(item instanceof CompItem)) continue;
        var layers = [];
        for (var j = 1; j <= item.numLayers; j++) {
            var layer = item.layer(j);
            layers.push({ index: j, name: layer.name, type: mcp.layerType(layer), enabled: layer.enabled,
                inPoint: layer.inPoint, outPoint: layer.outPoint });
        }
        comps.push({ id: item.id, name: item.name, width: item.width, height: item.height,
            duration: item.duration, frameRate: item.frameRate, layers: layers });
    }
    var result = { project: mcp.projectInfo(), compositions: comps };
    if (args.items !== false) {
        var items = [];
        for (var k = 1; k <= app.project.numItems && items.length < 2000; k++) {
            var it = app.project.item(k);
            if (it instanceof CompItem) continue;
            var info = { id: it.id, name: it.name, folder: it.parentFolder ? it.parentFolder.name : null };
            if (it instanceof FolderItem) { info.type = "folder"; info.numItems = it.numItems; }
            else {
                info.type = it.mainSource instanceof SolidSource ? "solid" : "footage";
                try { if (it.file) info.file = it.file.fsName; } catch (e0) {}
                try { info.usedIn = it.usedIn.length; } catch (e1) {}
                try { if (it.footageMissing) info.missing = true; } catch (e2) {}
            }
            items.push(info);
        }
        result.items = items;
    }
    return result;
})()`,

  saveProject: String.raw`(function () {
    if (!app.project) throw new Error("No project is open");
    if (args.path) {
        var file = new File(args.path);
        if (!/\.aep$/i.test(file.fsName)) throw new Error("path must be an absolute .aep path");
        mcp.ensureFolder(file.parent.fsName);
        app.project.save(file);
    } else {
        if (!app.project.file) throw new Error("The project has never been saved: pass an absolute .aep path");
        app.project.save();
    }
    return { saved: true, path: app.project.file.fsName };
})()`,

  openProject: String.raw`(function () {
    var file = new File(args.path), dirty = false;
    if (!file.exists) throw new Error("Project not found: " + args.path);
    try { dirty = app.project && app.project.dirty === true; } catch (e) { dirty = true; }
    if (dirty && !args.save && !args.discard) {
        throw new Error("The open project has unsaved changes: pass save: true to save them or discard: true to drop them");
    }
    if (app.project) app.project.close(dirty && args.save ? CloseOptions.SAVE_CHANGES : CloseOptions.DO_NOT_SAVE_CHANGES);
    app.open(file);
    return mcp.projectInfo();
})()`,

  captureFrame: String.raw`(function () {
    var comp = mcp.findComp(args.comp);
    var time = (args.time === undefined || args.time === null) ? comp.time : Number(args.time);
    var file = new File(args.path);
    mcp.ensureFolder(file.parent.fsName);
    comp.saveFrameToPng(time, file);
    return { path: file.fsName, composition: comp.name, compId: comp.id, time: time,
        width: comp.width, height: comp.height, bgColor: comp.bgColor };
})()`,

  createComp: String.raw`(function () {
    if (!app.project) throw new Error("No project is open");
    var c = app.project.items.addComp(
        lib.has(args.name) ? String(args.name) : "Comp",
        Math.round(lib.has(args.width) ? Number(args.width) : 1920),
        Math.round(lib.has(args.height) ? Number(args.height) : 1080),
        lib.has(args.pixelAspect) ? Number(args.pixelAspect) : 1,
        lib.has(args.duration) ? Number(args.duration) : 10,
        lib.has(args.frameRate) ? Number(args.frameRate) : 30);
    if (lib.has(args.bgColor)) c.bgColor = lib.color(args.bgColor);
    if (lib.has(args.motionBlur)) c.motionBlur = !!args.motionBlur;
    if (args.open !== false) c.openInViewer();
    return { id: c.id, name: c.name, width: c.width, height: c.height, pixelAspect: c.pixelAspect,
        duration: c.duration, frameRate: c.frameRate, bgColor: c.bgColor };
})()`,

  createLayer: String.raw`(function () {
    var c = lib.comp(args.comp), type = String(args.type || "").toLowerCase(), l, size, contents, group, items, shape, fill, stroke;
    var center = [c.width / 2, c.height / 2];
    if (type === "text") {
        l = c.layers.addText(lib.has(args.text) ? String(args.text) : "Text");
        var tp = l.property("ADBE Text Properties").property("ADBE Text Document");
        tp.setValue(lib.textDocument(tp.value, {
            font: args.font, fontSize: args.fontSize, fillColor: args.color, strokeColor: args.strokeColor,
            strokeWidth: args.strokeWidth, justification: lib.has(args.justification) ? args.justification : "center"
        }));
    } else if (type === "shape") {
        l = c.layers.addShape();
        size = lib.has(args.size) ? args.size : [200, 200];
        if (typeof size === "number") size = [size, size];
        group = l.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
        items = group.property("ADBE Vectors Group");
        var kind = String(args.shape || "rectangle").toLowerCase();
        if (kind === "rectangle") {
            shape = items.addProperty("ADBE Vector Shape - Rect");
            shape.property("ADBE Vector Rect Size").setValue(size);
            if (lib.has(args.roundness)) shape.property("ADBE Vector Rect Roundness").setValue(Number(args.roundness));
        } else if (kind === "ellipse") {
            shape = items.addProperty("ADBE Vector Shape - Ellipse");
            shape.property("ADBE Vector Ellipse Size").setValue(size);
        } else if (kind === "polygon" || kind === "star") {
            shape = items.addProperty("ADBE Vector Shape - Star");
            shape.property("ADBE Vector Star Type").setValue(kind === "polygon" ? 2 : 1);
            shape.property("ADBE Vector Star Points").setValue(lib.has(args.points) ? Number(args.points) : 5);
            shape.property("ADBE Vector Star Outer Radius").setValue(size[0] / 2);
            if (kind === "star") shape.property("ADBE Vector Star Inner Radius").setValue(size[0] / 4);
        } else {
            throw new Error("shape must be rectangle, ellipse, polygon or star");
        }
        if (args.fill !== false) {
            fill = items.addProperty("ADBE Vector Graphic - Fill");
            fill.property("ADBE Vector Fill Color").setValue(lib.toValue(fill.property("ADBE Vector Fill Color"), lib.has(args.color) ? args.color : [1, 1, 1]));
        }
        if (lib.has(args.strokeWidth) && Number(args.strokeWidth) > 0) {
            stroke = items.addProperty("ADBE Vector Graphic - Stroke");
            stroke.property("ADBE Vector Stroke Color").setValue(lib.toValue(stroke.property("ADBE Vector Stroke Color"), lib.has(args.strokeColor) ? args.strokeColor : [0, 0, 0]));
            stroke.property("ADBE Vector Stroke Width").setValue(Number(args.strokeWidth));
        }
        l.property("ADBE Transform Group").property("ADBE Position").setValue(center);
    } else if (type === "solid" || type === "adjustment") {
        size = lib.has(args.size) ? args.size : [c.width, c.height];
        l = c.layers.addSolid(type === "solid" ? lib.color(lib.has(args.color) ? args.color : [1, 1, 1]) : [1, 1, 1],
            lib.has(args.name) ? String(args.name) : (type === "solid" ? "Solid" : "Adjustment Layer"),
            Math.round(size[0]), Math.round(size[1]), c.pixelAspect);
        if (type === "adjustment") l.adjustmentLayer = true;
    } else if (type === "null") {
        l = c.layers.addNull();
    } else {
        throw new Error("type must be text, shape, solid, adjustment or null");
    }
    if (lib.has(args.name)) l.name = String(args.name);
    if (lib.has(args.position)) lib.setValue(l.property("ADBE Transform Group").property("ADBE Position"), args.position);
    if (lib.has(args.startTime)) l.startTime = Number(args.startTime);
    if (lib.has(args.duration)) l.outPoint = l.inPoint + Number(args.duration);
    return lib.layerInfo(l);
})()`,

  setLayer: String.raw`(function () {
    var c = lib.comp(args.comp), l = lib.layer(c, args.layer), changed = [], tr = l.property("ADBE Transform Group");
    var map = { anchorPoint: "ADBE Anchor Point", position: "ADBE Position", scale: "ADBE Scale", opacity: "ADBE Opacity" };
    if (lib.has(args.name)) { l.name = String(args.name); changed.push("name"); }
    if (lib.has(args.enabled)) { l.enabled = !!args.enabled; changed.push("enabled"); }
    if (lib.has(args.threeD)) { l.threeDLayer = !!args.threeD; changed.push("threeD"); }
    if (lib.has(args.label)) { l.label = Number(args.label); changed.push("label"); }
    if (args.parent === null) { l.parent = null; changed.push("parent"); }
    else if (lib.has(args.parent)) { l.parent = lib.layer(c, args.parent); changed.push("parent"); }
    if (lib.has(args.motionBlur)) {
        l.motionBlur = !!args.motionBlur;
        if (args.motionBlur && !c.motionBlur) { c.motionBlur = true; changed.push("comp.motionBlur"); }
        changed.push("motionBlur");
    }
    if (args.trackMatte === null) {
        if (typeof l.removeTrackMatte === "function") l.removeTrackMatte(); else l.trackMatteType = TrackMatteType.NO_TRACK_MATTE;
        changed.push("trackMatte");
    } else if (lib.has(args.trackMatte)) {
        var MATTE = { alpha: "ALPHA", alphaInverted: "ALPHA_INVERTED", luma: "LUMA", lumaInverted: "LUMA_INVERTED" };
        var matteType = MATTE[args.trackMatteType || "alpha"];
        if (!matteType) throw new Error("trackMatteType must be alpha, alphaInverted, luma or lumaInverted");
        if (typeof l.setTrackMatte !== "function") throw new Error("Track matte by layer needs After Effects 2023 or newer");
        var matte = lib.layer(c, args.trackMatte);
        l.setTrackMatte(matte, TrackMatteType[matteType]);
        if (lib.has(args.matteVisible)) matte.enabled = !!args.matteVisible;
        changed.push("trackMatte");
    }
    if (lib.has(args.startTime)) { l.startTime = Number(args.startTime); changed.push("startTime"); }
    if (lib.has(args.inPoint)) { l.inPoint = Number(args.inPoint); changed.push("inPoint"); }
    if (lib.has(args.outPoint)) { l.outPoint = Number(args.outPoint); changed.push("outPoint"); }
    for (var key in map) {
        if (map.hasOwnProperty(key) && lib.has(args[key])) { lib.setValue(tr.property(map[key]), args[key], args.time); changed.push(key); }
    }
    if (lib.has(args.rotation)) {
        lib.setValue(tr.property("ADBE Rotate Z"), args.rotation, args.time);
        changed.push("rotation");
    }
    var textFields = ["text", "font", "fontSize", "fillColor", "strokeColor", "strokeWidth", "justification", "tracking", "leading"];
    var textArgs = {}, hasText = false;
    for (var i = 0; i < textFields.length; i++) {
        if (lib.has(args[textFields[i]])) { textArgs[textFields[i]] = args[textFields[i]]; hasText = true; changed.push(textFields[i]); }
    }
    if (hasText) {
        if (!(l instanceof TextLayer)) throw new Error("Text fields given but '" + l.name + "' is not a text layer");
        lib.setValue(l.property("ADBE Text Properties").property("ADBE Text Document"), textArgs, args.time);
    }
    var info = lib.layerInfo(l);
    info.changed = changed;
    info.scale = tr.property("ADBE Scale").value;
    info.rotation = tr.property("ADBE Rotate Z").value;
    info.opacity = tr.property("ADBE Opacity").value;
    info.anchorPoint = tr.property("ADBE Anchor Point").value;
    try { info.motionBlur = l.motionBlur; } catch (e1) {}
    try { if (l.hasTrackMatte) info.trackMatte = { layer: l.trackMatteLayer ? l.trackMatteLayer.name : null, type: l.trackMatteType }; } catch (e2) {}
    return info;
})()`,

  setComp: String.raw`(function () {
    var c = lib.comp(args.comp), changed = [];
    if (lib.has(args.name)) { c.name = String(args.name); changed.push("name"); }
    if (lib.has(args.width)) { c.width = Math.round(Number(args.width)); changed.push("width"); }
    if (lib.has(args.height)) { c.height = Math.round(Number(args.height)); changed.push("height"); }
    if (lib.has(args.duration)) { c.duration = Number(args.duration); changed.push("duration"); }
    if (lib.has(args.frameRate)) { c.frameRate = Number(args.frameRate); changed.push("frameRate"); }
    if (lib.has(args.bgColor)) { c.bgColor = lib.color(args.bgColor); changed.push("bgColor"); }
    if (lib.has(args.motionBlur)) { c.motionBlur = !!args.motionBlur; changed.push("motionBlur"); }
    if (lib.has(args.shutterAngle)) { c.shutterAngle = Number(args.shutterAngle); changed.push("shutterAngle"); }
    if (lib.has(args.workAreaStart)) { c.workAreaStart = Number(args.workAreaStart); changed.push("workAreaStart"); }
    if (lib.has(args.workAreaDuration)) { c.workAreaDuration = Number(args.workAreaDuration); changed.push("workAreaDuration"); }
    if (lib.has(args.time)) { c.time = Number(args.time); changed.push("time"); }
    if (args.open) c.openInViewer();
    return { id: c.id, name: c.name, width: c.width, height: c.height, duration: c.duration, frameRate: c.frameRate,
        bgColor: c.bgColor, motionBlur: c.motionBlur, shutterAngle: c.shutterAngle,
        workAreaStart: c.workAreaStart, workAreaDuration: c.workAreaDuration, time: c.time, changed: changed };
})()`,

  captureFrames: String.raw`(function () {
    var c = lib.comp(args.comp), fd = c.frameDuration, times = [], i, t;
    if (lib.isArr(args.times) && args.times.length) {
        for (i = 0; i < args.times.length; i++) times.push(Number(args.times[i]));
    } else {
        var start = lib.has(args.start) ? Number(args.start) : 0;
        var end = lib.has(args.end) ? Number(args.end) : c.duration - fd;
        var count = lib.has(args.count) ? Math.max(1, Math.round(Number(args.count))) : 9;
        if (lib.has(args.step)) { for (t = start; t <= end + fd / 2 && times.length < 100; t += Number(args.step)) times.push(t); }
        else if (count === 1) times.push(start);
        else for (i = 0; i < count; i++) times.push(start + (end - start) * i / (count - 1));
    }
    if (times.length > args.maxFrames) throw new Error("Too many frames: " + times.length + " (max " + args.maxFrames + ")");
    mcp.ensureFolder(new File(args.prefix + "0.png").parent.fsName);
    var frames = [];
    for (i = 0; i < times.length; i++) {
        t = Math.round(times[i] / fd) * fd;
        var file = new File(args.prefix + i + ".png");
        c.saveFrameToPng(t, file);
        frames.push({ time: Math.round(t * 1000) / 1000, frame: Math.round(t / fd), path: file.fsName });
    }
    return { composition: c.name, width: c.width, height: c.height, frameRate: c.frameRate, bgColor: c.bgColor, frames: frames };
})()`,

  selection: String.raw`(function () {
    var result = { project: [], comp: null, layers: [], properties: [] }, i, sel, item;
    sel = app.project.selection;
    for (i = 0; i < sel.length; i++) result.project.push({ id: sel[i].id, name: sel[i].name, type: sel[i].typeName });
    item = app.project.activeItem;
    if (!(item instanceof CompItem)) return result;
    result.comp = { id: item.id, name: item.name, time: item.time };
    for (i = 0; i < item.selectedLayers.length; i++) result.layers.push(lib.layerInfo(item.selectedLayers[i]));
    var props = item.selectedProperties, depth = lib.has(args.depth) ? Number(args.depth) : 3;
    for (i = 0; i < props.length && i < 50; i++) {
        var p = props[i], layer = p.propertyGroup(p.propertyDepth), path = lib.propPath(p);
        var info = { layer: layer.name, layerIndex: layer.index, path: path.path, matchPath: path.matchPath };
        if (lib.isGroup(p)) info.tree = lib.inspect(p, depth, { values: true, keys: true }, { left: 500 });
        else {
            info.value = lib.readValue(p);
            if (p.numKeys) { info.keys = lib.keys(p, 50); info.selectedKeys = p.selectedKeys; }
            try { if (p.expressionEnabled) info.expression = p.expression; } catch (e) {}
        }
        result.properties.push(info);
    }
    return result;
})()`,

  inspect: String.raw`(function () {
    var c = lib.comp(args.comp), l = lib.layer(c, args.layer);
    var root = lib.has(args.property) ? lib.prop(l, args.property) : l;
    var opts = { values: args.values !== false, keys: args.keys !== false, modifiedOnly: args.modifiedOnly !== false };
    var budget = { left: lib.has(args.maxNodes) ? Number(args.maxNodes) : 800 };
    var tree = lib.inspect(root, lib.has(args.depth) ? Number(args.depth) : 6, opts, budget);
    var out = { layer: l.name, index: l.index, type: mcp.layerType(l), path: root === l ? "" : lib.propPath(root).path, tree: tree };
    if (budget.left <= 0) out.truncated = "Node budget exhausted: pass property, smaller depth or larger maxNodes";
    return out;
})()`,

  copyAnimation: String.raw`(function () {
    var c = lib.comp(args.comp), src = lib.layer(c, args.from), fd = c.frameDuration;
    var srcProp = lib.prop(src, args.property);
    var targets = lib.layers(c, args.to, false), stagger = lib.has(args.stagger) ? Number(args.stagger) : 0;
    var offset = lib.has(args.offset) ? Number(args.offset) : 0, warnings = [], done = [];
    var chain = [], cur = srcProp;
    while (cur && cur.propertyDepth > 0) { chain.unshift(cur); cur = cur.parentProperty; }

    function isIndexed(g) { return g.propertyType === PropertyType.INDEXED_GROUP; }

    function copyValue(s, d, shift) {
        if (s.propertyValueType === PropertyValueType.NO_VALUE) return;
        try {
            if (s.numKeys > 0) {
                while (d.numKeys > 0) d.removeKey(1);
                var k;
                for (k = 1; k <= s.numKeys; k++) d.setValueAtTime(s.keyTime(k) + shift, s.keyValue(k));
                for (k = 1; k <= s.numKeys; k++) {
                    d.setInterpolationTypeAtKey(k, s.keyInInterpolationType(k), s.keyOutInterpolationType(k));
                    try { d.setTemporalEaseAtKey(k, s.keyInTemporalEase(k), s.keyOutTemporalEase(k)); } catch (e1) {}
                    try { d.setTemporalContinuousAtKey(k, s.keyTemporalContinuous(k)); d.setTemporalAutoBezierAtKey(k, s.keyTemporalAutoBezier(k)); } catch (e2) {}
                    if (s.isSpatial) {
                        try { d.setSpatialTangentsAtKey(k, s.keyInSpatialTangent(k), s.keyOutSpatialTangent(k)); } catch (e3) {}
                        try { d.setRovingAtKey(k, s.keyRoving(k)); } catch (e4) {}
                    }
                }
            } else if (s.isModified) {
                if (d.numKeys === 0) d.setValue(s.value);
            }
            if (s.canSetExpression && s.expressionEnabled) d.expression = s.expression;
        } catch (e) {
            warnings.push(lib.propPath(s).path + ": " + e.toString());
        }
    }

    function copyChildren(s, d, shift) {
        for (var i = 1; i <= s.numProperties; i++) {
            var sc = s.property(i), dc = null;
            if (isIndexed(s)) {
                if (!d.canAddProperty(sc.matchName)) { warnings.push("cannot add " + sc.matchName + " to " + d.name); continue; }
                dc = d.addProperty(sc.matchName);
                try { if (lib.isGroup(sc)) dc.name = sc.name; } catch (eName) {}
            } else {
                // Named groups such as a text animator's Properties list every possible property; the ones
                // not added yet are hidden placeholders (still addable). Skip them in the source, add them in the target.
                if (lib.isPlaceholder(s, sc)) continue;
                dc = d.canAddProperty(sc.matchName) ? d.addProperty(sc.matchName) : d.property(sc.matchName);
            }
            if (!dc) continue;
            if (lib.isGroup(sc)) copyChildren(sc, dc, shift); else copyValue(sc, dc, shift);
        }
    }

    for (var t = 0; t < targets.length; t++) {
        var tl = targets[t];
        if (tl === src) { warnings.push("skipped the source layer itself"); continue; }
        var shift = offset + (t + 1) * stagger * fd, parent = tl, ok = true;
        for (var j = 0; j < chain.length - 1; j++) {
            var link = chain[j], next = null;
            if (isIndexed(link.parentProperty || src)) next = lib.child(parent, link.name) || lib.child(parent, link.matchName);
            else next = parent.property(link.matchName);
            if (!next) { warnings.push(tl.name + ": no '" + link.name + "' to copy into"); ok = false; break; }
            parent = next;
        }
        if (!ok) continue;
        var last = chain[chain.length - 1], dest;
        var parentIndexed = chain.length > 1 ? isIndexed(chain[chain.length - 2]) : false;
        if (parentIndexed) {
            if (args.replace) { var old = lib.child(parent, last.name); if (old) old.remove(); }
            if (!parent.canAddProperty(last.matchName)) { warnings.push(tl.name + ": cannot add " + last.matchName); continue; }
            dest = parent.addProperty(last.matchName);
            try { dest.name = last.name; } catch (eN) {}
        } else {
            dest = parent.property(last.matchName);
        }
        if (!dest) { warnings.push(tl.name + ": target property missing"); continue; }
        if (lib.isGroup(last)) copyChildren(last, dest, shift); else copyValue(last, dest, shift);
        done.push({ layer: tl.name, index: tl.index, shiftSeconds: Math.round(shift * 1000) / 1000 });
    }
    return { from: src.name, property: lib.propPath(srcProp).path, copiedTo: done, warnings: warnings };
})()`,

  addTextAnimator: String.raw`(function () {
    var c = lib.comp(args.comp), list = lib.layers(c, args.layers, false), fd = c.frameDuration;
    var PROPS = { position: "ADBE Text Position 3D", anchorPoint: "ADBE Text Anchor Point 3D", scale: "ADBE Text Scale 3D",
        rotation: "ADBE Text Rotation", opacity: "ADBE Text Opacity", blur: "ADBE Text Blur", tracking: "ADBE Text Tracking Amount",
        fillColor: "ADBE Text Fill Color", skew: "ADBE Text Skew" };
    var BASED = { characters: 1, charactersExcludingSpaces: 2, words: 3, lines: 4 };
    var SHAPES = { square: 1, rampUp: 2 };
    var offsets = args.offsets || { position: [0, 40], opacity: 0, blur: 16 };
    var basedOnName = args.basedOn || "characters", basedOn = BASED[basedOnName];
    if (!basedOn) throw new Error("basedOn must be characters, charactersExcludingSpaces, words or lines");
    // square: Start 0 -> 100 reveals units one by one ("typewriter" on characters).
    // rampUp: a soft-edged window (End = waveWidth %) slides over the text via Offset -width -> 100,
    // so neighbouring characters overlap into a wave; units after the window stay fully offset.
    var shapeName = args.shape || (basedOnName === "lines" ? "square" : "rampUp"), shape = SHAPES[shapeName];
    if (!shape) throw new Error("shape must be square or rampUp");
    var waveWidth = lib.has(args.waveWidth) ? Math.max(5, Math.min(100, Number(args.waveWidth))) : 40;
    var start = lib.has(args.start) ? Number(args.start) : null, duration = lib.has(args.duration) ? Number(args.duration) : 1;
    var stagger = lib.has(args.stagger) ? Number(args.stagger) : 0;
    var influence = lib.has(args.influence) ? Number(args.influence) : (shape === 1 ? 85 : 50);
    var mode = args.mode || "in", out = [];
    for (var i = 0; i < list.length; i++) {
        var l = list[i];
        if (!(l instanceof TextLayer)) throw new Error("'" + l.name + "' is not a text layer");
        var animators = function () { return l.property("ADBE Text Properties").property("ADBE Text Animators"); };
        var a = animators().addProperty("ADBE Text Animator"), ai = a.propertyIndex;
        a.name = lib.has(args.name) ? String(args.name) : "MCP Reveal";
        var anim = function () { return animators().property(ai); };
        for (var key in offsets) {
            if (!offsets.hasOwnProperty(key)) continue;
            if (!PROPS[key]) throw new Error("Unknown offset '" + key + "'. Use: position, anchorPoint, scale, rotation, opacity, blur, tracking, fillColor, skew");
            var p = anim().property("ADBE Text Animator Properties").addProperty(PROPS[key]);
            p.setValue(lib.toValue(p, offsets[key]));
        }
        anim().property("ADBE Text Selectors").addProperty("ADBE Text Selector");
        var sel = function () { return anim().property("ADBE Text Selectors").property(1); };
        sel().property("ADBE Text Range Advanced").property("ADBE Text Range Type2").setValue(basedOn);
        sel().property("ADBE Text Range Advanced").property("ADBE Text Range Shape").setValue(shape);
        if (lib.has(args.ease)) {
            sel().property("ADBE Text Range Advanced").property("ADBE Text Levels Max Ease").setValue(Number(args.ease.high || 0));
            sel().property("ADBE Text Range Advanced").property("ADBE Text Levels Min Ease").setValue(Number(args.ease.low || 0));
        }
        var t0 = (start === null ? l.inPoint : start) + i * stagger * fd, t1 = t0 + duration;
        var sp, from, to;
        if (shape === 1) {
            sp = sel().property("ADBE Text Percent Start");
            from = 0; to = 100;
        } else {
            sel().property("ADBE Text Percent Start").setValue(0);
            sel().property("ADBE Text Percent End").setValue(waveWidth);
            sp = sel().property("ADBE Text Percent Offset");
            from = -waveWidth; to = 100;
        }
        sp.setValueAtTime(t0, mode === "out" ? to : from);
        sp.setValueAtTime(t1, mode === "out" ? from : to);
        lib.applyEase(sp, 1, { easeOut: { speed: 0, influence: influence } });
        lib.applyEase(sp, 2, { easeIn: { speed: 0, influence: influence } });
        out.push({ layer: l.name, animator: anim().name, start: t0, end: t1 });
    }
    return { mode: mode, basedOn: basedOnName, shape: shapeName, influence: influence, duration: duration, offsets: offsets, layers: out };
})()`,

  renderPreview: String.raw`(function () {
    var c = lib.comp(args.comp), rq = app.project.renderQueue, i, disabled = [];
    for (i = 1; i <= rq.numItems; i++) {
        var it = rq.item(i);
        if (it.status === RQItemStatus.QUEUED) { it.render = false; disabled.push(i); }
    }
    var item = rq.items.add(c), om, template = null, names, wanted = args.format === "png" ? /PNG Sequence/i : /H\.264/i;
    try {
        if (lib.has(args.start)) item.timeSpanStart = Number(args.start);
        if (lib.has(args.duration)) item.timeSpanDuration = Number(args.duration);
        if (args.half) { try { item.setSetting("Resolution", "Half"); } catch (e0) {} }
        om = item.outputModule(1);
        names = om.templates;
        for (i = 0; i < names.length; i++) if (wanted.test(names[i]) && names[i].indexOf("_HIDDEN") !== 0) { template = names[i]; break; }
        if (!template) throw new Error("No output module template matching " + wanted + ". Available: " + names.join(", "));
        om.applyTemplate(template);
        mcp.ensureFolder(new File(args.path).parent.fsName);
        om.file = new File(args.path);
        rq.render();
        var status = item.status, file = om.file.fsName;
        return { file: file, template: template, status: status === RQItemStatus.DONE ? "done" : String(status),
            start: item.timeSpanStart, duration: item.timeSpanDuration };
    } finally {
        try { item.remove(); } catch (e1) {}
        for (i = 0; i < disabled.length; i++) { try { rq.item(disabled[i]).render = true; } catch (e2) {} }
    }
})()`,

  centerLayers: String.raw`(function () {
    var c = lib.comp(args.comp), list = lib.layers(c, args.layers, args.all), axis = args.axis || "both";
    var moveAnchor = args.anchor !== false, out = [];
    for (var i = 0; i < list.length; i++) {
        var l = list[i];
        if (l instanceof CameraLayer || l instanceof LightLayer) { out.push({ index: l.index, name: l.name, skipped: "camera or light" }); continue; }
        var tr = l.property("ADBE Transform Group"), ap = tr.property("ADBE Anchor Point"), pos = tr.property("ADBE Position");
        if (pos.dimensionsSeparated) { out.push({ index: l.index, name: l.name, skipped: "position dimensions are separated" }); continue; }
        var note = null;
        if (moveAnchor) {
            if (ap.numKeys > 0) note = "anchor point has keyframes, not moved";
            else {
                var r = l.sourceRectAtTime(c.time, false), a = ap.value, na = [r.left + r.width / 2, r.top + r.height / 2];
                if (a.length > 2) na.push(a[2]);
                ap.setValue(na);
            }
        }
        var p = pos.value;
        var np = [axis === "vertical" ? p[0] : c.width / 2, axis === "horizontal" ? p[1] : c.height / 2];
        if (p.length > 2) np.push(p[2]);
        if (pos.numKeys > 0) pos.setValueAtTime(c.time, np); else pos.setValue(np);
        var item = { index: l.index, name: l.name, position: np, anchorPoint: ap.value };
        if (l.parent) item.warning = "layer is parented: position is in parent space";
        if (note) item.note = note;
        out.push(item);
    }
    return { comp: c.name, center: [c.width / 2, c.height / 2], layers: out };
})()`,

  layerTiming: String.raw`(function () {
    var c = lib.comp(args.comp), l = lib.layer(c, args.layer), fd = c.frameDuration;
    function f(t) { return Math.round(t / fd); }
    return {
        comp: c.name, frameRate: c.frameRate, frameDuration: fd, layer: l.name, index: l.index,
        source: l.source ? l.source.name : null, stretch: l.stretch,
        startTime: l.startTime, startFrame: f(l.startTime),
        inPoint: l.inPoint, inFrame: f(l.inPoint),
        outPoint: l.outPoint, outFrame: f(l.outPoint),
        duration: l.outPoint - l.inPoint, durationFrames: f(l.outPoint - l.inPoint),
        sourceIn: l.inPoint - l.startTime, sourceOut: l.outPoint - l.startTime
    };
})()`,

  setProperty: String.raw`(function () {
    var c = lib.comp(args.comp), l = lib.layer(c, args.layer), p = lib.prop(l, args.property);
    var before = lib.readValue(p);
    lib.setValue(p, args.value, args.time);
    return { layer: l.name, property: p.name, matchName: p.matchName, previous: before,
        value: lib.has(args.time) ? p.valueAtTime(Number(args.time), false) : lib.readValue(p), numKeys: p.numKeys };
})()`,

  setKeyframes: String.raw`(function () {
    var c = lib.comp(args.comp), l = lib.layer(c, args.layer), p = lib.prop(l, args.property), keys = args.keys, i, key, k;
    if (!p.canVaryOverTime) throw new Error("'" + p.name + "' cannot be keyframed");
    if (!lib.isArr(keys) || !keys.length) throw new Error("keys must be a non-empty array of { time, value, ease? }");
    if (args.replace) while (p.numKeys > 0) p.removeKey(1);
    for (i = 0; i < keys.length; i++) {
        key = keys[i];
        if (!lib.has(key.time)) throw new Error("keys[" + i + "].time is required");
        if (lib.has(key.value)) p.setValueAtTime(Number(key.time), lib.toValue(p, key.value));
    }
    var done = [];
    for (i = 0; i < keys.length; i++) {
        key = keys[i];
        k = lib.keyAt(p, Number(key.time), c.frameDuration);
        if (!k) throw new Error("No keyframe at " + key.time + "s: keys[" + i + "] needs a value");
        if (!lib.has(key.ease) && lib.has(args.ease)) key.ease = args.ease;
        if (!lib.has(key.influence) && lib.has(args.influence)) key.influence = args.influence;
        lib.applyEase(p, k, key);
        done.push({ index: k, time: p.keyTime(k), value: p.keyValue(k) });
    }
    return { layer: l.name, property: p.name, matchName: p.matchName, numKeys: p.numKeys, keys: done };
})()`,

  setExpression: String.raw`(function () {
    var c = lib.comp(args.comp), l = lib.layer(c, args.layer), p = lib.prop(l, args.property);
    if (!p.canSetExpression) throw new Error("'" + p.name + "' does not support expressions");
    p.expression = lib.has(args.expression) ? String(args.expression) : "";
    var result = { layer: l.name, property: p.name, expression: p.expression, enabled: p.expressionEnabled };
    if (p.expression !== "") {
        try { p.valueAtTime(c.time, false); } catch (e) {}
        if (p.expressionError) result.expressionError = p.expressionError;
    }
    return result;
})()`,

  listAvailableEffects: String.raw`(function () {
    var q = lib.has(args.query) ? String(args.query).toLowerCase() : "", max = lib.has(args.max) ? Number(args.max) : 200;
    var all = app.effects, out = [], total = all.length, e, hay;
    for (var i = 0; i < total; i++) {
        e = all[i];
        if (!args.includeObsolete && e.category === "Obsolete") continue;
        hay = (e.displayName + " " + e.matchName + " " + e.category).toLowerCase();
        if (q && hay.indexOf(q) === -1) continue;
        out.push({ name: e.displayName, matchName: e.matchName, category: e.category });
        if (out.length >= max) break;
    }
    return { installed: total, returned: out.length, effects: out };
})()`,

  applyEffect: String.raw`(function () {
    var c = lib.comp(args.comp), l = lib.layer(c, args.layer), parade = l.property("ADBE Effect Parade");
    if (!parade) throw new Error("Layer '" + l.name + "' cannot have effects");
    if (!lib.has(args.effect)) throw new Error("effect is required: display name or matchName");
    var id = lib.effectId(args.effect);
    if (!parade.canAddProperty(id)) throw new Error("Effect '" + args.effect + "' is not installed or cannot be applied to this layer. Use ae_list_available_effects.");
    var fx = parade.addProperty(id), index = fx.propertyIndex;
    if (lib.has(args.name)) fx.name = String(args.name);
    var applied = [], failed = [];
    if (args.settings) {
        for (var key in args.settings) {
            if (!args.settings.hasOwnProperty(key)) continue;
            try {
                fx = parade.property(index);
                var p = lib.propIn(fx, key);
                lib.setValue(p, args.settings[key]);
                applied.push(p.name);
            } catch (e) { failed.push({ property: key, error: e.toString() }); }
        }
    }
    fx = parade.property(index);
    return { layer: l.name, effect: { index: fx.propertyIndex, name: fx.name, matchName: fx.matchName },
        settingsApplied: applied, settingsFailed: failed, properties: lib.tree(fx, 1, true).children };
})()`,

  listLayerEffects: String.raw`(function () {
    var c = lib.comp(args.comp), l = lib.layer(c, args.layer), parade = l.property("ADBE Effect Parade"), out = [];
    var depth = lib.has(args.depth) ? Number(args.depth) : 2, withValues = args.values !== false;
    if (parade) for (var i = 1; i <= parade.numProperties; i++) out.push(lib.tree(parade.property(i), depth, withValues));
    return { layer: l.name, count: out.length, effects: out };
})()`,

  removeEffects: String.raw`(function () {
    var c = lib.comp(args.comp), l = lib.layer(c, args.layer), parade = l.property("ADBE Effect Parade"), removed = [], fx;
    if (!parade || !parade.numProperties) return { layer: l.name, removed: [] };
    if (args.all) {
        for (var i = parade.numProperties; i >= 1; i--) { fx = parade.property(i); removed.push(fx.name); fx.remove(); }
    } else {
        if (!lib.has(args.effect)) throw new Error("Pass effect (name, matchName or index) or all: true");
        var refs = lib.isArr(args.effect) ? args.effect : [args.effect];
        for (var j = 0; j < refs.length; j++) { fx = lib.findEffect(l, refs[j]); removed.push(fx.name); fx.remove(); }
    }
    return { layer: l.name, removed: removed };
})()`,

  applyPreset: String.raw`(function () {
    var c = lib.comp(args.comp), l = lib.layer(c, args.layer), file = new File(args.path);
    if (!file.exists) throw new Error("Preset not found: " + args.path);
    var parade = l.property("ADBE Effect Parade"), before = parade ? parade.numProperties : 0;
    l.applyPreset(file);
    var added = [];
    parade = l.property("ADBE Effect Parade");
    if (parade) for (var i = before + 1; i <= parade.numProperties; i++) added.push({ index: i, name: parade.property(i).name, matchName: parade.property(i).matchName });
    return { layer: l.name, preset: file.fsName, effectsAdded: added };
})()`,

  addMarkers: String.raw`(function () {
    var c = lib.comp(args.comp), l = null, target, list = args.markers, added = 0, errors = [];
    if (lib.has(args.layer)) { l = lib.layer(c, args.layer); target = l.property("ADBE Marker"); }
    else target = c.markerProperty;
    if (!lib.isArr(list) || !list.length) throw new Error("markers must be a non-empty array of { time, comment?, duration?, label? }");
    for (var i = 0; i < list.length; i++) {
        var m = list[i];
        try {
            if (!lib.has(m.time)) throw new Error("time is required");
            var mv = new MarkerValue(lib.has(m.comment) ? String(m.comment) : "");
            if (lib.has(m.duration)) mv.duration = Number(m.duration);
            if (lib.has(m.chapter)) mv.chapter = String(m.chapter);
            if (lib.has(m.url)) mv.url = String(m.url);
            if (lib.has(m.label)) mv.label = Number(m.label);
            target.setValueAtTime(Number(m.time), mv);
            added++;
        } catch (e) { errors.push({ index: i, error: e.toString() }); }
    }
    return { target: l ? "layer" : "comp", comp: c.name, layer: l ? l.name : null, added: added, errors: errors, totalMarkers: target.numKeys };
})()`,

  audioInfo: String.raw`(function () {
    var c = lib.comp(args.comp), l = lib.layer(c, args.layer), src = l.source, info;
    info = { comp: c.name, layer: l.name, index: l.index, hasAudio: !!l.hasAudio, audioEnabled: !!l.audioEnabled,
        startTime: l.startTime, inPoint: l.inPoint, outPoint: l.outPoint, stretch: l.stretch, source: null, levels: null, markers: [] };
    if (src) {
        info.source = { name: src.name, hasAudio: !!src.hasAudio, duration: src.duration, file: null };
        try { if (src.file) info.source.file = src.file.fsName; } catch (e0) {}
    }
    var levels = l.property("ADBE Audio Group");
    levels = levels ? levels.property("ADBE Audio Levels") : null;
    if (levels) {
        info.levels = { value: levels.value, keys: [] };
        for (var k = 1; k <= levels.numKeys; k++) info.levels.keys.push({ time: levels.keyTime(k), value: levels.keyValue(k) });
    }
    var mp = l.property("ADBE Marker");
    for (var m = 1; mp && m <= mp.numKeys; m++) info.markers.push({ time: mp.keyTime(m), comment: mp.keyValue(m).comment });
    return info;
})()`,

  setAudioLevels: String.raw`(function () {
    var c = lib.comp(args.comp), l = lib.layer(c, args.layer), g = l.property("ADBE Audio Group");
    var p = g ? g.property("ADBE Audio Levels") : null;
    if (!p) throw new Error("Layer '" + l.name + "' has no audio");
    function pair(spec) {
        var left = lib.has(spec.left) ? Number(spec.left) : (lib.has(spec.level) ? Number(spec.level) : null);
        var right = lib.has(spec.right) ? Number(spec.right) : (lib.has(spec.level) ? Number(spec.level) : null);
        if (left === null && right === null) throw new Error("Pass level, or left/right, in dB");
        return [left === null ? right : left, right === null ? left : right];
    }
    if (lib.isArr(args.keys)) {
        for (var i = 0; i < args.keys.length; i++) p.setValueAtTime(Number(args.keys[i].time), pair(args.keys[i]));
    } else if (lib.has(args.time)) {
        p.setValueAtTime(Number(args.time), pair(args));
    } else {
        if (p.numKeys > 0) throw new Error("Audio Levels has keyframes: pass time or keys");
        p.setValue(pair(args));
    }
    return { layer: l.name, value: p.value, numKeys: p.numKeys };
})()`
};

// Prepended to every template and to ae_run_jsx code.
export function withLib(code) {
  return `${LIB} ${code}`;
}
