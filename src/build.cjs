// Assemble the per-type fragments in src/defs/ and src/strings/ into the two
// bundle files Cavalry reads, writing them into the install-ready plugin folder
// beside the shaders. Run after editing any fragment:
//     node src/build.cjs
//
// The plugin folder is deliberately FLAT: definitions.json references shaders by
// bare filename, so every .sksl has to sit next to it. That folder is exactly
// what ships - drag it, or a zip of it, into the Cavalry window.
//
// Pass --deploy to also copy it into the live plugins folder, which is only
// useful when iterating; a plain drag-and-drop install does not need it.
const fs = require("fs"), path = require("path");

const ROOT   = path.join(__dirname, "..");
const PLUGIN = path.join(ROOT, "Field Kit");

const read = d => fs.readdirSync(path.join(__dirname, d))
    .filter(f => f.endsWith(".json")).sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(__dirname, d, f), "utf8")));

const defs = read("defs");
fs.writeFileSync(path.join(PLUGIN, "definitions.json"), JSON.stringify(defs, null, 2));
fs.writeFileSync(path.join(PLUGIN, "strings.json"), JSON.stringify(read("strings"), null, 2));
console.log("types: " + defs.map(d => d.type).join(", "));

// presets.json ships the original looks of the filters that were merged, so a
// merged node can be put back to any of its predecessors in one click. Each
// fragment is an array, so they concatenate rather than nest.
const presets = read("presets").flat();
fs.writeFileSync(path.join(PLUGIN, "presets.json"), JSON.stringify(presets, null, 2));
console.log(presets.length + " presets");

// Every shader the definitions ask for must be present and flat, or Cavalry
// registers the types and then silently fails to find their code.
const wanted = new Set();
for (const t of defs) {
    if (t.skslFile) { wanted.add(t.skslFile); }
    for (const p of (t.passes || [])) { wanted.add(p.skslFile); }
}
const missing = [...wanted].filter(f => !fs.existsSync(path.join(PLUGIN, f)));
if (missing.length) {
    console.error("MISSING shaders in the plugin folder: " + missing.join(", "));
    process.exit(1);
}
const present = fs.readdirSync(PLUGIN).filter(f => f.endsWith(".sksl"));
const orphans = present.filter(f => !wanted.has(f));
if (orphans.length) { console.warn("unreferenced shaders: " + orphans.join(", ")); }
console.log(wanted.size + " shaders referenced, all present");

if (process.argv.includes("--deploy")) {
    const LIVE = path.join(process.env.HOME,
        "Library/Application Support/Cavalry/Third-Party/Plugins/Field Kit");
    fs.mkdirSync(LIVE, { recursive: true });
    const icons = fs.readdirSync(PLUGIN).filter(f => f.endsWith(".png"));
    const keep = new Set(["definitions.json", "strings.json", "presets.json",
        ...wanted, ...icons]);
    for (const f of fs.readdirSync(LIVE)) {
        if (f === ".DS_Store") { continue; }
        if (!keep.has(f)) { fs.rmSync(path.join(LIVE, f), { recursive: true, force: true }); }
    }
    for (const f of keep) { fs.copyFileSync(path.join(PLUGIN, f), path.join(LIVE, f)); }
    console.log("deployed " + keep.size + " files to " + LIVE);
}
