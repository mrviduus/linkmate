#!/usr/bin/env bash
#
# One-command release: bump version in package.json + src/manifest.json,
# commit, tag, push. GitHub Actions (.github/workflows/release.yml) takes
# over from the tag push and creates the GitHub Release with a versioned
# zip attached.
#
# Usage:
#   scripts/release.sh 0.4.1
#   scripts/release.sh 1.0.0
#
# Pre-flight: must be on main, working tree clean, all CI green.

set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "usage: $0 <semver>  (e.g. 0.4.1)" >&2
  exit 1
fi

# Plain X.Y.Z guard. Reject leading 'v' so the tag/version always match.
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must be plain semver like 1.2.3 (no leading 'v')" >&2
  exit 1
fi

BRANCH="$(git symbolic-ref --short HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "error: not on main (currently on '$BRANCH')" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is not clean" >&2
  git status --short >&2
  exit 1
fi

# Sync with origin so we don't tag a stale main.
git fetch origin main --quiet
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "error: local main diverges from origin/main — pull/push first" >&2
  exit 1
fi

# Idempotency guard: tag must not exist already (locally or on origin).
if git rev-parse "v$VERSION" >/dev/null 2>&1; then
  echo "error: tag v$VERSION already exists locally" >&2
  exit 1
fi
if git ls-remote --tags origin "refs/tags/v$VERSION" | grep -q .; then
  echo "error: tag v$VERSION already exists on origin" >&2
  exit 1
fi

PKG="package.json"
MANIFEST="src/manifest.json"

# In-place version bump. Match the existing "version": "x.y.z" line only;
# don't touch dependency versions.
node -e "
  const fs = require('fs');
  for (const f of ['$PKG', '$MANIFEST']) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    j.version = '$VERSION';
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  }
"

echo "→ bumped to $VERSION in $PKG and $MANIFEST"

# Sanity: build + tests must pass before we tag.
echo "→ running type-check, lint, tests, build…"
npm run type-check
npm run lint
npm test -- --silent
npm run build >/dev/null

git add "$PKG" "$MANIFEST"
git commit -m "release: v$VERSION"
git tag -a "v$VERSION" -m "v$VERSION"

echo "→ pushing main + tag…"
git push origin main
git push origin "v$VERSION"

cat <<EOF

✅ Released v$VERSION

GitHub Actions will now build, zip, and publish the release with a
linkmate-v$VERSION.zip asset.

Watch: https://github.com/mrviduus/linkmate/actions
Release page: https://github.com/mrviduus/linkmate/releases/tag/v$VERSION
EOF
