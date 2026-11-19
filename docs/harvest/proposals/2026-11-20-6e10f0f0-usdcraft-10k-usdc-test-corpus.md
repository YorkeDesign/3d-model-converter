---
harvestry_item: 6e10f0f0-28cb-4afe-8970-d85cfe92c54e
captured: 2026-11-18
proposed: 2026-11-20
status: awaiting-approval   # awaiting-approval | approved | rejected | implemented
approved_by: 
approved_on: 
implemented_commit: 
primary_source: https://huggingface.co/datasets/nvidia/USDCraft-10K
authority: STRONG
informs_decision: threejs-dev-branch-pin
---

# Use NVIDIA's USDCraft-10K as a real-world binary USDC test corpus

**What it is.** NVIDIA published 10,000 simulation-ready 3D objects (Apache-2.0) on Hugging Face. Each object's main file is a binary USD file (`physx/model.usdc`), with physics joints and mass data, and an optional loose `textures/` folder.

**What it would change here.** Nothing in the shipped tool. It gives the project a free, licence-clean set of real binary USDC files, which stable Three.js cannot read and the dev-branch USDLoader Crate parser can. Running a sample of them through the loader would give concrete evidence for the `threejs-dev-branch-pin` decision (does a tagged release, such as r186+, read real USDC, and does the dev parser survive physics schema prims). It also gives a baseline for the "USDC output is 2-5x bigger" question and tests textures that sit beside the USD file rather than inside a USDZ.

**Left behind.** The articulation and physics data itself (Isaac Sim, joints) is out of scope: the converter is a mesh and transform tool. The files are loose USDC, not USDZ, so they need zipping to USDZ (or loader support for folders) to exercise the real input path.

**Why now.** It informs the one live open decision. The post does not state the format; the dataset card does (checked 2026-11-20).

## Implementation plan

1. Download 5 to 10 objects across categories, mixing with and without textures (use the manifest `has_textures` column). Keep them outside the repo (Apache-2.0, but large); record IDs only.
2. Zip each object folder into a USDZ, load it in the tool on the current dev pin and on a tagged release, and record pass or fail plus any console errors in a short doc under `docs/research/`.
3. Export the passing ones to GLB and compare sizes and texture carry-through; note USDC-versus-GLB size ratio.
4. Add the evidence line to the `threejs-dev-branch-pin` decision notes in `PROJECT.yml` in the same commit.

**Effort:** 2 to 3 hours. **Risk:** low; read-only experiment, no product change. Large files could slow the browser, which is itself useful data.
**Cost or requirements:** none (free dataset, Apache-2.0, a few hundred MB of disk).

## Decision

Simon sets `status:` above. `approved` unlocks implementation by a session following the repo's normal verification and commit autonomy; `rejected` needs a one-line reason so the vault records why. Until then nothing is built.
