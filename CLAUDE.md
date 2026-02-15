# USDZ to GLB / USDZ Converter

A browser-based 3D model converter that loads USDZ files, provides a real-time 3D preview with orientation/position controls, and exports to GLB or USDZ format. All processing happens client-side — no server, no uploads.

## Project Structure

```
USDZtoGLB_Converter/
  index.html          Main HTML — upload UI, 3D preview, controls, export info
  css/style.css       Dark-themed stylesheet with CSS variables, responsive layout
  js/converter.js     All application logic (~1,800 lines, single ES module)
  start.bat           Windows launcher — auto-finds free port, opens browser, clean shutdown
```

## How to Run

Double-click `start.bat`, or manually:
```
python -m http.server 8080
```
Then open `http://localhost:8080` in a browser.

A local HTTP server is required because the app uses ES module imports via `<script type="importmap">`, which browsers block on `file://` URLs.

**Known issue:** The Python HTTP server occasionally dies with `ERR_EMPTY_RESPONSE`. Just restart it. `start.bat` handles this with a single double-click.

## Three.js Version

Uses the **Three.js dev branch** via CDN (jsdelivr, pointing at `mrdoob/three.js@dev`). This is required because:
- The new `USDLoader` (replacing the old `USDZLoader`) was merged in PR #32704 (Jan 2026, targeting r183)
- It includes a pure-JavaScript **USDC binary Crate parser** — the stable release only supports USDA (ASCII), which most real-world USDZ files don't use

## Architecture

### Scene Hierarchy

```
scene
  +-- lights (ambient, directional x2, hemisphere)
  +-- gridHelper          Ground plane at y=0
  +-- axesGizmo           RGB axes at world origin
  +-- ghostGroup          Purple wireframe of original orientation (outside pivotGroup)
  +-- pivotGroup          User rotation applied here; this is what gets exported
        +-- innerModel    The loaded model; centering offset + preview scale applied here
              +-- meshes  Actual geometry from the USD file
```

### Key Design Decisions

- **File upload listeners registered before Three.js init** — if WebGL fails, the upload zone still works and shows a meaningful error
- **Ghost wireframe sits outside pivotGroup** — unaffected by user transforms, always shows original orientation
- **Ghost auto-hides** when all transforms are at zero (would overlap the real model)
- **Grid fixed at y=0** (world origin), not at the model's bottom

### Monkey-Patch: Per-Vertex displayColor

The stock Three.js `USDComposer._buildGeometry` only reads the first RGB triple from `primvars:displayColor` for a flat material colour. Many CAD/scan USDZ files (e.g. photogrammetry models) store per-vertex or per-face colour data in this primvar.

We monkey-patch `USDComposer.prototype._buildGeometry` and `_buildMesh` to:
1. Detect when `displayColor` has more than one colour entry
2. Expand colours through the same triangulation pipeline used for positions/normals
3. Handle multiple interpolation modes: per-point, per-face-vertex, indexed, per-face uniform, cyclic fallback
4. Set `mat.vertexColors = true` and reset `mat.color` to white so vertex colours display correctly

## Export Pipeline

Both GLB and USDZ exports share `buildOptimisedExportClone()`:

### 1. Clone and Isolate
```
pivotGroup.clone(true)  ->  deep-clone each mesh's geometry
```
`clone(true)` shares `BufferGeometry` by reference. We explicitly clone each geometry to prevent mutations from corrupting the live scene. **This was a bug** — exporting used to turn the preview model black and change its orientation.

### 2. Bake Transforms
```
exportTarget.updateMatrixWorld(true)
for each mesh: geometry.applyMatrix4(child.matrixWorld)
reset position/quaternion/scale to identity
child.updateMatrix()  // critical for USDZExporter!
```
Baking ensures every node has identity transforms in the exported file. Android Scene Viewer is strict about this — one model appeared face-down before this fix.

**Important:** `child.updateMatrix()` must be called after resetting the decomposed properties. Without it, `object.matrix` retains stale values. GLTFExporter recomputes from decomposed props, but USDZExporter reads `.matrix` directly, causing duplicate transforms (a 5.435x scale and ~180-degree flip were observed).

### 3. Undo Preview Scale
```
invScale = 1 / previewScaleFactor
geometry.applyMatrix4(makeScale(invScale, invScale, invScale))
```
During loading, the model is scaled to fit ~2 viewport units (`2 / maxDim`). This is purely for the preview. The export undoes this so the output file has the model's original native scale.

**Note:** The centering offset is NOT undone. The model's center-of-mass at the origin is the natural export position. The user's Position controls adjust relative to this.

### 4. Optimise Geometry

| Step | What | Why |
|------|------|-----|
| Quantize colours | Float32 -> Uint8 normalized | 4x smaller, enables deduplication |
| Strip normals | `deleteAttribute('normal')` | Per-face normals prevent mergeVertices |
| Merge vertices | `mergeVertices(geo, 1e-4)` | Creates index buffer, ~80% vertex reduction |
| Recompute normals | `computeVertexNormals()` | Smooth normals on indexed geometry |
| Quantize normals | Float32 -> Int8 normalized | 4x smaller |

### GLB File Size Optimisation Journey

Starting point: raw USDLoader output exported to GLB was ~26,367 KB (vs ~5,861 KB from Aspose for the same model).

| Change | Size | Reduction |
|--------|------|-----------|
| Baseline (no optimisation) | 26,367 KB | — |
| + mergeVertices (alone) | 29,291 KB | Worse! (per-vertex colours made every vertex unique) |
| + quantize colours to Uint8 first | 23,244 KB | ~12% |
| + strip normals before merge, recompute after | 6,349 KB | ~73% |
| + quantize normals to Int8 | 5,373 KB | ~8% more |

**Key insight:** `mergeVertices` uses a hash-bucket system that concatenates ALL attributes into a hash string. Two issues prevented deduplication:
1. Float32 colour values had tiny rounding differences — quantising to Uint8 made them identical
2. Normals at shared triangle edges differed per-face (USDLoader expands geometry per-face-vertex) — stripping and recomputing as smooth normals after merging solved this

### USDZ Export Limitations

Three.js `USDZExporter` writes **USDA (ASCII text)**, not USDC (binary Crate). This means:
- Each float becomes ~8-10 bytes of text vs 4 bytes binary
- The USDZ spec mandates **zero compression** in the ZIP container
- Expect exported USDZ files to be **2-5x larger** than the original binary USDZ
- This is an inherent Three.js limitation — fixing it would require writing a USDC binary encoder

## UI Features

### Rotation Controls
- **Sliders** (0-360 degrees per axis) for quick adjustments
- **Nudge buttons** (arrow left/right) for 1-degree increments
- **Number inputs** for typing exact values
- All three stay synced bidirectionally; `clampDeg()` wraps values to 0-360

### Position Controls
- X/Y/Z number inputs with auto-computed min/max/step based on model size
- Positive Y = up (was inverted initially — bug was `position.set(-px, -py, -pz)`, fixed to `position.set(px, py, pz)`)
- "Center Position" button resets to (0,0,0)

### Viewport Legend
Explains the visual elements:
- Green swatch = textured model (exported orientation)
- Purple swatch = wireframe ghost (original USDZ orientation)
- RGB gradient swatch = grid and axes (world origin, Y is up)

### Export Info Panel
Expandable section below export buttons explaining: transform baking, geometry optimisation, colour preservation, normal recomputation, scale preservation, coordinate system, USDZ file size note, local processing.

## Bugs Solved

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| GLB too large (26 MB vs 5 MB expected) | Per-vertex colours as Float32 prevented vertex deduplication | Multi-step: quantize colours, strip normals, merge, recompute, quantize normals |
| Model face-down on Android Scene Viewer | Transforms stored as node properties, not baked into vertices | `geometry.applyMatrix4(child.matrixWorld)` + reset to identity |
| Export corrupts live preview (black, wrong orientation) | `pivotGroup.clone(true)` shares BufferGeometry by reference; mutations corrupt original | Deep-clone each mesh's geometry before any mutations |
| USDZ export 30x wrong scale | Preview normalisation (`2/maxDim` scale) baked into exported vertices | Undo preview scale factor before export |
| USDZ export ~180-degree orientation flip | `child.updateMatrix()` not called after resetting transforms; USDZExporter reads stale `.matrix` | Call `child.updateMatrix()` after setting identity |
| USDZ export unexpected Y offset | Centering offset being restored, shifting model to original file's arbitrary world position | Don't undo centering — keep model at origin |
| Positive Pivot Y moves model down | Code used `position.set(-px, -py, -pz)` | Changed to `position.set(px, py, pz)` |
| Server keeps dying (`ERR_EMPTY_RESPONSE`) | Python HTTP server instability | Created `start.bat` for easy restart |

## Legacy / Unused Code

`converter.js` contains several functions from early debugging that are no longer needed by the monkey-patch approach but remain in the file:

- `extractImagesFromUSDZ()` — scans USDZ archive for image files
- `scanForEmbeddedImages()` — magic-byte scanner for PNG/JPEG in binary
- `matchBytes()` — byte signature matcher
- `loadTextureFromBlobUrl()` — blob URL to THREE.Texture
- `applyFallbackTextures()` — heuristic texture-to-mesh matching
- `extractStringsFromBinary()` — Unix `strings`-like utility
- `extractDisplayColors()` — USDC parser re-parse for displayColor (superseded by monkey-patch)
- `applyVertexColors()` — manual vertex colour application (superseded by monkey-patch)
- `_expandDisplayColor` prototype method on USDComposer

Additionally, `loadUSDZ()` contains extensive debug logging (USDC string scanning, material property dumps) that could be stripped for production.

## Dependencies

All loaded via CDN (no `npm install` needed):

| Package | Source | Purpose |
|---------|--------|---------|
| Three.js (dev) | `cdn.jsdelivr.net/gh/mrdoob/three.js@dev` | 3D engine, scene graph, rendering |
| USDLoader | Three.js addon | Parse USDZ/USDA/USDC files |
| GLTFExporter | Three.js addon | Export to GLB format |
| USDZExporter | Three.js addon | Export to USDZ format |
| OrbitControls | Three.js addon | Mouse-driven camera orbit |
| BufferGeometryUtils | Three.js addon | `mergeVertices()` deduplication |
| fflate | Three.js bundled lib | ZIP decompression for USDZ archives |
| USDComposer | Three.js internal | Monkey-patched for per-vertex displayColor |

## Coordinate Systems

Both USDZ and GLB use **right-handed, Y-up** coordinates. No axis conversion is needed between formats. The Three.js scene also uses Y-up natively. `metersPerUnit = 1` is hardcoded by the USDZExporter.
