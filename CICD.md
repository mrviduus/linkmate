# LinkMate CI/CD Pipeline

This document describes the continuous integration and deployment pipeline for LinkMate Chrome extension.

## 🚀 Pipeline Overview

Our CI/CD pipeline consists of three main workflows:

### 1. **CI Workflow** (`.github/workflows/ci.yml`)
- **Triggers**: Push to `main`/`develop`, Pull Requests to `main`
- **Jobs**:
  - **Test**: Run tests on Node.js 18.x and 20.x
  - **Build**: Create extension build artifacts
  - **Security Scan**: Run security audits and CodeQL analysis

### 2. **Code Quality Workflow** (`.github/workflows/code-quality.yml`)
- **Triggers**: Push to `main`/`develop`, Pull Requests to `main`
- **Jobs**:
  - **Lint & Format**: ESLint, Prettier, Super Linter
  - **Type Check**: TypeScript type checking and coverage

### 3. **Release Workflow** (`.github/workflows/release.yml`)
- **Triggers**: Git tags starting with `v*` (e.g., `v1.0.0`)
- **Jobs**:
  - **Create Release**: Build, package, and create GitHub release
  - **Chrome Web Store**: Automated publishing (when configured)

## 📦 Build Scripts

Located in `./scripts/` directory:

### `build.sh`
```bash
./scripts/build.sh
```
- Clean previous builds
- Install dependencies
- Run type checking and linting
- Run tests
- Compile TypeScript
- Copy static files
- Validate manifest
- Generate size report

### `package.sh`
```bash
./scripts/package.sh
```
- Create ZIP packages for Chrome Web Store
- Generate development builds
- Create package manifest with metadata

### `version-bump.sh`
```bash
# Bump patch version (0.2.0 -> 0.2.1)
./scripts/version-bump.sh --type patch

# Bump minor version (0.2.0 -> 0.3.0)
./scripts/version-bump.sh --type minor

# Bump major version (0.2.0 -> 1.0.0)
./scripts/version-bump.sh --type major

# Set custom version
./scripts/version-bump.sh --type custom --version 1.5.0

# Preview changes without making them
./scripts/version-bump.sh --type patch --dry-run
```

## 🛠️ NPM Scripts

Add to your workflow:

### Development
```bash
npm run dev          # Start development build with watch mode
npm run build        # Build for production
npm run build:script # Use custom build script
```

### Testing & Quality
```bash
npm run test         # Run tests
npm run test:ci      # Run tests in CI mode
npm run test:coverage # Generate coverage report
npm run lint         # Run ESLint
npm run lint:fix     # Fix ESLint issues
npm run format       # Format code with Prettier
npm run type-check   # Run TypeScript type checking
```

### Packaging & Release
```bash
npm run package      # Create extension packages
npm run zip          # Build and package in one command
npm run clean        # Clean all build artifacts
```

## 🔄 Release Process

### Automatic Release
1. **Bump version**:
   ```bash
   ./scripts/version-bump.sh --type patch
   ```

2. **Push to trigger release**:
   ```bash
   git push && git push --tags
   ```

3. **GitHub Actions will**:
   - Run all tests and quality checks
   - Build and package the extension
   - Create a GitHub release with artifacts
   - Upload packages to release assets

### Manual Release
1. **Create and push a tag**:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

2. **The release workflow will run automatically**

## 📋 Configuration Files

### `.eslintrc.json`
- ESLint configuration for TypeScript and Chrome extensions
- Includes Chrome extension specific rules
- Jest configuration for test files

### `.prettierrc.json`
- Code formatting rules
- Consistent styling across the project

### `package.json`
- All npm scripts for development and CI
- Development dependencies for tooling

## 🔒 Security Features

- **Dependency Scanning**: `npm audit` in CI
- **Code Analysis**: GitHub CodeQL integration
- **Permission Validation**: Manifest validation
- **Secret Management**: GitHub secrets for sensitive data

## 🌟 Best Practices

### Branch Protection
Recommended branch protection rules for `main`:
- Require pull request reviews
- Require status checks to pass
- Require branches to be up to date
- Include administrators

### Required Status Checks
- `test (18.x)`
- `test (20.x)`
- `build`
- `lint-and-format`
- `type-check`

### Secrets Configuration
For Chrome Web Store publishing, add these secrets to your GitHub repository:

```
CHROME_WEB_STORE_KEYS    # Chrome Web Store API credentials
```

## 📊 Monitoring & Reporting

The pipeline provides:
- **Test Coverage**: Uploaded to Codecov
- **Build Artifacts**: Available for download
- **ESLint Reports**: Generated in CI
- **Security Reports**: CodeQL results
- **Build Size Reports**: Track extension size

## 🚨 Troubleshooting

### Common Issues

1. **Build Failures**:
   - Check TypeScript errors: `npm run type-check`
   - Check linting: `npm run lint`
   - Check tests: `npm run test`

2. **Permission Errors**:
   - Ensure scripts are executable: `chmod +x scripts/*.sh`
   - Check file permissions in the repository

3. **Release Issues**:
   - Verify tag format: `v1.0.0` (must start with 'v')
   - Check GitHub token permissions
   - Verify manifest.json version matches tag

### Local Testing

Test the pipeline locally:
```bash
# Test build process
./scripts/build.sh

# Test packaging
./scripts/package.sh

# Test version bump (dry run)
./scripts/version-bump.sh --type patch --dry-run
```

## 📈 Future Enhancements

Planned improvements:
- Automated Chrome Web Store publishing
- Edge Add-ons store integration
- Performance benchmarking
- Visual regression testing
- Automated changelog generation

---

For questions or issues with the CI/CD pipeline, please create an issue in the repository.
