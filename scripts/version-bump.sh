#!/bin/bash

# Version bump script for ReplyMate Chrome Extension
set -e

echo "🚀 ReplyMate Version Bump Utility"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Default values
BUMP_TYPE=""
NEW_VERSION=""
DRY_RUN=false

# Function to show usage
usage() {
    echo -e "${BLUE}Usage: $0 [OPTIONS]${NC}"
    echo ""
    echo -e "${YELLOW}Options:${NC}"
    echo "  -t, --type TYPE     Bump type: major, minor, patch, or custom"
    echo "  -v, --version VER   Custom version (use with --type custom)"
    echo "  -d, --dry-run       Show what would be changed without making changes"
    echo "  -h, --help         Show this help message"
    echo ""
    echo -e "${YELLOW}Examples:${NC}"
    echo "  $0 --type patch              # Bump patch version (0.2.0 -> 0.2.1)"
    echo "  $0 --type minor              # Bump minor version (0.2.0 -> 0.3.0)"
    echo "  $0 --type major              # Bump major version (0.2.0 -> 1.0.0)"
    echo "  $0 --type custom -v 1.5.0    # Set custom version"
    echo "  $0 --type patch --dry-run    # Preview changes"
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -t|--type)
            BUMP_TYPE="$2"
            shift 2
            ;;
        -v|--version)
            NEW_VERSION="$2"
            shift 2
            ;;
        -d|--dry-run)
            DRY_RUN=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo -e "${RED}❌ Unknown option: $1${NC}"
            usage
            exit 1
            ;;
    esac
done

# Validate bump type
if [[ ! "$BUMP_TYPE" =~ ^(major|minor|patch|custom)$ ]]; then
    echo -e "${RED}❌ Invalid bump type. Use: major, minor, patch, or custom${NC}"
    usage
    exit 1
fi

# Check if custom version is provided for custom bump
if [[ "$BUMP_TYPE" == "custom" && -z "$NEW_VERSION" ]]; then
    echo -e "${RED}❌ Custom version required when using --type custom${NC}"
    usage
    exit 1
fi

# Get current version from manifest
if [[ ! -f "src/manifest.json" ]]; then
    echo -e "${RED}❌ src/manifest.json not found${NC}"
    exit 1
fi

CURRENT_VERSION=$(node -p "require('./src/manifest.json').version" 2>/dev/null)
if [[ $? -ne 0 || -z "$CURRENT_VERSION" ]]; then
    echo -e "${RED}❌ Could not read current version from manifest.json${NC}"
    exit 1
fi

echo -e "${BLUE}📋 Current version: ${CURRENT_VERSION}${NC}"

# Calculate new version
if [[ "$BUMP_TYPE" != "custom" ]]; then
    # Parse current version
    IFS='.' read -ra VERSION_PARTS <<< "$CURRENT_VERSION"
    MAJOR=${VERSION_PARTS[0]}
    MINOR=${VERSION_PARTS[1]}
    PATCH=${VERSION_PARTS[2]}

    # Bump version based on type
    case $BUMP_TYPE in
        major)
            MAJOR=$((MAJOR + 1))
            MINOR=0
            PATCH=0
            ;;
        minor)
            MINOR=$((MINOR + 1))
            PATCH=0
            ;;
        patch)
            PATCH=$((PATCH + 1))
            ;;
    esac

    NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
fi

echo -e "${GREEN}🎯 New version: ${NEW_VERSION}${NC}"

# Validate new version format
if [[ ! "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo -e "${RED}❌ Invalid version format. Use semantic versioning (x.y.z)${NC}"
    exit 1
fi

# Check if new version is actually newer (for non-custom bumps)
if [[ "$BUMP_TYPE" != "custom" ]]; then
    if [[ "$NEW_VERSION" == "$CURRENT_VERSION" ]]; then
        echo -e "${YELLOW}⚠️  New version is the same as current version${NC}"
        exit 0
    fi
fi

if [[ "$DRY_RUN" == "true" ]]; then
    echo -e "${YELLOW}🔍 DRY RUN - No changes will be made${NC}"
    echo ""
    echo -e "${BLUE}Files that would be updated:${NC}"
    echo "  - src/manifest.json: version field"
    echo "  - package.json: version field (if exists)"
    echo ""
    echo -e "${BLUE}Git operations that would be performed:${NC}"
    echo "  - git add src/manifest.json package.json"
    echo "  - git commit -m \"chore: bump version to v${NEW_VERSION}\""
    echo "  - git tag v${NEW_VERSION}"
    echo ""
    exit 0
fi

# Update manifest.json
echo -e "${YELLOW}📝 Updating manifest.json...${NC}"
node -e "
const fs = require('fs');
const manifest = require('./src/manifest.json');
manifest.version = '${NEW_VERSION}';
fs.writeFileSync('./src/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
"

# Re-format the JSON files through prettier so CI's format:check stays green.
# (Bug fix: JSON.stringify(.., 2) emits multi-line arrays that conflict with
# prettier's default short-array collapse → CI format:check failed on every
# release commit. Run prettier here once instead of needing a follow-up
# "style: reformat after version bump" commit each time.)
if [[ -d "node_modules/.bin" ]] && [[ -x "node_modules/.bin/prettier" ]]; then
    echo -e "${YELLOW}🎨 Re-formatting JSON through prettier...${NC}"
    npx prettier --write src/manifest.json >/dev/null 2>&1 || true
fi

# Update package.json if it exists
if [[ -f "package.json" ]]; then
    echo -e "${YELLOW}📝 Updating package.json...${NC}"
    npm version --no-git-tag-version "${NEW_VERSION}"
fi

# Git operations
if command -v git >/dev/null 2>&1 && [[ -d ".git" ]]; then
    echo -e "${YELLOW}📝 Creating git commit and tag...${NC}"
    
    # Add files
    git add src/manifest.json
    if [[ -f "package.json" ]]; then
        git add package.json
    fi
    
    # Commit
    git commit -m "chore: bump version to v${NEW_VERSION}"
    
    # Create tag
    git tag "v${NEW_VERSION}"
    
    echo -e "${GREEN}✅ Git commit and tag created${NC}"
    echo -e "${BLUE}💡 Don't forget to push: git push && git push --tags${NC}"
else
    echo -e "${YELLOW}⚠️  Git not available or not a git repository${NC}"
fi

echo -e "${GREEN}✅ Version bump completed successfully!${NC}"
echo -e "${GREEN}🎉 ReplyMate updated from ${CURRENT_VERSION} to ${NEW_VERSION}${NC}"
