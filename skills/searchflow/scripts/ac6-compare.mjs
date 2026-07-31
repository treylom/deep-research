#!/usr/bin/env node
// ac6-compare.mjs — AC6 도메인 테스트 3축 비교 (신 공정 vs 기존)
//
// 계약:
//   argv   : --new <runDir> --baseline <runDir> [--weights <json>] [--json]  |  --test
//   stdout : 축별 비교표(사람용) 또는 JSON 1줄
//   exit   : 0=3축 전건 신 공정 열세 없음 · 1=열세 축 있음 · 2=스크립트 오류·측정 불가
//
// runDir 계약: `report.md` · `sources.jsonl` · `meta.json` (fixtures/ac6-domain-tests.md 참조)
//
// 🚨 **가중치는 이 스크립트가 정하지 않는다.** 등급 가중치·문턱은 held-out 검증 전이라 잠정이고,
//    잠정값을 코드에 박으면 그 순간 "실측 지표"처럼 읽힌다. 그래서:
//      · `--weights <json>` 를 주면 그 값으로 계산하고 `weights=provided` 라벨을 붙인다.
//      · 안 주면 **rubric 축은 계산하지 않는다**(`not-measured`). 등급 분포만 서술한다.
//    "가중치가 없어서 동등으로 봤다" 는 결론은 이 도구가 낼 수 없다.
//
// 🚨 **측정 불가와 무차이를 구분한다.** `meta.json` 이 없으면 시간 축은 `not-measured` 이며,
//    그것을 "시간 단축 없음(동등)" 으로 적지 않는다. 축마다 3상태다: better | worse | not-measured.
//
// 이 도구가 **하지 않는** 것:
//   · 내용의 진위 판정 ❌ (원문 대조 층)
//   · 파이프라인 실행 ❌ (산출물 소비만 — 실행은 별 단계)
//   · 3종 통과를 "공정이 더 좋다"로 승격 ❌ (표본 3, fixture 문서의 THREATS 참조)
//
// 외부 패키지 0 (node: 내장만).

import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const die = (code, msg) => { process.stderr.write(`[ac6-compare] ${msg}\n`); process.exit(code); };
const TOP_GRADES = new Set(['ORIGINAL', 'A']);        // "A급+" 의 정의 — 원Source 와 A

export function loadRun(dir) {
  const need = ['report.md', 'sources.jsonl'];
  for (const f of need) if (!existsSync(join(dir, f))) die(2, `${dir}: ${f} 없음 (빈 입력을 비교로 세지 않는다)`);

  const ledger = readFileSync(join(dir, 'sources.jsonl'), 'utf8').split('\n').filter(l => l.trim())
    .map((l, i) => { try { return JSON.parse(l); } catch { die(2, `${dir}/sources.jsonl:${i + 1} JSON 파싱 실패`); } });
  if (!ledger.length) die(2, `${dir}/sources.jsonl 레코드 0건 (0 을 결과로 읽지 않는다)`);

  let meta = null;
  if (existsSync(join(dir, 'meta.json'))) {
    try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); } catch { meta = null; }
  }
  return { dir, ledger, meta, report: readFileSync(join(dir, 'report.md'), 'utf8') };
}

/** 등급 분포 — 가중치 없이도 잴 수 있는 서술 통계. */
export function distribution(ledger) {
  const by = {};
  for (const r of ledger) by[r.grade] = (by[r.grade] || 0) + 1;
  const used = ledger.filter(r => r.status === 'used');
  const top = used.filter(r => TOP_GRADES.has(r.grade)).length;
  return { by_grade: by, records: ledger.length, used: used.length,
           top_ratio: used.length ? top / used.length : null, top_count: top };
}

/** 시간 축 — meta.json 만이 측정면이다. */
export function elapsedSec(meta) {
  if (!meta || !meta.started_at || !meta.ended_at) return null;
  const a = Date.parse(meta.started_at), b = Date.parse(meta.ended_at);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return (b - a) / 1000;
}

/** rubric 축 — 가중치가 주어질 때만 계산한다. */
export function rubric(ledger, weights) {
  if (!weights) return null;
  const used = ledger.filter(r => r.status === 'used');
  if (!used.length) return null;
  let sum = 0, n = 0;
  for (const r of used) {
    const w = weights[r.grade];
    if (typeof w !== 'number') continue;          // 모르는 등급은 세지 않는다(0 으로 치환 ❌)
    sum += w; n++;
  }
  return n ? { score: sum / n, counted: n, skipped: used.length - n } : null;
}

const cmp = (a, b, betterIsLower = false) => {
  if (a == null || b == null) return 'not-measured';
  if (a === b) return 'equal';
  return (betterIsLower ? a < b : a > b) ? 'better' : 'worse';
};

export function compare(newDir, baseDir, weights = null) {
  const N = loadRun(newDir), B = loadRun(baseDir);
  const dN = distribution(N.ledger), dB = distribution(B.ledger);
  const tN = elapsedSec(N.meta), tB = elapsedSec(B.meta);
  const rN = rubric(N.ledger, weights), rB = rubric(B.ledger, weights);

  const axes = {
    rubric: { verdict: cmp(rN?.score ?? null, rB?.score ?? null), new: rN, baseline: rB,
              basis: weights ? 'weights=provided (잠정 가중치 기준 — 확정값 아님)' : 'weights=not-provided → 계산 안 함' },
    time:   { verdict: cmp(tN, tB, true), new_sec: tN, baseline_sec: tB,
              basis: (tN == null || tB == null) ? 'meta.json 부재 → 측정 불가(동등 ❌)' : 'meta.json started_at/ended_at' },
    top_grade: { verdict: cmp(dN.top_ratio, dB.top_ratio), new: dN, baseline: dB,
              basis: `A급+ = {${[...TOP_GRADES].join(',')}} / status=used 분모` },
  };
  // 판정 = "열세 축이 없음". equal·not-measured 는 열세가 아니지만 **통과 근거도 아니다**.
  const worse = Object.entries(axes).filter(([, v]) => v.verdict === 'worse').map(([k]) => k);
  const unmeasured = Object.entries(axes).filter(([, v]) => v.verdict === 'not-measured').map(([k]) => k);
  return { new: newDir, baseline: baseDir, axes, worse, unmeasured,
           claim: worse.length ? 'AC6 축 열세 있음'
                : unmeasured.length ? `열세 0 — 단 미측정 축 ${unmeasured.join(',')} (전건 통과 주장 ❌)`
                : '3축 전건 열세 없음' };
}

// ─────────────────────────── self-test ───────────────────────────

function mkRun(dir, { grades, started, ended }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.md'), '# r\n\n본문\n');
  writeFileSync(join(dir, 'sources.jsonl'),
    grades.map((g, i) => JSON.stringify({ id: `s${i}`, url: `https://e.test/${i}`, grade: g, status: 'used' })).join('\n') + '\n');
  if (started) writeFileSync(join(dir, 'meta.json'), JSON.stringify({ started_at: started, ended_at: ended }));
}

function selfTest() {
  let pass = 0, fail = 0;
  const t = (name, cond, detail = '') => {
    (cond ? (pass++, process.stdout.write(`PASS  ${name}\n`))
          : (fail++, process.stdout.write(`FAIL  ${name}\n`)));
    if (detail) process.stdout.write(`      ${detail}\n`);
  };
  const run = args => spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { encoding: 'utf8' });

  const root = mkdtempSync(join(tmpdir(), 'ac6-'));
  const W = { ORIGINAL: 1, A: 0.8, B: 0.5, C: 0.2, UNREACHABLE: 0 };
  const wf = join(root, 'w.json'); writeFileSync(wf, JSON.stringify(W));

  // 신 공정이 더 좋은 경우
  mkRun(join(root, 'new'),  { grades: ['ORIGINAL', 'ORIGINAL', 'A', 'C'], started: '2026-07-31T09:00:00+09:00', ended: '2026-07-31T09:05:00+09:00' });
  mkRun(join(root, 'base'), { grades: ['B', 'C', 'C', 'A'],               started: '2026-07-31T09:00:00+09:00', ended: '2026-07-31T09:20:00+09:00' });

  const better = compare(join(root, 'new'), join(root, 'base'), W);
  t('3축 전건 우세 검출', better.worse.length === 0 && better.unmeasured.length === 0
    && better.axes.rubric.verdict === 'better' && better.axes.time.verdict === 'better'
    && better.axes.top_grade.verdict === 'better', better.claim);

  // 음성 대조 — 신 공정이 느리면 time 축이 worse 로 잡혀야 한다.
  mkRun(join(root, 'slow'), { grades: ['ORIGINAL', 'ORIGINAL', 'A', 'C'], started: '2026-07-31T09:00:00+09:00', ended: '2026-07-31T09:40:00+09:00' });
  const slow = compare(join(root, 'slow'), join(root, 'base'), W);
  t('음성 대조 — 시간 열세 검출', slow.axes.time.verdict === 'worse' && slow.worse.includes('time'), slow.claim);

  // 가중치 미제공 = rubric 미측정 (동등으로 삼키지 않는다)
  const noW = compare(join(root, 'new'), join(root, 'base'), null);
  t('가중치 미제공 → rubric = not-measured (동등 ❌)', noW.axes.rubric.verdict === 'not-measured'
    && noW.unmeasured.includes('rubric') && !noW.worse.includes('rubric'), noW.claim);

  // meta.json 부재 = 시간 미측정
  mkRun(join(root, 'nometa'), { grades: ['ORIGINAL', 'A'] });
  const noM = compare(join(root, 'nometa'), join(root, 'base'), W);
  t('meta.json 부재 → time = not-measured (동등 ❌)', noM.axes.time.verdict === 'not-measured'
    && noM.unmeasured.includes('time'), noM.claim);

  t('미측정 축이 있으면 전건 통과를 주장하지 않는다', /전건 통과 주장 ❌/.test(noM.claim), noM.claim);

  // 모르는 등급은 0 으로 치환하지 않는다.
  mkRun(join(root, 'weird'), { grades: ['ZZZ', 'ORIGINAL'], started: '2026-07-31T09:00:00+09:00', ended: '2026-07-31T09:01:00+09:00' });
  const wr = compare(join(root, 'weird'), join(root, 'base'), W);
  t('모르는 등급 = 제외(0 치환 ❌)', wr.axes.rubric.new.counted === 1 && wr.axes.rubric.new.skipped === 1,
    `counted=${wr.axes.rubric.new.counted} skipped=${wr.axes.rubric.new.skipped}`);

  const empty = join(root, 'empty'); mkdirSync(empty, { recursive: true });
  writeFileSync(join(empty, 'report.md'), '#\n'); writeFileSync(join(empty, 'sources.jsonl'), '');
  const e = run(['--new', empty, '--baseline', join(root, 'base')]);
  t('음성 대조 — 원장 0건 = exit 2', e.status === 2, `exit=${e.status}`);

  const miss = run(['--new', join(root, 'nope'), '--baseline', join(root, 'base')]);
  t('음성 대조 — 입력 부재 = exit 2', miss.status === 2, `exit=${miss.status}`);

  const okRun = run(['--new', join(root, 'new'), '--baseline', join(root, 'base'), '--weights', wf, '--json']);
  const badRun = run(['--new', join(root, 'slow'), '--baseline', join(root, 'base'), '--weights', wf, '--json']);
  t('exit 계약 — 0 / 1', okRun.status === 0 && badRun.status === 1, `ok=${okRun.status} worse=${badRun.status}`);

  rmSync(root, { recursive: true, force: true });
  process.stdout.write(`\n${pass}/${pass + fail} PASS\n`);
  return fail === 0 ? 0 : 1;
}

// ─────────────────────────── CLI ───────────────────────────

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!isMain) { /* 라이브러리 로드 */ }
else if (process.argv.includes('--test')) process.exit(selfTest());
else {
  const argv = process.argv.slice(2);
  const val = f => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : null; };
  const nd = val('--new'), bd = val('--baseline'), wp = val('--weights');
  if (!nd || !bd) die(2, '사용법: --new <runDir> --baseline <runDir> [--weights <json>] [--json]  |  --test');

  let weights = null;
  if (wp) {
    if (!existsSync(wp)) die(2, `가중치 파일 없음: ${wp}`);
    try { weights = JSON.parse(readFileSync(wp, 'utf8')); } catch (e) { die(2, `가중치 파싱 실패: ${e.message}`); }
  }

  const out = compare(resolve(nd), resolve(bd), weights);
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(out) + '\n');
  else {
    process.stdout.write(`[ac6-compare] ${out.claim}\n`);
    for (const [k, v] of Object.entries(out.axes))
      process.stdout.write(`  ${k.padEnd(10)} ${String(v.verdict).padEnd(13)} ${v.basis}\n`);
  }
  process.exit(out.worse.length ? 1 : 0);
}
