import base64, json, os, socket, struct, sys, time, urllib.request
from urllib.parse import urlparse

def ws_connect(host, port, path):
    s = socket.create_connection((host, port), timeout=10)
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall(("GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n"
               % (path, host, port, key)).encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        c = s.recv(4096)
        if not c: raise RuntimeError("closed")
        buf += c
    if b"101" not in buf.split(b"\r\n")[0]: raise RuntimeError(buf[:120])
    return s

def ws_send(s, text):
    p = text.encode(); h = bytearray([0x81]); n = len(p)
    if n < 126: h.append(0x80 | n)
    elif n < 65536: h.append(0x80 | 126); h += struct.pack(">H", n)
    else: h.append(0x80 | 127); h += struct.pack(">Q", n)
    m = os.urandom(4); h += m
    s.sendall(bytes(h) + bytes(b ^ m[i % 4] for i, b in enumerate(p)))

def ws_recv(s):
    h = b""
    while len(h) < 2:
        c = s.recv(2 - len(h))
        if not c: return None
        h += c
    n = h[1] & 0x7F
    if n == 126: n = struct.unpack(">H", s.recv(2))[0]
    elif n == 127: n = struct.unpack(">Q", s.recv(8))[0]
    d = b""
    while len(d) < n:
        c = s.recv(n - len(d))
        if not c: break
        d += c
    return d.decode("utf8", "replace")

targets = json.loads(urllib.request.urlopen("http://127.0.0.1:9998/json", timeout=10).read())
page = next(t for t in targets if t.get("url","").endswith("index.html"))
u = urlparse(page["webSocketDebuggerUrl"])
s = ws_connect("127.0.0.1", 9998, u.path)
_id = [0]

def rpc(method, params):
    _id[0] += 1
    ws_send(s, json.dumps({"id": _id[0], "method": method, "params": params}))
    while True:
        msg = ws_recv(s)
        if msg is None: return {"__no_response__": True}
        try: obj = json.loads(msg)
        except Exception: continue
        if obj.get("id") != _id[0]: continue
        return obj.get("result", {})

def js(expr):
    r = rpc("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
    if "exceptionDetails" in r:
        d = r["exceptionDetails"]
        return "EXC: " + (d.get("exception", {}).get("description") or d.get("text", "?"))[:140].replace("\n", " ")
    return r.get("result", {}).get("value")

def key(code, k, ptype="keyDown"):
    rpc("Input.dispatchKeyEvent", {"type": ptype, "windowsVirtualKeyCode": code,
                                   "nativeVirtualKeyCode": code, "key": k, "code": k})

def press(code, k):
    key(code, k, "keyDown"); time.sleep(0.08); key(code, k, "keyUp"); time.sleep(0.45)

def check(label, cond, detail):
    print("  [%s] %-34s %s" % ("PASS" if cond else "FAIL", label, detail))
    return bool(cond)

results = []
print("PHASE 1 — direct calls via the diagnostics hook")
sym = js("JSON.stringify({hook: typeof window.__silo, openSearch: typeof window.__silo.openSearch, openSettings: typeof window.__silo.openSettings, searchKey: typeof window.__silo.searchKey, settingsKey: typeof window.__silo.settingsKey, publicInfo: typeof window.__silo.api.publicInfo})")
print("  symbols:", sym)
t = js("(function(){ window.__silo.openSettings(); return document.title; })()")
results.append(check("openSettings() opens screen", t == "Silo · settings", t))
rows = js("document.querySelectorAll('#settings-list .set-row').length")
heads = js("document.querySelectorAll('#settings-list .set-header').length")
results.append(check("settings rows render", isinstance(rows, int) and rows >= 8, "rows=%s headers=%s" % (rows, heads)))
info = js("(async function(){ var i = await window.__silo.api.publicInfo(); return i.ServerName + ' / ' + i.Version; })()")
results.append(check("api.publicInfo() works", isinstance(info, str) and "Silo" in info, info))
t = js("(function(){ window.__silo.openSearch(); return document.title; })()")
results.append(check("openSearch() opens screen", t == "Silo · search", t))
n = js("(async function(){ await window.__silo.runSearch('star wars'); return document.querySelectorAll('#search-grid .card').length; })()")
results.append(check("search returns results", isinstance(n, int) and n > 0, "cards=%s" % n))
hint = js("document.getElementById('search-hint').textContent")
print("  search hint:", hint)
t = js("(async function(){ await window.__silo.enterHome(); return document.title; })()")
results.append(check("returns to home", isinstance(t, str) and "home" in t, t))

print("\nPHASE 2 — real remote-key path (Down to Libraries row, Enter)")
time.sleep(1)
for _ in range(10): press(40, "ArrowDown")
press(13, "Enter")
time.sleep(1.2)
t = js("document.title")
results.append(check("Enter on first Libraries tile", t == "Silo · search", t))

active = lambda: js("document.activeElement && document.activeElement.id")
rpc("Input.insertText", {"text": "star warsx"})
press(8, "Backspace")
t, v = js("document.title"), js("document.getElementById('search-input').value")
results.append(check("Backspace deletes, stays on search", t == "Silo · search" and v == "star wars", "%s / %r" % (t, v)))
press(13, "Enter"); time.sleep(3)
n = js("document.querySelectorAll('#search-grid .card.focused').length")
results.append(check("Enter searches, focuses a result", n == 1, "focused=%s" % n))
press(38, "ArrowUp")
results.append(check("Up from top row returns to input", active() == "search-input", active()))
press(461, "GoBack")
t = js("document.title")
results.append(check("Back closes keyboard, stays on search", t == "Silo · search" and active() != "search-input", "%s / %s" % (t, active())))
press(13, "Enter"); time.sleep(3)
results.append(check("Enter on result opens detail", js("document.title") == "Silo · detail", js("document.title")))
press(461, "GoBack"); time.sleep(0.5)
results.append(check("Back from detail returns to search", js("document.title") == "Silo · search", js("document.title")))
press(461, "GoBack"); time.sleep(1.2)
t = js("document.title")
results.append(check("Back returns home", isinstance(t, str) and "home" in t, t))

print("\nPHASE 3 — Settings tile via Right then Enter")
for _ in range(10): press(40, "ArrowDown")
press(39, "ArrowRight")
press(13, "Enter")
time.sleep(1.2)
t = js("document.title")
results.append(check("Enter on Settings tile", t == "Silo · settings", t))
press(461, "GoBack"); time.sleep(1)

fatal = js("(function(){ var f = document.getElementById('fatal'); return f.classList.contains('hidden') ? '' : f.textContent; })()")
results.append(check("no errors in the #fatal bar", fatal == "", fatal or "clean"))

print("\n%d/%d checks passed" % (sum(results), len(results)))
