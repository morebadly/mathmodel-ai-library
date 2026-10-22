#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/.runtime/ragflow/docker"
if [ -f "$ROOT/.runtime/proxy.env" ]; then set -a; source "$ROOT/.runtime/proxy.env"; set +a; fi
if [ "$(cat /proc/1/comm)" = systemd ]; then systemctl start docker; fi
docker info >/dev/null
current="$(sysctl -n vm.max_map_count)"
if [ "$current" -lt 262144 ]; then sysctl -w vm.max_map_count=262144 >/dev/null; fi
export COMPOSE_PROJECT_NAME=mathmodel-ragflow
docker compose -f docker-compose.yml -f ../../compose.local.yml config --services
docker compose --progress plain -f docker-compose.yml -f ../../compose.local.yml up -d --quiet-pull
docker compose -f docker-compose.yml -f ../../compose.local.yml ps --format 'table {{.Name}}\t{{.State}}\t{{.Health}}'
