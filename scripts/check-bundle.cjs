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
const INHERITED = new Set(["allowViewportClipping", "padding", "autoPadding"]);

const AUTO_UNIFORMS = new Set(["resolution", "rectCentre", "childShader",
  "original", "image"]);

let problems = 0;
const fail = (t, m) => { console.log(`  ✗ ${t}: ${m}`); problems++; };

const defs = fs.readdirSync(path.join(SRC, "defs")).filter(f => f.endsWith(".json")).sort();

for (const file of defs) {
  const d = JSON.parse(fs.readFileSync(path.join(SRC, "defs", file), "utf8"));
  const type = d.type;
  // thirdPartyShader is a GENERATOR, not a filter, and three rules below do not
  // apply to it: its first pass has no input shader at all, `original` does not
  // exist for it in any pass, and paddingExpression is filters-only.
  const SUPERTYPES = ["thirdPartyFilter", "thirdPartyShader", "thirdPartyJavaScript",
    "thirdPartyJavaScriptShape", "thirdPartyJavaScriptDeformer"];
  if (!SUPERTYPES.includes(d.superType)) {
    fail(type, `superType "${d.superType}" is not one Cavalry registers - expected one of ${SUPERTYPES.join(", ")}`);
  }
  const isShaderLayer = d.superType === "thirdPartyShader";
  const attrs = d.attributes || {};
  const attrNames = Object.keys(attrs).filter(a => !INHERITED.has(a));

  // 0 - paddingExpression is a 2.8-only key. On 2.7.2 the definition parser
  // has no such key, ignores it, and falls back to the padding/autoPadding
  // attributes - so a large blur silently CLIPS at the layer bounds instead of
  // erroring. paddingExpression overrides padding on 2.8 (verified), so a
  // static default costs nothing there and fixes the older version.
  if (d.paddingExpression && isShaderLayer) {
    fail(type, "paddingExpression is a filters-only key and is ignored on a thirdPartyShader");
  }
  if (d.paddingExpression && !isShaderLayer && !(attrs.padding && attrs.padding.default)) {
    fail(type, "has paddingExpression but no static padding default - will clip on Cavalry 2.7.2, which ignores paddingExpression");
  }

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
    // Comment-stripped copy for the identifier checks. Without it a type name
    // mentioned in a trailing comment reads as a declaration: `uniform float
    // invert;  // bool` followed by the next `uniform` line matched the
    // reserved-word pattern as "bool uniform" and failed a perfectly good
    // shader.
    const srcCode = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
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
      if (re.test(srcCode)) {
        fail(type, `${p.skslFile} declares a variable named "${word}", which SkSL reserves - the pass will fail to build silently`);
      }
    }

    // An EMPTY `uniforms` array is not "bind nothing" - it is treated exactly
    // like omitting the key, so Cavalry binds EVERY attribute and then logs a
    // "Could not bind uniform" error for each one this shader does not declare.
    // At a couple of dozen attributes that is megabytes of log per minute and
    // an app that stops responding. List at least one real uniform.
    if (Array.isArray(p.uniforms) && p.uniforms.length === 0) {
      fail(type, `${p.skslFile} has an EMPTY "uniforms" array - that binds ALL attributes, not none, and floods the log with bind errors. List the uniforms the shader actually declares.`);
    }

    // A pass with no shader input at all fails to CONSTRUCT - Cavalry binds the
    // image by position, and reports only "Pass N: buildShader failed" with no
    // SkSL error, because nothing failed to compile. Even a purely procedural
    // pass has to declare the input.
    if (!/^uniform\s+shader\s+\w+\s*;/m.test(src)
        && !(isShaderLayer && passes.indexOf(p) === 0)) {
      fail(type, `${p.skslFile} declares no input shader - the pass will fail to build ("buildShader failed") even if it never samples the image`);
    }

    // Unbalanced braces. Trivial, but scripted edits to these files break it
    // easily and the compiler's report ("function 'main' can exit without
    // returning a value", pointing at a line hundreds away) buries the cause.
    {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      const open = (code.match(/{/g) || []).length;
      const close = (code.match(/}/g) || []).length;
      if (open !== close) {
        fail(type, `${p.skslFile} has unbalanced braces (${open} "{" vs ${close} "}") - the compiler will report this somewhere far from the real cause`);
      }
    }

    // SkSL has NO dynamic array indexing: "index expression must be constant".
    // A local array written in one loop and read in another looks perfectly
    // ordinary and fails outright, so flag any locally-declared array indexed
    // by anything that is not a literal.
    {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      const arrays = new Set();
      for (const m of code.matchAll(/\b(?:float|half|int|bool)[0-9]?\s+(\w+)\s*\[\s*\d+\s*\]\s*;/g)) arrays.add(m[1]);
      if (arrays.size) {
        const lines = code.split("\n");
        lines.forEach((line, i) => {
          for (const a of arrays) {
            const use = new RegExp(`\\b${a}\\s*\\[([^\\]]+)\\]`, "g");
            for (const m of line.matchAll(use)) {
              if (!/^\s*\d+\s*$/.test(m[1])) {
                fail(type, `${p.skslFile}:${i + 1} indexes array "${a}" with a non-constant expression ("${m[1].trim()}") - SkSL rejects this ("index expression must be constant")`);
              }
            }
          }
        });
      }
    }

    // Sampling a shader input the file never declared is a guaranteed compile
    // failure ("unknown identifier 'childShader'"), and easy to hit because the
    // input is named `image` in single-pass filters and `childShader` in
    // multi-pass ones - so code moved between them looks right and is not.
    {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      const declared = new Set();
      for (const m of code.matchAll(/^uniform\s+shader\s+(\w+)\s*;/gm)) declared.add(m[1]);
      const seen = new Set();
      for (const m of code.matchAll(/(\w+)\.eval\s*\(/g)) {
        if (!declared.has(m[1]) && !seen.has(m[1])) {
          seen.add(m[1]);
          fail(type, `${p.skslFile} calls ${m[1]}.eval() but never declares "uniform shader ${m[1]}" - single-pass filters name the input "image", multi-pass ones "childShader"`);
        }
      }
    }

    // Redeclaring a name in the SAME scope is a hard compile error ("symbol 'n'
    // was already defined") that nothing else here catches - it needs brace
    // tracking rather than a line-level regex. Shadowing an OUTER scope is
    // legal, as in C, so only same-scope collisions are reported. Braces must be
    // walked in source order: handling every '{' before every '}' makes
    // "} else if (x) {" reuse the parent scope instead of opening a sibling,
    // which produces a flood of false positives.
    {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      const DECL = /^\s*(?:const\s+)?(?:float|half|int|bool|void)[0-9]?(?:x[0-9])?\s+(\w+)\s*(?:=|;|\[)/;
      let scopes = [new Map()];
      code.split("\n").forEach((line, i) => {
        const m = line.match(DECL);
        if (m && scopes.length > 1) {
          const top = scopes[scopes.length - 1];
          if (top.has(m[1])) {
            fail(type, `${p.skslFile}:${i + 1} redeclares "${m[1]}" in the same scope (first at line ${top.get(m[1])}) - SkSL rejects this outright`);
          } else {
            top.set(m[1], i + 1);
          }
        }
        for (const ch of line) {
          if (ch === "{") scopes.push(new Map());
          else if (ch === "}" && scopes.length > 1) scopes.pop();
        }
      });
    }

    // An UNCONNECTED shaderData input is substituted as a constant half4(0), and
    // SkSL constant-folds both arms of a ternary at compile time - so the usual
    // `c.a > 0.0 ? c.rgb / c.a : c.rgb` un-premultiply becomes a literal 0/0 and
    // the whole shader fails to compile with "division by zero". The guard never
    // runs. Divides of a shaderData sample must use max(), which cannot fold to
    // zero. Cost one silent Lightwrap compile failure.
    for (const sd of shaderAttrs) {
      const assign = new RegExp(`half4\\s+(\\w+)\\s*=\\s*${sd}\\.eval`, 'g');
      let m;
      while ((m = assign.exec(src)) !== null) {
        const v = m[1];
        const bad = new RegExp(`${v}\\.(a|w)\\s*>[^?]*\\?[^:]*/\\s*${v}\\.(a|w)`);
        if (bad.test(src)) {
          fail(type, `${p.skslFile} divides by ${v}.a from shaderData "${sd}" behind a ternary - an unconnected input folds that to 0/0 at compile time and the shader will not build. Use / max(float(${v}.a), 1e-6) instead`);
        }
      }
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
    if (isShaderLayer && uni.indexOf("original") !== -1) {
      fail(type, `${p.skslFile} declares "original", which does not exist for a thirdPartyShader in any pass`);
    }
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

// CAVALRY 2.7.2 COMPATIBILITY, checked on the BUILT bundle rather than the
// source - the build rewrites passes to make them portable, so only its output
// can be judged. Two rules, both of which cost a silent "Pass N: buildShader
// failed" with no SkSL error attached:
//
//   1. Per-pass `constants` are a 2.8 feature. 2.7.2's pass spec knows only
//      skslFile, uniforms, blendMode and clearColor, so the block is ignored,
//      the matching uniform is never bound, and the pass fails to construct.
//   2. 2.7.2 binds shader inputs BY POSITION and always supplies `original`
//      from pass 2 on, so every pass after the first must declare it - even
//      when it never samples it - or the slots shift and the pass fails.
{
  const built = path.join(PLUGIN, "definitions.json");
  if (fs.existsSync(built)) {
    for (const t of JSON.parse(fs.readFileSync(built, "utf8"))) {
      (t.passes || []).forEach((p, i) => {
        if (p.constants && Object.keys(p.constants).length) {
          fail(t.type, `built pass ${i} still carries "constants" - Cavalry 2.7.2 ignores them and the pass will fail to build`);
        }
        const sp = path.join(PLUGIN, p.skslFile);
        if (!fs.existsSync(sp)) { return; }
        const has = /^uniform\s+shader\s+original\s*;/m.test(fs.readFileSync(sp, "utf8"));
        if (t.superType === "thirdPartyShader") {
          if (has) {
            fail(t.type, `built pass ${i} (${p.skslFile}) declares "original", which thirdPartyShader never receives`);
          }
        } else if (i >= 1 && !has) {
          fail(t.type, `built pass ${i} (${p.skslFile}) does not declare "uniform shader original" - Cavalry 2.7.2 binds by position and will fail to build it`);
        }
        if (t.superType !== "thirdPartyShader" && i === 0 && has) {
          fail(t.type, `built pass 0 (${p.skslFile}) declares "uniform shader original" - there is no such input on the first pass`);
        }
      });
    }
  }
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
