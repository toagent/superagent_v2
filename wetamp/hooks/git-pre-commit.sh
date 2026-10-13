#!/usr/bin/env bash
# 三端统一 git pre-commit 护栏（L1 层，对人和 AI 都生效）
# 真源: ~/.wetamp/git-hooks/pre-commit，经 core.hooksPath 全局启用
#       ai-toolkit-manage.sh agents sync 分发到三端 + 开发机
set -o pipefail
FAILED=0
# ---------- 1. gitleaks 扫暂存区 ----------
# 只扫 staged（实测 27ms / 172B 样本），不扫历史，误报可用 gitleaks:allow 行内注释豁免
if command -v gitleaks >/dev/null 2>&1 && git rev-parse --verify HEAD >/dev/null 2>&1; then
  if ! gitleaks git --staged --no-banner --redact >/dev/null 2>&1; then
    echo "✗ pre-commit 拦截: gitleaks 在暂存区发现疑似 secret" >&2
    gitleaks git --staged --no-banner --redact 2>&1 | grep -iE "Finding|Secret|File|Line" | head -6 | sed 's/^/    /' >&2
    echo "    处理: 移除凭据 / 改走 .gitignore / 行内 gitleaks:allow 注释豁免" >&2
    FAILED=1
  fi
fi
# 首次提交（无 HEAD）时退化为 dir 扫描暂存文件
if command -v gitleaks >/dev/null 2>&1 && ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  files=$(git diff --cached --name-only 2>/dev/null)
  if [ -n "$files" ] && ! echo "$files" | xargs gitleaks dir --no-banner --redact >/dev/null 2>&1; then
    echo "✗ pre-commit 拦截: gitleaks 在首提交暂存文件中发现疑似 secret" >&2
    FAILED=1
  fi
fi
# ---------- 2. chain 调用仓库本地 pre-commit（husky 等）----------
# 全局 hooksPath 会架空 .git/hooks 与 husky，这里补上，避免静默废掉仓库自己的检查
if [ -x .git/hooks/pre-commit ]; then
  # husky v9+ 的 .git/hooks/pre-commit 只是转发器，安全直接跑
  if ! .git/hooks/pre-commit; then
    echo "✗ pre-commit: 仓库本地 hook（husky/lint-staged）失败" >&2
    FAILED=1
  fi
fi
if [ -d .husky ] && [ -x .husky/pre-commit ]; then
  if ! .husky/pre-commit; then
    echo "✗ pre-commit: .husky/pre-commit 失败" >&2
    FAILED=1
  fi
fi
exit $FAILED
