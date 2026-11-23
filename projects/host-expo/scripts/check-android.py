"""Exercise the release APK's local-file install, Hermes reload, offline start, and removal."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
import zipfile

PROJECT = Path(__file__).resolve().parent.parent
PACKAGE = "org.pluxel.hostexpo"


def adb(*args):
    return subprocess.check_output([os.environ.get("ADB", "adb"), *args], text=True, timeout=45).strip()


def nodes():
    raw = adb("exec-out", "uiautomator", "dump", "/dev/tty")
    begin, end = raw.find("<hierarchy"), raw.rfind("</hierarchy>")
    if begin < 0 or end < 0:
        return []
    return ET.fromstring(raw[begin:end + len("</hierarchy>")]).findall(".//node")


def tap(node):
    x1, y1, x2, y2 = map(int, re.findall(r"\d+", node.get("bounds")))
    adb("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))


def receipt(previous=None, digest=None):
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        fields = {node.get("resource-id", "").split("/")[-1]: node for node in nodes()}
        field, button = fields.get("receipt"), fields.get("change-plugin")
        if field is not None and button is not None and button.get("enabled") == "true":
            raw = field.get("text")
            if raw:
                try:
                    value = json.loads(raw)
                except json.JSONDecodeError as error:
                    raise RuntimeError(f"Pluxel startup or installation failed: {raw}") from error
                if value["runtime"] != previous:
                    shared = value["shared"]
                    assert value["engine"] == "Hermes" and value["pluginSha256"] == digest, value
                    expected = ["Consumer", "HostCapabilities", "Provider"]
                    if digest is not None:
                        expected.append("DeviceLanguage")
                    assert sorted(value["catalog"]) == sorted(expected), value
                    assert shared["first"]["visits"] == 1 and shared["second"]["visits"] == 2, value
                    if digest is None:
                        assert value["languages"] is None, value
                    else:
                        assert value["languages"] and all(value["languages"]), value
                    return value, button
        time.sleep(0.5)
    raise TimeoutError("No fresh receipt in the Android UI. Inspect adb logcat and the screen.")


def select_file(name):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        items = nodes()
        item = next((node for node in items if node.get("text") in (name, name.removesuffix(".json"))), None)
        if item is not None:
            tap(item)
            return
        downloads = next((node for node in items if node.get("text") == "Downloads" and node.get("clickable") == "true"), None)
        if downloads is None:
            drawer = next((node for node in items if node.get("content-desc") in ("Show roots", "Open navigation drawer")), None)
            if drawer is not None:
                tap(drawer)
                items = nodes()
            downloads = next((node for node in items if node.get("text") == "Downloads"), None)
        if downloads is not None:
            tap(downloads)
        time.sleep(0.5)
    raise TimeoutError(f"{name} not found in the Android document picker")


def launch():
    adb("shell", "am", "start", "-n", f"{PACKAGE}/.MainActivity")


def require_offline():
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        state = adb("shell", "dumpsys", "connectivity")
        if re.search(r"Active default network:\s*none\b", state, re.IGNORECASE):
            return
        time.sleep(0.5)
    raise RuntimeError("Android still has a default network. Disconnect Wi-Fi on the test device.")


def main(apk):
    with zipfile.ZipFile(apk) as archive:
        app_bundle = archive.read("assets/index.android.bundle")
        assert app_bundle.startswith(bytes.fromhex("c61fbc03c103191f")), "Expected Hermes bytecode in the APK"
        assert b"The device did not report a preferred language" not in app_bundle, "Plugin implementation found in the APK"
    if f"package:{PACKAGE}" in adb("shell", "pm", "list", "packages", PACKAGE).splitlines():
        raise RuntimeError(f"Start with a clean test device or explicitly uninstall {PACKAGE} first")
    assert "Success" in adb("install", str(apk))
    apk_digest = hashlib.sha256(apk.read_bytes()).hexdigest()
    original_mode = adb("shell", "cmd", "connectivity", "airplane-mode")
    if original_mode not in ("enabled", "disabled"):
        raise RuntimeError("Cannot check airplane mode on this Android version")
    remote = None
    try:
        adb("shell", "cmd", "connectivity", "airplane-mode", "enable")
        assert adb("shell", "cmd", "connectivity", "airplane-mode") == "enabled"
        require_offline()
        launch()
        initial, button = receipt()
        initial_pid = adb("shell", "pidof", PACKAGE)

        # Build B only after the unmodified APK has run without it.
        subprocess.run(["vp", "run", "build:plugin"], cwd=PROJECT, check=True)
        artifact = PROJECT / "dist/device-language.pluxel.json"
        digest = json.loads(artifact.read_text())["sha256"]
        name = f"pluxel-{digest[:12]}.json"
        remote = f"/sdcard/Download/{name}"
        adb("push", str(artifact), remote)
        adb("shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
            "-d", f"file://{remote}")
        tap(button)
        select_file(name)
        installed, _ = receipt(initial["runtime"], digest)
        installed_pid = adb("shell", "pidof", PACKAGE)
        assert installed_pid == initial_pid, "Installation restarted the OS process"

        adb("shell", "am", "force-stop", PACKAGE)
        launch()
        cold, button = receipt(installed["runtime"], digest)
        cold_pid = adb("shell", "pidof", PACKAGE)
        tap(button)
        removed, _ = receipt(cold["runtime"])
        removed_pid = adb("shell", "pidof", PACKAGE)
        assert removed_pid == cold_pid, "Removal restarted the OS process"
        installed_path = adb("shell", "pm", "path", PACKAGE).removeprefix("package:")
        assert adb("shell", "sha256sum", installed_path).split()[0] == apk_digest
        print(json.dumps({"apkSha256": apk_digest,
                          "processIds": {"initial": initial_pid, "installed": installed_pid,
                                         "cold": cold_pid, "removed": removed_pid},
                          "initial": initial, "installed": installed,
                          "cold": cold, "removed": removed}, ensure_ascii=False, indent=2))
    finally:
        if remote:
            adb("shell", "rm", "-f", remote)
        if original_mode == "disabled":
            adb("shell", "cmd", "connectivity", "airplane-mode", "disable")


if __name__ == "__main__":
    apk = Path(sys.argv[1]) if len(sys.argv) > 1 else PROJECT / "android/app/build/outputs/apk/release/app-release.apk"
    main(apk)
