#!/bin/bash
# Capture a screenshot tour of the Silo app on the TV, and audit console + network.
#   tools/tour.sh                  -> writes to ./tour-out/<timestamp>/
#   KEEP=1 tools/tour.sh           -> keeps the SSH tunnel open afterwards
# Requires tools/inspect.sh (tunnel + app launch) to succeed.
set -u
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="${OUT:-./tour-out}/$STAMP"
mkdir -p "$OUT"
echo "tour -> $OUT"

# 1. make sure a web app is running and the loopback port is tunnelled
"$(dirname "$0")/inspect.sh" >/dev/null 2>&1 || { echo "could not open a DevTools session"; exit 1; }

# 2. drive the app and capture
python3 - "$OUT" <<'PY'
import base64, json, os, socket, struct, sys, time, urllib.request
from urllib.parse import urlparse
OUT = sys.argv[1]; HOST, PORT = "127.0.0.1", 9998

targets = json.loads(urllib.request.urlopen("http://%s:%d/json" % (HOST, PORT), timeout=10).read())
page = next(t for t in targets if t.get("url", "").endswith("index.html"))
pid = urlparse(page["webSocketDebuggerUrl"]).path.rsplit("/", 1)[-1]
s = socket.create_connection((HOST, PORT), timeout=15); s.settimeout(10)
key = base64.b64encode(os.urandom(16)).decode()
s.sendall(("GET /devtools/page/%s HTTP/1.1\r\nHost: %s:%d\r\n" % (pid, HOST, PORT)).encode() +
          ("Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\n" % key).encode() +
          b"Sec-WebSocket-Version: 13\r\n\r\n")
buf = b""
while b"\r\n\r\n" not in buf: buf += s.recv(4096)

def send(o):
    p = json.dumps(o).encode(); h = bytearray([0x81]); n = len(p)
    if n < 126: h.append(0x80 | n)
    elif n < 65536: h.append(0x80 | 126); h += struct.pack(">H", n)
    else: h.append(0x80 | 127); h += struct.pack(">Q", n)
    m = os.urandom(4); h += m
    s.sendall(bytes(h) + bytes(b ^ m[i % 4] for i, b in enumerate(p)))

def recv():
    h = b""
    while len(h) < 2:
        c = s.recv(2 - len(h))
        if not c: return None
        h += c
    n = h[1] & 0x7F
    if n == 126: n = struct.unpack(">H", s.recv(2))[0]
    elif n == 127: n = struct.unpack(">Q", s.recv(8))[0]
    d = b""
    while len(d) < n: d += s.recv(n - len(d))
    return d.decode("utf8", "replace")

_id = [0]; ev = {"console": [], "log": [], "resp": {}}
def rpc(m, params=None, wait=8):
    _id[0] += 1
    send({"id": _id[0], "method": m, "params": params or {}})
    end = time.time() + wait
    while time.time() < end:
        try: msg = recv()
        except socket.timeout: return {}
        if msg is None: continue
        try: o = json.loads(msg)
        except Exception: continue
        if "id" in o and o["id"] == _id[0]: return o.get("result", {})
        mth, p = o.get("method"), o.get("params", {})
        if mth == "Runtime.consoleAPICalled":
            ev["console"].append(" ".join(str(a.get("value", a.get("description", ""))) for a in p.get("args", [])))
        elif mth == "Log.entryAdded":
            e = p.get("entry", {}); ev["log"].append("%s: %s" % (e.get("level"), (e.get("text") or "")[:160]))
        elif mth == "Network.responseReceived":
            ev["resp"][p["requestId"]] = (p["response"]["status"], p["response"]["url"])
    return {}

def js(e):
    r = rpc("Runtime.evaluate", {"expression": e, "returnByValue": True, "awaitPromise": True})
    if "exceptionDetails" in (r or {}):
        return "EXC " + str(r["exceptionDetails"].get("exception", {}).get("description"))[:100]
    return (r or {}).get("result", {}).get("value")

def key(code, name):
    for t in ("keyDown", "keyUp"):
        rpc("Input.dispatchKeyEvent", {"type": t, "windowsVirtualKeyCode": code,
                                       "nativeVirtualKeyCode": code, "key": name, "code": name}, wait=2)
        time.sleep(0.05)
    time.sleep(0.7)

def shot(name):
    r = rpc("Page.captureScreenshot", {"format": "png"})
    data = (r or {}).get("data")
    if not data: print("  !! %s failed" % name); return
    path = os.path.join(OUT, name + ".png")
    open(path, "wb").write(base64.b64decode(data))
    print("  %-16s %s" % (name, os.path.basename(path)))

for d in ("Page", "Runtime", "Log", "Network"): rpc(d + ".enable", wait=2)
time.sleep(0.5)

js("window.__silo.enterHome()"); time.sleep(2.5); shot("1-home")
js("window.__silo.openSettings()"); time.sleep(1.2); shot("2-settings")
js("window.__silo.enterHome()"); time.sleep(2)
js("window.__silo.openSearch()"); js("window.__silo.runSearch('matrix')"); time.sleep(4); shot("3-search")
js("window.__silo.enterHome()"); time.sleep(2.5)
js("(async function(){var v=await window.__silo.api.views();var lib=v[1]||v[0];await window.__silo.openGrid({Id:lib.Id,Name:lib.Name});return document.title;})()"); time.sleep(4)
shot("4-library")
js("(function(){var c=window.__silo.state.gridCards;if(!c||!c.length)return 'no cards';window.__silo.openDetail(c[0].__item.Id);return 'opened';})()"); time.sleep(3); shot("5-detail")
js("window.__silo.enterHome()"); time.sleep(2)

bad = sorted({(st, u) for st, u in ev["resp"].values() if st >= 400})
errs = [c for c in ev["console"] if "WAM" not in c]
print("\n  console errors: %d" % len(errs))
for c in errs[:6]: print("    " + c[:150])
print("  requests: %d | 4xx/5xx: %d" % (len(ev["resp"]), len(bad)))
for st, u in bad[:8]: print("    %s %s" % (st, u[:140]))
print("  log entries: %d" % len(ev["log"]))
PY

echo
echo "done. open them with:  open $OUT"
[ "${KEEP:-0}" = "1" ] || pkill -f "9998:127.0.0.1:9998" 2>/dev/null
