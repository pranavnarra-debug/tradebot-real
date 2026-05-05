#!/bin/bash
# TradeBot startup script
# Place this file in your tradebot project root

cd "$(dirname "$0")"

# Build if dist doesn't exist
if [ ! -f "dist/index.cjs" ]; then
  echo "Building TradeBot..."
  npm run build
fi

echo "Starting TradeBot on port 3000..."
PORT=3000 NODE_ENV=production node dist/index.cjs
