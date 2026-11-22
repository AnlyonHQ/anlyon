"""Build the ChatGPT/Codex plugin ZIP with forward-slash entry names.

Windows' Compress-Archive writes backslashes into entry names, which OpenAI
rejects as unsafe paths. Run from the repository root:

    python sdks/typescript/mcp-server/scripts/build-plugin-zip.py

Output: dist/anlyon-plugin-<version>.zip in the mcp-server package.
"""
import json
import os
import zipfile

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugin")
SKIP_DIRS = {"review"}
SKIP_FILES = {"plugin-package.test.ts", ".DS_Store"}

with open(os.path.join(SRC, "plugin.json"), encoding="utf-8") as f:
    version = json.load(f)["version"]

dist = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dist")
os.makedirs(dist, exist_ok=True)
out = os.path.join(dist, f"anlyon-plugin-{version}.zip")
entries = []
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(SRC):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for name in sorted(files):
            if name in SKIP_FILES:
                continue
            full = os.path.join(root, name)
            arc = os.path.relpath(full, SRC).replace(os.sep, "/")
            z.write(full, arc)
            entries.append(arc)

for e in entries:
    print(e)
print("wrote", out)
