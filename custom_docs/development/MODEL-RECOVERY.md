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

### Held impostor images stayed blank after WebGL restoration

Frozen and downed units can retain their final pose in a shared impostor atlas or
a private render texture. WebGL context restoration invalidates those GPU image
contents. The held-pose optimization previously skipped repainting them because
the actor had not moved, leaving an empty cached image indefinitely.

A real Chrome control lost and restored the context with `WEBGL_lose_context`:
the held model went from 4,967 nontransparent pixels to zero. Manually marking
the impostor dirty restored all 4,967 pixels. This confirms another independent
failure mechanism, not that context loss occurred in the original screenshots.

Impostors now track the renderer's context identity and repaint after it changes.
Each atlas page also clears itself on its first draw in the new context. Shared
and private targets recovered automatically in Chrome, retaining the same actor
and render target; the held-pose optimization resumes after the redraw. No model
redownload, simulation restart or continuous pixel scan is required.

The new browser test's evaluation callback ran through Playwright at 1280x720
and 390x844 against the local raw-object CDN. Both shared and private targets
retained nonzero pixels after restoration (4,668 on desktop; 477/476 on mobile).
Screenshots were inspected at both sizes. This exercised the browser regression
body, not its Puppeteer launcher. The non-browser renderer and asset-CDN suite
passed 582 tests with two skips; `npm run build` also passed.

### A model loaded while stunned could cache an unposed skeleton

The 120-unit stress scene exposed three persistent blank models: Gavial the
Invincible, an enemy shield guard and an enemy recruit. Their textures were
valid, but they entered stun before their first Spine update. Without a stun
clip, `frozen` skipped that update while still marking the pose as applied.
Repainting alone left them blank; `spine.update(0)` followed by a repaint restored
all three without advancing their animations or reloading their assets.

Frozen actors now apply their first pose and pending tint/clip changes at zero
animation time. Unchanged poses remain cached; failed pose updates are not marked
as applied. A fresh browser run checked all 91 living models in the stress scene
twice with no blank models or invalid textures. All three initially stunned
models remained visible with track time zero. Degenbrecher's Skill 3 disappearance
is an intentional animation and is not counted as a loading failure.

### WebGL restoration left Pixi extensions disabled

The shipped Pixi 7 context-restored handler rebuilt GPU resources without calling
`getExtensions()` again. WebGL disables extensions on context loss, so cached
anisotropic-filtering enums produced `INVALID_ENUM` warnings after restoration.
A capture-phase restoration listener now refreshes extensions before Pixi's
resource-rebuild listener runs; it is removed when the view is destroyed.
Two real browser restorations (shared atlas and private target) retained visible
model pixels, reported no matching warnings and ended with `gl.getError() === 0`.

The combined non-browser renderer/asset-CDN suite passed 586 tests with two skips;
the production Vite build passed. Browser checks used Playwright because the
standalone Puppeteer launcher timed out in this environment.

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
- `test/render/held-pose.test.js`: one redraw after context restoration for both
  shared and private targets, then held-pose update skipping resumes.
- `test/render/impostor-context.test.js`: atlas pages clear once per context.
- `test/render/frozen-pose.test.js`: first pose, tint/clip changes, thaw and retry
  after a failed pose update while frozen.
- `test/render/pixi-extensions.test.js`: extension refresh precedes resource
  rebuilding, and the restoration listener is removable.
- `test/render/context-recovery.browser.test.js`: real held-model pixels survive
  context restoration in both target types at desktop and mobile viewport sizes.
  Opt in with `RENDER_E2E=1`; requires Chrome and downloaded art.

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

## Shared DOM and Canvas Image Policy

R2 custom-domain responses can omit CORS headers when the request has no Origin,
even with a valid bucket allow policy. A normal DOM image can therefore seed the
browser HTTP cache with a response that a later anonymous Canvas/WebGL image
cannot use. This explains a detail-card icon loading while its battlefield plate
remains the question-mark fallback.

All DOM image templates now request anonymous CORS before setting `src`. The
shared `public/js/image.js` loader uses the same policy. On failure it refreshes
the original URL once with a CORS `fetch` and `cache: 'reload'`, then retries the
image. Concurrent refreshes of one URL share a request; the refresh times out
after ten seconds. DOM recovery checks that the element is still mounted and
still has the same URL before applying its result. Permanent failures retain the
existing UI fallback, without an automatic retry loop.

Resource hashes, downloaded packs and CacheStorage entries are unchanged. This
is a targeted migration of old HTTP-cache entries, not a global cache purge.
`test/render/image-cors-recovery.test.js` covers bounded recovery, concurrency
and stale elements; `test/ui/image-policy.test.js` guards every DOM image entry.
Browser checks against an Origin-dependent local CDN also confirmed recovery of
the three reported icons and a valid, nonblank ItemView texture after warming a
legacy non-CORS cache entry. Real network errors or denied CORS still require a
fallback; this policy does not make unavailable resources downloadable.

## Vite Is Not a Resource-Lifecycle Fix

The project already builds the production client with Vite. Bundling reduces
JavaScript module requests and produces versioned chunks, but the model's skeleton,
atlas and image pages are still loaded at runtime. It cannot correct stale Pixi
resolver metadata, reference-count corruption, or blank restored render targets.
Those require the runtime fixes and regression coverage above. Do not disable
texture garbage collection or pin all models permanently to hide the symptoms.
