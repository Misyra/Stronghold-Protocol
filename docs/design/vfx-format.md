# DESIGN §33 — Official battle effects (特效): the extracted format

Part of [DESIGN.md](../DESIGN.md) (the index; section numbers are global).

## 33. Official battle effects — the extracted format (0.3.0, Phase 1a)

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

**Status (Phase 1a).** The extractor and this format exist for a sample (§33.13); the runtime is the next phase. Values
marked **[verify]** are read from the data but their exact runtime behaviour still has to be compared with the client.
Enum names marked *metadata* come from the client's il2cpp metadata (`Arknights_Data/il2cpp_data/Metadata/
global-metadata.dat`, version 29, not encrypted: the enum constants with their values).

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
is a file of its own — ~8,300 entries for the full set — so that `data/local-assets.json`, which every page loads, stays
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

Timings on the maintainer's Mac (Windows client 26-09-13, 8 processes): the sample (126 prefabs, 290 textures,
43 meshes, 6.8 MB) takes ~17 s, ~10 s more on the first run (the bundles' prefab lists: 606 effect bundles read once,
then cached in `.cache/fx/`). The prefab export costs ~0.35 s CPU per prefab; libwebp effort 4 (`WEBP_METHOD`; effort 6
is ~90× slower here for 4.5 % smaller files).

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
particles clockwise on screen for positive angles, the opposite of a Transform's Z rotation **[verify]** —,
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
  `multiplyDragByParticleVelocity`, `inWorldSpace`. **[verify]** the step size (Unity applies dampen per simulation
  step: sub-step at ≤ 1/30 s, §33.2).
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
index = floor(frac(startFrame + frameOverTime(frac(t · cycles))) · frames) **[verify]**; frames run left to right, top
to bottom (frame 0 is the top-left tile).

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
Custom1.xy, TEXCOORD1.xy = Custom1.zw. **[verify]** against the shader inputs of the `*(CustomData)` family.

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
Semantics below are read from the field names, the data and the client's enum names (*metadata*); **[verify]** marks
the ones a runtime should compare with the client.

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
**`FxUVRotation`**: `_propertyName` (e.g. `_Rotation`), `_rotateTex1…4`, `angle1`, `_angle2…4` — sets a rotation
property per texture **[verify]**.

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
`_requireAllConditions`, `_disableMeshRendererWhenPause`. Flags (*metadata* AbnormalFlag): 0 STUNNED, 5 INVINCIBLE,
9 INVISIBLE, 11 DISARMED, 12 SILENCED, 13 UNMOVABLE, 16 FROZEN, 17 CAMOUFLAGE, 23 COLD, 25 LEVITATE, 33 FEARED,
39 PALSY, 43 DOZE, 45 GROUND_BOUND, …; combos (AbnormalCombo): 0 SLEEPING, 1 SHELTERING, 2 ISOLATE — e.g. `buff_stun`
pauses while its owner is immune to FROZEN (16) **[verify]**. **`PauseEffectIfDisappeared`**,
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
  units: { id: Unit }, projectiles: { key: Projectile }, skills: { skillId: { effects, projectiles } },
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
  skills: { skillId: { effects: [key…], projectiles: [key…] } },
  projectiles: [key…], refs: [every effect key the unit uses], skin: id | absent }
Emit = { effects: [key…], directionType, oneshot, startEvent, endEvent, onlyOnce, useFourDirectionalFace, … }
```

`modes[0]` (`Default`) is the normal attack; the others are the modes a skill switches to (`S1` = skill 1's attack,
named by the client). An attack's `cast` effects play on the attacker, its `hit` effects on each target hit (melee and
direct attacks), and a projectile's own `onHit` effects where the projectile arrives. `startEvent` / `endEvent` are
ability events — likely (*metadata*) 0 ON_ATTACHED, 1 ON_DETACHED, 2 ON_CAST_START, 3 ON_CAST_END, 4 ON_SPELL_ON,
5 ON_SPELL_END, 6 ON_ATTACK_FINISH, 7 ON_ATTACK_CHECK_POINT, 8 ON_OVERLOAD (normal attacks start a cast effect at 2,
skill modes at 4, both end at 3) **[verify]**. `directionType` (*metadata* DirectionType): 0 NONE, 1 L_OR_R, 2 U_OR_D,
3 FOUR_DIR, 4 UD_OR_LR, …. Skills list the effect keys found anywhere in the skill prefab (`[uc]skills.ab`): which event
plays which key is not in the data the extractor reads — `*_start` at activation, `*_buff` while active, `*_range` /
`*_hit` per hit by naming convention.

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

### 33.13 The Phase 1a sample

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

### 33.14 Phase 1b (the full set)

`--fx-set used` exports every effect the mode's units reference. A dry run of its crawl (client 26-09-13) finds
510 units (210 operators, 243 enemies — six `_2` variants have no prefab of their own —, 57 tokens), 538 projectiles,
529 skills and 3,869 effect prefabs (3,834 referenced + the generic keys) in 264 bundles, in 45 s; the export is ~0.35 s
CPU per prefab (~23 minutes of CPU, ~3–4 minutes with 8 processes), before the second pass over the keys behaviours
name. Expected output: ~3,400 textures, ~435 meshes — about 40 MB of WebP and ~60 MB of JSON (10 MB gzipped). Still to
do there: run and check it (every key an index entry names has a descriptor — the consistency test does this on any
extracted set), and the manifest's size (one entry per file: ~8,000 entries, ~1 MB raw / ~150 KB gzipped added to
`data/local-assets.json`) — a separate served manifest for fx may be wanted.
