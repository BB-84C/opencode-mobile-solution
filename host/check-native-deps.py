#!/usr/bin/env python3
"""Every package.json dependency that ships an iOS podspec must be present in ios/Podfile.lock.
A JS bundle that calls a native module the binary lacks dies with an uncaught JS error the first
time that code runs (2026-10-16: react-native-webview / react-native-uitextview, entering a session).
Usage: check-native-deps.py APP_DIR [LOCKFILE]   exit 0 = all linked, 1 = missing (names printed)."""
import json, re, sys, glob, os
app = sys.argv[1]; lock = sys.argv[2] if len(sys.argv) > 2 else os.path.join(app, 'ios/Podfile.lock')
text = open(lock).read()
locked = set(re.findall(r'^  - "?([A-Za-z0-9_+.-]+?)(?:/[^ "]*)? \(', text, re.M))
deps = json.load(open(os.path.join(app, 'package.json'))).get('dependencies', {})
missing = []
for d in deps:
    root = os.path.join(app, 'node_modules', d)
    specs = glob.glob(os.path.join(root, '*.podspec')) + glob.glob(os.path.join(root, 'ios', '*.podspec'))
    for spec in specs:
        name = os.path.basename(spec)[:-len('.podspec')]
        m = re.search(r'''\.name\s*=\s*['"]([^'"]+)['"]''', open(spec, errors='ignore').read())
        if m and not m.group(1).startswith('#'): name = m.group(1)
        if name not in locked and d not in locked:
            missing.append(f'{d} (pod {name})')
for m in missing: print('MISSING', m)
print(f'checked {len(deps)} deps: {"all native deps linked" if not missing else f"{len(missing)} native dep(s) not in Podfile.lock"}')
sys.exit(1 if missing else 0)
