#!/usr/bin/env bash
# build-and-export-coordinator.sh
# Build the AWARE coordinator image, then export it as a tarball so it can be
# `docker load`-ed into a colima/dev host.
#
# 2026-11-17 (t_091892e3): the build no longer clones rl-pipeline from an
# external git server, so it no longer needs a host with DNS access to one.
# The image ships the repo's own vendored copy (backend/heavy-think/src).

set -euo pipefail

# ─── Configuration ──────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Optional: output tarball path. Default: ./aware-coordinator-<timestamp>.tar
OUTPUT_TAR="${OUTPUT_TAR:-./aware-coordinator-$(date +%Y%m%d-%H%M%S).tar}"

# Image tag (must match what the dev host expects when running the container).
IMAGE_TAG="${IMAGE_TAG:-aware-coordinator:0.4.5-phase4-rl-pipeline-from-internal-git}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-aware-2}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.coordinator.yml}"

# ─── Preflight ──────────────────────────────────────────────────────────────
echo "=== AWARE coordinator build-and-export ==="
echo "REPO_ROOT:        $REPO_ROOT"
echo "IMAGE_TAG:        $IMAGE_TAG"
echo "OUTPUT_TAR:       $OUTPUT_TAR"
echo "COMPOSE_PROJECT:  $COMPOSE_PROJECT"
echo ""

# Sanity-check the source-tree edits are present (the durable fix from t_c9246f65).
echo "=== Verifying source-tree edits are in place ==="
grep -q "^COPY src/audit ./src/audit$" Dockerfile.coordinator || {
  echo "ERROR: Dockerfile.coordinator is missing the 'COPY src/audit' line." >&2
  echo "Apply the edits from kanban t_c9246f65 first." >&2
  exit 1
}
grep -q "mkdir -p /data/audit" Dockerfile.coordinator || {
  echo "ERROR: Dockerfile.coordinator is missing the '/data/audit' mkdir." >&2
  echo "Apply the edits from kanban t_c9246f65 first." >&2
  exit 1
}
test -f src/audit/package.json || {
  echo "ERROR: src/audit/package.json is missing." >&2
  echo "Apply the edits from kanban t_c9246f65 first." >&2
  exit 1
}
test "$(cat src/audit/package.json)" = '{"type":"commonjs"}' || {
  echo "ERROR: src/audit/package.json content is wrong." >&2
  echo "Expected: {\"type\":\"commonjs\"}" >&2
  echo "Got: $(cat src/audit/package.json)" >&2
  exit 1
}
echo "  ✓ COPY src/audit in Dockerfile.coordinator"
echo "  ✓ /data/audit mkdir in Dockerfile.coordinator"
echo "  ✓ src/audit/package.json with commonjs type"
echo ""

# Verify the rl-pipeline copy the image ships is the repo's own vendored
# tree. The build no longer clones rl-pipeline from an external git server,
# so there is no remote to reach and no tag to bump — but the vendored tree
# MUST exist, or the image would ship an empty /app/rl-pipeline and the
# coordinator would fail to import it at runtime.
test -f backend/heavy-think/src/verify.js || {
  echo "ERROR: backend/heavy-think/src/verify.js is missing." >&2
  echo "The image ships the repo's vendored rl-pipeline copy; without it the" >&2
  echo "coordinator has no judge path to load." >&2
  exit 1
}
test -f backend/heavy-think/src/index.js || {
  echo "ERROR: backend/heavy-think/src/index.js is missing." >&2
  exit 1
}
echo "  ✓ vendored rl-pipeline tree present (backend/heavy-think/src)"
echo ""

# 2026-11-17 (t_091892e3): the DNS-access preflight for the internal git
# server is GONE. The build no longer clones rl-pipeline from a git remote,
# so the build host needs no DNS access to one.

# ─── Build ──────────────────────────────────────────────────────────────────
echo "=== Building image (no cache) ==="
DOCKER_BUILDKIT=1 docker compose \
  -f "$COMPOSE_FILE" \
  -p "$COMPOSE_PROJECT" \
  build --no-cache aware-coordinator

# Tag the compose-built image with our stable IMAGE_TAG so docker save uses it.
# Compose tags images as <project>-<service> by default (aware-2-aware-coordinator).
COMPOSE_BUILT_TAG="${COMPOSE_PROJECT}-aware-coordinator"
echo ""
echo "=== Tagging $COMPOSE_BUILT_TAG → $IMAGE_TAG ==="
docker tag "$COMPOSE_BUILT_TAG" "$IMAGE_TAG"

# ─── Verify the baked-in audit chain (mirrors the live hot-patch) ────────────
echo ""
echo "=== Inspecting built image ==="
docker run --rm "$IMAGE_TAG" sh -c '
  echo "Files in /app/src/audit/:"
  ls -la /app/src/audit/ 2>&1
  echo ""
  echo "Package.json contents:"
  cat /app/src/audit/package.json 2>&1
  echo ""
  echo "Decision-logger source present:"
  head -5 /app/src/audit/decision-logger.js 2>&1
  echo ""
  echo "Data dir ownership baked in:"
  ls -ld /data/audit 2>&1
'

# ─── Export ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Exporting image to $OUTPUT_TAR ==="
docker save "$IMAGE_TAG" -o "$OUTPUT_TAR"

echo ""
echo "=== Build summary ==="
echo "  Image:  $IMAGE_TAG ($(docker inspect --format='{{.Size}}' "$IMAGE_TAG" | numfmt --to=iec --suffix=B))"
echo "  Tarball: $OUTPUT_TAR ($(du -h "$OUTPUT_TAR" | cut -f1))"
echo ""
echo "=== Next steps on the dev host (the colima instance) ==="
echo "  1. Copy $OUTPUT_TAR to the dev host:"
echo "     scp $OUTPUT_TAR user@devhost:~/"
echo ""
echo "  2. On the dev host, load the image into colima's docker:"
echo "     docker load -i ~/$OUTPUT_TAR"
echo ""
echo "  3. Force-recreate the running container to use the new image:"
echo "     docker compose -f docker-compose.coordinator.yml -p $COMPOSE_PROJECT up -d --force-recreate aware-2-coordinator"
echo ""
echo "  4. Run the verification steps from kanban t_c9246f65:"
echo "     - docker exec aware-2-coordinator ls -la /app/src/audit/    # should show decision-logger.js + package.json"
echo "     - docker exec aware-2-coordinator ls -la /data/audit/       # should be aware:aware"
echo "     - docker logs aware-2-coordinator --since 30s | grep -c 'decision-logger unavailable'  # should be 0"
echo "     - send a /coordinate probe and confirm no warnings"
echo ""
echo "Done."