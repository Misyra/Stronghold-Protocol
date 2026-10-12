# Model Disappearance: Findings and Regression Coverage

## Confirmed Failure Mechanisms

The scene can keep a unit's shadow, rank and combat state while losing its model.
Those elements are separate from the Spine actor; their presence does not prove
that the model's page textures are usable.

### Disposed atlas reused after an unload

In per-file CDN manifest mode, `loadSpineData` supplies an explicit `spineAtlas`.
Pixi Assets retains resolver metadata after unloading an asset and ignores new
metadata supplied for an already registered URL. Without refreshing that resolver
record, a reload can parse the skeleton against the previous atlas, whose page
textures were destroyed by the preceding unload. Creating the Spine object can
still succeed, so the renderer hides its fallback and draws an invisible model.

The resolver refresh was already fixed in `fca74861`. A local Chrome control
experiment on 2026-10-12 deliberately restored the disposed metadata before the
second parse: the constructed model had 25 used textures, all destroyed/invalid.
The fixed path rendered nontransparent pixels through 25 full unload/reload
cycles covering two operators' Front/Back models and one enemy.

This explains a scene-switch-dependent failure mechanism, not proof that every
production report has the same cause. Cache pressure and which models a scene
reuses affect which units encounter it. This investigation made no production
changes and did not verify the currently deployed client version.

### Build errors had no recovery path

`UnitView` used to retry rejected downloads, but returned immediately when actor
construction threw. Failures while restoring the unit's pose were outside that
handler; an orientation swap could discard the working actor first.

Construction and pose setup now share the bounded download-failure recovery path,
including local-to-web fallback. A replacement is prepared before the previous
actor is retired. Partial actors are destroyed without destroying shared textures.
Retry counters reset only after installation succeeds; a failed orientation swap
can retry while keeping the old model visible.

### Expired failures could corrupt reference counts

`RefLru.acquire` previously replaced expired failed entries even when callers still
held references. Their later `release(key)` calls could decrement the replacement
entry, allowing a live resource to be evicted. Both TTL expiry and explicit retry
now require zero references before replacing a failure.

## Additional Guards

- Invalid atlas pages are rejected rather than accepted as a ready model.
- Asynchronous atlas page callback errors reject the load instead of leaving it
  pending until timeout.
- Unload drops the resolver's old atlas reference, but never a newer load's atlas.
- No cache-budget increase, permanent resource pinning or per-frame skin scan was
  introduced. Missing or permanently broken assets still use a fallback after
  bounded retries; the application cannot guarantee successful downloads.

## Tests

- `test/render/model-recovery.test.js`: construction failure, bounded retries,
  atomic orientation replacement, partial actor cleanup and local-model fallback.
- `test/render/assets.test.js`: referenced failure expiry and cache lifecycle.
- `test/asset-cdn.test.js`: invalid atlas/page rejection and resolver cleanup.
- `test/asset-cdn.browser.test.js`: real textures and extracted pixels across 25
  unload/reload cycles. Opt in with `SP_E2E=1`; requires Chrome and downloaded art.

The browser evaluation callback was also executed through the Playwright browser
tool against a local raw-object CDN. This does not exercise Puppeteer's launcher.
Desktop (1440x900) and mobile-sized (390x844) demo scenes additionally completed
17 prep/united-defense/normal/final-assault transitions without missing actors,
invalid textures or logged errors. The desktop test changed model orientation in
each scene. After the idle grace elapsed, the cache reclaimed idle models down to
its existing 48 MiB budget; subsequent scene transitions still rendered correctly.
Both viewport sizes were inspected with screenshots and canvas pixel checks.
After deployment, existing tabs must load the updated client; files already
executing in a browser are not replaced by a server restart.
