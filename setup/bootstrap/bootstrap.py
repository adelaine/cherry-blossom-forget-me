"""Shared host bootstrap, run by the project's private Python interpreter."""
import argparse
from contextlib import contextmanager, redirect_stdout
import getpass
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shlex
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import urllib.parse
import uuid
import webbrowser

PROJECT = Path(__file__).resolve().parents[2]
WINDOWS = sys.platform == "win32"
MACOS = sys.platform == "darwin"
HOST_PLATFORM = "win32" if WINDOWS else "linux"
IMAGE = "suitecontainer-workspace"
DEVELOPER_IMAGE = "container-registry.eng.netsuite.com/oracle/oraclelinux9-nodejs:24"
BASE_IMAGE = "ghcr.io/oracle/oraclelinux9-nodejs:24"
OWNER = "suitecontainer.project"
OPTIONS = argparse.Namespace(dev=False, no_browser=False, non_interactive=False, json=False, project=None)
TOOLS_LABEL = "suitecontainer.tools"
DEPENDENCIES_LABEL = "suitecontainer.dependencies"


def secure_path(path):
    """Make runtime credentials accessible only to the launching OS user."""
    if path.is_symlink():
        raise RuntimeError(f"Secure credential storage cannot use a symbolic link: {path}")
    if WINDOWS:
        script = """$ErrorActionPreference='Stop'; $p=$env:SUITECONTAINER_SECURE_PATH;
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
$directory=Test-Path -LiteralPath $p -PathType Container;
if($directory){$acl=[Security.AccessControl.DirectorySecurity]::new(); $flags=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}
else{$acl=[Security.AccessControl.FileSecurity]::new(); $flags=[Security.AccessControl.InheritanceFlags]::None};
$acl.SetAccessRuleProtection($true,$false);
$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',$flags,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);
$acl.AddAccessRule($rule);
if($directory){[IO.Directory]::SetAccessControl($p,$acl)}
else{[IO.File]::SetAccessControl($p,$acl)}"""
        result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                                env={**os.environ, "SUITECONTAINER_SECURE_PATH": str(path)}, capture_output=True, text=True)
        if result.returncode:
            detail = result.stderr.strip() or "Windows PowerShell could not apply the filesystem ACL."
            raise RuntimeError(f"Cannot establish owner-only Windows permissions for {path}. Check filesystem ACL support and your ownership, then relaunch.\n{detail}")
    else:
        path.chmod(0o700 if path.is_dir() else 0o600)
        if path.stat().st_mode & 0o077:
            raise RuntimeError(f"Cannot establish owner-only permissions for {path}. Use a filesystem that supports POSIX permissions.")


def runtime_directory():
    directory = PROJECT / ".cache/runtime"
    directory.mkdir(parents=True, exist_ok=True)
    secure_path(directory)
    return directory


@contextmanager
def startup_lock():
    path = runtime_directory() / "startup.lock"
    with path.open("a+b") as lock:
        secure_path(path)
        if lock.tell() == 0:
            lock.write(b"\0")
            lock.flush()
        lock.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise RuntimeError("Another launcher is starting this project. Wait for it to finish and run the launcher again.") from None
        try:
            yield
        finally:
            lock.seek(0)
            if os.name == "nt":
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock, fcntl.LOCK_UN)


def write_private_json(path, value):
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("x", encoding="utf-8") as output:
            secure_path(temporary)
            json.dump(value, output, indent=2)
            output.write("\n")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def dependency_fingerprint():
    paths = ["app/package.json", "app/server/package.json", "app/client/package.json", "app/package-lock.json"]
    digest = hashlib.sha256()
    for relative in paths:
        path = PROJECT / relative
        if not path.is_file():
            raise RuntimeError(f"Development mode needs {relative}. Restore the committed application dependency files and relaunch.")
        digest.update(relative.encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def tooling_fingerprint():
    digest = hashlib.sha256()
    for relative in ("setup/Containerfile", "setup/gitlab-askpass.sh", "setup/sftp/start.sh", "app/run-npm.mjs"):
        digest.update(relative.encode())
        digest.update((PROJECT / relative).read_bytes())
    return digest.hexdigest()


def command(*args, capture=False, optional=False):
    args = [str(arg) for arg in args]
    # Windows npm is a batch command, rather than a native executable.
    if WINDOWS and args[0] == "npm":
        args = [os.environ["COMSPEC"], "/d", "/s", "/c", subprocess.list2cmdline(args)]
    result = subprocess.run(args, text=True, encoding="utf-8", errors="replace",
                            stdout=subprocess.PIPE if capture else (sys.stderr if OPTIONS.json else None),
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
    credentials_created = not (PROJECT / "credentials").exists()
    for name in ("credentials", "repos", "sftp-files"):
        (PROJECT / name).mkdir(exist_ok=True)
    # Existing checkouts can have a credentials directory owned by a different
    # setup account. Protect every credential file without changing that owner.
    if credentials_created:
        secure_path(PROJECT / "credentials")
    for name in ("suitecontainer.config", "credentials/auth"):
        destination = PROJECT / f"{name}.json"
        if not destination.exists():
            shutil.copyfile(PROJECT / f"{name}.example.json", destination)
    nems = Path(os.environ.get("SUITECONTAINER_NEMS_DIR", Path.home() / ".codex"))
    sources = [PROJECT / ".codex/config.toml", nems / "config.toml", PROJECT / ".nems.env", nems / ".nems.env"]
    if not os.environ.get("SUITECONTAINER_NEMS_DIR"):
        sources.append(Path.home() / ".nems.env")
    auth_file = PROJECT / "credentials/auth.json"
    secure_path(auth_file)
    import_token(auth_file, sources)
    for path in (PROJECT / "credentials").iterdir():
        if path.is_file():
            secure_path(path)


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
    if OPTIONS.non_interactive:
        raise RuntimeError("Podman is not installed. Install Podman and initialize its machine, then run the launcher again. Noninteractive startup cannot request installation privileges.")
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
        if OPTIONS.non_interactive and not machines:
            raise RuntimeError("No Podman machine is configured. Run podman machine init --now interactively, then relaunch.")
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
    return isinstance(config, dict) and config.get("PM_MODE") is True


def machine_path(path):
    path = str(Path(path).resolve())
    if not re.match(r"^[A-Za-z]:[\\/]", path):
        raise RuntimeError(f"Podman's WSL machine cannot access this Windows path: {path}")
    return f"/mnt/{path[0].lower()}/{path[3:].replace(chr(92), '/')}"


def build_podman(machine, *arguments, **kwargs):
    if machine and machine.get("VMType") == "wsl":
        return podman("machine", "ssh", machine["Name"], "--", shlex.join(["podman", *arguments]), **kwargs)
    return podman(*arguments, **kwargs)


def select_base_image(machine):
    print("Checking the internal base image...", flush=True)
    result = build_podman(machine, "pull", "--retry=0", DEVELOPER_IMAGE, capture=True, optional=True)
    if not result.returncode:
        return DEVELOPER_IMAGE
    print("The internal base image could not be pulled. Trying Oracle's public image...", flush=True)
    build_podman(machine, "pull", "--retry=0", BASE_IMAGE)
    return BASE_IMAGE


def build_image(machine):
    base_image = select_base_image(machine)
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
        arguments = ["build", "--build-arg", f"SUITECONTAINER_BASE_IMAGE={base_image}", *secrets, "-f", convert(PROJECT / "setup/Containerfile"), "--ignorefile", convert(PROJECT / "setup/.containerignore"), "--build-arg", "SUITECLOUD_CLI_ACCEPT_LICENSE=true"]
        if OPTIONS.dev:
            arguments += ["--target", "development", "--label", f"{TOOLS_LABEL}={tooling_fingerprint()}"]
        if not (WINDOWS or MACOS):
            environment.setdefault("SUITECLOUD_PROXY", "http://proxy.eng.netsuite.com:80")
            arguments += ["--build-arg", "SUITECLOUD_PROXY"]
        arguments += ["-t", IMAGE, convert(PROJECT)]
        print("Preparing the SuiteCloud container...", flush=True)
        build_podman(machine, *arguments)


def start_web(name, extra_arguments=(), instance_id=None, dependencies=None):
    host = ["--env", f"SUITECONTAINER_HOST_ROOT={PROJECT}", "--env", f"SUITECONTAINER_HOST_PLATFORM={HOST_PLATFORM}"]
    helper_options = (["--mount", f"type=bind,src={PROJECT / 'app'},dst=/app,ro=true",
                       "--mount", f"type=volume,src={development_volume(name)},dst=/app/node_modules",
                       "--mount", f"type=volume,src={development_volume(name)}-server,dst=/app/server/node_modules",
                       "--mount", f"type=volume,src={development_volume(name)}-client,dst=/app/client/node_modules",
                       "--entrypoint", "node"] if OPTIONS.dev else [])
    helper = [IMAGE, "--experimental-strip-types", "/app/src/install.ts"] if OPTIONS.dev else [IMAGE]
    base = ["--mount", f"type=bind,src={PROJECT},dst=/project,ro=true", *host, *helper_options]
    target = podman("run", "--rm", "--cgroups=disabled", *base, *helper, "--web-ssh-target", capture=True).stdout.strip()
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
    requests = podman("run", "--rm", "--cgroups=disabled", *base, *ssh, *helper, "--web-paths", capture=True).stdout
    staged = ["--mount", f"type=bind,src={PROJECT},dst=/project", *helper_options]
    for request in requests.splitlines():
        if not request:
            continue
        kind, identifier, path = request.split("\t", 2)
        present = Path(path).is_dir() if kind in ("local", "sftp") else Path(path).is_file()
        if present:
            if kind == "external":
                identifier += ".pem"
            staged += ["--mount", f"type=bind,src={path},dst=/{kind}/{identifier},ro=true"]
    result = podman("run", "--rm", "--cgroups=disabled", *staged, *ssh, *host, *helper, "--web-mounts", capture=True)
    mounts = [argument for mount in result.stdout.splitlines() if mount for argument in ("--mount", mount)]
    if not podman("container", "exists", name, optional=True).returncode:
        info = inspect(name)
        if info is None:
            raise RuntimeError("Could not inspect the existing app. Check the Podman connection and retry. It will not be reused or removed.")
        confirm_owner(info)
        podman("rm", name, capture=True)
    arguments = ["run", "-d", "--name", name, "--label", f"{OWNER}={PROJECT}", "--cgroups=disabled", "--publish", "127.0.0.1::8080", "--publish", "127.0.0.1::8000", "--env", "SUITECONTAINER_SFTP=1"]
    if instance_id:
        directory = runtime_directory()
        arguments += ["--label", f"suitecontainer.instance={instance_id}",
                      "--env", f"SUITECONTAINER_INSTANCE_ID={instance_id}",
                      "--env", "SUITECONTAINER_ACCESS_TOKEN_FILE=/run/suitecontainer/access-token",
                      "--env", "SUITECONTAINER_CONNECTION_FILE=/run/suitecontainer/connection.json",
                      "--env", f"SUITECONTAINER_MODE={'development' if OPTIONS.dev else 'production'}",
                      "--mount", f"type=bind,src={directory},dst=/run/suitecontainer",
                      "--mount", f"type=bind,src={directory / 'access-token'},dst=/run/suitecontainer/access-token,ro=true"]
    if OPTIONS.dev:
        volume = development_volume(name)
        arguments += ["--label", f"{DEPENDENCIES_LABEL}={dependencies}",
                      "--mount", f"type=bind,src={PROJECT / 'app'},dst=/app",
                      "--mount", f"type=volume,src={volume},dst=/app/node_modules",
                      "--mount", f"type=volume,src={volume}-server,dst=/app/server/node_modules",
                      "--mount", f"type=volume,src={volume}-client,dst=/app/client/node_modules",
                      "--workdir", "/app", "--entrypoint", "npm"]
        if WINDOWS and "SUITECONTAINER_WATCH_POLLING" not in os.environ:
            arguments += ["--env", "SUITECONTAINER_WATCH_POLLING=1"]
        for variable in ("SUITECONTAINER_WATCH_POLLING", "SUITECONTAINER_WATCH_INTERVAL_MS"):
            if os.environ.get(variable):
                arguments += ["--env", f"{variable}={os.environ[variable]}"]
    if not (WINDOWS or MACOS):
        arguments += ["--env", f"SUITECONTAINER_HOST_FQDN={command('hostname', '-f', capture=True, optional=True).stdout.strip()}"]
    execution = ["--prefix", "/app", "run", "dev", "--", "--host", "0.0.0.0", "--port", "8080"] if OPTIONS.dev else ["--serve"]
    podman(*arguments, *extra_arguments, *mounts, IMAGE, *execution, capture=True)


def development_volume(name):
    return f"{name}-node-modules"


@contextmanager
def development_npm_inputs():
    """Reuse host npm configuration and trust without putting credentials in argv."""
    with tempfile.TemporaryDirectory(prefix="suitecontainer-dependencies-") as temporary:
        directory = Path(temporary)
        environment = os.environ
        candidates = {
            "npmrc": environment.get("SUITECONTAINER_NPMRC") or environment.get("NPM_CONFIG_USERCONFIG") or environment.get("npm_config_userconfig") or Path.home() / ".npmrc",
            "npm-globalrc": environment.get("NPM_CONFIG_GLOBALCONFIG") or environment.get("npm_config_globalconfig"),
            "npm-rootrc": PROJECT / ".npmrc", "npm-projectrc": PROJECT / "app/.npmrc",
        }
        variables = {key: value for key, value in environment.items() if key.lower().startswith("npm_config_")}
        files = {}
        for identifier, candidate in candidates.items():
            if not candidate or not Path(candidate).is_file():
                continue
            path = Path(candidate).resolve()
            files[identifier] = path
            for variable in re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", path.read_text(encoding="utf-8-sig")):
                if variable in environment:
                    variables[variable] = environment[variable]
        if variables:
            path = directory / "npm-env"
            path.write_bytes(b"".join(key.encode() + b"\0" + value.encode() + b"\0" for key, value in variables.items()))
            secure_path(path)
            files["npm-env"] = path
        arguments = []
        if WINDOWS:
            certificates = {data for store in ("ROOT",) for data, encoding, _ in ssl.enum_certificates(store) if encoding == "x509_asn"}
            path = directory / "npm-ca.pem"
            path.write_text("".join(ssl.DER_cert_to_PEM_cert(data) for data in sorted(certificates)), encoding="ascii")
            files["npm-ca"] = path
            arguments += ["--env", "NODE_EXTRA_CA_CERTS=/run/secrets/npm-ca"]
        for identifier, path in files.items():
            arguments += ["--mount", f"type=bind,src={path},dst=/run/secrets/{identifier},ro=true"]
        yield arguments


def prepare_dependencies(name, fingerprint):
    record = runtime_directory() / "dependencies.json"
    previous = {}
    try:
        previous = json.loads(record.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    volume = development_volume(name)
    exists = podman("volume", "exists", volume, optional=True)
    server_exists = podman("volume", "exists", volume + "-server", optional=True)
    client_exists = podman("volume", "exists", volume + "-client", optional=True)
    for relative in ("app/node_modules", "app/server/node_modules", "app/client/node_modules"):
        (PROJECT / relative).mkdir(exist_ok=True)
    if previous.get("fingerprint") == fingerprint and all(result.returncode == 0 for result in (exists, server_exists, client_exists)):
        return
    if any(result.returncode not in (0, 1) for result in (exists, server_exists, client_exists)):
        raise RuntimeError("Cannot inspect development dependency storage. Check Podman permissions and relaunch.")
    print("Refreshing development dependencies from the committed lockfile...", flush=True)
    # This runs only during an explicit launch, after the old app has been stopped while idle.
    with development_npm_inputs() as npm_inputs:
        podman("run", "--rm", "--cgroups=disabled", *npm_inputs,
               "--mount", f"type=bind,src={PROJECT / 'app'},dst=/app,ro=true",
               "--mount", f"type=volume,src={volume},dst=/app/node_modules",
               "--mount", f"type=volume,src={volume}-server,dst=/app/server/node_modules",
               "--mount", f"type=volume,src={volume}-client,dst=/app/client/node_modules",
               "--workdir", "/app", "--entrypoint", "node", IMAGE,
               "/opt/suitecontainer/run-npm.mjs", "ci", "--ignore-scripts", "--no-audit", "--no-fund")
    write_private_json(record, {"fingerprint": fingerprint, "volume": volume})


def assert_app_idle(name, runner_stopped=False):
    # Older app images do not expose activity on /health. Read their authenticated
    # state locally without returning a session token or application log to the host.
    script = "const runnerStopped=" + json.dumps(runner_stopped) + ";\n" + """const health=await fetch('http://127.0.0.1:8080/health?activity=1',{signal:AbortSignal.timeout(5000)});
if(!health.ok)process.exit(2);
let state=await health.json();
if(runnerStopped&&typeof state.localBusy==='boolean')state.busy=state.localBusy;
else if(typeof state.busy!=='boolean'||runnerStopped){
 const {readFileSync}=await import('node:fs');
 const suffix=readFileSync('/tmp/suitecontainer-web-url','utf8').trim();
 const token=new URL('http://localhost'+suffix).hash.slice(1);
 const response=await fetch('http://127.0.0.1:8080/api/state',{headers:{'x-session-token':new URLSearchParams(token).get('session')||''},signal:AbortSignal.timeout(5000)});
 if(!response.ok)process.exit(2);
 state=await response.json();
 if(typeof state.run?.state!=='string'||typeof state.sql?.state!=='string')process.exit(2);
 state.busy=state.run.state==='running'||state.sql.state==='running'||state.sql.preparing===true||(!runnerStopped&&state.playwright?.state==='running');
}
console.log(state.busy?'busy':'idle');"""
    result = podman("exec", name, "node", "--input-type=module", "-e", script, capture=True, optional=True)
    if result.returncode or result.stdout.strip() != "idle":
        raise RuntimeError("The app is busy or its activity could not be checked. The containers were left untouched. Wait for running jobs to finish, or use Stop app before relaunching.")


def playwright_runner(name, machine, info):
    config = json.loads((PROJECT / "suitecontainer.config.json").read_text(encoding="utf-8-sig"))
    settings = config.get("playwright", {})
    if not isinstance(settings, dict):
        raise RuntimeError("The Playwright settings must be an object.")
    previous = (info or {}).get("Config", {}).get("Env", [])
    if settings.get("enabled") is not True and not any(item.startswith("SUITECONTAINER_PLAYWRIGHT_URL=") for item in previous):
        return None
    spec = importlib.util.spec_from_file_location("suitecontainer_playwright", Path(__file__).with_name("playwright.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.PlaywrightRunner(project=PROJECT, app_name=name, machine=machine, config=config, app_info=info,
                                   podman=podman, command=command, windows=WINDOWS, macos=MACOS,
                                   machine_path=machine_path, inspect_container=inspect, confirm_owner=confirm_owner, owner=OWNER)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def connection_http():
    # Credentials must never be sent through a corporate proxy or a redirect.
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def validate_connection(value, name):
    expected_token = PROJECT / ".cache/runtime/access-token"
    if not isinstance(value, dict) or value.get("schemaVersion") != 1 or value.get("apiVersion") != 1:
        raise RuntimeError("instance_unavailable: The connection descriptor has an unsupported schema. Run the launcher explicitly to refresh it.")
    if not isinstance(value.get("projectRoot"), str) or Path(value["projectRoot"]).resolve() != PROJECT.resolve() or value.get("containerName") != name:
        raise RuntimeError("instance_unavailable: The connection descriptor belongs to another project.")
    if value.get("tokenFile") != str(expected_token) or value.get("mode") not in ("production", "development"):
        raise RuntimeError("instance_unavailable: The connection descriptor has invalid credential or mode metadata.")
    if not isinstance(value.get("instanceId"), str) or not re.fullmatch(r"[a-f0-9-]{36}", value["instanceId"]):
        raise RuntimeError("instance_unavailable: The connection descriptor has an invalid instance identity.")
    destination = urllib.parse.urlsplit(value.get("baseUrl", ""))
    if destination.scheme != "http" or destination.hostname not in ("127.0.0.1", "::1", "localhost") or not destination.port or destination.username or destination.password or destination.path not in ("", "/") or destination.query or destination.fragment:
        raise RuntimeError("instance_unavailable: The connection descriptor must identify a host-loopback HTTP endpoint.")
    return value


def read_connection(name):
    path = PROJECT / ".cache/runtime/connection.json"
    try:
        return validate_connection(json.loads(path.read_text(encoding="utf-8")), name)
    except (OSError, ValueError, TypeError) as error:
        raise RuntimeError("instance_unavailable: No valid connection descriptor is available. Run the launcher explicitly.") from error


def handshake(connection):
    http = connection_http()
    # Check identity without credentials before reading and sending the token.
    with http.open(connection["baseUrl"] + "/health?activity=1", timeout=3) as response:
        identity = json.load(response)
    if identity.get("instanceId") != connection["instanceId"]:
        raise RuntimeError("instance_unavailable: The endpoint is a different backend instance. Rediscover it before sending credentials.")
    token_file = Path(connection["tokenFile"])
    secure_path(token_file)
    token = token_file.read_text(encoding="ascii").strip()
    if not re.fullmatch(r"[a-f0-9]{64}", token):
        raise RuntimeError("instance_unavailable: The access token file is invalid. Run the launcher explicitly.")
    request = urllib.request.Request(connection["baseUrl"] + "/api/capabilities", headers={"Authorization": "Bearer " + token})
    with http.open(request, timeout=5) as response:
        capabilities = json.load(response)
    if capabilities.get("instanceId") != connection["instanceId"] or capabilities.get("apiVersion") != 1:
        raise RuntimeError("instance_unavailable: The authenticated backend identity or API contract changed.")
    return capabilities


def remove_owned_connection(instance_id):
    path = PROJECT / ".cache/runtime/connection.json"
    try:
        if json.loads(path.read_text(encoding="utf-8")).get("instanceId") == instance_id:
            path.unlink()
    except (OSError, ValueError, AttributeError):
        pass


def new_credentials():
    instance_id = str(uuid.uuid4())
    path = runtime_directory() / "access-token"
    if path.is_symlink():
        raise RuntimeError("The access token path must not be a symbolic link.")
    (path.parent / "browser-url").unlink(missing_ok=True)
    with path.open("w", encoding="ascii") as output:
        secure_path(path)
        output.write(secrets.token_hex(32))
    return instance_id


def discover(name, instance_id, dependencies=None):
    addresses = podman("port", name, "8080/tcp", capture=True).stdout.splitlines()
    if not addresses or not re.fullmatch(r"127\.0\.0\.1:[0-9]+", addresses[0].strip()):
        raise RuntimeError("Could not discover a host-loopback application port from Podman.")
    connection = {"schemaVersion": 1, "apiVersion": 1, "instanceId": instance_id,
                  "projectRoot": str(PROJECT), "containerName": name,
                  "baseUrl": "http://" + addresses[0].strip(),
                  "mode": "development" if OPTIONS.dev else "production",
                  "tokenFile": str(PROJECT / ".cache/runtime/access-token")}
    if dependencies:
        connection["dependencyFingerprint"] = dependencies
    validate_connection(connection, name)
    for _ in range(30):
        try:
            handshake(connection)
            write_private_json(runtime_directory() / "connection.json", connection)
            return connection
        except (OSError, ValueError, urllib.error.URLError):
            info = inspect(name)
            if not info or not info.get("State", {}).get("Running"):
                raise RuntimeError("instance_unavailable: The backend exited before its authenticated startup handshake. Check container logs and relaunch.") from None
            time.sleep(1)
    raise RuntimeError("instance_unavailable: The backend did not complete its authenticated handshake. Check loopback access, Podman permissions, and container logs, then relaunch.")


def open_page(name, connection=None):
    if OPTIONS.no_browser:
        return
    if connection is None:
        connection = read_connection(name)
    suffix = podman("exec", name, "cat", "/tmp/suitecontainer-web-url", capture=True).stdout.strip()
    if not re.fullmatch(r"/#session=[a-f0-9]+", suffix):
        raise RuntimeError("The browser session is unavailable. Relaunch the application.")
    url = connection["baseUrl"] + suffix
    if WINDOWS or MACOS:
        try:
            if not webbrowser.open(url):
                raise OSError()
        except OSError:
            browser_file = runtime_directory() / "browser-url"
            browser_file.write_text(url, encoding="utf-8")
            secure_path(browser_file)
            print(f"Open the private browser address stored in {browser_file}.")
    else:
        browser_file = runtime_directory() / "browser-url"
        browser_file.write_text(url, encoding="utf-8")
        secure_path(browser_file)
        port = urllib.parse.urlsplit(connection["baseUrl"]).port
        hostname = command("hostname", "-f", capture=True).stdout.strip()
        print(f"From your computer, forward the port: ssh -N -L {port}:127.0.0.1:{port} {getpass.getuser()}@{hostname}")
        print(f"Open the private browser address stored in {browser_file} after forwarding the port.")
    print("The application is ready. Use Stop app to stop it, or run the launcher to reopen it.")


def launch():
    prepare_host()
    install_podman()
    machine = start_machine()
    name = container_name()
    info = inspect(name)
    if info:
        confirm_owner(info)
    source_available = (PROJECT / "app/package.json").is_file() and (PROJECT / "setup/Containerfile").is_file()
    if OPTIONS.dev and not source_available:
        raise RuntimeError("Development mode requires the application source checkout.")
    shared_image_mode = pm_mode() and not OPTIONS.dev
    build_from_source = source_available and not shared_image_mode
    running = bool(info and info.get("State", {}).get("Running"))
    dependencies = dependency_fingerprint() if OPTIONS.dev else None
    runner = playwright_runner(name, machine, info)
    if OPTIONS.dev:
        image = podman("image", "inspect", IMAGE, "--format", "json", capture=True, optional=True)
        try:
            compatible = not image.returncode and json.loads(image.stdout)[0].get("Labels", {}).get(TOOLS_LABEL) == tooling_fingerprint()
        except (ValueError, KeyError, IndexError, AttributeError):
            compatible = False
        if not compatible:
            build_image(machine)
    elif build_from_source:
        build_image(machine)
    elif not running:
        image = podman("image", "exists", IMAGE, optional=True)
        archive = PROJECT / "container-image/suitecontainer-workspace.tar"
        if image.returncode == 1 and archive.is_file():
            print(f"Loading the shared SuiteCloud image from {archive}...", flush=True)
            podman("load", "-i", archive)
            image = podman("image", "exists", IMAGE, optional=True)
            if image.returncode:
                raise RuntimeError(f"The archive did not contain the {IMAGE} image: {archive}")
        elif image.returncode == 1 and shared_image_mode:
            raise RuntimeError(f"Copy the shared {IMAGE} image archive to {archive}, then run the launcher again.")
        elif image.returncode == 1:
            build_image(machine)
        elif image.returncode:
            raise RuntimeError("Could not check the local SuiteCloud image. Check the Podman connection and retry.")
    replace_app = False
    connection = None
    if running:
        try:
            connection = read_connection(name)
            labels = info["Config"].get("Labels") or {}
            expected_mode = "development" if OPTIONS.dev else "production"
            replace_app = connection["mode"] != expected_mode or (OPTIONS.dev and labels.get(DEPENDENCIES_LABEL) != dependencies)
            if not replace_app:
                handshake(connection)
        except (OSError, ValueError, RuntimeError, urllib.error.URLError):
            replace_app = True
    if running and build_from_source:
        current_image = podman("image", "inspect", IMAGE, "--format", "{{.Id}}", capture=True).stdout.strip().removeprefix("sha256:")
        running_image = str(info.get("Image") or "").removeprefix("sha256:")
        if not current_image or not running_image:
            raise RuntimeError("Could not compare the running app with the updated image. The running app was left untouched.")
        replace_app = replace_app or current_image != running_image
    if runner:
        runner.plan(shared_image_mode)
        replace_app = replace_app or runner.app_changed
    if running and (replace_app or (runner and runner.runner_changed)):
        runner_stopped = bool(runner and runner.enabled and (not runner.info or not runner.info.get("State", {}).get("Running")))
        assert_app_idle(name, runner_stopped=runner_stopped)
    if runner and (replace_app or runner.runner_changed):
        runner.assert_idle()
    if runner:
        runner.prepare_resources()
    if running and replace_app:
        print("Restarting the app with its updated container settings...", flush=True)
        podman("stop", name)
        if connection:
            remove_owned_connection(connection["instanceId"])
        # App shutdown also stops its runner. Recreate that runner only after the
        # old app has exited, so shutdown cannot stop the replacement container.
        if runner and runner.enabled:
            runner.runner_changed = True
    if runner:
        runner.apply()
    if not running or replace_app:
        instance_id = new_credentials()
        try:
            if OPTIONS.dev:
                prepare_dependencies(name, dependencies)
            start_web(name, runner.app_arguments if runner else (), instance_id=instance_id, dependencies=dependencies)
            connection = discover(name, instance_id, dependencies)
        except BaseException:
            remove_owned_connection(instance_id)
            failed = inspect(name)
            if failed and (failed["Config"].get("Labels") or {}).get("suitecontainer.instance") == instance_id:
                podman("stop", name, optional=True, capture=True)
            raise
    open_page(name, connection)
    return {**{key: connection[key] for key in ("apiVersion", "instanceId", "projectRoot", "containerName", "baseUrl", "mode")},
            "connectionFile": str(PROJECT / ".cache/runtime/connection.json"), "reused": running and not replace_app}


def main(args=()):
    global PROJECT, OPTIONS, IMAGE
    parser = argparse.ArgumentParser(description="Start the SuiteContainer environment and discover its shared API.")
    parser.add_argument("--dev", action="store_true")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--non-interactive", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--project", type=Path)
    OPTIONS = parser.parse_args(args)
    if OPTIONS.json:
        OPTIONS.non_interactive = True
        OPTIONS.no_browser = True
    if OPTIONS.project:
        PROJECT = OPTIONS.project.expanduser().resolve()
    if not PROJECT.is_dir() or not (PROJECT / "suitecontainer.config.example.json").is_file():
        raise RuntimeError("The selected project must contain the SuiteContainer checkout or distribution.")
    IMAGE = "suitecontainer-workspace:dev" if OPTIONS.dev else "suitecontainer-workspace"
    with redirect_stdout(sys.stderr) if OPTIONS.json else redirect_stdout(sys.stdout):
        with startup_lock():
            result = launch()
    if OPTIONS.json:
        print(json.dumps(result))
    return result


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except subprocess.CalledProcessError as error:
        print(f"Setup stopped: {Path(error.cmd[0]).name} failed (exit {error.returncode}). Review the error above and retry.", file=sys.stderr)
        sys.exit(error.returncode if 0 < error.returncode < 256 else 1)
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Setup could not finish: {error}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
