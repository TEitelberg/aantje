"use strict";
// Shows the Oog start page as an editor tab once code-server has finished loading.
//
// The page is served by entrypoint.sh on 127.0.0.1:8081 inside the container. The extension fetches
// index.html, tools.json and features.json from there and renders them in a webview panel (data embedded
// as window.OOG_DATA). A webview and not the Simple Browser, on purpose: the Simple Browser shows its page
// in an iframe whose sandbox lacks allow-popups, so links with target=_blank do nothing there (browser
// console: "Blocked opening ... in a new window because the request was made in a sandboxed frame").
// In a webview, VS Code opens clicked links itself, in a new browser tab.
const crypto = require("crypto");
const vscode = require("vscode");

const BASE_URL = "http://127.0.0.1:8081/";
const VIEW_TYPE = "oog.startPage";

let panel;

async function fetchText(name, optional) {
    try {
        const response = await fetch(BASE_URL + name, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) {
            throw new Error(`${name}: HTTP ${response.status}`);
        }
        return await response.text();
    } catch (error) {
        if (optional) {
            return null;
        }
        throw error;
    }
}

// The webview cannot load files from the page server (no base URL, strict CSP), so the logos named by
// "logo" in tools.json are fetched here and handed to the page as data URIs ("logoData").
const LOGO_TYPES = { svg: "image/svg+xml", png: "image/png" };
const MAX_LOGO_BYTES = 131072;

async function logoDataUri(path) {
    const match = typeof path === "string" ? /^[\w.\/-]+\.(svg|png)$/.exec(path) : null;
    if (!match || path.charAt(0) === "/" || path.indexOf("..") >= 0) {
        return null;
    }
    // Two attempts: the simple page server closes connections after each response, which can make a
    // request fail when several are in flight.
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const response = await fetch(BASE_URL + path, { signal: AbortSignal.timeout(5000) });
            if (!response.ok) {
                return null;
            }
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) {
                return null;
            }
            return `data:${LOGO_TYPES[match[1]]};base64,${bytes.toString("base64")}`;
        } catch (error) {
            // try again once
        }
    }
    return null;
}

// Escaped so that the JSON can never end the script element it is embedded in.
const BS = String.fromCharCode(92);
function inlineJson(text) {
    return text.split("<").join(BS + "u003c").split(String.fromCharCode(0x2028)).join(BS + "u2028").split(String.fromCharCode(0x2029)).join(BS + "u2029");
}

// Links are opened by the extension, not by the webview itself. code-server rewrites every opened
// http://localhost:<port> URL (regex without the i flag) to its own path proxy /proxy/<port>/, i.e. to a
// port inside this container, while the tiles mean the ports the host publishes (Gitea, RustFS, ...).
// The webview normalizes the host to lower case before it reports a click, so it cannot keep the
// address intact; this extension upper-cases the host name instead (the browser treats host names
// case-insensitively and opens http://localhost:3000/ as usual, but the rewrite no longer matches).
const LOCAL_URL = /^(https?:\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+.*)$/;

function hostLink(url) {
    const match = LOCAL_URL.exec(url);
    return vscode.Uri.parse(match ? match[1] + match[2].toUpperCase() + match[3] : url);
}

// URLs the page may ask for: only the ones listed in tools.json.
let allowedUrls = new Set();

async function render() {
    const [index, tools, features] = await Promise.all([
        fetchText("index.html"),
        fetchText("tools.json"),
        fetchText("features.json", true),
    ]);
    const config = JSON.parse(tools);
    // One after the other (the logos are small): keeps the load on the page server low.
    for (const tool of config.tools || []) {
        const uri = await logoDataUri(tool.logo);
        if (uri) {
            tool.logoData = uri;
        }
    }
    allowedUrls = new Set((config.tools || []).map((tool) => tool.url).filter((url) => typeof url === "string"));
    const nonce = crypto.randomBytes(16).toString("base64");
    const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';`;
    const data = `<script nonce="${nonce}">window.OOG_DATA = {tools: ${inlineJson(JSON.stringify(config))}, features: ${inlineJson(JSON.stringify(features ? JSON.parse(features) : {}))}};</script>`;
    return index
        // Replacer functions: the data may contain "$" sequences that String.replace would interpret.
        .replace("<head>", () => `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`)
        .replace("<script>", () => `${data}\n<script nonce="${nonce}">`);
}

async function fill(target) {
    try {
        target.webview.html = await render();
    } catch (error) {
        const message = String(error && error.message ? error.message : error).replace(/[&<>]/g, "");
        target.webview.html = `<!doctype html><meta charset="utf-8"><body><h3>Oog</h3><p>The start page is not reachable (${message}).</p>`;
    }
}

function attach(target) {
    panel = target;
    target.webview.options = { enableScripts: true };
    target.webview.onDidReceiveMessage((message) => {
        if (message && message.command === "open" && allowedUrls.has(message.url)) {
            vscode.env.openExternal(hostLink(message.url));
        }
    });
    target.onDidDispose(() => {
        if (panel === target) {
            panel = undefined;
        }
    });
}

async function openStartPage() {
    if (panel) {
        panel.reveal(undefined, false);
        await fill(panel);
        return;
    }
    const created = vscode.window.createWebviewPanel(
        VIEW_TYPE,
        "Oog",
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
        { enableScripts: true }
    );
    attach(created);
    await fill(created);
}

function startPageTabOpen() {
    return vscode.window.tabGroups.all.some((group) =>
        group.tabs.some(
            (tab) => tab.input instanceof vscode.TabInputWebview && String(tab.input.viewType).endsWith(VIEW_TYPE)
        )
    );
}

function activate(context) {
    context.subscriptions.push(vscode.commands.registerCommand("oog.openStartPage", openStartPage));
    // A tab that was open before a reload is revived here (webview panels without a serializer are dropped).
    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
            async deserializeWebviewPanel(restored) {
                attach(restored);
                await fill(restored);
            },
        })
    );

    if (!vscode.workspace.getConfiguration("oog.startPage").get("openOnStartup", true)) {
        return;
    }
    // onStartupFinished runs after the editors of the last session were restored. A start page tab from
    // that session counts as "already open": no second tab, and a tab the user closed on purpose comes back
    // only with the next page load, not while working. A failure is never fatal: the page is a convenience.
    setTimeout(() => {
        if (panel || startPageTabOpen()) {
            return;
        }
        openStartPage().catch((error) => {
            console.warn("oog-welcome: could not open the start page:", error);
        });
    }, 1500);
}

function deactivate() {}

module.exports = { activate, deactivate };
