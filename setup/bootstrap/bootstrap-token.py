"""Best-effort token discovery on codeboxes with Python already installed."""
import json
import re
import sys
from pathlib import Path


def token_in(contents):
    section = ""
    for line in contents.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        heading = re.fullmatch(r"\[([^\]]+)\]", line)
        if heading:
            section = heading[1].lower()
            continue
        setting = re.search(r'''(?:^|[{,]\s*)["']?((?:nems_)?gitlab_(?:(?:personal_access|private_access|personal|private|access|api)_)?token|gitlab_pat|gitlab\.token)["']?\s*=\s*("[^"]*"|'[^']*')''', line, re.I) or re.match(r'''^(?:export\s+)?["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*=\s*(.*?)\s*$''', line)
        if not setting:
            continue
        key = setting[1].lower()
        if not (re.fullmatch(r"(?:nems_)?gitlab_(?:(?:personal_access|private_access|personal|private|access|api)_)?token", key) or key in ("gitlab_pat", "gitlab.token") or (section == "gitlab" and key in ("token", "access_token", "private_token", "personal_access_token", "pat"))):
            continue
        value = setting[2].strip()
        if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
            value = value[1:-1]
        else:
            value = re.sub(r"\s+#.*$", "", value)
        if value and not any(c in value for c in "\r\n\0"):
            return value
    return ""


def main(args):
    auth_file = Path(args[0])
    try:
        auth = json.loads(auth_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if not isinstance(auth, dict) or (isinstance(auth.get("gitlab-token"), str) and auth["gitlab-token"].strip()):
        return
    for source in args[1:]:
        try:
            token = token_in(Path(source).read_text(encoding="utf-8"))
        except (OSError, UnicodeError):
            continue
        if token:
            auth["gitlab-token"] = token
            auth_file.write_text(json.dumps(auth, indent=4) + "\n", encoding="utf-8")
            return


if __name__ == "__main__":
    main(sys.argv[1:])
