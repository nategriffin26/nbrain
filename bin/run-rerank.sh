#!/bin/bash
# The search reranker: Qwen3-Reranker-0.6B (Q8_0 GGUF) under llama-server's /v1/rerank on RERANK_URL's port.
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
export BRAIN_HOME="${BRAIN_HOME:-$HOME/.brain}"
set -a; source "$BRAIN_HOME/env"; set +a
MODEL="$BRAIN_HOME/models/qwen3-reranker-0.6b-q8_0.gguf"
mkdir -p "$BRAIN_HOME/models"
[ -f "$MODEL" ] || curl -fL -o "$MODEL" https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/resolve/main/qwen3-reranker-0.6b-q8_0.gguf
exec llama-server --model "$MODEL" --rerank --host 127.0.0.1 --port "${RERANK_URL##*:}" -c 32768 -np 8 -b 8192 -ub 8192 -fa on --no-webui --log-verbosity 1
