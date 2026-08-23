// Static checks over the Field Kit bundle. Catches the mistakes
// that have actually cost time on this project:
//
//   1. An attribute named like an inherited one (blendMode et al). The shader
//      then silently never runs, with no error anywhere.
//   2. Uniform declaration order not matching the attribute order, which
//      mis-binds every uniform after the first mismatch.
//   3. An attribute missing from triggers.out, so changing it does not
//      re-render and the control looks dead.
//   4. A missing tooltip or enum label, which ships an unlabelled control.
//
// Run: node scripts/check-bundle.cjs
const fs = require("fs");
const path = require("path");

const ROOT   = path.join(__dirname, "..");
const SRC    = path.join(ROOT, "src");
const PLUGIN = path.join(ROOT, "Field Kit");

// Provided by thirdPartyFilter itself - declaring any of these collides.
const RESERVED = new Set(["blendMode", "padding", "autoPadding", "mattes",
  "matteApplyMode", "matteTileMode", "filterInputCompositing", "childShaders",
  "id", "outCode", "code", "inputs", "hidden", "frozen", "opacity", "out",
  "userData", "uuid", "niceName", "notes", "tags", "locked", "pinned"]);

// Bound automatically, or by position, rather than from the attribute list.
// Attributes inherited from the base filter that a definition may re-declare
// only to change their default. They are not ours: no uniform, no tooltip, no
// UI slot of our own.
const INHERITED = new Set(["allowViewportClipping"]);

const AUTO_UNIFORMS = new Set(["resolution", "rectCentre", "childShader",
  "original", "image"]);

let problems = 0;
const fail = (t, m) => { console.log(`  ✗ ${t}: ${m}`); problems++; };

const defs = fs.readdirSync(path.join(SRC, "defs")).filter(f => f.endsWith(".json")).sort();

for (const file of defs) {
  const d = JSON.parse(fs.readFileSync(path.join(SRC, "defs", file), "utf8"));
  const type = d.type;
  const attrs = d.attributes || {};
  const attrNames = Object.keys(attrs).filter(a => !INHERITED.has(a));

  // 1 - reserved names
  const clash = attrNames.filter(a => RESERVED.has(a));
  if (clash.length) fail(type, `reserved attribute name(s): ${clash.join(", ")} - rename (blendMode -> blend)`);

  // 3 - triggers
  const trig = new Set((d.triggers && d.triggers.out) || []);
  const missingTrig = attrNames.filter(a => !trig.has(a));
  if (missingTrig.length) fail(type, `not in triggers.out, so will not re-render: ${missingTrig.join(", ")}`);

  // 2 - uniform order per pass
  const passes = d.passes || [{ skslFile: d.skslFile, uniforms: null }];
  const scalarAttrs = attrNames.filter(a => attrs[a].type !== "shaderData");
  const shaderAttrs = attrNames.filter(a => attrs[a].type === "shaderData");

  for (const p of passes) {
    const sp = path.join(PLUGIN, p.skslFile);
    if (!fs.existsSync(sp)) { fail(type, `missing shader ${p.skslFile}`); continue; }
    const src = fs.readFileSync(sp, "utf8");
    const uni = [...src.matchAll(/^uniform\s+\S+\s+(\w+)\s*;/gm)].map(m => m[1]);

    // constants supplied per pass are legitimately declared but not attributes
    const constNames = new Set(Object.keys(p.constants || {}));

    // ...but they must still be DECLARED. Cavalry binds them as ordinary float
    // uniforms, so a constant the shader never declares is an undefined symbol:
    // the pass fails to compile and silently contributes nothing.
    const undeclared = [...constNames].filter(c => !uni.includes(c));
    if (undeclared.length) {
      fail(type, `${p.skslFile} uses pass constants it never declares: ${undeclared.join(", ")} - add "uniform float <name>;"`);
    }
    const declared = uni.filter(u => !AUTO_UNIFORMS.has(u) && !constNames.has(u));

    // Which attributes should this pass see? The whitelist if given, else all.
    const expected = (p.uniforms ? p.uniforms : scalarAttrs)
      .filter(a => attrs[a] && attrs[a].type !== "shaderData");

    const declaredScalars = declared.filter(u => !shaderAttrs.includes(u));
    const a = declaredScalars.join(",");
    const b = expected.join(",");
    if (a !== b) {
      fail(type, `${p.skslFile} uniform order != attribute order\n      shader: ${a}\n      defs:   ${b}`);
    }

    // SkSL reserves a set of identifiers that look perfectly ordinary. Using
    // one fails the build with "name 'x' is reserved" and the pass then
    // silently contributes nothing, which is indistinguishable from a filter
    // that simply does not work.
    const SKSL_RESERVED = ["packed", "sampler", "texture", "buffer", "shared",
      "attribute", "varying", "uniform", "precision", "invariant", "layout",
      "coherent", "volatile", "restrict", "readonly", "writeonly", "subroutine",
      "common", "partition", "active", "asm", "class", "union", "template",
      "this", "resource", "goto", "inline", "noinline", "public", "static",
      "extern", "external", "interface", "long", "short", "double", "fixed",
      "unsigned", "input", "output", "filter", "sizeof", "cast", "namespace"];
    for (const word of SKSL_RESERVED) {
      const re = new RegExp(`\\b(?:float|half|int|bool|void)[0-9x]*\\s+${word}\\b`);
      if (re.test(src)) {
        fail(type, `${p.skslFile} declares a variable named "${word}", which SkSL reserves - the pass will fail to build silently`);
      }
    }

    // A pass with no shader input at all fails to CONSTRUCT - Cavalry binds the
    // image by position, and reports only "Pass N: buildShader failed" with no
    // SkSL error, because nothing failed to compile. Even a purely procedural
    // pass has to declare the input.
    if (!/^uniform\s+shader\s+\w+\s*;/m.test(src)) {
      fail(type, `${p.skslFile} declares no input shader - the pass will fail to build ("buildShader failed") even if it never samples the image`);
    }

    // shaderData inputs must be declared before the image/childShader
    for (const s of shaderAttrs) {
      const si = uni.indexOf(s);
      if (si === -1) {
        fail(type, `${p.skslFile} must declare shaderData "${s}" in EVERY pass to keep binding order`);
      } else {
        for (const tail of ["childShader", "image", "original"]) {
          const ti = uni.indexOf(tail);
          if (ti !== -1 && si > ti) fail(type, `${p.skslFile}: shaderData "${s}" declared after "${tail}" - binds in the wrong slot`);
        }
      }
    }
    // original, when present, must be last
    const oi = uni.indexOf("original");
    if (oi !== -1 && oi !== uni.length - 1) {
      fail(type, `${p.skslFile}: "original" must be the LAST shader uniform or it swaps with childShader`);
    }

    // PASS 0 MUST NOT DECLARE `original`. There is no untouched-input shader to
    // bind on the first pass, so declaring one makes the pass fail to BUILD -
    // Cavalry logs "Pass 0: buildShader failed" and then runs the rest of the
    // chain anyway. Nothing errors and nothing is obviously broken; the pass
    // just silently contributes nothing. This cost three filters a missing
    // blur term (Bokeh's aperture summed one segment short, Ultra Glow and
    // Lightwrap lost their tightest ladder step) and a long hunt, because
    // preflight_shader compiles the file standalone and reports OK.
    // Fix: give pass 0 its own file that reads the layer via childShader.
    if (passes.indexOf(p) === 0 && uni.indexOf("original") !== -1) {
      fail(type, `${p.skslFile} is pass 0 and declares "original" - pass 0 has no `
        + `original input, so it will fail to build and silently do nothing. `
        + `Give pass 0 a separate shader that reads the layer via childShader.`);
    }
  }

  // 4 - strings coverage
  const sfile = path.join(SRC, "strings", file);
  if (!fs.existsSync(sfile)) { fail(type, "no strings file"); continue; }
  const s = JSON.parse(fs.readFileSync(sfile, "utf8")).value || {};
  const st = s.attributes || {};
  const noTip = attrNames.filter(a => !st[a]);
  if (noTip.length) fail(type, `no label/tooltip: ${noTip.join(", ")}`);

  for (const a of attrNames) {
    if (attrs[a].type !== "enum") continue;
    const labels = (s.enums || {})[a];
    const n = (attrs[a].enumValues || []).length;
    if (!labels) { fail(type, `enum "${a}" has no labels`); continue; }
    const count = Array.isArray(labels) ? labels.length : Object.keys(labels).length;
    if (count !== n) fail(type, `enum "${a}" has ${count} labels for ${n} values`);
  }

  // 5 - UI layout: either one flat attributeOrder, or tabs. UI.tabs and
  // UI.attributeOrder are alternatives; using both is ambiguous.
  const ui   = d.UI || {};
  const tabs = ui.tabs;
  if (tabs && ui.attributeOrder) {
    fail(type, "has BOTH UI.tabs and UI.attributeOrder - they are alternatives, pick one");
  }

  // Every attribute must be reachable in the UI. An attribute left out of every
  // tab does not fall back to a default panel - it VANISHES from the Attribute
  // Editor entirely, with no error, which is the easy mistake when tabbing a
  // filter up.
  const listed = [];
  if (tabs) {
    for (const t of tabs) {
      if (!t.id) { fail(type, "a tab has no id"); }
      if (!Array.isArray(t.attributeOrder)) {
        fail(type, `tab "${t.id}" has no attributeOrder`);
        continue;
      }
      listed.push(...t.attributeOrder);
    }
  } else {
    listed.push(...(ui.attributeOrder || []));
  }
  const shown = listed.filter(a => !/^---/.test(a));
  const orphaned = attrNames.filter(a => !shown.includes(a));
  if (orphaned.length) {
    fail(type, `not in any tab/attributeOrder, so INVISIBLE in the UI: ${orphaned.join(", ")}`);
  }
  const dupes = shown.filter((a, i) => shown.indexOf(a) !== i);
  if (dupes.length) fail(type, `listed more than once in the UI: ${[...new Set(dupes)].join(", ")}`);

  // Attribution slot: by convention the LAST entry is a separator carrying the
  // credit, since the schema has no static-text type. With tabs, that means the
  // last entry of the last tab.
  const last = listed[listed.length - 1] || "";
  if (!/^---/.test(last)) {
    fail(type, "last UI entry should be a '---' separator carrying the credit");
  }

  // Tab display names must exist, or the tab shows its raw id.
  if (tabs) {
    const tabStrings = s.tabs || {};
    const unnamed = tabs.map(t => t.id).filter(id => !tabStrings[id]);
    if (unnamed.length) fail(type, `tabs with no display name in strings: ${unnamed.join(", ")}`);
  }

  // 6 - dimming expressions. `dimming` greys a control out when the expression
  // is TRUE. It is an undocumented engine key, and a typo'd driver does not
  // error - it just never dims. So check every identifier is a real scalar
  // attribute on this same type.
  const SCALAR = new Set(["double", "int", "enum", "bool"]);
  for (const a of attrNames) {
    const expr = attrs[a].dimming;
    if (!expr) continue;
    if (/[()]/.test(expr)) {
      fail(type, `dimming on "${a}" uses parentheses, which the engine does not parse: ${expr}`);
    }
    // Cavalry parses == != <= >= && || - but NOT a bare < or >. It logs
    // "Could not parse dimming expression" and the control then never dims at
    // all, which looks exactly like a control that was never meant to dim.
    if (/[^<>=!]<[^=]|[^<>=!]>[^=]/.test(expr)) {
      fail(type, `dimming on "${a}" uses < or >, which the engine cannot parse - use <= or >=: ${expr}`);
    }
    const ids = expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
    for (const id of ids) {
      if (id === "true" || id === "false") continue;
      if (!attrs[id]) {
        fail(type, `dimming on "${a}" references unknown attribute "${id}" - it will never dim`);
      } else if (!SCALAR.has(attrs[id].type)) {
        fail(type, `dimming on "${a}" is driven by "${id}" of type ${attrs[id].type}; `
          + `only double/int/enum/bool can drive dimming`);
      }
    }
  }
}

// Informational, not a failure: which controls arrive already greyed out,
// because their dimming expression is true at the filter's own defaults. Often
// correct - Spectral Displacement defaults to Barrel, so its Spectral, Channel
// and Prism controls SHOULD start greyed - but a surprise here usually means the
// polarity is inverted, since dimming disables when TRUE.
if (process.argv.includes("--defaults")) {
  const rows = [];
  for (const file of defs) {
    const d = JSON.parse(fs.readFileSync(path.join(SRC, "defs", file), "utf8"));
    const attrs = d.attributes || {};
    const env = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (typeof v.default === "number" || typeof v.default === "boolean") env[k] = v.default;
    }
    for (const [a, v] of Object.entries(attrs)) {
      if (!v.dimming) continue;
      const js = v.dimming.replace(/\b(\w+)\b/g, (t) => (t in env ? JSON.stringify(env[t]) : t));
      let on = false;
      try { on = Function(`"use strict";return (${js});`)(); } catch (e) { on = null; }
      if (on === null) rows.push([d.type, a, `UNEVALUABLE: ${v.dimming}`]);
      else if (on) rows.push([d.type, a, v.dimming]);
    }
  }
  console.log(`\n${rows.length} control(s) greyed at their own defaults:`);
  for (const [t, a, e] of rows) console.log(`  ${t}.${a}  <-  ${e}`);
}

// 7 - presets. A preset naming an attribute that does not exist is dropped in
// silence, so the look it promises just never arrives.
{
  const pfile = path.join(PLUGIN, "presets.json");
  if (fs.existsSync(pfile)) {
    const parsed = defs.map(f =>
      JSON.parse(fs.readFileSync(path.join(SRC, "defs", f), "utf8")));
    const AUTHOR = parsed[0].author;
    const byType = new Map(parsed.map(d => [d.type, d]));
    const seenId = new Set();
    for (const p of JSON.parse(fs.readFileSync(pfile, "utf8"))) {
      const where = `preset "${p.name}"`;
      if (p.author !== AUTHOR) fail(where, `author is "${p.author}", not "${AUTHOR}"`);
      if (seenId.has(p.id)) fail(where, `duplicate id ${p.id}`);
      seenId.add(p.id);
      for (const t of p.layerType || []) {
        const d = byType.get(t);
        if (!d) { fail(where, `unknown layerType "${t}"`); continue; }
        for (const a of p.attrs || []) {
          const def = d.attributes[a.attrId];
          if (!def) { fail(where, `${t} has no attribute "${a.attrId}"`); continue; }
          if (def.type === "enum" && !(def.enumValues || []).includes(a.value)) {
            fail(where, `${a.attrId} = ${a.value} is not one of ${t}'s enum values`);
          }
        }
      }
    }
  }
}

console.log(problems
  ? `\n${problems} problem(s) across ${defs.length} filters.`
  : `\nAll ${defs.length} filters pass.`);
process.exit(problems ? 1 : 0);
