#!/usr/bin/env node
// mcp-server.mjs — SearchFlow 공정을 하네스 밖에서 쥐는 stdio MCP 서버 (P1)
//
// 계약:
//   transport : stdio · 줄 단위 JSON-RPC 2.0 (Content-Length 프레이밍 없음)
//   argv      : (없음) = 서버 기동  |  --test = 자체 테스트  |  --tools = 도구 목록 1줄 JSON
//   exit      : 서버 = 종료 시 0 · --test = 0 PASS / 1 FAIL · 계약 위반 = 2 (통과 취급 ❌)
//
// 왜 서버가 공정을 쥐는가 (47-doc §2):
//   채점 기준·통과선을 **조사 워커의 컨텍스트에 원천 미주입**하기 위해서다.
//   스킬 안에 두면 같은 컨텍스트에 있으니 워커가 읽고 거기 맞춰 쓴다.
//   ⚠️ "세상에 비밀" 이 아니다 — 이 파일은 공개된다. 막는 것은 *실행 중 참조*지 열람이 아니다
//      (우로보로스도 오픈소스인데 워커가 기준을 못 보는 것과 동형 — 47-doc §5 THREATS-1).
//
// 그래서 이 파일의 불변식 하나:
//   **`searchflow_gate` 응답에 점수·가중치·통과선을 담지 않는다.** 담는 순간 서버를 둔 이유가 사라진다.
//   `assertNoLeak()` 가 응답 직전에 기계로 막는다(사람 규율 ❌).
//
// 외부 패키지 0 (node: 내장만). 기존 동봉 스크립트 재사용 = 포장 교체(재작성 ❌).

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createInterface } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'searchflow', version: '1.0.0' };

const die = (code, msg) => { process.stderr.write(`[searchflow-mcp] ${msg}\n`); process.exit(code); };

// ── 서버 내부 상태 (워커 비가시) ──────────────────────────────────────────
// 이 블록이 스킬 파일로 새어나가면 은닉이 깨진다. 서버 안에서만 산다.
// 🔒 채점 기준은 **이 객체 하나**에만 산다. 흩어 두면 "기준을 바꿔도 결과 서술이 그대로인가"
//    (L3 기준 스왑 불변성)를 잴 때 스왑 자체가 신규 변수가 된다 — 무엇을 바꿨는지 모르게 된다.
//    바꿀 곳이 하나여야 스왑이 측정이 된다.
const DEFAULT_CRITERIA = {
  weights: { ORIGINAL: 1.0, A: 0.75, B: 0.45, C: 0.15, UNREACHABLE: 0 },
  threshold: 1.6,     // 프레임 통과선
  min_sources: 2,     // 프레임당 최소 유효 출처
  max_rounds: 2,      // 재조사 상한 (47-doc: 시한 1차·라운드 2차)
};

/** 스왑 훅 — 검증자가 기준을 통째로 갈아끼우는 **유일한** 입구(env: JSON 1개). */
function loadCriteria() {
  const raw = process.env.SEARCHFLOW_CRITERIA;
  if (!raw) return DEFAULT_CRITERIA;
  let c;
  try { c = JSON.parse(raw); }
  catch (e) { die(2, `SEARCHFLOW_CRITERIA 파싱 실패 — 기준을 못 읽으면 채점하지 않는다: ${e.message}`); }
  const merged = { ...DEFAULT_CRITERIA, ...c, weights: { ...DEFAULT_CRITERIA.weights, ...(c.weights || {}) } };
  for (const g of Object.keys(DEFAULT_CRITERIA.weights))
    if (typeof merged.weights[g] !== 'number') die(2, `기준 스왑 무효 — weights.${g} 가 수가 아니다`);
  if (typeof merged.threshold !== 'number') die(2, '기준 스왑 무효 — threshold 가 수가 아니다');
  return merged;
}

const CRITERIA = loadCriteria();

/**
 * 리터럴 층의 **건전성 전제**: 통과선이 소수일 것.
 *
 * 정수 통과선은 한국어 **세는 표현**으로 쓰면 리터럴 검사를 그냥 지나간다 — 실측:
 *   통과선 2 · 문안 `근거 2건 이상`·`자료 2개`·`출처 2곳`·`최대 2회` → 전부 미검출.
 * 수량사 제외 규칙(거짓 RED 방지)과 세는 값(정수)이 **같은 어휘를 두고 정면으로 겹치기** 때문이고,
 * 규칙을 조여 풀면 `3종` 거짓 RED 가 돌아온다. 어휘 층에서 닫히는 문제가 아니다.
 *
 * 그래서 막지 않고 **degraded 로 선언**한다 — 조용히 약해지는 것만 막는다(stdout 오염 ❌, stderr 만).
 */
if (Number.isInteger(CRITERIA.threshold)) {
  process.stderr.write(
    `[searchflow-mcp] ⚠️ 통과선이 정수(${CRITERIA.threshold}) — 리터럴 누출 검사가 약해진 상태로 돕니다.\n` +
    '  한국어 세는 표현("근거 2건 이상")으로 적힌 통과선은 검출되지 않습니다. 기준 스왑은 소수 값을 쓰십시오.\n');
}
const WEIGHTS = CRITERIA.weights;
const THRESHOLD = CRITERIA.threshold;
const MIN_SOURCES = CRITERIA.min_sources;
const MAX_ROUNDS = CRITERIA.max_rounds;

/** 응답에 새면 안 되는 것들. 값이 아니라 **이름**으로 막는다 — 값은 바뀌어도 이름은 남는다. */
const LEAK_KEYS = new Set([
  'score', 'scores', 'weight', 'weights', 'threshold', 'cutoff',
  'grade_weight', 'total', 'points', 'min_sources', 'max_rounds',
]);


// ── 세션 원장 ─────────────────────────────────────────────────────────────
// 저장소 안에 쓰지 않는다(공개 레포 오염 방지). env override > ~/.searchflow > tmp.
function stateDir() {
  const env = process.env.SEARCHFLOW_STATE_DIR;
  const base = env ? resolve(env) : join(homedir(), '.searchflow');
  // mode 0o700 — 원장에는 어떤 출처를 어떻게 판정했는지가 남는다. 같은 기계의 다른 프로세스가
  // 읽을 수 있으면 "안 보낸다"만 지킨 반쪽 격리다.
  try { mkdirSync(join(base, 'sessions'), { recursive: true, mode: 0o700 }); return join(base, 'sessions'); }
  catch { const t = join(tmpdir(), 'searchflow-sessions'); mkdirSync(t, { recursive: true, mode: 0o700 }); return t; }
}

const sessionPath = (id) => join(stateDir(), `${id}.jsonl`);

/** 매 도구 호출을 append — "검증했다"가 주장이 아니라 원장이 되게. */
function ledgerAppend(id, event) {
  appendFileSync(sessionPath(id), JSON.stringify(event) + '\n', 'utf8');
}

/**
 * ① 워커가 실제로 받은 것을 **verbatim** 으로 남긴다(요약 ❌).
 * 은닉을 나중에 검증하려면 "서버가 뭘 보냈다고 주장하는가"가 아니라
 * "실제로 나간 바이트가 무엇인가"가 있어야 한다. 요약해 두면 그 시점에 측정이 죽는다.
 */
function recordOutbound(id, tool, payload) {
  ledgerAppend(id, {
    event: 'outbound',
    tool,
    verbatim: JSON.stringify(payload),   // 문자열 그대로 — 재파싱 없이 원문 대조 가능
    bytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
  });
  return payload;
}

function ledgerRead(id) {
  const p = sessionPath(id);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// 결정적 세션 id — Date.now()/random 없이(재현 가능). 원장 파일명 충돌만 피하면 된다.
function sessionId(question, salt) {
  let h = 2166136261;
  for (const ch of `${question}::${salt}`) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return 'sf-' + (h >>> 0).toString(36);
}

// ── 공정 ──────────────────────────────────────────────────────────────────
const TYPES = {
  factcheck: ['원문 확정', '반증 탐색', '맥락·시점'],
  compare:   ['후보 집합', '축별 대조', '전제·한계'],
  market:    ['규모·추세', '주체·구조', '반론·불확실'],
  tech:      ['공식 규격', '실사용 보고', '한계·대안'],
  policy:    ['법령 원문', '집행 실태', '이해관계'],
  open:      ['현황', '쟁점', '전망'],
};

function routeType(q) {
  const s = String(q).toLowerCase();
  if (/사실|맞나|진짜|검증|fact|true|verify/.test(s)) return 'factcheck';
  if (/비교|vs|대비|차이|compare/.test(s)) return 'compare';
  if (/시장|규모|점유|market|시장성/.test(s)) return 'market';
  if (/어떻게|구현|스펙|api|버전|기술/.test(s)) return 'tech';
  if (/정책|법|규제|제도|policy/.test(s)) return 'policy';
  return 'open';
}

/** 서버 전용 채점. 이 함수의 반환값은 **절대 응답에 넣지 않는다**(gate 가 판정만 꺼낸다). */
function scoreFrame(sources) {
  const used = sources.filter((s) => s.status === 'used');
  const total = used.reduce((a, s) => a + (WEIGHTS[s.grade] ?? 0), 0);
  return { total, usable: used.length };
}

/**
 * 문자열에서 **독립한 수 토큰**만 뽑는다 — 앞뒤가 글자·밑줄·점이면 수로 세지 않는다.
 * 별도 함수인 이유: 이 경계 판정이 거짓 RED 의 진원지라 **고정 문자열로 직접 재기** 위해서다.
 */
export function numericTokens(txt) {
  // 규칙: **라틴 글자에 붙은 숫자만** 토큰(식별자·버전)으로 보고 수에서 뺀다.
  //
  // 여기까지 두 번 틀렸고, 방향이 서로 반대였다:
  //   ① `\w`(ASCII) 경계 → `3종` 을 수로 세어 **거짓 RED**
  //   ② `\p{L}`(글자 일반) 경계 → 한국어에서 거의 항상 발동해 **거짓 GREEN**.
  //      `통과선은 1.6이다`·`합계 2.`·`임계값1.6` 이 전부 미검출이었다 — 우리 응답 문안이
  //      전부 한국어라, 누가 여기에 통과선을 한 문장으로 적으면 그대로 통과했다.
  //   ⇒ 은닉 검사기에서 **부족(거짓 GREEN)이 과잉(거짓 RED)보다 아프다.** 그래서 한글 인접은
  //      수로 세고, 라틴 인접만 뺀다(`f1`·`P2`·`v1.6.0`·`ac6-compare` 는 식별자다).
  //
  // ⚠️ 알고 받는 대가: **정수 통과선 + 한글 수량사**는 거짓 RED 가 난다(threshold 3 · 문안 `3종`).
  //    이건 우리가 통제하는 조건이다 — 응답 문안에 맨숫자를 쓰지 않으면 안 난다(현재 0개).
  //    반대로 거짓 GREEN 은 *앞으로 누가 어떻게 쓰느냐*에 달려 통제 밖이다. 통제 가능한 쪽으로 위험을 옮긴다.
  //
  // 가중치 값은 여전히 대상 밖 — `1.0`·`0` 은 평범한 수와 구별되지 않아 상시 거짓 RED 가 된다.
  const s = String(txt);
  const out = [];
  for (const m of s.matchAll(/\d+(?:\.\d+)*/g)) {
    const before = s[m.index - 1] ?? '';
    const rest = s.slice(m.index + m[0].length);
    if (/[A-Za-z_]/.test(before) || /^[A-Za-z_]/.test(rest)) continue;  // 식별자·버전 (f1·P2·ac6)
    if (m[0].split('.').length > 2) continue;                            // 1.6.0 = 버전 문자열
    // 정수 + **한글 수량사**만 뺀다 — `3종`·`2개` 는 세는 말이지 통과선이 아니다.
    // 조사(`2이다`)는 여기 안 걸리므로 그대로 검출된다 ← 이게 위 ②를 닫는 지점.
    if (Number.isInteger(Number(m[0])) && KO_COUNTER.test(rest)) continue;
    out.push(Number(m[0]));
  }
  return out;
}

/**
 * 한글 수량사(세는 말) — 정수 바로 뒤에 붙었을 때만 "수가 아니라 수량 표현"으로 본다.
 * ⚠️ 이 목록은 완전하지 않다. 빠진 수량사는 **검출 쪽으로** 떨어진다(거짓 RED) — 안전한 방향이다.
 *    반대로 여기에 조사·서술어를 넣으면 거짓 GREEN 이 되므로 넣지 말 것.
 */
const KO_COUNTER = /^(종|개|명|곳|건|회|차|장|번|가지|부|줄|배|쪽|권|판|기)/;

/** 응답 직전 기계 검사 — 은닉 규율을 사람 기억에 맡기지 않는다. */
function assertNoLeak(payload) {
  const seen = [];
  (function walk(v) {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (LEAK_KEYS.has(k.toLowerCase())) seen.push(k);
        walk(val);
      }
    }
  })(payload);
  const txt = JSON.stringify(payload);
  // 통과선 리터럴이 문자열로 새는 경우까지(예: "1.6 넘었습니다").
  //
  // ⚠️ 부분일치로 재면 **정수 통과선에서 거짓 RED** 가 난다 — 실측으로 걸렸다:
  //    threshold 2 → 문안 "P2 제공 예정" 의 `2` / threshold 1 → `"frame_id":"f1"` 의 `1`.
  //    정수는 L3 기준 스왑에 가장 자연스러운 값이라, 이대로 두면 스왑 회차에서
  //    **게이트가 죽은 것을 "은닉 위반 검출" 로 오독**하게 된다. 거짓 RED 는 거짓 GREEN 만큼 나쁘다.
  //    그래서 수 토큰 경계로 끊어 **수로 비교**한다(`P2`·`f1` 은 앞이 글자라 수 토큰이 아니다).
  //
  // 가중치 값은 여기서 재지 않는다 — `1.0`·`0` 은 문안의 평범한 수와 구별되지 않아
  // 넣는 순간 이 검사기가 상시 거짓 RED 가 된다(= 무시되는 검사기 = 죽은 검사기).
  // 그 축은 키 이름(`LEAK_KEYS`)과 별도 은닉 e2e 가 담당한다.
  if (numericTokens(txt).some((n) => n === THRESHOLD)) seen.push(`literal:${THRESHOLD}`);
  if (seen.length) {
    throw new Error(`은닉 위반 — 응답에 채점 내부값이 실렸다: ${seen.join(',')}`);
  }
  return payload;
}

// ── 도구 ──────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'searchflow_start',
    description: 'Start a SearchFlow research session. Routes the question to a research type and returns the investigation frames to fan out. Call this before any searching.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to research or claim to verify' },
        salt: { type: 'string', description: 'Optional disambiguator when starting two sessions on the same question' },
      },
      required: ['question'],
    },
  },
  {
    name: 'searchflow_submit',
    description: 'Submit one frame\'s collected sources. Provide every source you looked at, including ones you discarded, with its grade and status. Returns an acknowledgement only — no scoring.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        frame_id: { type: 'string' },
        sources: {
          type: 'array',
          description: 'Source records. grade = ORIGINAL|A|B|C|UNREACHABLE (what the URL IS relative to the claim). status = used|discarded|unreachable (what you DID with it).',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              claim: { type: 'string' },
              grade: { type: 'string', enum: ['ORIGINAL', 'A', 'B', 'C', 'UNREACHABLE'] },
              status: { type: 'string', enum: ['used', 'discarded', 'unreachable'] },
              grade_basis: { type: 'string' },
              discard_reason: { type: 'string' },
              unreachable_reason: { type: 'string', enum: ['blocked', 'not-traced'] },
            },
            required: ['url', 'grade', 'status'],
          },
        },
      },
      required: ['session_id', 'frame_id', 'sources'],
    },
  },
  {
    name: 'searchflow_gate',
    description: 'Ask the server whether the evidence is sufficient. Returns either "done" or which single frame to re-investigate and why. Deliberately returns no scores, weights, or thresholds.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
  },
];

function toolStart(args) {
  const q = String(args.question || '').trim();
  if (!q) throw new Error('question 이 비어 있다');
  const type = routeType(q);
  const frames = TYPES[type].map((label, i) => ({ frame_id: `f${i + 1}`, focus: label }));
  const id = sessionId(q, args.salt || '');
  writeFileSync(sessionPath(id), '', 'utf8');
  ledgerAppend(id, { event: 'start', schema_version: '1', session_id: id, question: q, type, frames });
  return recordOutbound(id, 'searchflow_start', {
    session_id: id,
    research_type: type,
    frames,
    instructions:
      `이 ${frames.length}개 프레임을 각각 조사한다. 프레임마다 본 출처를 **버린 것까지 전부** ` +
      `searchflow_submit 으로 제출한다(grade = 그 URL 이 주장에 대해 무엇인가 · status = 그걸로 무엇을 했나). ` +
      `제출이 끝나면 searchflow_gate 를 호출한다 — 충분한지는 서버가 판정한다. ` +
      `깊이를 스스로 정하지 말 것.`,
  });
}

function toolSubmit(args) {
  const { session_id, frame_id, sources } = args;
  const led = ledgerRead(session_id);
  if (!led) throw new Error(`세션 없음: ${session_id}`);
  if (!Array.isArray(sources)) throw new Error('sources 는 배열이어야 한다');
  for (const s of sources) {
    if (!WEIGHTS.hasOwnProperty(s.grade)) throw new Error(`grade enum 위반: ${s.grade}`);
    if (!['used', 'discarded', 'unreachable'].includes(s.status)) throw new Error(`status enum 위반: ${s.status}`);
    // 축 분리 강제 — 21-doc §2-5 와 동일 계약
    if (s.grade === 'UNREACHABLE' && !s.unreachable_reason)
      throw new Error('grade=UNREACHABLE 이면 unreachable_reason(blocked|not-traced) 필수');
    if (s.grade !== 'UNREACHABLE' && s.unreachable_reason)
      throw new Error('unreachable_reason 은 grade=UNREACHABLE 에만 허용');
    if (s.status === 'discarded' && !s.discard_reason)
      throw new Error('status=discarded 면 discard_reason 필수');
  }
  // 둘 다 남긴다: `sources` = 게이트가 읽는 구조 · `sources_verbatim` = 감사용 원문(①).
  // verbatim 만 남기면 소비자가 깨지고, 구조만 남기면 "실제로 뭐가 왔나"를 나중에 못 잰다.
  ledgerAppend(session_id, {
    event: 'submit', frame_id, sources,
    sources_verbatim: JSON.stringify(sources),
    inbound_bytes: Buffer.byteLength(JSON.stringify(sources), 'utf8'),
  });
  return recordOutbound(session_id, 'searchflow_submit', { accepted: sources.length, frame_id, next: '남은 프레임을 제출하거나, 다 냈으면 searchflow_gate 를 호출한다.' });
}

/**
 * 판정 1건을 내보내고, **나간 뒤에** 원장에 적는다.
 *
 * 순서가 반대면 원장이 사실과 어긋난다 — 실측으로 걸렸다: 누출 검사가 던지는 경로에서
 * `gate` 는 적혔는데 `outbound` 가 없고 실패 기록도 없었다. 원장만 재생하면
 * **"판정했고 전달됐다"** 로 읽히는데 워커는 그 판정을 받은 적이 없다.
 * "주장이 아니라 원장" 이 이 설계의 근거인 이상, 원장은 **실패도 적어야 한다**.
 *
 * ⚠️ 여기서 보증하는 것은 "검사 통과 후 직렬화까지" 지 클라이언트 수신이 아니다(그건 전송 계층 몫).
 */
function emitGate(session_id, ledgerEvent, out) {
  let payload;
  try {
    payload = assertNoLeak(out);
  } catch (err) {
    ledgerAppend(session_id, { event: 'gate_error', reason: err.message, withheld: ledgerEvent });
    throw err;
  }
  const sent = recordOutbound(session_id, 'searchflow_gate', payload);
  ledgerAppend(session_id, ledgerEvent);
  return sent;
}

function toolGate(args) {
  const { session_id } = args;
  const led = ledgerRead(session_id);
  if (!led) throw new Error(`세션 없음: ${session_id}`);
  const start = led.find((e) => e.event === 'start');
  const rounds = led.filter((e) => e.event === 'gate').length;

  const byFrame = new Map(start.frames.map((f) => [f.frame_id, []]));
  for (const e of led) {
    if (e.event !== 'submit') continue;
    if (!byFrame.has(e.frame_id)) byFrame.set(e.frame_id, []);
    byFrame.get(e.frame_id).push(...e.sources);
  }

  const missing = [...byFrame.entries()].filter(([, v]) => v.length === 0).map(([k]) => k);
  if (missing.length) {
    const out = { decision: 'incomplete', awaiting_frames: missing,
      guidance: '아직 제출되지 않은 프레임이 있다. 먼저 제출한다.' };
    return emitGate(session_id, { event: 'gate', decision: out.decision, awaiting: missing }, out);
  }

  // 판정은 서버 안에서. 밖으로는 결론만.
  const judged = [...byFrame.entries()].map(([fid, srcs]) => ({ fid, ...scoreFrame(srcs) }));
  const weak = judged.filter((j) => j.total < THRESHOLD || j.usable < MIN_SOURCES)
                     .sort((a, b) => a.total - b.total);

  if (weak.length === 0) {
    const out = { decision: 'done',
      guidance: '근거가 충분하다. searchflow_report 로 보고서를 구성한다(P2 제공 예정 — 현재는 원장을 근거로 직접 작성).' };
    return emitGate(session_id, { event: 'gate', decision: 'done', rounds: rounds + 1 }, out);
  }

  if (rounds + 1 >= MAX_ROUNDS) {
    const out = { decision: 'done_with_gaps',
      weak_frames: weak.map((w) => w.fid),
      guidance: '재조사 상한에 도달했다. 부족한 프레임을 보고서에 **한계로 명시**하고 마무리한다 — 조용히 넘기지 말 것.' };
    return emitGate(session_id, { event: 'gate', decision: out.decision, rounds: rounds + 1, weak: out.weak_frames }, out);
  }

  const target = weak[0];
  const reason = target.usable < MIN_SOURCES
    ? '이 프레임은 쓸 수 있는 출처가 너무 적다 — 서로 독립된 출처를 더 찾는다.'
    : '이 프레임은 근거가 원본에서 멀다 — 인용된 원문·1차 자료를 직접 열어 등급을 올린다.';
  const out = { decision: 'reinvestigate', frame_id: target.fid, guidance: reason,
    note: '가장 약한 프레임 하나만 다시 본다. 나머지는 그대로 둔다.' };
  return emitGate(session_id, { event: 'gate', decision: 'reinvestigate', frame_id: target.fid, rounds: rounds + 1 }, out);
}

const DISPATCH = { searchflow_start: toolStart, searchflow_submit: toolSubmit, searchflow_gate: toolGate };

// ── JSON-RPC ──────────────────────────────────────────────────────────────
function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    case 'notifications/initialized':
      return null;                                   // 통지 = 응답 없음
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const fn = DISPATCH[params?.name];
      if (!fn) return fail(-32602, `알 수 없는 도구: ${params?.name}`);
      try {
        const out = fn(params.arguments || {});
        return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
      } catch (e) {
        // 도구 실패는 프로토콜 오류가 아니라 **결과**로 돌려준다(모델이 고쳐 재시도할 수 있게).
        return reply({ isError: true, content: [{ type: 'text', text: `오류: ${e.message}` }] });
      }
    }
    case 'ping':
      return reply({});
    default:
      return fail(-32601, `지원하지 않는 메서드: ${method}`);
  }
}

function serve() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); }
    catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 파싱 실패' } }) + '\n'); return; }
    const res = handle(msg);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  });
  rl.on('close', () => process.exit(0));
}

// ── 자체 테스트 ───────────────────────────────────────────────────────────
function selfTest() {
  const results = [];
  const ok = (name, cond, detail = '') => results.push({ name, ok: !!cond, detail });
  const S = (q) => toolStart({ question: q, salt: 't' });

  // 1 초기화 핸드셰이크
  const init = handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  ok('initialize 가 protocolVersion·serverInfo 반환', init.result?.protocolVersion === PROTOCOL_VERSION && init.result?.serverInfo?.name === 'searchflow');

  // 2 통지는 응답 없음
  ok('notifications/initialized = 응답 없음', handle({ jsonrpc: '2.0', method: 'notifications/initialized' }) === null);

  // 3 도구 3종 노출 + 스키마 필수 필드
  const list = handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).result.tools;
  ok('tools/list 3종', list.length === 3 && list.every((t) => t.name && t.description && t.inputSchema), `${list.length}종`);

  // 4 유형 라우팅
  ok('유형 라우팅', routeType('이 주장이 사실인가') === 'factcheck' && routeType('A와 B 비교') === 'compare');

  // 5 start 가 세션·프레임 생성
  const s1 = S('이 주장이 사실인가');
  ok('start = 세션+프레임 생성', s1.session_id?.startsWith('sf-') && s1.frames.length === 3, s1.session_id);

  // 6 enum 위반은 거부 (음성 대조)
  let rejected = false;
  try { toolSubmit({ session_id: s1.session_id, frame_id: 'f1', sources: [{ url: 'u', grade: 'D', status: 'used' }] }); }
  catch { rejected = true; }
  ok('구 체계 grade=D 거부', rejected);

  // 7 축 분리 강제
  let axisRejected = false;
  try { toolSubmit({ session_id: s1.session_id, frame_id: 'f1', sources: [{ url: 'u', grade: 'UNREACHABLE', status: 'unreachable' }] }); }
  catch { axisRejected = true; }
  ok('UNREACHABLE 에 unreachable_reason 강제', axisRejected);

  // 8 미제출 프레임이 있으면 incomplete
  toolSubmit({ session_id: s1.session_id, frame_id: 'f1',
    sources: [{ url: 'a', grade: 'ORIGINAL', status: 'used' }, { url: 'b', grade: 'A', status: 'used' }] });
  const g1 = toolGate({ session_id: s1.session_id });
  ok('일부만 제출 = incomplete', g1.decision === 'incomplete' && g1.awaiting_frames.length === 2);

  // 9 약한 근거 = reinvestigate (프레임 하나만 지목)
  const s2 = S('약한 근거 세션');
  for (const f of ['f1', 'f2', 'f3']) {
    toolSubmit({ session_id: s2.session_id, frame_id: f,
      sources: [{ url: 'x', grade: 'C', status: 'used' }, { url: 'y', grade: 'C', status: 'used' }] });
  }
  const g2 = toolGate({ session_id: s2.session_id });
  ok('약한 근거 = reinvestigate 1개 프레임', g2.decision === 'reinvestigate' && !!g2.frame_id, g2.frame_id);

  // 10 강한 근거 = done
  const s3 = S('강한 근거 세션');
  for (const f of ['f1', 'f2', 'f3']) {
    toolSubmit({ session_id: s3.session_id, frame_id: f,
      sources: [{ url: 'x', grade: 'ORIGINAL', status: 'used' }, { url: 'y', grade: 'ORIGINAL', status: 'used' }] });
  }
  const g3 = toolGate({ session_id: s3.session_id });
  ok('강한 근거 = done', g3.decision === 'done');

  // 11 🔴 은닉 — gate 응답 어디에도 점수·통과선이 없다
  const all = JSON.stringify([g1, g2, g3]);
  const leaked = ['1.6', 'threshold', 'score', 'weight', '0.75', '0.45']
    .filter((t) => all.toLowerCase().includes(t.toLowerCase()));
  ok('gate 응답에 채점 내부값 0', leaked.length === 0, leaked.length ? `누출: ${leaked.join(',')}` : '깨끗');

  // 12 🔴 양성 대조 — 누출 검사기가 실제로 잡는가(안 잡으면 11번의 0 은 미측정이다)
  let caught = false;
  try { assertNoLeak({ decision: 'done', score: 9 }); } catch { caught = true; }
  let caughtLiteral = false;
  try { assertNoLeak({ decision: 'done', note: `통과선 ${THRESHOLD} 초과` }); } catch { caughtLiteral = true; }
  ok('누출 검사기 양성 대조(키·리터럴 둘 다)', caught && caughtLiteral);

  // 12b 🔴 음성 대조 — 정수 통과선에서 **무고한 문자열**을 잡지 않는가 (거짓 RED 회귀)
  //     외부 재검에서 걸린 실제 두 케이스를 고정 문자열로 박는다: `P2 제공 예정` · `"frame_id":"f1"`.
  //     양성(위 12)만 있고 이 음성이 없으면 "잡는다"만 재고 "안 잡아야 할 것"은 미측정이다.
  const negCases = [
    ['P2 제공 예정', 2, '문안 안의 P2'],
    ['{"frame_id":"f1"}', 1, '식별자 f1'],
    ['도구 3종', 3, '수량사 3종'],
    ['v1.6.0 배포', 1.6, '버전 v1.6.0'],
    ['ac6-compare', 6, '파일명 ac6'],
  ];
  const negBad = negCases.filter(([txt, n]) => numericTokens(txt).includes(n)).map(([, , why]) => why);

  // 🔴 한국어 문장형 양성 — 여기가 비어 있으면 검사기는 **한국어에서 아무것도 못 잡는다**.
  //    우리 응답 문안(guidance·note)이 전부 한국어라 이 축이 실사용 축이다.
  const posCases = [
    ['통과선은 1.6이다', 1.6, '조사 직결'],
    ['합계 2.', 2, '문장 끝 마침표'],
    ['통과선은 1.6.', 1.6, '소수 + 마침표'],
    ['임계값1.6', 1.6, '앞이 한글'],
    ['통과선은 2이다', 2, '정수 + 조사'],
    ['통과선 1.6 초과', 1.6, '띄어쓴 소수'],
    ['{"rounds":2}', 2, 'JSON 맨숫자'],
    ['출처 3 곳', 3, '띄어쓴 정수'],
    // 수량사 제외는 **정수에만** 건다 — 소수는 수량 표현이 아니므로 그대로 검출돼야 한다.
    // (`2개` 는 빼고 `2.4개` 는 잡는다 = 제외 규칙이 값의 꼴로 좁혀져 있다는 증명)
    ['2.4개', 2.4, '소수 + 수량사'],
    ['통과선 2.4건', 2.4, '소수 + 수량사(문장)'],
  ];
  const posBad = posCases.filter(([txt, n]) => !numericTokens(txt).includes(n)).map(([, , why]) => why);
  // 갯수는 fixture 에서 뽑는다 — 이름에 손으로 적으면 케이스를 늘린 순간 그 숫자가 거짓말이 된다.
  ok(`수 토큰 — 한국어 양성 ${posCases.length}건 검출 + 식별자·수량사 음성 ${negCases.length}건 미검출`,
     negBad.length === 0 && posBad.length === 0,
     [negBad.length ? `거짓 RED: ${negBad.join(',')}` : null,
      posBad.length ? `거짓 GREEN: ${posBad.join(',')}` : null,
     ].filter(Boolean).join(' / ') || `양성 ${posCases.length} · 음성 ${negCases.length} 전건 통과`);

  // 12c 🔴 원장이 **전달 실패를 적는가** (원장≠사실 회귀)
  //     누출로 막힌 판정이 원장에 `gate` 로 남으면, 재생 시 "판정했고 전달됐다"로 읽힌다 —
  //     워커는 받은 적이 없는데. 실패 경로에서 gate 0 · gate_error 1 · outbound 0 이어야 한다.
  const sErr = S('원장 실패기록 세션');
  const beforeLen = ledgerRead(sErr.session_id).length;
  let threw = false;
  try { emitGate(sErr.session_id, { event: 'gate', decision: 'done' }, { decision: 'done', score: 9 }); }
  catch { threw = true; }
  const tail = ledgerRead(sErr.session_id).slice(beforeLen);
  const cnt = (ev) => tail.filter((e) => e.event === ev).length;
  ok('누출로 막힌 판정 = gate_error 만 남고 gate·outbound 0',
     threw && cnt('gate_error') === 1 && cnt('gate') === 0 && cnt('outbound') === 0,
     `throw=${threw} gate_error=${cnt('gate_error')} gate=${cnt('gate')} outbound=${cnt('outbound')}`);

  // 13 원장이 실제로 쌓였는가
  const led = ledgerRead(s3.session_id);
  ok('세션 원장 append', led.length >= 5 && led[0].event === 'start', `${led.length}줄`);

  // 14 라운드 상한
  const s4 = S('상한 세션');
  for (const f of ['f1', 'f2', 'f3']) {
    toolSubmit({ session_id: s4.session_id, frame_id: f, sources: [{ url: 'x', grade: 'C', status: 'used' }, { url: 'y', grade: 'C', status: 'used' }] });
  }
  toolGate({ session_id: s4.session_id });
  const g5 = toolGate({ session_id: s4.session_id });
  ok('재조사 상한 = done_with_gaps(한계 명시 요구)', g5.decision === 'done_with_gaps' && g5.weak_frames.length > 0);

  // 15 알 수 없는 도구 = JSON-RPC 오류
  ok('알 수 없는 도구 = -32602',
    handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nope' } }).error?.code === -32602);

  // 16 도구 실패는 result.isError 로 (프로토콜 오류 ❌)
  const bad = handle({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'searchflow_gate', arguments: { session_id: 'nope' } } });
  ok('도구 실패 = isError 결과', bad.result?.isError === true && !bad.error);

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed += 1;
    process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n      ${r.detail}` : ''}\n`);
  }
  process.stdout.write(`\n${results.length - failed}/${results.length} PASS\n`);
  process.stdout.write('참고: 실제 하네스 등록·왕복(2모드 e2e)은 이 --test 에 없다 — P3 소관.\n');
  // 알려진 한계는 통과 화면에도 띄운다 — 주석에만 두면 "18/18" 만 읽고 닫힌 줄 안다.
  // 알려진 한계는 통과 화면에 **실측과 함께** 띄운다. 목록만 적으면 다음 사람이 다시 잰다.
  const gap = ['근거 2건 이상 필요', '자료 2개 이상', '출처 2곳 이상', '최대 2회까지']
    .map((t) => `${t} → ${JSON.stringify(numericTokens(t))}`);
  process.stdout.write(
    '알려진 한계 (리터럴 누출 검사):\n' +
    `  1. 한글 수량사 목록은 **열린 집합**이다(현재 ${KO_COUNTER.source.split('|').length}종). 미등재 수량사 + 같은 값의 정수\n` +
    '     통과선 = 거짓 RED("3켤레"). 검출 쪽이라 안전한 방향. 목록에 조사·서술어를 넣으면 거짓 GREEN 이 되므로 넣지 말 것.\n' +
    '  2. 🔴 **건전성 전제 = 통과선이 소수일 것.** 정수 통과선은 한국어 세는 표현으로 우회된다:\n' +
    gap.map((g) => `       ${g}`).join('\n') + '\n' +
    '     수량사 제외(거짓 RED 방지)와 세는 값이 같은 어휘를 두고 겹쳐서 생기는 것이라 어휘 층에서 안 닫힌다.\n' +
    '     ⇒ 기준 스왑 값은 소수로. 그리고 **세는 기준(min_sources·max_rounds)은 이 층에 넣지 말 것** —\n' +
    '        넣는 순간 수량사 제외가 그 검출을 통째로 무력화한다. 그 축은 키 이름 검사 + 의미 층 소관.\n' +
    '  3. 띄어쓰기가 판정을 바꾼다: `출처 3 곳` 검출 / `출처 3곳` 미검출. 문안을 고치면 검출 여부도 바뀐다.\n');
  return failed === 0 ? 0 : 1;
}

// ── 진입점 ────────────────────────────────────────────────────────────────
if (process.argv.includes('--test')) {
  // 자체 테스트는 **기본 기준**에 맞춰 쓰였다. 기준이 스왑된 채로 돌리면 통과선이 달라져
  // 멀쩡한 서버가 FAIL 로 보인다 — 거짓 RED 는 거짓 GREEN 만큼 나쁘다.
  // L3(기준 스왑 불변성)은 --test 가 아니라 gate 응답을 두 기준으로 비교해서 잰다.
  if (process.env.SEARCHFLOW_CRITERIA) {
    die(2, '기준이 스왑된 상태(SEARCHFLOW_CRITERIA)에서는 --test 를 돌리지 않는다 — ' +
           '이 테스트는 기본 기준 기준으로 쓰여서 결과가 무의미하다. ' +
           'L3 스왑 비교는 gate 응답을 두 기준으로 대조해서 잰다.');
  }
  process.exit(selfTest());
}
if (process.argv.includes('--tools')) {
  process.stdout.write(JSON.stringify({ tools: TOOLS.map((t) => t.name) }) + '\n');
  process.exit(0);
}

/**
 * ②③ 공개 표면 감사 — 검증자가 서버 **밖에서** 은닉을 재기 위한 입구.
 *   ② tools/list 스키마 스냅샷: 서버가 안 보내도 **하네스가 컨텍스트에 싣는** 표면이다.
 *      도구 설명·스키마는 워커가 항상 본다 — 여기에 기준이 새면 서버 은닉은 무의미하다.
 *   ③ 원장·기준의 경로와 권한: 격리는 "안 보낸다" + "못 읽는다" 두 개다.
 *      경로를 안 적어두면 나중에 "워커가 원장을 읽을 수 있었나"를 되물을 수 없다.
 */
if (process.argv.includes('--audit')) {
  const dir = stateDir();
  let mode = null, ownerOnly = null;
  try {
    const { statSync } = await import('node:fs');
    mode = (statSync(dir).mode & 0o777).toString(8);
    ownerOnly = !(statSync(dir).mode & 0o077);
  } catch { /* 못 읽으면 null — 모른다를 0 으로 적지 않는다 */ }

  // 워커가 볼 수 있는 정적 문자열 전부(도구 스키마 + 지시문 상수)
  const workerVisible = JSON.stringify(TOOLS) +
    Object.values(TYPES).flat().join(' ');

  // 두 부류를 갈라 센다 — 섞으면 정상 노출이 위반을 가려서 이 검사기가 무시당한다.
  //   어휘: 워커가 등급을 *붙이려면* 알아야 한다(노출 정상). 값: 새면 워커가 맞춰 쓴다(위반).
  const vocabulary = [...Object.keys(DEFAULT_CRITERIA.weights)]
    .filter((t) => workerVisible.includes(t));
  const valueLeaks = [
    String(DEFAULT_CRITERIA.threshold),
    ...Object.values(DEFAULT_CRITERIA.weights).map(String).filter((v) => v !== '0' && v !== '1'),
  ].filter((v) => workerVisible.includes(v));
  // 「기준이 존재한다」는 언급(부정문 포함)은 값이 아니다 — 따로 센다.
  const mentions = ['threshold', 'weight', 'score', 'cutoff', '통과선', '가중치', '점수']
    .filter((t) => workerVisible.toLowerCase().includes(t.toLowerCase()));

  process.stdout.write(JSON.stringify({
    schema_version: '1',
    proof_class: 'deterministic',
    server: SERVER_INFO,
    protocol_version: PROTOCOL_VERSION,
    tools_schema: TOOLS,                       // ② 스냅샷 (해시 아닌 전문 — 나중에 diff 가능)
    tools_schema_bytes: Buffer.byteLength(JSON.stringify(TOOLS), 'utf8'),
    state: {                                   // ③ 경로·권한
      ledger_dir: dir,
      ledger_dir_mode: mode,
      ledger_owner_only: ownerOnly,
      criteria_source: process.env.SEARCHFLOW_CRITERIA ? 'env:SEARCHFLOW_CRITERIA' : 'built-in default',
      criteria_in_repo_file: false,            // 기준은 파일이 아니라 서버 상수 — 워커 경로에 없음
    },
    disclosure: {
      // ⚠️ 이 값이 0 이 아니면 스키마 표면으로 기준이 새는 것이다(서버 은닉과 별개 층).
      grade_vocabulary_exposed: vocabulary,
      criteria_values_leaked: valueLeaks,
      criteria_mentioned_without_value: mentions,
      verdict: valueLeaks.length === 0 ? 'PASS — 값 유출 0' : 'FAIL — 기준 값이 스키마 표면에 있다',
      note: 'grade_vocabulary_exposed 는 정상이다(워커가 등급을 붙이려면 알아야 한다). ' +
            'criteria_mentioned_without_value 도 대개 정상 — 도구 설명이 "점수는 안 준다"고 *부정*하는 문장이라 ' +
            '기준의 존재는 알리되 값은 안 준다. 판정 대상은 criteria_values_leaked 하나다.',
    },
  }, null, 2) + '\n');
  process.exit(0);
}
serve();
