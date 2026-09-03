#!/usr/bin/env bash
# preflight.sh — searchflow 요소 점검·자동 설치 게이트 (시작 시 1회 · SKILL.md §5.1)
#
# 계약:
#   argv   : [--json] [--no-install] [--test] [--test-network]
#   stdout : JSON 1줄 (기본 출력도 JSON — --json 은 명시용)
#   stderr : 진단·설치 고지만 (stdout 은 파싱 가능한 1줄을 유지한다)
#   exit   : 항상 0 (fail-open — 부재는 exit 코드가 아니라 라벨로 표현한다)
#            예외 = 번들 파일 결손 1 · --test 실패 1
#
# 환경 변수:
#   SEARCHFLOW_STATE_DIR          상태 폴더 (기본 ~/.searchflow)
#   SEARCHFLOW_PREFLIGHT_INSTALL=0  자동 설치 끔 (= --no-install)
#   SEARCHFLOW_PREFLIGHT_ENHANCED=0 강화 요소(P5) 설치 생략
#   SEARCHFLOW_NODE               node 실행기 수동 지정 (최우선)
#   SEARCHFLOW_TEST_TARBALL       (테스트) 로컬 tarball 로 다운로드 대체 — 네트워크 0
#   SEARCHFLOW_TEST_SHASUMS       (테스트) 체크섬 파일 주입
#
# 외부 패키지 0. bash 3.2 호환(연관배열·mapfile ❌). 관리자 권한 호출 ❌.
# 저장소 안에는 쓰지 않는다(공개 레포 오염 방지 — mcp-server.mjs 와 같은 계약).

set -u

# ── 경로·예산 ────────────────────────────────────────────────────────────────
SELF_PATH="$0"
case "$SELF_PATH" in
  /*) ;;
  *) SELF_PATH="$(pwd)/$SELF_PATH" ;;
esac
SCRIPT_DIR="$(cd "$(dirname "$SELF_PATH")" && pwd)"
SELF_PATH="$SCRIPT_DIR/$(basename "$SELF_PATH")"
HOME_DIR="${HOME:-}"

DETECT_BUDGET=5          # 탐지 프로브 1건 상한(s)
INSTALL_BUDGET=180       # 설치 총 예산(s)
SELFTEST_LIMIT=30        # 자체시험 1건 상한(s)
ENHANCED_LIMIT=60        # 강화 요소 설치 1건 상한(s)
HOST_LIMIT=30            # 호스트 CLI 호출 상한(s)
NODE_MIN_MAJOR=18
TEST_OFFLINE_VERSION="v22.0.0"   # SEARCHFLOW_TEST_TARBALL 주입 시 쓰는 오프라인 버전(네트워크 0)
DIST_BASE="https://nodejs.org/dist"

REQUIRED_SCRIPTS="ac6-compare.mjs env-detect.mjs grade-ledger.mjs hide-check.mjs hide-e2e.mjs mcp-server.mjs relay-check.mjs report-check.mjs robots-gate.mjs spawn-plan.mjs"

# ── 유틸 ────────────────────────────────────────────────────────────────────
warn() { printf '[preflight] %s\n' "$*" >&2; }

have() { command -v "$1" >/dev/null 2>&1; }

json_escape() { printf '%s' "${1:-}" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
jstr() { printf '"%s"' "$(json_escape "${1:-}")"; }
jstr_or_null() { if [ -n "${1:-}" ]; then jstr "$1"; else printf 'null'; fi; }

# 사용자에게 보이는 경로는 홈을 ~ 로 접는다(고지문에 절대 내부 경로를 싣지 않는다).
display_path() {
  _dp="${1:-}"
  if [ -n "$HOME_DIR" ]; then
    case "$_dp" in
      "$HOME_DIR") printf '~'; return 0 ;;
      "$HOME_DIR"/*) printf '~%s' "${_dp#$HOME_DIR}"; return 0 ;;
    esac
  fi
  printf '%s' "$_dp"
}

abs_path() {
  _ap="${1:-}"
  case "$_ap" in
    /*) printf '%s' "$_ap" ;;
    *) printf '%s/%s' "$(pwd)" "$_ap" ;;
  esac
}

# macOS 기본 환경에 timeout(1) 이 없다 — 배경 실행 + 폴링으로 상한을 건다.
run_limited() {
  _rl_limit="$1"; shift
  "$@" &
  _rl_pid=$!
  _rl_i=0
  while kill -0 "$_rl_pid" 2>/dev/null; do
    if [ "$_rl_i" -ge "$_rl_limit" ]; then
      kill -9 "$_rl_pid" 2>/dev/null
      wait "$_rl_pid" 2>/dev/null
      return 124
    fi
    sleep 1
    _rl_i=$((_rl_i + 1))
  done
  wait "$_rl_pid"
  return $?
}

# 1줄 JSON 에서 문자열 값 1개 꺼내기 (node 없이도 돌아야 한다 — 테스트 하네스용)
json_get() {
  printf '%s' "${2:-}" | sed -n 's/.*"'"$1"'":"\([^"]*\)".*/\1/p'
}

LABELS=""
add_label() {
  if [ -z "$LABELS" ]; then LABELS="$1"; else LABELS="$LABELS
$1"; fi
}
INSTALLED=""
add_installed() {
  if [ -z "$INSTALLED" ]; then INSTALLED="$1"; else INSTALLED="$INSTALLED
$1"; fi
}
json_array_from_lines() {
  _ja_first=1
  printf '['
  while IFS= read -r _ja_line; do
    [ -n "$_ja_line" ] || continue
    if [ "$_ja_first" -eq 1 ]; then _ja_first=0; else printf ','; fi
    jstr "$_ja_line"
  done
  printf ']'
}

# ── 옵션 ────────────────────────────────────────────────────────────────────
OPT_NO_INSTALL=0
OPT_TEST=0
OPT_TEST_NETWORK=0
for _arg in "$@"; do
  case "$_arg" in
    --json) ;;
    --no-install) OPT_NO_INSTALL=1 ;;
    --test) OPT_TEST=1 ;;
    --test-network) OPT_TEST_NETWORK=1 ;;
    *) warn "unknown option ignored: $_arg" ;;
  esac
done
if [ "${SEARCHFLOW_PREFLIGHT_INSTALL:-1}" = "0" ]; then OPT_NO_INSTALL=1; fi
ENHANCED_ON=1
if [ "${SEARCHFLOW_PREFLIGHT_ENHANCED:-1}" = "0" ]; then ENHANCED_ON=0; fi

INSTALL_T0=0
budget_left() {
  _bl_now="$(date +%s)"
  printf '%s' "$((INSTALL_BUDGET - (_bl_now - INSTALL_T0)))"
}

# ── P3 상태 폴더 ────────────────────────────────────────────────────────────
STATE_DIR=""
STATE_KIND="home"
state_writable() {
  _sw_probe="$1/.preflight-write-test.$$"
  if : > "$_sw_probe" 2>/dev/null; then rm -f "$_sw_probe" 2>/dev/null; return 0; fi
  return 1
}
resolve_state() {
  if [ -n "${SEARCHFLOW_STATE_DIR:-}" ]; then
    _rs_base="$(abs_path "$SEARCHFLOW_STATE_DIR")"
  else
    _rs_base="${HOME_DIR:-/tmp}/.searchflow"
  fi
  if mkdir -p "$_rs_base" 2>/dev/null && chmod 0700 "$_rs_base" 2>/dev/null && state_writable "$_rs_base"; then
    STATE_DIR="$_rs_base"
    STATE_KIND="home"
    return 0
  fi
  _rs_tmp="${TMPDIR:-/tmp}/searchflow"
  mkdir -p "$_rs_tmp" 2>/dev/null
  chmod 0700 "$_rs_tmp" 2>/dev/null
  STATE_DIR="$_rs_tmp"
  STATE_KIND="tmp"
  warn "state dir not writable — falling back to a temporary directory"
}

# ── P1 node ─────────────────────────────────────────────────────────────────
NODE_BIN=""
NODE_VERSION=""
NODE_SOURCE="none"
CAND_VERSION=""

node_major() { printf '%s' "${1:-}" | sed -n 's/^v\([0-9][0-9]*\)\..*$/\1/p'; }

# 후보 실행기가 v18+ 인지. 성공 시 CAND_VERSION 설정.
node_usable() {
  CAND_VERSION=""
  _nu_bin="${1:-}"
  [ -n "$_nu_bin" ] || return 1
  [ -x "$_nu_bin" ] || return 1
  _nu_out="$(mktemp "${TMPDIR:-/tmp}/searchflow-node-probe.XXXXXX" 2>/dev/null)" || return 1
  run_limited "$DETECT_BUDGET" "$_nu_bin" -v >"$_nu_out" 2>/dev/null
  _nu_v="$(head -1 "$_nu_out" 2>/dev/null | tr -d '\r')"
  rm -f "$_nu_out" 2>/dev/null
  case "$_nu_v" in v[0-9]*) ;; *) return 1 ;; esac
  _nu_m="$(node_major "$_nu_v")"
  [ -n "$_nu_m" ] || return 1
  [ "$_nu_m" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null || return 1
  CAND_VERSION="$_nu_v"
  return 0
}

PF_OS=""
PF_ARCH=""
detect_os_arch() {
  case "$(uname -s 2>/dev/null || printf unknown)" in
    Darwin) PF_OS="darwin" ;;
    Linux)  PF_OS="linux" ;;
    *)      PF_OS=""; return 1 ;;
  esac
  case "$(uname -m 2>/dev/null || printf unknown)" in
    arm64|aarch64) PF_ARCH="arm64" ;;
    x86_64|amd64)  PF_ARCH="x64" ;;
    *)             PF_ARCH=""; return 1 ;;
  esac
  return 0
}

DOWNLOADER=""
pick_downloader() {
  if have curl; then DOWNLOADER="curl"; return 0; fi
  if have wget; then DOWNLOADER="wget"; return 0; fi
  DOWNLOADER=""
  return 1
}
fetch_to_file() {   # url out_file max_seconds — https 고정
  case "$1" in https://*) ;; *) warn "refusing non-https url"; return 1 ;; esac
  if [ "$DOWNLOADER" = "curl" ]; then
    curl -fsSL --max-time "$3" -o "$2" "$1" 2>/dev/null
  else
    wget -q -T "$3" -O "$2" "$1" 2>/dev/null
  fi
}

SHA_TOOL=""
pick_sha_tool() {
  if have shasum; then SHA_TOOL="shasum"; return 0; fi
  if have sha256sum; then SHA_TOOL="sha256sum"; return 0; fi
  SHA_TOOL=""
  return 1
}
sha256_of() {
  if [ "$SHA_TOOL" = "shasum" ]; then shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'
  else sha256sum "$1" 2>/dev/null | awk '{print $1}'; fi
}

# nodejs.org dist 인덱스에서 최신 LTS(짝수 major) 1개
latest_lts_version() {
  _llv_f="$(mktemp "${TMPDIR:-/tmp}/searchflow-node-index.XXXXXX" 2>/dev/null)" || return 1
  _llv_rem="$(budget_left)"
  if [ "$_llv_rem" -le 0 ]; then rm -f "$_llv_f"; return 1; fi
  if ! fetch_to_file "$DIST_BASE/index.json" "$_llv_f" "$_llv_rem"; then
    rm -f "$_llv_f" 2>/dev/null
    return 1
  fi
  _llv_v="$(tr '{' '\n' < "$_llv_f" \
    | grep '"lts":"' \
    | sed -n 's/.*"version":"v\([0-9][0-9]*\)\.\([0-9][0-9.]*\)".*/v\1.\2 \1/p' \
    | awk '$2 % 2 == 0 { print $1; exit }')"
  rm -f "$_llv_f" 2>/dev/null
  [ -n "$_llv_v" ] || return 1
  printf '%s' "$_llv_v"
}

# 관리자 권한 없이 홈 아래로 내려받아 푼다. 성공 시 NODE_BIN/NODE_VERSION 설정.
install_portable_node() {
  if ! pick_downloader; then
    warn "neither curl nor wget is available — skipping portable node download"
    return 1
  fi
  if ! detect_os_arch; then
    warn "portable node is not offered for this os/arch — skipping download"
    return 1
  fi

  _ipn_offline="${SEARCHFLOW_TEST_TARBALL:-}"
  if [ -n "$_ipn_offline" ]; then
    _ipn_ver="$TEST_OFFLINE_VERSION"
  else
    _ipn_ver="$(latest_lts_version)" || {
      warn "could not read the node release index — skipping download"
      return 1
    }
  fi

  _ipn_name="node-$_ipn_ver-$PF_OS-$PF_ARCH.tar.gz"
  _ipn_root="$STATE_DIR/node"
  _ipn_work="$_ipn_root/.download.$$"
  mkdir -p "$_ipn_work" 2>/dev/null || { warn "cannot create the download directory"; return 1; }

  warn "installing node $_ipn_ver into $(display_path "$_ipn_root") (no admin rights needed; remove with: rm -rf $(display_path "$_ipn_root"))"

  _ipn_tar="$_ipn_work/$_ipn_name"
  if [ -n "$_ipn_offline" ]; then
    cp "$_ipn_offline" "$_ipn_tar" 2>/dev/null || { warn "cannot read the injected tarball"; rm -rf "$_ipn_work"; return 1; }
  else
    _ipn_rem="$(budget_left)"
    if [ "$_ipn_rem" -le 0 ]; then
      warn "install budget of ${INSTALL_BUDGET}s is exhausted — giving up on the download"
      rm -rf "$_ipn_work"; return 1
    fi
    if ! fetch_to_file "$DIST_BASE/$_ipn_ver/$_ipn_name" "$_ipn_tar" "$_ipn_rem"; then
      warn "download failed for $_ipn_name"
      rm -rf "$_ipn_work"; return 1
    fi
  fi

  _ipn_sha="$_ipn_work/SHASUMS256.txt"
  if [ -n "${SEARCHFLOW_TEST_SHASUMS:-}" ]; then
    cp "$SEARCHFLOW_TEST_SHASUMS" "$_ipn_sha" 2>/dev/null || { warn "cannot read the injected checksum file"; rm -rf "$_ipn_work"; return 1; }
  else
    _ipn_rem="$(budget_left)"
    if [ "$_ipn_rem" -le 0 ]; then
      warn "install budget of ${INSTALL_BUDGET}s is exhausted — discarding the download"
      rm -rf "$_ipn_work"; return 1
    fi
    if ! fetch_to_file "$DIST_BASE/$_ipn_ver/SHASUMS256.txt" "$_ipn_sha" "$_ipn_rem"; then
      warn "checksum file unavailable — discarding the download"
      rm -rf "$_ipn_work"; return 1
    fi
  fi

  if ! pick_sha_tool; then
    warn "no sha256 tool (shasum/sha256sum) — discarding the download unverified"
    rm -rf "$_ipn_work"; return 1
  fi
  _ipn_expected="$(grep -F "  $_ipn_name" "$_ipn_sha" 2>/dev/null | awk '{print $1}' | head -1)"
  _ipn_actual="$(sha256_of "$_ipn_tar")"
  if [ -z "$_ipn_expected" ] || [ -z "$_ipn_actual" ] || [ "$_ipn_expected" != "$_ipn_actual" ]; then
    warn "checksum mismatch for $_ipn_name — discarding the download (expected=${_ipn_expected:-none} actual=${_ipn_actual:-none})"
    rm -rf "$_ipn_work"
    return 1
  fi
  _ipn_kib="$(( $(wc -c < "$_ipn_tar" 2>/dev/null || printf 0) / 1024 ))"
  warn "downloaded $_ipn_name (${_ipn_kib} KiB), sha256 verified"

  _ipn_dest="$_ipn_root/$_ipn_ver"
  rm -rf "$_ipn_dest" 2>/dev/null
  mkdir -p "$_ipn_dest" 2>/dev/null || { warn "cannot create the install directory"; rm -rf "$_ipn_work"; return 1; }
  if ! tar -xzf "$_ipn_tar" -C "$_ipn_dest" --strip-components=1 2>/dev/null; then
    warn "extraction failed for $_ipn_name"
    rm -rf "$_ipn_work" "$_ipn_dest"
    return 1
  fi
  rm -rf "$_ipn_work" 2>/dev/null
  ln -sfn "$_ipn_dest" "$_ipn_root/current" 2>/dev/null

  if node_usable "$_ipn_root/current/bin/node"; then
    NODE_BIN="$_ipn_root/current/bin/node"
    NODE_VERSION="$CAND_VERSION"
    return 0
  fi
  warn "the extracted node did not answer -v — treating it as unavailable"
  return 1
}

# 패키지 관리자 폴백 — 권한 상승은 시도하지 않는다(실패하면 그냥 다음으로 간다).
install_via_package_manager() {
  if have brew; then
    _ivp_rem="$(budget_left)"
    if [ "$_ivp_rem" -gt 0 ]; then
      warn "trying the system package manager (brew) for node"
      if run_limited "$_ivp_rem" brew install node >/dev/null 2>&1; then
        if node_usable "$(command -v node 2>/dev/null)"; then
          NODE_BIN="$(command -v node)"; NODE_VERSION="$CAND_VERSION"; NODE_SOURCE="brew"
          return 0
        fi
      fi
      warn "brew could not provide node"
    fi
  fi
  if have apt-get; then
    _ivp_rem="$(budget_left)"
    if [ "$_ivp_rem" -gt 0 ]; then
      warn "trying the system package manager (apt-get) for node"
      if run_limited "$_ivp_rem" apt-get install -y nodejs >/dev/null 2>&1; then
        if node_usable "$(command -v node 2>/dev/null)"; then
          NODE_BIN="$(command -v node)"; NODE_VERSION="$CAND_VERSION"; NODE_SOURCE="apt"
          return 0
        fi
      fi
      warn "apt-get could not provide node without elevated rights"
    fi
  fi
  if have winget; then
    _ivp_rem="$(budget_left)"
    if [ "$_ivp_rem" -gt 0 ]; then
      warn "trying the system package manager (winget) for node"
      if run_limited "$_ivp_rem" winget install -e --id OpenJS.NodeJS.LTS >/dev/null 2>&1; then
        if node_usable "$(command -v node 2>/dev/null)"; then
          NODE_BIN="$(command -v node)"; NODE_VERSION="$CAND_VERSION"; NODE_SOURCE="winget"
          return 0
        fi
      fi
      warn "winget could not provide node"
    fi
  fi
  return 1
}

resolve_node() {
  # ① 수동 지정
  if [ -n "${SEARCHFLOW_NODE:-}" ]; then
    if node_usable "$SEARCHFLOW_NODE"; then
      NODE_BIN="$(abs_path "$SEARCHFLOW_NODE")"; NODE_VERSION="$CAND_VERSION"; NODE_SOURCE="path"
      return 0
    fi
    warn "SEARCHFLOW_NODE does not point at a usable node v${NODE_MIN_MAJOR}+ — falling through"
  fi
  # ② PATH
  _rn_path="$(command -v node 2>/dev/null)"
  if [ -n "$_rn_path" ] && node_usable "$_rn_path"; then
    NODE_BIN="$_rn_path"; NODE_VERSION="$CAND_VERSION"; NODE_SOURCE="path"
    return 0
  fi
  # ③ 이전 실행이 받아둔 portable 캐시
  if node_usable "$STATE_DIR/node/current/bin/node"; then
    NODE_BIN="$STATE_DIR/node/current/bin/node"; NODE_VERSION="$CAND_VERSION"; NODE_SOURCE="portable-cached"
    return 0
  fi
  # ④ 설치
  if [ "$OPT_NO_INSTALL" -eq 1 ]; then
    warn "no node runtime found and installation is disabled — continuing degraded"
    return 1
  fi
  INSTALL_T0="$(date +%s)"
  if install_portable_node; then
    NODE_SOURCE="portable"
    add_installed "node $NODE_VERSION (portable)"
    return 0
  fi
  if install_via_package_manager; then
    add_installed "node $NODE_VERSION ($NODE_SOURCE)"
    return 0
  fi
  warn "could not provide a node runtime — continuing degraded (script self-checks are skipped)"
  return 1
}

# ── P2 번들 스크립트 · 자체시험 ──────────────────────────────────────────────
SCRIPTS_OK="true"
MISSING_SCRIPTS=""
check_scripts() {
  for _cs_f in $REQUIRED_SCRIPTS; do
    if [ ! -f "$SCRIPT_DIR/$_cs_f" ]; then
      SCRIPTS_OK="false"
      MISSING_SCRIPTS="$MISSING_SCRIPTS $_cs_f"
    fi
  done
}

SELFTEST="skip"
run_selftest() {
  if [ -z "$NODE_BIN" ]; then SELFTEST="skip"; return 0; fi
  SELFTEST="pass"
  for _rs_f in env-detect.mjs spawn-plan.mjs report-check.mjs; do
    if ! run_limited "$SELFTEST_LIMIT" "$NODE_BIN" "$SCRIPT_DIR/$_rs_f" --test >/dev/null 2>&1; then
      warn "self-test failed: $_rs_f --test"
      SELFTEST="fail"
    fi
  done
}

# ── P4 서버 등록 ────────────────────────────────────────────────────────────
MCP_STATE="skipped-no-host"

# 플러그인 경유로 등록된 서버는 `claude mcp get <name>` 이 못 본다 — 실측: get 은
# 「No MCP server named "searchflow"」로 exit 1 인데 `claude mcp list` 에는
# `plugin:searchflow:searchflow: node …/mcp-server.mjs - ✔ Connected` 가 있다.
# get 실패 하나로 부재를 단정하면 이미 붙어 있는 서버를 다시 등록하게 된다.
# 반환 3상태: 0=있음 · 1=없음 · 2=모름(호스트가 시한 안에 답하지 않음 — 부재로 단정하지 않는다).
claude_sees_searchflow() {
  if run_limited "$HOST_LIMIT" claude mcp get searchflow >/dev/null 2>&1; then
    return 0
  fi
  _css_out="$(mktemp "${TMPDIR:-/tmp}/searchflow-mcp-list.XXXXXX" 2>/dev/null)" || return 1
  run_limited "$HOST_LIMIT" claude mcp list >"$_css_out" 2>/dev/null
  _css_rc=$?
  if grep -E -q '(^|:)searchflow:' "$_css_out" 2>/dev/null; then
    rm -f "$_css_out" 2>/dev/null
    return 0
  fi
  # run_limited 는 시한 초과를 124 로 돌려준다. 빈 출력 + 비정상 종료도 「없다」가 아니라 「모른다」다.
  if [ "$_css_rc" -eq 124 ]; then
    rm -f "$_css_out" 2>/dev/null
    return 2
  fi
  if [ "$_css_rc" -ne 0 ] && [ ! -s "$_css_out" ]; then
    rm -f "$_css_out" 2>/dev/null
    return 2
  fi
  rm -f "$_css_out" 2>/dev/null
  return 1
}
register_mcp() {
  _rm_host=0
  _rm_present=0
  _rm_registered=0
  _rm_failed=0
  _rm_skipped=0
  _rm_unknown=0
  _rm_server="$SCRIPT_DIR/mcp-server.mjs"

  if have claude; then
    _rm_host=1
    claude_sees_searchflow
    _rm_seen=$?
    if [ "$_rm_seen" -eq 0 ]; then
      _rm_present=1
    elif [ "$_rm_seen" -eq 2 ]; then
      _rm_unknown=1
      warn "the claude host did not answer within ${HOST_LIMIT}s — skipping mcp registration (rerun preflight once the host responds)"
    elif [ "$OPT_NO_INSTALL" -eq 0 ] && [ -n "$NODE_BIN" ]; then
      if run_limited "$HOST_LIMIT" claude mcp add -s user searchflow -- "$NODE_BIN" "$_rm_server" >/dev/null 2>&1; then
        _rm_registered=1
        add_installed "searchflow mcp server (claude, user scope)"
        warn "registered the searchflow mcp server for claude — restart the host to load it (undo with: claude mcp remove -s user searchflow)"
      else
        _rm_failed=1
        warn "could not register the searchflow mcp server for claude"
      fi
    elif [ "$OPT_NO_INSTALL" -eq 1 ]; then
      _rm_skipped=1
    else
      _rm_failed=1
    fi
  fi

  if have codex; then
    _rm_host=1
    _rm_cfg="${CODEX_HOME:-$HOME_DIR/.codex}/config.toml"
    if [ -f "$_rm_cfg" ] && grep -q '^\[mcp_servers\.searchflow\]' "$_rm_cfg" 2>/dev/null; then
      _rm_present=$((_rm_present + 1))
    elif [ "$OPT_NO_INSTALL" -eq 0 ] && [ -n "$NODE_BIN" ]; then
      mkdir -p "$(dirname "$_rm_cfg")" 2>/dev/null
      if [ -f "$_rm_cfg" ]; then
        cp "$_rm_cfg" "$_rm_cfg.bak.$(date +%s)" 2>/dev/null || warn "could not back up the codex config — leaving it untouched"
      fi
      if {
        printf '\n[mcp_servers.searchflow]\n'
        printf 'command = "%s"\n' "$NODE_BIN"
        printf 'args = ["%s"]\n' "$_rm_server"
      } >> "$_rm_cfg" 2>/dev/null; then
        _rm_registered=1
        add_installed "searchflow mcp server (codex config.toml)"
        warn "added the searchflow mcp server to the codex config — restart the host to load it (undo: restore the .bak file next to config.toml)"
      else
        _rm_failed=1
        warn "could not write the codex config"
      fi
    elif [ "$OPT_NO_INSTALL" -eq 1 ]; then
      _rm_skipped=1
    else
      _rm_failed=1
    fi
  fi

  # 우선순위: 「시도 후 실패」 > 「호스트가 답하지 않아 모름」 > 「등록함(재시작 필요)」 > 「설치를 꺼서 시도 안 함」 > 「이미 있음」.
  # skipped-no-install 을 register-failed 로 적으면 두 사실이 한 라벨로 뭉개진다.
  if [ "$_rm_host" -eq 0 ]; then MCP_STATE="skipped-no-host"
  elif [ "$_rm_failed" -eq 1 ]; then MCP_STATE="register-failed"
  elif [ "$_rm_unknown" -eq 1 ]; then MCP_STATE="unknown-host-timeout"
  elif [ "$_rm_registered" -eq 1 ]; then MCP_STATE="registered-restart-needed"
  elif [ "$_rm_skipped" -eq 1 ]; then MCP_STATE="skipped-no-install"
  else MCP_STATE="present"; fi
}

# ── P5 강화 요소 (best-effort · 비치명) ─────────────────────────────────────
ENH_CODEX="absent"
ENH_OOO="absent"
ENH_HOOK="absent"
enhanced_pass() {
  # codex
  if have codex; then
    ENH_CODEX="present"
  elif [ "$ENHANCED_ON" -eq 1 ] && [ "$OPT_NO_INSTALL" -eq 0 ]; then
    _ep_npm=""
    case "$NODE_SOURCE" in
      portable|portable-cached) [ -x "$STATE_DIR/node/current/bin/npm" ] && _ep_npm="$STATE_DIR/node/current/bin/npm" ;;
      *) _ep_npm="$(command -v npm 2>/dev/null)" ;;
    esac
    if [ -n "$_ep_npm" ]; then
      case "$NODE_SOURCE" in
        portable|portable-cached)
          run_limited "$ENHANCED_LIMIT" "$_ep_npm" i -g --prefix "$STATE_DIR/node/current" @openai/codex >/dev/null 2>&1 ;;
        *)
          run_limited "$ENHANCED_LIMIT" "$_ep_npm" i -g @openai/codex >/dev/null 2>&1 ;;
      esac
      if [ $? -eq 0 ]; then
        ENH_CODEX="installed"
        add_installed "@openai/codex (npm global)"
      else
        ENH_CODEX="failed"
        warn "optional codex cli install failed — continuing without it (install manually: npm i -g @openai/codex)"
      fi
    fi
  fi

  # ooo (우로보로스 CLI) — uv 가 있을 때만
  if have ooo; then
    ENH_OOO="present"
  elif [ "$ENHANCED_ON" -eq 1 ] && [ "$OPT_NO_INSTALL" -eq 0 ] && have uv; then
    if run_limited "$ENHANCED_LIMIT" uv tool install 'ouroboros-ai[mcp]' >/dev/null 2>&1; then
      ENH_OOO="installed"
      add_installed "ouroboros-ai[mcp] (uv tool)"
    else
      ENH_OOO="failed"
      warn "optional ooo install failed — continuing without it (install manually: uv tool install 'ouroboros-ai[mcp]')"
    fi
  fi

  # 지식 조회 훅 — 탐지만 한다(설치 대상이 아니다)
  if [ -n "${SEARCHFLOW_KNOWLEDGE_HOOK:-}" ] && [ -e "${SEARCHFLOW_KNOWLEDGE_HOOK}" ]; then
    ENH_HOOK="present"
  fi
}

# ── 출력 ────────────────────────────────────────────────────────────────────
emit_json() {
  printf '{'
  printf '"node":%s,' "$(jstr_or_null "$NODE_BIN")"
  printf '"node_version":%s,' "$(jstr_or_null "$NODE_VERSION")"
  printf '"node_source":%s,' "$(jstr "$NODE_SOURCE")"
  printf '"scripts_ok":%s,' "$SCRIPTS_OK"
  printf '"selftest":%s,' "$(jstr "$SELFTEST")"
  printf '"state_dir":%s,' "$(jstr "$STATE_DIR")"
  printf '"mcp":%s,' "$(jstr "$MCP_STATE")"
  printf '"enhanced":{"codex":%s,"ooo":%s,"hook":%s},' "$(jstr "$ENH_CODEX")" "$(jstr "$ENH_OOO")" "$(jstr "$ENH_HOOK")"
  printf '"installed":%s,' "$(printf '%s\n' "$INSTALLED" | json_array_from_lines)"
  printf '"labels":%s' "$(printf '%s\n' "$LABELS" | json_array_from_lines)"
  printf '}\n'
}

main() {
  resolve_state
  check_scripts
  if [ "$SCRIPTS_OK" = "false" ]; then
    warn "bundle is incomplete — missing:$MISSING_SCRIPTS"
    SELFTEST="skip"
    add_label "degraded=bundle-incomplete"
    add_label "state=$STATE_KIND"
    emit_json
    exit 1
  fi

  if resolve_node; then
    add_label "node=$NODE_SOURCE"
  else
    NODE_SOURCE="none"
    add_label "degraded=no-node-runtime"
  fi

  run_selftest
  add_label "selftest=$SELFTEST"
  add_label "state=$STATE_KIND"

  register_mcp
  add_label "mcp=$MCP_STATE"

  enhanced_pass
  add_label "enhanced=codex:$ENH_CODEX"
  add_label "enhanced=ooo:$ENH_OOO"
  add_label "enhanced=hook:$ENH_HOOK"

  emit_json
  exit 0
}

# ── 셀프테스트 (F1~F7 · 네트워크 0) ─────────────────────────────────────────
TEST_PASS=0
TEST_FAIL=0
report_case() {
  if [ "$1" -eq 0 ]; then
    printf 'PASS %s — %s\n' "$2" "$3"
    TEST_PASS=$((TEST_PASS + 1))
  else
    printf 'FAIL %s — %s\n' "$2" "$3"
    TEST_FAIL=$((TEST_FAIL + 1))
  fi
}
count_matches() { printf '%s' "${2:-}" | grep -o "$1" 2>/dev/null | wc -l | tr -d ' '; }
# 정규식 해석 없이 정본 철자 그대로 세는 자(라벨 철자 회귀용).
count_fixed() { printf '%s' "${2:-}" | grep -o -F "$1" 2>/dev/null | wc -l | tr -d ' '; }

self_test() {
  BASE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/searchflow-preflight-test.XXXXXX")" || {
    printf 'FAIL harness — cannot create a temporary directory\n'
    return 1
  }
  trap 'rm -rf "$BASE_TMP"' EXIT
  MIN_PATH="/usr/bin:/bin"
  HOST_NODE="${SEARCHFLOW_NODE:-}"
  [ -n "$HOST_NODE" ] || HOST_NODE="$(command -v node 2>/dev/null)"

  # F1 — PATH 에 node 있음
  _d="$BASE_TMP/f1"; mkdir -p "$_d/state" "$_d/home"
  if [ -n "$HOST_NODE" ]; then
    _out="$(env PATH="$(dirname "$HOST_NODE"):$MIN_PATH" HOME="$_d/home" \
      SEARCHFLOW_STATE_DIR="$_d/state" SEARCHFLOW_PREFLIGHT_ENHANCED=0 \
      SEARCHFLOW_NODE= SEARCHFLOW_TEST_TARBALL= SEARCHFLOW_TEST_SHASUMS= \
      bash "$SELF_PATH" --json 2>"$_d/err")"
    _rc=$?
    _src="$(json_get node_source "$_out")"
    _st="$(json_get selftest "$_out")"
    if [ "$_src" = "path" ] && [ "$_st" = "pass" ] && [ "$_rc" -eq 0 ]; then _ok=0; else _ok=1; fi
    report_case "$_ok" "F1 node-on-path" "node_source=$_src selftest=$_st exit=$_rc"
  else
    report_case 1 "F1 node-on-path" "no host node runtime to exercise this case"
  fi

  # F2 — PATH 최소 + portable 캐시(stub)
  _d="$BASE_TMP/f2"; mkdir -p "$_d/state/node/current/bin" "$_d/home"
  cat > "$_d/state/node/current/bin/node" <<'PREFLIGHT_TEST_STUB'
#!/bin/sh
case "${1:-}" in
  -v|--version) echo "v20.0.0" ;;
  *) exit 0 ;;
esac
PREFLIGHT_TEST_STUB
  chmod +x "$_d/state/node/current/bin/node"
  _out="$(env PATH="$MIN_PATH" HOME="$_d/home" \
    SEARCHFLOW_STATE_DIR="$_d/state" SEARCHFLOW_PREFLIGHT_ENHANCED=0 \
    SEARCHFLOW_NODE= SEARCHFLOW_TEST_TARBALL= SEARCHFLOW_TEST_SHASUMS= \
    bash "$SELF_PATH" --json 2>"$_d/err")"
  _rc=$?
  _src="$(json_get node_source "$_out")"
  _ver="$(json_get node_version "$_out")"
  if [ "$_src" = "portable-cached" ] && [ "$_ver" = "v20.0.0" ] && [ "$_rc" -eq 0 ]; then _ok=0; else _ok=1; fi
  report_case "$_ok" "F2 portable-cached" "node_source=$_src node_version=$_ver exit=$_rc"

  # F3 — PATH 최소 + --no-install
  _d="$BASE_TMP/f3"; mkdir -p "$_d/state" "$_d/home"
  F3_OUT="$(env PATH="$MIN_PATH" HOME="$_d/home" \
    SEARCHFLOW_STATE_DIR="$_d/state" SEARCHFLOW_PREFLIGHT_ENHANCED=0 \
    SEARCHFLOW_NODE= SEARCHFLOW_TEST_TARBALL= SEARCHFLOW_TEST_SHASUMS= \
    bash "$SELF_PATH" --json --no-install 2>"$_d/err")"
  _rc=$?
  F3_ERR="$(cat "$_d/err" 2>/dev/null)"
  _st="$(json_get selftest "$F3_OUT")"
  _deg="$(count_fixed 'degraded=no-node-runtime' "$F3_OUT")"
  _deg_var="$(count_fixed 'no_node_runtime' "$F3_OUT$F3_ERR")"
  if [ "$_deg" -ge 1 ] && [ "$_deg_var" -eq 0 ] && [ "$_st" = "skip" ] && [ "$_rc" -eq 0 ]; then _ok=0; else _ok=1; fi
  report_case "$_ok" "F3 no-install-degraded" "degraded_label=$_deg (canonical, expect >=1) underscore_variant=$_deg_var (expect 0) selftest=$_st exit=$_rc"

  # F4 — 체크섬 불일치 → 다운로드 폐기 (네트워크 0: 로컬 tarball 주입)
  _d="$BASE_TMP/f4"; mkdir -p "$_d/state" "$_d/home"
  detect_os_arch || true
  _fake_name="node-$TEST_OFFLINE_VERSION-${PF_OS:-unknown}-${PF_ARCH:-unknown}.tar.gz"
  printf 'this is not a node tarball\n' > "$_d/fake.tar.gz"
  printf '%s  %s\n' '0000000000000000000000000000000000000000000000000000000000000000' "$_fake_name" > "$_d/fake-shasums.txt"
  _out="$(env PATH="$MIN_PATH" HOME="$_d/home" \
    SEARCHFLOW_STATE_DIR="$_d/state" SEARCHFLOW_PREFLIGHT_ENHANCED=0 \
    SEARCHFLOW_NODE= SEARCHFLOW_TEST_TARBALL="$_d/fake.tar.gz" \
    SEARCHFLOW_TEST_SHASUMS="$_d/fake-shasums.txt" \
    bash "$SELF_PATH" --json 2>"$_d/err")"
  _rc=$?
  _err="$(cat "$_d/err" 2>/dev/null)"
  _deg="$(count_matches 'degraded=no-node-runtime' "$_out")"
  _mis="$(count_matches 'checksum mismatch' "$_err")"
  if [ -e "$_d/state/node/current" ]; then _extracted="yes"; else _extracted="no"; fi
  if [ "$_deg" -ge 1 ] && [ "$_mis" -ge 1 ] && [ "$_extracted" = "no" ] && [ "$_rc" -eq 0 ]; then _ok=0; else _ok=1; fi
  report_case "$_ok" "F4 checksum-mismatch-discard" "degraded_label=$_deg mismatch_notices=$_mis extracted_current=$_extracted exit=$_rc"

  # F5 — 음성 미끼: 언더스코어 변형 0건 + 계약 키 전건 (양성 대조 = 하이픈 정본 1건 이상)
  _decoy="$(count_matches 'no_node_runtime' "$F3_OUT$F3_ERR")"
  _positive="$(count_matches 'no-node-runtime' "$F3_OUT")"
  _missing=""
  for _k in '"node":' '"node_version":' '"node_source":' '"scripts_ok":' '"selftest":' '"state_dir":' '"mcp":' '"enhanced":' '"installed":' '"labels":' '"codex":' '"ooo":' '"hook":'; do
    case "$F3_OUT" in
      *"$_k"*) ;;
      *) _missing="$_missing $_k" ;;
    esac
  done
  if [ "$_decoy" -eq 0 ] && [ "$_positive" -ge 1 ] && [ -z "$_missing" ]; then _ok=0; else _ok=1; fi
  report_case "$_ok" "F5 negative-decoy" "underscore_variant=$_decoy (expect 0) canonical_hyphen=$_positive (expect >=1) missing_keys=${_missing:-none}"

  # F6 — 플러그인 경유 등록: `mcp get` 은 못 찾고 `mcp list` 에만 보인다(가짜 claude stub).
  #      한 케이스 안에서 양성(list 에 있음 → present)과 음성(list 에 없음 → present 아님)을 쌍으로 잰다.
  _d="$BASE_TMP/f6"; mkdir -p "$_d/state" "$_d/home" "$_d/bin"
  cat > "$_d/bin/claude" <<'PREFLIGHT_CLAUDE_STUB'
#!/bin/sh
# 테스트용 가짜 호스트. get 은 항상 못 찾고, list 는 PREFLIGHT_STUB_LIST_MISS 로 갈린다.
if [ "${1:-}" = "mcp" ] && [ "${2:-}" = "get" ]; then
  echo 'No MCP server named "searchflow"' >&2
  exit 1
fi
if [ "${1:-}" = "mcp" ] && [ "${2:-}" = "list" ]; then
  if [ "${PREFLIGHT_STUB_LIST_MISS:-0}" = "1" ]; then
    printf ''
  else
    echo 'plugin:searchflow:searchflow: node /opt/bundle/skills/searchflow/scripts/mcp-server.mjs - Connected'
  fi
  exit 0
fi
exit 1
PREFLIGHT_CLAUDE_STUB
  chmod +x "$_d/bin/claude"
  _out="$(env PATH="$_d/bin:$MIN_PATH" HOME="$_d/home" \
    SEARCHFLOW_STATE_DIR="$_d/state" SEARCHFLOW_PREFLIGHT_ENHANCED=0 \
    SEARCHFLOW_NODE= SEARCHFLOW_TEST_TARBALL= SEARCHFLOW_TEST_SHASUMS= \
    PREFLIGHT_STUB_LIST_MISS=0 \
    bash "$SELF_PATH" --json --no-install 2>"$_d/err")"
  _rc=$?
  _mcp_pos="$(json_get mcp "$_out")"
  _out="$(env PATH="$_d/bin:$MIN_PATH" HOME="$_d/home" \
    SEARCHFLOW_STATE_DIR="$_d/state" SEARCHFLOW_PREFLIGHT_ENHANCED=0 \
    SEARCHFLOW_NODE= SEARCHFLOW_TEST_TARBALL= SEARCHFLOW_TEST_SHASUMS= \
    PREFLIGHT_STUB_LIST_MISS=1 \
    bash "$SELF_PATH" --json --no-install 2>>"$_d/err")"
  _rc2=$?
  _mcp_neg="$(json_get mcp "$_out")"
  if [ "$_mcp_pos" = "present" ] && [ "$_mcp_neg" = "skipped-no-install" ] && [ "$_rc" -eq 0 ] && [ "$_rc2" -eq 0 ]; then _ok=0; else _ok=1; fi
  report_case "$_ok" "F6 plugin-registered-via-list" "list_has_searchflow -> mcp=$_mcp_pos (expect present) / list_empty -> mcp=$_mcp_neg (expect skipped-no-install) exit=$_rc,$_rc2"

  # F7 — 호스트가 시한 안에 답하지 않음: 가짜 claude 가 `mcp list` 에서 HOST_LIMIT+2s 잠든다.
  #      기대 = mcp=unknown-host-timeout + 등록 시도(add) 0건. 양성 대조 = 같은 stub 이 즉시 답하면 present.
  #      node 는 portable 캐시 stub 으로 준다(설치 경로가 열려 있어야 「add 를 안 했다」가 뜻을 가진다 · 네트워크 0).
  #      잠드는 시간은 HOST_LIMIT 의 2배로 준다 — run_limited 는 1초 폴링이라 실제 상한이 한 바퀴(약 7%) 늦게 걸린다.
  _d="$BASE_TMP/f7"; mkdir -p "$_d/state/node/current/bin" "$_d/home" "$_d/bin"
  cat > "$_d/state/node/current/bin/node" <<'PREFLIGHT_TEST_STUB'
#!/bin/sh
case "${1:-}" in
  -v|--version) echo "v20.0.0" ;;
  *) exit 0 ;;
esac
PREFLIGHT_TEST_STUB
  chmod +x "$_d/state/node/current/bin/node"
  cat > "$_d/bin/claude" <<'PREFLIGHT_SLOW_STUB'
#!/bin/sh
# 테스트용 가짜 호스트. 호출을 기록하고, get 은 항상 못 찾고, list 는 PREFLIGHT_STUB_SLOW_LIST 로 갈린다.
printf '%s\n' "$*" >> "${PREFLIGHT_STUB_LOG:-/dev/null}"
if [ "${1:-}" = "mcp" ] && [ "${2:-}" = "get" ]; then
  echo 'No MCP server named "searchflow"' >&2
  exit 1
fi
if [ "${1:-}" = "mcp" ] && [ "${2:-}" = "list" ]; then
  if [ "${PREFLIGHT_STUB_SLOW_LIST:-0}" = "1" ]; then
    sleep "${PREFLIGHT_STUB_SLEEP:-32}"
  fi
  echo 'plugin:searchflow:searchflow: node /opt/bundle/skills/searchflow/scripts/mcp-server.mjs - Connected'
  exit 0
fi
exit 1
PREFLIGHT_SLOW_STUB
  chmod +x "$_d/bin/claude"
  _slow_log="$_d/slow.log"; : > "$_slow_log"
  _out="$(env PATH="$_d/bin:$MIN_PATH" HOME="$_d/home" \
    SEARCHFLOW_STATE_DIR="$_d/state" SEARCHFLOW_PREFLIGHT_ENHANCED=0 \
    SEARCHFLOW_NODE= SEARCHFLOW_TEST_TARBALL= SEARCHFLOW_TEST_SHASUMS= \
    PREFLIGHT_STUB_SLOW_LIST=1 PREFLIGHT_STUB_SLEEP="$((HOST_LIMIT * 2))" \
    PREFLIGHT_STUB_LOG="$_slow_log" \
    bash "$SELF_PATH" --json 2>"$_d/err")"
  _rc=$?
  _mcp_slow="$(json_get mcp "$_out")"
  _add_calls="$(count_fixed 'mcp add' "$(cat "$_slow_log" 2>/dev/null)")"
  _fast_log="$_d/fast.log"; : > "$_fast_log"
  _out="$(env PATH="$_d/bin:$MIN_PATH" HOME="$_d/home" \
    SEARCHFLOW_STATE_DIR="$_d/state" SEARCHFLOW_PREFLIGHT_ENHANCED=0 \
    SEARCHFLOW_NODE= SEARCHFLOW_TEST_TARBALL= SEARCHFLOW_TEST_SHASUMS= \
    PREFLIGHT_STUB_SLOW_LIST=0 \
    PREFLIGHT_STUB_LOG="$_fast_log" \
    bash "$SELF_PATH" --json 2>>"$_d/err")"
  _rc2=$?
  _mcp_fast="$(json_get mcp "$_out")"
  if [ "$_mcp_slow" = "unknown-host-timeout" ] && [ "$_add_calls" -eq 0 ] && [ "$_mcp_fast" = "present" ] && [ "$_rc" -eq 0 ] && [ "$_rc2" -eq 0 ]; then _ok=0; else _ok=1; fi
  report_case "$_ok" "F7 host-timeout" "slow_list -> mcp=$_mcp_slow (expect unknown-host-timeout) add_calls=$_add_calls (expect 0) / fast_list -> mcp=$_mcp_fast (expect present) exit=$_rc,$_rc2"

  printf '%d/%d PASS\n' "$TEST_PASS" "$((TEST_PASS + TEST_FAIL))"
  [ "$TEST_FAIL" -eq 0 ] || return 1
  return 0
}

# ── 네트워크 테스트 (실다운로드 1회 · 임시 STATE) ───────────────────────────
test_network() {
  NET_TMP="$(mktemp -d "${TMPDIR:-/tmp}/searchflow-preflight-net.XXXXXX")" || {
    printf 'FAIL N1 network-install — cannot create a temporary directory\n'
    return 1
  }
  mkdir -p "$NET_TMP/state" "$NET_TMP/home"
  printf 'temp state dir: %s\n' "$NET_TMP/state"
  _t0="$(date +%s)"
  _out="$(env PATH="/usr/bin:/bin" HOME="$NET_TMP/home" \
    SEARCHFLOW_STATE_DIR="$NET_TMP/state" SEARCHFLOW_PREFLIGHT_ENHANCED=0 \
    SEARCHFLOW_NODE= SEARCHFLOW_TEST_TARBALL= SEARCHFLOW_TEST_SHASUMS= \
    bash "$SELF_PATH" --json 2>"$NET_TMP/err")"
  _rc=$?
  _t1="$(date +%s)"
  _elapsed=$((_t1 - _t0))
  printf 'stderr:\n'
  sed 's/^/  /' "$NET_TMP/err" 2>/dev/null
  printf 'stdout: %s\n' "$_out"
  _src="$(json_get node_source "$_out")"
  _bin="$(json_get node "$_out")"
  _ver_run=""
  if [ -n "$_bin" ] && [ -x "$_bin" ]; then _ver_run="$("$_bin" -v 2>/dev/null)"; fi
  _major="$(node_major "$_ver_run")"
  if [ "$_src" = "portable" ] && [ -n "$_major" ] && [ "$_major" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null; then _ok=0; else _ok=1; fi
  report_case "$_ok" "N1 network-install" "node_source=$_src installed_node_v=${_ver_run:-none} elapsed=${_elapsed}s exit=$_rc"
  rm -rf "$NET_TMP"
  printf 'temp state dir removed: %s\n' "$NET_TMP"
  printf '%d/%d PASS\n' "$TEST_PASS" "$((TEST_PASS + TEST_FAIL))"
  [ "$TEST_FAIL" -eq 0 ] || return 1
  return 0
}

if [ "$OPT_TEST" -eq 1 ]; then
  self_test
  exit $?
fi
if [ "$OPT_TEST_NETWORK" -eq 1 ]; then
  test_network
  exit $?
fi

main
