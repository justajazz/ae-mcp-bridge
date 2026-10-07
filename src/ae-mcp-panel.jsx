// AE MCP Bridge panel v0.2.0 - runs inside Adobe After Effects (ExtendScript, ES3).
//
// Inspired by "After Effects MCP by Ruslan Tsapenko" v0.1.0
//   YouTube: https://www.youtube.com/@RuslanTsapenko  Site: https://tsapenko.com/
// Ideas and tools ported from TheLlamainator/after-effects-mcp (MIT, (c) 2025 Dakkshin).
// Made by Claude Code & Yuriy Martyniuk. MIT License, see LICENSE.
//
// Protocol (file IPC in the bridge folder, see mcp-server.mjs):
//   command.json        <- server: { commandId, tool, code, args, undo, undoName, createdAt, pickupDeadline }
//   ack.json            -> panel:  { commandId, tool, startedAt } while the command executes
//   results/<id>.json   -> panel:  { commandId, ok, data | error, ... }
//   panel-status.json   -> panel:  heartbeat, versions, current project
// Code and data travel separately: `code` is evaluated with `args` and `mcp` in scope,
// user data is never concatenated into code.

// Evaluates bridge code in a minimal scope: only `args`, `mcp` and globals are visible,
// so user code cannot clobber the panel's private state.
function aeMcpEvaluate(__aeMcpCode, args, mcp) {
    return eval(__aeMcpCode);
}

// @@serializer-begin
// JSON encoder safe for After Effects objects: depth limit, cycle detection,
// AE host objects collapsed to short summaries, non-ASCII escaped as \uXXXX.
var aeMcpSerializer = (function () {
    var MAX_DEPTH = 40;
    var MAX_ITEMS = 1000;
    var MAX_STRING = 100000;
    var ITEM_TYPES = { CompItem: 1, FootageItem: 1, FolderItem: 1, AVItem: 1, Item: 1 };
    var LAYER_TYPES = { AVLayer: 1, TextLayer: 1, ShapeLayer: 1, CameraLayer: 1, LightLayer: 1, ThreeDModelLayer: 1, Layer: 1 };
    var PROPERTY_TYPES = { Property: 1, PropertyGroup: 1, MaskPropertyGroup: 1, PropertyBase: 1 };
    var VALUE_TYPES = {
        TextDocument: ["text", "font", "fontSize", "fillColor", "strokeColor", "applyFill", "applyStroke", "justification", "tracking", "leading", "boxText"],
        MarkerValue: ["comment", "duration", "chapter", "url", "label", "protectedRegion"],
        Shape: ["vertices", "inTangents", "outTangents", "closed"],
        KeyframeEase: ["speed", "influence"]
    };

    function hex4(code) {
        var h = code.toString(16);
        while (h.length < 4) h = "0" + h;
        return h;
    }

    function quote(text) {
        text = String(text);
        if (text.length > MAX_STRING) text = text.substring(0, MAX_STRING) + "...[truncated " + (text.length - MAX_STRING) + " chars]";
        return '"' + text.replace(/[\\"\u0000-\u001f\u007f-\uffff]/g, function (ch) {
            if (ch === '"') return '\\"';
            if (ch === "\\") return "\\\\";
            if (ch === "\n") return "\\n";
            if (ch === "\r") return "\\r";
            if (ch === "\t") return "\\t";
            return "\\u" + hex4(ch.charCodeAt(0));
        }) + '"';
    }

    function isArray(value) {
        return Object.prototype.toString.call(value) === "[object Array]";
    }

    function className(value) {
        try { if (value.reflect && value.reflect.name) return String(value.reflect.name); } catch (e) {}
        try { if (value.constructor && value.constructor.name) return String(value.constructor.name); } catch (e2) {}
        return "Object";
    }

    // Primitive, or an array (up to 2 levels deep) of primitives.
    function isPlainValue(value, level) {
        if (value === null) return true;
        var t = typeof value;
        if (t === "string" || t === "number" || t === "boolean") return true;
        if (!isArray(value) || value.length > MAX_ITEMS || (level || 0) >= 2) return false;
        for (var i = 0; i < value.length; i++) if (!isPlainValue(value[i], (level || 0) + 1)) return false;
        return true;
    }

    function pick(target, source, keys) {
        for (var i = 0; i < keys.length; i++) {
            try {
                var v = source[keys[i]];
                if (v !== undefined && isPlainValue(v, 0)) target[keys[i]] = v;
            } catch (e) {}
        }
        return target;
    }

    function summarize(value, type) {
        var s = { _type: type };
        if (ITEM_TYPES[type]) return pick(s, value, ["id", "name", "typeName"]);
        if (LAYER_TYPES[type]) {
            pick(s, value, ["index", "name", "matchName"]);
            try { s.comp = value.containingComp.name; } catch (e) {}
            return s;
        }
        if (PROPERTY_TYPES[type]) {
            pick(s, value, ["name", "matchName", "propertyIndex", "numKeys", "numProperties", "expression"]);
            if (type === "Property") {
                try { var pv = value.value; if (isPlainValue(pv, 0)) s.value = pv; } catch (e2) {}
            }
            return s;
        }
        if (VALUE_TYPES[type]) return pick(s, value, VALUE_TYPES[type]);
        if (type === "Project") {
            try { s.file = value.file ? value.file.fsName : null; } catch (e3) {}
            return pick(s, value, ["numItems"]);
        }
        if (type === "File" || type === "Folder") return pick(s, value, ["fsName", "exists"]);
        return pick(s, value, ["id", "name", "index", "message"]);
    }

    function hasOwnKeys(value) {
        try {
            for (var key in value) if (Object.prototype.hasOwnProperty.call(value, key)) return true;
        } catch (e) {}
        return false;
    }

    function encode(value, depth, stack) {
        if (value === null || value === undefined) return "null";
        var t = typeof value;
        if (t === "string") return quote(value);
        if (t === "number") return isFinite(value) ? String(value) : "null";
        if (t === "boolean") return value ? "true" : "false";
        if (t === "function") return "null";
        if (t !== "object") return quote(String(value));
        for (var s = 0; s < stack.length; s++) if (stack[s] === value) return quote("[Circular]");

        var type = isArray(value) ? "Array" : className(value);
        if (type === "Date" || type === "RegExp") return quote(String(value));
        if (type === "Error") return encode(summarize(value, type), depth, stack);
        if (type !== "Array" && type !== "Object" &&
            (ITEM_TYPES[type] || LAYER_TYPES[type] || PROPERTY_TYPES[type] || VALUE_TYPES[type] || !hasOwnKeys(value))) {
            return encode(summarize(value, type), depth, stack);
        }
        if (depth >= MAX_DEPTH) return quote("[Max depth]");

        stack.push(value);
        try {
            var parts = [];
            if (type === "Array") {
                var n = Math.min(value.length, MAX_ITEMS);
                for (var i = 0; i < n; i++) parts.push(encode(value[i], depth + 1, stack));
                if (value.length > MAX_ITEMS) parts.push(quote("[" + (value.length - MAX_ITEMS) + " more items]"));
                return "[" + parts.join(",") + "]";
            }
            var count = 0;
            for (var key in value) {
                if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
                var item;
                try { item = value[key]; } catch (e) { continue; }
                if (item === undefined || typeof item === "function") continue;
                if (++count > MAX_ITEMS) { parts.push(quote("_truncated") + ":true"); break; }
                parts.push(quote(key) + ":" + encode(item, depth + 1, stack));
            }
            return "{" + parts.join(",") + "}";
        } finally {
            stack.pop();
        }
    }

    return {
        stringify: function (value) { return encode(value, 0, []); },
        summarize: function (value) {
            if (value === null || typeof value !== "object") return value;
            return summarize(value, isArray(value) ? "Array" : className(value));
        },
        quote: quote
    };
})();
// @@serializer-end

(function aeMcpPanel(thisObj) {
    var PANEL_VERSION = "0.2.0";
    var POLL_MS = 100;
    var HEARTBEAT_MS = 2000;
    var LOG_LINES = 50;

    var BRIDGE_DIR = resolveBridgeDir();
    var COMMAND_FILE = BRIDGE_DIR + "/command.json";
    var ACK_NAME = "ack.json";
    var STATUS_NAME = "panel-status.json";
    var RESULTS_DIR = BRIDGE_DIR + "/results";
    var FRAMES_DIR = BRIDGE_DIR + "/frames";

    var instanceId = "p" + (new Date().getTime()) + "_" + Math.floor(Math.random() * 1000000);
    var pollName = "aeMcpPoll_" + instanceId;
    var running = false;
    var busy = false;
    var pollTaskId = null;
    var lastCommandId = "";
    var lastHeartbeat = 0;

    // ---- paths and files -------------------------------------------------

    // Must match defaultBridgeDir() in mcp-server.mjs.
    function resolveBridgeDir() {
        var custom = null;
        try { custom = $.getenv("AE_MCP_BRIDGE_DIR"); } catch (e) {}
        if (custom) return new Folder(custom).fsName;
        if ($.os.indexOf("Windows") !== -1) return "C:/MCP/ae-bridge";
        return new Folder("~/Library/Application Support/ae-mcp-bridge").fsName;
    }

    function ensureFolder(folderPath) {
        var folder = new Folder(folderPath);
        if (folder.exists) return true;
        if (folder.parent && !folder.parent.exists) ensureFolder(folder.parent.fsName);
        if (!folder.create()) throw new Error("Cannot create folder " + folder.fsName + ": " + folder.error);
        return true;
    }

    function readText(filePath) {
        var file = new File(filePath);
        if (!file.exists) return null;
        file.encoding = "UTF-8";
        if (!file.open("r")) return null;
        try { return file.read(); } finally { file.close(); }
    }

    function parseJson(text) {
        text = String(text).replace(/^\uFEFF/, "");
        if (typeof JSON !== "undefined" && JSON.parse) return JSON.parse(text);
        return eval("(" + text + ")");
    }

    // Write to <name>.tmp, then rename over the target so readers never see partial JSON.
    function writeTextAtomic(dirPath, name, text) {
        var tmp = new File(dirPath + "/" + name + ".tmp");
        var target = new File(dirPath + "/" + name);
        tmp.encoding = "UTF-8";
        if (!tmp.open("w")) throw new Error("Cannot write " + tmp.fsName + ": " + tmp.error);
        try {
            if (!tmp.write(text)) throw new Error("Cannot write " + tmp.fsName + ": " + tmp.error);
        } finally {
            tmp.close();
        }
        for (var attempt = 0; attempt < 20; attempt++) {
            if (target.exists) target.remove();
            if (tmp.rename(name)) return;
            $.sleep(10);
        }
        throw new Error("Cannot replace " + target.fsName + ": " + tmp.error);
    }

    function removeFile(filePath) {
        var file = new File(filePath);
        if (file.exists) file.remove();
    }

    // ---- helpers visible to bridge code as `mcp` --------------------------

    function projectInfo() {
        if (!app.project) return null;
        var info = { path: null, name: null, numItems: app.project.numItems };
        if (app.project.file) {
            info.path = app.project.file.fsName;
            info.name = app.project.file.displayName;
        }
        try { if (typeof app.project.dirty === "boolean") info.dirty = app.project.dirty; } catch (e) {}
        return info;
    }

    function currentProjectPath() {
        try { return app.project && app.project.file ? app.project.file.fsName : null; } catch (e) { return null; }
    }

    function activeComp() {
        var item = app.project ? app.project.activeItem : null;
        if (!(item instanceof CompItem)) throw new Error("No active composition: open a composition or pass its name");
        return item;
    }

    function findComp(ref) {
        if (ref === undefined || ref === null || ref === "") return activeComp();
        if (!app.project) throw new Error("No project is open");
        if (typeof ref === "number") {
            var byId = app.project.itemByID(ref);
            if (byId instanceof CompItem) return byId;
            throw new Error("Composition not found by id: " + ref);
        }
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof CompItem && item.name === ref) return item;
        }
        throw new Error("Composition not found: " + ref);
    }

    function findLayer(comp, ref) {
        if (typeof ref === "number") {
            if (ref < 1 || ref > comp.numLayers) throw new Error("Layer index out of range 1.." + comp.numLayers + ": " + ref);
            return comp.layer(ref);
        }
        for (var i = 1; i <= comp.numLayers; i++) if (comp.layer(i).name === ref) return comp.layer(i);
        throw new Error("Layer not found in '" + comp.name + "': " + ref);
    }

    function layerType(layer) {
        if (layer instanceof TextLayer) return "text";
        if (layer instanceof ShapeLayer) return "shape";
        if (layer instanceof CameraLayer) return "camera";
        if (layer instanceof LightLayer) return "light";
        if (layer instanceof AVLayer) {
            if (layer.adjustmentLayer) return "adjustment";
            if (layer.nullLayer) return "null";
            var src = layer.source;
            if (src instanceof CompItem) return "precomp";
            if (src && src.mainSource instanceof SolidSource) return "solid";
            if (src && !src.hasVideo && src.hasAudio) return "audio";
            return "footage";
        }
        return "unknown";
    }

    var helpers = {
        version: PANEL_VERSION,
        bridgeDir: BRIDGE_DIR,
        framesDir: FRAMES_DIR,
        activeComp: activeComp,
        findComp: findComp,
        findLayer: findLayer,
        layerType: layerType,
        projectInfo: projectInfo,
        ensureFolder: ensureFolder,
        describe: aeMcpSerializer.summarize
    };

    // ---- protocol ----------------------------------------------------------

    function writeStatus() {
        lastHeartbeat = new Date().getTime();
        writeTextAtomic(BRIDGE_DIR, STATUS_NAME, aeMcpSerializer.stringify({
            running: running,
            busy: busy,
            panelVersion: PANEL_VERSION,
            app: app.name,
            appVersion: app.version,
            heartbeat: lastHeartbeat,
            instanceId: instanceId,
            lastCommandId: lastCommandId,
            projectPath: currentProjectPath(),
            bridgeDir: BRIDGE_DIR
        }));
    }

    function writeResult(envelope) {
        envelope.panelVersion = PANEL_VERSION;
        envelope.finishedAt = new Date().getTime();
        envelope.project = currentProjectPath();
        var text;
        try {
            text = aeMcpSerializer.stringify(envelope);
        } catch (e) {
            text = aeMcpSerializer.stringify({ commandId: envelope.commandId, ok: false, panelVersion: PANEL_VERSION, error: "Cannot serialize result: " + e.toString() });
        }
        writeTextAtomic(RESULTS_DIR, envelope.commandId + ".json", text);
    }

    function execute(command) {
        var startedAt = new Date().getTime();
        writeTextAtomic(BRIDGE_DIR, ACK_NAME, aeMcpSerializer.stringify({ commandId: command.commandId, tool: command.tool, startedAt: startedAt }));
        busy = true;
        setStatus("Running " + command.tool + "...");
        var envelope = { commandId: command.commandId, tool: command.tool, startedAt: startedAt };
        var undoOpen = false;
        try {
            if (command.undo) {
                app.beginUndoGroup(command.undoName || ("MCP: " + command.tool));
                undoOpen = true;
            }
            envelope.data = aeMcpEvaluate(String(command.code), command.args || {}, helpers);
            envelope.ok = true;
        } catch (error) {
            envelope.ok = false;
            envelope.error = error.toString();
            if (error.line) envelope.errorLine = error.line;
        } finally {
            if (undoOpen) { try { app.endUndoGroup(); } catch (_) {} }
            busy = false;
        }
        // Order matters: drop the ack first, then publish the result.
        try { removeFile(BRIDGE_DIR + "/" + ACK_NAME); } catch (_) {}
        writeResult(envelope);
        var seconds = Math.round((new Date().getTime() - startedAt) / 100) / 10;
        addLog((envelope.ok ? "OK   " : "FAIL ") + command.tool + " (" + seconds + "s)" + (envelope.ok ? "" : ": " + envelope.error));
        setStatus("Running: " + BRIDGE_DIR);
    }

    function tick() {
        var now = new Date().getTime();
        if (now - lastHeartbeat >= HEARTBEAT_MS) writeStatus();

        var text = readText(COMMAND_FILE);
        if (!text) return;
        var command;
        try { command = parseJson(text); } catch (e) { return; }
        if (!command || !command.commandId || command.commandId === lastCommandId) return;
        lastCommandId = command.commandId;

        // Another panel instance (or an earlier run) already handled it.
        if (new File(RESULTS_DIR + "/" + command.commandId + ".json").exists) return;
        var ack = readText(BRIDGE_DIR + "/" + ACK_NAME);
        if (ack && ack.indexOf(command.commandId) !== -1) return;

        if (!command.pickupDeadline || now > command.pickupDeadline) {
            writeResult({ commandId: command.commandId, tool: command.tool, ok: false, expired: true,
                error: "Command expired before the panel picked it up; it was not executed." });
            addLog("SKIP " + command.tool + " (expired)");
            return;
        }
        execute(command);
        writeStatus();
    }

    function poll() {
        pollTaskId = null;
        if (!running) return;
        if ($.global.aeMcpActiveInstance !== instanceId) {
            stopBridge("Stopped: another AE MCP panel took over");
            return;
        }
        if (!busy) {
            try { tick(); } catch (error) {
                setStatus("Bridge error: " + error.toString());
                addLog("ERR  " + error.toString());
            }
        }
        if (running) pollTaskId = app.scheduleTask("$.global['" + pollName + "']()", POLL_MS, false);
    }
    $.global[pollName] = poll;

    function startBridge() {
        try {
            ensureFolder(BRIDGE_DIR);
            ensureFolder(RESULTS_DIR);
            ensureFolder(FRAMES_DIR);
            removeFile(BRIDGE_DIR + "/" + ACK_NAME);
            running = true;
            $.global.aeMcpActiveInstance = instanceId;
            writeStatus();
        } catch (error) {
            running = false;
            setStatus("Start failed: " + error.toString());
            addLog("ERR  start: " + error.toString());
            return;
        }
        button.text = "Stop bridge";
        setStatus("Running: " + BRIDGE_DIR);
        addLog("Started v" + PANEL_VERSION + " in " + BRIDGE_DIR);
        poll();
    }

    function stopBridge(message) {
        if (pollTaskId !== null) { try { app.cancelTask(pollTaskId); } catch (_) {} pollTaskId = null; }
        var wasRunning = running;
        running = false;
        if (wasRunning && $.global.aeMcpActiveInstance === instanceId) {
            try { writeStatus(); } catch (_) {}
        }
        button.text = "Start bridge";
        setStatus(message || "Stopped");
        if (wasRunning) addLog(message || "Stopped");
    }

    // ---- UI ------------------------------------------------------------------

    var panel = (thisObj instanceof Panel) ? thisObj : new Window("palette", "AE MCP Bridge", undefined, { resizeable: true });
    panel.orientation = "column";
    panel.alignChildren = ["fill", "top"];
    var status = panel.add("statictext", undefined, "Stopped");
    status.characters = 42;
    var button = panel.add("button", undefined, "Start bridge");
    var autoStart = panel.add("checkbox", undefined, "Start automatically when this panel opens");
    autoStart.value = readSetting("autostart") === "1";
    autoStart.onClick = function () { writeSetting("autostart", autoStart.value ? "1" : "0"); };
    var logList = panel.add("listbox", undefined, []);
    logList.preferredSize = [320, 140];
    panel.add("statictext", undefined, "AE MCP Bridge v" + PANEL_VERSION + " \u00B7 inspired by Ruslan Tsapenko's MCP");

    function readSetting(key) {
        try { return app.settings.haveSetting("AE MCP Bridge", key) ? app.settings.getSetting("AE MCP Bridge", key) : ""; } catch (e) { return ""; }
    }

    function writeSetting(key, value) {
        try { app.settings.saveSetting("AE MCP Bridge", key, value); } catch (e) {}
    }

    function setStatus(text) {
        try { status.text = text; } catch (_) {}
    }

    function addLog(text) {
        try {
            var d = new Date();
            var hh = (d.getHours() < 10 ? "0" : "") + d.getHours();
            var mm = (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
            var ss = (d.getSeconds() < 10 ? "0" : "") + d.getSeconds();
            logList.add("item", hh + ":" + mm + ":" + ss + "  " + text, 0);
            while (logList.items.length > LOG_LINES) logList.remove(logList.items.length - 1);
        } catch (_) {}
    }

    button.onClick = function () {
        if (running) stopBridge(); else startBridge();
    };
    panel.onResizing = panel.onResize = function () { this.layout.resize(); };
    if (panel instanceof Window) panel.onClose = function () { stopBridge(); };

    panel.layout.layout(true);
    if (panel instanceof Window) { panel.center(); panel.show(); }
    if (autoStart.value) startBridge();
})($.global.aeMcpPanelHost || this);
