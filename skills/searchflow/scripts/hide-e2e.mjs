#!/usr/bin/env node
// hide-e2e.mjs — 은닉 e2e (P2)
//
// 계약:
//   argv   : (없음) = 전 검사 실행  |  --corpus <경로> = L2 심판용 말뭉치만 내보내기  |  --json
//   exit   : 0 = 전 항목 통과 · 1 = 위반 있음 · 2 = 검사 자체 실패(통과 취급 ❌)
//
// 무엇을 재는가:
//   "워커가 기준을 못 본다" 를 **서버 내부를 읽지 않고** 잰다. 내부를 import 하면
//   "서버가 뭘 안 보냈다고 주장하는가" 를 재게 된다 — 재야 하는 건 **실제로 나간 바이트**다.
//   그래서 stdio 로 왕복시키고, 워커가 볼 수 있는 것만 모아 말뭉치로 만든다:
//     ① tools/list 응답(스키마·description — 조사 시작 전에 이미 보이는 표면)
//     ② 세션 원장의 outbound verbatim 전건(서버→워커로 실제 나간 문자열)
//
// 층 분리 (오늘 확정):
//   · 리터럴 층 = **소수 점수형 기준만** 담당. 정수 기준은 한국어 세는 표현으로 우회되므로
//     이 검사의 건전성 전제가 "기준이 소수" 다. 그래서 e2e 는 **소수 기준으로만** 돈다.
//   · 세는 기준(min_sources·max_rounds) = 키 이름 검사 + L2 소관. 리터럴로 재지 않는다.
//   · 어휘(grade 이름 ORIGINAL|A|B|C|UNREACHABLE)는 **공유가 불가피**하다 — submit 이 그걸 요구한다.
//     따라서 L1 위반 = **값·규칙**이고, 이름 등장은 정보성이다(48-doc §2.1).
//
// L2(의미 복원)는 여기서 판정하지 않는다 — 사람/심판 모델이 필요하다. 대신 **심판이 볼 말뭉치를
//   그대로 내보낸다**(--corpus). 결정적 검사(①)와 평가자 검사(③)를 섞지 않는다.
//
// 외부 패키지 0.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, 'mcp-server.mjs');
const die = (code, msg) => { process.stderr.write(`[hide-e2e] ${msg}\n`); process.exit(code); };

// 소수만 쓴다 — 위 '건전성 전제' 참조. 두 기준은 **판정이 갈리도록** 고른다(스왑이 무효면 L3 가 공허하다).
const CRITERIA_A = { threshold: 1.6, weights: { ORIGINAL: 1.0, A: 0.75, B: 0.45, C: 0.15, UNREACHABLE: 0 } };
const CRITERIA_B = { threshold: 2.4, weights: { ORIGINAL: 0.9, A: 0.55, B: 0.35, C: 0.05, UNREACHABLE: 0 } };

function rpc(env, msgs) {
  const p = spawnSync('node', [SERVER], {
    input: msgs.map((m) => JSON.stringify(m)).join('\n') + '\n',
    encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024,
  });
  if (p.error) die(2, `서버 기동 실패: ${p.error.message}`);
  const lines = (p.stdout || '').trim().split('\n').filter(Boolean);
  let out;
  try { out = lines.map((l) => JSON.parse(l)); }
  catch (e) { die(2, `서버 stdout 이 JSON 이 아니다(경고가 stdout 으로 샜을 수 있다): ${e.message}`); }
  return out;
}

/** 한 회차를 끝까지 돌리고, **워커가 볼 수 있었던 것 전부**를 모아 온다. */
function runSession(criteria, grade) {
  const dir = mkdtempSync(join(tmpdir(), 'hide-e2e-'));
  const env = { ...process.env, SEARCHFLOW_CRITERIA: JSON.stringify(criteria), SEARCHFLOW_STATE_DIR: dir };

  const [listed] = rpc(env, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  if (!listed?.result?.tools) die(2, 'tools/list 응답이 비었다 — 말뭉치의 절반이 미측정이다');

  const [started] = rpc(env, [{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'searchflow_start', arguments: { question: '이 주장이 사실인가' } } }]);
  const startBody = JSON.parse(started.result.content[0].text);
  const sid = startBody.session_id;

  const src = [{ url: 'https://a', grade, status: 'used' }, { url: 'https://b', grade, status: 'used' }];
  const seq = startBody.frames.map((f, i) => ({
    jsonrpc: '2.0', id: 10 + i,
    params: { name: 'searchflow_submit', arguments: { session_id: sid, frame_id: f.frame_id, sources: src } },
    method: 'tools/call',
  }));
  seq.push({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'searchflow_gate', arguments: { session_id: sid } } });
  const responses = rpc(env, seq);
  const last = responses[responses.length - 1];
  const decision = last.error ? `ERROR:${last.error.message}` : JSON.parse(last.result.content[0].text).decision;

  // 원장에서 outbound verbatim 만 — 서버 내부 판정(gate 이벤트의 decision 등)은 워커가 못 본다.
  const files = readdirSync(join(dir, 'sessions'));
  const ledger = files.flatMap((f) => readFileSync(join(dir, 'sessions', f), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  const outbound = ledger.filter((e) => e.event === 'outbound').map((e) => e.verbatim);

  rmSync(dir, { recursive: true, force: true });
  return {
    decision,
    schema: JSON.stringify(listed.result.tools),
    outbound,
    corpus: [JSON.stringify(listed.result.tools), ...outbound].join('\n'),
  };
}

/**
 * L1 — 말뭉치에 **기준 값**이 있는가.
 * 값만 본다(이름은 정보성). 수 비교는 mcp-server 와 같은 경계 규칙을 쓴다.
 */
const KO_COUNTER = /^(종|개|명|곳|건|회|차|장|번|가지|부|줄|배|쪽|권|판|기)/;
function numericTokens(txt) {
  const s = String(txt); const out = [];
  for (const m of s.matchAll(/\d+(?:\.\d+)*/g)) {
    const before = s[m.index - 1] ?? '';
    const rest = s.slice(m.index + m[0].length);
    if (/[A-Za-z_]/.test(before) || /^[A-Za-z_]/.test(rest)) continue;
    if (m[0].split('.').length > 2) continue;
    if (Number.isInteger(Number(m[0])) && KO_COUNTER.test(rest)) continue;
    out.push(Number(m[0]));
  }
  return out;
}

function l1Report(corpus, criteria) {
  const nums = numericTokens(corpus);
  const set = new Set(nums);
  const targets = [
    ['threshold', criteria.threshold],
    ...Object.entries(criteria.weights).map(([g, w]) => [`weights.${g}`, w]),
  ];
  // 정수 기준값은 리터럴로 재지 않는다 — 문안의 평범한 수와 구별되지 않아 상시 거짓 RED 가 된다.
  // ⚠️ 그러면 **검사 대상이 전체가 아니다.** 분모를 안 적으면 "위반 0" 이 전수 통과로 읽힌다.
  const checked = targets.filter(([, v]) => !Number.isInteger(v));
  const skipped = targets.filter(([, v]) => Number.isInteger(v));
  const violations = checked.filter(([, v]) => set.has(v)).map(([n, v]) => `${n}=${v}`);
  return { violations, checked, skipped, total: targets.length, corpusNums: nums };
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const corpusOut = argv.indexOf('--corpus') > -1 ? argv[argv.indexOf('--corpus') + 1] : null;

  const results = [];
  const rec = (name, ok, detail) => results.push({ name, ok, detail });

  // 두 기준 × 두 제출 강도 — 스왑이 실제로 판정을 바꾸는 조합을 만든다.
  const a_strong = runSession(CRITERIA_A, 'ORIGINAL');   // 2.0 ≥ 1.6 → done
  const b_strong = runSession(CRITERIA_B, 'ORIGINAL');   // 1.8 < 2.4 → reinvestigate
  const a_weak = runSession(CRITERIA_A, 'C');

  if (corpusOut) {
    writeFileSync(corpusOut, a_strong.corpus + '\n', 'utf8');
    process.stdout.write(`[hide-e2e] L2 심판용 말뭉치 기록: ${corpusOut} (${Buffer.byteLength(a_strong.corpus)} B)\n`);
    process.stdout.write('  이 파일이 워커가 볼 수 있었던 전부다. 여기서 가중치·통과선을 복원할 수 있으면 L2 실패다.\n');
    return 0;
  }

  // ── L3: 스왑이 무효면 나머지 검사가 공허하다. 먼저 잰다.
  rec('L3-a 기준 스왑이 판정을 바꾼다 (스왑 유효성)',
      a_strong.decision !== b_strong.decision,
      `A(1.6)→${a_strong.decision} · B(2.4)→${b_strong.decision}`);

  // ── L3-b: 같은 판정이면 **문안이 기준과 무관하게 동일**해야 한다.
  //    문안이 기준에 따라 달라지면 워커가 기준을 역추정할 수 있다.
  const sameDecision = runSession(CRITERIA_B, 'C');
  rec('L3-b 같은 판정의 문안이 기준과 무관하게 동일',
      normalize(a_weak.corpus) === normalize(sameDecision.corpus),
      a_weak.decision === sameDecision.decision
        ? `둘 다 ${a_weak.decision} · 말뭉치 ${normalize(a_weak.corpus) === normalize(sameDecision.corpus) ? '동일' : '다름'}`
        : `판정이 달라 비교 불가(${a_weak.decision} vs ${sameDecision.decision})`);

  // ── L1: 말뭉치에 기준 값 0
  for (const [label, s, crit] of [['A', a_strong, CRITERIA_A], ['B', b_strong, CRITERIA_B], ['A-weak', a_weak, CRITERIA_A]]) {
    const r = l1Report(s.corpus, crit);
    // 분모를 같이 적는다 — "위반 0" 만 적으면 전수 통과로 읽힌다. 실제로는 정수 기준값이 빠져 있다.
    rec(`L1 기준 ${label} — 말뭉치에 기준 값 0 (검사 ${r.checked.length}/${r.total})`,
        r.violations.length === 0,
        r.violations.length
          ? `누출: ${r.violations.join(',')}`
          : `${Buffer.byteLength(s.corpus)} B · 말뭉치 수 토큰 ${JSON.stringify(r.corpusNums)} · ` +
            `검사 제외(정수, 리터럴 부적합): ${r.skipped.map(([n, v]) => `${n}=${v}`).join(' ') || '없음'}`);
  }

  // ── L1 양성 대조: 검사기가 실제로 잡는가. 안 잡으면 위 0 은 미측정이다.
  const planted = `${a_strong.corpus}\n판정 근거: 통과선 ${CRITERIA_A.threshold} 를 넘었습니다.`;
  rec('L1 양성 대조 — 값을 심으면 잡는다',
      l1Report(planted, CRITERIA_A).violations.length > 0,
      `심은 값 ${CRITERIA_A.threshold}`);

  // ── 순서 함의는 **실제로 나간다**. 위반은 아니지만 "안 보인다" 고 적으면 거짓이다.
  //    워커는 등급의 서열(ORIGINAL > A > B > C)을 복원할 수 있다 — 크기와 통과선은 못 한다.
  const ordinal = /ORIGINAL\|A\|B\|C\|UNREACHABLE/.test(a_strong.schema);
  rec('은닉 하한 — 등급 **서열**은 노출된다(값·통과선은 아님)', true,
      ordinal
        ? '스키마에 ORIGINAL|A|B|C|UNREACHABLE 순서 존재 ⇒ 서열 복원 가능 · 가중치 크기·통과선은 말뭉치에 없음'
        : '순서 문자열 미검출 — 서열 노출 없음');

  // ── 어휘 하한 명시: grade 이름은 **나가는 것이 정상**이다. 안 나가면 submit 이 불가능하다.
  const vocab = ['ORIGINAL', 'UNREACHABLE'].every((g) => a_strong.schema.includes(g));
  rec('은닉 하한 — grade 어휘는 공유된다(정보성, 위반 아님)', vocab,
      vocab ? '스키마에 등급 이름 존재 = 설계대로' : '등급 이름 부재 = 워커가 제출 형식을 모른다');

  const failed = results.filter((r) => !r.ok);
  if (asJson) {
    process.stdout.write(JSON.stringify({ results, passed: results.length - failed.length, total: results.length }) + '\n');
  } else {
    for (const r of results) process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}\n`);
    process.stdout.write(`\n${results.length - failed.length}/${results.length} PASS\n`);
    process.stdout.write('L2(의미 복원)는 이 스크립트가 판정하지 않는다 — `--corpus <경로>` 로 심판용 말뭉치를 내보낸다.\n');
  }
  return failed.length ? 1 : 0;
}

/** 세션 id·프레임 id 처럼 회차마다 달라지는 것은 비교에서 뺀다(내용 비교가 목적). */
function normalize(s) {
  return s.replace(/sf-[a-z0-9]+/g, 'sf-X');
}

process.exit(main());
