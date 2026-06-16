#!/bin/bash
# finance-tracker incremental warm cache
# Calls /api/warm which fetches latest data and merges with existing cache.
# Run by cron at 09:00 and 20:00 on weekdays.

BASE="http://127.0.0.1:3008"
LOG="/var/www/finance-tracker/cache/warm.log"
MAX_WAIT=120  # seconds to wait for /api/warm to complete

echo "" >> "$LOG"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] === Warm cache started ===" >> "$LOG"

# Call /api/warm (incremental merge, may take up to 2 minutes)
RESPONSE=$(curl -s -m "$MAX_WAIT" -X POST "$BASE/api/warm" -H "Content-Type: application/json" 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: curl failed (exit $EXIT_CODE)" >> "$LOG"
  exit 1
fi

# Check if response indicates success
SUCCESS=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('success', False))" 2>/dev/null)

if [ "$SUCCESS" = "True" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] SUCCESS" >> "$LOG"
  # Print the server-side log entries
  echo "$RESPONSE" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for line in d.get('log', []):
    print(line)
" >> "$LOG" 2>/dev/null
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] FAILED: $RESPONSE" >> "$LOG"
fi

# Pre-warm K-line cache (runs after main warm)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Warming K-line cache..." >> "$LOG"
KLINE_RESPONSE=$(curl -s -m 60 -X POST "$BASE/api/warm-kline" -H "Content-Type: application/json" 2>&1)
KLINE_SUCCESS=$(echo "$KLINE_RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('success', False))" 2>/dev/null)

if [ "$KLINE_SUCCESS" = "True" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] K-line cache warmed successfully" >> "$LOG"
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] K-line warm failed: $KLINE_RESPONSE" >> "$LOG"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] === Warm cache done ===" >> "$LOG"
