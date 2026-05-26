# LinkMate Development Guide

This guide covers everything you need to know about developing, building, testing, and deploying LinkMate.

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ 
- npm or yarn
- Chrome browser for testing
- Git for version control

### Setup
```bash
# Clone the repository
git clone https://github.com/mrviduus/LinkMate.git
cd LinkMate

# Install dependencies
npm install

# Build the extension
npm run build

# Start development mode
npm run dev
```

## 🛠️ Development Workflow

### 1. **Development Build**
```bash
# Start watch mode for development
npm run dev

# This will:
# - Watch for file changes
# - Automatically rebuild
# - Update the dist/ folder
```

### 2. **Load Extension in Chrome**
1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top-right)
3. Click "Load unpacked"
4. Select the `dist/` folder from your project
5. The extension will appear in your extensions list

### 3. **Development Testing**
```bash
# Run all tests
npm run test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run only passing tests (skip LinkedIn integration test)
npm run test -- --testPathIgnorePatterns=linkedin-integration
```

### 4. **Code Quality**
```bash
# Check linting
npm run lint

# Auto-fix linting issues
npm run lint:fix

# Format code
npm run format

# Check formatting
npm run format:check

# TypeScript type checking
npm run type-check
```

## 📦 Building & Packaging

### Production Build
```bash
# Build for production
npm run build

# This creates optimized files in dist/
# Ready for Chrome extension loading
```

### Advanced Build (Using Scripts)
```bash
# Use custom build script (more comprehensive)
npm run build:script

# This includes:
# - Type checking
# - Linting
# - Testing
# - Building
# - Validation
# - Size reporting
```

### Packaging for Distribution
```bash
# Create ZIP packages for Chrome Web Store
npm run package

# Or step by step:
npm run build
./scripts/package.sh

# Creates:
# - packages/LinkMate-v0.2.0.zip (production)
# - packages/LinkMate-v0.2.0-dev.zip (development)
```

## 🧪 Testing Guide

### Test Structure
```
tests/
├── chrome-api.test.ts          # Chrome extension API tests
├── content.test.ts             # Content script tests
├── linkedin-integration.test.ts # LinkedIn-specific tests
├── performance-error.test.ts    # Performance & error handling
├── popup-utils.test.ts         # Popup functionality tests
├── ui-interactions.test.ts     # UI interaction tests
├── setup.ts                    # Test configuration
└── README.md                   # Testing documentation
```

### Running Specific Tests
```bash
# Run specific test file
npm test -- chrome-api.test.ts

# Run tests matching pattern
npm test -- --testNamePattern="should handle"

# Run tests in specific directory
npm test -- tests/

# Skip failing tests temporarily
npm test -- --testPathIgnorePatterns=linkedin-integration
```

### Writing Tests
```typescript
// Example test structure
import { chrome } from './setup';

describe('Feature Name', () => {
  beforeEach(() => {
    // Setup before each test
  });

  test('should do something specific', () => {
    // Test implementation
    expect(result).toBe(expected);
  });
});
```

## 🔄 Version Management

### Bump Version
```bash
# Bump patch version (0.2.0 → 0.2.1)
./scripts/version-bump.sh --type patch

# Bump minor version (0.2.0 → 0.3.0)
./scripts/version-bump.sh --type minor  

# Bump major version (0.2.0 → 1.0.0)
./scripts/version-bump.sh --type major

# Set custom version
./scripts/version-bump.sh --type custom --version 1.5.0

# Preview changes without making them
./scripts/version-bump.sh --type patch --dry-run
```

### What Version Bumping Does
1. Updates `src/manifest.json`
2. Updates `package.json` 
3. Creates git commit: `"chore: bump version to v0.2.1"`
4. Creates git tag: `v0.2.1`

## 🚀 Release Process

### Manual Release
```bash
# 1. Bump version and create tag
./scripts/version-bump.sh --type patch

# 2. Push changes and tags
git push origin main
git push origin --tags

# 3. GitHub Actions will automatically:
#    - Run tests
#    - Build extension  
#    - Create GitHub release
#    - Upload ZIP packages
```

### Automated Release (GitHub Actions)
When you push a tag like `v1.0.0`, the CI/CD pipeline automatically:
1. ✅ Runs all tests
2. ✅ Performs security scans
3. ✅ Builds production extension
4. ✅ Creates ZIP packages
5. ✅ Creates GitHub release
6. ✅ Uploads release assets

## 🏪 Chrome Web Store Submission

### First-Time Submission
1. **Build production package**:
   ```bash
   npm run build
   npm run package
   ```

2. **Upload to Chrome Web Store**:
   - Go to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/developer/dashboard)
   - Click "New Item"
   - Upload `packages/LinkMate-v0.2.0.zip`
   - Fill in store listing details
   - Submit for review

### Updates
```bash
# For extension updates:
./scripts/version-bump.sh --type patch
git push origin main --tags

# Download the new ZIP from GitHub Releases
# Upload to Chrome Web Store Developer Dashboard
```

## 🧩 Extension Architecture

### File Structure
```
src/
├── manifest.json           # Extension manifest
├── background.ts          # Background service worker
├── model-loader.ts       # Optimized WebLLM engine loader (singleton)
├── linkedin-content.ts   # LinkedIn-specific content script
├── popup.html           # Extension popup HTML
├── popup.ts            # Extension popup logic
├── popup.css          # Extension popup styles
├── linkedin-styles.css # LinkedIn integration styles
└── icons/             # Extension icons
    ├── icon-16.png
    ├── icon-32.png  
    ├── icon-64.png
    └── icon-128.png
```

### Key Components

**Background Service Worker** (`background.ts`)
- Handles LinkedIn reply generation
- Manages AI engine initialization
- Coordinates between content scripts and popup

**LinkedIn Content Script** (`linkedin-content.ts`)
- Injects "Generate Reply" buttons into LinkedIn posts
- Handles LinkedIn DOM manipulation
- Communicates with background worker

**Popup** (`popup.ts`, `popup.html`, `popup.css`)
- Chat interface for manual AI interaction
- Independent AI engine for testing
- Settings and model selection

## 🔧 Development Tips

### Hot Reload During Development
1. Use `npm run dev` to watch for changes
2. When files change, go to `chrome://extensions/`
3. Click the refresh button on your extension
4. Refresh any open LinkedIn pages to see changes

### Debugging
```bash
# View background worker logs
# Go to chrome://extensions/
# Click "Inspect views: background page"

# View content script logs
# Open LinkedIn, press F12, check Console

# View popup logs  
# Click extension icon, right-click popup, "Inspect"
```

### Common Development Tasks

**Adding a new feature**:
1. Write tests first (`tests/`)
2. Implement feature (`src/`)
3. Update styles if needed (`src/*.css`)
4. Test manually in Chrome
5. Run full test suite: `npm run test`

**Modifying LinkedIn integration**:
1. Edit `src/linkedin-content.ts`
2. Update styles in `src/linkedin-styles.css`
3. Test on actual LinkedIn pages
4. Update tests in `tests/linkedin-integration.test.ts`

## 🛡️ Security & Best Practices

### Manifest V3 Compliance
- ✅ Using service workers (not background pages)
- ✅ Minimal permissions requested
- ✅ No inline scripts or eval()
- ✅ Content Security Policy compliant

### Code Quality Standards
- **ESLint**: Enforces coding standards
- **Prettier**: Consistent code formatting  
- **TypeScript**: Type safety
- **Tests**: Minimum 80% coverage goal
- **Security**: Regular npm audits

### Permission Optimization
Current permissions explained:
- `storage`: Store user preferences and AI model data
- `tabs`: Query active tab for content script injection  
- `webNavigation`: Detect LinkedIn page navigation
- `activeTab`: Access current tab when extension is clicked
- `windows`: Manage popup windows
- `alarms`: Keep service worker alive
- `host_permissions: ["https://*.linkedin.com/*"]`: Only LinkedIn access

## 📊 Monitoring & Analytics

### Build Monitoring
```bash
# Check bundle sizes
npm run build
du -sh dist/*

# Analyze dependencies
npm ls --depth=0

# Security audit
npm audit
```

### Performance Testing
```bash
# Test with large content
# Test memory usage over time  
# Test on slow connections
# Profile in Chrome DevTools
```

## 🆘 Troubleshooting

### Common Issues

**Extension won't load**:
- Check `dist/manifest.json` exists
- Verify no syntax errors: `npm run build`
- Check Chrome DevTools for errors

**LinkedIn integration not working**:
- Refresh LinkedIn page after loading extension
- Check content script is injected: `chrome://extensions/`
- Verify LinkedIn page URL matches host permissions

**Build failures**:
```bash
# Clear caches and rebuild
npm run clean
rm -rf node_modules package-lock.json  
npm install
npm run build
```

**Tests failing**:
```bash
# Check specific failing test
npm test -- --verbose failing-test.ts

# Update test snapshots if needed
npm test -- --updateSnapshot
```

### Getting Help
- Check existing issues on GitHub
- Create detailed bug reports with:
  - Chrome version
  - Extension version  
  - Console error messages
  - Steps to reproduce

---

## 📚 Additional Resources

- [Chrome Extension Documentation](https://developer.chrome.com/docs/extensions/)
- [Manifest V3 Guide](https://developer.chrome.com/docs/extensions/mv3/intro/)
- [LinkedIn DOM Structure](docs/LinkedIn_LinkMate_Requirements.md)
- [CI/CD Pipeline Details](CICD.md)
- [Privacy Policy](privacy-policy.md)

---

*This guide is part of the LinkMate project. For more information, see the main [README.md](README.md).*
