/**
 * USDZ to GLB Converter — Main Application Script
 * =================================================
 * This file handles:
 *   1. Drag-and-drop / click-to-browse file upload
 *   2. Three.js scene setup (camera, renderer, lights, controls)
 *   3. Loading USDZ files with Three.js USDLoader (supports USDA + USDC binary)
 *   4. Real-time rotation via sliders
 *   5. Pivot point (origin) adjustment with XYZ gizmo
 *   6. Ghost wireframe overlay showing original model orientation
 *   7. Ground plane grid for spatial reference
 *   8. Exporting the scene to GLB with GLTFExporter
 *
 * All processing happens client-side — no server required.
 *
 * SCENE HIERARCHY (when a model is loaded):
 *
 *   scene
 *    ├── lights, gridHelper, axesGizmo
 *    ├── ghostGroup            ← transparent wireframe of original orientation
 *    └── pivotGroup            ← always at (0,0,0); rotation applied HERE
 *          └── innerModel      ← the loaded model; offset by -pivot values
 *
 *   The GLTFExporter exports `pivotGroup`, so the model's world-space
 *   position and rotation are exactly what the user sees in the preview.
 *
 * ARCHITECTURE NOTE:
 *   File-upload event listeners are registered FIRST, before any
 *   Three.js initialisation.  This guarantees that even if the 3D
 *   setup fails (e.g. WebGL not available), the upload zone still
 *   reacts and the user sees a meaningful error instead of a dead page.
 */

// ============================================================
// Imports
// ============================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
// USDLoader (dev branch) replaces the old USDZLoader and adds a pure-JS
// USDC binary Crate parser, so both ASCII (USDA) and binary (USDC) USDZ
// files are supported without any WASM or special server headers.
import { USDLoader }     from 'three/addons/loaders/USDLoader.js';
import { GLTFExporter }  from 'three/addons/exporters/GLTFExporter.js';
import { USDZExporter }  from 'three/addons/exporters/USDZExporter.js';
// mergeVertices de-duplicates identical vertices and creates an index
// buffer, dramatically reducing GLB file size for non-indexed geometry.
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
// fflate is bundled with Three.js and used internally by USDLoader
// for unzipping USDZ archives.  We import it for our own fallback
// texture-extraction when the loader fails to resolve texture paths.
import { unzipSync }     from 'three/addons/libs/fflate.module.js';
// Import USDComposer so we can monkey-patch _buildGeometry to also
// extract primvars:displayColor as per-vertex colors.  The stock
// implementation only takes the first RGB triple for a flat material
// colour and ignores any per-vertex/per-face data.
import { USDComposer }   from 'three/addons/loaders/usd/USDComposer.js';

// ============================================================
// MONKEY-PATCH: Add per-vertex displayColor support to USDComposer
// ============================================================
// Save the original _buildGeometry so we can call it and then
// augment the returned geometry with vertex colour data.
const _origBuildGeometry = USDComposer.prototype._buildGeometry;

USDComposer.prototype._buildGeometry = function (path, fields, hasSkinning) {
    // Call the original to get the geometry with position, normal, uv, etc.
    const geometry = _origBuildGeometry.call(this, path, fields, hasSkinning);

    // --- Add vertex colours from primvars:displayColor ---
    const displayColor = fields['primvars:displayColor'];
    if (!displayColor || displayColor.length < 6) {
        // 3 or fewer values = single flat colour (already handled by _buildMesh)
        return geometry;
    }

    const posAttr = geometry.getAttribute('position');
    if (!posAttr) return geometry;
    const numVertices = posAttr.count;
    const numColors   = displayColor.length / 3;

    const points            = fields['points'];
    const numPoints         = points ? points.length / 3 : 0;
    const faceVertexIndices = fields['faceVertexIndices'];
    const faceVertexCounts  = fields['faceVertexCounts'];
    const colorIndices      = fields['primvars:displayColor:indices'];

    console.log(`[USDZ→GLB patch] displayColor: ${numColors} colours, geometry: ${numVertices} vertices, points: ${numPoints}, faceVertexIndices: ${faceVertexIndices ? faceVertexIndices.length : 'none'}`);

    let vertexColors;

    if (numColors === numVertices) {
        // Direct 1:1 match — already in the right format
        vertexColors = new Float32Array(displayColor);

    } else if (numColors === numPoints && faceVertexIndices && faceVertexCounts) {
        // Per-point colours (same count as unique points in the mesh).
        // The positions were expanded from points via:
        //   _expandAttribute(points, triangulatedIndices, 3)
        // We need to do the same expansion for displayColor.
        // Re-create the triangulated indices the same way _buildGeometry does.
        const polygonHoles = fields['primvars:arnold:polygon_holes'];
        const holeMap = this._buildHoleMap ? this._buildHoleMap(polygonHoles) : new Map();
        const result = this._triangulateIndicesWithPattern(
            faceVertexIndices, faceVertexCounts, points, holeMap
        );
        const triIndices = result.indices;
        vertexColors = new Float32Array(this._expandAttribute(displayColor, triIndices, 3));
        console.log(`[USDZ→GLB patch] Expanded per-point colours via triangulated indices (${triIndices.length} indices).`);

    } else if (numColors === (faceVertexIndices ? faceVertexIndices.length : 0) && faceVertexCounts) {
        // Per-face-vertex colours (one colour per original face-vertex, pre-triangulation).
        // Need to apply the same triangulation pattern used for normals/UVs.
        const polygonHoles = fields['primvars:arnold:polygon_holes'];
        const holeMap = this._buildHoleMap ? this._buildHoleMap(polygonHoles) : new Map();
        const result = this._triangulateIndicesWithPattern(
            faceVertexIndices, faceVertexCounts, points, holeMap
        );
        const triPattern = result.pattern;
        // Apply pattern: generate sequential indices for the colour stream
        const colorStreamIndices = Array.from({ length: numColors }, (_, i) => i);
        const triColorIndices = this._applyTriangulationPattern(colorStreamIndices, triPattern);
        vertexColors = new Float32Array(this._expandAttribute(displayColor, triColorIndices, 3));
        console.log(`[USDZ→GLB patch] Expanded per-face-vertex colours via triangulation pattern.`);

    } else if (colorIndices && colorIndices.length > 0 && faceVertexCounts) {
        // Indexed colours with explicit index array — expand through triangulation
        const polygonHoles = fields['primvars:arnold:polygon_holes'];
        const holeMap = this._buildHoleMap ? this._buildHoleMap(polygonHoles) : new Map();
        const result = this._triangulateIndicesWithPattern(
            faceVertexIndices, faceVertexCounts, points, holeMap
        );
        const triPattern = result.pattern;
        const triColorIndices = this._applyTriangulationPattern(
            Array.from(colorIndices), triPattern
        );
        vertexColors = new Float32Array(this._expandAttribute(displayColor, triColorIndices, 3));
        console.log(`[USDZ→GLB patch] Expanded indexed colours via triangulation pattern.`);

    } else if (faceVertexCounts && numColors === faceVertexCounts.length) {
        // Per-face uniform colours — one colour per face
        vertexColors = new Float32Array(numVertices * 3);
        let vi = 0;
        for (let f = 0; f < faceVertexCounts.length && vi < numVertices; f++) {
            const r = displayColor[f * 3 + 0];
            const g = displayColor[f * 3 + 1];
            const b = displayColor[f * 3 + 2];
            const triCount = Math.max(faceVertexCounts[f] - 2, 1);
            for (let t = 0; t < triCount * 3 && vi < numVertices; t++, vi++) {
                vertexColors[vi * 3 + 0] = r;
                vertexColors[vi * 3 + 1] = g;
                vertexColors[vi * 3 + 2] = b;
            }
        }
        console.log(`[USDZ→GLB patch] Expanded per-face uniform colours.`);

    } else {
        // Fallback — repeat cyclically
        console.log(`[USDZ→GLB patch] Colour count mismatch (${numColors} vs ${numVertices} verts). Using cyclic fallback.`);
        vertexColors = new Float32Array(numVertices * 3);
        for (let i = 0; i < numVertices; i++) {
            const ci = i % numColors;
            vertexColors[i * 3 + 0] = displayColor[ci * 3 + 0];
            vertexColors[i * 3 + 1] = displayColor[ci * 3 + 1];
            vertexColors[i * 3 + 2] = displayColor[ci * 3 + 2];
        }
    }

    if (vertexColors) {
        geometry.setAttribute('color',
            new THREE.BufferAttribute(vertexColors, 3));
        console.log(`[USDZ→GLB patch] Applied ${numVertices} vertex colours to geometry.`);
    }

    return geometry;
};

// Helper to expand displayColor through triangulation, matching
// what _buildGeometry does for positions/normals.
USDComposer.prototype._expandDisplayColor = function (
    colors, indices, faceVertexCounts, targetVertexCount
) {
    if (!faceVertexCounts) {
        // No face structure — just expand via indices
        const result = new Float32Array(targetVertexCount * 3);
        for (let i = 0; i < targetVertexCount; i++) {
            const ci = indices ? indices[i] : i;
            result[i * 3 + 0] = colors[ci * 3 + 0] || 0;
            result[i * 3 + 1] = colors[ci * 3 + 1] || 0;
            result[i * 3 + 2] = colors[ci * 3 + 2] || 0;
        }
        return result;
    }

    // Triangulate: for each polygon with N vertices, fan-triangulate into
    // (N-2) triangles.  This mirrors _buildGeometry's triangulation.
    const result = new Float32Array(targetVertexCount * 3);
    let srcIdx = 0;   // index into the face-vertex colour stream
    let dstIdx = 0;   // index into the output vertex colour array

    for (let f = 0; f < faceVertexCounts.length; f++) {
        const count = faceVertexCounts[f];
        // Gather this face's colour values
        const faceColors = [];
        for (let v = 0; v < count; v++) {
            const ci = indices ? indices[srcIdx + v] : (srcIdx + v);
            faceColors.push(
                colors[ci * 3 + 0] || 0,
                colors[ci * 3 + 1] || 0,
                colors[ci * 3 + 2] || 0
            );
        }
        // Fan-triangulate: triangle i uses vertices [0, i+1, i+2]
        for (let t = 0; t < count - 2; t++) {
            // vertex 0
            result[dstIdx++] = faceColors[0];
            result[dstIdx++] = faceColors[1];
            result[dstIdx++] = faceColors[2];
            // vertex t+1
            result[dstIdx++] = faceColors[(t + 1) * 3 + 0];
            result[dstIdx++] = faceColors[(t + 1) * 3 + 1];
            result[dstIdx++] = faceColors[(t + 1) * 3 + 2];
            // vertex t+2
            result[dstIdx++] = faceColors[(t + 2) * 3 + 0];
            result[dstIdx++] = faceColors[(t + 2) * 3 + 1];
            result[dstIdx++] = faceColors[(t + 2) * 3 + 2];
        }
        srcIdx += count;
    }

    return result;
};

// Also patch _buildMesh to enable vertexColors on the material
// when we've added a 'color' attribute to the geometry.
const _origBuildMesh = USDComposer.prototype._buildMesh;

USDComposer.prototype._buildMesh = function (path, spec) {
    const mesh = _origBuildMesh.call(this, path, spec);

    // If our patched _buildGeometry added vertex colours, enable them on the material
    if (mesh && mesh.geometry && mesh.geometry.getAttribute('color')) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of mats) {
            if (!mat) continue;
            mat.vertexColors = true;
            mat.color.set(0xffffff);  // reset so vertex colours aren't tinted
            mat.needsUpdate = true;
        }
        console.log(`[USDZ→GLB patch] Enabled vertexColors on material for "${mesh.name}".`);
    }

    return mesh;
};

// ============================================================
// DOM Element References
// ============================================================
const dropZone            = document.getElementById('dropZone');
const fileInput           = document.getElementById('fileInput');
const fileInfo            = document.getElementById('fileInfo');
const fileNameEl          = document.getElementById('fileName');
const clearFileBtn        = document.getElementById('clearFileBtn');
const statusBar           = document.getElementById('statusBar');
const statusMessage       = document.getElementById('statusMessage');
const previewContainer    = document.getElementById('previewContainer');
const previewPlaceholder  = document.getElementById('previewPlaceholder');
const loadingOverlay      = document.getElementById('loadingOverlay');
const controlsSection     = document.getElementById('controlsSection');
const rotXSlider          = document.getElementById('rotX');
const rotYSlider          = document.getElementById('rotY');
const rotZSlider          = document.getElementById('rotZ');
const rotXNum             = document.getElementById('rotXNum');
const rotYNum             = document.getElementById('rotYNum');
const rotZNum             = document.getElementById('rotZNum');
const pivotXInput         = document.getElementById('pivotX');
const pivotYInput         = document.getElementById('pivotY');
const pivotZInput         = document.getElementById('pivotZ');
const resetBtn            = document.getElementById('resetBtn');
const centerPivotBtn      = document.getElementById('centerPivotBtn');
const convertBtn          = document.getElementById('convertBtn');
const convertUsdzBtn      = document.getElementById('convertUsdzBtn');

// ============================================================
// Application State
// ============================================================

/** The outer group that sits at the scene origin. Rotation is applied here.
 *  This is what gets exported to GLB. */
let pivotGroup = null;

/** The actual loaded model mesh, child of pivotGroup.
 *  Its position is offset by -pivot to move the origin point. */
let innerModel = null;

/** Cached bounding box of the model (in its own local space, after initial centering).
 *  Used to set sensible min/max on the pivot inputs. */
let modelBBox = null;

/** The original file name (used when saving the GLB) */
let originalFileName = '';

/** Three.js core objects — initialised in initThree() */
let scene, camera, renderer, controls;

/** XYZ axes gizmo (THREE.AxesHelper) shown at the origin */
let axesGizmo = null;

/** Ground plane grid (THREE.GridHelper) for spatial orientation */
let gridHelper = null;

/** Ghost wireframe group showing the original model orientation.
 *  This is a clone of the model rendered as transparent wireframe
 *  so the user can see how their transforms differ from the original. */
let ghostGroup = null;

/** Whether Three.js initialised successfully */
let threeReady = false;

/** Preview normalization values — saved during addModelToScene() so
 *  the export pipeline can undo them and restore native scale/position.
 *  Without undoing these, exports would be in "viewport units" (~2 units
 *  max dimension) rather than the model's original coordinate system. */
let previewCenterOffset = new THREE.Vector3();
let previewScaleFactor  = 1;

// ============================================================
// HELPER FUNCTIONS — Status Messages
// ============================================================

function showStatus(message, type = 'info') {
    statusBar.classList.remove('hidden', 'status-info', 'status-error', 'status-success', 'status-warning');
    statusBar.classList.add(`status-${type}`);
    statusMessage.textContent = message;
}

function hideStatus() {
    statusBar.classList.add('hidden');
}

function showLoading()  { loadingOverlay.classList.remove('hidden'); }
function hideLoading()  { loadingOverlay.classList.add('hidden'); }

// ============================================================
// HELPER FUNCTIONS — Texture Loading
// ============================================================

/**
 * Wait for every texture in a scene graph to finish loading its image.
 *
 * USDLoader.parse() creates Texture objects whose `.image` is an
 * HTMLImageElement with `src` set to a blob URL.  The image decode is
 * asynchronous — `parse()` returns before the images are ready.
 * Without waiting, the preview starts without textures and, more
 * critically, GLTFExporter will silently drop any texture whose
 * `.image` hasn't loaded yet.
 *
 * @param {THREE.Object3D} object — the loaded model (or any subtree)
 * @returns {Promise<void>} resolves when every pending image is ready
 */
function waitForTextures(object) {
    const pending = [];
    const seen = new Set();          // avoid duplicating promises for shared textures

    object.traverse((child) => {
        if (!child.isMesh) return;

        const materials = Array.isArray(child.material)
            ? child.material
            : [child.material];

        for (const mat of materials) {
            if (!mat) continue;
            // Iterate all properties looking for Texture instances
            for (const key of Object.keys(mat)) {
                const value = mat[key];
                if (value && value.isTexture && !seen.has(value.uuid)) {
                    seen.add(value.uuid);

                    const img = value.image;
                    if (img instanceof HTMLImageElement && !img.complete) {
                        pending.push(
                            new Promise((resolve, reject) => {
                                img.addEventListener('load', () => {
                                    value.needsUpdate = true;   // tell Three.js to re-upload
                                    resolve();
                                }, { once: true });
                                img.addEventListener('error', () => {
                                    console.warn('[USDZ→GLB] Texture image failed to load:', img.src);
                                    resolve();     // resolve anyway so we don't block on one broken texture
                                }, { once: true });
                            })
                        );
                    }
                }
            }
        }
    });

    console.log(`[USDZ→GLB] Waiting for ${pending.length} texture(s) to decode…`);
    return Promise.all(pending);
}

// ============================================================
// HELPER FUNCTIONS — Fallback Texture Extraction
// ============================================================

/**
 * Extract all embedded image files from a USDZ archive.
 *
 * A USDZ file is a standard ZIP containing one or more USD files and
 * any referenced texture images (PNG / JPG).  If the USDLoader's
 * composer fails to resolve texture paths (a known issue with certain
 * USD authoring tools), this function gives us the raw images so we
 * can apply them as a fallback.
 *
 * @param {ArrayBuffer} arrayBuffer — the raw USDZ file bytes
 * @returns {Array<{name: string, blobUrl: string, type: string}>}
 */
function extractImagesFromUSDZ(arrayBuffer) {
    const images = [];
    try {
        const bytes = new Uint8Array(arrayBuffer);
        // Verify it's a ZIP (PK magic bytes)
        if (bytes[0] !== 0x50 || bytes[1] !== 0x4B) {
            console.log('[USDZ→GLB] Not a ZIP file (no PK header).');
            return images;
        }

        const zip = unzipSync(bytes);

        // Debug: list ALL files in the archive
        const allFiles = Object.keys(zip);
        console.log(`[USDZ→GLB] USDZ archive contains ${allFiles.length} file(s):`);
        for (const f of allFiles) {
            const size = zip[f].byteLength || zip[f].length || 0;
            console.log(`[USDZ→GLB]   "${f}" (${size} bytes)`);
        }

        // --- Phase 1: Look for standalone image files in the archive ---
        for (const filename in zip) {
            const lower = filename.toLowerCase();
            let mimeType = null;
            if (lower.endsWith('.png'))                                  mimeType = 'image/png';
            else if (lower.endsWith('.jpg') || lower.endsWith('.jpeg'))  mimeType = 'image/jpeg';
            else continue;

            const blob = new Blob([zip[filename]], { type: mimeType });
            const blobUrl = URL.createObjectURL(blob);
            images.push({ name: filename, blobUrl, type: mimeType });
            console.log(`[USDZ→GLB] Extracted image file from archive: "${filename}" (${mimeType})`);
        }

        // --- Phase 2: If no standalone images, scan binary USD files for
        //     embedded PNG/JPEG data using magic byte signatures.
        //     Some authoring tools (Reality Composer Pro, Blender, etc.)
        //     embed texture data directly inside the USDC crate binary. ---
        if (images.length === 0) {
            console.log('[USDZ→GLB] No standalone image files — scanning USD binaries for embedded textures…');
            for (const filename in zip) {
                const lower = filename.toLowerCase();
                if (!lower.endsWith('.usd') && !lower.endsWith('.usdc') && !lower.endsWith('.usda')) continue;

                const fileBytes = zip[filename];
                const embedded = scanForEmbeddedImages(fileBytes);
                for (let i = 0; i < embedded.length; i++) {
                    const { data, type } = embedded[i];
                    const blob = new Blob([data], { type });
                    const blobUrl = URL.createObjectURL(blob);
                    const ext = type === 'image/png' ? 'png' : 'jpg';
                    const name = `embedded_${i}.${ext}`;
                    images.push({ name, blobUrl, type });
                    console.log(`[USDZ→GLB] Found embedded ${ext.toUpperCase()} in "${filename}" (${data.byteLength} bytes) → "${name}"`);
                }
            }
        }
    } catch (err) {
        console.warn('[USDZ→GLB] Failed to extract images from USDZ archive:', err);
    }
    return images;
}

/**
 * Scan a binary buffer for embedded PNG and JPEG images using magic bytes.
 *
 * PNG files start with: 89 50 4E 47 0D 0A 1A 0A
 * PNG files end with:   49 45 4E 44 AE 42 60 82  (IEND chunk CRC)
 *
 * JPEG files start with: FF D8 FF
 * JPEG files end with:   FF D9
 *
 * @param {Uint8Array} bytes — the raw binary data to scan
 * @returns {Array<{data: Uint8Array, type: string}>}
 */
function scanForEmbeddedImages(bytes) {
    const results = [];
    const len = bytes.length;

    // --- Scan for PNG ---
    // PNG signature: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
    const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    // PNG end (IEND chunk): 0x49 0x45 0x4E 0x44 0xAE 0x42 0x60 0x82
    const PNG_END = [0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82];

    for (let i = 0; i <= len - 8; i++) {
        if (matchBytes(bytes, i, PNG_SIG)) {
            // Found PNG start — now find the IEND trailer
            for (let j = i + 8; j <= len - 8; j++) {
                if (matchBytes(bytes, j, PNG_END)) {
                    const endPos = j + 8;
                    const imgData = bytes.slice(i, endPos);
                    if (imgData.length > 64) {   // sanity: skip tiny fragments
                        results.push({ data: imgData, type: 'image/png' });
                        console.log(`[USDZ→GLB] PNG found at offset ${i}, length ${imgData.length}`);
                    }
                    i = endPos - 1;   // skip past this image
                    break;
                }
            }
        }
    }

    // --- Scan for JPEG ---
    // JPEG start: 0xFF 0xD8 0xFF
    // JPEG end:   0xFF 0xD9
    for (let i = 0; i <= len - 3; i++) {
        if (bytes[i] === 0xFF && bytes[i + 1] === 0xD8 && bytes[i + 2] === 0xFF) {
            // Found JPEG start — find the EOI marker (FF D9)
            for (let j = i + 3; j <= len - 2; j++) {
                if (bytes[j] === 0xFF && bytes[j + 1] === 0xD9) {
                    const endPos = j + 2;
                    const imgData = bytes.slice(i, endPos);
                    if (imgData.length > 64) {   // sanity: skip tiny fragments
                        results.push({ data: imgData, type: 'image/jpeg' });
                        console.log(`[USDZ→GLB] JPEG found at offset ${i}, length ${imgData.length}`);
                    }
                    i = endPos - 1;   // skip past this image
                    break;
                }
            }
        }
    }

    return results;
}

/**
 * Check if bytes at a given offset match a signature.
 */
function matchBytes(bytes, offset, signature) {
    for (let i = 0; i < signature.length; i++) {
        if (bytes[offset + i] !== signature[i]) return false;
    }
    return true;
}

/**
 * Load an image from a blob URL and return a ready-to-use THREE.Texture.
 *
 * @param {string} blobUrl — the object URL for the image
 * @returns {Promise<THREE.Texture>}
 */
function loadTextureFromBlobUrl(blobUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const texture = new THREE.Texture(img);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.needsUpdate = true;
            resolve(texture);
        };
        img.onerror = () => {
            console.warn('[USDZ→GLB] Failed to decode texture image:', blobUrl);
            reject(new Error('Image decode failed'));
        };
        img.src = blobUrl;
    });
}

/**
 * Fallback: if USDLoader failed to attach textures, manually extract
 * images from the USDZ archive and apply them to materials.
 *
 * Heuristic: we look at each mesh material.  If it has no `.map`
 * (diffuse texture), we try to match an extracted image by name
 * (looking for common patterns like the mesh name or "diffuse",
 * "basecolor", "albedo").  If the archive only contains a single
 * image we just use that for every textureless material.
 *
 * @param {THREE.Group} group       — the parsed model
 * @param {ArrayBuffer}  arrayBuffer — the raw USDZ file (for re-extraction)
 */
async function applyFallbackTextures(group, arrayBuffer) {
    // Check how many meshes lack a diffuse map
    const untexturedMeshes = [];
    group.traverse((child) => {
        if (child.isMesh && child.material && !child.material.map) {
            untexturedMeshes.push(child);
        }
    });

    if (untexturedMeshes.length === 0) return;   // all good, nothing to fix

    console.log(`[USDZ→GLB] ${untexturedMeshes.length} mesh(es) have no diffuse map — attempting fallback texture extraction…`);

    const images = extractImagesFromUSDZ(arrayBuffer);
    if (images.length === 0) {
        console.log('[USDZ→GLB] No images found inside the USDZ archive.');
        return;
    }

    console.log(`[USDZ→GLB] Found ${images.length} image(s) in the archive. Attempting to match to meshes…`);

    for (const mesh of untexturedMeshes) {
        const meshName = (mesh.name || '').toLowerCase();
        let bestMatch = null;

        // Try to find a matching image by mesh name or common texture keywords
        for (const img of images) {
            const imgName = img.name.toLowerCase();
            const imgBase = imgName.split('/').pop().replace(/\.[^.]+$/, '');

            // Direct mesh name match
            if (meshName && imgBase.includes(meshName.replace(/_LOD\d+$/i, '').toLowerCase())) {
                bestMatch = img;
                break;
            }
            // Common diffuse/albedo/basecolor keywords
            if (/diffuse|basecolor|albedo|base_color|color/i.test(imgBase)) {
                bestMatch = img;
                // Don't break — keep looking for a more specific match
            }
        }

        // If there's only one image in the archive, use it (very common for simple models)
        if (!bestMatch && images.length === 1) {
            bestMatch = images[0];
        }

        // If we still have no match, use the first image as a last resort
        if (!bestMatch) {
            bestMatch = images[0];
        }

        if (bestMatch) {
            try {
                const texture = await loadTextureFromBlobUrl(bestMatch.blobUrl);
                mesh.material.map = texture;
                mesh.material.color.set(0xffffff);   // reset tint so texture shows correctly
                mesh.material.needsUpdate = true;
                console.log(`[USDZ→GLB] Applied fallback texture "${bestMatch.name}" → mesh "${mesh.name}"`);
            } catch (err) {
                console.warn(`[USDZ→GLB] Could not apply texture to "${mesh.name}":`, err);
            }
        }
    }
}

/**
 * Extract printable ASCII strings from a binary buffer.
 * Similar to the Unix `strings` command.
 *
 * @param {Uint8Array} bytes — binary data
 * @param {number} minLen — minimum string length to include
 * @returns {string[]}
 */
function extractStringsFromBinary(bytes, minLen = 6) {
    const results = [];
    let current = '';
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b >= 0x20 && b < 0x7F) {
            current += String.fromCharCode(b);
        } else {
            if (current.length >= minLen) {
                results.push(current);
            }
            current = '';
        }
    }
    if (current.length >= minLen) results.push(current);
    return results;
}

// ============================================================
// HELPER FUNCTIONS — Per-Vertex displayColor Extraction
// ============================================================

/**
 * Extract per-vertex displayColor data from the USDC binary by
 * re-parsing it with USDCParser and walking the spec/field tree.
 *
 * The Three.js USDComposer reads `primvars:displayColor` but only
 * uses the first RGB triple as a flat material color.  If the USD
 * file has per-vertex or per-face colors (common in CAD/scan data),
 * that data is discarded.  This function recovers it.
 *
 * @param {ArrayBuffer} arrayBuffer — the raw USDZ file bytes
 * @returns {Float32Array|null} — per-vertex RGB data (3 floats per vertex), or null
 */
function extractDisplayColors(arrayBuffer) {
    try {
        const bytes = new Uint8Array(arrayBuffer);

        // Unzip the USDZ archive
        let usdcBytes = bytes;
        if (bytes[0] === 0x50 && bytes[1] === 0x4B) {
            const zip = unzipSync(bytes);
            for (const fname in zip) {
                const lower = fname.toLowerCase();
                if (lower.endsWith('.usd') || lower.endsWith('.usdc')) {
                    usdcBytes = zip[fname];
                    break;
                }
            }
        }

        // Parse the USDC crate
        const parser = new USDCParser();
        const parsed = parser.parseData(usdcBytes);

        if (!parsed || !parsed.specsByPath) {
            console.log('[USDZ→GLB] USDCParser returned no specs.');
            return null;
        }

        const specPaths = Object.keys(parsed.specsByPath);
        console.log(`[USDZ→GLB] Re-parsed USDC. ${specPaths.length} specs found. Looking for displayColor…`);

        // Debug: dump all specs with their field keys
        for (const path of specPaths) {
            const spec = parsed.specsByPath[path];
            if (!spec || !spec.fields) continue;
            const fieldNames = Object.keys(spec.fields);
            const hasColor = fieldNames.some(f => /color/i.test(f));
            const hasPoints = fieldNames.includes('points');
            if (hasColor || hasPoints || fieldNames.length > 3) {
                console.log(`[USDZ→GLB]   spec "${path}" → fields: [${fieldNames.join(', ')}]`);
                // Show displayColor-related fields in detail
                for (const fn of fieldNames) {
                    if (/color|display/i.test(fn)) {
                        const val = spec.fields[fn];
                        const info = Array.isArray(val) ? `Array(${val.length})` :
                                     (val && val.length !== undefined) ? `TypedArray(${val.length})` :
                                     JSON.stringify(val);
                        console.log(`[USDZ→GLB]     "${fn}" = ${info}`);
                    }
                }
            }
        }

        // Walk the spec tree looking for primvars:displayColor with per-vertex data
        for (const path in parsed.specsByPath) {
            const spec = parsed.specsByPath[path];
            if (!spec || !spec.fields) continue;

            // Try multiple possible field names
            const displayColor = spec.fields['primvars:displayColor']
                              || spec.fields['displayColor']
                              || spec.fields['primvars:displayColor:default'];
            if (!displayColor) continue;

            console.log(`[USDZ→GLB] Found displayColor at "${path}", length: ${displayColor.length}, type: ${typeof displayColor}, isArray: ${Array.isArray(displayColor)}`);

            // A single flat color is just 3 values [r, g, b]
            // Per-vertex colors will have many more (numVertices * 3)
            if (displayColor.length > 3) {
                console.log(`[USDZ→GLB] displayColor has ${displayColor.length / 3} color entries — this is per-vertex/per-face color data!`);

                // Also check for displayColor indices (interpolation)
                const colorIndices = spec.fields['primvars:displayColor:indices'];
                const interpolation = spec.fields['primvars:displayColor:interpolation'];
                console.log(`[USDZ→GLB] displayColor interpolation: ${interpolation || 'not specified'}, indices: ${colorIndices ? colorIndices.length : 'none'}`);

                return {
                    colors: new Float32Array(displayColor),
                    indices: colorIndices || null,
                    interpolation: interpolation || 'vertex'
                };
            } else {
                console.log(`[USDZ→GLB] displayColor has only ${displayColor.length} values — single flat color, not per-vertex.`);
            }
        }

        return null;
    } catch (err) {
        console.warn('[USDZ→GLB] Failed to extract displayColor from USDC:', err);
        return null;
    }
}

/**
 * Apply per-vertex displayColor data to a mesh's geometry and material.
 *
 * @param {THREE.Group} group       — the parsed model group
 * @param {ArrayBuffer}  arrayBuffer — the raw USDZ file bytes (for re-parsing)
 */
function applyVertexColors(group, arrayBuffer) {
    const colorData = extractDisplayColors(arrayBuffer);
    if (!colorData) return;

    const { colors, indices, interpolation } = colorData;

    group.traverse((child) => {
        if (!child.isMesh) return;
        const geometry = child.geometry;
        if (!geometry) return;

        const posAttr = geometry.getAttribute('position');
        if (!posAttr) return;
        const numVertices = posAttr.count;

        console.log(`[USDZ→GLB] Mesh "${child.name}" has ${numVertices} vertices. displayColor has ${colors.length / 3} entries.`);

        let vertexColors;

        if (indices && indices.length > 0) {
            // Indexed colors — expand using indices
            vertexColors = new Float32Array(numVertices * 3);
            for (let i = 0; i < numVertices && i < indices.length; i++) {
                const ci = indices[i];
                vertexColors[i * 3 + 0] = colors[ci * 3 + 0];
                vertexColors[i * 3 + 1] = colors[ci * 3 + 1];
                vertexColors[i * 3 + 2] = colors[ci * 3 + 2];
            }
        } else if (colors.length / 3 === numVertices) {
            // Direct per-vertex colors (same count as vertices)
            vertexColors = colors;
        } else if (colors.length / 3 > numVertices) {
            // More color entries than vertices — might be pre-triangulation face-vertex data
            // The geometry has already been triangulated by USDComposer, so the vertex
            // count should match the expanded positions. Just use the first numVertices entries.
            vertexColors = colors.slice(0, numVertices * 3);
        } else {
            // Fewer colors than vertices — might be per-face "uniform" interpolation
            // Spread each face color across its vertices (approximation)
            console.log(`[USDZ→GLB] Color count (${colors.length / 3}) doesn't match vertex count (${numVertices}). Attempting face-color expansion.`);
            vertexColors = new Float32Array(numVertices * 3);
            // Simple fallback: repeat the available colors cyclically
            for (let i = 0; i < numVertices; i++) {
                const ci = i % (colors.length / 3);
                vertexColors[i * 3 + 0] = colors[ci * 3 + 0];
                vertexColors[i * 3 + 1] = colors[ci * 3 + 1];
                vertexColors[i * 3 + 2] = colors[ci * 3 + 2];
            }
        }

        // Add color attribute to geometry
        geometry.setAttribute('color', new THREE.BufferAttribute(vertexColors, 3));

        // Enable vertex colors on the material
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const mat of mats) {
            if (!mat) continue;
            mat.vertexColors = true;
            mat.color.set(0xffffff);  // reset material color so vertex colors show correctly
            mat.needsUpdate = true;
        }

        console.log(`[USDZ→GLB] Applied ${numVertices} vertex colors to "${child.name}".`);
    });
}

// ============================================================
// 1. FILE UPLOAD — Drag & Drop + Click to Browse
// ============================================================
// Registered FIRST so they work even if Three.js init fails.

document.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
document.addEventListener('drop',     (e) => { e.preventDefault(); e.stopPropagation(); });

dropZone.addEventListener('click', () => { fileInput.click(); });
fileInput.addEventListener('click', (e) => { e.stopPropagation(); });

fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
        handleFile(e.target.files[0]);
    }
});

dropZone.addEventListener('dragenter', (e) => {
    e.preventDefault(); e.stopPropagation();
    dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault(); e.stopPropagation();
    dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault(); e.stopPropagation();
    dropZone.classList.remove('drag-over');
});
dropZone.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    dropZone.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (files && files.length > 0) handleFile(files[0]);
});

// ============================================================
// 2. FILE VALIDATION & LOADING
// ============================================================

function handleFile(file) {
    hideStatus();

    const name = file.name.toLowerCase();
    if (!name.endsWith('.usdz')) {
        showStatus('Please upload a .usdz file.', 'error');
        return;
    }
    if (file.size === 0) {
        showStatus('The file appears to be empty.', 'error');
        return;
    }
    if (!threeReady) {
        showStatus('3D engine failed to initialise. Check the browser console for errors.', 'error');
        return;
    }

    originalFileName = file.name.replace(/\.usdz$/i, '');
    fileNameEl.textContent = file.name;
    fileInfo.classList.remove('hidden');

    loadUSDZ(file);
}

/**
 * Read the file as an ArrayBuffer and pass it to the USDLoader.
 * USDLoader (Three.js dev branch) supports both USDA (ASCII) and USDC (binary Crate).
 *
 * IMPORTANT: USDLoader.parse() returns *before* embedded texture images
 * have finished decoding (they use async blob URL → HTMLImageElement).
 * We explicitly wait for all textures via waitForTextures() so that:
 *   • the 3D preview shows materials from the first frame
 *   • GLTFExporter receives fully-loaded textures when exporting GLB
 */
function loadUSDZ(file) {
    showLoading();
    previewPlaceholder.classList.add('hidden');
    showStatus('Loading USDZ file…', 'info');

    const reader = new FileReader();

    reader.onload = async (e) => {
        try {
            const loader = new USDLoader();
            const arrayBuffer = e.target.result;
            const group = loader.parse(arrayBuffer);

            // Check if the loader produced any meshes
            let meshCount = 0;
            let textureCount = 0;
            group.traverse((child) => {
                if (child.isMesh) {
                    meshCount++;
                    // Count textures for debug info
                    const mats = Array.isArray(child.material) ? child.material : [child.material];
                    for (const mat of mats) {
                        if (!mat) continue;
                        for (const key of Object.keys(mat)) {
                            if (mat[key] && mat[key].isTexture) textureCount++;
                        }
                    }
                }
            });

            console.log(`[USDZ→GLB] Parsed: ${meshCount} mesh(es), ${textureCount} texture reference(s)`);

            // --- Dump USD text content if USDA, or check for asset paths in binary ---
            try {
                const zipBytes = new Uint8Array(arrayBuffer);
                const zip2 = unzipSync(zipBytes);
                for (const fname in zip2) {
                    const fileData = zip2[fname];
                    // Check if this is USDA (ASCII) — starts with "#usda"
                    const header = String.fromCharCode(...fileData.slice(0, 20));
                    if (header.startsWith('#usda')) {
                        const text = new TextDecoder().decode(fileData);
                        // Find material-related sections
                        const lines = text.split('\n');
                        const materialLines = lines.filter(l =>
                            /material|shader|surface|texture|diffuse|color|albedo|roughness|metallic|normal|opacity|map|asset|\.png|\.jpg|\.jpeg/i.test(l)
                        );
                        console.log(`[USDZ→GLB] USDA material-related lines (${materialLines.length}):`);
                        materialLines.forEach(l => console.log('  ', l.trim()));
                    } else {
                        // USDC binary — scan for readable strings that look like paths/textures
                        console.log(`[USDZ→GLB] "${fname}" is binary USDC. Scanning for string tokens…`);
                        const strings = extractStringsFromBinary(fileData, 6);
                        const materialStrings = strings.filter(s =>
                            /material|shader|surface|texture|diffuse|color|albedo|roughness|metallic|normal|opacity|\.png|\.jpg|\.jpeg|asset|inputs:/i.test(s)
                        );
                        console.log(`[USDZ→GLB] Relevant strings found (${materialStrings.length}):`);
                        materialStrings.slice(0, 50).forEach(s => console.log('  ', s));
                    }
                }
            } catch (dbgErr) {
                console.warn('[USDZ→GLB] Debug USD scan failed:', dbgErr);
            }

            // --- Detailed material debug dump ---
            group.traverse((child) => {
                if (!child.isMesh) return;
                const mat = child.material;
                const matType = mat ? mat.type : 'NO MATERIAL';
                const hasMap = mat && mat.map ? 'yes' : 'no';
                const color = mat && mat.color ? `#${mat.color.getHexString()}` : 'none';
                const metalness = mat && mat.metalness !== undefined ? mat.metalness : 'N/A';
                const roughness = mat && mat.roughness !== undefined ? mat.roughness : 'N/A';
                // Check geometry attributes for vertex colors
                const geomAttrs = child.geometry ? Object.keys(child.geometry.attributes) : [];
                const hasVertexColors = geomAttrs.includes('color');
                const vertexColorUsed = mat && mat.vertexColors;
                console.log(`[USDZ→GLB]   Mesh "${child.name}" → ${matType}, color: ${color}, map: ${hasMap}, metalness: ${metalness}, roughness: ${roughness}, geomAttrs: [${geomAttrs.join(', ')}], hasVertexColors: ${hasVertexColors}, mat.vertexColors: ${vertexColorUsed}`);
                if (mat) {
                    const texKeys = Object.keys(mat).filter(k => mat[k] && mat[k].isTexture);
                    if (texKeys.length > 0) {
                        for (const k of texKeys) {
                            const tex = mat[k];
                            const img = tex.image;
                            const imgStatus = img instanceof HTMLImageElement
                                ? (img.complete ? `loaded (${img.naturalWidth}×${img.naturalHeight})` : 'pending')
                                : (img ? `${typeof img} / ${img.constructor?.name}` : 'null');
                            console.log(`[USDZ→GLB]     texture "${k}" → image: ${imgStatus}`);
                        }
                    }
                }
            });

            if (meshCount === 0) {
                hideLoading();
                showStatus(
                    'The file loaded but contained no visible geometry. It may use unsupported USD features.',
                    'warning'
                );
                addModelToScene(group);
                controlsSection.classList.remove('hidden');
                return;
            }

            // Wait for all texture images to finish decoding from their
            // blob URLs before adding to the scene.  This ensures the
            // preview shows materials immediately and GLB export works.
            if (textureCount > 0) {
                showStatus('Loading textures…', 'info');
            }
            await waitForTextures(group);
            console.log('[USDZ→GLB] All textures decoded.');

            // FALLBACK: If the USDLoader produced meshes without textures,
            // try to recover colour data from the USDC binary.
            if (textureCount === 0) {
                // Step 1: Check for per-vertex displayColor primvar data.
                // Many CAD/scan USDZ files use this instead of image textures.
                showStatus('Resolving colours…', 'info');
                applyVertexColors(group, arrayBuffer);

                // Step 2: If still no colour data, try extracting images.
                let hasColors = false;
                group.traverse((child) => {
                    if (child.isMesh && child.geometry && child.geometry.getAttribute('color')) {
                        hasColors = true;
                    }
                });
                if (!hasColors) {
                    await applyFallbackTextures(group, arrayBuffer);
                }
            }

            console.log('[USDZ→GLB] Adding model to scene.');
            addModelToScene(group);
            hideLoading();
            showStatus(`Model loaded successfully! (${meshCount} mesh${meshCount > 1 ? 'es' : ''})`, 'success');
            controlsSection.classList.remove('hidden');
        } catch (err) {
            hideLoading();
            console.error('USDZ parse error:', err);
            showStatus(`Failed to parse USDZ file: ${err.message || 'Unknown error'}`, 'error');
        }
    };

    reader.onerror = () => {
        hideLoading();
        showStatus('Failed to read the file. Please try again.', 'error');
    };

    reader.readAsArrayBuffer(file);
}

// ============================================================
// 3. THREE.JS INITIALISATION
// ============================================================

function initThree() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1d27);

    camera = new THREE.PerspectiveCamera(50, 16 / 10, 0.01, 1000);
    camera.position.set(0, 1, 3);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    previewContainer.appendChild(renderer.domElement);

    resizeRendererToContainer();

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance   = 0.1;
    controls.maxDistance   = 50;

    // Lighting
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const mainLight = new THREE.DirectionalLight(0xffffff, 1.2);
    mainLight.position.set(5, 8, 5);
    scene.add(mainLight);
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.6);
    fillLight.position.set(-3, 4, -3);
    scene.add(fillLight);
    scene.add(new THREE.HemisphereLight(0xb1e1ff, 0x886633, 0.4));

    // Animation loop
    function animate() {
        requestAnimationFrame(animate);
        resizeRendererToContainer();
        controls.update();
        renderer.render(scene, camera);
    }
    animate();

    threeReady = true;
}

function resizeRendererToContainer() {
    const canvas = renderer.domElement;
    const displayWidth  = canvas.clientWidth;
    const displayHeight = canvas.clientHeight;

    const needResize =
        canvas.width  !== Math.round(displayWidth  * window.devicePixelRatio) ||
        canvas.height !== Math.round(displayHeight * window.devicePixelRatio);

    if (needResize && displayWidth > 0 && displayHeight > 0) {
        renderer.setSize(displayWidth, displayHeight, false);
        camera.aspect = displayWidth / displayHeight;
        camera.updateProjectionMatrix();
    }
}

try {
    initThree();
} catch (err) {
    console.error('Three.js initialisation failed:', err);
    showStatus(`3D engine error: ${err.message}. Try a different browser or enable WebGL.`, 'error');
}

// ============================================================
// 4. ADDING THE MODEL TO THE SCENE
// ============================================================

/**
 * Remove any previously loaded model, then set up the nested group
 * hierarchy (pivotGroup → innerModel) and create the axes gizmo.
 */
function addModelToScene(group) {
    // --- Clean up previous model and helpers ---
    cleanupSceneObjects();

    // --- Debug ---
    let meshCount = 0;
    group.traverse((child) => { if (child.isMesh) meshCount++; });
    console.log('[USDZ→GLB] Model children:', group.children.length, '| Meshes:', meshCount);

    // --- Center the model at the origin ---
    const box    = new THREE.Box3().setFromObject(group);
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    console.log('[USDZ→GLB] Bounding box size:', size, '| center:', center);

    // Shift so the model's center is at (0,0,0)
    group.position.sub(center);

    // Uniform scale so the largest dimension fits in ~2 units
    const maxDim = Math.max(size.x, size.y, size.z);
    let scaleFactor = 1;
    if (maxDim > 0) {
        scaleFactor = 2 / maxDim;
        group.scale.set(scaleFactor, scaleFactor, scaleFactor);
    }

    // Save normalization values so the export pipeline can undo them
    previewCenterOffset.copy(center);
    previewScaleFactor = scaleFactor;

    // --- Store the bounding box in scaled space for pivot input ranges ---
    const scaledBox = new THREE.Box3().setFromObject(group);
    modelBBox = scaledBox;

    // --- Set pivot input min/max/step based on model size ---
    const scaledSize = scaledBox.getSize(new THREE.Vector3());
    const largestDim = Math.max(scaledSize.x, scaledSize.y, scaledSize.z);
    const range = largestDim * 1.5;
    const step = range > 10 ? 0.1 : 0.01;

    [pivotXInput, pivotYInput, pivotZInput].forEach((input) => {
        input.min  = (-range).toFixed(3);
        input.max  = range.toFixed(3);
        input.step = step;
        input.value = 0;
    });

    // --- Build the nested group hierarchy ---
    pivotGroup = new THREE.Group();
    pivotGroup.name = 'pivotGroup';
    innerModel = group;
    innerModel.name = 'innerModel';
    pivotGroup.add(innerModel);
    scene.add(pivotGroup);

    // --- Create the ghost wireframe (original orientation reference) ---
    ghostGroup = createGhostClone(group);
    scene.add(ghostGroup);

    // --- Create the ground plane grid ---
    // Grid size is based on the model, with enough cells to look good.
    const gridSize = Math.ceil(largestDim * 2);   // diameter of the model × 2
    const gridDivisions = 20;
    gridHelper = new THREE.GridHelper(
        gridSize,
        gridDivisions,
        0x444466,   // center line color (subtle)
        0x2a2a3a    // grid line color (very subtle)
    );
    // Grid sits at y=0 (world origin) — consistent with the axes gizmo.
    gridHelper.position.y = 0;
    scene.add(gridHelper);

    // --- Create the axes gizmo at the origin ---
    const gizmoSize = largestDim * 0.3;
    axesGizmo = new THREE.AxesHelper(Math.max(gizmoSize, 0.2));
    scene.add(axesGizmo);

    // --- Reset camera ---
    camera.position.set(0, 1, 3);
    controls.target.set(0, 0, 0);
    controls.update();

    // --- Reset all controls ---
    resetAll();

    // Force a render
    renderer.render(scene, camera);
    console.log('[USDZ→GLB] Canvas size:',
                renderer.domElement.clientWidth, '×', renderer.domElement.clientHeight,
                '| Buffer:', renderer.domElement.width, '×', renderer.domElement.height);
}

/**
 * Remove all model-related objects from the scene and free GPU memory.
 */
function cleanupSceneObjects() {
    if (pivotGroup) {
        scene.remove(pivotGroup);
        disposeObject(pivotGroup);
        pivotGroup = null;
        innerModel = null;
    }
    if (ghostGroup) {
        scene.remove(ghostGroup);
        disposeObject(ghostGroup);
        ghostGroup = null;
    }
    if (axesGizmo) {
        scene.remove(axesGizmo);
        axesGizmo.dispose();
        axesGizmo = null;
    }
    if (gridHelper) {
        scene.remove(gridHelper);
        gridHelper.dispose();
        gridHelper = null;
    }
    modelBBox = null;
}

/**
 * Create a transparent wireframe clone of the model to show its
 * original orientation.  The ghost sits directly in the scene
 * (not inside pivotGroup), so it's unaffected by rotation/pivot changes.
 *
 * @param {THREE.Object3D} source — The centered+scaled model group
 * @returns {THREE.Group} A new group containing wireframe copies of all meshes
 */
function createGhostClone(source) {
    const ghost = new THREE.Group();
    ghost.name = 'ghostGroup';

    // Copy the source's position and scale so the ghost matches
    // the original model placement exactly.
    ghost.position.copy(source.position);
    ghost.scale.copy(source.scale);

    source.traverse((child) => {
        if (!child.isMesh) return;

        // Create a wireframe version of each mesh's geometry
        const wireGeo = new THREE.WireframeGeometry(child.geometry);
        const wireMat = new THREE.LineBasicMaterial({
            color: 0x6c63ff,        // primary/purple tint
            transparent: true,
            opacity: 0.15,
            depthWrite: false,       // so it doesn't occlude the real model
        });
        const wireMesh = new THREE.LineSegments(wireGeo, wireMat);

        // Copy the mesh's local transform so the wireframe sits in the
        // correct position within the group.
        wireMesh.position.copy(child.position);
        wireMesh.rotation.copy(child.rotation);
        wireMesh.scale.copy(child.scale);

        // If the mesh is nested inside sub-groups, we need its world
        // transform relative to the source group.
        // Compute it by getting the child's world matrix and then
        // removing the source's world matrix contribution.
        if (child.parent !== source) {
            child.updateWorldMatrix(true, false);
            source.updateWorldMatrix(true, false);
            const relativeMatrix = new THREE.Matrix4();
            relativeMatrix.copy(source.matrixWorld).invert();
            relativeMatrix.multiply(child.matrixWorld);
            wireMesh.matrix.copy(relativeMatrix);
            wireMesh.matrixAutoUpdate = false;
        }

        ghost.add(wireMesh);
    });

    return ghost;
}

/**
 * Show the ghost wireframe when any transform (rotation or pivot) differs
 * from the default values.  Hide it when everything is at zero — at that
 * point the ghost would overlap the real model exactly and just look messy.
 */
function updateGhostVisibility() {
    if (!ghostGroup) return;

    const hasRotation =
        parseInt(rotXSlider.value, 10) !== 0 ||
        parseInt(rotYSlider.value, 10) !== 0 ||
        parseInt(rotZSlider.value, 10) !== 0;

    const hasPivot =
        (parseFloat(pivotXInput.value) || 0) !== 0 ||
        (parseFloat(pivotYInput.value) || 0) !== 0 ||
        (parseFloat(pivotZInput.value) || 0) !== 0;

    ghostGroup.visible = hasRotation || hasPivot;
}

function disposeObject(obj) {
    obj.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            for (const mat of materials) {
                for (const key of Object.keys(mat)) {
                    const value = mat[key];
                    if (value && value.isTexture) value.dispose();
                }
                mat.dispose();
            }
        }
    });
}

// ============================================================
// 5. ROTATION SLIDERS — Real-Time Preview Updates
// ============================================================

function degToRad(deg) {
    return deg * (Math.PI / 180);
}

/**
 * Sync all rotation controls (sliders + number inputs) and apply
 * rotation to the pivotGroup.  Called whenever any rotation control
 * changes.  The `source` parameter indicates which control triggered
 * the update so we don't create feedback loops.
 *
 * @param {'slider'|'number'} [source='slider']
 */
function updateRotation(source = 'slider') {
    if (!pivotGroup) return;

    let x, y, z;

    if (source === 'number') {
        // Number inputs are the source — clamp and sync back to sliders
        x = clampDeg(parseInt(rotXNum.value, 10) || 0);
        y = clampDeg(parseInt(rotYNum.value, 10) || 0);
        z = clampDeg(parseInt(rotZNum.value, 10) || 0);
        rotXSlider.value = x;
        rotYSlider.value = y;
        rotZSlider.value = z;
    } else {
        // Slider is the source — sync to number inputs
        x = parseInt(rotXSlider.value, 10);
        y = parseInt(rotYSlider.value, 10);
        z = parseInt(rotZSlider.value, 10);
    }

    // Keep number inputs in sync
    rotXNum.value = x;
    rotYNum.value = y;
    rotZNum.value = z;

    pivotGroup.rotation.set(degToRad(x), degToRad(y), degToRad(z));

    // Show/hide the ghost based on whether any transform has changed
    updateGhostVisibility();
}

/** Wrap degrees to 0-360 range */
function clampDeg(v) {
    return ((v % 360) + 360) % 360;
}

// Slider → update
rotXSlider.addEventListener('input', () => updateRotation('slider'));
rotYSlider.addEventListener('input', () => updateRotation('slider'));
rotZSlider.addEventListener('input', () => updateRotation('slider'));

// Number input → update
rotXNum.addEventListener('input', () => updateRotation('number'));
rotYNum.addEventListener('input', () => updateRotation('number'));
rotZNum.addEventListener('input', () => updateRotation('number'));

// Nudge arrow buttons (◀ / ▶)
document.querySelectorAll('.btn-nudge').forEach((btn) => {
    btn.addEventListener('click', () => {
        const axisId = btn.dataset.axis;             // 'rotX', 'rotY', or 'rotZ'
        const dir    = parseInt(btn.dataset.dir, 10); // -1 or +1
        const slider = document.getElementById(axisId);
        if (!slider) return;

        const current = parseInt(slider.value, 10);
        slider.value = clampDeg(current + dir);
        updateRotation('slider');
    });
});

// ============================================================
// 6. PIVOT POINT CONTROLS
// ============================================================

/**
 * Apply the current position offset values.
 *
 * Positive values move the model in the positive axis direction:
 *   +X = right,  +Y = up,  +Z = towards camera
 *
 * Rotation still happens around the world origin (0,0,0), so
 * offsetting the model changes which part of it sits at the origin.
 */
function updatePivot() {
    if (!innerModel) return;

    const px = parseFloat(pivotXInput.value) || 0;
    const py = parseFloat(pivotYInput.value) || 0;
    const pz = parseFloat(pivotZInput.value) || 0;

    innerModel.position.set(px, py, pz);

    // Show/hide the ghost based on whether any transform has changed
    updateGhostVisibility();
}

pivotXInput.addEventListener('input', updatePivot);
pivotYInput.addEventListener('input', updatePivot);
pivotZInput.addEventListener('input', updatePivot);

/**
 * Reset pivot back to center (0,0,0).
 */
function centerPivot() {
    pivotXInput.value = 0;
    pivotYInput.value = 0;
    pivotZInput.value = 0;
    updatePivot();
}

centerPivotBtn.addEventListener('click', centerPivot);

// ============================================================
// 7. RESET ALL
// ============================================================

/**
 * Reset both rotation sliders and pivot inputs to zero.
 */
function resetAll() {
    rotXSlider.value = 0;
    rotYSlider.value = 0;
    rotZSlider.value = 0;
    updateRotation();

    pivotXInput.value = 0;
    pivotYInput.value = 0;
    pivotZInput.value = 0;
    updatePivot();
}

resetBtn.addEventListener('click', resetAll);

// ============================================================
// 8. CLEAR / REMOVE MODEL
// ============================================================

clearFileBtn.addEventListener('click', () => {
    cleanupSceneObjects();

    fileInfo.classList.add('hidden');
    fileInput.value = '';
    controlsSection.classList.add('hidden');
    previewPlaceholder.classList.remove('hidden');
    hideStatus();
    resetAll();
    originalFileName = '';
});

// ============================================================
// 9. GLB EXPORT
// ============================================================

/**
 * Quantize Float32 vertex colours (0-1 range) to Uint8 (0-255).
 *
 * GLB stores colours as normalised uint8 when the accessor component
 * type is GL_UNSIGNED_BYTE.  Three.js GLTFExporter will detect a
 * Uint8 BufferAttribute with `normalized = true` and write it as
 * an 8-bit accessor automatically.  This reduces colour storage from
 * 12 bytes/vertex (3×float32) to 3 bytes/vertex — a 4× saving.
 *
 * Additionally, quantising colours means many vertices that were
 * "unique" only due to tiny float rounding differences in their
 * colour values become truly identical, allowing mergeVertices()
 * to de-duplicate them effectively.
 *
 * @param {THREE.BufferGeometry} geometry
 */
function quantizeVertexColors(geometry) {
    const colorAttr = geometry.getAttribute('color');
    if (!colorAttr) return;

    const count = colorAttr.count;
    const itemSize = colorAttr.itemSize;           // 3 (RGB) or 4 (RGBA)
    const src = colorAttr.array;                   // Float32Array

    const uint8 = new Uint8Array(count * itemSize);
    for (let i = 0; i < count * itemSize; i++) {
        uint8[i] = Math.round(Math.min(1, Math.max(0, src[i])) * 255);
    }

    // `normalized = true` tells Three.js (and the GLB accessor) that
    // the uint8 values represent 0.0-1.0 when divided by 255.
    geometry.setAttribute('color',
        new THREE.BufferAttribute(uint8, itemSize, true));
}

/**
 * Quantize Float32 normals to Int8 normalized (-128..127 → -1..1).
 *
 * Normal vectors only need ~256 discrete directions per axis —
 * the visual difference from Float32 is imperceptible.  This cuts
 * normal storage from 12 bytes/vertex (3×f32) to 3 bytes/vertex (3×i8).
 *
 * @param {THREE.BufferGeometry} geometry
 */
function quantizeNormals(geometry) {
    const attr = geometry.getAttribute('normal');
    if (!attr) return;

    const count = attr.count;
    const src   = attr.array;                       // Float32Array
    const int8  = new Int8Array(count * 3);

    for (let i = 0; i < count * 3; i++) {
        // Clamp to [-1, 1] then scale to [-127, 127]
        int8[i] = Math.round(Math.min(1, Math.max(-1, src[i])) * 127);
    }

    geometry.setAttribute('normal',
        new THREE.BufferAttribute(int8, 3, true));  // normalized = true
}

/**
 * Build an optimised, baked-transform clone of the model for export.
 *
 * Shared by both GLB and USDZ export paths.  Returns a scene graph
 * where every node has identity transforms and meshes have:
 *   - Vertex positions/normals in world space (baked)
 *   - Colours quantised to Uint8
 *   - Normals recomputed as smooth and quantised to Int8
 *   - Duplicate vertices merged with an index buffer
 *
 * @returns {Promise<THREE.Group>} the optimised clone ready for export
 */
async function buildOptimisedExportClone() {
    await waitForTextures(pivotGroup);

    showStatus('Optimising geometry…', 'info');
    await new Promise((r) => setTimeout(r, 50));

    const exportTarget = pivotGroup.clone(true);

    // --- Deep-clone each mesh's geometry ---
    // clone(true) shares BufferGeometry by reference, so any mutation
    // (applyMatrix4, quantize, deleteAttribute) would corrupt the
    // live scene.  We deep-copy each geometry to isolate the export.
    exportTarget.traverse((child) => {
        if (child.isMesh) {
            child.geometry = child.geometry.clone();
        }
    });

    // --- Bake all transforms into vertex data ---
    // Multiply each mesh's world matrix into its geometry so the
    // exported file has identity transforms on every node.  This
    // guarantees consistent orientation across all viewers
    // (Android Scene Viewer is strict about this).
    exportTarget.updateMatrixWorld(true);
    exportTarget.traverse((child) => {
        if (child.isMesh) {
            child.geometry.applyMatrix4(child.matrixWorld);
        }
        // Reset every node's local transform to identity
        child.position.set(0, 0, 0);
        child.quaternion.identity();
        child.scale.set(1, 1, 1);
        // Force the local .matrix to be recomposed from the (now identity)
        // decomposed properties.  Without this, the USDZExporter reads
        // the stale .matrix that still contains the old preview transforms,
        // causing duplicate scale/offset in the exported file.
        child.updateMatrix();
    });

    // --- Undo preview scale normalization ---
    // The baked world transform includes the uniform scale factor that
    // was applied in addModelToScene() to fit the model into the viewport.
    // We undo that here so the exported model preserves the original
    // file's native scale.  Only the user's rotation/position adjustments
    // remain.
    //
    // Note: we do NOT undo the centering offset.  The centering puts the
    // model's center of mass at the origin, which is the natural export
    // position.  The user's Position controls adjust relative to this
    // centered position — restoring the original file's arbitrary world
    // offset would produce an unexpected shift in the exported file.
    {
        const invScale = 1 / previewScaleFactor;
        const undoScale = new THREE.Matrix4().makeScale(invScale, invScale, invScale);
        exportTarget.traverse((child) => {
            if (!child.isMesh) return;
            child.geometry.applyMatrix4(undoScale);
        });
        console.log(`[Export] Undid preview scale: ×${invScale.toFixed(4)}`);
    }

    // --- Optimise each mesh ---
    exportTarget.traverse((child) => {
        if (!child.isMesh) return;

        const geo = child.geometry;
        const before = geo.getAttribute('position').count;

        // Step 1: Quantize colours to Uint8 (normalized)
        quantizeVertexColors(geo);

        // Step 2: Strip normals before merging.
        // USDLoader expands geometry per-face-vertex, so normals
        // at shared triangle edges differ per-face, preventing
        // vertex deduplication.  We recompute smooth normals after.
        geo.deleteAttribute('normal');

        // Step 3: De-duplicate vertices (comparing position + color only)
        try {
            child.geometry = mergeVertices(child.geometry, 1e-4);
        } catch (err) {
            console.warn('[Export] mergeVertices failed:', err);
        }

        // Step 4: Recompute smooth normals on the indexed geometry
        child.geometry.computeVertexNormals();

        // Step 5: Quantize normals to Int8 (3 bytes vs 12 bytes/vertex)
        quantizeNormals(child.geometry);

        const after = child.geometry.getAttribute('position').count;
        const idxCount = child.geometry.index ? child.geometry.index.count : 0;
        console.log(`[Export] optimise: ${before} → ${after} vertices, ${idxCount} indices (${((1 - after / before) * 100).toFixed(1)}% reduction)`);
    });

    return exportTarget;
}

// --- GLB Export ---
convertBtn.addEventListener('click', async () => {
    if (!pivotGroup) {
        showStatus('No model loaded. Please upload a USDZ file first.', 'warning');
        return;
    }

    showStatus('Preparing GLB export…', 'info');
    convertBtn.disabled = true;
    convertUsdzBtn.disabled = true;

    try {
        const exportTarget = await buildOptimisedExportClone();

        showStatus('Converting to GLB…', 'info');
        await new Promise((r) => setTimeout(r, 50));

        const exporter = new GLTFExporter();
        exporter.parse(
            exportTarget,
            (result) => {
                const sizeKB = Math.round(result.byteLength / 1024);
                console.log(`[Export] GLB size: ${sizeKB} KB`);
                downloadBlob(result, `${originalFileName || 'model'}.glb`, 'model/gltf-binary');
                showStatus(`GLB file downloaded! (${sizeKB} KB)`, 'success');
                convertBtn.disabled = false;
                convertUsdzBtn.disabled = false;
            },
            (error) => {
                console.error('GLB export error:', error);
                showStatus(`GLB export failed: ${error.message || 'Unknown error'}`, 'error');
                convertBtn.disabled = false;
                convertUsdzBtn.disabled = false;
            },
            { binary: true }
        );
    } catch (err) {
        console.error('GLB export error:', err);
        showStatus(`GLB export failed: ${err.message || 'Unknown error'}`, 'error');
        convertBtn.disabled = false;
        convertUsdzBtn.disabled = false;
    }
});

// --- USDZ Export ---
convertUsdzBtn.addEventListener('click', async () => {
    if (!pivotGroup) {
        showStatus('No model loaded. Please upload a USDZ file first.', 'warning');
        return;
    }

    showStatus('Preparing USDZ export…', 'info');
    convertBtn.disabled = true;
    convertUsdzBtn.disabled = true;

    try {
        const exportTarget = await buildOptimisedExportClone();

        showStatus('Converting to USDZ…', 'info');
        await new Promise((r) => setTimeout(r, 50));

        const exporter = new USDZExporter();
        const result = await exporter.parseAsync(exportTarget);

        const sizeKB = Math.round(result.byteLength / 1024);
        console.log(`[Export] USDZ size: ${sizeKB} KB`);
        downloadBlob(result, `${originalFileName || 'model'}_modified.usdz`, 'model/vnd.usdz+zip');
        showStatus(`USDZ file downloaded! (${sizeKB} KB)`, 'success');
    } catch (err) {
        console.error('USDZ export error:', err);
        showStatus(`USDZ export failed: ${err.message || 'Unknown error'}`, 'error');
    } finally {
        convertBtn.disabled = false;
        convertUsdzBtn.disabled = false;
    }
});

function downloadBlob(buffer, filename, mimeType) {
    const blob = new Blob([buffer], { type: mimeType });
    const url  = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href     = url;
    link.download = filename;
    link.style.display = 'none';

    document.body.appendChild(link);
    link.click();

    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

// ============================================================
// 10. INITIAL STATE
// ============================================================

controlsSection.classList.add('hidden');
hideLoading();

console.log('[USDZ→GLB] Script loaded. Three.js ready:', threeReady);
