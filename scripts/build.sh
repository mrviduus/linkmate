#!/bin/bash

# Build script for ReplyMate Chrome Extension.
# Enforces Constitution v1.1 §II quality gates, then delegates to Parcel.
#
# Why we DON'T run a raw `tsc + cp manifest.json` pipeline anymore:
#   - manifest.json references `background.ts` and `linkedin-content.ts`
#   - Chrome cannot load TypeScript directly; Parcel rewrites the manifest
#     to point at the compiled .js entries on its way out
#   - A standalone tsc compile would leave dist/manifest.json broken
# Source of truth for the build is `npm run build` (Parcel webextension config).

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "🚀 Starting ReplyMate build process..."

# Check dependencies
command -v npm >/dev/null 2>&1 || { echo -e "${RED}❌ npm is required but not installed.${NC}" >&2; exit 1; }

if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}📦 Installing dependencies...${NC}"
    npm ci
fi

# Quality gates — must pass before build (Constitution v1.1 §II)
echo -e "${YELLOW}🔍 Running type checks...${NC}"
npm run type-check

echo -e "${YELLOW}🧹 Running linter (--max-warnings=0)...${NC}"
npm run lint

echo -e "${YELLOW}🧪 Running test suite...${NC}"
npm run test:ci

# Clean + Parcel build (the only build that actually produces a loadable extension)
echo -e "${YELLOW}🧼 Cleaning previous build...${NC}"
rm -rf dist/ .parcel-cache/

echo -e "${YELLOW}📦 Building with Parcel (webextension config)...${NC}"
npm run build

# Validate the Parcel-rewritten manifest
echo -e "${YELLOW}✅ Validating manifest...${NC}"
node -e "
const manifest = require('./dist/manifest.json');
if (!manifest.name || !manifest.version || manifest.manifest_version !== 3) {
  console.error('❌ Invalid manifest.json');
  process.exit(1);
}
console.log('✅ Manifest is valid:', manifest.name, 'v' + manifest.version);
"

echo -e "${GREEN}✅ Build completed successfully!${NC}"
echo -e "${GREEN}📁 Build output: ./dist/${NC}"

echo -e "\n${YELLOW}📊 Build size report:${NC}"
du -sh dist/* | sort -hr
echo ""
