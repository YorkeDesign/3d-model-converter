# 3D Model Converter

A browser-based tool for converting and adjusting USDZ 3D models. Load a USDZ file, preview it in real-time 3D, adjust orientation and position, then export as GLB or USDZ. Everything runs locally in your browser — no server uploads, no accounts, no installs.

## Features

- **Drag-and-drop upload** — load `.usdz` files instantly
- **Real-time 3D preview** — orbit, zoom, and inspect your model with mouse controls
- **Rotation controls** — sliders, nudge buttons (+/- 1 degree), and direct number input for each axis
- **Position controls** — shift the model relative to the world origin with fine-grained XYZ inputs
- **Ghost wireframe overlay** — see the original orientation alongside your adjustments
- **Export to GLB** — optimised binary format with baked transforms, ~80% vertex reduction
- **Export to USDZ** — re-export with your orientation changes applied
- **Per-vertex colour support** — preserves `primvars:displayColor` data from CAD/photogrammetry models
- **100% client-side** — your files never leave your browser

## Quick Start

### Option 1: Double-click (Windows)
Double-click `start.bat`. It starts a local server, opens your browser, and cleans up when you close it.

### Option 2: Manual
```bash
python -m http.server 8080
```
Then open [http://localhost:8080](http://localhost:8080) in your browser.

> A local HTTP server is required because the app uses ES module imports (`<script type="importmap">`), which browsers block on `file://` URLs.

## How It Works

1. **Upload** a USDZ file via drag-and-drop or file picker
2. **Preview** the model in an interactive 3D viewport
3. **Adjust** rotation (0-360 per axis) and position (XYZ offset)
4. **Export** as GLB or USDZ — transforms are baked into vertex data for maximum viewer compatibility

### What happens during export

- **Transforms are baked** — rotation, position, and scale are applied directly into mesh vertices. Every node in the exported file has identity transforms, ensuring consistent orientation across all viewers (including Android Scene Viewer).
- **Geometry is optimised** — duplicate vertices are merged and indexed, reducing file size by up to 80%.
- **Colours are preserved** — per-vertex colours from the original USDZ are quantised to 8-bit (visually lossless).
- **Normals are recomputed** — smooth vertex normals are recalculated after optimisation.
- **Original scale is preserved** — the preview normalises the model to fit the viewport, but exports restore native scale.
- **Coordinate system** — both USDZ and GLB use right-handed, Y-up. No axis conversion needed.

### USDZ export note

Exported USDZ files will be **2-5x larger** than the original. This is because Three.js writes USDA (ASCII text) format, not USDC (binary). GLB exports use compact binary encoding and will be closer to the original size.

## Tech Stack

All dependencies are loaded via CDN — no `npm install` required.

| Package | Purpose |
|---------|---------|
| [Three.js](https://threejs.org) (dev branch) | 3D engine, scene graph, rendering |
| USDLoader | Parse USDZ/USDA/USDC files |
| GLTFExporter | Export to GLB format |
| USDZExporter | Export to USDZ format |
| OrbitControls | Mouse-driven camera orbit |
| BufferGeometryUtils | Vertex deduplication (`mergeVertices`) |

The dev branch of Three.js is required for the new `USDLoader` with its pure-JavaScript USDC binary Crate parser (PR #32704). The stable release only supports USDA (ASCII), which most real-world USDZ files don't use.

## Project Structure

```
index.html          Main HTML — upload UI, 3D preview, controls, export info
css/style.css       Dark-themed stylesheet with CSS variables, responsive layout
js/converter.js     All application logic (single ES module)
start.bat           Windows launcher — auto port selection, browser open, clean shutdown
```

## License

MIT
