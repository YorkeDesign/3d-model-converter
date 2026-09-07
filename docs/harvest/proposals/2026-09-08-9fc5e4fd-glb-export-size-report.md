---
harvestry_item: 9fc5e4fd-eeb8-4590-9850-792c170e6294
captured: 2026-06-03
proposed: 2026-09-08
status: awaiting-approval   # awaiting-approval | approved | rejected | implemented
approved_by:
approved_on:
implemented_commit:
primary_source: https://x.com/boona11/status/2062053207770124676
authority: WEAK
informs_decision: none
---

# Show the user what the conversion actually saved, and offer real mesh compression

**What it is.** Someone built "GLB Shrink", a browser tool with the same shape
as this one: drop a file in, see a before and after preview, download the
result. Their claimed test went from 58 MB to 869 KB. The interesting part is
not their tool, it is the two things they show that we compute and then throw
away.

**What it would change here.** Two gaps in `js/converter.js`:

1. The export path already knows the output size. `js/converter.js:1734` and
   `js/converter.js:1777` both compute `sizeKB` and send it to `console.log`,
   where no user ever sees it. The input file size and the pre- and post-merge
   triangle counts are equally available and equally discarded.
2. `mergeVertices` at `js/converter.js:1694` is the only size reduction we do.
   There is no Draco or Meshopt stage, and `signal_interests` lists Draco and
   Meshopt compression as a live interest for this project.

**Why now.** The repo is at `stage: beta` with no open decisions declared, so
this answers no live decision. It is a small, contained improvement to the one
thing the tool exists to do. Part 1 is nearly free; part 2 is the part worth
Simon's judgement, because it would add the project's first runtime dependency
beyond Three.js.

## Implementation plan

1. **Size and triangle report (the cheap half).** Capture input `File.size` at
   load, and triangle count before and after `mergeVertices`. Render both next
   to the existing download control in `index.html`, as
   "12.4 MB, 482k tris to 3.1 MB, 190k tris". Touches `js/converter.js` around
   the export block (lines 1690 to 1790) and one block in `index.html`.
2. **Mesh compression (the half needing a decision).** Three.js `GLTFExporter`
   cannot emit Draco or Meshopt; that needs `gltf-transform`, loaded as an ESM
   module through the existing importmap in `index.html:21`. Add it as an
   optional post-export pass behind a checkbox, defaulting off, so the current
   dependency-free path stays the default.
3. **Verification:** convert the same USDZ twice, once with compression off and
   once on. The reported numbers must match the actual downloaded file sizes on
   disk, and both outputs must still open in iOS Quick Look and in the
   viewer's own preview. Re-check that textures survive, which
   `js/converter.js:354` flags as a known silent-drop hazard.

**Effort:** step 1, about 1.5 hours. Step 2, about 4 hours including the Quick
Look round trip. **Risk:** step 1 is display only and cannot corrupt output.
Step 2 can corrupt geometry or drop textures, which is why it is off by default
and gated on the Quick Look check. **Cost or requirements:** none. Both
`gltf-transform` and Three.js addons are free and load from the same CDN
importmap already in use. No accounts, no uploads, no server.

## Decision

Simon sets `status:` above. `approved` unlocks implementation by a session
following the repo's normal verification and commit autonomy; `rejected` needs
a one-line reason so the vault records why. Until then nothing is built.

Approving step 1 alone is a reasonable answer; say so in the status line and a
session will ship only that.
