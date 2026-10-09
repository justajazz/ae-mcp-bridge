// AE MCP Bridge panel v0.3.0 - optional status/log panel for Adobe After Effects (ExtendScript, ES3).
//
// Inspired by "After Effects MCP by Ruslan Tsapenko" v0.1.0
//   YouTube: https://www.youtube.com/@RuslanTsapenko  Site: https://tsapenko.com/
// Ideas and tools ported from TheLlamainator/after-effects-mcp (MIT, (c) 2025 Dakkshin).
// Made by Claude Code & Yuriy Martyniuk. MIT License, see LICENSE.
//
// Since 0.3.0 the bridge needs no panel: the server runs <bridge>/runner.jsx in After Effects for
// every command (AfterFX.exe -s). This panel only shows what the runner did. It never polls and never
// schedules tasks (app.scheduleTask breaks in AE 2026 as soon as a modal dialog opens); the runner
// pushes log lines to it through $.global.aeMcpPanelNotify, and "Refresh" reads runner-status.json.

(function aeMcpPanel(thisObj) {
    var PANEL_VERSION = "0.3.0";
    var LOG_LINES = 50;
    var BRIDGE_DIR = resolveBridgeDir();

    // Must match defaultBridgeDir() in mcp-server.mjs.
    function resolveBridgeDir() {
        var custom = null;
        try { custom = $.getenv("AE_MCP_BRIDGE_DIR"); } catch (e) {}
        if (custom) return new Folder(custom).fsName;
        if ($.os.indexOf("Windows") !== -1) return "C:/MCP/ae-bridge";
        return new Folder("~/Library/Application Support/ae-mcp-bridge").fsName;
    }

    function readStatus() {
        var file = new File(BRIDGE_DIR + "/runner-status.json");
        if (!file.exists) return null;
        file.encoding = "UTF-8";
        if (!file.open("r")) return null;
        var text;
        try { text = file.read(); } finally { file.close(); }
        text = String(text).replace(/^\uFEFF/, "");
        if (typeof JSON !== "undefined" && JSON.parse) return JSON.parse(text);
        return eval("(" + text + ")");
    }

    function two(n) { return (n < 10 ? "0" : "") + n; }

    function clock(time) {
        var d = time ? new Date(time) : new Date();
        return two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds());
    }

    // ---- UI ------------------------------------------------------------------

    var panel = (thisObj instanceof Panel) ? thisObj : new Window("palette", "AE MCP Bridge", undefined, { resizeable: true });
    panel.orientation = "column";
    panel.alignChildren = ["fill", "top"];
    var status = panel.add("statictext", undefined, "");
    status.characters = 42;
    var refresh = panel.add("button", undefined, "Refresh");
    var logList = panel.add("listbox", undefined, []);
    logList.preferredSize = [320, 140];
    panel.add("statictext", undefined, "AE MCP Bridge v" + PANEL_VERSION + " \u00B7 inspired by Ruslan Tsapenko's MCP");

    // UI calls are guarded: the panel may already be closed, and an uncaught "Object is invalid"
    // would pop up a modal error dialog in AE.
    function setStatus(text) {
        try { status.text = text; } catch (_) {}
    }

    function addLog(text) {
        try {
            logList.add("item", clock() + "  " + text, 0);
            while (logList.items.length > LOG_LINES) logList.remove(logList.items.length - 1);
        } catch (_) {}
    }

    function showStatus() {
        try {
            var s = readStatus();
            if (!s) { setStatus("No commands yet. Bridge folder: " + BRIDGE_DIR); return; }
            setStatus("Last command " + clock(s.lastRunAt) + " \u00B7 runner v" + s.runnerVersion + " \u00B7 " + BRIDGE_DIR);
        } catch (e) {
            setStatus("Cannot read status: " + e.toString());
        }
    }

    $.global.aeMcpPanelNotify = function (text) {
        addLog(text);
        setStatus("Last command " + clock() + " \u00B7 " + BRIDGE_DIR);
    };

    refresh.onClick = showStatus;
    panel.onResizing = panel.onResize = function () { this.layout.resize(); };
    if (panel instanceof Window) panel.onClose = function () { $.global.aeMcpPanelNotify = undefined; };

    showStatus();
    panel.layout.layout(true);
    if (panel instanceof Window) { panel.center(); panel.show(); }
})($.global.aeMcpPanelHost || this);
