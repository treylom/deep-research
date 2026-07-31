#!/usr/bin/env node
// robots-gate.mjs — 취득 전 robots.txt 판정 (차단 존중을 규율에서 게이트로)
//
// 계약:
//   argv   : <target-url> [...]  |  --test
//   stdout : URL 당 JSON 1줄 {url, decision, rule, robots_status, ledger}
//   exit   : 0=전건 allowed · 1=1건 이상 blocked(정상 결과다, 오류 아님) · 2=스크립트 오류
//
// 왜 게이트인가: `acquisition.md` §2 는 "우회하지 않는다"를 **글로** 적어뒀다. 글은
//   조사 중에 안 읽힌다. 여기서 판정을 내려 **blocked 면 원장 라인을 만들어 준다** —
//   막힌 것을 기록하는 쪽이 무시하는 쪽보다 싸지게 만드는 것이 설계 의도다.
//   exit 1 은 "실패"가 아니라 "막혔다는 결과"다. 재시도·우회 신호로 읽지 말 것.
//
// 🔴 `*` 그룹만 보면 안 된다 — 실측으로 걸린 설계 결함:
//   어떤 발행처는 `User-agent: *` 는 허용하면서 **AI 엔진 계열 이름에만 `Disallow: /`** 를 건다
//   (2026-07-31 실측: 한 대형 언론사 robots.txt 가 `*` 는 열어두고 `anthropic-ai`·`ClaudeBot`·
//    `Claude-SearchBot`·`Claude-User`·`Claude-Web`·`GPTBot` 등에 전면 불허). `*` 만 보는 게이트는
//   거기서 allowed 를 낸다 — 발행처가 우리 계열에 대고 하지 말라고 적어둔 것을 무시하는 것,
//   즉 이 게이트가 막으려던 우회 그 자체다.
//
// 그래서 판정 = **적용 가능한 그룹 전체 중 가장 엄한 것**(strictest-of-applicable).
//   RFC 9309 의 최소 요구(가장 구체적인 그룹 하나만 적용)보다 엄하다. 그 대가를 명시한다:
//     · 과다 차단 시 손실 = 원장에 UNREACHABLE 한 줄(보이고, 되돌릴 수 있다)
//     · 과소 차단 시 손실 = 발행처가 금지한 취득의 실행(안 보이고, 되돌릴 수 없다)
//   비대칭이므로 엄한 쪽을 기본값으로 둔다. `--ua-only <name>` 로 RFC 최소 동작으로 내릴 수 있다.
//   ⚠️ 이 하네스의 취득 도구가 실제로 어떤 User-Agent 문자열을 보내는지는 **미측정**이다 —
//      그래서 특정 이름을 "우리다"라고 주장하지 않고, 계열 후보 전체를 적용 대상으로 본다.
//
// RFC 9309 중 지키는 부분:
//   · 연속된 `User-agent:` 줄은 **하나의 그룹**이다 (실측 버그였다 — 두 번째 줄이 그룹을 무효화했다)
//   · Allow/Disallow 는 **가장 긴 매치 우선**, 길이가 같으면 Allow 우선
//   · `*` 와일드카드 · `$` 끝 고정 지원
//   · robots.txt 가 **4xx = 전면 허용** / **5xx = 전면 불허** (RFC 9309 §2.3.1.3~4)
//
// 지키지 않는(=하지 않는) 부분 — 이걸 안 적으면 판정을 과대 인용하게 된다:
//   · Crawl-delay · Sitemap · robots.txt 리다이렉트 추적
//   · **ToS·로그인·페이월·CAPTCHA 는 robots.txt 에 없다 → 이 스크립트로 판정 불가.**
//     실측 사례: 같은 파일 **주석**에 "자동 수집·LLM 개발 목적 이용 금지"가 적혀 있었다. 주석은
//     기계 판정 대상이 아니다 → `tos_notice` 로 **표시만** 하고, 판단은 리드가 한다(§2 그대로).
//
// 외부 패키지 0 (node: 내장만).

import { get } from 'node:https';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCHEMA_VERSION = '1';
const UA = 'SearchFlow/1.0 (research acquisition ladder; respects robots.txt)';
const TIMEOUT_MS = 12000;

/**
 * 우리 계열로 적용해야 할 User-agent 후보. `*` 는 항상 포함된다.
 * ⚠️ 이 목록은 **판정 대상 선정용**이며 "우리가 이 이름으로 요청한다"는 주장이 아니다.
 *    실제 전송 UA 문자열은 미측정 — 그래서 계열 전체를 적용 대상으로 잡는다(엄한 쪽).
 */
export const SELF_AGENTS = ['*', 'anthropic-ai', 'claudebot', 'claude-searchbot', 'claude-user', 'claude-web'];

/** ToS 성격 금지 문구를 주석에서 감지 — 판정이 아니라 리드에게 보내는 표시다. */
const TOS_HINT = /(prohibit|not permitted|without prior written|data min|scrap|machine learning|large language model|LLM)/i;

/**
 * robots.txt 본문 → 그룹 목록 [{agents:[…소문자], rules:[{type,path}]}].
 * 연속된 `User-agent:` 줄은 하나의 그룹이다(RFC 9309) — 이걸 틀렸던 게 실측 버그였다.
 */
export function parseRobots(text) {
  const groups = [];
  let cur = null, lastWasRule = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase(), value = m[2].trim();
    if (field === 'user-agent') {
      if (!cur || lastWasRule) { cur = { agents: [], rules: [] }; groups.push(cur); lastWasRule = false; }
      cur.agents.push(value.toLowerCase());
      continue;
    }
    if (field === 'disallow' || field === 'allow') {
      if (!cur) continue;
      lastWasRule = true;
      // `Disallow:` (빈 값) = 아무것도 막지 않음 → 규칙으로 세지 않는다.
      if (field === 'disallow' && value === '') continue;
      cur.rules.push({ type: field, path: value });
    }
  }
  return groups;
}

/** 우리에게 적용되는 그룹만 남긴다. */
export function applicableGroups(groups, selfAgents = SELF_AGENTS) {
  const want = new Set(selfAgents.map(s => s.toLowerCase()));
  return groups.filter(g => g.agents.some(a => want.has(a)));
}

/** 규칙 path 를 정규식으로. `*`=임의 문자열, `$`=끝 고정. */
function toRe(path) {
  const esc = path.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const body = esc.replace(/\*/g, '.*').replace(/\\\$$/, '$');
  return new RegExp('^' + body);
}

/** 한 그룹 안에서: 가장 긴 매치 우선, 동률이면 allow 우선. */
export function decideInGroup(rules, pathname) {
  let best = null;
  for (const r of rules) {
    if (!toRe(r.path).test(pathname)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.type === 'allow')) best = { ...r, len };
  }
  if (!best) return { decision: 'allowed', rule: '(매치 규칙 없음 — 기본 허용)' };
  return { decision: best.type === 'allow' ? 'allowed' : 'blocked', rule: `${best.type === 'allow' ? 'Allow' : 'Disallow'}: ${best.path}` };
}

/**
 * 적용 가능한 그룹 전체 중 **가장 엄한** 판정. 하나라도 blocked 면 blocked.
 * 어느 그룹이 막았는지(`matched_group`)를 반드시 함께 돌려준다 — 근거 없는 차단은
 * 다음 사람이 되돌릴 수 없다.
 */
export function decide(groups, pathname, selfAgents = SELF_AGENTS) {
  const applicable = applicableGroups(groups, selfAgents);
  if (!applicable.length) return { decision: 'allowed', rule: '(우리에게 적용되는 그룹 없음 — 기본 허용)', matched_group: null };
  let allowedRule = '(매치 규칙 없음 — 기본 허용)', allowedGroup = null;
  for (const g of applicable) {
    const d = decideInGroup(g.rules, pathname);
    if (d.decision === 'blocked') return { decision: 'blocked', rule: d.rule, matched_group: g.agents.join(', ') };
    allowedRule = d.rule; allowedGroup = g.agents.join(', ');
  }
  return { decision: 'allowed', rule: allowedRule, matched_group: allowedGroup };
}

function fetchText(url) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const req = get(url, { headers: { 'User-Agent': UA }, timeout: TIMEOUT_MS }, res => {
      let body = '';
      res.on('data', c => { body += c; if (body.length > 512 * 1024) req.destroy(); });
      res.on('end', () => finish({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); finish({ status: 0, body: '', error: 'timeout' }); });
    req.on('error', e => finish({ status: 0, body: '', error: e.message }));
  });
}

export async function gate(target, selfAgents = SELF_AGENTS) {
  let u;
  try { u = new URL(target); } catch { return { url: target, decision: 'error', rule: 'URL 파싱 실패' }; }
  const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
  const r = await fetchText(robotsUrl);

  let verdict;
  if (r.status >= 400 && r.status < 500) verdict = { decision: 'allowed', rule: `robots.txt ${r.status} — RFC 9309 상 전면 허용` };
  else if (r.status >= 500) verdict = { decision: 'blocked', rule: `robots.txt ${r.status} — RFC 9309 상 전면 불허` };
  else if (r.status !== 200) verdict = { decision: 'blocked', rule: `robots.txt 취득 실패(${r.error || r.status}) — 보수적으로 불허 처리` };
  else verdict = decide(parseRobots(r.body), u.pathname + (u.search || ''), selfAgents);

  const out = { url: target, robots_url: robotsUrl, robots_status: r.status, ...verdict };
  // 주석의 ToS 성격 금지 문구 — 기계 판정 대상이 아니므로 표시만 한다.
  if (r.status === 200 && r.body.split('\n').some(l => l.trim().startsWith('#') && TOS_HINT.test(l))) {
    out.tos_notice = 'robots.txt 주석에 이용 제한 문구가 있다 — 기계 판정 밖. 리드가 원문을 읽고 판단할 것';
  }
  if (verdict.decision === 'blocked') {
    // 막혔으면 원장 라인을 만들어 준다 — 기록하는 쪽이 싸야 기록된다.
    out.ledger = {
      schema_version: SCHEMA_VERSION,
      run_id: process.env.SEARCHFLOW_RUN_ID || 'sf-RUNID-REPLACE',
      frame_id: process.env.SEARCHFLOW_FRAME_ID || 'fN',
      source_id: process.env.SEARCHFLOW_SOURCE_ID || 'sNNN',
      url: target,
      claim: '(취득 실패 — 이 URL 이 무엇을 주장하는지 확인하지 못함)',
      grade: 'UNREACHABLE',
      grade_basis: `robots.txt 차단 — ${verdict.rule}${verdict.matched_group ? ` [User-agent: ${verdict.matched_group}]` : ''} (우회하지 않음)`,
      accessed_at: new Date().toISOString(),
      status: 'unreachable',
      // 이 게이트가 내는 미도달은 **차단**이다 — 시한 내 미추적(`not-traced`)과 같은 칸에 담기지 않는다.
      unreachable_reason: 'blocked',
    };
  }
  return out;
}

// ─────────────────────────── self-test ───────────────────────────

function selfTest() {
  let pass = 0, fail = 0;
  const t = (name, cond, detail = '') => {
    (cond ? (pass++, process.stdout.write(`PASS  ${name}\n`))
          : (fail++, process.stdout.write(`FAIL  ${name}\n`)));
    if (detail) process.stdout.write(`      ${detail}\n`);
  };

  // 파싱·판정은 네트워크 없이 검증한다(오프라인에서도 도는 결정적 층).
  const full = parseRobots('User-agent: *\nDisallow: /\n');
  t('전면 차단', decide(full, '/anything').decision === 'blocked', JSON.stringify(full));

  t('빈 Disallow = 전면 허용', decide(parseRobots('User-agent: *\nDisallow:\n'), '/x').decision === 'allowed');

  const other = parseRobots('User-agent: Googlebot\nDisallow: /\n');
  t('우리 계열이 아닌 그룹은 판정에 안 쓴다', decide(other, '/x').decision === 'allowed',
    `그룹 ${other.length}개 파싱되지만 적용 대상 ${applicableGroups(other).length}개`);

  const sel = parseRobots('User-agent: *\nDisallow: /search/\nAllow: /search/public/\n');
  const a = decide(sel, '/search/private'), b = decide(sel, '/search/public/x'), c = decide(sel, '/docs');
  t('가장 긴 매치 우선(Allow 가 하위 경로를 되살림)',
    a.decision === 'blocked' && b.decision === 'allowed' && c.decision === 'allowed',
    `/search/private=${a.decision} /search/public/x=${b.decision} /docs=${c.decision}`);

  const wild = parseRobots('User-agent: *\nDisallow: /*/checkout$\n');
  t('와일드카드 `*` 와 끝고정 `$`',
    decide(wild, '/shop/checkout').decision === 'blocked' && decide(wild, '/shop/checkout/step2').decision === 'allowed');

  t('주석·대소문자 무시', parseRobots('# c\nUSER-AGENT: *\nDISALLOW: /a  # trail\n')[0].rules.length === 1);

  // 🔴 회귀 1 — 실측에서 걸린 버그: 연속 User-agent 줄은 한 그룹이다.
  //    구판은 두 번째 줄에서 그룹을 무효화해, 실제 Disallow 를 allowed 로 판정했다.
  const multi = parseRobots('User-agent: *\nUser-agent: Googlebot\nDisallow: /athletic/search/*\n');
  const mv = decide(multi, '/athletic/search/?q=x');
  t('회귀 — 연속 User-agent 줄 = 한 그룹(구판이 놓친 Disallow 를 잡는다)',
    multi.length === 1 && multi[0].agents.length === 2 && mv.decision === 'blocked',
    `그룹=${multi.length} agents=${multi[0]?.agents.join('+')} 판정=${mv.decision} rule=${mv.rule}`);

  // 🔴 회귀 2 — 실측에서 걸린 설계 결함: `*` 허용 + 우리 계열만 전면 불허.
  const named = parseRobots('User-agent: *\nDisallow: /ads/\n\nUser-agent: anthropic-ai\nDisallow: /\n');
  const nv = decide(named, '/some/article');
  t('회귀 — `*` 는 허용해도 우리 계열 그룹이 막으면 blocked',
    nv.decision === 'blocked' && /anthropic-ai/.test(nv.matched_group || ''),
    `판정=${nv.decision} 그룹=${nv.matched_group} rule=${nv.rule}`);
  t('그 경우 RFC 최소 동작(--ua-only "*")으로 내리면 allowed — 차이가 실재함을 보임',
    decide(named, '/some/article', ['*']).decision === 'allowed');

  // 음성 대조 — 파서가 항상 blocked 를 뱉는 고장이면 위 전건이 의미가 없다.
  t('음성 대조 — 그룹 0개면 blocked 를 만들지 않는다', decide([], '/').decision === 'allowed');

  // exit 계약: blocked 는 exit 1(정상 결과), URL 파싱 실패는 exit 2.
  const run = args => spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { encoding: 'utf8' });
  const bad = run(['not-a-url']);
  t('exit 계약 — URL 파싱 실패 = exit 2', bad.status === 2, `exit=${bad.status}`);

  process.stdout.write(`\n${pass}/${pass + fail} PASS\n`);
  process.stdout.write('참고: 네트워크 축(실제 robots.txt 취득·4xx/5xx 처분)은 이 --test 에 없다 —\n');
  process.stdout.write('      fixtures/blocked-observed.md 의 실측 기록이 그 축의 근거다.\n');
  return fail === 0 ? 0 : 1;
}

// ─────────────────────────── CLI ───────────────────────────

if (process.argv.includes('--test')) process.exit(selfTest());

const argv = process.argv.slice(2);
let selfAgents = SELF_AGENTS;
const targets = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--ua-only') { selfAgents = (argv[++i] || '*').split(',').map(s => s.trim()).filter(Boolean); continue; }
  if (argv[i].startsWith('--')) continue;
  targets.push(argv[i]);
}
if (!targets.length) { process.stderr.write('[robots-gate] 사용법: robots-gate.mjs <url> [...] [--ua-only "*"]  |  --test\n'); process.exit(2); }

let blocked = 0, errored = 0;
for (const t of targets) {
  const r = await gate(t, selfAgents);
  if (r.decision === 'error') errored++;
  if (r.decision === 'blocked') blocked++;
  process.stdout.write(JSON.stringify(r) + '\n');
}
if (errored) process.exit(2);
process.exit(blocked ? 1 : 0);
