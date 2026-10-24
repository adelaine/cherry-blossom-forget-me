"""Create team distribution ZIPs that download private Python on first launch."""
import argparse
from pathlib import Path
import subprocess
import zipfile

PROJECT = Path(__file__).resolve().parent.parent
LAUNCHERS = {
    "windows-x64": {"start-windows.cmd"},
    "macos-arm64": {"start-macos.command"},
    "linux-x64": {"start-codebox"},
}


def package(target, sources):
    output = PROJECT / "dist" / f"suitecontainer-{target}.zip"
    output.parent.mkdir(exist_ok=True)
    partial = output.with_suffix(".zip.partial")
    with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for relative in sources:
            parts = Path(relative).parts
            if any(part in (".cache", ".ai-docs", "node_modules", "dist", "build", ".agents", ".codex") for part in parts):
                continue
            if Path(relative).name in ("access-token", "connection.json", ".npmrc"):
                continue
            if parts[0].startswith("start-") and relative not in LAUNCHERS[target]:
                continue
            if relative.startswith("setup/python/") and relative not in ("setup/python/runtimes.tsv", "setup/python/NOTICE.txt"):
                continue
            if parts[0] not in ("app", "setup", "docs", "credentials", "sftp-files", "container-image") and relative not in {"README.md", ".gitignore", ".gitattributes", "suitecontainer.config.example.json", *LAUNCHERS[target]}:
                continue
            if "test" in parts or "tests" in parts or any(part in (".npmrc", ".nems.env") or part.startswith(".env") for part in parts):
                continue
            if parts[0] == "credentials" and relative not in ("credentials/auth.example.json", "credentials/.sql-default"):
                continue
            if parts[0] == "sftp-files" and relative != "sftp-files/.gitkeep":
                continue
            if parts[0] == "container-image" and relative != "container-image/.gitkeep":
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
