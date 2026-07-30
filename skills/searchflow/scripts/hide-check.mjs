#!/usr/bin/env node
// hide-check.mjs — 조립된 워커 프롬프트에서 리드 전용 수치 누출을 검사한다.
//
// 계약 (21-implementation-spec §2-6 ABI):
//   argv   : <조립된 워커 프롬프트 파일>...  |  --test
//   stdout : 누출 매치 목록 (파일:라인:패턴)
//   exit   : 0=PASS · 1=FAIL(누출 또는 **검사기 사망**) · 2=스크립트 오류(**통과 취급 ❌**)
//
// 금칙 패턴 SoT = references/scoring.md 머리의 `<!-- HIDE-TOKENS: ... -->` 선언부 **한 곳뿐**.
// 여기에 패턴을 복제하지 않는다 — 이중 관리는 한쪽만 갱신되는 순간 은닉이 조용히 얇아진다.
//
// ⚠️ **양성 대상 미검출 = exit 1.** 매 실행마다 고의 오염 fixture 를 함께 검사해
//    "0건 통과"와 "검사기가 죽어서 아무것도 못 봄"을 갈라낸다 — 이 둘은 화면상 같다.
//
// 외부 패키지 0 (node: 내장만).

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(SCRIPT_DIR, '..');
const SCORING = join(SKILL_DIR, 'references', 'scoring.md');
const POSITIVE = join(SKILL_DIR, 'fixtures', 'hide-positive.txt');

class ScriptError extends Error {}

/** 한글 조합형/분해형 차이로 검사가 새지 않게 — 비교 전 NFC 로 모은다. */
const nfc = s => s.normalize('NFC');

/** scoring.md 머리의 HIDE-TOKENS 블록 → 정규식 배열. */
function loadPatterns() {
  if (!existsSync(SCORING)) {
    throw new ScriptError(`패턴 SoT 부재 — ${SCORING}`);
  }
  const text = nfc(readFileSync(SCORING, 'utf8'));
  const m = text.match(/<!--\s*HIDE-TOKENS:\s*([\s\S]*?)-->/);
  if (!m) {
    throw new ScriptError('scoring.md 에 HIDE-TOKENS 선언부가 없음 — 패턴 0개로는 검사가 성립하지 않는다');
  }
  const out = [];
  for (const raw of m[1].split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    try {
      out.push({ src: line, re: new RegExp(line, 'g') });
    } catch (err) {
      throw new ScriptError(`패턴 컴파일 실패 — /${line}/ : ${err.message}`);
    }
  }
  if (!out.length) {
    throw new ScriptError('HIDE-TOKENS 블록이 비어 있음 — 검사기가 아무것도 안 본다');
  }
  return out;
}

/** 한 텍스트에서 누출 매치 목록. label 은 출력용 경로/이름. */
function scanText(text, label, patterns) {
  const hits = [];
  const lines = nfc(text).split('\n');
  lines.forEach((line, i) => {
    for (const { src, re } of patterns) {
      re.lastIndex = 0;
      let mm;
      while ((mm = re.exec(line)) !== null) {
        hits.push({ file: label, line: i + 1, pattern: src, match: mm[0] });
        if (mm.index === re.lastIndex) re.lastIndex += 1;   // 폭 0 매치 무한루프 방어
      }
    }
  });
  return hits;
}

function scanFile(path, patterns) {
  if (!existsSync(path)) throw new ScriptError(`검사 대상 부재 — ${path}`);
  return scanText(readFileSync(path, 'utf8'), path, patterns);
}

const fmt = h => `${h.file}:${h.line}:${h.pattern} | match="${h.match}"`;

/**
 * 양성 대조 — 고의 오염 fixture 가 잡히는지.
 * 잡히지 않으면 이 실행의 "0건"은 무의미하다(패턴 로드 실패·정규화 사고·fixture 표류).
 */
function livenessOrDie(patterns) {
  if (!existsSync(POSITIVE)) {
    throw new ScriptError(`양성 fixture 부재 — ${POSITIVE} (생존 증명 불가 = 검사 성립 안 함)`);
  }
  return scanFile(POSITIVE, patterns);
}

/**
 * 패턴별 커버리지 — fixture 가 밟지 않는 패턴은 **검증되지 않은 패턴**이다.
 * 전체 히트 ≥1 만 보면 어휘층 하나가 잡히는 것으로 수치층 사망을 덮는다(실제로 겪은 갭).
 * 본 경로에서는 stderr 경고(ABI 유지), `--test` 에서는 FAIL.
 */
function uncovered(patterns, posHits) {
  const seen = new Set(posHits.map(h => h.pattern));
  return patterns.filter(p => !seen.has(p.src)).map(p => p.src);
}

// ── 셀프테스트 ──────────────────────────────────────────────────────────────
function selfTest() {
  const results = [];
  let patterns;
  try {
    patterns = loadPatterns();
  } catch (err) {
    console.log(`FAIL  패턴 로드 — ${err.message}`);
    return 1;
  }
  results.push({ name: 'HIDE-TOKENS 패턴 로드 ≥1', ok: patterns.length >= 1, detail: `${patterns.length}개` });

  // 양성 대조 — 고의 오염이 잡히는가
  let pos = [], posErr = null;
  try { pos = livenessOrDie(patterns); } catch (err) { posErr = err.message; }
  results.push({
    name: '양성 대조 — 고의 오염 fixture 검출 ≥1',
    ok: pos.length >= 1,
    detail: posErr || `${pos.length}건 (0 이면 검사기 사망)`,
  });

  // 패턴별 커버리지 — 어휘층 히트로 수치층 사망을 덮지 못하게
  const gaps = posErr ? patterns.map(p => p.src) : uncovered(patterns, pos);
  results.push({
    name: '커버리지 — 선언 패턴 전종이 fixture 로 검증됨',
    ok: gaps.length === 0,
    detail: gaps.length ? `미검증 ${gaps.length}개: ${gaps.join(' / ')}` : `${patterns.length}/${patterns.length}`,
  });

  // 음성 대조 1 — 깨끗한 텍스트는 0건 (항상 FAIL 하는 검사기 배제)
  const clean = [
    '담당 축: f3 (반증) — 이 주장에 반대되는 증거를 찾는다.',
    '반환: findings[] + SELF-REPORT S1~S5 각 Y/N + 근거 1줄.',
    '취득은 references/acquisition.md 사다리를 따른다. 우회 금지.',
    '마감: 2026-07-30 13:00 KST 까지.',
  ].join('\n');
  const cleanHits = scanText(clean, '(clean)', patterns);
  results.push({
    name: '음성 대조 — 정상 워커 프롬프트 0건',
    ok: cleanHits.length === 0,
    detail: cleanHits.length ? cleanHits.map(fmt).join(' / ') : '0건',
  });

  // 음성 대조 2 — 버전·좌표 소수는 오탐 아님
  const versionish = 'codex 0.146.0 / v1.20 / lat 100.15 / 2.5배 / 항목 1.2.3';
  const vHits = scanText(versionish, '(version)', patterns);
  results.push({
    name: '음성 대조 — 버전·좌표 소수 오탐 0건',
    ok: vHits.length === 0,
    detail: vHits.length ? vHits.map(fmt).join(' / ') : '0건',
  });

  // 양성 대조 2 — NFD(분해형) 한글도 잡히는가 = 정규화가 실효인가
  const nfd = '이 조사의 문턱을 넘기면 종료'.normalize('NFD');
  const nfdHits = scanText(nfd, '(nfd)', patterns);
  results.push({
    name: '양성 대조 — NFD 분해형 한글 검출 (정규화 실효)',
    ok: nfdHits.length >= 1,
    detail: nfdHits.length ? nfdHits.map(h => h.pattern).join(',') : '0건 — normalize 가 안 걸리고 있다',
  });

  // 양성 대조 3 — 수치층이 실제로 문턱/가중치 소수를 잡는가
  const numeric = '합격은 0.80 이상, 이 축 비중은 .35 다.';
  const nHits = scanText(numeric, '(numeric)', patterns);
  results.push({
    name: '양성 대조 — 소수 수치층 검출 ≥2',
    ok: nHits.length >= 2,
    detail: `${nHits.length}건 ${nHits.map(h => h.match).join(',')}`,
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}`);
    if (!r.ok) failed += 1;
  }
  console.log(`\n${results.length - failed}/${results.length} PASS`);
  return failed === 0 ? 0 : 1;
}

// ── 본 경로 ─────────────────────────────────────────────────────────────────
try {
  const args = process.argv.slice(2);
  if (args.includes('--test')) process.exit(selfTest());

  const targets = args.filter(a => !a.startsWith('--'));
  if (!targets.length) {
    console.error('usage: hide-check.mjs <조립된 워커 프롬프트 파일>... | --test');
    process.exit(2);
  }

  const patterns = loadPatterns();

  // 생존 증명 먼저 — 죽은 검사기의 "0건"을 PASS 로 내보내지 않는다.
  const alive = livenessOrDie(patterns);
  if (alive.length === 0) {
    console.log(`검사기 사망 — 양성 fixture(${POSITIVE})에서 0건. 패턴 ${patterns.length}개가 로드됐는데도 고의 오염이 안 잡힌다.`);
    console.log('이번 실행의 결과는 신뢰할 수 없다(0건이 "깨끗함"이 아니라 "안 봄"일 수 있다).');
    process.exit(1);
  }

  const gaps = uncovered(patterns, alive);
  if (gaps.length) {
    process.stderr.write(
      `[hide-check] ⚠️ 미검증 패턴 ${gaps.length}개 — 양성 fixture 가 밟지 않는다: ${gaps.join(' / ')}\n` +
      `[hide-check]    이 패턴들의 "0건"은 생존이 증명되지 않은 0건이다. fixture 에 해당 줄을 추가할 것(--test 는 FAIL).\n`);
  }

  const hits = [];
  for (const t of targets) hits.push(...scanFile(t, patterns));

  if (hits.length) {
    for (const h of hits) console.log(fmt(h));
    console.log(`\n누출 ${hits.length}건 / 대상 ${targets.length}개 — 조립 경로가 리드 전용 층을 밟았다.`);
    process.exit(1);
  }

  console.log(`PASS — 누출 0건 (대상 ${targets.length}개 · 패턴 ${patterns.length}개 · 양성 대조 ${alive.length}건 검출로 생존 확인)`);
  process.exit(0);
} catch (err) {
  if (err instanceof ScriptError) {
    console.error(`[hide-check] 스크립트 오류 — ${err.message}`);
    console.error('exit 2 = 통과 취급 ❌. 사유를 기록하고 조립을 진행하지 않는다.');
    process.exit(2);
  }
  console.error(`[hide-check] 예상 밖 오류 — ${err && err.stack || err}`);
  process.exit(2);
}
