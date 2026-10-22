#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
project_prefix="${PLEIADES_CONDA_PREFIX:-$project_root/.conda-fonts}"
if [[ "$project_prefix" != /* ]]; then
  echo 'PLEIADES_CONDA_PREFIX must be an absolute path.' >&2
  exit 1
fi
if [[ -f "$project_root/.deploy/current.json" || -e "$project_root/.deploy/transaction.json" || -e "$project_root/.deploy/lock" ]]; then
  echo 'Finish or recover pending deployments and undeploy managed bots before updating the runtime.' >&2
  exit 1
fi
# Never prune Node from a legacy environment which a deployed release might still use.
if [[ -e "$project_prefix/bin/node" ]]; then
  echo 'The selected Conda prefix contains Node.js. Select a new fonts-only PLEIADES_CONDA_PREFIX.' >&2
  exit 1
fi
if [[ -n "${PLEIADES_NODE_PREFIX:-}" ]]; then
  echo 'Unset PLEIADES_NODE_PREFIX during setup; setup creates a versioned runtime under .runtime.' >&2
  exit 1
fi
conda_command="${CONDA_EXE:-$(command -v conda || true)}"
if [[ -z "$conda_command" || ! -x "$conda_command" ]]; then
  echo 'Conda is required. Set CONDA_EXE to the Conda executable and retry.' >&2
  exit 1
fi
bootstrap_node="$(command -v node || true)"
if [[ -z "$bootstrap_node" ]]; then
  echo 'An existing Node.js with built-in fetch is required to bootstrap the official runtime.' >&2
  exit 1
fi
if [[ -d "$project_prefix/conda-meta" ]]; then
  "$conda_command" env update --prefix "$project_prefix" --file "$project_root/environment.yml" --prune
else
  "$conda_command" env create --prefix "$project_prefix" --file "$project_root/environment.yml" --yes
fi
export PLEIADES_CONDA_PREFIX="$project_prefix"
export PLEIADES_FONT_DIR="$project_prefix/fonts"
unset NODE_PATH npm_config_prefix NPM_CONFIG_PREFIX
cd "$project_root"
node_prefix="$("$bootstrap_node" scripts/setup-node.mjs)"
export PLEIADES_NODE_PREFIX="$node_prefix"
export PATH="$node_prefix/bin:$PATH"
# A clean install rebuilds native dependencies for the selected official runtime.
"$node_prefix/bin/node" scripts/runtime.mjs exec npm ci
"$node_prefix/bin/node" scripts/runtime.mjs exec node -r ts-node/register -e 'require("./src/infra/graphics/canvas-font").ensureCanvasFont(); if (!require("./src/infra/graphics/canvas-emoji").renderEmojiImage("\u{1F44D}", 28)) throw new Error("Emoji font cannot render a colour glyph");'
