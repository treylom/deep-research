#!/usr/bin/env node
// spawn-plan.mjs — 조사 단위 확정 + 실행 경로(tier) 결정
//
// 계약 (21-implementation-spec §2-6 ABI 준수):
//   argv   : --type <t[,t2..]> [--harness cc|codex] [--tools <A,B>] [--multi-agent-api public|collab_v2|none]
//            [--frames <frames.md 경로>] | --test
//   stdout : JSON 1줄 {harness,tier,parallelism,units[],labels[],dedupe_required}
//   exit   : 0=계획 산출 · 1=입력 계약 위반 · 2=스크립트 오류(통과 취급 ❌)
//
// 이 스크립트가 존재하는 이유 = **경로 등가의 기계적 강제**(S2 완료 판정).
//   tier 는 *실행 방식과 라벨만* 바꾼다. 조사 단위 집합은 어느 tier 에서도 동일하다.
//   특히 순차 강등에서 축을 합치는 것을 금지한다 — factcheck ②③ 분리는 성능이 아니라
//   편향 차단 장치이므로(frames.md §2), 병렬이 불가능해도 별개 단위로 남아야 한다.
//
// SoT 규율: 유형→축 표는 **references/frames.md §2 가 유일 SoT** 다. 이 스크립트에 표를
//   복제하지 않는다(HIDE-TOKENS 를 scoring.md 한 곳에만 두는 것과 같은 이유 — 이중 관리는
//   한쪽만 갱신되는 순간 조용히 갈린다). 파싱 실패는 빈 계획이 아니라 exit 2 다.
//
// 기계로 못 정하는 것은 안 정한다: 복합 유형의 **의미적 중복 접기**(frames.md §1 결합규칙 2)는
//   축 이름의 뜻을 읽어야 하므로 리드 몫이다. 여기서는 `dedupe_required:true` 로 넘긴다.
//   기계가 정할 수 있는 것(합집합·상한 6·순서)만 정한다.
//
// 외부 패키지 0 (node: 내장만).

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FRAMES = resolve(join(HERE, '..', 'references', 'frames.md'));
const MAX_UNITS = 6;                       // frames.md §1 결합규칙 3
const die = (code, msg) => { process.stderr.write(`[spawn-plan] ${msg}\n`); process.exit(code); };

/** tier 결정표 — SKILL.md §3 과 1:1. 여기 문자열이 보고서 라벨의 SoT 다. */
const TIERS = {
  cc: [
    { tier: 'cc-workflow',  parallelism: 'parallel',   when: t => t.includes('Workflow') },
    { tier: 'cc-subagent',  parallelism: 'parallel',   when: t => t.includes('Task') || t.includes('Agent') },
    { tier: 'sequential',   parallelism: 'sequential', when: () => true },
  ],
  codex: [
    { tier: 'codex-multi-agent', parallelism: 'parallel',   when: (_t, api) => api === 'public' },
    { tier: 'codex-collab-v2',   parallelism: 'parallel',   when: (_t, api) => api === 'collab_v2' },
    { tier: 'sequential',        parallelism: 'sequential', when: () => true },
  ],
};

/**
 * references/frames.md §2 표를 파싱해 { 유형: [축 이름, ...] } 를 만든다.
 * 표 행 형태: | `factcheck` | ① 원 주장 출처 추적 ② **지지 증거** ... | 4 |
 */
export function loadFrameTable(path = DEFAULT_FRAMES) {
  if (!existsSync(path)) die(2, `frames.md 없음: ${path} (빈 계획으로 넘어가지 않는다)`);
  const md = readFileSync(path, 'utf8').normalize('NFC');
  const table = {};
  for (const line of md.split('\n')) {
    const m = line.match(/^\|\s*`([a-z]+)`\s*\|\s*(.+?)\s*\|\s*([0-9~\-]+)\s*\|\s*$/);
    if (!m) continue;
    const [, type, axesCell] = m;
    // ①②③④ 로 쪼갠다. compare 처럼 번호 없는 셀은 통째 1축으로 두고 리드가 스코핑에서 확정한다.
    const parts = axesCell.split(/[①②③④⑤⑥]/).map(s => s.replace(/\*\*/g, '').trim()).filter(Boolean);
    if (parts.length) table[type] = parts;
  }
  if (Object.keys(table).length < 8) die(2, `frames.md §2 파싱 실패 — 유형 ${Object.keys(table).length}개만 잡힘(8 기대)`);
  return table;
}

/** 유형 목록 → 조사 단위. tier 와 무관하다(경로 등가의 근거). */
export function buildUnits(types, table) {
  const wanted = [];
  for (const t of types) {
    const axes = table[t] || table.discovery;      // 판정 실패 = discovery 폴백 (frames.md §1)
    const key = table[t] ? t : 'discovery';
    for (const a of axes) wanted.push({ type: key, axis: a });
  }
  const folded = Math.max(0, wanted.length - MAX_UNITS);
  const kept = wanted.slice(0, MAX_UNITS);         // 주 유형(첫 인자) 축을 먼저 살린다
  return {
    units: kept.map((u, i) => ({ frame_id: `f${i + 1}`, type: u.type, axis: u.axis })),
    folded,
  };
}

export function plan({ types, harness = 'cc', tools = [], multiAgentApi = 'none', framesPath, denied = false }) {
  const table = loadFrameTable(framesPath);
  const { units, folded } = buildUnits(types, table);
  const ladder = TIERS[harness];
  if (!ladder) die(1, `harness 는 cc|codex 만: ${harness}`);
  const natural = ladder.find(r => r.when(tools, multiAgentApi));

  // 강등 사유는 **두 가지이고 서로 다르다** — 한 문자열로 덮으면 라벨이 거짓말을 한다.
  //   · no-orchestration-tool = **부재**(그 도구가 이 환경에 없다)
  //   · orchestration-denied  = **거부**(도구는 실재하나 정책·권한이 호출을 막는다)
  // 실측으로 걸렸다(AC8 RUN1, 2026-07-31): 세션에 Workflow·Agent 가 **실재**했는데
  // 정책이 호출을 금지해 순차로 내려갔고, 그때 기계 라벨은 `no-orchestration-tool` 이라
  // **없다고 주장**했다. 리드가 본문에 사유를 따로 적어 살렸지만, 기계 대조는 못 한다.
  // ⇒ 거부는 호출자가 `--denied` 로 **선언**한다(도구 목록은 사실대로 유지).
  let chosen = natural;
  let reason = natural.parallelism === 'sequential' ? 'no-orchestration-tool' : null;
  if (denied) {
    if (natural.parallelism === 'sequential')
      die(1, '--denied 는 오케스트레이션 도구가 실재할 때만 쓴다 — 이 tool surface 엔 없다. 부재는 no-orchestration-tool 이다(부재를 거부로 위장 ❌).');
    chosen = ladder[ladder.length - 1];          // 사다리 마지막 단 = sequential
    reason = 'orchestration-denied';
  }

  const labels = [`parallelism=${chosen.parallelism}`, `tier=${chosen.tier}`];
  if (reason) labels.push(`degraded=${reason}`);
  if (folded > 0) labels.push(`frames-folded=${folded}`);

  return {
    harness,
    tier: chosen.tier,
    parallelism: chosen.parallelism,
    units,
    labels,
    // 의미적 중복 접기는 기계가 못 한다 — 복합 유형이면 리드가 frames.md §1 결합규칙 2 를 적용한다.
    dedupe_required: types.length > 1,
  };
}

// ─────────────────────────── self-test ───────────────────────────

function selfTest() {
  let pass = 0, fail = 0;
  const t = (name, cond, detail = '') => {
    (cond ? (pass++, process.stdout.write(`PASS  ${name}\n`))
          : (fail++, process.stdout.write(`FAIL  ${name}\n`)));
    if (detail) process.stdout.write(`      ${detail}\n`);
  };

  const table = loadFrameTable();
  t('frames.md §2 파싱 — 유형 8종', Object.keys(table).length === 8, Object.keys(table).join(','));

  const fc = plan({ types: ['factcheck'], harness: 'cc', tools: ['Workflow'] });
  t('factcheck = 4축', fc.units.length === 4, fc.units.map(u => u.frame_id).join(','));

  // 편향 차단 장치: 지지/반증이 서로 다른 단위로 남아야 한다 — 순차에서도.
  const seq = plan({ types: ['factcheck'], harness: 'cc', tools: [] });
  const hasBoth = a => a.some(u => /지지/.test(u.axis)) && a.some(u => /반증/.test(u.axis));
  t('순차 강등에서도 지지·반증 분리 유지', seq.parallelism === 'sequential' && hasBoth(seq.units),
    `tier=${seq.tier} units=${seq.units.length}`);

  // 경로 등가 — 6 tier 전부 같은 단위 집합.
  const variants = [
    plan({ types: ['factcheck'], harness: 'cc', tools: ['Workflow', 'Task'] }),
    plan({ types: ['factcheck'], harness: 'cc', tools: ['Task'] }),
    plan({ types: ['factcheck'], harness: 'cc', tools: [] }),
    plan({ types: ['factcheck'], harness: 'codex', multiAgentApi: 'public' }),
    plan({ types: ['factcheck'], harness: 'codex', multiAgentApi: 'collab_v2' }),
    plan({ types: ['factcheck'], harness: 'codex', multiAgentApi: 'none' }),
  ];
  const sig = p => JSON.stringify(p.units);
  const tiers = variants.map(v => v.tier);
  t('경로 등가 — 6 tier 전건 동일 단위 집합', new Set(variants.map(sig)).size === 1, tiers.join(' · '));
  t('tier 결정표 — 6종이 서로 다른 경로로 갈림', new Set(tiers).size === 5,
    `sequential 이 cc·codex 공용이라 고유 tier 는 5종: ${[...new Set(tiers)].join(',')}`);

  // 상한 6 + folded 라벨
  const multi = plan({ types: ['market', 'company', 'policy'], harness: 'cc', tools: ['Workflow'] });
  t('복합 3유형 → 상한 6 + folded 라벨', multi.units.length === MAX_UNITS
    && multi.labels.some(l => l === 'frames-folded=6') && multi.dedupe_required === true,
    `units=${multi.units.length} labels=${multi.labels.join(' ')}`);

  // 폴백: 모르는 유형 = discovery
  const unknown = plan({ types: ['banana'], harness: 'cc', tools: ['Workflow'] });
  t('알 수 없는 유형 → discovery 폴백', unknown.units.every(u => u.type === 'discovery') && unknown.units.length === 3,
    unknown.units.map(u => u.axis).join(' | '));

  // 음성 대조 — SoT 부재를 빈 계획으로 삼키지 않는다(0=미측정 함정 방어).
  const r = spawnSelf(['--type', 'factcheck', '--frames', '/nonexistent-frames-' + process.pid + '.md']);
  t('음성 대조 — frames.md 부재 시 exit 2 (빈 계획 ❌)', r.status === 2, `exit=${r.status}`);

  // 음성 대조 — 라벨이 실제로 보고서 grep 대상 문자열로 나온다(AC9).
  t('음성 대조 — 강등 라벨 문자열 실재', seq.labels.includes('parallelism=sequential')
    && seq.labels.includes('degraded=no-orchestration-tool'), seq.labels.join(' '));

  // 거부(정책) ≠ 부재(도구 없음) — 두 라벨이 실제로 갈리는지.
  const denied = plan({ types: ['factcheck'], harness: 'cc', tools: ['Workflow', 'Task'], denied: true });
  t('거부 선언 → orchestration-denied 로 갈린다', denied.parallelism === 'sequential'
    && denied.labels.includes('degraded=orchestration-denied')
    && !denied.labels.includes('degraded=no-orchestration-tool'), denied.labels.join(' '));

  // 음성 대조 — 부재를 거부로 위장하지 못한다(라벨 세탁 차단).
  const fake = spawnSelf(['--type', 'factcheck', '--denied']);          // tools 없음 + 거부 선언
  t('음성 대조 — 도구 없이 --denied = exit 1 (부재를 거부로 위장 ❌)', fake.status === 1, `exit=${fake.status}`);

  process.stdout.write(`\n${pass}/${pass + fail} PASS\n`);
  return fail === 0 ? 0 : 1;
}

/** 자기 자신을 별도 프로세스로 돌려 exit 코드를 실측한다(음성 대조 — 내부 호출로는 exit 를 못 잰다). */
function spawnSelf(args) {
  return spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { encoding: 'utf8' });
}

// ─────────────────────────── CLI ───────────────────────────

function argOf(flag, dflt = null) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

if (process.argv.includes('--test')) process.exit(selfTest());

const typesArg = argOf('--type');
if (!typesArg) die(1, '사용법: --type <t[,t2]> [--harness cc|codex] [--tools A,B] [--multi-agent-api public|collab_v2|none] [--denied] [--frames <path>]  |  --test');

process.stdout.write(JSON.stringify(plan({
  types: typesArg.split(',').map(s => s.trim()).filter(Boolean),
  harness: argOf('--harness', 'cc'),
  tools: (argOf('--tools', '') || '').split(',').map(s => s.trim()).filter(Boolean),
  multiAgentApi: argOf('--multi-agent-api', 'none'),
  denied: process.argv.includes('--denied'),
  framesPath: argOf('--frames', DEFAULT_FRAMES),
})) + '\n');
process.exit(0);
