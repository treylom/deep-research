#!/usr/bin/env node
// report-check.mjs — 보고서 산출 계약 검증 (칸이 실제로 채워졌는가)
//
// 계약:
//   argv   : <report.md> [--labels <라벨,라벨>]  |  --test
//   stdout : JSON 1줄 {file, columns_required, columns_found, missing[], empty[], labels_missing[], violations[]}
//   exit   : 0=위반 0 · 1=위반 있음 · 2=스크립트 오류(통과 취급 ❌)
//
// SoT 규율: 칸 목록은 **`references/report-contract.md` §1 표가 유일 SoT** 다. 여기 복제하지 않는다
//   (frames.md↔spawn-plan · scoring.md↔hide-check 와 같은 규율. 이중 관리는 한쪽만 갱신되는
//    순간 조용히 갈리고, 그때 검사기는 옛 계약을 통과시킨다).
//
// "있다"와 "채워졌다"를 구분한다: 칸 제목만 있고 내용이 없으면 `empty` 로 따로 센다.
//   제목만 복사해 두면 계약을 형식적으로 통과하면서 실질은 비는데, 그게 가장 흔한 통과 방식이다.
//
// 이 검사기가 **하지 않는** 것 — 안 적으면 GREEN 을 과대 인용한다:
//   · 내용의 진위·품질 판정 ❌ (칸 존재·비어있지 않음만 본다)
//   · 인용이 실제 원문과 일치하는지 ❌ (그건 원문 대조 층)
//   · 점수 계산 검증 ❌ (리드 전용 층)
//
// 외부 패키지 0 (node: 내장만).

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = resolve(join(HERE, '..', 'references', 'report-contract.md'));
const FIX = resolve(join(HERE, '..', 'fixtures'));
const die = (code, msg) => { process.stderr.write(`[report-check] ${msg}\n`); process.exit(code); };

/** report-contract.md §1 표에서 필수 칸 이름을 뽑는다. 행 형태: | **as-of 표기** | … | … | */
export function loadColumns(path = CONTRACT) {
  if (!existsSync(path)) die(2, `report-contract.md 없음: ${path} (빈 계약으로 넘어가지 않는다)`);
  const md = readFileSync(path, 'utf8').normalize('NFC');
  const cols = [];
  let inSection = false;
  for (const line of md.split('\n')) {
    if (/^##\s/.test(line)) { inSection = /^##\s*1\./.test(line); continue; }
    if (!inSection) continue;
    const m = line.match(/^\|\s*\*\*(.+?)\*\*\s*\|/);
    if (m) cols.push(m[1].trim());
  }
  if (cols.length < 10) die(2, `report-contract.md §1 파싱 실패 — 칸 ${cols.length}개만 잡힘(10+ 기대)`);
  return cols;
}

/**
 * 보고서에서 칸을 찾는다. 표기 자유를 허용한다 — 제목(`## as-of 표기`)이든
 * 표 행(`| as-of 표기 | … |`)이든 굵게(`**as-of 표기**`)든 인정한다.
 * 대신 **그 칸 뒤에 내용이 있는지**를 별도로 본다.
 */
function findColumn(reportLines, col) {
  const needle = col.toLowerCase();
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // ⚠️ 느슨한 매칭은 검사기를 무력화한다 — 실측으로 걸렸다: 문서 머리말의
  //    "심은 위반: 「부재 단정 근거」 칸 삭제" 라는 **설명 문장**이 그 칸으로 인정돼,
  //    실제로 칸이 없는데 있다고 판정했다. 그래서 **라벨이 줄의 머리에 올 때만** 인정한다.
  const atHead = new RegExp('^\\s*(?:#{1,6}\\s*|[-*]\\s*)?(?:\\*\\*)?' + esc);
  for (let i = 0; i < reportLines.length; i++) {
    const line = reportLines[i], l = line.toLowerCase();
    const isHeading = /^#{1,6}\s/.test(line) && atHead.test(l);
    const isBold = /^\s*(?:[-*]\s*)?\*\*/.test(line) && atHead.test(l);
    // 표 행은 **첫 칸**이 라벨일 때만.
    const firstCell = /^\|/.test(line) ? (line.split('|')[1] || '').toLowerCase().replace(/\*\*/g, '').trim() : null;
    const isRow = firstCell !== null && firstCell.startsWith(needle);
    if (!isHeading && !isRow && !isBold) continue;

    // 내용 판정: 표 행이면 그 행의 나머지 칸, 제목이면 다음 비어있지 않은 줄.
    if (isRow) {
      const cells = reportLines[i].split('|').map(s => s.trim()).filter(Boolean);
      const rest = cells.slice(1).join(' ').replace(/\*\*/g, '').trim();
      return { found: true, filled: rest.length > 0 && !/^-+$/.test(rest) };
    }
    for (let j = i + 1; j < reportLines.length; j++) {
      const nxt = reportLines[j].trim();
      if (!nxt) continue;
      if (/^#{1,6}\s/.test(nxt)) return { found: true, filled: false };   // 바로 다음 제목 = 내용 없음
      return { found: true, filled: true };
    }
    return { found: true, filled: false };
  }
  return { found: false, filled: false };
}

export function check(file, requiredLabels = [], contractPath) {
  if (!existsSync(file)) return { fatal: `없는 파일: ${file}` };
  const cols = loadColumns(contractPath);
  const text = readFileSync(file, 'utf8').normalize('NFC');
  const lines = text.split('\n');
  if (!text.trim()) return { fatal: `빈 보고서: ${file} (0바이트를 통과로 세지 않는다)` };

  const missing = [], empty = [];
  for (const c of cols) {
    const r = findColumn(lines, c);
    if (!r.found) missing.push(c);
    else if (!r.filled) empty.push(c);
  }
  // 강등 라벨은 spawn-plan 이 낸 문자열 그대로 실려야 한다(AC9 grep 대상).
  const labelsMissing = requiredLabels.filter(l => !text.includes(l));

  const violations = [
    ...missing.map(c => `칸 부재 — ${c}`),
    ...empty.map(c => `칸이 제목만 있고 내용 없음 — ${c}`),
    ...labelsMissing.map(l => `격하 라벨 부재 — ${l} (환경·한계 칸에 문자열 그대로 필요)`),
  ];
  return { file, columns_required: cols.length, columns_found: cols.length - missing.length, missing, empty, labels_missing: labelsMissing, violations };
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

  const cols = loadColumns();
  t('report-contract.md §1 파싱 — 필수 칸 로드', cols.length >= 13, `${cols.length}개: ${cols.slice(0, 3).join(' / ')}…`);

  const ok = check(join(FIX, 'report-valid.md'), ['parallelism=sequential']);
  t('양성 fixture — 위반 0', ok.violations.length === 0,
    `칸 ${ok.columns_found}/${ok.columns_required}`);

  const bad = check(join(FIX, 'report-invalid.md'), ['parallelism=sequential']);
  const hit = re => bad.violations.find(v => re.test(v));
  t('음성 — 칸 부재 검출', !!hit(/칸 부재/), hit(/칸 부재/) || '');
  t('음성 — 제목만 있고 내용 없는 칸 검출', !!hit(/제목만/), hit(/제목만/) || '');
  t('음성 — 격하 라벨 부재 검출', !!hit(/격하 라벨 부재/), hit(/격하 라벨 부재/) || '');
  t('음성 — 위반 3종이 동시에 잡힘', bad.violations.length >= 3, `${bad.violations.length}건`);

  // 검사기가 항상 위반을 뱉는 고장이면 위 양성이 의미 없다 → 양성/음성 쌍으로 확인 완료.
  t('대조 성립 — 같은 검사기가 양성 0 / 음성 3+', ok.violations.length === 0 && bad.violations.length >= 3);

  // SoT 부재를 빈 계약으로 삼키지 않는다.
  const noSot = run([join(FIX, 'report-valid.md'), '--contract', '/nonexistent-contract-' + process.pid + '.md']);
  t('음성 — 계약 SoT 부재 시 exit 2 (빈 칸 목록 ❌)', noSot.status === 2, `exit=${noSot.status}`);

  const rOk = run([join(FIX, 'report-valid.md')]);
  const rBad = run([join(FIX, 'report-invalid.md')]);
  const rMiss = run([join(FIX, 'no-such-report.md')]);
  t('exit 계약 — 0 / 1 / 2', rOk.status === 0 && rBad.status === 1 && rMiss.status === 2,
    `valid=${rOk.status} invalid=${rBad.status} 없는파일=${rMiss.status}`);

  process.stdout.write(`\n${pass}/${pass + fail} PASS\n`);
  return fail === 0 ? 0 : 1;
}

// ─────────────────────────── CLI ───────────────────────────

// 이 파일은 함수를 export 하므로 **직접 실행일 때만** CLI 를 돈다.
// 가드가 없으면 import 하는 쪽에서 사용법 출력 + exit 2 가 튄다(실측으로 걸렸다).
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!isMain) { /* 라이브러리로 로드됨 — CLI 미실행 */ }
else if (process.argv.includes('--test')) process.exit(selfTest());
else {
const argv = process.argv.slice(2);
let labels = [], contractPath = CONTRACT;
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--labels') { labels = (argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean); continue; }
  if (argv[i] === '--contract') { contractPath = argv[++i]; continue; }
  if (argv[i].startsWith('--')) continue;
  files.push(argv[i]);
}
if (!files.length) die(2, '사용법: report-check.mjs <report.md> [--labels a,b] [--contract <path>]  |  --test');

let bad = 0;
for (const f of files) {
  const out = check(f, labels, contractPath);
  if (out.fatal) die(2, out.fatal);
  process.stdout.write(JSON.stringify(out) + '\n');
  if (out.violations.length) { for (const v of out.violations) process.stderr.write(`[report-check] ${v}\n`); bad++; }
}
process.exit(bad ? 1 : 0);
}
