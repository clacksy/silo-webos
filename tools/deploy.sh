#!/bin/sh
# Build the IPK, install it on the TV and relaunch the app.
# Refuses while the app is playing something, unless --force is given:
# installing restarts the app and cuts off whatever is being watched.
set -e
cd "$(dirname "$0")/.."

title=$(ssh c2tv 'curl -s http://127.0.0.1:9998/json' | grep -o '"title": *"[^"]*"' | head -1 || true)
case "$title" in
  *player*)
    if [ "$1" != "--force" ]; then
      echo "The TV is playing something ($title). Not installing; rerun with --force to interrupt it."
      exit 1
    fi
    ;;
esac

python3 build.py >/dev/null
ssh c2tv 'cat > /tmp/silo-webos.ipk' < silo-webos.ipk
ssh c2tv "luna-send -n 6 -w 60000 luna://com.webos.appInstallService/dev/install \
  '{\"id\":\"org.silo.webos\",\"ipkUrl\":\"/tmp/silo-webos.ipk\",\"subscribe\":true}' >/dev/null
  sleep 3
  grep '\"version\"' /media/developer/apps/usr/palm/applications/org.silo.webos/appinfo.json
  luna-send -n 1 luna://com.webos.applicationManager/closeByAppId '{\"id\":\"org.silo.webos\"}' >/dev/null || true
  sleep 2
  luna-send -n 1 luna://com.webos.applicationManager/launch '{\"id\":\"org.silo.webos\"}' >/dev/null"
echo "installed and relaunched"
