#!/bin/sh
# Package dist/ in a Debian 13 container and check the result with lintian
# (make deb-package): the same tools on every host, the CI runner included.
# The image, with debhelper and lintian, is made on first use; remove it
# (podman rmi localhost/cockpit-samba-dc-deb:trixie) to get newer tools.
set -eu

engine=${CONTAINER:-$(command -v podman || command -v docker || true)}
[ -n "$engine" ] || { echo "deb-container: podman or docker is needed" >&2; exit 1; }
image=localhost/cockpit-samba-dc-deb:trixie

if ! "$engine" image inspect "$image" >/dev/null 2>&1; then
    context=$(mktemp -d)
    trap 'rm -rf "$context"' EXIT
    "$engine" build -t "$image" -f - "$context" <<'CONTAINERFILE'
FROM docker.io/library/debian:trixie
RUN apt-get update \
 && apt-get install -y --no-install-recommends debhelper lintian make \
 && rm -rf /var/lib/apt/lists/*
CONTAINERFILE
fi

# Files written in the work tree belong to the user who runs this. The
# "docker" command may be podman's emulation.
if "$engine" --version 2>/dev/null | grep -qi podman; then
    user=--userns=keep-id
else
    user=--user=$(id -u):$(id -g)
fi

# label=disable: mount the work tree without relabelling it for SELinux.
"$engine" run --rm "$user" --security-opt label=disable -e HOME=/tmp \
    -v "$PWD:/src" -w /src "$image" \
    sh -ec 'make --no-print-directory deb-binary
            lintian --fail-on error,warning --info build/*.deb'
