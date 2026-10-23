#!/bin/bash
# Register Neelima Browser Bridge native messaging host for Chrome/Edge on Linux/macOS

set -euo pipefail

HOST_NAME="com.neelima.browser_bridge"
BINARY_NAME="neelima_native_host"
MANIFEST_NAME="${HOST_NAME}.json"

# Determine paths
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    CHROME_DIR="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    EDGE_DIR="${HOME}/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
    INSTALL_DIR="/usr/local/bin"
else
    # Linux
    CHROME_DIR="${HOME}/.config/google-chrome/NativeMessagingHosts"
    EDGE_DIR="${HOME}/.config/microsoft-edge/NativeMessagingHosts"
    INSTALL_DIR="/usr/local/bin"
fi

BINARY_PATH="${INSTALL_DIR}/${BINARY_NAME}"

show_usage() {
    cat <<EOF
Usage: $0 [OPTIONS]

Options:
    --install       Install the native messaging host (default)
    --uninstall     Remove the native messaging host
    --system        Install system-wide (requires sudo)
    --help          Show this help

EOF
}

uninstall() {
    local system_install="$1"
    local dirs=()

    if [[ "$system_install" == "true" ]]; then
        if [[ "$OSTYPE" == "darwin"* ]]; then
            dirs+=("/Library/Application Support/Google/Chrome/NativeMessagingHosts")
            dirs+=("/Library/Application Support/Microsoft Edge/NativeMessagingHosts")
        else
            dirs+=("/etc/opt/chrome/native-messaging-hosts")
            dirs+=("/etc/opt/edge/native-messaging-hosts")
        fi
    else
        dirs+=("$CHROME_DIR")
        dirs+=("$EDGE_DIR")
    fi

    for dir in "${dirs[@]}"; do
        local manifest_path="${dir}/${MANIFEST_NAME}"
        if [[ -f "$manifest_path" ]]; then
            rm -f "$manifest_path"
            echo "Removed: $manifest_path"
        fi
    done

    echo "Uninstallation complete."
}

install() {
    local system_install="$1"

    # Check if binary exists
    if [[ ! -f "$BINARY_PATH" ]]; then
        echo "Error: Native host binary not found at: $BINARY_PATH" >&2
        echo "Please build and install the binary first:" >&2
        echo "  cargo build --release -p neelima-native_host" >&2
        echo "  sudo cp target/release/neelima_native_host $INSTALL_DIR/" >&2
        exit 1
    fi

    local dirs=()
    if [[ "$system_install" == "true" ]]; then
        if [[ "$OSTYPE" == "darwin"* ]]; then
            dirs+=("/Library/Application Support/Google/Chrome/NativeMessagingHosts")
            dirs+=("/Library/Application Support/Microsoft Edge/NativeMessagingHosts")
        else
            dirs+=("/etc/opt/chrome/native-messaging-hosts")
            dirs+=("/etc/opt/edge/native-messaging-hosts")
        fi
    else
        dirs+=("$CHROME_DIR")
        dirs+=("$EDGE_DIR")
    fi

    # Create manifest content
    local manifest=$(cat <<EOF
{
  "name": "${HOST_NAME}",
  "description": "Neelima Browser Bridge Native Messaging Host",
  "path": "${BINARY_PATH}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://<EXTENSION_ID>/"
  ]
}
EOF
)

    for dir in "${dirs[@]}"; do
        mkdir -p "$dir"
        local manifest_path="${dir}/${MANIFEST_NAME}"
        echo "$manifest" > "$manifest_path"
        echo "Installed manifest: $manifest_path"
    done

    echo ""
    echo "Installation complete!"
    echo "Binary: $BINARY_PATH"
    echo ""
    echo "Note: Replace <EXTENSION_ID> in the manifest with your actual Chrome extension ID."
    echo "Manifest location(s):"
    for dir in "${dirs[@]}"; do
        echo "  ${dir}/${MANIFEST_NAME}"
    done
}

# Parse arguments
ACTION="install"
SYSTEM_INSTALL="false"

while [[ $# -gt 0 ]]; do
    case $1 in
        --install)
            ACTION="install"
            shift
            ;;
        --uninstall)
            ACTION="uninstall"
            shift
            ;;
        --system)
            SYSTEM_INSTALL="true"
            shift
            ;;
        --help|-h)
            show_usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            show_usage
            exit 1
            ;;
    esac
done

# Execute action
if [[ "$ACTION" == "install" ]]; then
    install "$SYSTEM_INSTALL"
else
    uninstall "$SYSTEM_INSTALL"
fi