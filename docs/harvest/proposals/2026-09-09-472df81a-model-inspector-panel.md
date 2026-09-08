---
harvestry_item: 472df81a-0d35-4993-8cd5-1aec5e787d0f
captured: 2026-08-16
proposed: 2026-09-09
status: awaiting-approval
approved_by:
approved_on:
implemented_commit:
primary_source: https://github.com/znkim/gltf-inspector
authority: MEDIUM
informs_decision: none
---

# Show the user what is actually inside the model they loaded

**What it is.** `gltf-inspector` is a small open-source browser tool that opens
a glTF or GLB file and tells you what is in it: the scene tree, every material
and texture, geometry counts, and a validation pass that flags malformed data.
It is the same shape of thing as this repo, client-side and no uploads, but it
reports instead of converts.

**What it would change here.** Today `index.html` gives the user a preview
canvas, rotation and position controls, and two download buttons. Nothing on
screen says how many meshes or triangles the file has, what materials it
carries, whether it has vertex colours, or whether anything is wrong with it.
This proposal adds one collapsible **Model info** panel under
`#controlsSection`, populated by a new `js/inspector.js` from the loaded scene
graph, and a new "Model info" section in `README.md`.

**Why now.** Two independent captures a week apart (`472df81a` and `2d569dd6`)
point at the same idea, and yesterday's proposal (`9fc5e4fd`, GLB export size
report) wants the same numbers on the export side. The counts are computed once
and read twice, so doing this first makes that proposal smaller. It also
touches this project's real failure mode: the USDZ `displayColor` monkey-patch
in `CLAUDE.md` exists because per-vertex colour data is easy to get wrong and
invisible until it renders black. A panel that says "vertex colours: yes,
per-face-vertex" makes that class of bug visible before export, not after.

## Implementation plan

1. `js/inspector.js` (new): one exported function that walks the loaded scene
   with `Object3D.traverse`, and returns mesh count, total triangles, total
   vertices, unique material and texture counts, per-mesh name and triangle
   count, whether any geometry has a `color` attribute, and the world-space
   bounding box dimensions from `Box3.setFromObject`.
2. `index.html`: a collapsed `<details id="modelInfo">` block inside
   `#controlsSection`, above the pivot controls, with a table body the panel
   fills.
3. `css/`: styling matching the existing controls, monospace numbers so digits
   line up.
4. `js/converter.js`: call the inspector once after the model loads (the same
   place `#controlsSection` is unhidden) and once on the export clone, so the
   panel can show a before and after row when `buildOptimisedExportClone()` has
   deduplicated vertices.
5. Verification: load a known USDZ with per-vertex colour and a plain GLB in
   the browser; confirm the triangle count matches what Blender reports for the
   same file, that the vertex-colour flag reads true only for the coloured
   file, and that the export row shows the ~80% vertex reduction the README
   already claims. Nothing is committed until those three match.

**Effort:** 3 to 4 hours. **Risk:** low and contained. It is read-only over the
scene graph and adds no dependency; the one real risk is `traverse` on a very
large model blocking the main thread, contained by computing once per load
rather than per frame. **Cost or requirements:** none. No service, no
dependency, no spend; the referenced repo is a reference, not an import.

## Decision

Simon sets `status:` above. `approved` unlocks implementation by a session
following the repo's normal verification and commit autonomy; `rejected` needs
a one-line reason so the vault records why. Until then nothing is built.
