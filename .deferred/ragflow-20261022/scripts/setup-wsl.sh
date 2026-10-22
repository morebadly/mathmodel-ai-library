#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq docker.io docker-compose-v2 curl ca-certificates python3
if [ "$(cat /proc/1/comm)" = systemd ]; then
  systemctl enable --now docker
else
  if ! docker info >/dev/null 2>&1; then
    nohup dockerd > /var/log/mathmodel-docker.log 2>&1 &
  fi
fi
for attempt in $(seq 1 20); do
  if docker info >/dev/null 2>&1; then break; fi
  sleep 1
done
docker version --format '{{.Server.Version}}'
docker compose version
