use embedded_launcher::packages::PackageStore;
use serde_json::json;
use std::{fs, io::Write, path::Path};
use zip::{ZipWriter, write::SimpleFileOptions};

const MODULE: &[u8] = b"export class Demo {}\n";
const MODULE_DIGEST: &str = "b5453414d9281039e8baebe3fdd18b0eb14d1a9e9b3d3435db40083dc8b6eb4d";

fn archive(path: &Path, version: &str, name: &str, bytes: &[u8]) {
    let mut zip = ZipWriter::new(fs::File::create(path).unwrap());
    zip.start_file("manifest.json", SimpleFileOptions::default())
        .unwrap();
    serde_json::to_writer(
        &mut zip,
        &json!({
            "format": 1, "name": "@embedded-launcher/app", "version": version,
            "entry": "plugins.mjs", "exports": ["Demo"], "loweringAbi": 2,
            "sdkVersion": "1", "requires": {}, "files": {"plugins.mjs": MODULE_DIGEST}
        }),
    )
    .unwrap();
    zip.start_file(name, SimpleFileOptions::default()).unwrap();
    zip.write_all(bytes).unwrap();
    zip.finish().unwrap();
}

#[test]
fn installs_verified_archives_and_preserves_selection_on_invalid_bytes_or_paths() {
    let directory = tempfile::tempdir().unwrap();
    let baseline = directory.path().join("baseline");
    fs::create_dir_all(baseline.join("shared")).unwrap();
    fs::write(baseline.join("embedded.mjs"), b"export {};\n").unwrap();
    fs::write(baseline.join("runtime.json"), serde_json::to_vec(&json!({
        "format": 1, "sdkVersion": "1", "loweringAbi": 2,
        "files": {"embedded.mjs": "8e609bb71c20b858c77f0e9f90bb1319db8477b13f9f965f1a1e18524bf50881"}
    })).unwrap()).unwrap();
    archive(&baseline.join("seed.zip"), "1.0.0", "plugins.mjs", MODULE);
    let profile = directory.path().join("profile");
    let mut store = PackageStore::open(&profile, &baseline).unwrap();
    let update = directory.path().join("update.zip");
    archive(&update, "2.0.0", "plugins.mjs", MODULE);
    store.install(&update).unwrap();
    let active = store.prepare_active().unwrap();
    assert_eq!(
        fs::read(active.join("packages/demo/plugins.mjs")).unwrap(),
        MODULE
    );
    store.activated();
    let accepted = store.status();
    assert_eq!(accepted["packages"][0]["activeVersion"], "2.0.0");

    archive(&update, "3.0.0", "plugins.mjs", b"tampered");
    assert!(
        store
            .install(&update)
            .unwrap_err()
            .contains("integrity mismatch")
    );
    assert_eq!(store.status(), accepted);
    archive(&update, "3.0.0", "../plugins.mjs", MODULE);
    assert!(
        store
            .install(&update)
            .unwrap_err()
            .contains("invalid archive file path")
    );
    assert_eq!(store.status(), accepted);
    assert_eq!(
        PackageStore::open(&profile, &baseline).unwrap().status()["installedRevision"],
        accepted["installedRevision"]
    );
}
