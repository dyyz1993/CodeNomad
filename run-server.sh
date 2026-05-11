#!/usr/bin/env bash
set -euo pipefail
rm -rf ~/.npm/_npx 2>/dev/null
exec npx -y @dyyz1993/codenomad@0.15.49 \
  --launch \
  --password 654321 \
  --host 0.0.0.0 \
  --http-port 19900 \
  --unrestricted-root \
  --http true \
  --auth-cookie-name codenomad_session_b \
  --config ~/.config/codenomad-b/config.json \
  --tunnel-hub-url https://api.tunnel.19930810.xyz:8443
