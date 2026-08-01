#!/usr/bin/env node
// publish-scan.mjs — 공개 안전 스캔 (배포 전 게이트)
//
// 계약:
//   argv   : [<대상>] [--patterns <file.json>] [--json] [--allow-missing-patterns]
//            [--git-log [<범위>]]   커밋 메시지도 같은 규칙으로 검사(기본 HEAD) — 아래 사각 참조
//            |  --test
//   stdout : 위반 목록(사람용) 또는 JSON 1줄
//   exit   : 0=위반 0 · 1=위반 있음 · 2=스크립트 오류·근거 부족(통과 취급 ❌)
//
// 이 검사기가 사는 이유 — **스캐너가 조용히 안 돌아간 적이 있다**:
//   공백 구분 변수를 셸이 분할하지 않아 목록 전체를 한 파일명으로 보고 죽었는데,
//   그 출력이 "0히트"로 읽혔다. **0 은 결과가 아니라 미측정일 수 있다.**
//   그래서 매 실행마다 **양성 대조**를 먼저 돌린다 — 심어둔 씨앗을 못 잡으면 스캔 자체가 실패다.
//
// 🚨 패턴 좁히기 금지: 히트가 났을 때 패턴을 깎아 통과시키는 것은 검사기를 죽이는 것이다.
//    고치는 쪽은 **배포물**이다. 정당한 예외는 사유와 함께 명시한다(침묵 예외 ❌).
//
// ⚠️ **이 파일에 조직 고유 명단을 넣지 말 것.** 사람·계정·내부 도구 이름의 목록은 그 자체가
//    유출물이다(검사기를 공개하면 명단이 공개된다). 그래서 축을 둘로 나눈다:
//      · 범용 축(아래 GENERIC_RULES) = 어느 저장소에나 맞는 형태 검사. 이 파일에 산다.
//      · 조직 축(`--patterns`) = 사람·봇·내부 인프라 이름. **저장소 밖 파일**에서 읽는다.
//    조직 축을 안 주면 **exit 2** 다 — 절반만 재고 "깨끗하다"고 말할 수 없다.
//
// 이 검사기가 **하지 않는** 것:
//   · 점수·가중치 은닉 검사 ❌ (별도 검사기 소관 — 직교)
//   · 문안 품질·사실 정확성 ❌ (독립 검토 층)   · 라이선스 검사 ❌
//
// 외부 패키지 0 (node: 내장만).

import { readFileSync, existsSync, statSync, readdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, extname } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(join(HERE, '..'));
const die = (code, msg) => { process.stderr.write(`[publish-scan] ${msg}\n`); process.exit(code); };

/** 범용 축 — 형태로 판정한다(고유명사 없음). */
export const GENERIC_RULES = [
  { axis: 'abs-path', re: /\/Users\/[A-Za-z0-9._-]+/,     why: '내부 절대경로(사용자 홈)' },
  { axis: 'abs-path', re: /\/home\/[A-Za-z0-9._-]+\//,    why: '내부 절대경로(리눅스 홈)' },
  { axis: 'abs-path', re: /\/mnt\/[a-z]\/Users\//,        why: '내부 절대경로(마운트된 다른 OS)' },
  { axis: 'chat-id',  re: /\b\d{17,19}\b/,                why: '채팅 플랫폼 id 로 보이는 17~19자리 수' },
  { axis: 'chat-id',  re: /discord\.com\/channels/,       why: '내부 채널 링크' },
  { axis: 'email',    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, why: '이메일 주소' },
  { axis: 'secret',   re: /sk-[A-Za-z0-9]{20,}|ntn_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}/, why: '토큰 형태 문자열' },
];

const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.zip', '.ico', '.woff', '.woff2']);

/**
 * 조직 축 파일 형식:
 *   { "rules": [{"axis":"identity","re":"코드네임1|코드네임2","why":"내부 코드네임"}],
 *     "allow": [{"file":".*","re":"허용문자열","why":"사유"}] }
 * `re` 는 JS 정규식 소스. 파일 자체는 이 저장소 밖에 둔다.
 */
export function loadPatterns(path) {
  if (!existsSync(path)) die(2, `조직 축 패턴 파일 없음: ${path}`);
  let j;
  try { j = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { die(2, `패턴 파일 파싱 실패: ${e.message}`); }
  // ⚠️ `probe` 를 빼먹으면 조직 축 전부가 "대조 미검증" 으로 떨어진다(실측으로 걸렸다) —
  //    그 상태의 위반 0 은 미측정과 구분되지 않는다. 통과시키는 필드다.
  const rules = (j.rules || []).map(r => ({ axis: r.axis || 'org', re: new RegExp(r.re, r.flags || ''), why: r.why || '조직 축', probe: r.probe }));
  const allow = (j.allow || []).map(a => ({ file: new RegExp(a.file || '.*'), re: new RegExp(a.re, a.flags || ''), why: a.why || '' }));
  if (!rules.length) die(2, `패턴 파일에 rules 0건: ${path} (빈 명단을 통과로 세지 않는다)`);
  return { rules, allow };
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (!BINARY_EXT.has(extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

export function scan(target = REPO, orgRules = [], allow = []) {
  if (!existsSync(target)) die(2, `대상 없음: ${target}`);
  const files = statSync(target).isDirectory() ? walk(target) : [target];
  if (!files.length) die(2, `대상에 파일 0개: ${target} (빈 스캔을 통과로 세지 않는다)`);

  const rules = [...GENERIC_RULES, ...orgRules];
  const violations = [];
  for (const f of files) {
    const rel = relative(target, f) || f;
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const r of rules) {
        const m = lines[i].match(r.re);
        if (!m) continue;
        if (allow.some(a => a.file.test(rel) && a.re.test(m[0]))) continue;
        violations.push({ file: rel, line: i + 1, axis: r.axis, why: r.why, hit: m[0].slice(0, 60) });
      }
    }
  }
  return { target, files_scanned: files.length, axes: [...new Set(rules.map(r => r.axis))], violations };
}

/**
 * 커밋 메시지 축 — 작업 트리만 보는 검사기의 사각.
 *
 * 파일은 고치면 되지만 **커밋 메시지는 push 되면 사실상 되돌릴 수 없다**(히스토리 재작성 = 별개 결정).
 * 그래서 이 축은 "고쳐라"가 아니라 **"내보내기 전에 알아라"** 로 존재한다.
 * allow 목록은 경로 기준이라 여기서는 대개 안 걸린다 — 파일에 준 예외가 메시지 예외로 번지지 않게
 * 의도한 것이다(LICENSE 에 준 허용이 커밋 제목을 통과시키면 안 된다).
 */
export function scanGitLog(range, orgRules = [], allow = [], cwd = REPO) {
  const g = spawnSync('git', ['log', '--format=%H%x00%B%x1e', range], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (g.status !== 0) die(2, `git log 실패(${range}) — 범위를 못 읽으면 "깨끗하다"고 말할 수 없다: ${(g.stderr || '').trim()}`);
  const recs = g.stdout.split('\x1e').map(s => s.trim()).filter(Boolean);
  if (!recs.length) die(2, `커밋 0건: ${range} (빈 범위를 통과로 세지 않는다)`);

  const rules = [...GENERIC_RULES, ...orgRules];
  const violations = [];
  for (const rec of recs) {
    const [sha, body = ''] = rec.split('\x00');
    const label = `commit ${sha.slice(0, 7)}`;
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const r of rules) {
        const m = lines[i].match(r.re);
        if (!m) continue;
        if (allow.some(a => a.file.test(label) && a.re.test(m[0]))) continue;
        violations.push({ file: label, line: i + 1, axis: r.axis, why: r.why, hit: m[0].slice(0, 60) });
      }
    }
  }
  return { range, commits_scanned: recs.length, violations };
}

/** 양성 대조 — 씨앗을 심은 임시 트리에서 각 축이 실제로 잡히는지 잰다. */
export function positiveControl(orgRules = []) {
  const dir = mkdtempSync(join(tmpdir(), 'pubscan-'));
  const seeds = {
    'abs-path': '경로: /Users/someone/x',
    'chat-id': '스레드 1234567890123456789',
    email: '연락 a.b@example.com',
    secret: 'key=sk-abcdefghijklmnopqrstuvwxyz12',
  };
  // 조직 축은 그 축의 패턴에서 씨앗을 만들 수 없다(정규식이라 역생성 불가) →
  // 파일이 제공한 `probe` 문자열을 쓴다. 없으면 그 축은 대조 불가로 **보고**한다(숨기지 않는다).
  const orgSeeds = orgRules.filter(r => r.probe).map(r => r.probe);
  writeFileSync(join(dir, 'seed.md'), [...Object.values(seeds), ...orgSeeds].join('\n') + '\n');
  const r = scan(dir, orgRules, []);
  rmSync(dir, { recursive: true, force: true });
  const caught = new Set(r.violations.map(v => v.axis));
  const missed = Object.keys(seeds).filter(a => !caught.has(a));
  const orgUnverified = orgRules.filter(r => !r.probe).map(r => r.axis);
  return { caught: [...caught], missed, org_axes_without_probe: [...new Set(orgUnverified)] };
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

  const pc = positiveControl();
  t('양성 대조 — 범용 4축 씨앗 전건 검출', pc.missed.length === 0,
    `잡힘=${pc.caught.join(',')} 놓침=${pc.missed.join(',') || '없음'}`);

  // 조직 축 주입이 실제로 새 축을 만드는가 (주입이 무시되면 절반만 재고 통과한다).
  const dir = mkdtempSync(join(tmpdir(), 'pubscan-org-'));
  writeFileSync(join(dir, 'p.json'), JSON.stringify({ rules: [{ axis: 'org-x', re: 'ZZTOPSECRET', why: 't', probe: 'ZZTOPSECRET' }] }));
  writeFileSync(join(dir, 'doc.md'), 'hello ZZTOPSECRET world\n');
  const withOrg = run([join(dir, 'doc.md'), '--patterns', join(dir, 'p.json'), '--json']);
  const parsed = (() => { try { return JSON.parse(withOrg.stdout.trim()); } catch { return null; } })();
  t('조직 축 주입 → 새 축이 실제로 검출한다', withOrg.status === 1 && !!parsed
    && parsed.violations.some(v => v.axis === 'org-x'), `exit=${withOrg.status}`);

  // 조직 축 없이는 통과 주장 자체를 막는다(절반 측정으로 GREEN ❌).
  const noPat = run([join(dir, 'doc.md')]);
  t('음성 대조 — 조직 축 미제공 = exit 2 (절반 측정 GREEN ❌)', noPat.status === 2, `exit=${noPat.status}`);

  // 명시 선언하면 범용 축만으로 돌 수 있다 — 단 그 사실이 출력에 남는다.
  const partial = run([join(dir, 'doc.md'), '--allow-missing-patterns', '--json']);
  const pj = (() => { try { return JSON.parse(partial.stdout.trim()); } catch { return null; } })();
  t('부분 스캔은 라벨로만 허용', partial.status === 0 && pj && pj.org_axis === 'not-loaded', `exit=${partial.status}`);

  writeFileSync(join(dir, 'empty.json'), JSON.stringify({ rules: [] }));
  const emptyPat = run([join(dir, 'doc.md'), '--patterns', join(dir, 'empty.json')]);
  t('음성 대조 — 빈 명단 = exit 2', emptyPat.status === 2, `exit=${emptyPat.status}`);

  const emptyDir = mkdtempSync(join(tmpdir(), 'pubscan-empty-'));
  const empty = run([emptyDir, '--allow-missing-patterns']);
  rmSync(emptyDir, { recursive: true, force: true });
  t('음성 대조 — 파일 0개 = exit 2 (빈 스캔 ❌)', empty.status === 2, `exit=${empty.status}`);

  const missing = run(['/nonexistent-' + process.pid, '--allow-missing-patterns']);
  t('음성 대조 — 대상 부재 = exit 2', missing.status === 2, `exit=${missing.status}`);

  rmSync(dir, { recursive: true, force: true });
  process.stdout.write(`\n${pass}/${pass + fail} PASS\n`);
  return fail === 0 ? 0 : 1;
}

// ─────────────────────────── CLI ───────────────────────────

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!isMain) { /* 라이브러리 로드 */ }
else if (process.argv.includes('--test')) process.exit(selfTest());
else {
  const argv = process.argv.slice(2);
  const flagVal = f => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : null; };
  const asJson = argv.includes('--json');
  const allowMissing = argv.includes('--allow-missing-patterns');
  const patPath = flagVal('--patterns') || process.env.PUBLISH_SCAN_PATTERNS || null;
  // ⚠️ 값을 받는 플래그를 한 곳에 모은다 — 신규 플래그를 여기 안 넣으면 그 **값이 스캔 대상으로**
  //    둔갑한다(실측으로 걸렸다: `--git-log origin/main` → 대상 `<repo>/origin/main` → exit 2).
  const VALUE_FLAGS = new Set(['--patterns', '--git-log']);
  const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]));
  const target = positional[0] ? resolve(positional[0]) : REPO;

  let org = { rules: [], allow: [] };
  if (patPath) org = loadPatterns(resolve(patPath));
  else if (!allowMissing)
    die(2, '조직 축 패턴 파일이 없다 — `--patterns <file.json>`(또는 env PUBLISH_SCAN_PATTERNS) 을 주거나, 범용 축만 돌 것을 `--allow-missing-patterns` 로 명시 선언하라. 절반만 재고 "깨끗하다"고 말할 수 없다.');

  const pc = positiveControl(org.rules);
  if (pc.missed.length) die(2, `양성 대조 실패 — 축 ${pc.missed.join(',')} 를 못 잡는다. 이 스캔 결과는 신뢰할 수 없다.`);

  const out = scan(target, org.rules, org.allow);

  // 커밋 메시지 축 — 명시 요청 시에만(범위를 사람이 정한다). 기본 동작 불변.
  const wantLog = argv.includes('--git-log');
  const logOut = wantLog ? scanGitLog(flagVal('--git-log') || 'HEAD', org.rules, org.allow) : null;

  const meta = { ...out, positive_control: pc.caught, org_axis: patPath ? 'loaded' : 'not-loaded',
                 org_axes_without_probe: pc.org_axes_without_probe, git_log: logOut };
  if (asJson) process.stdout.write(JSON.stringify(meta) + '\n');
  else {
    process.stdout.write(`[publish-scan] 양성 대조 OK(${pc.caught.join(',')}) · 조직 축=${meta.org_axis} · 파일 ${out.files_scanned}개 · 위반 ${out.violations.length}건\n`);
    if (pc.org_axes_without_probe.length)
      process.stdout.write(`  ⚠️ 대조 미검증 조직 축(씨앗 probe 없음): ${pc.org_axes_without_probe.join(',')} — 이 축의 0 은 미측정과 구분되지 않는다\n`);
    for (const v of out.violations) process.stdout.write(`  ${v.file}:${v.line} [${v.axis}] ${v.why} — "${v.hit}"\n`);
    if (logOut) {
      process.stdout.write(`[publish-scan] 커밋 메시지 축 · 범위 ${logOut.range} · 커밋 ${logOut.commits_scanned}개 · 위반 ${logOut.violations.length}건\n`);
      for (const v of logOut.violations) process.stdout.write(`  ${v.file}:${v.line} [${v.axis}] ${v.why} — "${v.hit}"\n`);
      if (logOut.violations.length)
        process.stdout.write('  ⚠️ 커밋 메시지는 push 된 뒤 파일처럼 고칠 수 없다 — 히스토리 재작성은 별개 결정이다. 이 축은 "내보내기 전에 알아라" 용도다.\n');
    }
  }
  process.exit((out.violations.length + (logOut?.violations.length || 0)) ? 1 : 0);
}
