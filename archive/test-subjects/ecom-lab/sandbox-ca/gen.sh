#!/usr/bin/env bash
# ONLY for environments behind a TLS-intercepting proxy (e.g. CI sandboxes). Generates patched copies of upstream's Dockerfiles that
# trust the proxy CA for Maven/JDK downloads (and drop `apk add curl`, replacing curl healthchecks with wget), plus a compose override. Upstream files are not modified.
#   CA_DIR=/root/.ccr CA_FILE=ca-bundle.crt ecom-lab/sandbox-ca/gen.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; UP="$HERE/../upstream"
CA_DIR="${CA_DIR:?directory containing the CA bundle}"; CA_FILE="${CA_FILE:-ca-bundle.crt}"
mkdir -p "$HERE/out"
OVR="$HERE/out/compose.ca.yml"; echo "services:" > "$OVR"
declare -A PORT=([api-gateway]=8080 [user-service]=8081 [inventory-service]=8082 [order-service]=8083 [payment-service]=8084 [review-service]=8086 [projection-service]=8087)
for svc in api-gateway user-service inventory-service order-service payment-service review-service projection-service; do
  python3 - "$UP/$svc/Dockerfile" "$HERE/out/$svc.Dockerfile" "$CA_FILE" <<'PY'
import sys
src,dst,ca=sys.argv[1:4]
out=[]
for line in open(src):
    if line.strip()=='RUN apk add --no-cache curl':
        out.append('# (sandbox) alpine CDN unreachable: curl omitted, healthcheck uses busybox wget instead\n'); continue
    out.append(line)
    if line.startswith('WORKDIR /app'):
        out.append(f"""COPY --from=ca {ca} /tmp/ca.crt
RUN cat /tmp/ca.crt >> /etc/ssl/certs/ca-certificates.crt \\
 && awk 'BEGIN{{n=0}} /BEGIN CERT/{{n++}} {{print > ("/tmp/c" n ".pem")}}' /tmp/ca.crt \\
 && for f in /tmp/c[0-9]*.pem; do keytool -importcert -noprompt -cacerts -storepass changeit -alias "sb$(basename $f .pem)" -file "$f" >/dev/null 2>&1 || true; done
""")
        pass
open(dst,'w').write(''.join(out))
PY
  cat >> "$OVR" <<YML
  $svc:
    build:
      context: $UP/$svc
      dockerfile: $HERE/out/$svc.Dockerfile
      additional_contexts: { ca: $CA_DIR }
    healthcheck:
      test: ["CMD-SHELL", "wget -q -O /dev/null http://localhost:${PORT[$svc]}/actuator/health/readiness"]
      interval: 10s
      timeout: 5s
      retries: 30
YML
done
echo "wrote $OVR"
