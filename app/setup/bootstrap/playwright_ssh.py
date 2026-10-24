"""Prepare dedicated keys for standard SSH remote forwarding to the runner."""
import os
from pathlib import Path
import shutil
import subprocess


def prepare_ssh(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    if not shutil.which("ssh") or not shutil.which("ssh-keygen"):
        raise RuntimeError("Local Chrome requires the OpenSSH client and ssh-keygen on this computer. See PLAYWRIGHT.md.")
    for name in ("id_ed25519", "ssh_host_ed25519_key"):
        key = directory / name
        if not key.is_file():
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key)], check=True)
        key.chmod(0o600)
        if os.name == "nt":
            identity = subprocess.run(["whoami"], capture_output=True, text=True, check=True).stdout.strip()
            subprocess.run(["icacls", str(key), "/inheritance:r", "/grant:r", identity + ":F"],
                           check=True, stdout=subprocess.DEVNULL)
    client_public = (directory / "id_ed25519.pub").read_text(encoding="utf-8").split()
    host_public = (directory / "ssh_host_ed25519_key.pub").read_text(encoding="utf-8").split()
    (directory / "authorized_keys").write_text(
        'restrict,port-forwarding,permitlisten="127.0.0.1:9222" ' + " ".join(client_public[:2]) + "\n", encoding="utf-8")
    (directory / "known_hosts").write_text(
        "suitecontainer-playwright " + " ".join(host_public[:2]) + "\n", encoding="utf-8")
