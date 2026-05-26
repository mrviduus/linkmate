#!/bin/bash

# ReplyMate LinkedIn Auto-Reply Extension Installation Script
# This script helps set up the ReplyMate Chrome Extension for development and testing

echo "🤖 ReplyMate LinkedIn Auto-Reply Extension Setup"
echo "=============================================="

# Colors for better output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

# Check if we're in the right directory
if [ ! -f "package.json" ] || [ ! -f "src/manifest.json" ]; then
    print_error "package.json or src/manifest.json not found. Please run this script from the ReplyMate project root."
    exit 1
fi

print_success "Found project files"

# Check Node.js installation
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    print_success "Found Node.js $NODE_VERSION"
else
    print_error "Node.js not found. Please install Node.js from: https://nodejs.org/"
    exit 1
fi

# Check npm installation
if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm --version)
    print_success "Found npm $NPM_VERSION"
else
    print_error "npm not found. Please install npm."
    exit 1
fi

# Check Chrome installation (macOS compatible)
CHROME_CMD=""
if [ -d "/Applications/Google Chrome.app" ]; then
    CHROME_CMD="open -a 'Google Chrome'"
    print_success "Found Chrome browser (macOS)"
elif command -v google-chrome &> /dev/null; then
    CHROME_CMD="google-chrome"
    print_success "Found Chrome browser (Linux)"
elif command -v chrome &> /dev/null; then
    CHROME_CMD="chrome"
    print_success "Found Chrome browser"
elif command -v chromium &> /dev/null; then
    CHROME_CMD="chromium"
    print_success "Found Chromium browser"
else
    print_warning "Chrome not found. Please install Google Chrome to use this extension."
    echo "   You can download it from: https://www.google.com/chrome/"
    CHROME_CMD=""
fi

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
if npm install; then
    print_success "Dependencies installed successfully"
else
    print_error "Failed to install dependencies"
    exit 1
fi

# Build the extension
echo ""
echo "🔨 Building extension..."
if npm run build; then
    print_success "Extension built successfully"
else
    print_error "Failed to build extension"
    exit 1
fi

# Check if dist directory exists
if [ ! -d "dist" ]; then
    print_error "Build failed - dist directory not found"
    exit 1
fi

# Validate required files in dist
echo ""
echo "🔍 Validating extension files..."

# Check for manifest.json (should be exact name)
if [ -f "dist/manifest.json" ]; then
    print_success "dist/manifest.json"
else
    print_error "Missing: dist/manifest.json"
    exit 1
fi

# Check for hashed files (using wildcards)
required_patterns=("popup*.html" "content*.js" "popup*.js" "popup*.css")
for pattern in "${required_patterns[@]}"; do
    if ls dist/$pattern 1> /dev/null 2>&1; then
        files=$(ls dist/$pattern)
        for file in $files; do
            print_success "$file"
        done
    else
        print_error "Missing files matching pattern: dist/$pattern"
        exit 1
    fi
done

# Check icons with flexible naming
if ls dist/icon* 1> /dev/null 2>&1; then
    print_success "Extension icons found"
    icon_count=$(ls dist/icon* | wc -l)
    print_info "Found $icon_count icon files"
else
    print_warning "No icon files found in dist/"
fi

echo ""
print_success "ReplyMate Extension is ready for installation!"
echo ""
echo "📋 Installation Instructions:"
echo "1. Open Chrome and navigate to: chrome://extensions/"
echo "2. Enable 'Developer mode' (toggle in top right)"
echo "3. Click 'Load unpacked' and select the 'dist' directory:"
echo "   $(pwd)/dist"
echo "4. Visit LinkedIn.com to test the extension"
echo ""
echo "🔧 Development Workflow:"
echo "- Make changes to files in 'src/' directory"
echo "- Run 'npm run build' to rebuild the extension"
echo "- Click 'Reload' button in Chrome extensions page"
echo "- Test on LinkedIn.com"
echo ""
echo "🧪 Testing:"
echo "- Run 'npm test' to execute unit tests"
echo "- Run 'npm run test:watch' for continuous testing"
echo "- Run 'npm run test:coverage' for coverage report"
echo ""

# Optionally open Chrome extensions page
if [ -n "$CHROME_CMD" ]; then
    echo -n "🚀 Open Chrome extensions page now? (y/n): "
    read -r response
    if [[ $response =~ ^[Yy]$ ]]; then
        if [ -d "/Applications/Google Chrome.app" ]; then
            # macOS specific command
            open -a "Google Chrome" "chrome://extensions/"
        else
            # Linux/other systems
            $CHROME_CMD "chrome://extensions/"
        fi
        print_success "Opened Chrome extensions page"
        echo ""
        print_info "Remember to:"
        echo "   1. Enable 'Developer mode'"
        echo "   2. Click 'Load unpacked'"
        echo "   3. Select the 'dist' folder from this project"
    fi
else
    echo ""
    print_info "To install the extension manually:"
    echo "   1. Open Google Chrome"
    echo "   2. Go to chrome://extensions/"
    echo "   3. Enable Developer mode"
    echo "   4. Click 'Load unpacked' and select the 'dist' directory"
fi

echo ""
echo "🎯 Usage Tips:"
echo "- The extension works specifically on LinkedIn pages"
echo "- Click the ReplyMate icon in the toolbar to open the popup"
echo "- Use the AI-powered reply suggestions in LinkedIn message threads"
echo "- Check the status indicators in the popup for extension health"
echo ""
print_success "Setup complete! Happy LinkedIn networking with ReplyMate! 🚀"
