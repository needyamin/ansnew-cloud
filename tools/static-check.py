#!/usr/bin/env python3
r"""
Static check for PHP unqualified class references that cannot be autoloaded.

Catches the bug class found in ANSNEW CLOUD: a class referenced as `Foo::bar()` or
`new Foo(...)` without a matching `use` import, so PHP resolves it against the
current namespace (e.g. App\Services\StorageManager) and fatals at runtime.

Resolution order mirrors PHP/composer PSR-4:
  1. class declared in the same file            -> OK
  2. imported via `use` (with optional alias)   -> OK if target file exists
  3. global / builtin class                     -> OK if in BUILTINS
  4. current-namespace sibling (PSR-4 path)     -> OK if file exists
  5. otherwise                                  -> FLAG
"""
import os
import re
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else "."
SRC_DIRS = ["src", "bin"]
PSR4_PREFIX = "App\\"
PSR4_BASE = "src"

# Strip /* */ and // comments plus quoted strings, so class-name-looking text
# inside docblocks or literals does not produce false positives.
# Note: '#' comments are intentionally not stripped, because PHP 8 attributes
# (#[Foo]) start with the same character.
STRIP_RE = re.compile(
    r"/\*.*?\*/"          # block comment
    r"|//[^\n]*"          # line comment
    r"|'(?:\\.|[^'\\])*'" # single-quoted string
    r'|"(?:\\.|[^"\\])*"',  # double-quoted string
    re.S,
)


def strip_noise(code):
    def repl(m):
        # keep newlines so line structure (and thus regex anchoring) survives
        return "\n" * m.group(0).count("\n")
    return STRIP_RE.sub(repl, code)

BUILTINS = {
    # SPL / core
    "Exception", "RuntimeException", "InvalidArgumentException", "LogicException",
    "Error", "TypeError", "ValueError", "Throwable", "Exception", "Closure",
    "ArrayObject", "ArrayIterator", "SplFileInfo", "SplFileObject", "SplTempFileObject",
    "RecursiveDirectoryIterator", "RecursiveIteratorIterator", "DirectoryIterator",
    "Generator", "WeakMap", "stdClass", "Traversable", "Countable", "IteratorAggregate",
    "JsonException", "JsonSerializable", "Stringable", "DateTimeImmutable", "DateTime",
    "DateInterval", "DateTimeZone", "Random\\Randomizer", "Random\\Engine\\Secure",
    # extensions used by the project
    "PDO", "PDOStatement", "PDOException", "ZipArchive", "finfo", "CurlHandle",
    "SimpleXMLElement", "DOMDocument", "XMLReader", "XMLWriter", "SessionHandler",
    # phpseclib / vendor (composer-managed, not PSR-4-mapped by our checker)
    "SSH2", "SFTP", "RSA", "AES", "Crypt", "Hash", "Random",
    "FTP", "Net", "System", "File",
}

USE_RE = re.compile(r"^\s*use\s+([A-Za-z_][A-Za-z0-9_\\]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?\s*;", re.M)
NS_RE = re.compile(r"^\s*namespace\s+([A-Za-z_][A-Za-z0-9_\\]*)\s*;", re.M)
CLASS_RE = re.compile(r"^\s*(?:final\s+|abstract\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)", re.M)
# Foo::bar  /  new Foo(  /  Foo $var  (type hint)
STATIC_RE = re.compile(r"(?<![\\\w$])([A-Z][A-Za-z0-9_]*)::")
NEW_RE = re.compile(r"new\s+(?![\\])([A-Z][A-Za-z0-9_]*)\s*[(\s;]")
# `use App\X\Y;` style is handled by USE_RE; also catch fully-qualified \App\...
FQ_RE = re.compile(r"\\App\\[A-Za-z0-9_\\]+")


def php_files():
    for d in SRC_DIRS:
        base = os.path.join(ROOT, d)
        for dirpath, _dirs, files in os.walk(base):
            for f in files:
                if f.endswith(".php"):
                    yield os.path.join(dirpath, f)


def cls_to_path(cls):
    """Map a fully-qualified class to its expected file under PSR4_BASE."""
    if not cls.startswith(PSR4_PREFIX):
        return None
    rel = cls[len(PSR4_PREFIX):].replace("\\", "/")
    return os.path.join(ROOT, PSR4_BASE, "App", rel + ".php")


problems = []
checked = 0

for path in sorted(php_files()):
    raw = open(path, encoding="utf-8", errors="replace").read()
    src = strip_noise(raw)
    ns_match = NS_RE.search(src)
    ns = ns_match.group(1) if ns_match else ""

    imports = {}
    for m in USE_RE.finditer(src):
        fq, alias = m.group(1), m.group(2)
        if fq.startswith("function ") or fq.startswith("const "):
            continue
        imports[alias or fq.split("\\")[-1]] = fq

    declared = set(CLASS_RE.findall(src))

    # collect referenced class names
    refs = set(STATIC_RE.findall(src)) | set(NEW_RE.findall(src))
    # ignore obvious non-class tokens
    refs -= {"self", "static", "parent"}
    checked += len(refs)

    for ref in sorted(refs):
        if ref in declared:
            continue                      # declared in this file
        if ref in imports:
            target = imports[ref]
            p = cls_to_path(target)
            if p is not None and not os.path.exists(p):
                problems.append((path, ref, f"imported as {target} but {p} is missing"))
            continue
        if ref in BUILTINS:
            continue
        # same-namespace sibling
        sibling = ns + "\\" + ref if ns else ref
        p = cls_to_path(sibling)
        if p is not None and os.path.exists(p):
            continue
        # maybe it's a vendor/global class we don't know about
        problems.append((path, ref, f"unresolved: would resolve to '{sibling}' (no use import, no such file)"))

if problems:
    print(f"FOUND {len(problems)} problem(s) across {checked} references:\n")
    for path, ref, why in problems:
        print(f"  {path}\n    -> {ref}: {why}\n")
    sys.exit(1)

print(f"OK: {checked} class references checked, all resolvable.")
