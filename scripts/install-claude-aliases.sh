#!/usr/bin/env bash
# 一键写入 Claude Code 的 3 个 OpenSelect 别名：
#   ds-cli   付费 deepseek-v4.1-flash（走 OpenSelect 账号池）
#   free-cli 免费模型链（走 OpenSelect）
#   auto-cli coding-auto：Z.ai → MiniMax → opencode-go
#
# 所有别名只用 ANTHROPIC_AUTH_TOKEN="openselect" 占位；真实 API Key 留在
# OpenSelect 自己的 ~/.openselect/config.json，不写进 shell 配置。
set -euo pipefail

SHELL_KIND=""
FILE=""
PROXY="http://127.0.0.1:8788"
DRY_RUN=0

usage() {
  cat <<'EOF'
用法: install-claude-aliases.sh [选项]

  --shell zsh|bash   写入哪个 shell 配置（默认按 $SHELL / 已存在的 rc 文件判断）
  --file PATH        直接指定 rc 文件（测试/高级用法）
  --proxy URL        OpenSelect 代理地址，默认 http://127.0.0.1:8788
  --dry-run          只打印将写入的块，不修改文件
  -h, --help         显示帮助
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --shell) SHELL_KIND="${2:-}"; shift 2 ;;
    --file) FILE="${2:-}"; shift 2 ;;
    --proxy) PROXY="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$FILE" ]]; then
  if [[ -z "$SHELL_KIND" ]]; then
    case "$(basename "${SHELL:-}")" in
      zsh) SHELL_KIND=zsh ;;
      bash) SHELL_KIND=bash ;;
      *)
        if [[ -f "$HOME/.zshrc" ]]; then SHELL_KIND=zsh; else SHELL_KIND=bash; fi
        ;;
    esac
  fi
  case "$SHELL_KIND" in
    zsh) FILE="$HOME/.zshrc" ;;
    bash) FILE="$HOME/.bashrc" ;;
    *) echo "--shell 只能是 zsh 或 bash" >&2; exit 2 ;;
  esac
fi

PROXY="${PROXY%/}"

alias_line() {
  local name="$1" model="$2" extra="${3:-}"
  local body
  body="unset ANTHROPIC_API_KEY OPENAI_API_KEY OPENAI_BASE_URL; export NO_PROXY=\"localhost,127.0.0.1\"; export no_proxy=\"localhost,127.0.0.1\"; export ANTHROPIC_BASE_URL=\"${PROXY}\"; export ANTHROPIC_AUTH_TOKEN=\"openselect\"; export API_TIMEOUT_MS=3000000; export ANTHROPIC_MODEL=\"${model}\"; export ANTHROPIC_DEFAULT_OPUS_MODEL=\"${model}\"; export ANTHROPIC_DEFAULT_SONNET_MODEL=\"${model}\"; export ANTHROPIC_DEFAULT_HAIKU_MODEL=\"${model}\"; export CLAUDE_CODE_SUBAGENT_MODEL=\"${model}\"; export CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000; export CLAUDE_CODE_AUTO_COMPACT_WINDOW=950000; export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=90; export CLAUDE_CODE_MAX_OUTPUT_TOKENS=16000; ${extra}claude --permission-mode bypassPermissions"
  printf "alias %s='%s'\n" "$name" "$body"
}

BLOCK="$(
  echo "# >>> OpenSelect Claude aliases >>>"
  alias_line "ds-cli" "deepseek-v4.1-flash[1m]"
  alias_line "free-cli" "deepseek-v4.1-flash-free" "export CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1; "
  alias_line "auto-cli" "coding-auto[1m]"
  echo "# <<< OpenSelect Claude aliases <<<"
)"

if [[ "$DRY_RUN" == "1" ]]; then
  printf '%s\n' "$BLOCK"
  exit 0
fi

mkdir -p "$(dirname "$FILE")"
if [[ -f "$FILE" ]]; then
  cp "$FILE" "$FILE.bak.openselect-aliases-$(date +%Y%m%d-%H%M%S)"
  tmp="$(mktemp "${TMPDIR:-/tmp}/openselect-aliases.XXXXXX")"
  awk '
    /^# >>> OpenSelect Claude aliases >>>$/ { skip=1; next }
    /^# <<< OpenSelect Claude aliases <<<$/ { skip=0; next }
    !skip { print }
  ' "$FILE" > "$tmp"
  mv "$tmp" "$FILE"
else
  : > "$FILE"
fi

{
  printf '\n%s\n' "$BLOCK"
} >> "$FILE"

echo "✓ 已写入 $FILE"
echo "  使用: source \"$FILE\""
echo "  然后: ds-cli / free-cli / auto-cli"
echo "  说明: 别名里只有 ANTHROPIC_AUTH_TOKEN=\"openselect\" 占位，真实 Key 在 OpenSelect config。"
