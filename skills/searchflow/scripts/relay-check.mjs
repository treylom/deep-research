#!/usr/bin/env node
// relay-check.mjs — 리드 릴레이 원장(relay envelope) 계약 검증 + E-FUP 판정
//
// 계약 (21-implementation-spec §3-1 relay 상태 계약 · SKILL.md §4):
//   argv   : <relay.jsonl> [...]  |  --test
//   stdout : JSON 1줄 {records,questions,frames,efup,in_flight,violations[]}
//   exit   : 0=위반 0 · 1=위반 있음(빈 원장 포함) · 2=스크립트 오류(통과 취급 ❌)
//
// envelope = 정확히 5키: {run_id, frame_id, question_id, round, status}
//   status 전이 = pending → asked → answered → resumed  (건너뜀·역행·중복 전부 위반)
//   각 전이는 리드만 기록한다 — 워커는 이 파일에 쓰지 않는다(single-writer, SKILL.md §P3).
//
// **E-FUP(완료 워커 재진입)** = 21-doc r2-P1 이 S2 완료 판정으로 요구한 fixture.
//   정의: 한 frame 의 round 1 주기가 `resumed` 까지 끝난 뒤 같은 frame 에 round 2 주기가 열리는 것.
//   이때 리드는 워커를 **재스폰하지 않고 재진입**시킨다(collab_v2 `followup_task`).
//   재스폰하면 그 워커가 라운드 1에서 이미 읽은 것을 다시 읽으므로 시간이 두 배로 든다.
//   ⚠️ 이 스크립트가 재는 것은 **원장에 그 형태가 남았는가**이지, 실제 런타임이 재진입을
//      했는가가 아니다. 런타임 축은 별도 실행 fixture 소관 — 여기서 GREEN 이 났다고
//      "재진입이 동작한다"로 인용하면 오귀속이다.
//
// 외부 패키지 0 (node: 내장만).

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(join(HERE, '..', 'fixtures'));

const KEYS = ['run_id', 'frame_id', 'question_id', 'round', 'status'];
const ORDER = ['pending', 'asked', 'answered', 'resumed'];
const MAX_ROUND = 2;                       // SKILL.md §2 — 라운드 상한은 사용자가 덮어쓸 수 없다

export function check(paths) {
  const violations = [];
  const cycles = new Map();                // question_id → {frame_id, round, seen:[status]}
  const frames = new Set();
  let runId = null, records = 0;

  for (const p of paths) {
    if (!existsSync(p)) return { fatal: `없는 파일: ${p}` };
    const lines = readFileSync(p, 'utf8').split('\n');
    lines.forEach((raw, i) => {
      const line = raw.trim();
      if (!line) return;
      records++;
      const at = `${p}:${i + 1}`;
      let e;
      try { e = JSON.parse(line); }
      catch (err) { violations.push(`${at}: malformed-relay — JSON parse 실패 (${err.message})`); return; }

      const keys = Object.keys(e).sort();
      const missing = KEYS.filter(k => !keys.includes(k));
      const extra = keys.filter(k => !KEYS.includes(k));
      if (missing.length) { violations.push(`${at}: malformed-relay — 키 결손 ${missing.join(',')}`); return; }
      if (extra.length) violations.push(`${at}: envelope 계약 위반 — 미정의 키 ${extra.join(',')}`);

      if (runId === null) runId = e.run_id;
      else if (e.run_id !== runId) violations.push(`${at}: run_id 불일치 — "${e.run_id}" (원장 첫 줄 "${runId}")`);

      if (!ORDER.includes(e.status)) { violations.push(`${at}: status enum 위반 — ${ORDER.join('|')} (받은 값: ${JSON.stringify(e.status)})`); return; }
      if (!Number.isInteger(e.round) || e.round < 1 || e.round > MAX_ROUND) {
        violations.push(`${at}: round 범위 위반 — 1..${MAX_ROUND} (받은 값: ${JSON.stringify(e.round)})`); return;
      }
      frames.add(e.frame_id);

      let c = cycles.get(e.question_id);
      if (!c) { c = { frame_id: e.frame_id, round: e.round, seen: [], firstAt: at }; cycles.set(e.question_id, c); }
      if (c.frame_id !== e.frame_id) violations.push(`${at}: question_id "${e.question_id}" 가 frame 을 갈아탐 (${c.frame_id}→${e.frame_id})`);
      if (c.round !== e.round) violations.push(`${at}: question_id "${e.question_id}" 가 round 를 갈아탐 (${c.round}→${e.round})`);

      const want = ORDER[c.seen.length];
      if (e.status !== want) {
        violations.push(`${at}: 전이 위반 — "${e.question_id}" 는 ${want ?? '(주기 종료)'} 를 기대했는데 ${e.status}`);
      }
      c.seen.push(e.status);
    });
  }

  if (records === 0) violations.push('빈 원장 — 0건은 통과가 아니다(미측정과 구별되지 않는다)');

  // in-flight = 아직 resumed 에 도달하지 않은 주기. 위반은 아니지만 완료 판정에 쓰인다.
  const inFlight = [...cycles.entries()].filter(([, c]) => c.seen.length < ORDER.length).map(([q]) => q);

  // E-FUP: round 1 주기가 완주한 frame 에 round 2 주기가 열렸는가.
  const done1 = new Set([...cycles.values()].filter(c => c.round === 1 && c.seen.length === ORDER.length).map(c => c.frame_id));
  const efup = [...new Set([...cycles.values()].filter(c => c.round === 2 && done1.has(c.frame_id)).map(c => c.frame_id))];

  return { run_id: runId, records, questions: cycles.size, frames: frames.size, efup, in_flight: inFlight, violations };
}

// ─────────────────────────── self-test ───────────────────────────

function selfTest() {
  let pass = 0, fail = 0;
  const t = (name, cond, detail = '') => {
    (cond ? (pass++, process.stdout.write(`PASS  ${name}\n`))
          : (fail++, process.stdout.write(`FAIL  ${name}\n`)));
    if (detail) process.stdout.write(`      ${detail}\n`);
  };
  const run = args => spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { encoding: 'utf8' });

  const ok = check([join(FIX, 'relay-valid.jsonl')]);
  t('양성 fixture — 위반 0', ok.violations.length === 0, `records=${ok.records} questions=${ok.questions}`);
  t('E-FUP 검출 — 완료 워커 재진입 1건', ok.efup.length === 1 && ok.in_flight.length === 0,
    `efup=${ok.efup.join(',')} in_flight=${ok.in_flight.length}`);

  const bad = check([join(FIX, 'relay-invalid.jsonl')]);
  const hit = re => bad.violations.find(v => re.test(v));
  t('음성 — 키 결손 검출', !!hit(/키 결손/), hit(/키 결손/) || '');
  t('음성 — 전이 위반 검출(pending→resumed 건너뜀)', !!hit(/전이 위반/), hit(/전이 위반/) || '');
  t('음성 — round 범위 위반 검출', !!hit(/round 범위/), hit(/round 범위/) || '');
  t('음성 — run_id 불일치 검출', !!hit(/run_id 불일치/), hit(/run_id 불일치/) || '');
  t('음성 — malformed line 검출', !!hit(/JSON parse 실패/), hit(/JSON parse 실패/) || '');

  // 0건을 통과로 삼키지 않는다.
  const empty = join(FIX, 'relay-empty.jsonl');
  const r0 = run([empty]);
  t('음성 — 빈 원장은 exit 1 (0건 ≠ 통과)', r0.status === 1, `exit=${r0.status}`);

  const rOk = run([join(FIX, 'relay-valid.jsonl')]);
  const rBad = run([join(FIX, 'relay-invalid.jsonl')]);
  const rMiss = run([join(FIX, 'no-such-relay.jsonl')]);
  t('exit 계약 — 0 / 1 / 2', rOk.status === 0 && rBad.status === 1 && rMiss.status === 2,
    `valid=${rOk.status} invalid=${rBad.status} 없는파일=${rMiss.status}`);

  process.stdout.write(`\n${pass}/${pass + fail} PASS\n`);
  return fail === 0 ? 0 : 1;
}

// ─────────────────────────── CLI ───────────────────────────

if (process.argv.includes('--test')) process.exit(selfTest());

const paths = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!paths.length) { process.stderr.write('[relay-check] 사용법: relay-check.mjs <relay.jsonl> [...]  |  --test\n'); process.exit(2); }

const out = check(paths);
if (out.fatal) { process.stderr.write(`[relay-check] ${out.fatal}\n`); process.exit(2); }
process.stdout.write(JSON.stringify(out) + '\n');
if (out.violations.length) { for (const v of out.violations) process.stderr.write(`[relay-check] ${v}\n`); process.exit(1); }
process.exit(0);
