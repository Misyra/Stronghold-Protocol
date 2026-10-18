#!/usr/bin/env node
/**
 * Docker Compose production deployer.
 *
 * Default: read-only plan. Use --apply to:
 *   1. validate compose;
 *   2. back up compose/config/data manifests and record the old image;
 *   3. upload data/assets/fonts/packs to the configured static root;
 *   4. build the stronghold image;
 *   5. recreate only the game service (never `down -v`);
 *   6. wait for /healthz and roll the service back to the old image on failure.
 *
 * It deliberately does not edit config/announcements.json, Redis data, or compose secrets.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULTS = {
  compose: path.join(ROOT, 'docker-compose.yml'),
  service: 'stronghold',
  redis: 'redis',
  health: 'http://127.0.0.1:3080/healthz',
  staticRoot: process.env.SP_STATIC_ROOT || '',
  dataTarget: process.env.SP_DATA_TARGET || '',
  assetsTarget: process.env.SP_ASSETS_TARGET || '',
  fontsTarget: process.env.SP_FONTS_TARGET || '',
  packsTarget: process.env.SP_PACKS_TARGET || '',
  python: process.env.SP_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
  assetSource: process.env.SP_ASSET_SOURCE || 'direct',
  backupRoot: process.env.SP_DEPLOY_BACKUP_ROOT || path.join(ROOT, '.cache', 'deploy-backups'),
  waitSeconds: 120,
  stopTimeout: 30,
};
let options;

const usage = `用法：
  node scripts/deploy-compose.mjs --compose /srv/stronghold/docker-compose.yml
  node scripts/deploy-compose.mjs --compose docker-compose.yml --apply

重要选项：
  --apply                 实际执行；不加时只做检查和输出计划
  --prepare-assets        自动下载素材、重算哈希并生成 16MB 分包（不转换图片/音频）
  --asset-source <mode>   setup/fetch-assets 源：direct 或 mirror
  --python <command>      Python 命令，默认 python3（Windows 默认 python）
  --pull                  apply 前执行 git pull --ff-only
  --compose <file>        Compose 文件
  --project <name>        Compose project name
  --service <name>        游戏服务，默认 stronghold
  --health <url>          健康检查地址，默认 http://127.0.0.1:3080/healthz
  --static-root <dir>     CDN 静态根目录；自动使用其 data/assets/fonts/resource-packs 子目录
  --data-target <dir>     覆盖数据同步目录
  --assets-target <dir>   覆盖素材同步目录
  --fonts-target <dir>    覆盖字体同步目录
  --packs-target <dir>    覆盖 16MB 资源包同步目录
  --backup-root <dir>     备份目录
  --skip-data             不同步 data
  --skip-assets           不同步 public/assets/fonts
  --skip-packs            不同步 public/resource-packs
  --no-build              不构建镜像
  --wait <seconds>        健康检查超时，默认 120
  --help

不会执行 docker compose down -v，不会删除 Redis volume，不会覆盖公告配置。
`;

function parseArgs(argv) {
  const o = { ...DEFAULTS, apply: false, pull: false, prepareAssets: false, skipData: false, skipAssets: false,
    skipPacks: false, noBuild: false, project: '', compose: DEFAULTS.compose };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] || '';
    if (a === '--apply') o.apply = true;
    else if (a === '--pull') o.pull = true;
    else if (a === '--prepare-assets') o.prepareAssets = true;
    else if (a === '--skip-data') o.skipData = true;
    else if (a === '--skip-assets') o.skipAssets = true;
    else if (a === '--skip-packs') o.skipPacks = true;
    else if (a === '--no-build') o.noBuild = true;
    else if (a === '--compose') o.compose = path.resolve(next());
    else if (a === '--project') o.project = next();
    else if (a === '--service') o.service = next();
    else if (a === '--health') o.health = next();
    else if (a === '--static-root') o.staticRoot = path.resolve(next());
    else if (a === '--data-target') o.dataTarget = path.resolve(next());
    else if (a === '--assets-target') o.assetsTarget = path.resolve(next());
    else if (a === '--fonts-target') o.fontsTarget = path.resolve(next());
    else if (a === '--packs-target') o.packsTarget = path.resolve(next());
    else if (a === '--python') o.python = next();
    else if (a === '--asset-source') o.assetSource = next();
    else if (a === '--backup-root') o.backupRoot = path.resolve(next());
    else if (a === '--wait') o.waitSeconds = Math.max(1, Number(next()) || DEFAULTS.waitSeconds);
    else if (a === '--stop-timeout') o.stopTimeout = Math.max(1, Number(next()) || DEFAULTS.stopTimeout);
    else if (a === '--help' || a === '-h') { console.log(usage); process.exit(0); }
    else throw new Error(`未知参数：${a}\n${usage}`);
  }
  if (!o.staticRoot && (o.dataTarget || o.assetsTarget || o.fontsTarget || o.packsTarget)) {
    // Explicit individual targets are allowed without a common root.
  } else if (o.staticRoot) {
    o.dataTarget ||= path.join(o.staticRoot, 'srv');
    o.assetsTarget ||= path.join(o.staticRoot, 'assets');
    o.fontsTarget ||= path.join(o.staticRoot, 'fonts');
    o.packsTarget ||= path.join(o.staticRoot, 'resource-packs');
  }
  return o;
}

function composeArgs(o, args) {
  const base = ['docker', 'compose', '-f', o.compose];
  if (o.project) base.push('-p', o.project);
  return [...base, ...args];
}

function command(args, { allowFailure = false, capture = false } = {}) {
  const printable = args.map((x) => (/(KEY|TOKEN|PASSWORD|SECRET|API_KEY)/i.test(x) ? '<redacted>' : x)).join(' ');
  console.log(`$ ${printable}`);
  if (!options.apply) return { status: 0, stdout: '', stderr: '' };
  const result = spawnSync(args[0], args.slice(1), {
    cwd: ROOT, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`命令失败（${result.status ?? 'signal'}）：${printable}\n${result.stderr || ''}`);
  }
  return result;
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

function assertContained(source, destination) {
  const a = path.resolve(source), b = path.resolve(destination);
  if (a === b || b.startsWith(`${a}${path.sep}`)) throw new Error(`目标不能是源目录本身或其子目录：${destination}`);
}

async function copyTree(source, destination, label) {
  if (!(await exists(source))) throw new Error(`${label} 不存在：${source}`);
  assertContained(source, destination);
  console.log(`${options.apply ? '同步' : '计划同步'} ${label}: ${source} -> ${destination}`);
  if (!options.apply) return;
  await fs.mkdir(destination, { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true, errorOnExist: false });
}

async function copyOptionalTree(source, destination, label) {
  if (!(await exists(source))) {
    console.log(`跳过 ${label}：源目录不存在（可选）`);
    return;
  }
  await copyTree(source, destination, label);
}

async function normalizeReadableTree(root) {
  if (!(await exists(root))) return;
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await fs.chmod(target, 0o755).catch(() => {});
      await normalizeReadableTree(target);
    } else if (entry.isFile()) {
      await fs.chmod(target, 0o644).catch(() => {});
    }
  }
}

async function copyFile(source, destination) {
  if (!(await exists(source))) return;
  if (!options.apply) { console.log(`备份 ${source} -> ${destination}`); return; }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function backupDeployment(o, oldImage) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(o.backupRoot, stamp);
  console.log(`备份目录：${dir}`);
  if (!o.apply) return { dir, oldImage };
  await fs.mkdir(dir, { recursive: true });
  await copyFile(o.compose, path.join(dir, 'compose.yml'));
  for (const file of ['config/announcements.json', 'data/assets.json', 'data/local-assets.json',
    'data/asset-hashes.json', 'data/resource-packs.json']) {
    await copyFile(path.join(ROOT, file), path.join(dir, file));
  }
  await fs.writeFile(path.join(dir, 'deployment.json'), JSON.stringify({
    at: new Date().toISOString(), compose: o.compose, service: o.service, oldImage,
  }, null, 2));
  return { dir, oldImage };
}

async function health(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) return { ok: false, status: response.status };
    const text = await response.text();
    return { ok: true, status: response.status, body: text.slice(0, 500) };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally { clearTimeout(timer); }
}

async function waitHealth(url, seconds) {
  const deadline = Date.now() + seconds * 1000;
  let last;
  while (Date.now() < deadline) {
    last = await health(url);
    if (last.ok) { console.log(`健康检查通过：${url}`); return last; }
    await sleep(2000);
  }
  throw new Error(`健康检查超时：${url}，最后结果：${JSON.stringify(last)}`);
}

async function oldImage(o) {
  const result = command([...composeArgs(o, ['images', '-q', o.service])], { capture: true });
  return result.stdout.trim().split(/\s+/)[0] || '';
}

function composeImageRef(o, imageId) {
  const old = command(['docker', 'image', 'inspect', imageId || '', '--format', '{{json .RepoTags}}'],
    { capture: true, allowFailure: true });
  try {
    const tags = JSON.parse(old.stdout || '[]');
    return Array.isArray(tags) ? tags.find((tag) => typeof tag === 'string' && tag) || '' : '';
  } catch { return ''; }
}

async function rollback(o, image, imageRef) {
  if (!image || !imageRef) {
    console.error('没有可用旧镜像标识，无法自动回滚；请手动恢复旧镜像。');
    return false;
  }
  console.error(`开始回滚：${image} -> ${imageRef}`);
  command(['docker', 'tag', image, imageRef], { allowFailure: true });
  command([...composeArgs(o, ['up', '-d', '--no-deps', '--no-build', '--force-recreate', o.service])], { allowFailure: true });
  try { await waitHealth(o.health, Math.min(o.waitSeconds, 60)); return true; }
  catch (error) { console.error(`回滚后健康检查仍失败：${error.message}`); return false; }
}

async function prepareAssets(o, backupDir) {
  const candidate = path.join(backupDir, 'asset-candidate');
  const candidateData = path.join(candidate, 'data');
  const candidatePublic = path.join(candidate, 'public');
  const setup = [process.execPath, path.join(ROOT, 'tools', 'setup.mjs'), '--yes',
    '--no-local', '--no-scenes', `--asset-source=${o.assetSource}`];
  const manifestCode = [
    "import { createResourceIndex } from './server/resources.js';",
    "import fs from 'node:fs/promises';",
    `const root = ${JSON.stringify(candidate)};`,
    "const result = await createResourceIndex({ dataDir: `${root}/data`, publicDir: `${root}/public` }).get();",
    "await fs.writeFile(`${root}/data/resource-manifest.json`, JSON.stringify(result.manifest) + '\\n');",
  ].join('\n');
  const packs = [o.python, path.join(ROOT, 'tools', 'resource_packs.py'),
    '--manifest', path.join(candidateData, 'resource-manifest.json'),
    '--assets-root', candidatePublic,
    '--output', path.join(candidatePublic, 'resource-packs'),
    '--index', path.join(candidateData, 'resource-packs.json')];

  console.log(`\n资源准备候选目录：${candidate}`);
  command(setup);
  // Snapshot the downloaded/existing art without image/audio conversion. Keep
  // installed local art and explicit atlas variants; never remove old URLs.
  await fs.mkdir(candidatePublic, { recursive: true });
  await fs.cp(path.join(ROOT, 'data'), candidateData, { recursive: true });
  for (const name of ['assets', 'fonts']) {
    const source = path.join(ROOT, 'public', name);
    if (await exists(source)) await fs.cp(source, path.join(candidatePublic, name), { recursive: true });
  }
  command([process.execPath, path.join(ROOT, 'tools', 'asset-hashes.mjs'), '--root', candidate]);
  command([process.execPath, '--input-type=module', '-e', manifestCode]);
  command(packs);

  if (!options.apply) return;
  // Only publish completed manifests/packs; the candidate did not mutate art.
  await fs.cp(path.join(candidatePublic, 'resource-packs'), path.join(ROOT, 'public', 'resource-packs'),
    { recursive: true, force: true, errorOnExist: false });
  for (const name of ['assets.json', 'local-assets.json', 'asset-hashes.json', 'resource-packs.json']) {
    if (await exists(path.join(candidateData, name))) {
      await fs.copyFile(path.join(candidateData, name), path.join(ROOT, 'data', name));
    }
  }
  console.log('素材下载、哈希和 16MB 分包已应用到当前部署源目录（未转换素材）。');
}

async function main() {
  options = parseArgs(process.argv.slice(2));
  const o = options;
  if (!(await exists(o.compose))) throw new Error(`Compose 文件不存在：${o.compose}`);
  if (!o.apply) console.log('DRY-RUN：不会构建、同步、重启或回滚。加 --apply 执行部署。\n');
  command([...composeArgs(o, ['config', '--quiet'])]);
  if (o.pull) command(['git', 'pull', '--ff-only']);

  const old = await oldImage(o);
  const imageRef = composeImageRef(o, old);
  const backup = await backupDeployment(o, old);
  if (o.prepareAssets) {
    if (!o.apply) {
      console.log(`计划执行：${process.execPath} tools/setup.mjs --yes --no-local --no-scenes --asset-source=${o.assetSource}`);
      console.log('计划执行：复制现有素材到隔离候选并重算哈希，不转换图片或音频');
      console.log('计划执行：生成 resource-manifest.json、16MB 分类 ZIP 和 resource-packs.json');
    } else {
      await prepareAssets(o, backup.dir);
    }
  }
  if (o.apply) {
    // Dockerfile COPY and bind mounts preserve source permissions. Normalize
    // generated/public data before building so the non-root `node` user can
    // read manifests and mounted resources.
    await normalizeReadableTree(path.join(ROOT, 'data'));
    await normalizeReadableTree(path.join(ROOT, 'public', 'assets'));
    await normalizeReadableTree(path.join(ROOT, 'public', 'fonts'));
    await normalizeReadableTree(path.join(ROOT, 'public', 'resource-packs'));
  }

  if (!o.skipData && o.dataTarget) await copyTree(path.join(ROOT, 'data'), o.dataTarget, 'data');
  if (!o.skipAssets && o.assetsTarget) await copyTree(path.join(ROOT, 'public', 'assets'), o.assetsTarget, 'assets');
  if (!o.skipAssets && o.fontsTarget) await copyTree(path.join(ROOT, 'public', 'fonts'), o.fontsTarget, 'fonts');
  if (!o.skipPacks && o.packsTarget) await copyOptionalTree(path.join(ROOT, 'public', 'resource-packs'), o.packsTarget, 'resource-packs');

  if (!o.apply) {
    console.log('\n预检完成。建议实际执行：');
    console.log(`node scripts/deploy-compose.mjs --compose "${o.compose}" --static-root "${o.staticRoot || '<静态根目录>'}" --apply`);
    return;
  }

  try {
    command([...composeArgs(o, ['up', '-d', o.redis])]);
    if (!o.noBuild) command([...composeArgs(o, ['build', '--pull', o.service])]);
    command([...composeArgs(o, ['up', '-d', '--no-deps', '--force-recreate', o.service])]);
    await waitHealth(o.health, o.waitSeconds);
    console.log('部署完成。Redis 未删除，公告配置未覆盖，旧备份已保留。');
  } catch (error) {
    console.error(`部署失败：${error.message}`);
    const restored = await rollback(o, old, imageRef);
    if (!restored) console.error('自动回滚失败，请使用备份目录和旧镜像手动恢复。');
    process.exitCode = restored ? 1 : 2;
  }
}

main().catch((error) => { console.error(`部署预检失败：${error.message}`); process.exitCode = 2; });
