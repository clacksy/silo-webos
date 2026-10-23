#!/bin/sh
# One-command DevTools session against the TV.
#
#   TV=<ssh-host> APP=<app-id> tools/inspect.sh
#
# Why this is needed:
#   1. The inspector port is ALWAYS 9998 - it never changes.
#   2. It only listens while a web app is actually running.
#   3. Glasshouse firewalls it to loopback ("answers on the TV only"), so it
#      must be reached through an SSH tunnel, never directly by TV IP.
#   4. The TV's IP itself is DHCP and can move - pin it, or change TV= below.
set -e

TV=${TV:-c2tv}
APP=${APP:-io.github.clacksy.silotv}
PORT=${PORT:-9998}
BASE=http://127.0.0.1:$PORT

# 1. A web app must be running, or there is no inspector to talk to.
fg=$(ssh -o BatchMode=yes "$TV" \
  "sleep 3 | luna-send -n 1 luna://com.webos.service.applicationManager/getForegroundAppInfo '{}' 2>/dev/null" || true)
case "$fg" in
  *"$APP"*) ;;
  *) echo "launching $APP on the TV..."
     ssh -o BatchMode=yes "$TV" \
       "sleep 4 | luna-send -n 1 luna://com.webos.applicationManager/launch '{\"id\":\"$APP\"}' >/dev/null 2>&1" || true
     sleep 7 ;;
esac

# 2. Tunnel the loopback-only port.
pkill -f "$PORT:127.0.0.1:$PORT" 2>/dev/null || true
ssh -f -N -L "$PORT:127.0.0.1:$PORT" -o BatchMode=yes "$TV"
sleep 1

# 3. Report what is debuggable.
curl -s -m 8 "$BASE/json" | python3 -c '
import json, sys
try:
    targets = json.load(sys.stdin)
except Exception:
    print("  no inspector targets - is a web app actually running?")
    raise SystemExit(1)
for t in targets:
    print("  %-34s %s" % (t.get("title", "?")[:34], t.get("webSocketDebuggerUrl", "")))
' || true

echo
echo "tunnel up:  $BASE/json"
echo "chrome:     chrome://inspect  ->  Configure...  ->  localhost:$PORT"
echo "stop with:  pkill -f '$PORT:127.0.0.1:$PORT'"
