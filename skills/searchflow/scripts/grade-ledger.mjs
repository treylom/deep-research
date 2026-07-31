#!/usr/bin/env node
// grade-ledger.mjs — sources.jsonl schema v1 검증기
//
// 계약 (21-implementation-spec §2-6 ABI):
//   argv   : <sources.jsonl>  |  --test
//   stdout : 위반 목록 (라인번호 + 사유)
//   exit   : 0 = PASS · 1 = FAIL(위반 있음) · 2 = 스크립트 자체 오류
//
// exit 2 는 "통과 취급 ❌" — 리드는 사유를 기록한 뒤 core 로 진행한다.
// 외부 패키지 0 (node: 내장만).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCHEMA_VERSION = '1';
const GRADES = new Set(['ORIGINAL', 'A', 'B', 'C', 'UNREACHABLE']);
const STATUSES = new Set(['used', 'discarded', 'unreachable']);
const REQUIRED = [
  'schema_version', 'run_id', 'frame_id', 'source_id',
  'url', 'claim', 'grade', 'grade_basis', 'accessed_at', 'status',
];
const OPTIONAL = new Set(['verbatim', 'discard_reason', 'unreachable_reason']);
// UNREACHABLE 은 **두 사실을 한 이름으로 덮고 있었다** — 차단당해 못 갔는가(존중해 멈춤),
// 시한 안에 못 쫓았는가(시간을 더 주면 풀림). 처분이 다르다.
// 실측으로 걸렸다(AC8 RUN2): 워커가 enum 으로 못 적으니 그 구분을 **산문에** 넣었다.
const UNREACHABLE_REASONS = new Set(['blocked', 'not-traced']);

// sf-<YYYYMMDDTHHMMSSZ>-<4hex>
const RUN_ID = /^sf-\d{8}T\d{6}Z-[0-9a-f]{4}$/;
// ISO-8601 + offset (Z 또는 ±HH:MM) — offset 없는 naive 시각은 거부
const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** @returns {{violations: string[], records: number}} */
export function validateLedger(text) {
  const violations = [];
  const seenSourceIds = new Map(); // source_id -> 최초 라인번호
  let records = 0;

  const lines = text.split('\n');
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.trim();
    if (line === '') return; // 빈 줄은 무시 (파일 끝 개행 허용)

    let rec;
    try {
      rec = JSON.parse(line);
    } catch (err) {
      violations.push(`${lineNo}: malformed line — JSON parse 실패 (${err.message})`);
      return;
    }
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
      violations.push(`${lineNo}: record 가 JSON object 아님`);
      return;
    }
    records += 1;

    for (const field of REQUIRED) {
      if (!(field in rec)) {
        violations.push(`${lineNo}: 필수필드 누락 — ${field}`);
      } else if (typeof rec[field] !== 'string' || rec[field] === '') {
        violations.push(`${lineNo}: ${field} 는 비어있지 않은 문자열이어야 함 (받은 값: ${JSON.stringify(rec[field])})`);
      }
    }

    for (const key of Object.keys(rec)) {
      if (!REQUIRED.includes(key) && !OPTIONAL.has(key)) {
        violations.push(`${lineNo}: 미정의 필드 — ${key} (schema v${SCHEMA_VERSION} 확장은 schema_version 증분으로만)`);
      }
    }

    if ('schema_version' in rec && rec.schema_version !== SCHEMA_VERSION) {
      violations.push(`${lineNo}: schema_version 불일치 — "${SCHEMA_VERSION}" 고정 (받은 값: ${JSON.stringify(rec.schema_version)})`);
    }
    if (typeof rec.run_id === 'string' && !RUN_ID.test(rec.run_id)) {
      violations.push(`${lineNo}: run_id 형식 위반 — sf-<YYYYMMDDTHHMMSSZ>-<4hex> (받은 값: ${rec.run_id})`);
    }
    if ('grade' in rec && !GRADES.has(rec.grade)) {
      violations.push(`${lineNo}: grade enum 위반 — ${[...GRADES].join('|')} (받은 값: ${JSON.stringify(rec.grade)})`);
    }
    if ('status' in rec && !STATUSES.has(rec.status)) {
      violations.push(`${lineNo}: status enum 위반 — ${[...STATUSES].join('|')} (받은 값: ${JSON.stringify(rec.status)})`);
    }
    if (typeof rec.accessed_at === 'string' && !ISO_OFFSET.test(rec.accessed_at)) {
      violations.push(`${lineNo}: accessed_at 은 ISO-8601+offset 이어야 함 (받은 값: ${rec.accessed_at})`);
    }
    if (rec.status === 'discarded' && (typeof rec.discard_reason !== 'string' || rec.discard_reason === '')) {
      violations.push(`${lineNo}: status=discarded 면 discard_reason 필수`);
    }
    // grade=UNREACHABLE 은 사유 축을 반드시 갖는다 — 없으면 "차단"과 "미추적"이 한 이름에 묻힌다.
    if (rec.grade === 'UNREACHABLE') {
      if (!('unreachable_reason' in rec)) {
        violations.push(`${lineNo}: grade=UNREACHABLE 면 unreachable_reason 필수 — ${[...UNREACHABLE_REASONS].join('|')} (차단당한 것과 시한 내 못 쫓은 것은 다른 사실이고 처분이 다르다)`);
      } else if (!UNREACHABLE_REASONS.has(rec.unreachable_reason)) {
        violations.push(`${lineNo}: unreachable_reason enum 위반 — ${[...UNREACHABLE_REASONS].join('|')} (받은 값: ${JSON.stringify(rec.unreachable_reason)})`);
      }
    } else if ('unreachable_reason' in rec) {
      violations.push(`${lineNo}: unreachable_reason 은 grade=UNREACHABLE 일 때만 쓴다 (받은 grade: ${JSON.stringify(rec.grade)})`);
    }
    if (typeof rec.source_id === 'string' && rec.source_id !== '') {
      const first = seenSourceIds.get(rec.source_id);
      if (first !== undefined) {
        violations.push(`${lineNo}: source_id 중복 — "${rec.source_id}" (최초 등장 ${first}행)`);
      } else {
        seenSourceIds.set(rec.source_id, lineNo);
      }
    }
  });

  return { violations, records };
}

// ── 셀프테스트 ──────────────────────────────────────────────────────────────
// 양성(valid → PASS) 과 음성(invalid → FAIL) 을 함께 돌린다.
// 양성만 통과시키는 검사기는 "언제나 PASS" 와 화면상 구별되지 않는다.
function selfTest() {
  const here = dirname(fileURLToPath(import.meta.url));
  const fx = join(here, '..', 'fixtures');
  const results = [];

  const valid = validateLedger(readFileSync(join(fx, 'ledger-valid.jsonl'), 'utf8'));
  results.push({
    name: '양성 fixture(ledger-valid.jsonl) → 위반 0',
    ok: valid.violations.length === 0,
    detail: valid.violations.length === 0
      ? `records=${valid.records}`
      : `예상 0건, 실제 ${valid.violations.length}건: ${valid.violations.join(' / ')}`,
  });

  const invalid = validateLedger(readFileSync(join(fx, 'ledger-invalid.jsonl'), 'utf8'));
  // 음성 fixture 가 담고 있는 6종이 각각 잡히는지 — 총 건수가 아니라 종류로 본다
  const kinds = {
    '필수필드 누락': /필수필드 누락/,
    'enum 위반': /enum 위반/,
    'source_id 중복': /source_id 중복/,
    'malformed line': /malformed line/,
    // UNREACHABLE 의 사유 축 — 없으면 "차단"과 "미추적"이 한 이름에 묻힌다.
    'UNREACHABLE 사유 누락': /unreachable_reason 필수/,
    'UNREACHABLE 아닌데 사유 붙음': /unreachable_reason 은 grade=UNREACHABLE 일 때만/,
  };
  for (const [label, re] of Object.entries(kinds)) {
    results.push({
      name: `음성 fixture → ${label} 검출`,
      ok: invalid.violations.some(v => re.test(v)),
      detail: invalid.violations.filter(v => re.test(v))[0] ?? '미검출 — 검사기가 이 위반을 못 본다',
    });
  }

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}`);
    if (!r.ok) failed += 1;
  }
  console.log(`\n${results.length - failed}/${results.length} PASS`);
  return failed === 0 ? 0 : 1;
}

function main(argv) {
  if (argv.includes('--test')) return selfTest();

  const target = argv.find(a => !a.startsWith('--'));
  if (!target) {
    console.log('usage: grade-ledger.mjs <sources.jsonl> | --test');
    return 2;
  }

  let text;
  try {
    text = readFileSync(target, 'utf8');
  } catch (err) {
    console.log(`스크립트 오류: ${target} 읽기 실패 — ${err.message}`);
    return 2; // 통과 취급 ❌ — 리드는 사유 기록 후 core 진행
  }

  const { violations, records } = validateLedger(text);
  if (violations.length === 0) {
    console.log(`PASS — ${records} record, 위반 0 (schema v${SCHEMA_VERSION})`);
    return 0;
  }
  for (const v of violations) console.log(v);
  console.log(`\nFAIL — ${records} record 중 위반 ${violations.length}건`);
  return 1;
}

// 직접 실행일 때만 종료코드 반환 (import 시엔 validateLedger 만 노출)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let code;
  try {
    code = main(process.argv.slice(2));
  } catch (err) {
    console.log(`스크립트 오류: ${err && err.stack ? err.stack : err}`);
    code = 2;
  }
  process.exit(code);
}
