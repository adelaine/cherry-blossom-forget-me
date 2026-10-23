"""Existing launcher, installer and token cases migrated to the shared bootstrap."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

REPOSITORY = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("bootstrap", REPOSITORY / "setup/bootstrap/bootstrap.py")
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)
HOST_PATH = bootstrap.host_path


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory(prefix="workspace with spaces ")))
        (self.root / "credentials").mkdir()
        (self.root / "repos").mkdir()
        for relative in ("suitecontainer.config.example.json", "credentials/auth.example.json"):
            shutil.copyfile(REPOSITORY / relative, self.root / relative)
        (self.root / "credentials/auth.json").write_text('{"gitlab-token": "fixture-token"}')
        self.stack.enter_context(patch.object(bootstrap, "PROJECT", self.root))
        self.stack.enter_context(patch.dict(os.environ, {"HOME": str(self.root), "USERPROFILE": str(self.root), "SUITECONTAINER_NEMS_DIR": str(self.root / "nems"), "SUITECONTAINER_NPMRC": str(self.root / "npm config/.npmrc")}, clear=True))
        self.stack.enter_context(patch.object(bootstrap, "container_name", return_value="fixture-app"))
        self.installer = self.stack.enter_context(patch.object(bootstrap, "install_podman"))
        self.browser = self.stack.enter_context(patch.object(bootstrap.webbrowser, "open", return_value=True))
        self.stack.enter_context(patch.object(bootstrap.ssl, "enum_certificates", return_value=[(b"certificate", "x509_asn", True)], create=True))
        self.stack.enter_context(patch.object(bootstrap.shutil, "which", side_effect=lambda name: name if name == "ssh" else None))
        self.stack.enter_context(patch.object(bootstrap.time, "sleep"))
        self.stack.enter_context(patch.object(bootstrap.getpass, "getuser", return_value="fixture-user"))
        self.stack.enter_context(patch.object(bootstrap.urllib.request, "build_opener"))
        self.output = self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.calls = []
        self.existing = False
        self.running = False
        self.owner = str(self.root)
        self.invalid_inspection = None
        self.inspection_status = 0
        self.failure = None
        self.wsl = False
        self.image_available = False
        self.secret_files = {}
        self.stack.enter_context(patch.object(bootstrap, "command", side_effect=self.command))

    def command(self, *args, capture=False, optional=False):
        args = [str(arg) for arg in args]
        self.calls.append(args)
        status, output = 0, ""
        if args[0] == "hostname":
            output = "fixture-codebox\n"
        elif args[:3] == ["ssh", "-G", "-T"]:
            output = "hostname fixture-scrumbox\n"
        elif args[0] == "podman":
            if args[1:3] == ["machine", "list"]:
                output = json.dumps([{"Name": "fixture-machine", "Running": True, "Default": True, "VMType": "wsl" if self.wsl else "qemu"}])
            elif args[1] == "inspect":
                status = self.inspection_status or (0 if self.existing else 125)
                output = self.invalid_inspection if self.invalid_inspection is not None else json.dumps([{"Config": {"Labels": {bootstrap.OWNER: self.owner}}, "State": {"Running": self.running}}])
            elif args[1:3] == ["container", "exists"]:
                status = 0 if self.existing else 1
            elif args[1:3] == ["image", "exists"]:
                status = 0 if self.image_available else 1
            elif args[1] == "port":
                output = "127.0.0.1:49123\n"
            elif args[1] == "exec":
                output = "/#session=fixture-session\n"
            elif args[1] == "run":
                if "--web-paths" in args:
                    output = f"local\tfixture\t{self.root / 'repos'}\n"
                elif "--web-mounts" in args:
                    output = f"type=bind,src={self.root / 'repos'},dst=/workspace\n"
                elif "--serve" in args:
                    self.existing = self.running = True
            elif args[1] == "build":
                for index, arg in enumerate(args):
                    if arg == "--secret" and ",src=" in args[index + 1]:
                        identifier, source = args[index + 1].split(",src=", 1)
                        self.secret_files[identifier.removeprefix("id=")] = Path(source).read_bytes()
        if self.failure and self.failure[0] in args:
            status = self.failure[1]
        if status and not optional:
            raise subprocess.CalledProcessError(status, args)
        return subprocess.CompletedProcess(args, status, output, "")

    @contextlib.contextmanager
    def host(self, name):
        with patch.multiple(bootstrap, WINDOWS=name == "windows", MACOS=name == "macos", HOST_PLATFORM="win32" if name == "windows" else "linux"):
            yield

    def calls_with(self, argument):
        return [call for call in self.calls if argument in call]

    def test_builds_and_starts_page_without_deploying(self):
        for host in ("windows", "macos", "linux"):
            with self.subTest(host=host), self.host(host):
                self.existing = self.running = False
                self.calls.clear()
                bootstrap.main()
                build = self.calls_with("build")[0]
                self.assertIn(str(self.root / "setup/Containerfile"), build)
                self.assertIn(str(self.root / "setup/.containerignore"), build)
                self.assertEqual(build[-1], str(self.root))
                self.assertIn("SUITECLOUD_CLI_ACCEPT_LICENSE=true", build)
                self.assertEqual(len(self.calls_with("--web-paths")), 1)
                self.assertEqual(len(self.calls_with("--web-mounts")), 1)
                serve = self.calls_with("--serve")[0]
                self.assertIn("127.0.0.1::8080", serve)
                self.assertIn(f"type=bind,src={self.root / 'repos'},dst=/workspace", serve)
                self.assertFalse(self.calls_with("--deploy"))
                if host == "linux":
                    self.assertIn("ssh -N -L", self.output.getvalue())

    def test_prefers_internal_base_image(self):
        bootstrap.main()
        self.assertEqual(self.calls_with("pull"), [["podman", "pull", "--retry=0", bootstrap.DEVELOPER_IMAGE]])
        self.assertIn(f"SUITECONTAINER_BASE_IMAGE={bootstrap.DEVELOPER_IMAGE}", self.calls_with("build")[0])

    def test_falls_back_to_public_base_image(self):
        self.failure = bootstrap.DEVELOPER_IMAGE, 125
        bootstrap.main()
        self.assertEqual([call[-1] for call in self.calls_with("pull")], [bootstrap.DEVELOPER_IMAGE, bootstrap.BASE_IMAGE])
        self.assertIn(f"SUITECONTAINER_BASE_IMAGE={bootstrap.BASE_IMAGE}", self.calls_with("build")[0])
        self.assertTrue(self.calls_with("--serve"))

    def test_stops_when_both_base_images_are_unavailable(self):
        self.failure = "pull", 125
        with self.assertRaises(subprocess.CalledProcessError):
            bootstrap.main()
        self.assertEqual(len(self.calls_with("pull")), 2)
        self.assertFalse(self.calls_with("build"))
        self.assertFalse(self.calls_with("--serve"))

    def test_pulls_base_image_inside_wsl(self):
        machine = {"Name": "fixture-machine", "VMType": "wsl"}
        with patch.object(bootstrap, "podman", side_effect=[
            subprocess.CompletedProcess([], 125, "", ""),
            subprocess.CompletedProcess([], 0, "", ""),
        ]) as podman:
            self.assertEqual(bootstrap.select_base_image(machine), bootstrap.BASE_IMAGE)
        for call, image in zip(podman.call_args_list, (bootstrap.DEVELOPER_IMAGE, bootstrap.BASE_IMAGE)):
            self.assertEqual(call.args, ("machine", "ssh", "fixture-machine", "--", f"podman pull --retry=0 {image}"))

    def test_creates_first_run_files_without_prompts(self):
        bootstrap.main()
        self.assertTrue((self.root / "credentials/auth.json").is_file())
        self.assertTrue((self.root / "repos").is_dir())
        config = json.loads((self.root / "suitecontainer.config.json").read_text())
        self.assertEqual(config["vms"][0]["url"], "")
        self.assertTrue(self.calls_with("--serve"))

    def test_propagates_preparation_and_mount_failures(self):
        for argument, status in (("--web-paths", 2), ("--web-mounts", 3)):
            with self.subTest(argument=argument):
                self.calls.clear()
                self.failure = argument, status
                with self.assertRaises(subprocess.CalledProcessError) as failure:
                    bootstrap.main()
                self.assertEqual(failure.exception.returncode, status)
                self.assertFalse(self.calls_with("--serve"))

    def test_stops_on_build_and_page_start_failures(self):
        for argument, status in (("build", 3), ("--serve", 4)):
            with self.subTest(argument=argument):
                self.failure = argument, status
                with self.assertRaises(subprocess.CalledProcessError) as failure:
                    bootstrap.main()
                self.assertEqual(failure.exception.returncode, status)
        self.assertEqual(len(self.calls_with("--web-paths")), 1)

    def test_reuses_running_app_without_rebuilding(self):
        self.existing = self.running = True
        bootstrap.main()
        self.assertFalse(self.calls_with("build"))
        self.assertFalse(self.calls_with("--serve"))
        self.assertTrue(self.calls_with("port"))

    def test_passes_npm_configuration_as_build_secret(self):
        npmrc = Path(os.environ["SUITECONTAINER_NPMRC"])
        npmrc.parent.mkdir()
        npmrc.write_text("registry=https://registry.example.test/\n")
        bootstrap.main()
        self.assertIn(f"id=npmrc,src={npmrc}", self.calls_with("build")[0])

    @unittest.skipUnless(os.name == "nt", "Windows paths are needed for the WSL case")
    def test_builds_inside_wsl_without_exposing_token(self):
        self.wsl = True
        os.environ["NSX_NPM_TOKEN"] = "test-token"
        with self.host("windows"):
            bootstrap.main()
        ssh = [call for call in self.calls if call[1:3] == ["machine", "ssh"] and call[-1].startswith("podman build ")][0]
        self.assertIn("fixture-machine", ssh)
        self.assertIn("id=npm-token,src=/mnt/", ssh[-1])
        self.assertNotIn("test-token", ssh[-1])
        self.assertNotIn("\\", ssh[-1])
        self.assertIn(bootstrap.machine_path(self.root / "setup/Containerfile"), ssh[-1])
        self.assertIn(bootstrap.machine_path(self.root / "setup/.containerignore"), ssh[-1])
        self.assertFalse(self.calls_with("build"))

    def test_imports_token_without_mounting_codex_configuration(self):
        nems = Path(os.environ["SUITECONTAINER_NEMS_DIR"])
        nems.mkdir()
        (self.root / "credentials/auth.json").write_text('{"gitlab-token": ""}')
        for name in (".nems.env", "config.toml"):
            (nems / name).write_text('GITLAB_TOKEN="fixture-token"')
        bootstrap.main()
        auth = json.loads((self.root / "credentials/auth.json").read_text())
        self.assertEqual(auth["gitlab-token"], "fixture-token")
        self.assertNotIn(str(nems), " ".join(self.calls_with("--serve")[0]))

    def test_replaces_stopped_app_after_checking_owner(self):
        self.existing = True
        bootstrap.main()
        self.assertEqual(len(self.calls_with("rm")), 1)
        self.assertLess(self.calls.index(self.calls_with("inspect")[-1]), self.calls.index(self.calls_with("rm")[0]))
        self.assertEqual(len(self.calls_with("--serve")), 1)

    def test_does_not_reuse_app_owned_by_another_checkout(self):
        self.existing = self.running = True
        self.owner = "another checkout"
        with self.assertRaisesRegex(RuntimeError, "Another container"):
            bootstrap.main()
        self.assertFalse(self.calls_with("rm"))
        self.assertFalse(self.calls_with("--serve"))
        self.browser.assert_not_called()

    def test_does_not_remove_stopped_app_without_owner(self):
        self.existing = True
        self.owner = None
        with self.assertRaisesRegex(RuntimeError, "Another container"):
            bootstrap.main()
        self.assertFalse(self.calls_with("rm"))
        self.assertFalse(self.calls_with("--serve"))

    def test_leaves_existing_app_untouched_on_inspection_failure(self):
        self.existing = self.running = True
        self.inspection_status = 125
        with self.assertRaisesRegex(RuntimeError, "Could not inspect"):
            bootstrap.main()
        self.assertFalse(self.calls_with("rm"))
        self.assertFalse(self.calls_with("--serve"))
        self.browser.assert_not_called()

    def test_rejects_malformed_inspection_without_removing_app(self):
        self.existing = True
        self.invalid_inspection = "invalid JSON"
        with self.assertRaisesRegex(RuntimeError, "Could not read ownership"):
            bootstrap.main()
        self.assertFalse(self.calls_with("rm"))
        self.assertFalse(self.calls_with("--serve"))

    def test_token_discovery_reads_data_and_preserves_credentials(self):
        for source, expected in (('[gitlab]\naccess_token = "example-token"', "example-token"), ('env = { NEMS_GITLAB_TOKEN = "inline-token" }', "inline-token"), ('env = { "GITLAB_PERSONAL_ACCESS_TOKEN" = "personal-token" }', "personal-token"), ('env = { GITLAB_PAT = "pat-token" }', "pat-token"), ('export GITLAB_TOKEN=literal-value # comment', "literal-value")):
            self.assertEqual(bootstrap.token_in(source), expected)
        auth, toml, env = [self.root / name for name in ("auth.json", "config.toml", ".nems.env")]
        auth.write_text('{"gitlab-token":""}')
        toml.write_text('[gitlab]\ntoken="preferred"')
        env.write_text("GITLAB_TOKEN=other")
        bootstrap.import_token(auth, [toml, env])
        bootstrap.import_token(auth, [env])
        self.assertEqual(json.loads(auth.read_text())["gitlab-token"], "preferred")


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.available = {"podman": "podman", "winget": "winget", "dnf": "dnf", "yum": "yum", "sudo": "sudo"}
        self.calls = []
        self.failure = None
        self.downloaded_package = None
        self.output = self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.stack.enter_context(patch.object(bootstrap, "host_path"))
        self.stack.enter_context(patch.object(bootstrap.shutil, "which", side_effect=lambda name: self.available.get(name)))
        self.stack.enter_context(patch.object(bootstrap.platform, "machine", return_value="arm64"))
        self.stack.enter_context(patch.object(bootstrap.os, "getuid", return_value=1000, create=True))
        self.stack.enter_context(patch.object(bootstrap, "command", side_effect=self.command))

    def command(self, *args, **kwargs):
        args = [str(arg) for arg in args]
        self.calls.append(args)
        if self.failure and args[0] == self.failure[0]:
            raise subprocess.CalledProcessError(self.failure[1], args)
        if args[0] == "curl":
            self.downloaded_package = Path(args[args.index("--output") + 1])
            self.downloaded_package.touch()
        elif args[0] in ("winget", "brew", "sudo", "dnf", "yum"):
            self.available["podman"] = "podman"
        return subprocess.CompletedProcess(args, 0, "", "")

    @contextlib.contextmanager
    def host(self, name):
        with patch.multiple(bootstrap, WINDOWS=name == "windows", MACOS=name == "macos"):
            yield

    def test_reuses_existing_podman_without_installing_packages(self):
        for host in ("windows", "macos", "linux"):
            with self.subTest(host=host), self.host(host):
                bootstrap.install_podman()
        self.assertFalse(self.calls)

    def test_installs_windows_podman_through_winget(self):
        self.available.pop("podman")
        with self.host("windows"):
            bootstrap.install_podman()
        self.assertEqual(self.calls[0][:5], ["winget", "install", "--id", "Podman.CLI", "--exact"])

    def test_reports_missing_windows_package_manager(self):
        self.available.pop("podman")
        self.available.pop("winget")
        with self.host("windows"), self.assertRaisesRegex(RuntimeError, "Windows Package Manager is missing"):
            bootstrap.install_podman()
        self.assertFalse(self.calls)

    @unittest.skipUnless(os.name == "nt", "Windows registry paths are needed")
    def test_finds_installed_windows_podman_outside_path(self):
        # Test the path search rather than installing software on the host.
        with patch.object(bootstrap, "WINDOWS", True), patch.dict(os.environ, {"PATH": "fixture"}):
            HOST_PATH()
            self.assertIn(str(Path(os.environ["LOCALAPPDATA"]) / "Programs/Podman"), os.environ["PATH"])

    def test_mac_prefers_homebrew_for_both_processors(self):
        self.available["brew"] = "brew"
        for architecture in ("x86_64", "arm64"):
            self.available.pop("podman", None)
            with self.subTest(architecture=architecture), self.host("macos"), patch.object(bootstrap.platform, "machine", return_value=architecture):
                bootstrap.install_podman()
        self.assertEqual(self.calls, [["brew", "install", "podman"], ["brew", "install", "podman"]])

    def test_mac_propagates_homebrew_failure(self):
        self.available.pop("podman")
        self.available["brew"] = "brew"
        self.failure = "brew", 4
        with self.host("macos"), self.assertRaises(subprocess.CalledProcessError) as failure:
            bootstrap.install_podman()
        self.assertEqual(failure.exception.returncode, 4)

    def test_mac_downloads_matching_package_and_removes_download(self):
        for architecture, suffix in (("x86_64", "amd64"), ("arm64", "arm64")):
            self.available.pop("podman", None)
            with self.subTest(architecture=architecture), self.host("macos"), patch.object(bootstrap.platform, "machine", return_value=architecture):
                bootstrap.install_podman()
                self.assertTrue(self.downloaded_package.name.endswith(f"macos-{suffix}.pkg"))
                self.assertFalse(self.downloaded_package.exists())
                self.assertFalse(self.downloaded_package.parent.exists())
                self.assertEqual(self.calls[-1][0:2], ["sudo", "installer"])

    def test_mac_rejects_unsupported_processors_before_downloading(self):
        self.available.pop("podman")
        with self.host("macos"), patch.object(bootstrap.platform, "machine", return_value="unknown"), self.assertRaisesRegex(RuntimeError, "not supported"):
            bootstrap.install_podman()
        self.assertFalse(self.calls)

    def test_failed_mac_download_stops_before_installation(self):
        self.available.pop("podman")
        self.failure = "curl", 5
        with self.host("macos"), self.assertRaises(subprocess.CalledProcessError) as failure:
            bootstrap.install_podman()
        self.assertEqual(failure.exception.returncode, 5)
        self.assertFalse(any(call[0] == "sudo" for call in self.calls))

    def test_codebox_uses_sudo_dnf_for_regular_user(self):
        self.available.pop("podman")
        with self.host("linux"):
            bootstrap.install_podman()
        self.assertEqual(self.calls, [["sudo", "dnf", "install", "-y", "podman"]])

    def test_codebox_uses_yum_without_sudo_as_root(self):
        self.available.pop("podman")
        self.available.pop("dnf")
        with self.host("linux"), patch.object(bootstrap.os, "getuid", return_value=0, create=True):
            bootstrap.install_podman()
        self.assertEqual(self.calls, [["yum", "install", "-y", "podman"]])

    def test_codebox_explains_missing_sudo(self):
        self.available.pop("podman")
        self.available.pop("sudo")
        with self.host("linux"), self.assertRaisesRegex(RuntimeError, "requires sudo access"):
            bootstrap.install_podman()
        self.assertFalse(self.calls)

    def test_codebox_preserves_package_manager_failure(self):
        self.available.pop("podman")
        self.failure = "dnf", 4
        with self.host("linux"), patch.object(bootstrap.os, "getuid", return_value=0, create=True), self.assertRaises(subprocess.CalledProcessError) as failure:
            bootstrap.install_podman()
        self.assertEqual(failure.exception.returncode, 4)


if __name__ == "__main__":
    unittest.main()
