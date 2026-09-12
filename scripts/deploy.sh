#!/usr/bin/env bash
# Build and deploy this fork, stamping the image with a version that names the
# exact commit it came from.
#
# The version comes from `git describe`, so it reads like v2.8.0-108-g31d6e133:
# the upstream release this descends from, how far past it we are, and the
# commit. A tree with uncommitted changes gets a -dirty suffix, which is the
# point: a deployed build should always be traceable to source someone can read.
#
#   scripts/deploy.sh            build, deploy, verify
#   scripts/deploy.sh --build    build only
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_DIR="${AURRAL_COMPOSE_DIR:-$(dirname "$REPO_DIR")}"
IMAGE="${AURRAL_IMAGE:-aurral:fork}"
HEALTH_URL="${AURRAL_HEALTH_URL:-http://10.243.242.146:8688/api/health}"

VERSION="$(git -C "$REPO_DIR" describe --tags --always --dirty)"

if [[ "$VERSION" == *-dirty ]]; then
  echo "warning: working tree has uncommitted changes; deploying $VERSION" >&2
fi

echo "==> building $IMAGE as $VERSION"
docker build --build-arg "APP_VERSION=$VERSION" -t "$IMAGE" "$REPO_DIR"

if [[ "${1:-}" == "--build" ]]; then
  echo "==> built $VERSION (not deployed)"
  exit 0
fi

echo "==> recreating the container"
docker compose -f "$COMPOSE_DIR/docker-compose.yaml" up -d

echo "==> waiting for the app to report its version"
for _ in $(seq 1 30); do
  reported="$(curl -fsS -m 5 "$HEALTH_URL" 2>/dev/null \
    | sed -n 's/.*"appVersion":"\([^"]*\)".*/\1/p' || true)"
  if [[ -n "$reported" ]]; then
    if [[ "$reported" == "$VERSION" ]]; then
      echo "==> live: $reported"
      exit 0
    fi
    echo "deployed build reports $reported, expected $VERSION" >&2
    exit 1
  fi
  sleep 2
done

echo "the app did not report a version within 60s; check 'docker logs aurral'" >&2
exit 1
