#!/usr/bin/env bash
# Install (or re-install) the weekly HubSpot dedupe launchd job on this Mac.
#
# Run this from the repo root on the machine where the dedupe tool lives:
#   bash scripts/launchd/install.sh
#
# The script:
#   1. Figures out this repo's absolute path
#   2. Renders the plist template with that path
#   3. Copies the rendered plist to ~/Library/LaunchAgents/
#   4. Unloads any existing job with the same label
#   5. Loads the new job (bootstraps into the user's GUI session)
#   6. Prints `launchctl list` output as a sanity check
#
# To uninstall later:
#   launchctl bootout gui/$(id -u)/com.yourorg.hubspot-dedupe
#   rm ~/Library/LaunchAgents/com.yourorg.hubspot-dedupe.plist

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMPLATE="$SCRIPT_DIR/com.yourorg.hubspot-dedupe.plist.template"
PLIST_DEST="$HOME/Library/LaunchAgents/com.yourorg.hubspot-dedupe.plist"
LABEL="com.yourorg.hubspot-dedupe"

echo "[install-launchd] repo dir: $REPO_DIR"
echo "[install-launchd] plist destination: $PLIST_DEST"

# Ensure Library/LaunchAgents exists
mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$HOME/Library/Logs"

# Render the template, substituting ${DEDUPE_PROJECT_DIR} and ${HOME}
# (using sed since macOS doesn't ship envsubst by default)
sed -e "s|\${DEDUPE_PROJECT_DIR}|$REPO_DIR|g" \
    -e "s|\${HOME}|$HOME|g" \
    "$TEMPLATE" > "$PLIST_DEST"
echo "[install-launchd] rendered plist:"
cat "$PLIST_DEST"

# Tear down any existing job, ignoring errors if it wasn't loaded
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

# Load the new job (modern bootstrap API, works on macOS 10.10+)
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"
echo "[install-launchd] loaded $LABEL into launchd"

# Verify
echo "[install-launchd] verify via launchctl list:"
launchctl list | grep "$LABEL" || echo "  (not yet in list — may take a few seconds)"

echo ""
echo "✅ Installed. The job will run every Sunday at 2:00 AM local time."
echo ""
echo "To trigger a run right now (for testing), use:"
echo "  launchctl kickstart -k gui/\$(id -u)/$LABEL"
echo ""
echo "To watch logs as it runs:"
echo "  tail -f ~/Library/Logs/hubspot-dedupe-weekly.log"
