// SPDX-License-Identifier: GPL-3.0-or-later
// Static checks of the monitoring stack's configuration: the public dashboard (no template variables, only known
// metric / recording-rule names, no addresses), the recording rules, prometheus.yml targets and relabelling, the
// compose file (pinned images, host networking on loopback, no published ports) and grafana.ini. promtool and a real
// stack run are separate (README.md §6). 移植自 Stardust fork 的同名测试:B 没有 OpenResty 边缘 job 与
// hello / store 指标,prometheus.yml 三个 job,规则与面板按 B 的 collector 表与 persist 面适配。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { exportedMetricNames } from '../collector/metrics.mjs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const exists = (path) => fs.existsSync(new URL(`../${path}`, import.meta.url));
const dashboard = JSON.parse(read('grafana/dashboards/stronghold-status.json'));
const rulesText = read('prometheus/rules.yml');
const promText = read('prometheus/prometheus.yml');
const compose = read('compose.monitoring.yaml');
const ini = read('grafana/grafana.ini');

/** The node-exporter metrics the rules use (fork 的 OpenResty exporter / ark_edge_* 在本仓没有对应组件). */
const NODE = ['node_cpu_seconds_total', 'node_memory_MemAvailable_bytes', 'node_memory_MemTotal_bytes',
  'node_network_transmit_bytes_total', 'node_network_receive_bytes_total'];
const COLLECTOR = exportedMetricNames();
const JOBS = ['collector', 'node', 'prometheus'];

/** `- record:` / `expr:` pairs (rules.yml keeps one expr per line). */
const rules = [...rulesText.matchAll(/^\s*- record: (\S+)\n\s*expr: (.+)$/gm)].map(([, record, expr]) => ({ record, expr }));

const PROMQL_WORDS = new Set(['by', 'without', 'on', 'ignoring', 'group_left', 'group_right', 'and', 'or', 'unless', 'bool',
  'offset', 'inf', 'nan']);
/** Metric (or recording rule) names an expression reads: strings, label matchers, ranges, grouping lists and functions removed. */
function metricNames(expr) {
  const names = new Set();
  for (const [, alternatives] of expr.matchAll(/__name__\s*=~?\s*"([^"]*)"/g)) for (const n of alternatives.split('|')) names.add(n);
  const s = expr.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\{[^}]*\}/g, ' ').replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, ' ');
  for (const [, name] of s.matchAll(/(?<![a-zA-Z0-9_:.])([a-zA-Z_:][a-zA-Z0-9_:]*)(?![a-zA-Z0-9_:]|\s*\()/g)) {
    if (!PROMQL_WORDS.has(name.toLowerCase())) names.add(name);
  }
  return [...names];
}
const jobs = (expr) => [...expr.matchAll(/job="([^"]*)"/g)].map((m) => m[1]);

const targets = (panel) => panel.targets ?? [];
const dataPanels = dashboard.panels.filter((p) => p.type !== 'row' && p.type !== 'text');

test('dashboard: a public-dashboard-compatible, Chinese, dark, 1 min / 6 h board with no template variables', () => {
  assert.equal(dashboard.uid, 'sp-status');
  assert.equal(dashboard.title, '卫戍协议 · 服务器状态');
  assert.equal(dashboard.refresh, '1m');
  assert.deepEqual(dashboard.time, { from: 'now-6h', to: 'now' });
  assert.equal(dashboard.timezone, 'browser');
  assert.deepEqual(dashboard.templating, { list: [] });
  assert.deepEqual(dashboard.annotations, { list: [] });
  assert.equal(dashboard.editable, false);
  assert.match(ini, /^default_theme = dark$/m);
  assert.deepEqual(dashboard.panels.filter((p) => p.type === 'row').map((p) => p.title), ['玩家', '游戏服务', '主机']);
  const ids = dashboard.panels.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'unique panel ids');
  for (const p of dashboard.panels) {
    assert.ok(p.gridPos.x >= 0 && p.gridPos.w > 0 && p.gridPos.x + p.gridPos.w <= 24, `${p.title}: inside 24 columns`);
    assert.ok(!p.libraryPanel && !p.repeat, `${p.title}: no library panel / repeat`);
    if (p.type === 'row') assert.deepEqual(p.panels, [], 'rows are expanded (public dashboards render collapsed rows empty)');
  }
  assert.ok(dashboard.panels.some((p) => p.type === 'text' && /10 秒/.test(p.options.content)), 'a note says how often data is collected');
  for (const p of dataPanels) {
    assert.ok(['stat', 'timeseries'].includes(p.type), p.type);
    assert.equal(p.datasource?.uid, 'sp-prometheus', `${p.title}: provisioned data source`);
    assert.ok(targets(p).length > 0, `${p.title}: has queries`);
    for (const t of targets(p)) {
      assert.equal(t.datasource?.uid, 'sp-prometheus');
      assert.doesNotMatch(t.expr, /\$/, `${p.title}: no variables`);
      assert.equal(t.instant, p.type === 'stat', `${p.title}: stats are instant queries, graphs range queries`);
    }
    assert.ok(p.fieldConfig.defaults.unit, `${p.title}: unit set`);
  }
  const titles = dataPanels.map((p) => p.title);
  for (const title of ['在线连接', '进行中对局', '房间', '观战', 'AI 机器人', '会话与连接', '房间与对局', '游戏服务器', '版本', '运行时长',
    '主线程事件循环延迟', '主线程 CPU（单核）', '服务器 CPU', '服务器内存', '请求失败趋势', '存档写入', 'GC 总耗时',
    '出口 / 入口带宽', 'CPU 使用率', '内存使用率']) {
    assert.ok(titles.includes(title), `panel ${title}`);
  }
  const up = dataPanels.find((p) => p.title === '游戏服务器');
  assert.equal(targets(up)[0].expr, 'sp:server_up');
  const texts = up.fieldConfig.defaults.mappings.flatMap((m) => Object.values(m.options).map((o) => o.text));
  assert.deepEqual(texts.sort(), ['异常', '正常']);
});

test('dashboard queries read only exported metrics or recording rules, cheaply, and leak no address', () => {
  const known = new Set([...COLLECTOR, ...rules.map((r) => r.record)]);
  const counters = new Set(COLLECTOR.filter((n) => n.endsWith('_total')));
  for (const p of dataPanels) {
    for (const t of targets(p)) {
      for (const name of metricNames(t.expr)) assert.ok(known.has(name), `${p.title}: unknown metric ${name} in ${t.expr}`);
      for (const name of metricNames(t.expr)) assert.ok(!counters.has(name), `${p.title}: raw counter ${name} (use a recording rule)`);
      assert.doesNotMatch(t.expr, /\brate\(|\bincrease\(|\[\d+[smhd]\]/, `${p.title}: no range functions in public queries`);
      for (const job of jobs(t.expr)) assert.ok(JOBS.includes(job), job);
    }
  }
  const text = JSON.stringify(dashboard);
  assert.doesNotMatch(text, /\b\d{1,3}(?:\.\d{1,3}){3}\b/, 'no IPv4 address');
  assert.doesNotMatch(text, /hanabi|stardust|matce|isomer|\.cn\b|\/root\/|\/www\/|10\.253\.|hz0|35400/i, 'no host, path or tunnel name');
});

test('recording rules: unique names, known inputs, used by the dashboard', () => {
  assert.ok(rules.length >= 6);
  assert.equal(rules.length, (rulesText.match(/- record:/g) || []).length, 'every rule is a record/expr pair');
  assert.doesNotMatch(rulesText, /^\s*- alert:/m, 'no alerting rules without an Alertmanager');
  const names = rules.map((r) => r.record);
  assert.equal(new Set(names).size, names.length);
  const inputs = new Set([...COLLECTOR, ...NODE]);
  for (const { record, expr } of rules) {
    assert.match(record, /^[a-z]+:[a-z0-9_]+(?::[a-z0-9_]+)?$/, record);
    for (const name of metricNames(expr)) assert.ok(inputs.has(name), `${record}: unknown input ${name}`);
    for (const job of jobs(expr)) assert.ok(JOBS.includes(job), `${record}: job ${job}`);
    // rate() drops the name: two counters selected together collide ("vector cannot contain metrics with the same labelset")
    assert.doesNotMatch(expr, /__name__/, `${record}: one counter per rate()`);
  }
  const used = new Set(dataPanels.flatMap((p) => targets(p).flatMap((t) => metricNames(t.expr))));
  for (const name of names) assert.ok(used.has(name), `${name} is used by the dashboard`);
});

test('prometheus.yml: fixed loopback targets, fixed instance names, the rules file, no address labels', () => {
  assert.match(promText, /^rule_files:\n\s+- \/etc\/prometheus\/rules\.yml$/m);
  assert.ok(exists('prometheus/rules.yml'));
  assert.match(compose, /- \.\/prometheus:\/etc\/prometheus:ro/);
  const jobNames = [...promText.matchAll(/- job_name: (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(jobNames, JOBS);
  const ports = [...promText.matchAll(/targets: \["([^"]+)"\]/g)].map((m) => m[1]);
  assert.deepEqual(ports, ['127.0.0.1:9108', '127.0.0.1:9100', '127.0.0.1:9090']);
  const instances = [...promText.matchAll(/target_label: instance\n\s+replacement: (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(instances, ['gameserver', 'host', 'prometheus'], 'every job rewrites instance to a name');
  assert.match(promText, /regex: nodename\|domainname/);
  assert.match(promText, /^\s+scrape_interval: 15s$/m);
  assert.match(promText, /job_name: collector\n\s+scrape_interval: 10s/);
});

test('compose: pinned images, host networking on loopback, no published ports, hardening, mounts that exist', () => {
  assert.doesNotMatch(compose, /^\s+ports:/m, 'nothing is published');
  assert.doesNotMatch(compose, /:latest\b|privileged|docker\.sock/);
  const images = [...compose.matchAll(/image: \$\{[A-Z_]+:-([^}]+)\}/g)].map((m) => m[1]);
  assert.equal(images.length, 4);
  for (const image of images.filter((i) => !i.endsWith(':local'))) assert.match(image, /:v?\d+\.\d+\.\d+$/, image);
  assert.match(compose, /NODE_IMAGE: \$\{NODE_IMAGE:-node:24\.\d+\.\d+-alpine[\d.]*\}/);
  assert.match(compose, /x-hardening: &hardening\n\s+network_mode: host\n\s+restart: unless-stopped\n\s+read_only: true\n\s+cap_drop: \[ALL\]\n\s+security_opt: \["no-new-privileges:true"\]/);
  const services = [...compose.matchAll(/^ {2}([a-z-]+):\n {4}<<: \*hardening$/gm)].map((m) => m[1]);
  assert.deepEqual(services, ['collector', 'node-exporter', 'prometheus', 'grafana']);
  assert.equal((compose.match(/mem_limit: /g) || []).length, 4);
  assert.match(compose, /MONITOR_LISTEN: 127\.0\.0\.1:9108/);
  assert.match(compose, /--web\.listen-address=127\.0\.0\.1:9100/);
  assert.match(compose, /--web\.listen-address=127\.0\.0\.1:9090/);
  assert.match(compose, /--storage\.tsdb\.retention\.time=30d/);
  assert.match(compose, /--storage\.tsdb\.retention\.size=5GB/);
  assert.match(compose, /--collector\.disable-defaults/);
  assert.match(compose, /GF_SECURITY_ADMIN_PASSWORD__FILE: \/run\/secrets\/grafana-admin-password/);
  assert.doesNotMatch(compose, /GF_SECURITY_ADMIN_PASSWORD:/, 'no password in the environment');
  for (const [, path] of compose.matchAll(/- \.\/([^:]+):/g)) assert.ok(exists(path), `mount source ${path}`);
  assert.ok(exists('collector/Dockerfile'));
  assert.match(read('collector/Dockerfile'), /^USER node$/m);
  // every variable the compose file reads is documented in the example env file, which holds no secret
  const env = read('monitoring.env.example');
  for (const [, name] of compose.matchAll(/\$\{([A-Z_]+)[:}]/g)) assert.match(env, new RegExp(`^${name}=`, 'm'), name);
  assert.doesNotMatch(env, /PASSWORD=(?!.*\/)/);
  // the dashboard provider reads the folder the compose file mounts
  assert.match(read('grafana/provisioning/dashboards/stronghold.yaml'), /path: \/etc\/grafana\/dashboards/);
  assert.match(compose, /- \.\/grafana\/dashboards:\/etc\/grafana\/dashboards:ro/);
  assert.match(read('grafana/provisioning/datasources/prometheus.yaml'), /uid: sp-prometheus\n[\s\S]*url: http:\/\/127\.0\.0\.1:9090/);
});

test('grafana.ini: loopback, sub-path, no anonymous access or sign-up, public dashboards on, Live and outbound calls off', () => {
  for (const line of ['http_addr = 127.0.0.1', 'http_port = 3160', 'serve_from_sub_path = true', 'cookie_secure = true',
    'disable_gravatar = true', 'allow_sign_up = false', 'reporting_enabled = false', 'check_for_updates = false',
    'check_for_plugin_updates = false', 'news_feed_enabled = false', 'max_connections = 0', 'external_enabled = false',
    'preinstall_disabled = true', 'public_key_retrieval_disabled = true']) {
    assert.match(ini, new RegExp(`^${line.replace(/[.]/g, '\\.')}$`, 'm'), line);
  }
  assert.match(ini, /^\[auth\.anonymous\]\nenabled = false$/m);
  assert.match(ini, /^\[public_dashboards\]\nenabled = true$/m);
});

test('adapted files credit the xinhai-ai fork (via the Stardust fork)', () => {
  for (const path of ['collector/index.mjs', 'collector/metrics.mjs', 'compose.monitoring.yaml', 'prometheus/prometheus.yml', 'README.md']) {
    assert.match(read(path), /xinhai-ai\/Stronghold-Protocol|Stardust fork/, path);
  }
});
