# Learnings

Hard-won. Each line cost a failed attempt. Read before touching shaders or definitions.

Terse on purpose.

---

## 1. Silent build failures

Shader compiles. Shader does nothing. No error you'd notice. Five causes:

- **Pass 0 declares `uniform shader original`.** No such input on first pass. Fails to BUILD, contributes nothing, rest of chain runs fine.
- **Pass declares NO input shader.** Fails to CONSTRUCT. Log says only `Pass N: buildShader failed`.
- **Pass constant used but not declared as uniform** (e.g. `plateIndex`). Blank output.
- **Reserved SkSL identifier as variable name** (e.g. `packed`).
- **Program too big.** Compiles, then `buildShader failed`. Hit it with 24 unrolled `irisMask` calls. Split heavy function into heavy-once + cheap-thrice.

Log wording tells which: `Pass N: buildShader failed` alone = construction. `SkSL Error:` block then `Pass N effect failed to build` = compile.

Log: `~/Library/Application Support/Cavalry/logs/<newest>.log`

`scripts/check-bundle.cjs` catches all five now. Run it. Trust it.

---

## 2. SkSL compiler traps

- **Compile-time-constant expressions can fold to ZERO.** Killed Display's kernel normaliser → divide floored at 1e-4 → picture blew to white. Derive normalisers from a RUNTIME value, never from literals in a loop.
- Loop bounds must be compile-time constant. Uniform-driven count = `if (i >= n) continue;` inside a fixed loop.
- No `tanh`. No bitwise ops. No array constructor syntax.
- **No INTEGER overloads of `max`/`min`.** `max(n - 1, 1)` on ints fails with
  "no match for max(int, int)". Use `n > 1 ? float(n - 1) : 1.0`. Worth knowing
  how this REPORTS: the failed statement means every identifier it declared is
  then unknown, so one bad call came back as eight errors pointing at eight
  innocent lines. Read the FIRST error and ignore the cascade.
- Int division truncates toward zero. `x - 3*(x/3)` still negative for negative x. Fold manually.
- No variable named after an SkSL type.
- Uniform declaration order MUST match pass's attribute order. `shaderData` binds BEFORE image. `original` LAST. A `shaderData` must be declared in EVERY pass of that filter or binding order breaks everywhere.

---

## 3. Coordinates, colour, data

- `fragCoord` = pixels, absolute, **Y-up**, pixel-CENTRE addressed (pixel 0 at 0.5).
- Premultiplied alpha in and out.
- **`time` compConnect is in FRAMES, not seconds.** Proved by scene JSON: time=1159 on 1200-frame comp. An agent once "corrected" this to seconds and made everything 30x too fast.
- **Pass targets clamp to 0..1.** Signed or large values must be bias-encoded. Bit us twice: DCT coefficients, and lens flare emitter offset in pixels (flare always landed centre-frame).
- **No frame history.** Filters see one frame. Datamosh, phosphor persistence, multi-frame accumulation: impossible, not just hard. Fake from noise and label honestly.
- One image input per filter. `shaderData` evaluates in the SOURCE IMAGE's own pixel space, not world space — differently-sized maps won't line up without their own scale/offset controls (see Lightwrap's `bgSize`/`bgScale`).
- To feed a LAYER into a `shaderData` port: user goes through **Shape to Shader** (`shapeToShader`), or **Image Shader** for a file. Port only accepts `["shader","shaderArray"]`, and that's enough.
- **`fract(sin(dot(...)))` hashes degrade** at absolute fragCoord magnitudes (dot ~87,000 on HD). float32 `sin` is quantised there → correlated structure, visible discontinuities, "grain went offscreen". Use non-trig hash:
  ```glsl
  float hash21(float2 p) {
      p = fract(p * float2(0.1031, 0.11369));
      p += dot(p, p.yx + 19.19);
      return fract((p.x + p.y) * p.x);
  }
  ```
- **Catastrophic cancellation** in `(1 - sqrt(1-u)) / (u/2)`: huge times tiny near centre → concentric rings exactly where picture should be untouched. Multiply by conjugate → `2 / (1 + sqrt(1-u))`. Same value, no guard needed, exact at u=0.

---

## 4. Definitions / UI

- Types register `<author>::<type>`, i.e. `samMularczyk::<type>`.
- `presets.json` ships INSIDE the plugin folder.
- **`dimming: "<expr>"` greys a control when expression is TRUE.**
- **A bare `<` or `>` in a dimming expression CANNOT be parsed.** Cavalry logs "Could not parse dimming expression" and the control never dims. Silently broken for ages in 11 places. Only `== != <= >= && ||` work.
- **No conditional hiding exists.** `UI.hide` is a static list. Dimming is the ONLY dynamic mechanism. Don't promise hiding.
- An attribute in no tab VANISHES from the UI. Checker catches orphans.
- Last entry of last tab must be a `---` credit separator.
- First tab keeps `id: "filter"`. Reordering tabs = swap the ids too.
- Never name an attribute `blendMode`.
- Non-local remaps need `"allowViewportClipping": {"default": false}` INSIDE `attributes`. Top-level entry silently ignored.
- `.sksl` edits do NOT hot-reload — restart Cavalry. Definitions DO reload. Brand-new types register live (loophole for probing without restart).
- `build.cjs` copies icon PNGs but never regenerates them. Editing `make-icons.py` does nothing until you re-run it.

### Cavalry 2.7.2 vs 2.8
Two multi-pass features exist only in 2.8. Both fail as a bare `Pass N: buildShader failed` with no SkSL error, because the pass fails to CONSTRUCT rather than compile.

- **Per-pass `constants`.** 2.7.2's pass spec is `skslFile`, `uniforms`, `blendMode`, `clearColor` only. A `constants` block is ignored, so the matching `uniform float` is never bound.
- **`original` on every pass after the first.** 2.7.2 binds shader inputs BY POSITION and always supplies `original` from pass 2 on. A later pass that does not declare it leaves the slots misaligned. 2.8 tolerates the omission; 2.7.2 does not.

`src/build.cjs` makes one bundle work on both: it bakes each pass's constants into a generated per-pass shader as `const float`, and appends `original` where a later pass lacks it. Author with `constants` as normal - the source is unchanged, only the built output differs. check-bundle enforces both rules against the BUILT bundle, since the source legitimately differs from it.

Side effect worth knowing: a baked `const` can be folded by the compiler where a bound uniform cannot, so branches on it resolve at compile time. The 2.7.2 output may be marginally faster than the 2.8 path it replaces.

**A THIRD 2.8-only key, and the nastiest because it does NOT fail:**
`paddingExpression`. 2.7.2's definition parser has no such key, ignores it, and
falls back to the `padding` / `autoPadding` attributes. So a big blur or glow
silently CLIPS at the layer bounds instead of erroring. `paddingExpression`
overrides `padding` on 2.8 (verified: setting padding to 200 changed nothing),
so a static `padding` default costs nothing there and fixes 2.7.2. check-bundle
now enforces the pairing.

**How to settle "is this key in 2.7.2?" yourself.** The definition parser's key
table is one contiguous string block in `libCore.dylib`. Diff it:

```
grep -aob "Pass missing required" "/Applications/Cavalry.app/Contents/Frameworks/libCore.dylib"
```

then `dd` a window around that offset through `strings`, and compare against
`/Applications/Cavalry Beta.app`. Authoritative where the bundled SDK docs are
NOT: the docs list `clearColor` and `blendMode` for 2.7.2 and neither appears in
its parser block.

**Two keys that DO work in 2.7.2 and the kit was not using:**
- `cavalryVersion` — a real per-layer minimum-version gate, with a user-facing
  message. If something genuinely cannot work on the older build, gate it rather
  than shipping a broken layer.
- per-pass `downsampleFactor` (0.1–1.0) — free performance on blur passes.

### thirdPartyShader — generator layers

`superType: "thirdPartyShader"` works in BOTH 2.7.2 and 2.8, single- or
multi-pass, same JSON shape as a filter. Differences, the whole list:

- **Pass 0 declares NO input shader at all.** The "a pass with no shader input
  fails to construct" rule in §1 is a FILTER rule.
- **`original` does not exist for a shader in any pass.** So the 2.7.2
  positional-binding rule does not apply, and `build.cjs` must not inject it.
- **`paddingExpression` is filters-only.**
- **`coord` is CENTRED and Y-up** — world space, like a filter's `fragCoord`,
  except there is no `rectCentre` to subtract because 0,0 already IS the centre.
  Writing `(coord - resolution*0.5)`, the habit from 0..1 UV shaders, puts the
  origin in a corner. Cost an hour across four shaders.
- A shader Layer can drive any `shaderData` input, which is the real reason to
  build one: `paperTexture` into Lens's Displace Map embosses arbitrary footage
  with no new code.

### Tab discipline
- Tab with only ~4 properties = merge it into a neighbour.
- Group by what the user is DOING, not by which pass owns it.
- Output / main controls go FIRST, in the first tab.
- Related pairs (Ghosts+Halo → Artifacts; Filtering+Artifacts → Signal) merge cleanly.

---

## 5. Visual and light behaviour

The recurring lesson: **decide whether the pixel is real light, absent light, or invented picture.** Nearly every artefact below is that question answered wrong.

### Edge artefacts — a whole bug CLASS
A tap outside the layer is **absent, not black**. Counting it in the weight sum while contributing nothing to the numerator dims the result into a dark rim along the layer edge. Found in 6 places (Display pixelation, Paint watercolour, Paint oil smear, Lens scatter, Film clarity blur, Photocopy blur). Fix:
```glsl
float sa = float(s.a);
sum  += float3(s.rgb) * (sa > 0.0 ? 1.0 : 0.0);
sumA += sa;
cnt  += 1.0;
...
sum  /= max(sumA, 0.0001);
sumA /= cnt;
```
**But NOT for light.** Halation, lightwrap, bloom, flare halo, glow streaks: zero-outside is CORRECT. No glow comes from picture that doesn't exist. Don't "fix" those.

### Geometric remaps vs gathers
- **Remaps** (barrel, fisheye, weave, tear, polar) pull picture from outside the layer → open holes. Need edge handling.
- **Gathers** (blur, bloom, scatter) don't. Leave them.

Edge options and when each is right:
- **Transparent** — honest, nothing there.
- **Clamp / Mirror** — fills wedges a barrel opens. Needs an **Edge Trim** inset (default ~1px): a layer's outermost pixels are antialiased with a dark premultiplied rim, and reflecting those doubles them into a hard seam.
- **Wrap** — not a preference, a fact, for anything that shifts a *scanline* sideways or rolls a raster vertically. A scanline is a fixed-length signal; shifting it wraps. Gap at line end = bug.
- **Overscan** — right answer for a CRT. Real sets draw the raster LARGER than the faceplate so picture runs off the glass rather than glass showing unpainted border (why broadcast safe areas exist). Scale by the corner's own distortion factor (worst case, r²=2) and nothing ever lands outside, at any distortion, with no control to tune.

### Stepping / banding
- **More taps never removes stepping.** A fixed ladder is a ladder at any length. Add per-pixel sub-step **jitter** — turns residual steps into fine noise. Needed in bloom ladder, halo blur, lens scatter, spectral fringing. 16 jittered taps beat 32 unjittered.
- Check the loop cap actually matches the slider max. `MAX_ITER = 16` with a slider to 32 meant every value above 16 rendered identically. THAT was the "stepping".
- 3 box taps read as 3 discrete copies. Use 7 gaussian taps + jitter.

### An empty `uniforms` array binds EVERYTHING

`"uniforms": []` is not "bind nothing" - it is treated exactly like omitting the
key, so Cavalry binds every attribute and logs "Could not bind uniform" for each
one the shader does not declare. At two dozen attributes that is megabytes of
log per minute and an app that stops responding. It looks like a crash, not a
config error. List at least one real uniform; check-bundle enforces this now. A
uniform listed but never used may still be stripped by the compiler and fail to
bind, so reference it - `step(-1.0, x)` is 1 for every legal value.

### Physical accuracy is not the goal - the LOOK plus the right colours is

Print's separation reproduces artwork through real inks, which is correct and
also frequently useless. Flat vector colours generally sit outside what
translucent inks reach on white paper: the artwork's green was DARKER than Riso
Green itself, so it saturated at full density - and so did the lighter green
beside it, so both printed identically and a whole shape vanished. No solver
change fixes that; a sweep of the log floor and an in-gamut clamp both failed,
because the difference between the two greens lived in the green channel while
the unreachable red channel dominated the fit for both.

The answer was to stop trying. Colour Fidelity blends the printed result back
toward the artwork's own colours, giving up the separation exactly where it
cannot deliver. Texture reduces in proportion, so wind the grain up to
compensate. That is a better bargain than a physically exact print of the wrong
colour, and it is what the user actually wanted from the start.

Two earlier attempts at this control were both too clever: scaling the source by
printY/srcY clipped saturated channels into acid hues, and blending chroma alone
preserved the print's luminance - so it could not correct a colour that came out
too pale, which was the whole complaint. The straight blend works.

Related trap: a preset that does not set ink colours INHERITS whatever the
defaults are. Screen Print set none, so every screen print came out riso blue
regardless of the artwork.

### A separation solve must invert the model the RENDERER uses

Print's Ink Density solve was handed the raw ink colours, as if a full-density
plate transmitted exactly `ink`. The renderer lays ink at `inkOpacity` coverage
(and Riso scales that by a further hidden 0.85), so a solid plate really
transmits `mix(1, ink, opacity)` - about 0.11 per channel lighter. The solver
was aiming at a target it could not reach with the inks it thought it had.

The second-order effect was worse than the first. An ink with a ZERO channel -
Riso Blue 0078BF has R=0 - has an unbounded logarithm there, so a whisker of
density annihilates that channel and the only stable answer is to use none of
it. The solve returned zero densities and printed BARE PAPER. Feeding it the
effective transmittance bounds every channel away from zero, so it fixes the
CONDITIONING as well as the target.

Residual after the fix is real gamut: bright green from blue plus yellow tops out
around G 0.53 against a target of 0.77. That part is why Riso sells a Green drum.

### REMOVING an attribute is worse than adding one - it mis-binds every uniform after it

Adding an attribute mid-session just leaves it unavailable until restart.
REMOVING one leaves the running app's pass `uniforms` lists still containing it
while the deployed shader no longer declares it. Binding is POSITIONAL, so every
uniform after the removed one shifts by a slot and the shader runs on scrambled
values - a render that looks like a broken algorithm rather than a stale build.

The tell is the same either way: `api.getAttributes(id)` still lists an
attribute you deleted. Check that before debugging the maths. Restart, then
re-render, then judge.

### ANY schema change needs a Cavalry restart - installPlugin is not enough

Adding an attribute, or a value to an `enumValues` array, does not reach a node
after `installPlugin` - not even a freshly created one. `.sksl` does not reload
either. Only definitions ALREADY KNOWN to the running app update.

Practical consequence for the authoring loop: after any schema or shader edit,
every render you take before restarting is of the OLD build. This invalidated
several rounds of "verified" results in one session before it was spotted. If a
brand-new attribute reads back `undefined`, or a new enum value behaves like an
existing one, stop and restart before debugging anything else.

### GROWING an enum needs a Cavalry restart - and the extra value is SILENTLY CLAMPED

Adding a value to an `enumValues` array does not hot-reload, even after
`installPlugin`, and even on a freshly created node. Worse, the new value is
accepted by `api.set` and READS BACK correctly - `api.get` returned 3 - while
the uniform is bound CLAMPED to the old range. So the shader quietly ran a
different mode, and the render looked like a bug in brand-new code that was in
fact never executed.

Two renders were debugged against the wrong hypothesis before
`api.getAttributeDefinition(id, "separation").enumValues` showed `[0,1,2]`.
Check that FIRST whenever a new enum value behaves like an existing one.

Note the asymmetry: SHRINKING an enum did reload in the same session. Do not
infer from one that the other works.

### Check EVERY procedural texture's cell size against the pixel grid

Five separate textures in Print were authored below Nyquist and none of it was
obvious: ink grain at 0.77px, ink loss at 1.1px, mottle at 0.59px, paper tooth
at 0.9px and 0.43px. Below about two pixels a value-noise lattice is not texture
at all - it is aliased hash, which has a FIXED visual frequency no matter what
you multiply it by.

That is why "add more octaves" did nothing for ink loss: every octave was
already below the grid, so they all rendered as the same fine speckle and the
result read as repetitive however it was tuned. Scale controls felt inert for
the same reason.

Rule: for any `noise(coord * k)`, compute 1/k and sanity-check it in pixels
against what the texture is meant to BE - a paper fibre is a few pixels, a
mottled patch is tens. Do it when authoring, because the symptom downstream
("feels repetitive", "the scale slider does nothing") points nowhere near it.

### Flat artwork wants SPOT inks, not a process build

Print's default inks are a process set (blue/red/yellow/black) that builds every
colour by overprinting. On a photograph that is right. On FLAT artwork it is
what makes the result look pale and washed: a saturated green rebuilt from blue
plus yellow lands lighter and pulled toward cyan.

Be precise about WHY, because it is easy to blame the press. A Riso reaches
bright saturated colours perfectly well - it is a spot process with a real ink
catalogue (Green 00A95C, Fluorescent Pink FF48B0, Orange FF6C2F) and a drum of
that ink lays the colour down directly. The limit is on BUILDING a bright colour
from two process inks, which needs a little of each, and that means paper showing
through.

A real spot-colour riso picks inks that ARE the artwork's colours, and each area
then prints at full density in its own ink. Setting the four inks to the
artwork's palette fixed a green that had been printing as pale teal, in one
change, with every other setting untouched. Verified by A/B in the app.

If a print looks washed out, check the INKS before touching density, opacity or
the artefact controls.

### Do not luminance-match a smoothed quantity against a sharp one

True Colour compared the print's luminance to the source's to re-expose the
source colour. But the print's luminance has been through the flatten wash and
the screen, so it is spatially SMOOTHED, while the source is sharp. Comparing
them is an unsharp mask, and every boundary got a halo - a thin outline in the
artwork printed brighter than the field it sat on.

Blending CHROMA instead has no such mismatch: a thin green line and a wide green
area have the same chroma. Both chroma terms are zero-luma by construction, so
adding them cannot move luminance at all.

### A screen type and a grain are orthogonal

Ink grain was one of the `screenType` values, which is a category error: the
screen is the GEOMETRY the ink is broken into, grain is the unevenness of the
transfer itself. A dotted press is grainy too, and making them mutually
exclusive meant Flat - the setting a riso actually wants - could never have any.

Also: the grain lattice was `coord * 1.3`, a cell of 0.77 PIXELS. Below Nyquist,
so it was aliased white noise that crawled rather than ink texture. Any
procedural texture needs its cell size checked against the pixel grid.

### Cell-based marks need PER-CELL tone, not per-pixel

A halftone reads as printed because the ink/paper decision is made once per
CELL, from the tone at the cell's centre. Sampling per pixel lets tone vary
inside a cell, so the boundary between light and dark regions is a smooth curve
with marks scattered over it - dots laid on a picture rather than a screen.
Sampling once per cell quantises that boundary to the grid, so regions are built
from whole cells with hard axis-aligned edges. That blockiness IS the look; it
is not an artefact to smooth away. Cost is one extra tap.

Related: a polarity SWITCH at mid grey (ink is a disc below, cell-minus-disc
above) cannot be reached by any continuous mapping of coverage, and is what
produces solid blocks against a field of small marks.

### Dimming names the case you do NOT want

It greys when the expression is TRUE. A control used by materials 1 and 2 dims
on `material == 0`, NOT `material != 0`. Backwards greys the control on exactly
the modes that use it, and the symptom is "none of the controls in this tab are
editable". Verify by stepping the enum, never by reading the expression back.

### Unconnected shaderData folds to a constant
An unconnected `shaderData` input is substituted as a literal `half4(0)`. SkSL then constant-folds BOTH arms of a ternary at compile time, so the standard un-premultiply `c.a > 0.0 ? c.rgb / c.a : c.rgb` becomes 0/0 and the WHOLE shader fails to compile — "division by zero". The guard never runs. Divide with `max()` instead, which cannot fold to zero:
```glsl
float3 lin = float3(c.rgb) / max(float(c.a), 1e-6);
```
Only shaderData is at risk; `childShader` and `original` are never constant. check-bundle enforces this now. Cost one silent Lightwrap failure and had spread to 8 places.

### Measure before replacing
Reimplementing a filter? MEASURE the original's frequency response first, don't assume its shape from its name. Composite Video's "luma FIR" turned out to be a 2.9x peaking bandpass, not a lowpass — a plain windowed sinc lost the entire crunchy look. Fitting lowpass-plus-unsharp `(1+k)*lp(fc) - k*lp(0.4*fc)` cut the error from 78 to 0.68. Twenty lines of Python beat guessing.

### Normalisation
- Normalise every mask/multiplier by its own mean, so turning it up changes TEXTURE not EXPOSURE.
- Get the actual weight sum right. A 7×7 gather divided by 7 when weights sum to 30.25 is 4.3× too bright — mid grey clipped to white before the mask was even visible.
- Raised cosine has mean 0.5. Raised to a power it does NOT — only exponent 1 keeps the mean. Use a duty-cycle band instead; then the mean is exactly the duty and normalisation is exact at every setting.
- Some darkness is PHYSICS, not a bug. A 17% fill-factor mask can't be compensated — the boost clips. Mask Amount and Dot Size are the real controls, not a scalar fudge.

### Units
**The most repeated mistake.** Antialiasing is a SCREEN-PIXEL quantity (one pixel, whatever the cell size). Diffusion/softness is a CELL quantity (blur relative to the thing's own size). Sharing one divisor makes a softness control feel dead at large cell sizes — 36× weaker at Pixel Size 36 than at 1. Split them:
```glsl
float aaFloor = 1.2 / max(pixelSize, 1.0);
return clamp(aaFloor * min(soft, 1.0) + 0.35 * max(soft - 1.0, 0.0), 0.0, 0.6);
```

### Two structures, one pitch
If two overlaid patterns share a pitch they must share a PHASE. Scanlines used bare `F.y` while the mask used `F.y + stag` — same pitch, different offset, so they beat against each other. Pass the same offset to both.

### Hard lookups alias
Integer cell lookups (`if (row == 0) ... if (col <= 2) ...`) have NO antialiasing, so no softness control can ever reach them. At large cell sizes = raw blocky bars. Rewrite as continuous fields with soft bands. Compose terms rather than branch, and keep edges symmetric so the mean survives:
```glsl
float3 res = float3(gridValue) * (1.0 - lit) + rgb;  // rgb sums to lit inside stripes
```

### Shape and space
- Evaluate a physical outline in SCREEN space, not in the distorted space. A tube's faceplate is a fixed outline on the glass; the raster bows INSIDE it. Getting this backwards made the tube shrink as distortion rose and slice corners off square.
- **Superellipse beats rounded rect** for anything physical. `|x|ⁿ + |y|ⁿ = 1`. A rounded rect is straight edges plus four arcs with a curvature discontinuity at the joint; a real faceplate has no joint. Map radius → exponent: `n = 1/r`, so half the short side is a true ellipse, a quarter is n=4, small approaches a sharp rect.
- A field need not be a true SDF. If antialiasing takes a finite-difference gradient and normalises by it, any monotonic field works — only the zero crossing must be right.
- Exact rounded-box SDF needs the interior term or it's wrong inside corner arcs:
  `length(max(q,0)) + min(max(q.x,q.y),0) - r`

### Optics
- **Starburst core is SHARP and that's correct** — it's the diffraction pattern's central lobe. But a photograph never shows it bare: the same lens that diffracts also SCATTERS, so the core sits inside a veiling glow. Without that it reads as a drawn asterisk. Add an emitter-centred glow.
- **Halo is centred on FRAME CENTRE, not the emitter** — internal reflections are centred on the optical axis wherever the source sits. Only element placement never moves.
- **Ghosts must not resample the highlight buffer** — that echoes the image, sharp. Ghosts are APERTURE SHAPES filled with the source's integrated colour.
- Auto flare placement = **brightest point** (argmax + local refine), not centroid. Centroid of a thresholded region lands mid-frame and looks broken.
- Split colour from brightness. Two separate source dropdowns (image vs manual) is what people actually want.
- Cat's-eye bokeh (barrel clips the aperture toward frame edge) is the strongest cue a defocus came from a real lens.
- Chromatic dispersion is glass acting on real light. Over invented picture (clamp/mirror fill) it's meaningless — but users may still prefer it. Ask before removing.
- Vertical hold roll must WRAP (`fract`). Rolling picture with a black band is wrong.

### Bloom vs diffusion — different things
- **Bloom** adds only the part of the blur BRIGHTER than the pixel. Haloes highlights, leaves flat areas alone.
- **Diffusion** adds the blur OUTRIGHT. Lifts everything, washes blacks to grey. That veiling is why a real tube never looks truly black and why a lit room kills its contrast.
- Gate them on `bloom > 0 || diffusion > 0`, never on bloom alone — CRT presets want diffusion with bloom at zero.

### Controls
- A control whose meaning inverts the intuition needs saying out loud. "Scanline Thickness" = fraction LIT, so 0.05 is a hairline, and energy normalisation makes that hairline BRIGHTER than its surround rather than gaps going darker.
- Prefer one control that does the right thing by default over three that need tuning.

---

## 6. Verification

- Green checker proves the bundle is WELL FORMED. Never that a filter LOOKS right. Compiling has twice hidden a filter doing nothing.
- **Judge brightness in the viewport, not `snapshot_layer`** — snapshots render filtered content markedly darker. Caused one wrong diagnosis. Snapshots fine for geometry and hue.
- Debugging intermediates: build a probe filter that prints them as colour channels. Brand-new types register without restart. This is what finally found the fold-to-zero.
- Restart Cavalry after ANY `.sksl` change. Ask; don't assume.
- Three failed hypotheses in a row means the model is wrong, not the tuning. Stop and measure.

---

## 7. Licensing

Kit is **AGPL-3.0**. Floor set by `flim`.

- **BSL-1.0 = Boost**, permissive. NOT Business Source Licence. Don't confuse them.
- Apache-2.0 folds one-way into AGPL. LGPL-3 folds in fine.
- "No licence stated" = not usable. Repo description is not a licence; check for a LICENSE file AND the README (GitHub's API reports null when a README declares one).
- Credits live in `docs/CREDITS.md`, split `## Code used` / `## Inspiration`. Don't invent citations for papers — ask for title and authors.

---

## 7b. Performance — techniques worth reaching for

From reading paper-design/shaders. Several apply to filters already shipped.

- **SkSL has no `dFdx`/`dFdy`/`fwidth`, and that is usually fine.** In nearly
  every case the derivative is of a KNOWN AFFINE function of the coordinate, so
  it is a constant you can compute: `patternPeriod / resolution.y`. That is more
  accurate than the GPU's 2x2-quad estimate, not less.
- **Derivative-width strokes are free supersampling for a periodic feature.**
  Draw the mark's antialiasing band two PIXELS wide expressed in CELL units.
  When the cells go sub-pixel the band swallows the cell and the pattern greys
  out to flat tone instead of moireing. Verified on Linear Refraction at 2px flutes.
  Every periodic filter wants this — hatching, print's screen, led, display's
  mask, ascii.
- **Non-power-of-two lacunarity** (2.1, 1.99, 1.1). Octaves never align, so
  three read as many more. Godray still runs 6 octaves x 3 angles = 18 Perlin
  evaluations per pixel; 3-4 at 2.1 would be indistinguishable.
- **`pow(noise, 1..4)` instead of extra octaves** to thin a field — a quarter
  the cost.
- **A product of two sparse fields is far sparser than either.** Crisp shafts,
  cheaper than fbm. This is what Godray's Light Field mode is.
- **Cubic in place of `pow`**: `clamp(8*f*f*f, 0, 1)`, `n = n*n` for contrast.
- **Value noise + cubic smoothstep, not simplex** unless gradient noise is
  actually needed. Value noise's axis-aligned blockiness is sometimes the POINT
  (in polar space it becomes radial banding, which reads as light shafts).
- **One field, many outputs.** Water evaluates each of its two noise fields
  exactly once and reuses them for distortion, tint, glint and alpha.
- **Uniform-driven branch skipping as doctrine.** Every layer skipped when its
  own uniform is 0. All fragments take the same path, so there is no divergence
  — this is what makes a five-layer paper model affordable at defaults.
- **Compute both and `mix`** rather than branching on a blend mode.
- Do NOT copy their tap counts: gooey halftone is 36-72 taps/px, and gem-smoke
  reads its texture with a 90-tap kernel, 81 of which are a 9x9 that is
  separable into 18 and simply was not separated. Copy the maths, not the loop.

## 8. Working with this repo

- Leave readme.md alone.
- `src/build.cjs --deploy` then `node scripts/check-bundle.cjs`. Both green before looking at anything.
- Two agents must never share a file. Fold-ins touching the same shader go to ONE agent.
- Delegate writing. Keep verification and "does this look right" here.
