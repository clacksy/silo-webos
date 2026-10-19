#!/usr/bin/env python3
"""Build silo-webos.ipk (a webOS installable package).

An IPK is an `ar` archive containing, in order:
    debian-binary   the text "2.0\n"
    control.tar.gz  package metadata
    data.tar.gz     the payload (usr/palm/applications/<id>/...)
"""
import io
import json
import os
import tarfile
import time

APP_ID = "org.silo.webos"
ROOT = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(ROOT, "appinfo.json")) as fh:
    VERSION = json.load(fh)["version"]
OUT = os.path.join(ROOT, "silo-webos.ipk")

SKIP_NAMES = {".DS_Store", "build.py", "make-icons.py", "silo-webos.ipk", "README.md", "HANDOFF.md", "seed.example.js"}
SKIP_DIRS = {"__pycache__", ".git", "tools"}


def tar_gz(members):
    buf = io.BytesIO()
    now = int(time.time())
    with tarfile.open(fileobj=buf, mode="w:gz", format=tarfile.GNU_FORMAT) as tf:
        for arcname, data, mode in members:
            info = tarfile.TarInfo(arcname)
            info.size = len(data)
            info.mode = mode
            info.mtime = now
            info.uid = 0
            info.gid = 0
            info.uname = "root"
            info.gname = "root"
            tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def ar_archive(members):
    out = io.BytesIO()
    out.write(b"!<arch>\n")
    now = int(time.time())
    for name, data in members:
        header = "{:<16}{:<12}{:<6}{:<6}{:<8}{:<10}`\n".format(
            name, now, 0, 0, "100644", len(data)
        ).encode("ascii")
        assert len(header) == 60, "ar header must be 60 bytes"
        out.write(header)
        out.write(data)
        if len(data) % 2:
            out.write(b"\n")
    return out.getvalue()


def collect_payload():
    members = []
    base = os.path.join(ROOT, "")
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for name in sorted(filenames):
            if name in SKIP_NAMES or name.startswith("."):
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, ROOT).replace(os.sep, "/")
            with open(full, "rb") as fh:
                data = fh.read()
            mode = 0o755 if os.access(full, os.X_OK) and not rel.endswith(
                (".html", ".css", ".js", ".json", ".png", ".md")
            ) else 0o644
            members.append(("usr/palm/applications/%s/%s" % (APP_ID, rel), data, mode))
    return members


CONTROL = """Package: {app_id}
Version: {version}
Architecture: all
Maintainer: silo-webos
Section: misc
Priority: optional
Description: Silo client for LG webOS TVs
 An unofficial Silo client for rooted LG webOS televisions. Connects to a
 Silo server's Jellyfin-compatible API: Quick Connect or password sign-in,
 library browsing, detail views and playback with resume tracking.
""".format(app_id=APP_ID, version=VERSION)


def main():
    payload = collect_payload()
    data_tar = tar_gz(payload)
    control_tar = tar_gz([("control", CONTROL.encode("utf-8"), 0o644)])
    debian_binary = b"2.0\n"

    ipk = ar_archive([
        ("debian-binary", debian_binary),
        ("control.tar.gz", control_tar),
        ("data.tar.gz", data_tar),
    ])

    with open(OUT, "wb") as fh:
        fh.write(ipk)

    print("built %s" % OUT)
    print("  payload files: %d" % len(payload))
    print("  size: %.1f KB" % (len(ipk) / 1024.0))
    for arcname, data, _ in payload:
        print("    %-72s %6d B" % (arcname, len(data)))


if __name__ == "__main__":
    main()
