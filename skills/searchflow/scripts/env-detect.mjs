#!/usr/bin/env node
// env-detect.mjs — enhanced 층 탐지 (fail-open)
//
// 계약 (21-implementation-spec §2-6 ABI):
//   argv   : (없음)  |  --test
//   stdout : JSON 1줄 {"cross_engine":bool,"knowledge_hook":bool,"ooo":bool,"multi_agent_api":"public|collab_v2|none"}
//   exit   : 본 경로(인자 없음) = 항상 0 (fail-open — 부재는 exit 코드가 아니라 값으로 표현한다)
//            `--test` 만 예외: 자체 테스트 실패 시 1 (검사기가 깨진 것은 "부재" 가 아니다)
//   자체 timeout : 5s (탐지가 리서치를 붙잡지 않는다)
//
// 진단 메시지는 stderr 로만 — stdout 은 파싱 가능한 1줄을 유지한다.
// 외부 패키지 0 (node: 내장만).
//
// ⚠️ multi_agent_api 는 **참고값이다.** 최종 판정은 리드가 자기 tool surface 에서 한다
//    (§1-2.5 — shell 이 모델의 tool 노출을 대신 판정하면 틀린다).

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';

const BUDGET_MS = 5000;
const PROBE_MS = 4000;   // 개별 프로브 상한 — 전체 예산 안에서 병렬로 돈다

const warn = msg => process.stderr.write(`[env-detect] ${msg}\n`);

/**
 * ⚠️ 프로브는 **병렬**로 돈다. 순차 합산이면 CLI 3종의 cold start 만으로 5s 예산을 넘고,
 * 그 초과가 "부재"(false)로 기록돼 격하 라벨을 잘못 붙인다 — 실측으로 걸렸다:
 * 순차판 셀프테스트 elapsed=5011ms · cross_engine=false 인데 직후 warm 실행은 true.
 * fail-open 은 "막히면 core 로 간다"는 뜻이고, "느리면 없는 것으로 친다"는 뜻이 아니다.
 */

/** PATH 를 훑어 실행파일 존재만 확인 — spawn 0회(비용 ~0). 없으면 프로브 자체를 건다. */
function onPath(bin) {
  const paths = (process.env.PATH || '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  return paths.some(p => exts.some(ext => existsSync(join(p, bin + ext))));
}

/** 실행파일이 실제로 응답하는지. 부재·타임아웃·비정상 종료 전부 false. */
function respondsTo(bin, args = ['--version']) {
  if (!onPath(bin)) return Promise.resolve(false);   // 부재 = spawn 불요
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch (err) {
      warn(`${bin} spawn 실패 — ${err.message}`);
      return finish(false);
    }
    const timer = setTimeout(() => {
      warn(`${bin} 프로브 ${PROBE_MS}ms 초과 — 부재로 기록하지 않고 미확인 처리(false)`);
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(false);
    }, PROBE_MS);
    child.on('error', () => { clearTimeout(timer); finish(false); });
    child.on('close', code => { clearTimeout(timer); finish(code === 0); });
  });
}

/** 같은 바이너리를 두 번 재우지 않는다 (cross_engine 과 multi_agent_api 가 codex 를 공유). */
const probeCache = new Map();
function probe(bin, args) {
  const key = bin + ' ' + (args || []).join(' ');
  if (!probeCache.has(key)) probeCache.set(key, respondsTo(bin, args));
  return probeCache.get(key);
}

/** 교차 엔진: 상대 CLI 가 하나라도 응답하면 true (어느 엔진에서 돌든 "상대가 있다"가 조건). */
async function detectCrossEngine() {
  const [codex, claude] = await Promise.all([probe('codex'), probe('claude')]);
  return codex || claude;
}

/**
 * 내부 지식 조회 훅 — 설정으로 주입한다(하드코딩된 내부 경로 ❌ = 공개 안전 계약 §7).
 * SEARCHFLOW_KNOWLEDGE_HOOK 이 가리키는 실행파일/디렉터리가 실재할 때만 true.
 */
function detectKnowledgeHook() {
  const hook = process.env.SEARCHFLOW_KNOWLEDGE_HOOK;
  if (!hook) return false;
  if (!existsSync(hook)) {
    warn(`SEARCHFLOW_KNOWLEDGE_HOOK 이 가리키는 경로가 없음 — ${hook}`);
    return false;
  }
  return true;
}

/**
 * ooo(우로보로스) CLI 가용성 — **shell 측 대리 신호**다.
 * 모델에 ooo 도구가 노출됐는지는 리드만 알 수 있고, core 는 애초에 ooo 를 요구하지 않는다.
 */
function detectOoo() {
  return probe('ooo', ['--help']);
}

/**
 * multi-agent API 참고값.
 *  - codex 부재            → none
 *  - config 가 v2 활성 선언 → collab_v2 (enhanced)
 *  - 그 외 codex 존재      → public  (바닐라 기본 = multi_agent stable·ON)
 */
async function detectMultiAgentApi() {
  if (!(await probe('codex'))) return 'none';
  const cfg = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
  try {
    if (existsSync(cfg)) {
      const text = readFileSync(cfg, 'utf8');
      const block = text.match(/\[features\.multi_agent_v2\][^[]*/);
      if (block && /enabled\s*=\s*true/.test(block[0])) return 'collab_v2';
    }
  } catch (err) {
    warn(`config.toml 판독 실패 — ${err.message} (public 로 간주)`);
  }
  return 'public';
}

export async function detect() {
  const deadline = new Promise(r => setTimeout(() => r('deadline'), BUDGET_MS));
  const work = (async () => {
    // 전부 병렬 — 지연은 합산되지 않는다
    const [cross_engine, ooo, multi_agent_api] = await Promise.all([
      detectCrossEngine(), detectOoo(), detectMultiAgentApi(),
    ]);
    return { cross_engine, knowledge_hook: detectKnowledgeHook(), ooo, multi_agent_api };
  })();
  const raced = await Promise.race([work, deadline]);
  if (raced === 'deadline') {
    warn(`전체 예산 ${BUDGET_MS}ms 초과 — 미확인 상태로 core 진행(부재 단정 아님)`);
    return { cross_engine: false, knowledge_hook: detectKnowledgeHook(), ooo: false, multi_agent_api: 'none' };
  }
  return raced;
}

// ── 셀프테스트 ──────────────────────────────────────────────────────────────
// 이 환경의 값이 무엇이든, **계약 형태**가 지켜지는지만 본다.
// (값 자체를 단정하면 환경마다 실패하는 테스트가 된다.)
async function selfTest() {
  const results = [];
  const t0 = Date.now();
  let out;
  try {
    out = await detect();
  } catch (err) {
    console.log(`FAIL  detect() 예외 — ${err.message}`);
    return 1;
  }
  const elapsed = Date.now() - t0;

  const keys = ['cross_engine', 'knowledge_hook', 'ooo', 'multi_agent_api'];
  results.push({
    name: '키 집합이 계약과 정확히 일치 (추가·누락 0)',
    ok: JSON.stringify(Object.keys(out).sort()) === JSON.stringify([...keys].sort()),
    detail: `keys=${Object.keys(out).join(',')}`,
  });
  results.push({
    name: 'bool 3종이 실제 boolean',
    ok: ['cross_engine', 'knowledge_hook', 'ooo'].every(k => typeof out[k] === 'boolean'),
    detail: keys.slice(0, 3).map(k => `${k}=${out[k]}`).join(' '),
  });
  results.push({
    name: 'multi_agent_api 가 허용 enum 안',
    ok: ['public', 'collab_v2', 'none'].includes(out.multi_agent_api),
    detail: `multi_agent_api=${out.multi_agent_api}`,
  });
  results.push({
    name: `자체 timeout 예산 내 (${BUDGET_MS}ms)`,
    ok: elapsed <= BUDGET_MS,
    detail: `elapsed=${elapsed}ms`,
  });
  results.push({
    name: 'stdout 가 1줄 JSON 으로 파싱됨',
    ok: (() => { try { const s = JSON.stringify(out); return !s.includes('\n') && typeof JSON.parse(s) === 'object'; } catch { return false; } })(),
    detail: JSON.stringify(out),
  });
  // 음성 대조: 존재하지 않는 훅을 주입하면 false 여야 한다 (항상 true 인 탐지기 배제)
  const savedHook = process.env.SEARCHFLOW_KNOWLEDGE_HOOK;
  process.env.SEARCHFLOW_KNOWLEDGE_HOOK = join('/nonexistent-searchflow-hook', String(Date.now()));
  const negative = detectKnowledgeHook();
  if (savedHook === undefined) delete process.env.SEARCHFLOW_KNOWLEDGE_HOOK;
  else process.env.SEARCHFLOW_KNOWLEDGE_HOOK = savedHook;
  results.push({
    name: '음성 대조 — 없는 훅 경로 주입 시 false',
    ok: negative === false,
    detail: `negative=${negative} (true 면 탐지기가 항상 참을 반환하는 것)`,
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}`);
    if (!r.ok) failed += 1;
  }
  console.log(`\n${results.length - failed}/${results.length} PASS`);
  return failed === 0 ? 0 : 1;
}

if (process.argv.includes('--test')) {
  process.exit(await selfTest());
}

// 본 경로: 무슨 일이 있어도 1줄 JSON + exit 0
let payload;
try {
  payload = await detect();
} catch (err) {
  warn(`탐지 전면 실패 — core 로 진행 (${err.message})`);
  payload = { cross_engine: false, knowledge_hook: false, ooo: false, multi_agent_api: 'none' };
}
process.stdout.write(JSON.stringify(payload) + '\n');
process.exit(0);
