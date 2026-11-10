#!/bin/sh
# A job's container does nothing by itself: the executor starts every process
# in it with `exec()`. The entrypoint only prepares the trust store and stays
# alive until the container is destroyed.
set -eu
/opt/stratum/trust-ca.sh || echo "warning: could not install the interception CA" >&2
exec sleep infinity
