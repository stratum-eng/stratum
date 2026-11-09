#!/bin/sh
# Trust the certificate authority Cloudflare's HTTPS interception signs with.
#
# The job's container has no route to the internet. Every host it can reach is
# one the executor intercepts, and an intercept terminates TLS with a
# certificate from a CA that exists only at runtime, in this file. Without it
# in the trust store, `git fetch` and `npm install` fail on the certificate.
#
# Both the entrypoint and prepare.sh run this, and they can run at the same
# time: the executor starts preparing as soon as the container accepts a
# command. So "trusted" is a marker written AFTER the store is rebuilt, and a
# second caller waits for the first instead of racing a half-written bundle.
#
# Absent outside Cloudflare (a plain `docker run`), where there is nothing to do.
set -eu
CA=/etc/cloudflare/certs/cloudflare-containers-ca.crt
DONE=/run/stratum-ca-trusted
LOCK=/run/stratum-ca.lock

[ -f "$CA" ] || exit 0
[ -f "$DONE" ] && exit 0

tries=0
until mkdir "$LOCK" 2>/dev/null; do
  [ -f "$DONE" ] && exit 0
  tries=$((tries + 1))
  if [ "$tries" -gt 300 ]; then
    echo "trust-ca: timed out waiting for the trust store" >&2
    exit 1
  fi
  sleep 0.1
done
if [ ! -f "$DONE" ]; then
  cp "$CA" /usr/local/share/ca-certificates/cloudflare-containers-ca.crt
  update-ca-certificates >/dev/null 2>&1
  touch "$DONE"
fi
rmdir "$LOCK"
