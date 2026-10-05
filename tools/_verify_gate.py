#!/usr/bin/env python3
"""Live API verification of the SensitiveGate + new endpoints.
Read-only-ish: only clears 0 favourites and toggles the gate twice (reverted)."""
import json, urllib.request, urllib.error, http.cookiejar, os

BASE = os.environ.get("BASE", "http://localhost:8080")
USER, PW = "admin", "admin"

jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

def call(method, path, body=None, csrf=None, origin=BASE):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json", "Origin": origin}
    if csrf:
        headers["X-CSRF-Token"] = csrf
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with op.open(req, timeout=20) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def parse(raw):
    try:
        j = json.loads(raw)
    except Exception:
        return None, None, raw
    if isinstance(j, dict) and j.get("ok") is True:
        return j.get("data"), None, raw
    if isinstance(j, dict) and "error" in j:
        err = j["error"]
        return None, err.get("code"), raw
    return j, None, raw

def show(label, status, raw):
    data, errcode, _ = parse(raw)
    print(f"[{status}] {label} errcode={errcode}")
    return data

print("== bootstrap (initial CSRF) ==")
st, raw = call("GET", "/api/bootstrap")
data = show("bootstrap", st, raw)
boot_csrf = (data or {}).get("csrf")
assert boot_csrf, "no csrf from bootstrap"
print("   gateDeleteTrash =", (data or {}).get("sensitive", {}).get("gateDeleteTrash"))

print("\n== login ==")
st, raw = call("POST", "/api/auth/login", {"username": USER, "password": PW}, csrf=boot_csrf)
data = show("login", st, raw)
csrf = (data or {}).get("csrf")
assert csrf, "no csrf from login"
assert (data or {}).get("user"), "no user in login response"

print("\n== GATE: DELETE /api/favorites/all WITHOUT grant (expect 403 sensitive_required) ==")
st, raw = call("DELETE", "/api/favorites/all", csrf=csrf)
data, code, _ = parse(raw)
show("fav-all no-grant", st, raw)
assert st == 403 and code == "sensitive_required", "FAIL: gate not enforced on favorites.clear"

print("\n== confirm password for favorites.clear ==")
st, raw = call("POST", "/api/auth/confirm", {"scope": "favorites.clear", "password": PW}, csrf=csrf)
data = show("confirm favorites.clear", st, raw)
assert st == 200, "FAIL: confirm did not grant"

print("\n== GATE: DELETE /api/favorites/all WITH grant (expect 200) ==")
st, raw = call("DELETE", "/api/favorites/all", csrf=csrf)
data = show("fav-all with-grant", st, raw)
assert st == 200, "FAIL: grant not honoured"

print("\n== GATE: DELETE /api/drives/{id} WITHOUT grant (expect 403 sensitive_required) ==")
st, raw = call("GET", "/api/drives", csrf=csrf)
data = show("list drives", st, raw)
drives = (data or {}).get("drives") or []
did = drives[0]["id"] if drives else None
print("   first drive id =", did)
if did:
    st, raw = call("DELETE", f"/api/drives/{did}", csrf=csrf)
    show("drive disconnect no-grant", st, raw)
    _, code, _ = parse(raw)
    assert st == 403 and code == "sensitive_required", "FAIL: gate not enforced on drive.disconnect"

print("\n== ADMIN GATE TOGGLE: off then on ==")
st, raw = call("POST", "/api/admin/security/gate", {"gateDeleteTrash": False}, csrf=csrf)
show("toggle off", st, raw)
assert st == 200, "FAIL: admin gate toggle"
st, raw = call("GET", "/api/bootstrap", csrf=csrf)
data = show("bootstrap after off", st, raw)
assert (data or {}).get("sensitive", {}).get("gateDeleteTrash") is False, "FAIL: toggle did not flip"
st, raw = call("POST", "/api/admin/security/gate", {"gateDeleteTrash": True}, csrf=csrf)
show("toggle on", st, raw)
st, raw = call("GET", "/api/bootstrap", csrf=csrf)
data = show("bootstrap after on", st, raw)
assert (data or {}).get("sensitive", {}).get("gateDeleteTrash") is True, "FAIL: toggle did not revert"

print("\n== rename-batch wiring: non-existent file (expect handled, not 500/sensitive_required) ==")
# mountFor() resolves on the mount NAME (m.name), which the SPA passes from
# bootstrap.mounts[].name — not the drive id.
mounts = (data or {}).get("mounts") or []
mname = mounts[0]["name"] if mounts else (drives[0].get("name") if drives else "local")
print("   using mount name =", mname)
st, raw = call("POST", f"/api/fs/{mname}/rename-batch",
               {"items": [{"from": "does-not-exist-xyz.txt", "to": "renamed-xyz.txt"}]}, csrf=csrf)
show("rename-batch missing", st, raw)
_, code, _ = parse(raw)
assert st in (200, 400, 404, 422), f"FAIL: rename-batch crashed with {st}"
assert code != "sensitive_required", "FAIL: rename-batch should not be gated"

print("\nALL GATE CHECKS PASSED")
