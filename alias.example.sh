# Replace the paths, or run ./install.sh to generate alias.sh automatically.
claude() {
  command claude \
    --mcp-config "/ABSOLUTE/PATH/TO/intercom/mcp.json" \
    --dangerously-load-development-channels server:intercom "$@"
}
