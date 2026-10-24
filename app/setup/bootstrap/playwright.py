"""Host orchestration for the optional, isolated Playwright runner."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shlex
import shutil
import ssl


IMAGE = "suitecontainer-playwright"
CONFIG_LABEL = "suitecontainer.playwright.config"
REGISTRY = "https://repository.eng.netsuite.com/repository/npm-stable/"
RUNTIME = "/run/playwright"


def environment(info):
    return dict(setting.split("=", 1) for setting in (info or {}).get("Config", {}).get("Env", []) if "=" in setting)


def discover_package_directories(checkouts, configured_project):
    """Find dependency mounts without following links outside registered checkouts."""
    if not configured_project:
        return []
    packages = set()
    excluded = {".git", "node_modules", ".cache", ".pnpm-store"}

    def linked(path):
        return path.is_symlink() or getattr(path, "is_junction", lambda: False)()

    def unreadable(error):
        raise RuntimeError("Could not inspect a SuiteApp checkout for Playwright dependency mounts.") from error

    for directory, checkout in checkouts:
        checkout = Path(checkout)
        if linked(checkout) or not checkout.is_dir() or not (checkout / ".git").exists():
            continue
        if PurePosixPath(configured_project).parts[0] == directory:
            packages.add(configured_project)
        boundary = checkout.resolve()
        for current, children, files in os.walk(checkout, topdown=True, followlinks=False, onerror=unreadable):
            current = Path(current)
            if not current.resolve().is_relative_to(boundary):
                children[:] = []
                continue
            children[:] = sorted(child for child in children if child not in excluded
                                 and not linked(current / child)
                                 and (current / child).resolve().is_relative_to(boundary))
            if "package.json" in files:
                relative = current.relative_to(checkout)
                packages.add(str(PurePosixPath(directory, *relative.parts)))
    return sorted(packages)


class PlaywrightRunner:
    def __init__(self, *, project, app_name, machine, config, app_info, podman, command,
                 windows, macos, machine_path, inspect_container, confirm_owner, owner):
        self.project, self.app_name, self.machine = project, app_name, machine
        self.home = project / "home"
        self.config, self.app_info = config, app_info
        self.podman, self.command = podman, command
        self.windows, self.macos, self.machine_path = windows, macos, machine_path
        self.inspect_container, self.confirm_owner, self.owner = inspect_container, confirm_owner, owner
        self.enabled = config.get("playwright", {}).get("enabled") is True
        self.name = app_name + "-playwright"
        self.network = app_name + "-network"
        self.info = None
        self.app_arguments = []
        self.mounts = []
        self.app_changed = False
        self.runner_changed = False

    def owned_resource(self, kind, name):
        exists = self.podman(kind, "exists", name, optional=True)
        if exists.returncode == 1:
            self.podman(kind, "create", "--label", f"{self.owner}={self.project}", name, capture=True)
            return
        if exists.returncode:
            raise RuntimeError(f"Could not check the Playwright {kind}. Check the Podman connection and relaunch.")
        items = json.loads(self.podman(kind, "inspect", name, capture=True).stdout)
        if len(items) != 1 or (items[0].get("Labels") or items[0].get("labels") or {}).get(self.owner) != str(self.project):
            raise RuntimeError(f"Another project owns the Playwright {kind} named {name}. It was left untouched.")

    def configuration(self):
        settings = self.config.get("playwright", {})
        self.browser = settings.get("browser", "container")
        if self.browser not in ("container", "local-chrome"):
            raise RuntimeError("Playwright browser must be container or local-chrome.")
        configured = settings.get("project", "")
        if not isinstance(configured, str):
            raise RuntimeError("The Playwright project must be a directory relative to repos.")
        relative = configured.strip().replace("\\", "/")
        if relative and (relative.startswith("/") or ":" in relative or any(part in ("", ".", "..") for part in relative.split("/"))) or re.search(r"[,\r\n\0]", relative):
            raise RuntimeError("The Playwright project must be a directory relative to repos, such as absi-nsn/test-pw.")
        self.test_project = str(PurePosixPath(relative)) if relative else ""
        self.mounts = ["--mount", f"type=bind,src={self.home / 'repos'},dst=/workspace"]
        self.checkouts = []
        local_paths = []
        for repo in self.config.get("suiteapps", []):
            directory = repo.get("directory", "")
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", directory) or directory in (".", ".."):
                raise RuntimeError("A SuiteApp directory is invalid. Check Settings before launching Playwright.")
            if not repo.get("localPath"):
                self.checkouts.append((directory, self.home / "repos" / directory))
                continue
            path = Path(repo["localPath"]).expanduser()
            path = (path if path.is_absolute() else self.home / path).resolve()
            if not path.is_dir() or any(character in str(path) for character in ",\r\n\0"):
                raise RuntimeError(f"The local checkout for {directory} cannot be mounted. Check its localPath in Settings.")
            local_paths.append([directory, str(path)])
            self.checkouts.append((directory, path))
            self.mounts += ["--mount", f"type=bind,src={path},dst=/workspace/{directory}"]
        return local_paths

    def npm_configuration(self):
        host_environment = os.environ
        explicit = host_environment.get("SUITECONTAINER_NPMRC") or host_environment.get("NPM_CONFIG_USERCONFIG") or host_environment.get("npm_config_userconfig")
        candidate = explicit
        if not candidate and shutil.which("npm"):
            result = self.command("npm", "config", "get", "userconfig", capture=True, optional=True)
            if not result.returncode:
                candidate = result.stdout.strip()
        source = Path(candidate or Path.home() / ".npmrc").expanduser()
        if explicit and not source.is_file():
            raise RuntimeError("The configured npm user configuration file does not exist.")
        npmrc = source.read_text(encoding="utf-8-sig") if source.is_file() else ""
        # Nexus metadata and package tarballs use both URL forms on the same host.
        # Preserve explicit entries and mirror only missing authentication settings.
        entries = {}
        for line in npmrc.splitlines():
            key, separator, value = line.strip().partition("=")
            if separator:
                entries[key.strip()] = value.strip()
        for key, value in list(entries.items()):
            if key.rsplit(":", 1)[-1].lower() not in ("_auth", "_authtoken", "_password", "username", "always-auth"):
                continue
            first = "//repository.eng.netsuite.com/repository/"
            second = "//repository.eng.netsuite.com/3/repository/"
            other = second + key[len(first):] if key.startswith(first) else first + key[len(second):] if key.startswith(second) else ""
            if other and other not in entries:
                npmrc += f"\n{other}={value}\n"
                entries[other] = value
        forwarded = {}
        for variable in re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", npmrc):
            if variable not in host_environment:
                raise RuntimeError(f"The npm configuration requires the {variable} environment variable. Set it and relaunch.")
            forwarded[variable] = host_environment[variable]
        for key, value in host_environment.items():
            if key.lower().startswith("npm_config_") and key.lower() not in ("npm_config_userconfig", "npm_config_globalconfig", "npm_config_cafile", "npm_config_store_dir", "npm_config_cache", "npm_config_prefix", "npm_config_local_prefix"):
                forwarded[key] = value
            if key.lower() in ("http_proxy", "https_proxy", "all_proxy", "no_proxy") or re.fullmatch(r"PLAYWRIGHT(?:_[A-Z]+)?_DOWNLOAD_HOST", key):
                forwarded[key] = value
        if host_environment.get("NSX_NPM_TOKEN"):
            forwarded["NSX_NPM_TOKEN"] = host_environment["NSX_NPM_TOKEN"]
            for prefix in ("repository", "3/repository"):
                registry_key = f"//repository.eng.netsuite.com/{prefix}/npm-stable/:_auth"
                if not re.search(r"(?mi)^\s*" + re.escape(registry_key), npmrc):
                    npmrc += f"\n{registry_key}=${{NSX_NPM_TOKEN}}\n"
        ca = []
        if self.windows:
            certificates = {data for data, encoding, _ in ssl.enum_certificates("ROOT") if encoding == "x509_asn"}
            ca += [ssl.DER_cert_to_PEM_cert(data) for data in sorted(certificates)]
        cafile = host_environment.get("NPM_CONFIG_CAFILE") or host_environment.get("npm_config_cafile")
        if not cafile:
            matches = re.findall(r"(?mi)^\s*cafile\s*=\s*(.*?)\s*$", npmrc)
            cafile = matches[-1] if matches else None
        for configured in (cafile, host_environment.get("NODE_EXTRA_CA_CERTS")):
            if not configured:
                continue
            configured = configured.strip().strip("\"'")
            configured = re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", lambda match: host_environment.get(match[1], ""), configured)
            path = Path(configured).expanduser()
            path = path if path.is_absolute() else source.parent / path
            if not path.is_file():
                raise RuntimeError("An npm CA certificate file cannot be read. Check cafile and NODE_EXTRA_CA_CERTS, then relaunch.")
            ca.append(path.read_text(encoding="ascii"))
        npmrc = re.sub(r"(?mi)^\s*cafile\s*=.*(?:\n|$)", "", npmrc)
        npmrc = f"registry={REGISTRY}\n" + npmrc.rstrip() + "\nstore-dir=/pnpm/store\n"
        if ca:
            npmrc += f"cafile={RUNTIME}/ca.pem\n"
        return npmrc, "\n".join(ca), forwarded

    @staticmethod
    def write_private(path, contents):
        if path.exists() and path.read_text(encoding="utf-8") == contents:
            return
        temporary = path.with_suffix(path.suffix + ".tmp")
        with temporary.open("w", encoding="utf-8", newline="\n") as output:
            if os.name != "nt":
                os.fchmod(output.fileno(), 0o600)
            output.write(contents)
        temporary.replace(path)

    @staticmethod
    def env_contents(values):
        for key, value in values.items():
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) or any(character in value for character in "\r\n\0"):
                raise RuntimeError(f"The environment setting {key} cannot be passed to Playwright.")
        return "".join(f"{key}={value}\n" for key, value in values.items())

    def ensure_image(self, shared_image_mode, ca_path):
        source = self.project / "app/setup/playwright/Containerfile"
        if source.is_file() and not shared_image_mode:
            wsl = self.machine and self.machine.get("VMType") == "wsl"
            convert = self.machine_path if wsl else str
            arguments = ["build", "-f", convert(source), "--ignorefile", convert(self.project / "app/setup/.containerignore")]
            if ca_path:
                arguments += ["--secret", f"id=npm-ca,src={convert(ca_path)}"]
            arguments += ["-t", IMAGE, convert(self.project)]
            print("Preparing the Playwright container...", flush=True)
            if wsl:
                self.podman("machine", "ssh", self.machine["Name"], "--", shlex.join(["podman", *arguments]))
            else:
                self.podman(*arguments)
        else:
            image = self.podman("image", "exists", IMAGE, optional=True)
            archive = self.home / "container-image/suitecontainer-playwright.tar"
            if image.returncode == 1 and archive.is_file():
                print(f"Loading the shared Playwright image from {archive}...", flush=True)
                self.podman("load", "-i", archive)
                image = self.podman("image", "exists", IMAGE, optional=True)
            if image.returncode == 1:
                raise RuntimeError(f"Copy the shared {IMAGE} image archive to {archive}, then relaunch.")
            if image.returncode:
                raise RuntimeError("Could not check the local Playwright image. Check the Podman connection and relaunch.")
        image_id = self.podman("image", "inspect", IMAGE, "--format", "{{.Id}}", capture=True).stdout.strip().removeprefix("sha256:")
        if not image_id:
            raise RuntimeError("Could not read the Playwright image ID. The existing containers were left untouched.")
        return image_id

    def plan(self, shared_image_mode):
        previous = environment(self.app_info)
        self.info = self.inspect_container(self.name)
        if self.info:
            self.confirm_owner(self.info)
        if not self.enabled:
            self.app_changed = bool(previous.get("SUITECONTAINER_PLAYWRIGHT_URL"))
            self.runner_changed = bool(self.info)
            return
        local_paths = self.configuration()
        self.package_directories = discover_package_directories(self.checkouts, self.test_project)
        npmrc, ca, npm_environment = self.npm_configuration()
        token = previous.get("SUITECONTAINER_PLAYWRIGHT_TOKEN") or environment(self.info).get("SUITECONTAINER_PLAYWRIGHT_TOKEN") or secrets.token_hex(32)
        endpoint = f"http://{self.name}:8787"
        app_environment = {"SUITECONTAINER_PLAYWRIGHT_URL": endpoint, "SUITECONTAINER_PLAYWRIGHT_TOKEN": token}
        runner_environment = {**npm_environment, "SUITECONTAINER_PLAYWRIGHT_TOKEN": token,
                              "SUITECONTAINER_PLAYWRIGHT_PROJECT": self.test_project,
                              "SUITECONTAINER_PLAYWRIGHT_BROWSER": self.browser,
                              "SUITECONTAINER_PLAYWRIGHT_APP_URL": f"http://{self.app_name}:8080",
                              "NPM_CONFIG_USERCONFIG": f"{RUNTIME}/npmrc"}
        if self.browser == "local-chrome":
            runner_environment["PLAYWRIGHT_REMOTE_WS_ENDPOINT"] = "ws://127.0.0.1:9222/"
        for key in ("NO_PROXY", "no_proxy"):
            runner_environment[key] = ",".join(filter(None, (npm_environment.get(key), "localhost,127.0.0.1", self.app_name, self.name)))
        if ca:
            runner_environment["NODE_EXTRA_CA_CERTS"] = f"{RUNTIME}/ca.pem"
            runner_environment["NPM_CONFIG_CAFILE"] = f"{RUNTIME}/ca.pem"
            runner_environment["GIT_SSL_CAINFO"] = f"{RUNTIME}/ca.pem"
        digest = hashlib.sha256(json.dumps([local_paths, self.package_directories, npmrc, ca, runner_environment], sort_keys=True).encode()).hexdigest()
        self.directory = self.home / ".cache/playwright" / digest
        self.directory.mkdir(parents=True, exist_ok=True)
        if self.browser == "local-chrome":
            spec = importlib.util.spec_from_file_location("suitecontainer_playwright_ssh", Path(__file__).with_name("playwright_ssh.py"))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            module.prepare_ssh(self.directory / "ssh")
        self.write_private(self.directory / "npmrc", npmrc)
        if ca:
            self.write_private(self.directory / "ca.pem", ca)
        self.write_private(self.directory / "runner.env", self.env_contents(runner_environment))
        self.write_private(self.directory / "app.env", self.env_contents(app_environment))
        image_id = self.ensure_image(shared_image_mode, self.directory / "ca.pem" if ca else None)
        self.fingerprint = digest
        self.runner_changed = not self.info or not self.info.get("State", {}).get("Running") or (self.info["Config"].get("Labels") or {}).get(CONFIG_LABEL) != digest or str(self.info.get("Image") or "").removeprefix("sha256:") != image_id
        self.app_changed = any(previous.get(key) != value for key, value in app_environment.items())
        self.app_arguments = ["--network", self.network, "--env-file", self.directory / "app.env"]

    def assert_idle(self):
        if not self.info or not self.info.get("State", {}).get("Running"):
            return
        script = "const response=await fetch('http://127.0.0.1:8787/state',{headers:{authorization:'Bearer '+process.env.SUITECONTAINER_PLAYWRIGHT_TOKEN},signal:AbortSignal.timeout(5000)});if(!response.ok)process.exit(2);const state=await response.json();if(typeof state.state!=='string')process.exit(2);console.log(state.state==='running'?'busy':'idle')"
        result = self.podman("exec", self.name, "node", "--input-type=module", "-e", script, capture=True, optional=True)
        if result.returncode or result.stdout.strip() != "idle":
            raise RuntimeError("Playwright is running or its activity could not be checked. The containers were left untouched. Wait for tests to finish, or use Stop app before relaunching.")

    def prepare_resources(self):
        if not self.enabled:
            return
        self.owned_resource("network", self.network)
        self.store = self.app_name + "-playwright-store"
        self.owned_resource("volume", self.store)
        self.modules = []
        for directory in self.package_directories:
            volume = self.app_name + "-playwright-modules-" + hashlib.sha256(directory.encode()).hexdigest()[:16]
            self.owned_resource("volume", volume)
            self.modules.append((volume, directory))

    def apply(self):
        if not self.enabled:
            if self.info:
                if self.info.get("State", {}).get("Running"):
                    self.podman("stop", self.name, capture=True)
                self.podman("rm", self.name, capture=True)
            return
        if not self.runner_changed:
            return
        mounts = [*self.mounts, "--mount", f"type=volume,src={self.store},dst=/pnpm/store",
                  "--mount", f"type=bind,src={self.directory / 'npmrc'},dst={RUNTIME}/npmrc,ro=true"]
        for volume, directory in self.modules:
            mounts += ["--mount", f"type=volume,src={volume},dst=/workspace/{directory}/node_modules"]
        if (self.directory / "ca.pem").is_file():
            mounts += ["--mount", f"type=bind,src={self.directory / 'ca.pem'},dst={RUNTIME}/ca.pem,ro=true"]
        if self.browser == "local-chrome":
            mounts += ["--mount", f"type=bind,src={self.directory / 'ssh'},dst={RUNTIME}/ssh,ro=true",
                       "--publish", "127.0.0.1::2222"]
        if self.info:
            if self.info.get("State", {}).get("Running"):
                self.podman("stop", self.name, capture=True)
            self.podman("rm", self.name, capture=True)
        print("Starting the Playwright container...", flush=True)
        self.podman("run", "-d", "--name", self.name, "--network", self.network,
                    "--label", f"{self.owner}={self.project}", "--label", f"{CONFIG_LABEL}={self.fingerprint}",
                    "--cgroups=disabled", "--init", "--shm-size=1g", "--env-file", self.directory / "runner.env", *mounts, IMAGE, capture=True)
        if self.browser == "local-chrome":
            print("For local Chrome, start the laptop Playwright server and SSH forward described in PLAYWRIGHT.md.", flush=True)
