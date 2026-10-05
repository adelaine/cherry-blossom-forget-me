// Runs with macOS JavaScript for Automation or an already installed Node runtime.
function tokenIn(contents) {
    var section = "";
    var lines = contents.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || line.charAt(0) === "#") continue;
        var heading = line.match(/^\[([^\]]+)\]$/);
        if (heading) { section = heading[1].toLowerCase(); continue; }
        var setting = line.match(/(?:^|[{,]\s*)["']?((?:nems_)?gitlab_(?:(?:personal_access|private_access|personal|private|access|api)_)?token|gitlab_pat|gitlab\.token)["']?\s*=\s*("[^"]*"|'[^']*')/i) || line.match(/^(?:export\s+)?["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*=\s*(.*?)\s*$/);
        if (!setting) continue;
        var key = setting[1].toLowerCase();
        if (!/^(?:nems_)?gitlab_(?:(?:personal_access|private_access|personal|private|access|api)_)?token$/.test(key) && key !== "gitlab_pat" && key !== "gitlab.token" && !(section === "gitlab" && /^(token|access_token|private_token|personal_access_token|pat)$/.test(key))) continue;
        var value = setting[2].trim();
        if ((value.charAt(0) === '"' && value.slice(-1) === '"') || (value.charAt(0) === "'" && value.slice(-1) === "'")) value = value.slice(1, -1);
        else value = value.replace(/\s+#.*$/, "");
        if (value && !/[\r\n\0]/.test(value)) return value;
    }
    return "";
}

function run(args) {
    var read, write;
    if (typeof ObjC !== "undefined") {
        ObjC.import("Foundation");
        read = function(path) { var value = $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, null); return ObjC.unwrap(value) || ""; };
        write = function(path, contents) { if (!$(contents).writeToFileAtomicallyEncodingError($(path), true, $.NSUTF8StringEncoding, null)) throw new Error("Could not save imported credentials."); };
    } else {
        var fs = require("node:fs");
        read = function(path) { try { return fs.readFileSync(path, "utf8"); } catch (_) { return ""; } };
        write = function(path, contents) { fs.writeFileSync(path, contents, {mode:384}); };
    }
    if (args[0] === "--pm-mode") {
        var config = {}, credentials = {};
        try { config = JSON.parse(read(args[1])); } catch (_) { /* The page reports malformed settings. */ }
        try { credentials = JSON.parse(read(args[2])); } catch (_) { /* Missing credentials use PM mode. */ }
        return (config && config.PM_MODE === true) || !credentials ||
            typeof credentials["gitlab-token"] !== "string" || !credentials["gitlab-token"].trim() ? "true" : "false";
    }
    var auth;
    try { auth = JSON.parse(read(args[0])); } catch (_) { return; }
    if (!auth || typeof auth !== "object" || Array.isArray(auth) || (typeof auth["gitlab-token"] === "string" && auth["gitlab-token"].trim())) return;
    for (var i = 1; i < args.length; i++) {
        var token = tokenIn(read(args[i]));
        if (token) { auth["gitlab-token"] = token; write(args[0], JSON.stringify(auth, null, 4) + "\n"); return; }
    }
}
if (typeof module !== "undefined") {
    module.exports = { tokenIn: tokenIn, run: run };
    if (require.main === module) {
        var result = run(process.argv.slice(2));
        if (result !== undefined) console.log(result);
    }
}
