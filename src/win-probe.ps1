# AE MCP Bridge - Windows probe for After Effects (started once by mcp-server.mjs, kept running).
# Reads one request per stdin line and answers one JSON line on stdout:
#   "probe" -> {"running":bool,"pid":n,"exe":"...","startTime":ms,"modal":bool,"dialogs":["title",...]}
# "modal" is true when AE's main window is disabled, i.e. a modal dialog is waiting for the user:
# a script sent to AE at that moment is rejected.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class AeMcpWin {
    delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
    // Returns { disabledMainWindows, ownedWindowTitles } for the visible top-level windows of a process.
    public static string[] Inspect(uint target, out int disabledMain) {
        var titles = new List<string>();
        int disabled = 0;
        EnumWindows(delegate (IntPtr h, IntPtr l) {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pid != target || !IsWindowVisible(h)) return true;
            bool owned = GetWindow(h, 4) != IntPtr.Zero; // GW_OWNER
            if (!owned && !IsWindowEnabled(h)) disabled++;
            if (owned) { var sb = new StringBuilder(256); GetWindowText(h, sb, 256); titles.Add(sb.ToString()); }
            return true;
        }, IntPtr.Zero);
        disabledMain = disabled;
        return titles.ToArray();
    }
}
'@

function Probe {
    $p = Get-Process -Name AfterFX -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1
    if (-not $p) { return @{ running = $false } }
    $disabled = 0
    $titles = [AeMcpWin]::Inspect([uint32]$p.Id, [ref]$disabled)
    $start = [int64](($p.StartTime.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds)
    return @{ running = $true; pid = $p.Id; exe = $p.Path; startTime = $start; modal = ($disabled -gt 0); dialogs = @($titles | Where-Object { $_ }) }
}

[Console]::Out.WriteLine('{"ready":true}')
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    try { $out = Probe | ConvertTo-Json -Compress -Depth 3 }
    catch { $out = @{ error = $_.Exception.Message } | ConvertTo-Json -Compress }
    [Console]::Out.WriteLine($out)
}
