#!/bin/bash
# ═══════════════════════════════════════════════════════
#  CTpaste Linux Installer
#  Supports Ubuntu 20.04+ / Debian-based distros
# ═══════════════════════════════════════════════════════

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

DEB_URL="https://dharani-sundharam.github.io/CodePaste/ctpaste_1.0_amd64.deb"
DEB_FILE="/tmp/ctpaste_1.0_amd64.deb"
MIN_GLIBC="2.31"

echo -e "${CYAN}"
echo "  ██████╗████████╗██████╗  █████╗ ███████╗████████╗███████╗"
echo "  ██╔════╝╚══██╔══╝██╔══██╗██╔══██╗██╔════╝╚══██╔══╝██╔════╝"
echo "  ██║        ██║   ██████╔╝███████║███████╗   ██║   █████╗  "
echo "  ██║        ██║   ██╔═══╝ ██╔══██║╚════██║   ██║   ██╔══╝  "
echo "  ╚██████╗   ██║   ██║     ██║  ██║███████║   ██║   ███████╗"
echo "   ╚═════╝   ╚═╝   ╚═╝     ╚═╝  ╚═╝╚══════╝   ╚═╝   ╚══════╝"
echo -e "${NC}"
echo -e "${CYAN}  CTpaste Linux Installer${NC}"
echo "  ─────────────────────────────────────────────────"
echo ""

# ── Step 1: Check OS ──────────────────────────────────
echo -e "[ ${YELLOW}1/5${NC} ] Checking system compatibility..."

if ! command -v dpkg &>/dev/null; then
    echo -e "${RED}✗ This installer only supports Debian-based systems (Ubuntu, Mint, etc.)${NC}"
    exit 1
fi

OS=$(lsb_release -d 2>/dev/null | cut -f2 || echo "Unknown")
ARCH=$(uname -m)
echo -e "      OS: ${GREEN}$OS${NC}"
echo -e "      Architecture: ${GREEN}$ARCH${NC}"

if [ "$ARCH" != "x86_64" ]; then
    echo -e "${RED}✗ CTpaste requires a 64-bit (x86_64) system. Got: $ARCH${NC}"
    exit 1
fi

# ── Step 2: Check GLIBC version ───────────────────────
GLIBC_VER=$(ldd --version | head -1 | grep -oP '\d+\.\d+$')
echo -e "      GLIBC: ${GREEN}$GLIBC_VER${NC}"

python3 -c "
import sys
cur = tuple(map(int, '${GLIBC_VER}'.split('.')))
req = tuple(map(int, '${MIN_GLIBC}'.split('.')))
if cur < req:
    print('GLIBC_FAIL')
" | grep -q "GLIBC_FAIL" && {
    echo -e "${RED}✗ Your GLIBC ($GLIBC_VER) is too old. Minimum required: ${MIN_GLIBC}${NC}"
    echo -e "${YELLOW}  This usually means your OS is Ubuntu 18.04 or older.${NC}"
    echo -e "${YELLOW}  Please upgrade to Ubuntu 20.04 or newer.${NC}"
    exit 1
}

echo -e "      ${GREEN}✓ System compatible${NC}"
echo ""

# ── Step 3: Install dependencies ─────────────────────
echo -e "[ ${YELLOW}2/5${NC} ] Installing dependencies (xdotool)..."
if ! command -v xdotool &>/dev/null; then
    sudo apt-get install -y -q xdotool
    echo -e "      ${GREEN}✓ xdotool installed${NC}"
else
    echo -e "      ${GREEN}✓ xdotool already installed${NC}"
fi
echo ""

# ── Step 4: Download .deb ─────────────────────────────
echo -e "[ ${YELLOW}3/5${NC} ] Downloading CTpaste..."
if ! command -v curl &>/dev/null && ! command -v wget &>/dev/null; then
    sudo apt-get install -y -q curl
fi

if command -v curl &>/dev/null; then
    curl -L --progress-bar "$DEB_URL" -o "$DEB_FILE"
else
    wget -q --show-progress "$DEB_URL" -O "$DEB_FILE"
fi

if [ ! -f "$DEB_FILE" ] || [ ! -s "$DEB_FILE" ]; then
    echo -e "${RED}✗ Download failed! Check your internet connection.${NC}"
    exit 1
fi

echo -e "      ${GREEN}✓ Downloaded successfully ($(du -h $DEB_FILE | cut -f1))${NC}"
echo ""

# ── Step 5: Install .deb ──────────────────────────────
echo -e "[ ${YELLOW}4/5${NC} ] Installing CTpaste..."
sudo dpkg -i "$DEB_FILE" 2>&1 | tail -5
if sudo dpkg -i "$DEB_FILE"; then
    echo -e "      ${GREEN}✓ Installation complete${NC}"
else
    echo -e "${YELLOW}  Fixing broken dependencies...${NC}"
    sudo apt-get install -f -y
fi
echo ""

# ── Step 6: Verify ────────────────────────────────────
echo -e "[ ${YELLOW}5/5${NC} ] Verifying installation..."

if dpkg -l ctpaste 2>/dev/null | grep -q "^ii"; then
    INSTALLED_FILES=$(dpkg -L ctpaste 2>/dev/null | tr '\n' '  ')
    echo -e "      ${GREEN}✓ Package installed correctly${NC}"
    echo -e "      Files: $INSTALLED_FILES"
else
    echo -e "${RED}✗ Package verification failed. Try running: sudo apt-get install -f${NC}"
    exit 1
fi

EXEC_PATH=$(dpkg -L ctpaste 2>/dev/null | grep -E "ctpaste$" | head -1)
if [ -n "$EXEC_PATH" ] && [ -x "$EXEC_PATH" ]; then
    echo -e "      ${GREEN}✓ Executable found at $EXEC_PATH${NC}"
else
    echo -e "${YELLOW}  ⚠ Could not verify executable path directly. Check your app menu.${NC}"
fi

rm -f "$DEB_FILE"

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  CTpaste installed successfully! 🚀${NC}"
echo -e "${GREEN}  Launch it from your application menu or run:${NC}"
echo -e "${GREEN}  ctpaste${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
