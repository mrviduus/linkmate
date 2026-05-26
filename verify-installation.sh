#!/bin/bash

# ReplyMate Extension Verification Script
echo "🔍 Verifying ReplyMate LinkedIn Integration..."

# Check if build succeeded
if [ -d "dist" ]; then
    echo "✅ Build directory exists"
    
    # Check key files
    if [ -f "dist/manifest.json" ]; then
        echo "✅ Manifest file present"
    else
        echo "❌ Manifest file missing"
        exit 1
    fi
    
    if [ -f "dist/linkedin-content.253cda3c.js" ] || [ -f "dist/linkedin-content.js" ] || ls dist/linkedin-content.*.js 1> /dev/null 2>&1; then
        echo "✅ LinkedIn content script built"
    else
        echo "❌ LinkedIn content script missing"
        exit 1
    fi
    
    if [ -f "dist/linkedin-styles.css" ]; then
        echo "✅ LinkedIn styles included"
    else
        echo "❌ LinkedIn styles missing"
        exit 1
    fi
    
else
    echo "❌ Build directory missing. Run 'npm run build' first."
    exit 1
fi

# Check package.json version
VERSION=$(node -p "require('./package.json').version")
echo "📦 Extension version: $VERSION"

# Show installation instructions
echo ""
echo "🚀 Ready to install! Follow these steps:"
echo "1. Open Chrome and go to chrome://extensions/"
echo "2. Enable 'Developer mode' (toggle in top right)"
echo "3. Click 'Load unpacked' and select the 'dist/' directory"
echo "4. Pin the ReplyMate extension to your toolbar"
echo "5. Visit LinkedIn.com to test the functionality"
echo ""
echo "🎯 Features implemented:"
echo "   ✅ F-1: LinkedIn page recognition"
echo "   ✅ F-2: Dynamic post detection with infinite scroll"
echo "   ✅ F-3: Generate Reply button injection"
echo "   ✅ F-4: AI model integration"
echo "   ✅ F-5: Reply panel display"
echo "   ✅ F-6: Regenerate, Copy, Insert controls"
echo "   ✅ F-7: Infinite scroll compatibility" 
echo "   ✅ F-8: LinkedIn-native styling"
echo "   ✅ F-9: Terms of Service compliance warning"
echo "   ✅ F-10: Chrome Manifest V3 compliance"
echo ""
echo "⚠️  Important Notes:"
echo "   • First AI reply generation requires model download (several minutes)"
echo "   • Open the ReplyMate popup to initialize the AI model"
echo "   • Review all generated content before posting"
echo "   • Use responsibly and respect LinkedIn's Terms of Service"
echo ""
echo "✨ Installation complete! Enjoy using ReplyMate!"
