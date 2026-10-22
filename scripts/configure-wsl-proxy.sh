#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
gateway="$(ip route show default | awk '{print $3; exit}')"
port="${1:-7897}"
proxy="http://$gateway:$port"
http_code="$(curl --proxy "$proxy" --connect-timeout 5 --max-time 12 -s -o /dev/null -w '%{http_code}' https://registry-1.docker.io/v2/)"
if [ "$http_code" != 401 ]; then printf 'Local proxy is not available; Docker configuration unchanged.\n'; exit 1; fi
mkdir -p /etc/systemd/system/docker.service.d
printf '[Service]\nEnvironment="HTTP_PROXY=%s"\nEnvironment="HTTPS_PROXY=%s"\nEnvironment="NO_PROXY=localhost,127.0.0.1,::1"\n' "$proxy" "$proxy" > /etc/systemd/system/docker.service.d/mathmodel-proxy.conf
systemctl daemon-reload
systemctl restart docker
printf 'MATHMODEL_PROXY_URL=%s\n' "$proxy" > "$ROOT/.runtime/proxy.env"
printf 'Dedicated WSL Docker now uses the existing host proxy.\n'
