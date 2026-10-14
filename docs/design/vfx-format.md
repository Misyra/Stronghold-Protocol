# DESIGN §33 — Official battle effects (特效): the extracted format

Part of [DESIGN.md](../DESIGN.md) (the index; section numbers are global).

**Changelog** (for runtimes reading the files; newest first)

* **2026-10-15 — Phase 1b, the full set.** (1) The file list left `data/local-assets.json`: it is `data/local-fx.json`
  (§33.1), served at `/data/local-fx.json` with hashed URLs; its groups (`fx`, `fx/prefabs`, `fx/tex`, `fx/mesh`) and
  entries are the ones `data/local-assets.json` had, which now has no fx group. A worktree that links
  `data/local-assets.json` from another checkout links `data/local-fx.json` too (it is written next to the
  `--manifest` path as given). (2) `index.json` (§33.12): the six enemy `_2` variants without a prefab of their own
  are copies of their base unit with `aliasOf`; an emitter row's `effects` is what it plays — directionType 0 (NONE)
  plays only the first slot (the other slots are leftovers: before, they were listed too), a directional row keeps
  every distinct key plus `slots` (the effect per facing); keys the client lacks are dropped; a row may carry only a
  `hookEffectAfterFirstAttack`. (3) Skills gained `mode` / `modeBy`, `uses`, `roles` and `unclassified` (§33.12),
  from the skill prefabs and the client's buff templates. (4) The used set holds the sample's keys too. (5)
  `InheritVelocityModule` / `LifetimeByEmitterSpeedModule` export: their `m_Curve` is a MinMaxCurve (159 prefabs of
  the full set failed on it). (6) The **[verify]** marks were checked against the client: resolved — ability events (§33.12), vertex stream
  packing and the custom-data components (§33.6), `FxUVRotation` (§33.11), `PauseEffectIf` (§33.11, the earlier
  `buff_stun` example was wrong), the texture-sheet frame from the data's `0.9999` ends (§33.5); still assumed —
  the billboard roll's sign, the Limit Velocity dampen step (§33.5), `FxUVRotation`'s matrix sign. No descriptor field
  changed.
* **2026-10-14 — Phase 1a**: the format and the sample.

## 33. Official battle effects — the extracted format (0.3.0, Phase 1a–1b)

The official battle effects (hit sparks, projectiles, cast flashes, status loops, skill effects) are Unity prefabs of
ParticleSystems, meshes, trails and small behaviour scripts. `tools/local-extract/fx.py` (run as `extract.py --only fx`)
reads them from the player's own client — like every local-client asset (§13), nothing of it is committed or shipped —
and writes them in the format below, from which the web runtime rebuilds and plays them. This section is the contract
between the two: a runtime can be written from it without opening Unity. (The feasibility study before it, 2026-10-14,
is kept with the maintainer's local handoff notes.)

Everything in the files is Unity-native (axes, units, enums, serialized field names), transcribed, not reinterpreted:
the descriptor keeps Unity's names so that every field can also be looked up in Unity's documentation. What the
extractor adds is the resolution of references (other files, other nodes, shaders' render states, clip bindings) and the
decoding of compressed data (animation clips, textures, meshes).

**Status (Phase 1b).** The extractor and this format cover the full set the mode uses (§33.14; the Phase 1a sample,
§33.13, is a subset); the runtime is the next phase. Where the client's own behaviour cannot be read from its data,
the text says **assumed** (Unity behaviour the data cannot confirm); **resolved** marks what Phase 1b checked against
the client (its shader source, il2cpp metadata, prefab data). Enum and field names marked *metadata* come from the
client's il2cpp metadata (`Arknights_Data/il2cpp_data/Metadata/global-metadata.dat`, version 29, not encrypted: type
and field names, nested types, the enum constants with their values; method bodies are native code and not read).

### 33.1 Files, the file list and the extractor run

```
.venv/bin/python tools/local-extract/extract.py --only fx                        the Phase 1a sample (§33.13)
.venv/bin/python tools/local-extract/extract.py --only fx --fx-set used          every effect the mode's units use
.venv/bin/python tools/local-extract/extract.py --only fx --fx-keys k1,k2        named prefabs only (a dev aid)
                                                 [--fx-jobs N]  worker processes (default up to 8)
```

A plain `extract.py` run (no `--only`) does not run fx. The run reads `data/chess.json`, `data/backups.json`,
`data/enemies.json` and `data/tokens.json` for the unit list, caches the bundles' prefab lists under `.cache/fx/`
(per bundle size + mtime) and writes, under `public/assets/local/fx/`:

| file | content |
|---|---|
| `index.json` | §33.12: per unit (operator / enemy / token) the attack modes, skills, projectiles and mount points; the projectiles; the generic keys; one summary per exported prefab |
| `textures.json` | §33.8: texture key → size, wrap, filter, alpha, files |
| `prefabs/<file>.json` | §33.4: one descriptor per effect prefab (effect key → file: `fx_file(key)` — the key itself when it is URL-safe (`[A-Za-z0-9_.-]`), else the safe form + `-` + the key's CRC32 in hex, e.g. `buff_ fragile_01` → `buff__fragile_01-9c1f…`) |
| `tex/<key>.webp`, `tex/half/<key>.webp` | §33.8: every texture (WebP q90, alpha kept), and a half-size copy for the light tier (both sides ≥ 64 px) |
| `mesh/<key>.json` | §33.9: meshes of mesh particles, MeshRenderers, skinned meshes and mesh-shaped emitters |

**The file list: `data/local-fx.json`** (written next to `data/local-assets.json`, `--manifest`; gitignored like it).
It names every file, so the server's asset index hashes its URL: the server hands it out at `GET /data/local-fx.json` as
a view whose URLs carry the content hash, `/assets/~<hash>/local/fx/…` (immutable for a year; docs/ASSETS.md "The
committed manifest and the served manifests"), and answers an empty `{ groups: {} }` on an install without effects. It
is a file of its own — ~8,800 entries for the full set — so that `data/local-assets.json`, which every page loads, stays
small: that file has no fx group (an fx run removes the ones a Phase 1a run wrote there). The server never loads it
(`server/data.js UNLOADED_DATA`), it is no part of the content hash (`PRESENTATION_DATA`), and the release zips leave the
effects out while `tools/package.mjs FULL_ZIP_FX` is off. The runtime takes URLs from it, never builds them:

```
{ version: 1, format: 'fx-manifest', source: 'local-client', client (the client version), set ('sample' | 'used' | 'keys'),
  count (entries), groups: { fx, fx/prefabs, fx/tex, fx/mesh } }
```

| group | entries |
|---|---|
| `fx` | `index` `{ path, kind: 'FxIndex', version, set, prefabs }`, `textures` `{ path, kind: 'FxTextures', count }` |
| `fx/prefabs` | effect key → `{ path, kind: 'FxPrefab' }` |
| `fx/tex` | texture key → `{ path, w, h, kind: 'Texture2D', half? }` (`half`: the half-size copy's URL) |
| `fx/mesh` | mesh key → `{ path, kind: 'FxMesh', verts }` |

Each JSON file starts with `format` (`fx-index`, `fx-textures`, `fx-prefab`, `fx-mesh`) and `version` (1). A full run
(`sample` / `used`) rewrites the list and removes the files of an earlier run that are no longer listed; `--fx-keys`
re-exports the named prefabs (and the keys they name) into the earlier set — their descriptors, index summaries and list
entries are replaced, everything else stays (without an earlier set it writes a set of just those keys).

**Keys are case-insensitive.** Effect, projectile and skill keys are the bundles' container names, which are lower
case; the client's own references mix cases (a `SwitchableBackEffect` names `chen2_skill_01_buff_02_B`). Every key the
extractor writes (file names, file-list entries, the index, the descriptors' `refs`) is lower case; behaviour fields keep
the client's spelling — lower-case a key read from them before looking it up.

Timings on the maintainer's Mac (Windows client 26-09-13, 8 processes): the full set (§33.14: 4,253 prefabs, 186 MB)
takes ~3 minutes; the sample (126 prefabs, 290 textures, 43 meshes, 6.8 MB) ~17 s; a first run adds ~10 s (the bundles'
prefab lists: 606 effect bundles read once, then cached in `.cache/fx/`). The prefab export costs ~0.18 s CPU per
prefab; libwebp effort 4 (`WEBP_METHOD`; effort 6 is ~90× slower here for 4.5 % smaller files).

### 33.2 Conventions

**Numbers.** Floats have 6 significant digits; `-0` is `0`; NaN and ±∞ are `null` (in curve keys, `null` slopes mean
stepped, §33.3). Integers stay integers. Booleans are JSON booleans where Unity serializes a bool, else Unity's 0 / 1
integers are kept (most script fields: `_isLoop: 0`).

**Units.** Lengths are Unity units = tiles (one tile is 1 × 1). Times are seconds of battle time. Angles: radians in the
ParticleSystem's rotation fields (`startRotation*`, `RotationModule`, `RotationBySpeedModule` — e.g. a random spin
`{ min: -6.28319, max: 6.28319 }` rad/s); degrees everywhere else (Euler angles of transforms and clips, `ShapeModule`
`angle` / `arc` / `m_Rotation`, `FxUVRotation`). Colours are Unity's raw floats, in gamma space (the client renders in
gamma space: blend them as they are, no sRGB conversion), and may exceed 1 (HDR tints).

**Frames.** Every transform, vector and mesh vertex is in Unity's left-handed frame, as authored. Effects are authored
for the battle scene, whose world frame is the level's centred frame of `render/projection.js`: x = column − 10,
y = row − 9, **z = −height** (z points down into the board; the battle camera looks along +z, pitched 30° from straight
down, vertical FOV 40° — `OFFICIAL` in `render/projection.js`, which is exactly the camera the board uses). A point
`p_u` of the battle world is the board point `p_o = (p_u.x + 10, p_u.y + 9, −p_u.z)` (x = column, y = row, z = height).

The recommended way to render: build every effect in Unity space (Unity's TRS order, Unity's quaternions, Unity's
camera-facing math), with the camera transformed into the same space, and map positions with the linear map
`C = diag(1, 1, −1)` plus the anchor's translation only when they become board / clip-space positions. C is its own
inverse. Because C has determinant −1, triangle winding flips: draw effect geometry with culling off (nearly every
Torappu particle pass is `Cull Off`; for a `Back` / `Front` pass — the Rim shaders, a material's `_CullMode` — swap the
two). Direction vectors map with C as well
(`v_o = (v.x, v.y, −v.z)`); a quaternion maps as `(−qx, −qy, qz, qw)` when an orientation must be expressed in the board
frame. Euler angles (transforms, clips, shape rotation) are degrees applied as Unity's `Quaternion.Euler(x, y, z)`:
rotate about Z, then X, then Y (q = q_y · q_x · q_z).

Why it works out: the effects' own geometry is pre-tilted for the battle camera — e.g. every child system of
`common_hit_01` is rotated +30° about X, and every unit's `Graphic` node is rotated −30° about X (quaternion
`(-0.258819, 0, 0, 0.965926)`), so a character's skeleton plane is perpendicular to the camera's view direction. With
our camera being the official one, the authored transforms produce the official picture.

**Gravity.** A ParticleSystem's gravity is `Physics.gravity × gravityModifier` in battle-world space; the client's
`Physics.gravity` (globalgamemanagers, PhysicsManager) is the default `(0, −9.81, 0)`: towards row 0, in the board's
plane — on screen that reads as falling down.

**Time.** Effects run on the battle clock (`FxSystem._ts`, ≈ 2 game seconds per real second at 2× speed), so they stay
in step with the Spine clips. The client simulates particles in steps of at most 1/30 s (TimeManager "Maximum Particle
Timestep" 0.0333): a runtime that wants the same drag / limit-velocity results sub-steps the same way.

### 33.3 Value encodings (curves, gradients, references)

**AnimationCurve** (`keys`): `[[time, value, inSlope, outSlope], …]`, sorted by time; a weighted key appends
`weightedMode, inWeight, outWeight` (weightedMode: 1 in, 2 out, 3 both). Evaluate as Unity does: between keys k0, k1
(Δ = t1 − t0) the cubic Hermite with tangents `k0.outSlope·Δ` and `k1.inSlope·Δ`; a `null` slope on either side of a
segment makes it stepped (hold k0's value until t1). Weighted tangents use Unity's Bézier form (rare: none in the sample).
Outside the keys, clamp to the first / last value (particle curves are evaluated on 0…1).

**MinMaxCurve** (Unity's `minMaxState` modes):

| encoding | mode | value |
|---|---|---|
| a number | Constant (0) | that number |
| `{ min, max }` | TwoConstants (3) | lerp(min, max, r) |
| `{ scalar, curve }` | Curve (1) | curve(t) × scalar |
| `{ scalar, minCurve, maxCurve }` | TwoCurves (2) | lerp(minCurve(t), maxCurve(t), r) × scalar |

`t` is the normalized time the field is defined over: the system's time / `lengthInSec` for the start values and the
emission rate (InitialModule `start*`, `rateOverTime`, burst counts), the particle's age / lifetime for the
over-lifetime modules, the custom data and the texture-sheet frame. `r` is a random number per particle, drawn when the
particle is born and kept (Unity keeps one per field). For the start values about 99 % of the systems use Constant or
TwoConstants (§33.5's table).

**Gradient**: `{ mode: 'blend' | 'fixed', color: [[t, r, g, b], …], alpha: [[t, a], …] }` (t in 0…1, up to 8 keys each).
Colour and alpha keys are separate tracks; 'blend' interpolates linearly between keys, 'fixed' holds the key at or
after t (Unity's fixed mode: the first key whose time ≥ t).

**MinMaxGradient**:

| encoding | mode | value |
|---|---|---|
| `[r, g, b, a]` | Color (0) | that colour |
| `{ min, max }` (colours) | TwoColors (2) | lerp(min, max, r) per component |
| `{ gradient }` | Gradient (1) | gradient(t) |
| `{ minGradient, maxGradient }` | TwoGradients (3) | lerp(min(t), max(t), r) |
| `{ random }` | RandomColor (4) | random(gradient) — one random point of the gradient, per particle |

**Vectors and colours**: `[x, y, z(, w)]`, `[r, g, b, a]`. A Unity `MultiModeParameter` (ShapeModule `radius`, `arc`,
`m_MeshSpawn`) is `{ value, mode, spread, speed }` (mode: 0 Random, 1 Loop, 2 PingPong, 3 BurstSpread; `speed` a
MinMaxCurve).

**References** (Unity PPtrs) are resolved:

| encoding | meaning |
|---|---|
| `{ node }` | a GameObject of this prefab (§33.4 node id) |
| `{ node, component }` | a component on that node (`'Transform'`, `'ParticleSystem'`, …) |
| `{ material: i }` | `materials[i]` of this descriptor |
| `{ mesh: key }` | a mesh file (§33.9); `'builtin:Quad'` etc. for Unity's built-in meshes |
| `{ texture: key }` | a texture (§33.8) |
| `{ clip: i }` | `clips[i]` of this descriptor |
| `{ builtin: x }` | an asset of Unity's built-in resources (`x`: a built-in mesh name or its path id) |
| `{ asset, name }` | any other asset (type, name) — informational |
| `null` | no reference (Unity's null), or a reference the extractor could not resolve |

### 33.4 The prefab descriptor (`prefabs/<file>.json`)

```
{ format: 'fx-prefab', version: 1, key, bundle, root: 0,
  nodes: [Node…], materials: [Material…] (§33.7), clips: [Clip…] (§33.10),
  textures: [texture key…], meshes: [mesh key…],          the files this prefab needs (preload them)
  refs: [effect key…],                                     other effects its behaviours name (§33.11: variants by
                                                           facing, chained effects) — exported too
  stats: { nodes, particleSystems, liveParticles, duration, looping } }
```

`stats` are estimates for budgets and pooling: `liveParticles` the rough peak of live particles of the active
systems, `duration` the time until every non-looping system has finished (startDelay + lengthInSec + max lifetime;
`null` when any system loops), `looping` whether one does.

**Node** (one per GameObject; `nodes[0]` is the prefab root; children in Transform order, depth first):

```
{ id, name, parent (id | null), children: [id…], active (the GameObject's own activeSelf),
  pos: [x, y, z], rot: [x, y, z, w] (quaternion), scale: [x, y, z],      local transform (Unity)
  particleSystem?        §33.5          particleSystemRenderer?   §33.6
  meshFilter?            mesh key (or 'builtin:Quad', or null)
  meshRenderer?, skinnedMeshRenderer?, trailRenderer?, lineRenderer?, spriteRenderer?    §33.6
  animator?, animation?  §33.10         behaviours?: [Behaviour…]  §33.11
  ignored?: [component type…]           components the format leaves out (MeshCollider, BoxCollider, …) }
```

World matrix of a node = parent's world matrix × T(pos) · R(rot) · S(scale). A node is active when it and all its
parents are `active` (Unity's activeInHierarchy); an inactive node renders and simulates nothing until something (an
FxDelay, a clip curve on `m_IsActive`) activates it. A renderer also has its own `m_Enabled`.

The usual layout: the root carries the controlling behaviour (`ParticleEffect`, `ProjectileEffect`, §33.11) → a node
`static_offset` → a node `fixed` (or `rotation_y` / `rotation_z`, nodes the behaviour turns by direction) holding a
ParticleSystem whose renderer is disabled (`Default-Particle` material) — it only times its children (in Unity, playing
a system plays its child systems) → the visible systems, quads, trails. Note the children's +30° X tilt (§33.2).

### 33.5 ParticleSystem (`node.particleSystem`)

Only enabled modules are written (InitialModule always); a missing module is off. Field names are Unity's serialized
names (`ParticleSystem` in a Unity YAML scene); the enum values are Unity's.

**System fields**: `lengthInSec` (duration), `looping`, `prewarm` (a looping system starts as if one full duration had
already run), `startDelay` (MinMaxCurve, s), `playOnAwake`, `simulationSpeed`, `moveWithTransform` (simulation space:
0 Local — particles move with the system's transform, 1 World — they stay where they were emitted, 2 Custom — relative
to `moveWithCustomTransform` `{node, component}`), `scalingMode` (0 Hierarchy — the full world scale applies, 1 Local —
only the system's own `scale` applies to its particles, 2 Shape — scale applies to the emission shape only), `stopAction`,
`cullingMode`, `ringBufferMode`, `ringBufferLoopRange`, `emitterVelocityMode` (0 Transform, 1 Rigidbody: the emitter's
velocity for inherit-velocity and rate-over-distance), `useUnscaledTime`, `autoRandomSeed`, `randomSeed`.

**InitialModule** (Main): `startLifetime`, `startSpeed` (along the shape's emission direction), `startSize` (or, with
`size3D`, `startSize` / `startSizeY` / `startSizeZ` per axis), `startRotation` (radians; with `rotation3D`
`startRotationX` / `startRotationY` / `startRotation` (Z)) — a billboard's roll about the view axis; Unity turns
particles clockwise on screen for positive angles, the opposite of a Transform's Z rotation (**assumed**: Unity's
behaviour, which no data of the client confirms; the transform-driven spins such as `buff_stun`'s are clips, §33.10) —,
`randomizeRotationDirection` (0…1: the share of particles whose rotation and spin are mirrored), `startColor` (MinMaxGradient), `gravityModifier` (MinMaxCurve × Physics.gravity,
§33.2), `maxNumParticles` (emission stops at this many live particles), `customEmitterVelocity`.

**ShapeModule** (where particles are born and their initial direction; omitted = emit at the system's origin, direction
+Z): `type` / `typeName` — `sphere`, `hemisphere`, `cone`, `box`, `mesh`, `coneVolume`, `circle`, `singleSidedEdge`,
`meshRenderer`, `skinnedMeshRenderer`, `boxShell`, `boxEdge`, `donut`, `rectangle` (and Unity's deprecated `*Shell` /
`circleEdge` ids, unused); `radius` and `arc` (MultiModeParameter, arc in degrees), `radiusThickness` (0 = only the
surface / edge, 1 = the whole volume), `angle` (cone half-angle, degrees), `length` (coneVolume length), `boxThickness`,
`donutRadius`, `m_Position` / `m_Rotation` (Euler degrees) / `m_Scale` (the shape's own transform inside the system),
`alignToDirection`, `randomDirectionAmount`, `sphericalDirectionAmount`, `randomPositionAmount`; mesh shapes: `m_Mesh`
(`{mesh}`), `m_MeshRenderer` / `m_SkinnedMeshRenderer` (`{node, component}`), `placementMode` (0 vertex, 1 edge,
2 triangle), `m_MeshSpawn`, `m_UseMeshColors`, `m_MeshNormalOffset`, `m_MeshMaterialIndex` / `m_UseMeshMaterialIndex`;
texture-masked shapes (`m_Texture`, …: unused). Unity's geometry: cone and hemisphere open along the shape's local +Z,
circle / donut / rectangle lie in its local XY plane, the edge runs along local X.

**EmissionModule**: `rateOverTime` (MinMaxCurve over the system's normalized time), `rateOverDistance` (particles per
unit the emitter moves — projectile trails), `m_Bursts`: `[{ time, countCurve, cycleCount (0 = repeat for ever),
repeatInterval, probability }]` (`m_BurstCount` is their number).

**Over-lifetime modules** (t = age / lifetime):
* `SizeModule`: `curve` (multiplies startSize); with `separateAxes` `curve` = X, `y`, `z`.
* `RotationModule`: angular velocity `curve` (rad/s, Z); with `separateAxes` `x`, `y`, `curve` (Z).
* `ColorModule`: `gradient` (MinMaxGradient, multiplies startColor).
* `VelocityModule`: `x`, `y`, `z` (added velocity), `orbitalX` / `orbitalY` / `orbitalZ` (rad/s around the system
  centre), `orbitalOffsetX/Y/Z`, `radial` (along centre → particle), `speedModifier` (multiplies the velocity),
  `inWorldSpace` (0 local, 1 world).
* `ClampVelocityModule` (Limit Velocity): `magnitude` (or `x` / `y` / `z` with `separateAxis`), `dampen` (the share of
  the excess speed removed per step), `drag` (MinMaxCurve) with `multiplyDragByParticleSize` /
  `multiplyDragByParticleVelocity`, `inWorldSpace`. **Assumed**: Unity applies dampen once per simulation step
  (sub-steps of ≤ 1/30 s, §33.2); the client's data cannot show the step (engine code).
* `ForceModule`: `x`, `y`, `z` (acceleration), `inWorldSpace`, `randomizePerFrame`.
* `InheritVelocityModule`: `m_Mode` (0 Initial, 1 Current), `m_Curve`.
* `LifetimeByEmitterSpeedModule`, `SizeBySpeedModule`, `RotationBySpeedModule`, `ColorBySpeedModule` (`range` = the
  speed interval mapped to 0…1).
* `NoiseModule`: `strength` (with `separateAxes` `strength` / `strengthY` / `strengthZ`), `frequency`, `scrollSpeed`,
  `damping` (strength proportional to frequency), `octaves`, `octaveMultiplier`, `octaveScale`, `quality` (0 1D, 1 2D,
  2 3D), `remap` / `remapY` / `remapZ` / `remapEnabled`, `positionAmount`, `rotationAmount`, `sizeAmount`. Unity's
  noise is curl noise; any smooth 3D noise of the same frequency and strength reads alike.

**UVModule** (Texture Sheet Animation): `mode` (0 grid, 1 sprites — grid only in this client), `tilesX` × `tilesY`,
`animationType` (0 whole sheet, 1 single row: `rowMode` / `rowIndex`), `timeMode` (0 lifetime, 1 speed (`speedRange`),
2 fps (`fps`)), `frameOverTime` and `startFrame` (MinMaxCurves **normalized**: 0…1 of the frame count — the client's
values run to 0.9999), `cycles` (sheet loops per lifetime), `flipU` / `flipV` (probabilities), `uvChannelMask`. Frame
index = floor(frac(startFrame + frameOverTime(frac(t · cycles))) · frames); frames run left to right, top to bottom
(frame 0 is the top-left tile). **Resolved** by the data: the authored curves end at 0.9999, not 1, exactly so that
floor(v · frames) stays on the last frame instead of wrapping to the first; the `cycles` repetition is Unity's
documented meaning (assumed).

**SubModule**: `subEmitters`: `[{ emitter: {node, component: 'ParticleSystem'} | null, type, properties,
emitProbability }]` — type 0 Birth, 1 Collision, 2 Death, 3 Trigger, 4 Manual; `properties` a bitmask of what the
child inherits (1 colour, 2 size, 4 rotation, 8 lifetime, 16 duration; 0 = nothing). A sub-emitter system does not
emit on its own; it emits (its bursts) at the parent particle's position for each parent event. `emitter: null` occurs
in the data and does nothing.

**TrailModule** (trails behind particles, drawn with the renderer's `materials[1]`): `mode` (0 Particles — one trail
per particle, 1 Ribbon — one strip through the particles in age order), `ratio` (share of particles with a trail),
`lifetime` (MinMaxCurve, × the particle lifetime), `minVertexDistance`, `textureMode` (0 Stretch, 1 Tile,
2 DistributePerSegment, 3 RepeatPerSegment), `worldSpace`, `dieWithParticles`, `sizeAffectsWidth`, `sizeAffectsLifetime`,
`inheritParticleColor`, `colorOverLifetime`, `widthOverTrail` (MinMaxCurve over the trail, head 0 → tail 1),
`colorOverTrail`, `ribbonCount`, `splitSubEmitterRibbons`, `attachRibbonsToTransform`.

**CustomDataModule**: `mode0` / `mode1` (0 disabled, 1 vector, 2 colour), `vectorComponentCount0/1`, `vector0_0…0_3`,
`vector1_0…1_3` (MinMaxCurves over the particle lifetime), `color0` / `color1`. These values reach the shader only
through the renderer's custom vertex streams (§33.6) — the `*(CustomData)` shaders read them (dissolve amount, UV
offsets).

**CollisionModule** (66 systems in the used set), **TriggerModule**, **LightsModule**, **ExternalForcesModule**: written
when enabled; a runtime may ignore them (no collider exists in our scene; the used set has no lights / external forces).

How often each module occurs in the systems 盟约 uses (28,360 ParticleSystems of the 4,013 prefabs, client 26-08-16):
Emission 83 %, Color 76 %, Size 69 %, Shape 41 % (cone 5,791, sphere 1,904, box 1,809, circle 1,142, coneVolume 609),
ClampVelocity 28 %, UV 16 %, CustomData 11 %, Rotation 11 %, Velocity 9 %, Noise 8 %, Force 3 %, Trail 2 %,
Sub 1 %, InheritVelocity 1 %; 23 % loop, 3,019 prewarm, 16 % simulate in world space, 89 % use scaling mode Local.

### 33.6 Renderers

All renderers carry `m_Enabled`, `m_SortingLayerID` / `m_SortingLayer`, `m_SortingOrder` and `materials` (indices
into the descriptor's `materials`, `null` for a missing one — draw nothing with it).

**`particleSystemRenderer`**: `renderMode` / `m_RenderMode` — `billboard` (0), `stretch` (1), `horizontalBillboard` (2),
`verticalBillboard` (3), `mesh` (4), `none` (5); `renderAlignment` / `m_RenderAlignment` — `view` (0, face the camera
plane), `world` (1), `local` (2, the system's transform orientation — 9,422 renderers: most mesh particles and many
quads are local), `facing` (3, face the camera position), `velocity` (4); `m_SortMode` (0 none, 1 by distance, 2 oldest
in front, 3 youngest in front), `m_SortingFudge` (bias of the camera distance used to sort this system against
others), `m_MinParticleSize` / `m_MaxParticleSize` (on-screen size clamp, as a fraction of the viewport height),
`m_LengthScale` / `m_VelocityScale` / `m_CameraVelocityScale` (stretched billboards: length = size × lengthScale +
speed × velocityScale), `m_FreeformStretching`, `m_RotateWithStretchDirection`, `m_NormalDirection`, `m_Pivot` (in
particle-size units), `m_Flip` (0…1: the share of particles mirrored per axis), `m_AllowRoll`; mesh particles:
`m_Mesh`, `m_Mesh1…3` (`{mesh}` or null), `m_MeshDistribution` (0 uniform, 1 by `m_MeshWeighting*`), `m_MaskInteraction`;
`materials[0]` draws the particles, `materials[1]` the TrailModule's trails.

Custom vertex streams: `m_UseCustomVertexStreams` and `vertexStreams` (names; `m_VertexStreams` the ids). Only when
`m_UseCustomVertexStreams` is true does the list apply; otherwise the shader gets Unity's default streams Position,
Normal, Color, UV. Unity packs the streams in list order: Position → POSITION, Normal → NORMAL, Tangent → TANGENT,
Color → COLOR, then every other stream fills TEXCOORD0, TEXCOORD1, … four floats at a time (UV is 2 floats, Custom1XYZW
4, AgePercent 1, …) — e.g. `[Position, Normal, Color, UV, Custom1XYZW]` gives TEXCOORD0.xy = UV, TEXCOORD0.zw =
Custom1.xy, TEXCOORD1.xy = Custom1.zw.

**Resolved** against the client's shader source (the custom-data variants, keyword `_HGCUSTOMVERTEXSTREAM_ON`): their
vertex inputs are sized to exactly these packings — `TEXCOORD0` half4, `TEXCOORD1` half4, `TEXCOORD2` half2 (10 floats)
in the Disturb / Ram / ZDistort `(CustomData)` families, whose renderers stream `[Position, Normal, Color, UV,
Custom1XYZW, Custom2XYZW]` (2,301 renderers of the used set: UV 2 + 4 + 4); `TEXCOORD0` + `TEXCOORD1` (8 floats) in
`Dissolve(CustomData)`, whose renderers stream `[…, UV, Custom1XYZW, Custom2XY]` (653). What the components do there
(CustomDataModule curves, §33.5) — offsets are added to a texture's UV after its tiling / offset, before the UV
rotation and the scrolling: in `Disturb(CustomData)` Custom1.xy offsets the main texture, Custom1.zw the dissolve
texture, Custom2.zw the disturb texture (the Ram and ZDistort families add the same three inputs to their own three
textures), Custom2.x is added to `_Amount` (the dissolve threshold) and Custom2.y to `_IntensityU` / `_IntensityV`
(the disturb strength); in `Dissolve(CustomData)` Custom1.xy / Custom1.zw offset its main / dissolve textures,
Custom2.x is added to `_DissolveIntensity` and Custom2.y to `_BorderWidth`. Without the keyword (or without custom
streams) the components are 0.

**`meshFilter` + `meshRenderer`**: the mesh drawn with the node's world transform, one material per sub-mesh.
`builtin:Quad` is Unity's quad: vertices (±0.5, ±0.5, 0), normal −Z, UV (0,0) at (−0.5, −0.5).

**`skinnedMeshRenderer`**: `m_Mesh`, `m_Bones` (`[{node, component}]`, the bone transforms), `m_RootBone`, `m_Quality`,
`m_BlendShapeWeights`; the mesh file carries `boneWeights`, `boneIndices`, `bindPoses` (§33.9). A vertex is
Σᵢ wᵢ · (boneᵢ world · bindPoseᵢ) · v. 17 prefabs in the used set (Ifrit S3's flame tongues), animated by legacy clips.

**`trailRenderer`**: `m_Time` (trail lifetime, s), `m_MinVertexDistance`, `m_Autodestruct`, `m_Emitting`, `m_Parameters`
= `{ widthMultiplier, widthCurve (keys over the trail, head 0 → tail 1), colorGradient (head → tail), numCornerVertices,
numCapVertices, alignment (0 view, 1 transform Z / local), textureMode (0 Stretch, 1 Tile, 2 DistributePerSegment,
3 RepeatPerSegment) }`. The trail follows its node's world position (the projectile's flight).

**`lineRenderer`**: `m_Positions` (in world space when `m_UseWorldSpace`, else the node's space), `m_Loop`, the same
`m_Parameters`. The authored positions are placeholders: the effects that use lines (chains, beams) get their end
points from the game (source and target).

**`spriteRenderer`**: not used by the effects of this mode (written with its materials only).

**Sorting and depth.** Transparent renderers sort by sorting layer, then `m_SortingOrder`, then the material's queue,
then camera distance (with `m_SortingFudge`). 71 % of the effect materials have ZTest `Disabled` (§33.7): they ignore
the board's depth; the rest test against it (ground decals, ranges).

### 33.7 Materials (`descriptor.materials[]`)

```
{ name, shader (the shader's name, e.g. 'Torappu/Particles/Additive'),
  passes: [{ blend: [src, dst, srcAlpha, dstAlpha], blendOp, zTest, zWrite, cull, colorMask }],
  queue (the material's render queue, else the shader's Queue tag, e.g. 'Transparent' = 3000),
  keywords: [shader keyword…],
  floats: { name: number }, colors: { name: [r, g, b, a] (also vectors) },
  textures: { name: { tex: key | null | 'builtin:<id>', st: [scaleX, scaleY, offsetX, offsetY], default? } },
  defaults?: [property names the material did not store: their values are the shader's defaults] }
```

Only the shader's declared properties are written (materials keep stale values of earlier shaders; they are dropped),
each with the material's value or the shader's default. `textures[n].default` is the shader's default texture name
('white', 'black', 'gray', 'bump') when no texture is set. The pass states are resolved for this material: blend
factors (`Zero`, `One`, `DstColor`, `SrcColor`, `OneMinusDstColor`, `SrcAlpha`, `OneMinusSrcColor`, `DstAlpha`,
`OneMinusDstAlpha`, `SrcAlphaSaturate`, `OneMinusSrcAlpha`), `blendOp` (`Add`, …), `zTest` (`Disabled` — always pass
— `Less`, `LessEqual`, …), `zWrite`, `cull` (`Off`, `Front`, `Back`), `colorMask` (bits R 8, G 4, B 2, A 1) — where
the shader takes a state from a property (`_ZTest`, `_DstBlend`, `_SrcBlend`, `_PremultiplyAlpha`, `_CullMode`, …) the
material's value (or the property default) is used. The alpha factors matter only when the effect layer's alpha is
composited (a transparent canvas). `keywords` select the shader's variant: in this client `_HGCUSTOMVERTEXSTREAM_ON`
(the custom-data variant of the `*(CustomData)` shaders), `HG_SPRITE_SHEET` / `HG_SPRITE_SHEET_LERP` (AlphaBlend's
in-shader flipbook), `_ALPHABLEND_ON`, `_WEIGHT_ON`, …

Shaders of the used set (by material uses; 38 names): `Torappu/Particles/AlphaBlend` 9,208, `…/Additive` 9,124,
`…/Ram/Disturb(CustomData)` 3,244, `…/Disturb/Disturb(CustomData)` 1,823, `…/Dissolve/Dissolve(CustomData)` 968,
`…/Dissolve/Dissolve AB` 945, `…/Dissolve/Dissolve Add` 760, `…/Disturb/Disturb Origin` 568, `…/Disturb/Disturb Anchor`
405, `…/Dissolve/Dissolve AB (VertexColor Major)` 395, `…/Dissolve/Dissolve AB UVTween` 361, `…/Dissolve Add UVTween`
288, `…/Dissolve Add Double` 213, … and the rare GrabPass / ZDistort / Bloom / Rim / Mask / Multiply families. The
runtime implements these families in its own GLSL; their behaviour (properties, passes, the vertex / fragment
computations) is documented for the runtime developer in a reference kept outside the repository — official shader
source never enters it. The common pattern: output = 2 × vertex colour × `_TintColor` × texture (a `_TintColor` of
0.5 grey is neutral), Dissolve variants cut the alpha by a noise texture against `_Amount` with a soft `_BorderWidth`,
Disturb variants offset the main UVs by a scrolled distortion texture.

### 33.8 Textures (`textures.json`, `tex/`)

`textures.json` = `{ format: 'fx-textures', version: 1, textures: { key: Texture } }`:

```
{ name (the Unity name), w, h, format (the client's encoding: DXT1, DXT5, RGBA32, …), mips, srgb, alpha,
  file: 'tex/<key>.webp', half: 'tex/half/<key>.webp' | null,
  wrapU, wrapV ('repeat' | 'clamp' | 'mirror' | 'mirrorOnce'), filter ('point' | 'bilinear' | 'trilinear'), aniso }
```

A key is the safe Unity name + the first 8 hex digits of the SHA-1 of the decoded pixels, so identical copies in
different bundles share one file (`star_02` alone exists ~50 times in the client). `alpha` false = every pixel opaque
(written as RGB). Textures are straight (not premultiplied) alpha; the half-size copy is resized premultiplied (no dark
fringes). `srgb` is informational: render in gamma space (§33.2). Built-in textures appear as `builtin:<path id>`.

### 33.9 Meshes (`mesh/<key>.json`)

```
{ format: 'fx-mesh', version: 1, name, vertexCount,
  positions: [x, y, z, …], normals?: […], uv0?: [u, v, …], uv1?: […], colors?: [r, g, b, a, …] (0…1),
  submeshes: [[i0, i1, i2, …], …] (triangle lists, one per material),
  boneWeights?: [w0, w1, w2, w3, …], boneIndices?: [i0…i3, …], bindPoses?: [[16 floats row-major]…] }
```

Unity mesh space (left-handed, as authored). Key = safe name + 8 hex digits of the SHA-1 of the file. Meshes of mesh
particles are small (`Plane003`, `Cone001`, `Torus001`, `Sphere001`: 4–200 vertices; 435 meshes / 57k vertices in the
whole used set).

### 33.10 Animation clips (`descriptor.clips[]`, `node.animator`, `node.animation`)

`node.animator` = `{ controller, clips: [clip index…], default, enabled, cullingMode, updateMode }`: the Animator plays
`default` from time 0 when the effect starts (every effect controller of the sample has one clip). `node.animation`
(legacy) = `{ clips, default, playAutomatically, wrapMode, enabled }`.

```
Clip = { name, legacy, length, start, loop, sampleRate, wrapMode, events: [{ time, function, data, float, int }],
         curves: [{ node, path, type, property, keys, customType?, pptr?, pathHash? }] }
```

A curve drives one float of one component of node `node` (`path`: its path from the Animator's / Animation's node;
`node: null` + `pathHash` when the clip names an object the prefab does not have — Unity ignores those). Evaluate the
keys at the clip time (§33.3; looping clips wrap at `length`, others hold their end values). `type` and `property`:

| type | property | meaning |
|---|---|---|
| `Transform` | `localPosition.x/y/z`, `localScale.x/y/z` | the node's local position / scale |
| `Transform` | `localRotation.x/y/z/w` | quaternion (normalize after evaluating) |
| `Transform` | `localEulerAnglesRaw.x/y/z` | Euler degrees (Z, X, Y order, §33.2; e.g. `buff_stun`'s spin: z 0 → −720 over 10.03 s) |
| `GameObject` | `m_IsActive` | > 0.5 = active |
| `MeshRenderer`, `ParticleSystemRenderer`, `TrailRenderer`, `LineRenderer`, `SkinnedMeshRenderer` | `material.<prop>[.<c>]` (customType 22) | overrides a material property of that renderer only: c = `r g b a` (colours), `x y z w` (vectors — for `_MainTex_ST`: x, y scale, z, w offset), none (floats). Seen: `_TintColor`, `_MainColor`, `_MainTex_ST`, `_Amount`, `_Amount_02`, `_BorderWidth`, `_DissolveTex_ST`, `_DisturTex_ST` |
| `TrailRenderer` / `LineRenderer` | `m_Parameters.widthMultiplier`, `m_Time`, … (customType 30 / 29) | the renderer field of that path |
| `ParticleSystem` | dotted module path, e.g. `EmissionModule.rateOverTime.scalar`, `InitialModule.startColor.maxColor.a` (customType 27) | that serialized field of the system |
| `MonoBehaviour` | the script's field | (16 bindings in the used set) |

Unresolvable properties would read `crc:<n>` (none in the sample). Clips are decoded from Unity's streamed (Hermite
segments), dense (sampled; written as linear keys) and constant tracks; legacy clips from their explicit curves.

### 33.11 Behaviours (`node.behaviours[]`)

`{ class, namespace, enabled, fields }` — every MonoBehaviour with its serialized fields (Unity names, references
resolved per §33.3; `_bodyTransofrm` is the client's spelling). Disabled behaviours (`enabled: false`) do nothing.
Semantics below are read from the field names, the data and the client's type, field and enum names (*metadata*);
**resolved** marks what was checked against the client's shader source or metadata, **assumed** what still is not.

**`ParticleEffect`** (Torappu.Battle.Effects — the root of most effects; 3,630 in the used set):
* `_spawnLocation` — where the game places the effect on its owner (*metadata* SpawnLocation): 0 NONE, 1 FOOT_POINT,
  2 HIT_POINT, 3 MUZZLE_POINT, 4 HEAD_POINT, 5 GROUND_CENTER, 6 MUZZLE_POINT_WITHOUT_ROTATION, 7 GROUND_CENTER_WITH_ZERO_HEIGHT,
  8 MP_SPECIAL_0, 9 MP_SPECIAL_1, 10 MP_SPECIAL_2, 11 MP_SPECIAL_3, 12 CAMERA, 13–16 MP_SPECIAL_4–7, 17 TILE_CENTER,
  18–25 MP_SPECIAL_8–15, 26 GROUND_CENTER_WITH_TILE_HEIGHT, 27–34 MP_SPECIAL_16–23, 35 GROUND_CENTER_WITH_HIGHLAND_HEIGHT.
  The points are the unit's mount points (§33.12 `skins`): FOOT = the unit's root, HIT = `HitPoint`, MUZZLE = `Muzzle` /
  `MuzzlePoint`, HEAD = `HeadPoint`, MP_SPECIAL_n = `Special<n>` / `SpecialPoint<n>`. In the sample: hits use 2, cast
  flashes 3 / 6 / 8, status loops 1 / 4, ranges 5 / 7.
* `_rotateType` (*metadata* RotateType): 0 NONE, 1 FLIP_TWO_SIDE (mirror for a left-facing owner), 2 FOUR_DIRECTION,
  3 FIXED_DIRECTION, 4 ANY_DIR; `_leftIsDefault` (the art faces left), `_mainDir`, `_useBodyRotation`, `_rotationY` /
  `_rotationZ` / `_flipZ` (`{node}`: the helper nodes the direction turns / flips — e.g. `inside_attack_01_hit`'s
  `rotation_y`).
* `_delayToPlay` (s before the systems start), `_delayToFinish` (s the effect lingers after it is finished, then it is
  recycled), `_maxLifetime` (s, −1 none), `_randomPlayDelay`, `_isLoop`, `_inactiveOnFinish` (`[{node}]` hidden when it
  finishes), `_subFXDelayConfigs`, `_holdByOwner`, `_overwriteHeight` / `_heightOffset` (place at this height),
  `_usePlaybackSpeed` / `_limitedPlaybackSpeed` (follow the owner's attack speed, capped), `_preloadCnt` (pool size
  hint), `_allowAutoReuse`, `_disableBattleEffectShrink`, `_ignoredByParticleEffectManager`, `_toggleMeshRendererWhenPause`.
* An effect is finished when every non-looping system has ended and has no live particle (and its clips have ended);
  looping effects run until the game stops them (a status ends, a skill ends, a projectile arrives).

**`ProjectileEffect`** (the flying part of a projectile, §33.12): `_mainDir`, `_resetMainDir`, `_rotate180Y`,
`_randomAngle`, `_flipIfLeft`, `_delayToFinish`, `_inactiveOnFinish`, `_inactiveOnHit` (`[{node}]` hidden on arrival
while the rest — trails — fades), `_preloadCnt`, `_allowAutoReuse`. **`EmptyEffect`**: an effect with no own logic.

**`FxDelay`**: `_delayTime` — the node becomes active that many seconds after the effect starts (its nodes start
inactive or the behaviour hides them first).

**`FxUVTweener`** / **`FxUVTweenerAdvance`** (Torappu.Fx): scroll texture offsets of the node's renderer material:
`xspeed`, `yspeed` (UV units per second, `_MainTex`), `useSecondMap` + `secondMapName` (e.g. `_DisturTex`, `_RamTex`,
`_DissolveTex`) + `secondXSpeed` / `secondYSpeed`, `keepInitOffset` (start from the material's offset), `protectMainUV`
/ `protectSecondUV`, `useSharedMaterial`; Advance adds `tweenRepeat`, `tweenAnmTime`, `extraMapSettings`.
**`FxUVRotation`** (186 prefabs): `_propertyName` (`_Rotation`), `_rotateTex1…4` (which textures), `angle1`,
`_angle2…4` (degrees). **Resolved** in the shader source: the Torappu particle shaders that support it rotate each
texture's UV about its centre when the float `_HG_UV_ROTATION` is > 0.5 — uv′ = (dot(uv − 0.5, R.xz),
dot(uv − 0.5, R.yw)) + 0.5, after the texture's tiling / offset and before its time scroll — with one matrix per
texture slot, `<propertyName>0…3` = `_Rotation0` (texture 1, `_MainTex`), `_Rotation1` (2, `_DissolveTex`),
`_Rotation2` (3, `_WeightTex`), `_Rotation3` (4, `_DisturbTex` / the ramp's disturb map). No material stores them: the
behaviour sets them at run time. **Assumed**: R = (cos θ, sin θ, −sin θ, cos θ) for its angle θ (the standard 2D
rotation, so u′ = cos θ·u − sin θ·v), and `_HG_UV_ROTATION` = 1 while it runs.

**`FollowMountPoint`**: keeps the effect on a mount point of its owner (*metadata* MountPointType): 0 FOOT, 1 HIT,
2 MUZZLE, 3 HEAD, 4 UI, 5 SPECIAL_0, 6 SPECIAL_1, 7 GROUND, 8 SPECIAL_2, 9 SPECIAL_3, 10 SPECIAL_4, 11–29
SPECIAL_5–SPECIAL_23 — sample: `buff_frozen` 0, `common_root_01` 1, `enemy_tidmag_attack_01_start_01` 2, `buff_stun` /
`buff_cold` 3, `greyy_attack_01_start` 5; `_followScale` / `_followScaleSign` / `_scaleMultiplier`,
`_keepOriginRotation`, `_pauseWhenMountPointInvalid`, `_onlyPauseWhenMountPointInvalid`, `_useBehaviourPause`.
**`FollowDirection`**: turns with the owner's facing (`_useFourDir`, `_useOwnerDirection`, `_useOwnerMoveDirection`,
`_leftIsDefault`, `_reverseWhenFaceToBack`, `_flipWhenFaceToVertical`, `_onlyFollowOnPlay`, `_useDirectionLerp`,
`_lerpDuration`, …). **`FollowOwner`**, **`FollowOwnerRootTileHeight`**, **`FollowTileHeight`** (`_followTileHeightSpeed`):
follow the owner / the height of the tile under it.

**Variants by facing** (the game swaps in another effect key — named in the descriptor's `refs`, and exported):
**`SwitchableBackEffect`**
(`_backEffect`: the key used when the owner faces back), **`SwitchableRightEffect`** (`_rightEffect`, `_reverseLeftRight`,
`_reactivationMode` 0 RESUME / 1 RESTART), **`SwitchableEffectByFaceDirection`** (`_upEffect`, `_downEffect`,
`_leftEffect`, `_useDeployDirection`).

**Chains** (spawn other effect keys): **`OnPlayEmitter`** / **`OnPlayEmitterIf`** (`_effects`, `_instant`, `_preDelay`,
`_useFaceVector`, `_clearWhenFinish`, `_useSourceEffectPos`; If: `_checkType` 1 MOTION_MODE, 2 OWNER_CONTAINS_BUFF,
4 OWNER_SPINE_FACE_TO_MATCH, `_motionMode` (0 WALK, 1 FLY), `_buffKey`, `_playWhenFaceToBack`), **`OnFinishEmitter`**
(`_effects` started when this one finishes, e.g. `amgoat_skill_03_buff` → `amgoat_skill_03_buff_end`),
**`OnFinishAnime`** / **`TriggerAnimatorWhenFinish`** (set an Animator trigger at the end), **`PauseAnotherEffect`**
(`_effect`).

**`PauseEffectIf`**: pause (hide) the effect while a condition on its owner holds — `_checkAbnormalFlag` +
`_pauseWhenAbnormalFlag(s)`, `_checkAbnormalImmune` + `_pauseWhenAbnormalImmune`, `_checkNotInAbnormalFlag` +
`_pauseWhenNotInAbnormalFlag`, `_checkAbnormalCombo` + `_pauseWhenAbnormalCombo`, `_checkContainBuff` + keys,
`_checkFaceToBack` / `_checkFaceToRight`, `_checkDisappear`, `_checkUnitModeIndex`, `_checkState`, `_checkOnPlay`,
`_requireAllConditions`, `_disableMeshRendererWhenPause`. Each `_check…` is a *metadata* PauseEffectIf.CheckType:
0 NOT_CHECK, 1 CHECK_YES (pause while the condition holds), 2 CHECK_NO (pause while it does not) — not a boolean; the
`_pauseWhen…` value it tests is read only when the check is 1 or 2 (a 0 there is a value, not "off"). Flags (*metadata*
AbnormalFlag): 0 STUNNED, 5 INVINCIBLE, 9 INVISIBLE, 11 DISARMED, 12 SILENCED, 13 UNMOVABLE, 16 FROZEN, 17 CAMOUFLAGE,
23 COLD, 25 LEVITATE, 33 FEARED, 39 PALSY, 43 DOZE, 45 GROUND_BOUND, …; combos (AbnormalCombo): 0 SLEEPING,
1 SHELTERING, 2 ISOLATE. **Resolved** examples: `buff_stun` pauses while its owner is immune to STUNNED (immune check 1,
value 0) or not stunned (not-in check 1, value 0); `buff_frozen` the same with FROZEN (16); `buff_cold` while the owner
is FROZEN (flag check 1, value 16); `buff_sleep` while the owner is not SLEEPING (combo check 2, value 0). **`PauseEffectIfDisappeared`**,
**`PauseEffectIfRenderInvisible`**, **`PauseEffectWithAnimation`** (`_validAnimation`, `_invalidAnimation`,
`_delayToPause`, `_delayToRestore`, `_finishIfPause`).

**`FxLODSetting`** (Torappu.Fx; 141 prefabs): the client's own low-quality reductions — `_disableObjects` (`[{node}]`
removed at low quality), `_particleDetailsHookers` (`[{ _particle: {node, component}, _detailPercentage }]`: emission
scaled by that share). A light tier can apply it.

**Others**: `ColorModifier` (`_color` tint), `FunnelHitEffect` (`_randomRange`), `OnPlayAudioPlayer` (`_audioSignal`:
a sound — the runtime's audio may play it), and the long tail (55 classes in the used set; most occur once or twice).

### 33.12 `index.json`

```
{ format: 'fx-index', version: 1, set: 'sample' | 'used' | 'keys', source: { root, client },
  units: { id: Unit }, projectiles: { key: Projectile }, skills: { skillId: Skill },
  skins: { id: Skin }, generic: { hit, die, birth, status, keys }, prefabs: { key: PrefabSummary } }
```

**Unit** (`char_*` from charpack/, `enemy_*` from battle/enm_pfb_*, tokens from pkgrps/btl_pfb_tokens_*):

```
{ kind: 'char' | 'enemy' | 'token', prefab (bundle), rootClass ('Character' | 'Enemy' | …),
  startEffect, deadEffect (keys or null: the deploy / death effect when the unit names one),
  graphic: { path, pos, rot, scale },          the unit's Graphic node (its skin's placement and tilt)
  modes: [{ name ('Default', 'S1', 'S2', …), overrideStartEffect, overrideDeadEffect,
            attack: { class ('RangedAttack', 'MeleeAttack', 'RangedHeal', …), animKey, attackType, damageType,
                      projectileKey, extraProjectileKeys, projectileDestination,
                      cast?, hit?, attach?, inputTarget?, castTarget?: [Emit…] } }],
  skills: { skillId: Skill },                  the same objects as index.skills
  projectiles: [key…], refs: [every effect key the unit uses], skin: id | absent,
  aliasOf?: id }                               a copy of unit `id` (below)
Emit = { effects: [key…], slots?: [key | null…], directionType, oneshot, startEvent, endEvent, onlyOnce,
         useFourDirectionalFace, hookEffectAfterFirstAttack, … }
```

`modes[0]` (`Default`) is the normal attack; the others are the modes a skill switches to (`S1` = skill 1's attack,
named by the client; a skill's `mode` names it, below). An attack's `cast` effects play on the attacker, its `hit`
effects on each target hit (melee and direct attacks), and a projectile's own `onHit` effects where the projectile
arrives. **Resolved** (*metadata*): an Emit row is a `Torappu.Battle.Abilities.UberEffectEmitter` option —
`CastEffectOptions` (`cast`, `inputTarget`, `castTarget`: `_oneshot`, `_startEvent`, `_endEvent`, …),
`HitEffectOptions` (`hit`: `_oneshot`, `_endEvent` — it starts at each hit on a target, the emitter's OnCastOnTarget),
`AttachEffectOptions` (`attach`: from the ability's attach to its detach, no events); `startEvent` / `endEvent` are
`Torappu.Battle.AbilityStandard/Event` — 0 ON_ATTACHED, 1 ON_DETACHED, 2 ON_CAST_START, 3 ON_CAST_END, 4 ON_SPELL_ON,
5 ON_SPELL_END, 6 ON_ATTACK_FINISH, 7 ON_ATTACK_CHECK_POINT, 8 ON_OVERLOAD, the only enum with these names: a cast
effect plays from its start event (a one-shot just plays there) and a looping one stops at its end event. In the used
set the units' cast rows start at 2 (662) or 4 (79, the spell — the moment the attack fires) and end at 3 (719) or 6
(21). `directionType`
(*metadata* UberEffectEmitter.EffectOptions.DirectionType): 0 NONE, 1 L_OR_R, 2 U_OR_D, 3 FOUR_DIR, 4 UD_OR_LR,
5 FOUR_DIR_FIXED. `effects` are the keys a row plays: for 0 the first slot only (the client fills the other slots of
some NONE rows with leftovers — 5 rows of the used set, one naming a key the client lacks — which the game does not
play; the variants by facing then come from the effect's own `SwitchableEffectByFaceDirection`, §33.11), else every
distinct key, and `slots` holds the effect per facing as *metadata* `Torappu.SharedConsts.Direction` indexes it:
0 UP (the back view), 1 RIGHT, 2 DOWN (the front view), 3 LEFT (null: nothing; L_OR_R rows use 1 / 3, U_OR_D rows
0 / 2). `hookEffectAfterFirstAttack` (a key or '') replaces the row's effect from the second attack on; a row may have
only that. Keys the client does not have are dropped (the extractor logs them).

**Aliases.** An enemy key without a prefab of its own (`enemy_2001_duckmi_2`, `enemy_2002_bearmi_2`,
`enemy_2034_sythef_2`, `enemy_2085_skzjxd_2`, `enemy_9013_acstmk_2`, `enemy_9017_achunt_2`: elite variants) is drawn
with its base prefab: its unit is a copy of the base unit's with `aliasOf: <base id>`.

**Skill** (`[uc]skills.ab`, the skills of the units: the chess data's and every `skchr_<code>_<n>` of an operator):

```
{ effects: [every key it names — its buff templates' included], projectiles: [key…],
  mode: index into the owner's modes | null, modeBy?: 'data' | 'name',
  uses: [Use…], roles: { start?, loop?, range?, cast?, hit?, end?, ready?, trigger?, other?: [key…] },
  unclassified: [keys found in the prefab that no use places] }
Use = { role, keys: [key…], from ('UberEffectEmitter._castEffects', 'ActiveBuffAbility._buffs',
        'ActiveBuffAbility._buffs → template <templateKey>', …), node (the skill prefab's GameObject),
        ability? (the ability an emitter serves: 'MeleeAttack', 'ActiveBuffAbility', …),
        list?, startEvent?, endEvent?, oneshot?, directionType?, slots?   (an emitter row, as Emit)
        on? ('owner' | 'targets' | 'token'), buff?, template?            (a buff: who carries it, its keys)
        event?, action?                                                  (a buff template's action: a Buff event name,
                                                                          the action node: CreateEffect, CreateBuff, …)
        bb?, by? ('name': placed by the key's name) }
```

The extractor reads every behaviour of the skill prefab (its emitters, abilities, buffs, the Odin action graphs some
abilities carry) and the client's buff templates (`config/buff_template_holder.ab`, *metadata*
`Torappu.Battle.BuffTemplate`: `templateKey`, `effectKey`, `eventToActions` keyed by *metadata* `Torappu.Battle.Buff/Event`),
and gives every effect a role — when the runtime plays it on the sim's skill timeline:

| role | when | from |
|---|---|---|
| `start` | once when the skill starts (for a one-cast skill — `ReplacementSkill` — its cast) | one-shot cast rows (start event 2 / 4 / 0), `_beginEffect`, `_overrideStartEffect` (summons), `_startEffect`, `_chantSuccessEffects`, a buff template's action at ON_BUFF_START / ON_SKILL_START |
| `loop` | while the skill lasts (or the buff carrying it: `on` says on whom) | looping cast rows (start → end event), attach rows, a buff's effect (`overrideEffectKey`, else its template's `effectKey`), aura `_effects`, channel emitters, buffs a template creates |
| `range` | the skill's area marker (loop or one-shot by `oneshot`) | a cast row or a field named `*_range*`, `RangeEffectEmitter`, `_tileEffectKey` |
| `cast` | each ability use while a buff lasts | a template's action at ON_ABILITY_START / ON_ABILITY_SPELL_ON / ON_BEFORE_ATTACK |
| `hit` | each target hit (on the target) | hit / castTarget / inputTarget rows (and `MultiHitUberEffectEmitter` groups), `_hitEffect(Key)`, a template's action at ON_OUTPUT_DAMAGE / ON_AFTER_ATTACK / …, a target buff's start action |
| `end` | when the skill (or the buff) ends | cast rows starting at 1 / 3 / 5 / 6 or named `*_end`, `_endEffect`, `_beforeEndEffects`, ON_BUFF_FINISH / ON_SKILL_FINISH actions |
| `ready` | while the skill is ready to cast | `ReadySkillEffect` |
| `trigger` | a buff's other events (periodic ON_BUFF_TRIGGER, reactive ON_TAKE_DAMAGE, …; `event` names it) | template actions |
| `other` | not placed | (none in the used set) |

An emitter row's role is relative to the cast of the ability it serves (`ability`): for an `ActiveBuffAbility` or a
`ReplacementSkill`'s single attack that cast is the skill's start, so `start` / `end` / `loop` follow the skill; when the
ability is an attack the skill repeats (`MeleeAttack`, `RangedAttack`, `Multi…Attack`, `ChannelingMeleeAttack` in a
skill that lasts), they follow each of its casts — `startEvent` / `endEvent` say where in the cast.

A buff's carrier (`on`): `owner` for the buffs a skill gives its unit (`ActiveBuffAbility` without a selector,
`BuffDuringSkill`, `BuffToOwner…`, passive and chant buffs), `targets` for the buffs an attack applies (`_activeBuffs`
— status loops such as `buff_burn` on Ifrit S2's targets) and the selector-driven or aura buffs, `token` for buffs a
summon gets; absent when unknown. `by: 'name'` marks the few effects (11 in the used set: a buff blackboard's `effect`
value, an extra event group) whose field says nothing about time, placed by their names (`*_hit` / `*_heal` → hit,
`*_buff` / `*_loop` → loop, `*_start` → start, `*_end` → end, `*_range` → range).

`mode` is the owner's mode the skill switches to — its attacks then use that mode's cast / hit effects (and its
projectile): `modeBy: 'data'` when the skill's data say it (the blackboard `mode` of a `switch_mode*` buff, a
`ToggleSkill`'s `_switchToMode`), `'name'` when the owner has a mode named after the skill (`S<n>` for `skchr_…_<n>`,
case-insensitive; where both exist they agree in 204 of 210 skills). So a runtime plays, on the sim's events: skill
start → `roles.start` (+ `range`), while active → `roles.loop` on `on` (default the owner) and the attacks of
`modes[mode]`, each hit → `roles.hit` (+ the mode's hit / projectile effects), skill end → `roles.end` (and stops the
loops). The web runtime reads `uses` (not the flat `roles`) through `render/vfx/skills.js` and plays them as §33.15
says.

**Projectile** (`[uc]projectiles.ab`):

```
{ main (the flying effect key), lifeTime (s), movement: { class, … every field },
  onStart?, onReached?, onHit?, onStop?, toTargetOnStart?, toTileOnStart?, onTrigger?, onSelect?: [key…],
  effects: [every key], projectiles: [nested projectile keys], behaviours: [{ class, node, fields }] }
```

`movement.class` is `AdvancedMovement` (fields `speed` in tiles/s, `moveType` — *metadata* MoveType: 0 NONE,
1 TRACE_TARGET_WITH_SPEED, 2 TRACE_TARGET_WITHIN_TIME, 3 TWO_POINTS, 4 FIXED_DIRECTION, 5 FIXED_DISTANCE,
6 FUNC_ANGLE_AND_TIME, 7 FUNC_INIT_SPEED_AND_ACC, 8 FUNC_CURVE_AND_X_LENGTH, 9 FUNC_TURN_AND_WAVE_TO_TARGET —
`rotateToTarget`, `comeBack`, `delayToStart`, …) or `ParacurveMovement` (`speed`, `raiseHeight`,
`noRaiseHeightThreshold`, `inverseParacurve`, `useRandomHeight`, …: a lobbed arc). The sim keeps its own projectile
speeds; the visual flies `main` along the sim's flight and plays `onHit` at the target's HitPoint (`onReached` where it
lands). Graphic / logic pairs (`projectile_amgoat_s3_graphic` / `_logic`) are listed as nested projectiles.

**Skin** (mount points): `{ source, graphic, points: { name: { facing: { pos, bone, path } } } }`. `pos` is the point in
the unit's root frame (Unity axes and units, through the unit's `Graphic` node and the skin's FaceSwitcher scale) —
e.g. 隐现's `HitPoint` (0, 0.232, −0.250): 0.25 above the feet. `facing` is `front` / `back` (operators have Front and
Back skeletons) or `all`. `bone` names the Spine bone a `BoneFollower` keeps the point on (`F_Muzzle`, `B_Muzzle`,
`Muzzle`, `Hip`, …): the runtime can read that bone from the unit's skeleton for a moving muzzle, else use `pos`.
Operators' points come from `chararts/<id>.ab` (`defaultskin`) placed under the charpack's `Graphic`; enemies' and
tokens' from their own prefab. Point names vary by skin: `HitPoint`, `HeadPoint`, `HeadAnchor`, `Muzzle` /
`MuzzlePoint`, `Special0` / `SpecialPoint0` (… `1`, `2`).

**generic**: `{ hit: { phys, arts, heal, enemy, fire, cut, ranger }, die: { char, enemy }, birth: { char },
status: { <sim status>: key }, keys: [every generic key exported] }` — the keys the client binds in code (no data file
names them): the hit by damage type, deaths, deploy, and the status loops by the sim's status names (render/style.js
`STATUS_ICON` keys; e.g. `stun` → `buff_stun`, `freeze` → `buff_autochess_frozen` — this mode's own frozen effect —,
`cold` → `buff_cold`, `sleep` → `buff_sleep`, `burn` → `buff_burn`). The map is the extractor's default
(`FX_GENERIC`); `keys` also holds every prefab of `buff.ab`.

**prefabs**: key → `{ file, bundle, nodes, particleSystems, liveParticles, duration, looping, refs }` (the descriptor's
stats and `refs`).

### 33.13 The Phase 1a sample (a subset of the full set, §33.14)

`extract.py --only fx` exports (client 26-09-13, `set: 'sample'`) 126 prefabs from 32 bundles, 290 textures (each with
a half-size copy), 43 meshes, 9 units, 11 projectiles, 12 skills — 6.8 MB (descriptors 2.2 MB, textures 3.9 MB, meshes
0.4 MB, index 0.1 MB):

* the keys of the brief (`FX_SAMPLE_KEYS`): `common_hit_01`, `common_firemagic_hit_01`, `common_enemy_hit_01`,
  `common_char_die_01`, `common_enemy_die_01`, `common_char_birth_01`, `buff_stun`, `buff_frozen`,
  `buff_autochess_frozen`, `buff_sleep`, `buff_burn`, `buff_cold`, the 隐现 (`inside_attack_01_*`), 格雷伊 (`greyy_*`),
  赫默 (`silent_attack_01_trail` + `myrrh_attack_01_hit`), 伊芙利特 (`ifrit_attack_01_start`, `ifrit_skill_03_*`),
  艾雅法拉 (`amgoat_skill_03_*`), 法术大师 (`lazerd_attack_01_*`) sets and `enemy_tidmag_attack_01_hit`;
* every effect the sample units reference (`FX_SAMPLE_UNITS`: `char_498_inside`, `char_253_greyy`, `char_108_silent`,
  `char_134_ifrit`, `char_180_amgoat`, `enemy_1041_lazerd(_2)`, `enemy_1161_tidmag(_2)`) and the generic keys;
* one prefab per rarer feature (`FX_COVERAGE_KEYS`): mesh-shaped emitter `swire2_skill_02_range`, ribbon trail
  `kroos2_attack_trail_01`, particle trails `bldsk_attack_01_start`, rate over distance `vendla_attack_trail_01`, orbital
  velocity `akkord_skill_02_buff_01`, velocity alignment `jesca2_skill_01_trail_01`, horizontal billboards
  `chen2_skill_02_range_01`, custom-data shaders `enemy_tgshd_attack_start_01`, clips on GameObject.active
  `crosly_attack_a_start`, on a LineRenderer `aphris_attack_01_line_01`, on a ParticleSystem `buff_yang_conversion_01`,
  birth / collision sub-emitters `enemy_jakill_reborn_03_start` / `irene_skill_03_range_02`, prewarm + lines
  `enemy_achunt_chain`, skinned meshes + legacy clips `ifrit_skill_03_buff`, and the behaviour classes of §33.11
  (`chen2_skill_01_buff_02`, `indigo_skill_01_buff_02`, `angel2_attack_loop_start_01`, `sbell2_ground_01`,
  `lumen_skill_02_hit`, `glady_skill_01_line`, `phatm2_skill_03_buff_02`, `etlchi_innate_hit_01`, `enemy_crstf_buff_01`,
  `yu_skill1_attack_01`, `aglna2_skill_02_buff_weapon_02`);
* the keys those prefabs' behaviours name (a second pass): `amgoat_skill_03_buff_end`, `angel2_attack_up_loop_start_01`,
  `angel2_attack_down_loop_start_01`, `chen2_skill_01_buff_02_b`, `common_disarm_icon`, `indigo_skill_01_buff`.

Checked on the output: clip decoding against known values (`buff_stun` z 0 → −720 over 10.03 s; the gate pulse's
`_TintColor.a` of `[pack]map.ab`), material blend states against the shaders (AlphaBlend takes its source factor from
`_PremultiplyAlpha`, default SrcAlpha), mount points against the transforms they compose, every clip binding resolved
(675 curves, no `crc:` property; 50 name objects their prefab lacks), every key the index names has a descriptor.

### 33.14 Phase 1b: the full set

`extract.py --only fx --fx-set used` (Windows client 26-09-13, 8 processes on the maintainer's Mac) exports 516 units
(210 operators, 243 enemies, 57 tokens and the 6 enemy aliases), 538 projectiles, 529 skills and 4,253 effect prefabs
from 264 bundles — 3,990 named by the units, their skills and the skills' buff templates, the generic keys and the
sample's, then 263 named by the exported behaviours (two more passes) — with 3,303 textures (3,263 with a half-size
copy) and 1,201 meshes: 12,023 files, 186 MB — descriptors 118 MB (17 MB gzipped, as the server sends them), textures
35 MB + 15 MB half-size, meshes 11.5 MB, `index.json` 5.4 MB (0.3 MB gzipped), `textures.json` 0.85 MB; the file list
`data/local-fx.json` has 8,759 entries, 1.2 MB (0.1 MB gzipped). The run takes 172 s: the bundles' prefab lists 0.5 s
(cached; a first run reads the ~600 effect bundles once), units, skills and buff templates 47 s, the prefabs 124 s
(757 s of CPU). No prefab fails, and the consistency test (`test/local-extract-fx.test.js`) passes on the output: every
key the index names — attack rows, slots, hooks, skill uses — has a descriptor, every listed file exists.

Skills: 497 of the 529 have effect roles (§33.12; 0 keys left unclassified, 11 effects placed by name); 22 more name no
effect of their own but switch to a mode, whose attacks carry their effects; 10 name neither — `skchr_doroth_1`–`3`,
`skchr_prove_1`, `skchr_silent_2`, `skchr_sunbr_1`, `skchr_svrash_1`, `skchr_vodfox_2`, `skchr_vvana_3`,
`skchr_wang_1`: what the client shows for them comes from what they place (tokens, traps), the unit's own animation, or
nothing. 333 skills have a mode (221 from their data, 112 by name).

### 33.15 The runtime's skill wiring (0.3.0 Phase 3b)

The field view plays a skill's effects from its `uses` (`render/vfx/skills.js skillPlan`: each use placed by its
role, its ability, its events and its carrier — the module header; `render/vfx/skillfx.js` plays the plan, DESIGN §9
"Official battle effects", Skills). What it reads, and what it does with the fields a later extractor adds:

* **A unit's skill**: the unit by FxWiring's candidates (a stand-in's or a 自选 pick's operator, the chess' operator,
  the spine, the def id), its skill from our data record's `skills[]` by the loadout's index (`prefabId`, else
  `skillId`), looked up in the unit's `skills`, then in `skills`; without a record, `skchr_<code>_<index + 1>`.
* **Modes**: `skills[id].mode` names the attack mode while the skill is on (`modes[mode].name`; a mode whose name ends in
  `[Down]` / `[D]` is a facing variant and not chosen). A unit without a resolved skill keeps `S<n>`.
* **Events**: a use's `startEvent` / `endEvent` are AbilityStandard/Event names (`ON_CAST_START` …), a unit's Emit row's
  numbers; ON_ATTACHED / ON_CAST_START rows start with the cast (the attack's wind-up), the others at the strike.
* **Attack abilities** (`ability` matching /Attack|Heal/, not Channeling*): their rows replace the attack mode's while
  the skill is on; a ranged one flies one of the skill's `projectiles` — the only one, else the shortest named
  `_s<n>` / `_sk<n>` after the skill's number, else the first (index.json does not say which ability fires which
  projectile: an ability's `projectileKey` on its uses would settle it).
* **Hit groups**: `MultiHitUberEffectEmitter._hitGroups` rows arrive flattened; a use's integer `group` (a later
  extractor) is taken as the group index when present, else the `_range` rule of §33.12's skills.js reading.
* **Buffs on targets** (`on: 'targets'`) from an attack ability's `_activeBuffs` loop on that attack's targets for our
  record's blackboard duration (`duration`, `…_duration`, `….duration`) — the template's own life time is not exported.
* **Charges**: a unit's `charge` ({ cap, slots: [{ spell: [key…], cast: [key…], mount: MountPointType }], projectiles: {
  mode: key }, … } — CHARGE_EMITTERS' shape) replaces the transcribed table when present (`skills.js chargeSource`).
* **Root class**: a skill's `rootClass` (ReplacementSkill, CastSkill, …) is kept on the plan (`plan.rootClass`); the
  runtime's one-cast rule does not need it (a skill turned on and off in one frame without an attack).
* **Enemy and token skills**: none in this index (`reason: 'enemy-skill'` / `'token-skill'`); a token's skill found in its
  unit's `skills` by our record's id plays like an operator's. An enemy's skill slot (the sim's ['cast', id, slot]) has
  no reader yet.
* **Projectile reached effects**: a skill projectile's `onReached` (else `onHit`) is what `skills.js FX_BINDINGS` plays
  where a kit's fx stands for that projectile (克莱门莎 S3's `projectile_chr_clemnt_s3`).

