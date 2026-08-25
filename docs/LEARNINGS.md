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

## 8. Working with this repo

- Leave readme.md alone.
- `src/build.cjs --deploy` then `node scripts/check-bundle.cjs`. Both green before looking at anything.
- Two agents must never share a file. Fold-ins touching the same shader go to ONE agent.
- Delegate writing. Keep verification and "does this look right" here.
