"""Shared host bootstrap, run by the project's private Python interpreter."""
import getpass
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import webbrowser

PROJECT = Path(__file__).resolve().parents[2]
WINDOWS = sys.platform == "win32"
MACOS = sys.platform == "darwin"
HOST_PLATFORM = "win32" if WINDOWS else "linux"
IMAGE = "suitecontainer-workspace"
OWNER = "suitecontainer.project"


def command(*args, capture=False, optional=False):
    args = [str(arg) for arg in args]
    # Windows npm is a batch command, rather than a native executable.
    if WINDOWS and args[0] == "npm":
        args = [os.environ["COMSPEC"], "/d", "/s", "/c", subprocess.list2cmdline(args)]
    result = subprocess.run(args, text=True, encoding="utf-8", errors="replace",
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.DEVNULL if optional else None)
    if result.returncode and not optional:
        raise subprocess.CalledProcessError(result.returncode, args)
    return result


def podman(*args, **kwargs):
    return command("podman", *args, **kwargs)


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
        if value and not any(char in value for char in "\r\n\0"):
            return value
    return ""


def import_token(auth_file, sources):
    try:
        auth = json.loads(auth_file.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return
    if not isinstance(auth, dict) or (isinstance(auth.get("gitlab-token"), str) and auth["gitlab-token"].strip()):
        return
    for source in sources:
        try:
            token = token_in(source.read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeError):
            continue
        if token:
            auth["gitlab-token"] = token
            auth_file.write_text(json.dumps(auth, indent=4) + "\n", encoding="utf-8")
            return


def prepare_host():
    if not WINDOWS:
        os.umask(0o077)
    for name in ("credentials", "repos", "sftp-files"):
        (PROJECT / name).mkdir(exist_ok=True)
    for name in ("suitecontainer.config", "credentials/auth"):
        destination = PROJECT / f"{name}.json"
        if not destination.exists():
            shutil.copyfile(PROJECT / f"{name}.example.json", destination)
    nems = Path(os.environ.get("SUITECONTAINER_NEMS_DIR", Path.home() / ".codex"))
    sources = [PROJECT / ".codex/config.toml", nems / "config.toml", PROJECT / ".nems.env", nems / ".nems.env"]
    if not os.environ.get("SUITECONTAINER_NEMS_DIR"):
        sources.append(Path.home() / ".nems.env")
    auth_file = PROJECT / "credentials/auth.json"
    import_token(auth_file, sources)
    if not WINDOWS:
        auth_file.chmod(0o600)


def host_path():
    if WINDOWS:
        import winreg
        additions = []
        for hive, key in ((winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"), (winreg.HKEY_CURRENT_USER, "Environment")):
            try:
                with winreg.OpenKey(hive, key) as registry:
                    additions.append(os.path.expandvars(winreg.QueryValueEx(registry, "Path")[0]))
            except OSError:
                pass
        for variable, suffix in (("LOCALAPPDATA", "Programs/Podman"), ("LOCALAPPDATA", "Microsoft/WinGet/Links"), ("ProgramFiles", "Podman")):
            if os.environ.get(variable):
                additions.append(str(Path(os.environ[variable]) / suffix))
        os.environ["PATH"] = os.pathsep.join([os.environ.get("PATH", ""), *additions])
    elif MACOS:
        os.environ["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/opt/podman/bin:" + os.environ.get("PATH", "")


def install_podman():
    host_path()
    if shutil.which("podman"):
        return
    if WINDOWS:
        if not shutil.which("winget"):
            raise RuntimeError("Windows Package Manager is missing. Install App Installer from Microsoft Store, then run start-windows.cmd again.")
        print("Installing Podman. Windows may ask for permission.", flush=True)
        command("winget", "install", "--id", "Podman.CLI", "--exact", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements")
        host_path()
    elif MACOS:
        if shutil.which("brew"):
            command("brew", "install", "podman")
        else:
            architecture = {"arm64": "arm64", "x86_64": "amd64"}.get(platform.machine())
            if not architecture:
                raise RuntimeError("This Mac processor is not supported by the Podman installer.")
            with tempfile.TemporaryDirectory(prefix="podman-installer-") as directory:
                package = Path(directory) / f"podman-installer-macos-{architecture}.pkg"
                print("Downloading the official Podman installer...", flush=True)
                command("curl", "--fail", "--location", "--show-error", "--silent", "--output", package,
                        f"https://github.com/podman-container-tools/podman/releases/latest/download/{package.name}")
                print("Installing Podman. macOS may ask for your password.", flush=True)
                command("sudo", "installer", "-pkg", package, "-target", "/")
    else:
        manager = shutil.which("dnf") or shutil.which("yum")
        if not manager:
            raise RuntimeError("Cannot install Podman automatically: this codebox needs dnf or yum. Ask your codebox administrator to install Podman.")
        elevate = [] if os.getuid() == 0 else ["sudo"]
        if elevate and not shutil.which("sudo"):
            raise RuntimeError("Installing Podman requires sudo access. Ask your codebox administrator to install Podman.")
        print(f"Podman is missing. Installing it with {Path(manager).name}...", flush=True)
        try:
            command(*elevate, manager, "install", "-y", "podman")
        except subprocess.CalledProcessError:
            print("Podman installation failed. Check the package manager error above, repository access, and sudo permissions, then run start-codebox again.", file=sys.stderr)
            raise
    if not shutil.which("podman"):
        raise RuntimeError("Podman was installed but is not available. Restart the launcher; Windows may require a restart.")


def start_machine():
    if not (WINDOWS or MACOS):
        return None
    machines = json.loads(podman("machine", "list", "--format", "json", capture=True).stdout)
    machine = next((item for item in machines if item.get("Running")), None)
    if not machine:
        if not machines:
            podman("machine", "init", "--now")
        else:
            machine = next((item for item in machines if item.get("Default")), machines[0])
            podman("machine", "start", machine["Name"])
        machines = json.loads(podman("machine", "list", "--format", "json", capture=True).stdout)
    return next((item for item in machines if item.get("Running") and item.get("Default")), None)


def container_name():
    # Preserve existing names so launches can reopen an app created by an older launcher.
    if WINDOWS:
        digest = hashlib.sha256(str(PROJECT).lower().encode()).hexdigest()[:16]
    else:
        # POSIX cksum is not the same algorithm as zlib.crc32.
        result = subprocess.run(["cksum"], input=str(PROJECT), text=True, capture_output=True, check=True)
        digest = result.stdout.split()[0]
    return f"suitecontainer-{digest}"


def inspect(name):
    result = podman("inspect", "--format", "json", name, capture=True, optional=True)
    if result.returncode:
        exists = podman("container", "exists", name, optional=True)
        if exists.returncode != 1:
            raise RuntimeError("Could not inspect the existing app. Check the Podman connection and retry. It will not be reused or removed.")
        return None
    try:
        items = json.loads(result.stdout)
        if len(items) != 1 or not isinstance(items[0].get("Config"), dict):
            raise ValueError()
        return items[0]
    except (ValueError, TypeError, AttributeError):
        raise RuntimeError("Could not read ownership information for the existing app. It will not be reused or removed.") from None


def confirm_owner(info):
    if (info["Config"].get("Labels") or {}).get(OWNER) != str(PROJECT):
        raise RuntimeError("Another container has this app name. It will not be reused or removed.")


def pm_mode():
    try:
        config = json.loads((PROJECT / "suitecontainer.config.json").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        config = {}
    try:
        auth = json.loads((PROJECT / "credentials/auth.json").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        auth = {}
    token = auth.get("gitlab-token") if isinstance(auth, dict) else None
    return (isinstance(config, dict) and config.get("PM_MODE") is True) or not isinstance(token, str) or not token.strip()


def machine_path(path):
    path = str(Path(path).resolve())
    if not re.match(r"^[A-Za-z]:[\\/]", path):
        raise RuntimeError(f"Podman's WSL machine cannot access this Windows path: {path}")
    return f"/mnt/{path[0].lower()}/{path[3:].replace(chr(92), '/')}"


def build_image(machine):
    with tempfile.TemporaryDirectory(prefix="suitecontainer-build-") as directory:
        directory = Path(directory)
        environment = os.environ
        user_config = environment.get("SUITECONTAINER_NPMRC") or environment.get("NPM_CONFIG_USERCONFIG") or environment.get("npm_config_userconfig")
        global_config = environment.get("NPM_CONFIG_GLOBALCONFIG") or environment.get("npm_config_globalconfig")
        if shutil.which("npm"):
            if not user_config:
                result = command("npm", "config", "get", "userconfig", capture=True, optional=True)
                if not result.returncode:
                    user_config = result.stdout.strip()
            if not global_config:
                result = command("npm", "config", "get", "globalconfig", capture=True, optional=True)
                if not result.returncode:
                    global_config = result.stdout.strip()
        candidates = {"npm-globalrc": global_config, "npmrc": user_config or Path.home() / ".npmrc",
                      "npm-rootrc": PROJECT / ".npmrc", "npm-projectrc": PROJECT / "app/.npmrc"}
        files = {}
        npm_environment = {key: value for key, value in environment.items() if key.lower().startswith("npm_config_")}
        for identifier, candidate in candidates.items():
            if candidate and Path(candidate).is_file():
                path = Path(candidate).resolve()
                contents = path.read_text(encoding="utf-8-sig")
                files[identifier] = path
                print(f"npm configuration: {path}", flush=True)
                for variable in re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", contents):
                    if variable in environment:
                        npm_environment[variable] = environment[variable]
        if not files:
            print("npm configuration: environment and container defaults", flush=True)
        if npm_environment:
            env_file = directory / "npm-env"
            env_file.write_bytes(b"".join(key.encode() + b"\0" + value.encode() + b"\0" for key, value in npm_environment.items()))
            files["npm-env"] = env_file
        if WINDOWS:
            certificates = {data for store in ("ROOT",) for data, encoding, _ in ssl.enum_certificates(store) if encoding == "x509_asn"}
            ca_file = directory / "npm-ca.pem"
            ca_file.write_text("".join(ssl.DER_cert_to_PEM_cert(data) for data in sorted(certificates)), encoding="ascii")
            files["npm-ca"] = ca_file
        secrets = []
        wsl = machine and machine.get("VMType") == "wsl"
        if environment.get("NSX_NPM_TOKEN"):
            if wsl:
                token_file = directory / "npm-token"
                token_file.write_text(environment["NSX_NPM_TOKEN"], encoding="utf-8")
                files["npm-token"] = token_file
            else:
                secrets += ["--secret", "id=npm-token,env=NSX_NPM_TOKEN,type=env"]
        convert = machine_path if wsl else str
        for identifier, path in files.items():
            secrets += ["--secret", f"id={identifier},src={convert(path)}"]
        arguments = ["build", *secrets, "-f", convert(PROJECT / "setup/Containerfile"), "--ignorefile", convert(PROJECT / "setup/.containerignore"), "--build-arg", "SUITECLOUD_CLI_ACCEPT_LICENSE=true"]
        if not (WINDOWS or MACOS):
            environment.setdefault("SUITECLOUD_PROXY", "http://proxy.eng.netsuite.com:80")
            arguments += ["--build-arg", "SUITECLOUD_PROXY"]
        arguments += ["-t", IMAGE, convert(PROJECT)]
        print("Preparing the SuiteCloud container...", flush=True)
        if wsl:
            podman("machine", "ssh", machine["Name"], "--", shlex.join(["podman", *arguments]))
        else:
            podman(*arguments)


def start_web(name):
    host = ["--env", f"SUITECONTAINER_HOST_ROOT={PROJECT}", "--env", f"SUITECONTAINER_HOST_PLATFORM={HOST_PLATFORM}"]
    base = ["--mount", f"type=bind,src={PROJECT},dst=/project,ro=true", *host]
    target = podman("run", "--rm", "--cgroups=disabled", *base, IMAGE, "--web-ssh-target", capture=True).stdout.strip()
    resolved = ""
    if target and shutil.which("ssh"):
        result = command("ssh", "-G", "-T", f"nsbuild@{target}", capture=True, optional=True)
        if not result.returncode:
            resolved = result.stdout
    ssh = ["--env", f"SUITECONTAINER_SSH_TARGET={target}", "--env", f"SUITECONTAINER_SSH_RESOLVED={resolved}", "--env", f"SUITECONTAINER_SSH_HOME={Path.home()}"]
    for key in ("SUITECONTAINER_SSH_KEY", "SUITECONTAINER_SSH_KNOWN_HOSTS"):
        if os.environ.get(key):
            ssh += ["--env", f"{key}={os.environ[key]}"]
    if WINDOWS:
        ssh += ["--env", f"SUITECONTAINER_SSH_PROGRAMDATA={os.environ.get('ProgramData', '')}"]
    requests = podman("run", "--rm", "--cgroups=disabled", *base, *ssh, IMAGE, "--web-paths", capture=True).stdout
    staged = ["--mount", f"type=bind,src={PROJECT},dst=/project"]
    for request in requests.splitlines():
        if not request:
            continue
        kind, identifier, path = request.split("\t", 2)
        present = Path(path).is_dir() if kind in ("local", "sftp") else Path(path).is_file()
        if present:
            if kind == "external":
                identifier += ".pem"
            staged += ["--mount", f"type=bind,src={path},dst=/{kind}/{identifier},ro=true"]
    result = podman("run", "--rm", "--cgroups=disabled", *staged, *ssh, *host, IMAGE, "--web-mounts", capture=True)
    mounts = [argument for mount in result.stdout.splitlines() if mount for argument in ("--mount", mount)]
    if not podman("container", "exists", name, optional=True).returncode:
        info = inspect(name)
        if info is None:
            raise RuntimeError("Could not inspect the existing app. Check the Podman connection and retry. It will not be reused or removed.")
        confirm_owner(info)
        podman("rm", name, capture=True)
    arguments = ["run", "-d", "--name", name, "--label", f"{OWNER}={PROJECT}", "--cgroups=disabled", "--publish", "127.0.0.1::8080", "--publish", "127.0.0.1::8000", "--env", "SUITECONTAINER_SFTP=1"]
    if not (WINDOWS or MACOS):
        arguments += ["--env", f"SUITECONTAINER_HOST_FQDN={command('hostname', '-f', capture=True, optional=True).stdout.strip()}"]
    podman(*arguments, *mounts, IMAGE, "--serve", capture=True)


def open_page(name):
    addresses = podman("port", name, "8080/tcp", capture=True).stdout.splitlines()
    if not addresses:
        raise RuntimeError("Could not find the deployment page port.")
    port = addresses[0].rsplit(":", 1)[-1]
    # Loopback readiness should not depend on the host's corporate HTTP proxy.
    http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(60):
        suffix = podman("exec", name, "cat", "/tmp/suitecontainer-web-url", capture=True, optional=True)
        if not suffix.returncode and suffix.stdout.strip():
            try:
                with http.open(f"http://127.0.0.1:{port}/health", timeout=2):
                    url = f"http://127.0.0.1:{port}{suffix.stdout.strip()}"
                print(f"Deployment page: {url}", flush=True)
                if WINDOWS or MACOS:
                    try:
                        if not webbrowser.open(url):
                            print("Open the address above in your browser.")
                    except OSError:
                        print("Open the address above in your browser.")
                else:
                    hostname = command("hostname", "-f", capture=True).stdout.strip()
                    print(f"From your computer, forward the port: ssh -N -L {port}:127.0.0.1:{port} {getpass.getuser()}@{hostname}")
                    print("Then open the deployment page address above in your browser.")
                print("The app stops automatically when unused. Running deployments and SQL jobs are allowed to finish. Use Stop app to stop it sooner, or run the launcher again to reopen it.")
                return
            except (OSError, urllib.error.URLError):
                pass
        info = inspect(name)
        if not info or not info.get("State", {}).get("Running"):
            podman("logs", name, optional=True)
            raise RuntimeError("The deployment page could not start.")
        time.sleep(1)
    raise RuntimeError("The deployment page did not become ready. Check the container logs and relaunch.")


def main():
    prepare_host()
    install_podman()
    machine = start_machine()
    name = container_name()
    info = inspect(name)
    if info and info.get("State", {}).get("Running"):
        confirm_owner(info)
    else:
        image = podman("image", "exists", IMAGE, optional=True)
        if image.returncode == 1:
            archive = PROJECT / "container-image/suitecontainer-workspace.tar"
            if archive.is_file():
                print(f"Loading the shared SuiteCloud image from {archive}...", flush=True)
                podman("load", "-i", archive)
                image = podman("image", "exists", IMAGE, optional=True)
                if image.returncode:
                    raise RuntimeError(f"The archive did not contain the {IMAGE} image: {archive}")
            elif pm_mode():
                raise RuntimeError(f"Copy the shared {IMAGE} image archive to {archive}, then run the launcher again.")
            else:
                build_image(machine)
        elif image.returncode:
            raise RuntimeError("Could not check the local SuiteCloud image. Check the Podman connection and retry.")
        start_web(name)
    open_page(name)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        print(f"Setup stopped: {Path(error.cmd[0]).name} failed (exit {error.returncode}). Review the error above and retry.", file=sys.stderr)
        sys.exit(error.returncode if 0 < error.returncode < 256 else 1)
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Setup could not finish: {error}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
