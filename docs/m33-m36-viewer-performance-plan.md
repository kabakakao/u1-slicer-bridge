# M33/M36 Viewer Performance Plan

Purpose: keep the pre-slice viewer fast enough for M33 placement while building the shared foundation needed for M36 painting.

## Goals

- Fast plate selection and thumbnail display (especially large multi-plate projects)
- Fast first visible object preview in `Object Placement`
- Accurate placement transforms (move/rotate) for slicing
- Scalable path to higher-detail mesh viewing for painting/colorization

## Targets (desktop, local Docker)

- First plate cards/thumbnails visible before placement viewer loads
- First visible placement preview for selected plate: `< 1s` for typical files, reasonable fallback for heavy files (e.g. Shashibo)
- Large models render a usable shape (not proxy-only cube) via decimated mesh
- Drag move/rotate remains responsive while preserving slice correctness

## Scope Split

- M33 placement mode: low/medium-detail mesh is acceptable; accuracy of transform + bounds is primary
- M36 painting mode: higher-detail mesh and segment/face interaction needed; can load progressively

## Phase Plan

### Phase 1: Perceived Performance (load order)

- [x] Do not load placement viewer geometry before a multi-plate selection is made
- [x] Ensure plate thumbnails/cards render before placement viewer work starts
- [x] Lazy-load placement viewer only when `Object Placement` is visible (or after plate selection settles)
- [x] Add simple loading states specific to placement viewer (`Loading layout`, `Loading preview mesh`)

### Phase 2: Geometry Budget / Decimation

- [x] Decimate oversized meshes instead of proxy-only fallback
- [x] Lower default viewer geometry budget for `/geometry` endpoint (placement mode)
- [ ] Make triangle budget dynamic by context (selected vs unselected, plate size, object count)
- [x] Progressive LOD: low-res first, refine selected object on idle/selection
- [ ] Better simplification quality (vertex clustering or similar) instead of simple skipping

### Phase 3: Transport / Rendering Efficiency

- [x] Measure `/layout`, `/geometry`, JSON parse, and mesh-build timings separately in browser
- [ ] Reduce payload size further (typed-array/binary transport or glTF-like path)
- [ ] Cache decoded geometry per upload+plate+modifier-toggle+LOD
- [ ] Reuse scene objects where possible when only transforms change

### Phase 4: UX / M33 Reliability

- [x] Real mesh rendering in placement viewer (with fallback)
- [x] Drag-to-move / drag-to-rotate interactions
- [x] Prime tower preview + drag position
- [ ] Better live bounds/overlap feedback (including prime tower collision)
- [ ] Clear pre-slice validation for out-of-bounds / conflict before Orca invocation

### Phase 5: M36 Readiness (shared viewer)

- [ ] Separate placement mesh LOD from painting mesh LOD policy
- [ ] Add geometry endpoint option for paint/segment metadata
- [ ] Add raycastable segment/face selection path (painting mode)
- [ ] Define viewer mode switch contract (`placement` vs `painting`)

## Regression Tests To Add / Keep

- [x] `/geometry` extents regression (non-zero Z + matches layout bounds)
- [x] Large-model geometry decimation regression (Shashibo)
- [x] Placement viewer drag -> slice bounds shift regression
- [x] Multi-plate Shashibo `slice-plate` requested plate routing regression (`@extended`)
- [ ] Placement viewer lazy-load regression (thumbnails visible before placement viewer fetch)

## Notes

- Placement preview and painting need different detail levels; do not optimize one by hurting the other.
- Prioritize perceived latency (thumbnails/selection first) over raw maximum mesh fidelity in M33.
