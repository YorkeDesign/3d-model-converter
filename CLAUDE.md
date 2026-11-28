# USDZ to GLB / USDZ Converter

Harvest approval: gated

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

## Architecture rules (short form)

LONG FORM: `docs/ARCHITECTURE.md`. Each bullet names the heading there that carries the detail, incident history and numbers.

- **Three.js Version** - stay on the `three.js@dev` CDN build. Stable only parses USDA; the dev `USDLoader` carries the USDC binary Crate parser most real USDZ files need.
- **Scene Hierarchy** - user rotation lives on `pivotGroup`, which is what gets exported. The ghost wireframe sits outside it on purpose.
- **Monkey-Patch: Per-Vertex displayColor** - `USDComposer.prototype._buildGeometry` and `_buildMesh` are patched. Any Three.js bump can break it; re-check per-vertex colour after one.
- **Export Pipeline** - `buildOptimisedExportClone()` must deep-clone every geometry before mutating, call `child.updateMatrix()` after baking transforms, and undo the preview scale but not the centering offset.
- **GLB File Size Optimisation Journey** - order matters: quantize colours, strip normals, `mergeVertices`, recompute normals, quantize normals.
- **USDZ Export Limitations** - `USDZExporter` writes USDA text, so exported USDZ is 2-5x the binary original. Not a bug.
- **Bugs Solved** - read the table before touching export, transform or position code; each row is a regression waiting to recur.
- **Legacy / Unused Code** - `converter.js` still holds superseded debug helpers. Do not delete them without asking.
- **Coordinate Systems** - USDZ, GLB and the scene are all right-handed Y-up; no axis conversion.


## Harvestry research vault

This project consumes curated research from Harvestry via the `harvestry` MCP
server. Context: `personal` (personal | fiso). Harvestry project
name: `3d-model-converter`.

The boundary:

- Harvestry curates. Items get captured + triaged + harvested + briefed there.
  We never write items / edges / project schema from this repo.
- We consume. Read tools (`get_project_brief`, `search_inbox`, `get_item`,
  `get_triage`, `get_harvested_updates`, `find_similar_items`, `graph_neighbors`)
  pull research into our context. `get_harvested_updates` is how you spot that a
  tool you referenced last month just shipped a v2 or picked up a critique;
  `list_recent_harvests` is the fleet-wide version - "what changed across my
  whole vault since I last looked."
- We close the loop with one write tool: `mark_item_actioned` (referenced /
  tasked / implemented / rejected / reverted) so the iOS Project Detail view +
  the Curator agent can see what we did with each item.

Default workflow when starting a session:

1. `get_project_brief({ context: "personal", project_name: "3d-model-converter" })`
   to read the latest curated brief.
2. Decide which suggested directions are worth actioning right now.
3. For items I'm using as background: `mark_item_actioned({ ..., action:
   "referenced" })`. For items I'm opening as work: `mark_item_actioned({ ...,
   action: "tasked", ref_url: "<issue or PR url>" })`.
4. Implement inside this repo (commits, PRs, tests). When the work ships:
   `mark_item_actioned({ ..., action: "implemented", ref_url: "<commit sha or
   release URL>" })`.

Never call `mark_item_actioned` for actions I haven't actually taken. The
lifecycle ledger is what closes the user's "into the void" feeling.

The `surface-innovation` skill (installed globally via Yorke-Claude-Setup) adds
*proactive* surfacing on top of these pull tools. Producer-side reference:
Harvestry repo `docs/integrations/consuming-harvestry-from-projects.md`.


## Operations reporting (hardware + services)

**Reports to: hardware-planning (direct)**

This project reports to the central **hardware-planning** repo, which plans one
shared fleet and one wallet across the whole portfolio. Two living docs:

| Doc | Covers | Convention |
|---|---|---|
| `docs/hardware-requirements.md` | Compute, storage, backups, devices this project needs **now and next** | `/Users/simonyorke/Projects/repos/hardware-planning/requirements-guide.md` |
| `docs/services.md` | Subscriptions, vendors, fees, and free tiers with a ceiling | `/Users/simonyorke/Projects/repos/hardware-planning/services-guide.md` |

- **Both are trajectory-first.** Report what is needed now *and* what will be
  needed and roughly when. A doc that only describes today has under-reported -
  the planner budgets ahead of the need.
- **Update them in the same commit as the change that moves a requirement**:
  new always-on process, storage or dataset jump, new device, new vendor or API,
  plan change, trial started, or a scope decision that changes either.
- **Run `/ops-review` at the first session of the week** in this repo. The
  central `/ops-sweep` catches anything missed.
- **Never record credentials** in `docs/services.md` - vendor, plan, cost,
  currency, cycle, dates, owner, and a payment-method *label* only. Nothing from
  `.env`.
- **Never sign up, start a trial, enter payment details, or cancel a service.**
  Recommend it in the doc; Simon acts.
- Out of scope: **BOM hardware** for hardware-design projects (motors, boards,
  electronics) is project BOM, not fleet. **Fiso-provided** hardware and
  services are excluded entirely.

## Harvest ingest (portfolio standard, 2026-09-07)

`Harvest approval:` at the top of this file governs Harvestry-sourced changes (`gated`: proposals wait for Simon to set `status: approved`; `autonomous`: this project implements them itself, one per run). The daily `daily-harvest-ingest` task runs the global `harvest-ingest` skill here: it works this project's Harvestry queue, records every verdict in the vault and in `docs/harvest/YYYY-MM-DD-harvest.md`, and writes an implementation proposal per adoptable capture into `docs/harvest/proposals/`. `TASKS.md` carries "Harvest proposals awaiting approval: N" and sessions say that number at start. Procedure: `~/.claude/skills/harvest-ingest/SKILL.md`.
