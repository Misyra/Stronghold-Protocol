# AGENTS.md

Entry point for AI coding assistants (Codex, Claude Code, Cursor, Copilot …) working on this repository. It only
indexes the existing documents and their hard rules; when this file and a linked document disagree, the document wins.
Human contributors: [CONTRIBUTING.md](CONTRIBUTING.md) is the same material in full.

## What this is

A non-commercial fan remake of Arknights「卫戍协议：盟约」 that runs in the browser: a Node.js server (economy, rounds,
rooms) and a deterministic battle sim shared by the server and the browser. It aims to be faithful to the official mode.

Code shape in one glance: three classes keep their constructor in one file and their methods in a folder installed on
the prototype (`server/sim/Battle.js` + `server/sim/battle/`, `server/match/Match.js` + `server/match/match/`,
`server/match/PlayerState.js` + `server/match/player/`); two client modules are barrels over folders
(`public/js/ui/gameLogic.js`, `public/js/render/fx.js`). `server/sim/` is served verbatim to browsers at `/sim/` —
that is why its imports are constrained. Every file is mapped in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §3.

## Read first

1. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the code map: where things live, data flow, golden results,
   import boundaries, where common changes start. §6's table maps each kind of change to its files; §7 states the
   worker-pool rule of thumb (pure CPU over data the worker can hold → a pool task; sockets, timers, lobby → the
   main thread).
2. [docs/DESIGN.md](docs/DESIGN.md) — the index of the rules: current rules in `docs/design/`, each release's
   revisions and their evidence in `docs/history/`. Section numbers are global and never change; code and tests cite
   them as "DESIGN §N".
3. The reference for the part you touch: [docs/SIM.md](docs/SIM.md) (battle engine API, hooks, test harness),
   [docs/META.md](docs/META.md) (match flow, shop, protocol), [docs/DATA.md](docs/DATA.md) (generated data),
   [docs/I18N.md](docs/I18N.md) (interface strings), [docs/PLUGINS.md](docs/PLUGINS.md) (plugin system, content hash),
   [docs/DEPLOY.md](docs/DEPLOY.md) (deployment, access gate, P2P), `server/sim/content/kits/README.md` (operator kits).
4. Before editing battle simulation code, read [server/sim/AGENTS.md](server/sim/AGENTS.md) for a short settlement API usage guide.
5. [docs/CI.md](docs/CI.md) — the CI jobs, the test-sharding contract (`ci-shards.json`), how to re-weigh it, the
   timeout policy, and the ways a CI measurement lies.

## Hard rules

- **Formatting.** Use two spaces for JavaScript indentation; do not introduce Tab indentation.
- **Official first.** Rules come from the official data tables (`.cache/gamedata/excel/` after setup) and
  [PRTS](https://prts.wiki/). A detail no source settles is implemented the simplest way and marked `[ASSUMED]` in the
  code and the PR. Deliberate deviations from the official mode are the maintainer's decision only.
- **Determinism.** `server/sim/` is plain ESM that runs in Node and in browsers: no Node APIs, no `Math.random`, no
  clocks, and no engine-approximated Math functions (use `server/sim/detmath.js`; ESLint and
  `test/sim/detmath.test.js` enforce it).
- **Golden results.** A refactor must not change `test/golden/*.json`. An intended gameplay change runs
  `npm run golden:update` in the same commit, and the commit / PR names every moved scenario and why
  ([test/golden/README.md](test/golden/README.md)).
- **Generated data.** Never hand-edit `data/*.json`: change `tools/build-data.mjs` and regenerate. A rebuild's JSON
  diff must show only the intended change.
- **No game art in git.** `public/assets/` is ignored; never commit extracted or downloaded game files.
- **Preload packs are not art.** `public/resource-packs/*.zip` (git-ignored) and their index
  `data/resource-packs.json` are the player preload packs, built with `npm run resources:packs` and handed out through
  the 预载资源 ZIP card and the maintainer's download page (`SP_RESOURCE_PACK_ROUTES`). They are a delivery line of
  their own: a pack missing from the R2 bucket, from `.assets-manifest.json` or from an asset-coverage report is not a
  missing asset — leave it alone. Art means `public/{assets,fonts,media}` and its manifest
  ([docs/ASSETS.md](docs/ASSETS.md)「ZIP resource packs」).
- **Two delivery paths, fixed roles.** Per-file requests go to the R2 bucket over its S3-compatible API
  (`tools/r2-s3-upload.mjs`, SigV4, `.assets-manifest.json` as the resume state): that is a preload that fell back, and
  everything a match asks for outside the preloaded set. Preload itself prefers the ModelScope dataset
  `Misyra/Arknight_Assets` through the category ZIPs: the client uses those packs first (a relaxed coverage
  gate plus a bigger retry budget on the ModelScope route) and R2 covers only the remaining gap. Build
  new packs for uncovered files with `npm run resources:packs -- --scopes gap` (append-only,
  `tools/assets/gapPacks.mjs`); never rebuild the whole index with `--scopes all` on a live dataset.
  Do not make packs the primary R2 path, and do not serve per-file art from ModelScope.
- **ModelScope is append-only and incomplete.** The dataset predates the current art and does not hold all of it:
  publish only the packs built from newly added files, append their entries to `data/resource-packs.json`, and never
  rewrite, renumber, re-pack or delete an existing pack. Every ZIP an older index names must keep resolving — a client
  must never 404 or fail because of a publish. Adding is the only safe operation there.
- **Interface strings** go through `t('…')`, with entries in every pack under `public/i18n/`
  (`node tools/i18n.mjs check --all --strict`). Developer logs are exempt (`// i18n-ignore`).
- **The browser client is native ESM.** `public/js/` loads with no bundler and no build step: no Node APIs, no
  `require`, imports resolve as URLs (see `tools/check-imports.mjs`). Pure in-match logic lives in
  `public/js/ui/gameLogic/` and must stay DOM-free and clock-free — Node unit-tests it directly.
- **The protocol is normative.** `shared/protocol.js` holds one `C2S` validator per client message; a new message
  starts there, and the handler never trusts what the validator does not already bound (types, lengths, shapes).
  Requests carrying `rid` are answered `ok`/`error` echoing it ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §2).
- **CPU-heavy server work goes to the worker pool.** Pure CPU over data a worker thread can hold
  (`server/workers/pool.js`) belongs in a task with a fallback for `POOL_FULL`/failure; anything touching sockets,
  timers or the lobby stays on the main thread (docs/ARCHITECTURE.md §7).
- **Performance changes are measured.** Before/after on the same machine, with the project's tools
  (`tools/workerbench.mjs`, `tools/memorybench.mjs`, `tools/state-sync-micro.mjs`, `tools/bench-state-delta.mjs`,
  `tools/perfbench.mjs`, `tools/loadgen.mjs`, `tools/perf2-lcp.mjs`, `tools/perf2-probe.mjs`) — and golden results
  must not move. A change without a verified A/B win is not merged. See [§ Performance acceptance](#performance-acceptance)
  for the A/B protocol, the metrics table and the rollback rules (2026-11-06 round 2).
- **Security-sensitive surfaces keep their guards.** The studio is local-network only and every change carries the
  studio key (`server/studio/`), plugin installs re-validate zips and hashes (`server/plugins/install.js`,
  `zip.js`), the access gate binds a cookie and rate-limits (`server/http/gate.js`), paths go through
  `server/pathSafety.js`. A change to one of these names the security impact in the PR.
- **Docs follow the code.** A rule change updates `docs/design/`, the current `docs/history/` file and the reference
  docs; run `node --test test/docs-consistency.test.js test/docs-paths.test.js`.
- **Commits and PRs**: one topic per PR; a one-line message of what changed (Chinese or English) with the issue number;
  no attribution trailers (`Co-Authored-By:`, `Generated with …`). The PR description states what, why, the sources,
  the `[ASSUMED]` points, the tests you ran (paste the summary lines) and the golden moves. No ads, payments or other
  monetisation — the project stays non-commercial.

## Verify

Run the tests of what you touched first, then everything before opening the PR:

```bash
node --test test/<area>/<file>.test.js      # targeted
npm run ci                                  # the CI checks locally (tools/ci.mjs): npm test, smoke, lint, imports, types
npm run golden                              # golden results
```

`npm run lint` allows warnings but not errors; `npm run typecheck` checks the JSDoc slice (`jsconfig.json`,
`types/README.md`); `npm run check:imports` enforces the sim/match/net import boundaries. All three run inside
`npm run ci`.

Browser suites are off by default and need Chrome: `SP_E2E=1` (UI), `SP_REAL_E2E=1` (real match, needs assets),
`RENDER_E2E=1`, `SIM_E2E=1` — see CONTRIBUTING.md §2. Battle tests are easiest with the helpers described in
docs/SIM.md (the test harness section) and the patterns in `test/content/op_siege.test.js`.

## Performance acceptance

Performance work is a measured change, not a cleanup. Every optimization PR states the baseline, the A/B result,
the residual risk and the rollback; a merged change with no verified win is a bug in the process.

**A/B protocol (mandatory).** Host load on the measurement machine drifts ±40–60% between sessions, so a single
sequential before/after pair is not evidence. Interleave the two variants (`ABBA` / `ABAB`, ≥4 rounds), take the
**minimum** per round (noise only adds, the min converges to the interference-free floor), and report every raw
round. A/B variants differ by exactly one variable — same build, same port, same seed, same warm/cold cache state.
Browser rendering uses `tools/perfbench.mjs --profile` with `CHROME_PATH` (Edge headless works on this machine),
CPU-profiler self-time by function is the unit of account; cold-page loading uses Edge + CDP
`Network.emulateNetworkConditions` (`tools/perf2-lcp.mjs`) with fresh contexts. Server endpoints use alternating
curl batches; worker/broadcast paths use `tools/loadgen.mjs` (a `--rehearsal-answer-ms` delay knob exists for
rehearsal A/B) and the `[loop]` / `/healthz?traffic=1` counters.

**Verification bar before an optimization is accepted:**

| Check | Bar |
|---|---|
| Golden results | `npm run golden` — all 291 scenarios match (roster 49 / bonds 46 / fields 22 / matches 21 / standins 10 / diy 143). A performance PR moves zero scenarios; a "242" count is a truncated roster line, not a pass. |
| Full suite | `npm test` / `npm run ci` — failure set **name-by-name identical to the same-HEAD baseline**. On a machine without `public/assets` extraction, 7–8 asset-coverage failures and an occasional `test/sim/robustness.test.js` 0.5 ms threshold wobble are environmental; prove it by comparing with the baseline, never by ignoring them. |
| Determinism | `server/sim/` unchanged by value: result payloads byte-identical; worker-pool consumer contract mirrors the real return shape; `test/workers-room.test.js` stays anchored on the real pool. |
| Serial measurement | Never run full `npm test` from two worktrees at once — they starve each other and trigger false sim CPU-threshold failures. Full suites and golden run serially. |
| Browser build | A `vite.config.js` change keeps the `/shared` `/sim` `/data` native-module boundary, both Workers' URLs and the `generateBundle` entry-script guard; `npm run build` + build-page probe (mount, screen switch, zero uncaught errors) before/after. |

**Quantified results must name the metric and its boundary.** "app chunk lands at 213 ms instead of 4832 ms" is a
transfer-side fact; it does **not** license "entering a match is 4.6 s faster" when the first-frame measurement is
noise-dominated. State what was measured, what was not, and why. A negative or risk-only result is a valid
deliverable: revert the commit and record the measurement so it is not retried (the 2026-11-04 round-1 rejected
list lives in the project memory / `docs/`).

**Rollback shape.** One topic per branch, one-line Chinese commit, no attribution trailers. Every optimization
carries a self-contained rollback: `git revert <sha>` for single-file/stateless changes, an env switch for
behavioural knobs (`SP_STEP_PACKET=full`, `SP_BOT_REHEARSAL_COLD_ANSWER_MS=0`, `POSE_SKIP_PX=0`), and
`git revert <sha>` + `npm run build` for bundle changes (output is content-addressed and git-ignored). Defaults that
affect official-mode appearance stay OFF until the maintainer decides.

**Round-2 measurements (2026-11-06, master `963ea741`, `REVIEW-2026-11-06-perf2.md`):** 10 branches / 19 commits,
baseline loadgen 232.4 msg/s · RSS 280.9 MB · loop p95 22.5 ms, golden 291/291 throughout. Representative wins:
304 revalidation 13.5→0.20 ms (69×), plugins index p50 −57%, drag highlight redraw −92%, step packet −71% /
tick-RPC −36%, cold-host rehearsal pool runs 8→0 (CPU 29.5→7.5%), film grain ~200× Node / ~24× page,
entry brotli −45.1% / cold first-screen download −22.8% / LCP min −20.3%. Each branch keeps its own A/B table
and rollback note; merging is one topic per PR.
