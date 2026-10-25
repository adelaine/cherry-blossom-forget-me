"""Create team distribution ZIPs that download private Python on first launch."""
import argparse
from pathlib import Path
import subprocess
import zipfile

PROJECT = Path(__file__).resolve().parents[2]
LAUNCHERS = {
    "windows-x64": {"start/start-windows.cmd"},
    "macos-arm64": {"start/start-macos.command"},
    "linux-x64": {"start/start-codebox"},
}
SUPPORT_FILES = {"windows-x64": {"start/connect-local-chrome.ps1"}}


def package(target, sources):
    output = PROJECT / "app/.cache/dist" / f"suitecontainer-{target}.zip"
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_suffix(".zip.partial")
    with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for relative in sources:
            relative = Path(relative).as_posix()
            parts = Path(relative).parts
            if any(part in (".cache", ".ai-docs", "node_modules", "dist", "build", ".agents", ".codex") for part in parts):
                continue
            if Path(relative).name in ("access-token", "connection.json", ".npmrc"):
                continue
            if parts[0] == "start" and relative not in LAUNCHERS[target] | SUPPORT_FILES.get(target, set()):
                continue
            if relative.startswith("app/container-setup/python/") and relative not in ("app/container-setup/python/runtimes.tsv", "app/container-setup/python/NOTICE.txt"):
                continue
            if not relative.startswith(("app/engine/", "app/container-setup/", "app/docs/", "start/")) and relative not in {"README.md", ".gitignore", ".gitattributes"}:
                continue
            if "test" in parts or "tests" in parts or any(part in (".npmrc", ".nems.env") or part.startswith(".env") for part in parts):
                continue
            path = PROJECT / relative
            if not path.is_file():
                continue
            info = zipfile.ZipInfo.from_file(path, "ns-suitecontainer/" + relative)
            info.create_system = 3
            executable = path.suffix in (".sh", ".command") or path.name == "start-codebox"
            info.external_attr = ((0o100755 if executable else 0o100644) << 16)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, path.read_bytes())
    partial.replace(output)
    print(f"{output} ({output.stat().st_size / 1_000_000:.1f} MB)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=LAUNCHERS, help="Build one platform package; default: all three.")
    arguments = parser.parse_args()
    sources = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=PROJECT).decode("utf-8").split("\0")
    for target in ([arguments.target] if arguments.target else LAUNCHERS):
        package(target, sorted(set(filter(None, sources))))
