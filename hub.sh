#!/bin/bash
# Central de migração do Snake IA. Chamado SÓ pelo authorized_keys (command="..."), nunca à mão.
# SSH_ORIGINAL_COMMAND = "sync <ilha>"; stdin = estado da ilha; stdout = estado das outras ilhas (1 JSON por linha).
set -euo pipefail
HUB=/opt/snake-ia/hub
read -r op island extra <<<"${SSH_ORIGINAL_COMMAND:-}"
if [[ "$op" != "sync" || ! "$island" =~ ^[a-z0-9-]{1,32}$ || -n "${extra:-}" ]]; then echo "comando inválido" >&2; exit 1; fi
tmp="$HUB/.$island.tmp"
head -c 4000000 > "$tmp"
mv "$tmp" "$HUB/$island.json"
for f in "$HUB"/*.json; do [[ "$f" == "$HUB/$island.json" ]] || { cat "$f"; echo; }; done
