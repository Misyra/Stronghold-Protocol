# AGENTS.md

Entry point for AI coding assistants (Codex, Claude Code, Cursor, Copilot …) working on this repository. It only
indexes the existing documents and their hard rules; when this file and a linked document disagree, the document wins.
Human contributors: [CONTRIBUTING.md](CONTRIBUTING.md) is the same material in full.

## What this is

A non-commercial fan remake of Arknights「卫戍协议：盟约」 that runs in the browser: a Node.js server (economy, rounds,
rooms) and a deterministic battle sim shared by the server and the browser. It aims to be faithful to the official mode.

## Read first

1. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the code map: where things live, data flow, golden results,
   import boundaries, where common changes start.
2. [docs/DESIGN.md](docs/DESIGN.md) — the index of the rules: current rules in `docs/design/`, each release's
   revisions and their evidence in `docs/history/`.
3. The reference for the part you touch: [docs/SIM.md](docs/SIM.md) (battle engine API, hooks, test harness),
   [docs/META.md](docs/META.md) (match flow, shop, protocol), [docs/DATA.md](docs/DATA.md) (generated data),
   [docs/I18N.md](docs/I18N.md) (interface strings), `server/sim/content/kits/README.md` (operator kits).
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
- **Generated data.** Never hand-edit `data/*.json`: change `tools/build-data.mjs` and regenerate.
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
  `Misyra/Arknight_Assets` through the category ZIPs. Do not make packs the primary R2 path, and do not serve per-file
  art from ModelScope.
- **ModelScope is append-only and incomplete.** The dataset predates the current art and does not hold all of it:
  publish only the packs built from newly added files, append their entries to `data/resource-packs.json`, and never
  rewrite, renumber, re-pack or delete an existing pack. Every ZIP an older index names must keep resolving — a client
  must never 404 or fail because of a publish. Adding is the only safe operation there.
- **Interface strings** go through `t('…')`, with entries in every pack under `public/i18n/`
  (`node tools/i18n.mjs check --all --strict`).
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

Browser suites are off by default and need Chrome: `SP_E2E=1` (UI), `SP_REAL_E2E=1` (real match, needs assets),
`RENDER_E2E=1`, `SIM_E2E=1` — see CONTRIBUTING.md §2. Battle tests are easiest with the helpers described in
docs/SIM.md (the test harness section) and the patterns in `test/content/op_siege.test.js`.
