---
harvestry_item: 3993ae01-d098-4f6c-ba76-f8851363d5e8
captured: 2026-09-09
proposed: 2026-09-21
status: awaiting-approval   # awaiting-approval | approved | rejected | implemented
approved_by:
approved_on:
implemented_commit:
primary_source: https://threejs.org/changelog/?r186 (also https://github.com/mrdoob/three.js/releases/tag/r186)
authority: STRONG
informs_decision: threejs-dev-branch-pin
---

# Log r186's USDLoader fix as evidence on the dev-branch-pin decision

**What it is.** Three.js r186 shipped on 2026-09-08. Its official changelog
lists one USD-related change: "USDLoader: Resolve connected attribute
values" (PR #34309, by @cabanier). It is a real, tagged-release USDLoader
fix, but it is an incremental attribute-resolution bug fix, not the USDC
binary Crate parser work the open decision is tracking, and the changelog
has no mention of USDC, USDZExporter, or a stabilization push.

**What it would change here.** Nothing in code. `PROJECT.yml`'s
`threejs-dev-branch-pin` open decision names exactly this kind of event as
what "moves this": "A release announcement naming USDLoader or USDC, a
changelog entry, or a regression report against r183+." This is that
changelog entry. The decision's `notes` field should record it so the
tracking reflects the latest evidence, without changing `status` (still
open) or the CDN pin at `index.html:24-25` (still `@dev`, correctly, since
r186 does not resolve USDC Crate parsing).

**Why now.** This is the "informs a live open_decision" case the harvest
skill treats as highest-value. Leaving it unrecorded means the next
assessment of this decision starts from the same stale notes rather than
from what r186 actually shipped.

## Implementation plan

1. Append a dated line to `threejs-dev-branch-pin.notes` in `PROJECT.yml`:
   "2026-09-21: r186 (2026-09-08) shipped a USDLoader attribute-resolution
   fix (PR #34309) but nothing touching USDC Crate parsing or a stable
   release cut. Dev-branch pin still required." No change to `status`.
2. No code, test, or build changes; this is a docs-only update.
3. **Verification:** re-read the decision block after editing to confirm
   `status: open` is unchanged and the new note does not contradict the
   existing ones.

**Effort:** 5 minutes. **Risk:** none; it only appends to a notes string.
**Cost or requirements:** none.

## Decision

Simon sets `status:` above. `approved` unlocks implementation by a session
following the repo's normal verification and commit autonomy; `rejected`
needs a one-line reason so the vault records why. Until then nothing is
built.
