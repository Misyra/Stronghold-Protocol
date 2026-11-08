#!/bin/bash
# poc/vanhost/ab40.sh — SP_BATTLE_POOL A/B 正式轮（串行锁内逐轮执行；调用方持锁）。
# 每轮记录起止时间戳（ISO+epoch），JSON 落 /tmp/vanhost-ab/。
set -u
cd /Users/misyra/Dev/sp-wt-vanhost
mkdir -p /tmp/vanhost-ab
run() { # $1=tag $2=clients $3=rooms $4=json $5...=extra env
  local tag="$1" clients="$2" rooms="$3" json="$4"; shift 4
  local start=$(date '+%F %T %z') eps=$(date +%s)
  echo "=== round $tag start $start ==="
  env "$@" node tools/loadgen.mjs --clients "$clients" --rooms "$rooms" --rate 20 --duration 115 --warmup 105 --seed 1 \
    --port 3999 --loop-window-ms 1000 --workers 4 --json "$json" --quiet
  local rc=$?
  local end=$(date '+%F %T %z') epe=$(date +%s)
  echo "=== round $tag done rc=$rc $end (wall $((epe-eps))s) ==="
  node -e "
    const fs = require('fs');
    const s = require('$json');
    const w = s.loop.windows;
    const hot = w.map((x, i) => ({ i, max: x.max, p95: x.p95, cpu: x.cpu })).sort((a, b) => b.cpu - a.cpu).slice(0, 5);
    fs.appendFileSync('/tmp/vanhost-ab/summary.txt',
      ['$tag', 'p50max=' + s.loop.p50.max, 'p95mean=' + s.loop.p95.mean, 'p95max=' + s.loop.p95.max,
       'max=' + s.loop.max.max, 'cpuPeak=' + s.loop.cpu.max, 'cpuMean=' + s.loop.cpu.mean,
       'eluMax=' + (s.server.elu ? s.server.elu.max : 'null'), 'rssMax=' + s.server.rssMB.max,
       'inMsg=' + s.clients.inMsgPerSec, 'hot=' + JSON.stringify(hot)].join(' ') + '\n');
  "
}
: > /tmp/vanhost-ab/summary.txt
run ab1-A 120 40 /tmp/vanhost-ab/ab1-A.json SP_BATTLE_POOL=0
run ab2-B 120 40 /tmp/vanhost-ab/ab2-B.json SP_BATTLE_POOL=1
run ab3-B 120 40 /tmp/vanhost-ab/ab3-B.json SP_BATTLE_POOL=1
run ab4-A 120 40 /tmp/vanhost-ab/ab4-A.json SP_BATTLE_POOL=0
run small12-on 12 4 /tmp/vanhost-ab/small12-on.json SP_BATTLE_POOL=1
echo "=== ABBA all done ==="
cat /tmp/vanhost-ab/summary.txt
