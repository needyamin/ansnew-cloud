#!/usr/bin/env bash
#
# Publish the four ANSNEW CLOUD images to a registry.
#
# Each component gets its own tag in a single repository, e.g. for
# `needyamin/ansnew-cloud` with version 1.0.0:
#
#   needyamin/ansnew-cloud:nginx        needyamin/ansnew-cloud:nginx-1.0.0
#   needyamin/ansnew-cloud:php          needyamin/ansnew-cloud:php-1.0.0
#   needyamin/ansnew-cloud:ws           needyamin/ansnew-cloud:ws-1.0.0
#   needyamin/ansnew-cloud:nas          needyamin/ansnew-cloud:nas-1.0.0
#
# Docker Hub allows only ONE slash in a repository path (namespace/repository),
# which is why this is one repo with four tags rather than four nested paths.
#
# Usage
#   scripts/publish-images.sh <repository> [version] [options]
#
#   scripts/publish-images.sh needyamin/ansnew-cloud 1.0.0
#   scripts/publish-images.sh ghcr.io/needyamin/ansnew-cloud 1.0.0
#   scripts/publish-images.sh myuser/ansnew-cloud 2.1.0 --no-build
#   scripts/publish-images.sh myuser/ansnew-cloud 1.0.0 --dry-run
#
# Options
#   --no-build     use the images already present locally
#   --no-latest    push only the version tags, not the moving `latest` tags
#   --dry-run      print what would happen; push nothing
#
# You must be logged in first:  docker login
#
set -euo pipefail

REPO=""
VERSION=""
DO_BUILD=1
PUSH_LATEST=1
DRY_RUN=0

while [ $# -gt 0 ]; do
    case "$1" in
        --no-build)  DO_BUILD=0; shift ;;
        --no-latest) PUSH_LATEST=0; shift ;;
        --dry-run)   DRY_RUN=1; shift ;;
        -h|--help)   sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*)          echo "unknown option: $1" >&2; exit 2 ;;
        *)           if [ -z "$REPO" ]; then REPO="$1"; elif [ -z "$VERSION" ]; then VERSION="$1"; else
                         echo "unexpected argument: $1" >&2; exit 2; fi
                     shift ;;
    esac
done

[ -n "$REPO" ] || { echo "usage: $0 <repository> [version] [--no-build] [--no-latest] [--dry-run]" >&2; exit 2; }
[ -n "$VERSION" ] || VERSION="1.0.0"

cd "$(dirname "$0")/.."

# component -> local image that `docker compose build` produces
COMPONENTS=(nginx php ws nas)

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ------------------------------------------------------------------ build
if [ "$DO_BUILD" -eq 1 ]; then
    say "Building images"
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "  (dry run) docker compose --profile nas --profile mysql build"
    else
        # The nas image only exists behind its profile, so build it explicitly.
        docker compose --profile nas --profile mysql build
    fi
else
    say "Skipping build (--no-build)"
fi

# ------------------------------------------------------------------- tags
TARGETS=()
for c in "${COMPONENTS[@]}"; do
    TARGETS+=("${REPO}:${c}-${VERSION}")
    [ "$PUSH_LATEST" -eq 1 ] && TARGETS+=("${REPO}:${c}")
done

say "Tagging ${#TARGETS[@]} references"
for c in "${COMPONENTS[@]}"; do
    src="ansnew/${c}:latest"
    if ! docker image inspect "$src" >/dev/null 2>&1; then
        echo "  ! missing local image $src — build it first (drop --no-build)" >&2
        exit 1
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "  (dry run) $src  ->  ${REPO}:${c}-${VERSION}"
        [ "$PUSH_LATEST" -eq 1 ] && echo "  (dry run) $src  ->  ${REPO}:${c}"
        continue
    fi
    docker tag "$src" "${REPO}:${c}-${VERSION}"
    echo "  ${src}  ->  ${REPO}:${c}-${VERSION}"
    if [ "$PUSH_LATEST" -eq 1 ]; then
        docker tag "$src" "${REPO}:${c}"
        echo "  ${src}  ->  ${REPO}:${c}"
    fi
done

# ------------------------------------------------------------------- push
say "Pushing to ${REPO}"
if [ "$DRY_RUN" -eq 1 ]; then
    for t in "${TARGETS[@]}"; do echo "  (dry run) docker push $t"; done
    echo
    echo "Dry run complete. Re-run without --dry-run to publish."
    exit 0
fi

# Push the smallest image first so an auth or naming problem surfaces before we
# upload hundreds of megabytes.
ORDER=(nginx ws nas php)
failed=0
for c in "${ORDER[@]}"; do
    tags=("${REPO}:${c}-${VERSION}")
    [ "$PUSH_LATEST" -eq 1 ] && tags+=("${REPO}:${c}")
    for t in "${tags[@]}"; do
        printf '  pushing %s ... ' "$t"
        if out=$(docker push "$t" 2>&1); then
            echo "ok"
        else
            echo "FAILED"
            echo "$out" | tail -4 | sed 's/^/      /'
            failed=1
        fi
    done
done

if [ "$failed" -ne 0 ]; then
    cat >&2 <<'EOF'

Push failed. The usual causes:

  1. Not logged in — run `docker login` (Docker Hub) and re-run this script.
     A push without credentials fails with
     "insufficient_scope: authorization failed".
  2. The repository path does not match your account. On Docker Hub the first
     segment must be your username or organisation, exactly — the GitHub
     username is not always the Docker Hub one. Check at
     https://hub.docker.com/repositories
  3. For ghcr.io, log in with a token that has `write:packages`:
     echo "$GITHUB_TOKEN" | docker login ghcr.io -u <username> --password-stdin
  4. The repository is private and the credential lacks push scope.

Re-running is safe: layers already uploaded are skipped.
EOF
    exit 1
fi

cat <<EOF

Published ${#TARGETS[@]} references to ${REPO}.

Deploy them by pointing .env at the same tags, then:
  docker compose pull
  docker compose up -d --no-build

(--no-build matters: the services also declare a build: context, so without it
Compose would rebuild locally and ignore what you just pulled.)
EOF
