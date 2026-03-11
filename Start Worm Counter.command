#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  Start Worm Counter.command
#  Double-click this file in macOS Finder to launch the app.
# ─────────────────────────────────────────────────────────────────────────────

# Change to the directory that contains this script
cd "$(dirname "$0")"

echo ""
echo "=========================================="
echo "   C. elegans Worm Counter  "
echo "=========================================="
echo ""

# ── 1. Find Python ────────────────────────────────────────────────────────────
# Prefer conda/mamba python, then system python3
if command -v conda &>/dev/null; then
  PYTHON=$(conda run -n base which python 2>/dev/null || which python3)
else
  PYTHON=$(which python3 || which python)
fi

if [ -z "$PYTHON" ]; then
  echo "❌  Python 3 not found."
  echo "    Install it from https://www.python.org or via conda."
  read -p "Press Enter to close..."
  exit 1
fi

echo "✅  Using Python: $PYTHON ($($PYTHON --version 2>&1))"

# ── 2. Install / update requirements ─────────────────────────────────────────
echo ""
echo "📦  Checking requirements..."
$PYTHON -m pip install -q flask anthropic "opencv-python-headless>=4.9" numpy werkzeug 2>&1 \
  | grep -v "^Requirement already"

echo "✅  Requirements ready."

# ── 3. Anthropic API key ──────────────────────────────────────────────────────
if [ -z "$ANTHROPIC_API_KEY" ]; then
  # Check a local .env file for convenience
  if [ -f ".env" ]; then
    source .env
  fi
fi

if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo ""
  echo "🔑  ANTHROPIC_API_KEY is not set."
  echo "    Enter your key now (or press Enter to skip — worm counting will fail):"
  read -r -p "    API key: " INPUT_KEY
  if [ -n "$INPUT_KEY" ]; then
    export ANTHROPIC_API_KEY="$INPUT_KEY"
    # Save to .env for next time
    echo "ANTHROPIC_API_KEY=$INPUT_KEY" > .env
    echo "    Saved to .env for future launches."
  fi
fi

# ── 4. Pick a free port ───────────────────────────────────────────────────────
PORT=5000
while lsof -i TCP:$PORT &>/dev/null 2>&1; do
  PORT=$((PORT + 1))
done
export PORT=$PORT

# ── 5. Start Flask ────────────────────────────────────────────────────────────
echo ""
echo "🚀  Starting server on http://localhost:$PORT ..."
echo "    (Close this window to stop the server)"
echo ""

# Open browser after a short delay
(sleep 2 && open "http://localhost:$PORT") &

$PYTHON app.py
