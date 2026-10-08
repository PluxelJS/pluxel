//! The demo's controlled precompiled package store. Immutable bytes are retained
//! while installed selection and the running selection are separate facts.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
const PACKAGE: &str = "@embedded-launcher/app";
const MAX_ARCHIVE: u64 = 16 * 1024 * 1024;
const MAX_EXPANDED: u64 = 32 * 1024 * 1024;
const MAX_FILES: usize = 256;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Manifest {
    pub format: u32,
    pub name: String,
    pub version: String,
    pub entry: String,
    pub exports: Vec<String>,
    pub lowering_abi: u32,
    pub sdk_version: String,
    pub requires: BTreeMap<String, String>,
    pub files: BTreeMap<String, String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Selected {
    version: String,
    revision: String,
}
type Selection = BTreeMap<String, Selected>;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    format: u32,
    installed: Selection,
    previous: Option<Selection>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RuntimeManifest {
    format: u32,
    sdk_version: String,
    lowering_abi: u32,
    files: BTreeMap<String, String>,
}
pub struct PackageStore {
    root: PathBuf,
    baseline: PathBuf,
    baseline_manifest: RuntimeManifest,
    baseline_digest: String,
    installed: Selection,
    previous: Option<Selection>,
    active: Option<Selection>,
    error: Option<String>,
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn selection_revision(selection: &Selection) -> String {
    hash(&serde_json::to_vec(selection).unwrap())
}
fn path_ok(name: &str) -> bool {
    !name.is_empty()
        && name
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
        && !name.contains('\\')
        && !name.contains(':')
        && Path::new(name)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn atomic_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path.parent().unwrap();
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut staged, value).map_err(|e| e.to_string())?;
    staged.write_all(b"\n").map_err(|e| e.to_string())?;
    staged.as_file().sync_all().map_err(|e| e.to_string())?;
    staged.persist(path).map_err(|e| e.to_string())?;
    File::open(parent)
        .and_then(|file| file.sync_all())
        .map_err(|e| e.to_string())
}
impl PackageStore {
    pub fn open(profile: &Path, baseline: &Path) -> Result<Self, String> {
        let baseline = baseline
            .canonicalize()
            .map_err(|e| format!("runtime baseline: {e}"))?;
        if !baseline.join("embedded.mjs").is_file() || !baseline.join("shared").is_dir() {
            return Err("runtime baseline must contain embedded.mjs and shared/".into());
        }
        let baseline_bytes = fs::read(baseline.join("runtime.json"))
            .map_err(|e| format!("runtime manifest: {e}"))?;
        let baseline_manifest: RuntimeManifest = serde_json::from_slice(&baseline_bytes)
            .map_err(|e| format!("runtime manifest: {e}"))?;
        if baseline_manifest.format != 1
            || baseline_manifest.lowering_abi != 2
            || baseline_manifest.sdk_version != "1"
            || !baseline_manifest.files.contains_key("embedded.mjs")
            || baseline_manifest.files.len() > MAX_FILES
            || baseline_manifest.files.iter().any(|(path, digest)| {
                !path_ok(path)
                    || !valid_digest(digest)
                    || (path != "embedded.mjs" && !path.starts_with("shared/"))
            })
        {
            return Err("runtime baseline format, ABI, SDK or file list mismatch".into());
        }
        let baseline_digest = hash(&serde_json::to_vec(&baseline_manifest).unwrap());
        let root = profile.join("packages");
        fs::create_dir_all(root.join("revisions")).map_err(|e| e.to_string())?;
        fs::create_dir_all(root.join("active")).map_err(|e| e.to_string())?;
        let saved = match fs::read(root.join("selection.json")) {
            Ok(bytes) => Some(
                serde_json::from_slice::<Saved>(&bytes)
                    .map_err(|e| format!("package selection is corrupt; bytes preserved: {e}"))?,
            ),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        };
        let fresh = saved.is_none();
        let saved = saved.unwrap_or(Saved {
            format: 1,
            installed: BTreeMap::new(),
            previous: None,
        });
        if saved.format != 1 {
            return Err("unsupported package selection format".into());
        }
        let mut store = Self {
            root,
            baseline,
            baseline_manifest,
            baseline_digest,
            installed: saved.installed,
            previous: saved.previous,
            active: None,
            error: None,
        };
        if fresh {
            store.install(&store.baseline.join("seed.zip"))?;
            store.previous = None;
            store.save()?;
        }
        store.validate_selection(&store.installed)?;
        Ok(store)
    }
    pub fn status(&self) -> Value {
        let installed = selection_revision(&self.installed);
        let active = self.active.as_ref().map(selection_revision);
        let mut names: std::collections::BTreeSet<&String> = self.installed.keys().collect();
        if let Some(active) = &self.active {
            names.extend(active.keys());
        }
        let packages:Vec<Value>=names.into_iter().map(|name|json!({"name":name,"version":self.installed.get(name).map(|p|&p.version),"revision":self.installed.get(name).map(|p|&p.revision),"activeVersion":self.active.as_ref().and_then(|active|active.get(name)).map(|p|&p.version)})).collect();
        json!({"mode":"embedded","installedRevision":installed,"activeRevision":active,"previousRevision":self.previous.as_ref().map(selection_revision),"pending":active.as_ref()!=Some(&installed),"packages":packages,"error":self.error})
    }
    fn save(&self) -> Result<(), String> {
        atomic_json(
            &self.root.join("selection.json"),
            &Saved {
                format: 1,
                installed: self.installed.clone(),
                previous: self.previous.clone(),
            },
        )
    }
    fn read_manifest(&self, revision: &str) -> Result<Manifest, String> {
        if !valid_digest(revision) {
            return Err("invalid package revision".into());
        }
        let path = self
            .root
            .join("revisions")
            .join(revision)
            .join("manifest.json");
        serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    }
    fn validate_manifest(manifest: &Manifest) -> Result<(), String> {
        if manifest.format != 1 || manifest.name != PACKAGE {
            return Err(format!(
                "only format 1 controlled package {PACKAGE} is supported"
            ));
        }
        semver::Version::parse(&manifest.version)
            .map_err(|e| format!("invalid package version: {e}"))?;
        if manifest.lowering_abi != 2 {
            return Err(format!(
                "lowering ABI mismatch: expected 2, got {}",
                manifest.lowering_abi
            ));
        }
        if manifest.sdk_version != "1" {
            return Err(format!(
                "host SDK mismatch: expected 1, got {}",
                manifest.sdk_version
            ));
        }
        if !path_ok(&manifest.entry) || !manifest.files.contains_key(&manifest.entry) {
            return Err("entry must name a declared package file".into());
        }
        if manifest.exports.is_empty()
            || manifest.exports.len() > 64
            || manifest.exports.iter().any(|name| {
                name.is_empty()
                    || !name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'$')
            })
        {
            return Err("canonical exports must be explicit JavaScript identifiers".into());
        }
        let unique: HashSet<_> = manifest.exports.iter().collect();
        if unique.len() != manifest.exports.len() {
            return Err("duplicate canonical export".into());
        }
        if manifest.files.len() > MAX_FILES
            || manifest.files.iter().any(|(path, digest)| {
                !path_ok(path) || path == "manifest.json" || !valid_digest(digest)
            })
        {
            return Err("manifest file paths or SHA-256 digests are invalid".into());
        }
        for version in manifest.requires.values() {
            semver::Version::parse(version)
                .map_err(|e| format!("requires versions must be exact: {e}"))?;
        }
        Ok(())
    }
    fn validate_selection(&self, selection: &Selection) -> Result<(), String> {
        if selection.len() > 1 || selection.keys().any(|name| name != PACKAGE) {
            return Err("selection may contain only the controlled demo package".into());
        }
        for (name, selected) in selection {
            let manifest = self.read_manifest(&selected.revision)?;
            Self::validate_manifest(&manifest)?;
            if manifest.name != *name || manifest.version != selected.version {
                return Err("selection identity does not match immutable manifest".into());
            }
            for (dependency, version) in &manifest.requires {
                if selection
                    .get(dependency)
                    .is_none_or(|p| p.version != *version)
                {
                    return Err(format!("package requires {dependency}@{version}"));
                }
            }
            let root = self.root.join("revisions").join(&selected.revision);
            for (path, digest) in &manifest.files {
                let file = root.join(path);
                if fs::symlink_metadata(&file)
                    .map_err(|e| e.to_string())?
                    .file_type()
                    .is_symlink()
                {
                    return Err(format!("package file is a symlink: {path}"));
                }
                let bytes = fs::read(&file).map_err(|e| e.to_string())?;
                if hash(&bytes) != *digest {
                    return Err(format!("package integrity mismatch: {path}"));
                }
            }
        }
        Ok(())
    }
    pub fn install(&mut self, path: &Path) -> Result<Value, String> {
        let file = File::open(path).map_err(|e| e.to_string())?;
        if file.metadata().map_err(|e| e.to_string())?.len() > MAX_ARCHIVE {
            return Err("package ZIP exceeds 16 MiB".into());
        }
        let mut zip =
            zip::ZipArchive::new(file).map_err(|e| format!("invalid package ZIP: {e}"))?;
        if zip.len() > MAX_FILES + 1 {
            return Err("package ZIP has too many entries".into());
        }
        let mut seen = HashSet::new();
        let mut expanded = 0u64;
        for index in 0..zip.len() {
            let entry = zip.by_index(index).map_err(|e| e.to_string())?;
            let name = entry.name();
            if !path_ok(name) || entry.enclosed_name().is_none() || entry.is_dir() {
                return Err(format!("invalid archive file path: {name}"));
            }
            if entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 != 0 && mode & 0o170000 != 0o100000)
            {
                return Err(format!(
                    "archive links or special files are forbidden: {name}"
                ));
            }
            if !seen.insert(name.to_owned()) {
                return Err(format!("duplicate archive file: {name}"));
            }
            expanded = expanded
                .checked_add(entry.size())
                .ok_or("archive size overflow")?;
            if expanded > MAX_EXPANDED {
                return Err("package expanded size exceeds 32 MiB".into());
            }
        }
        let mut manifest_bytes = Vec::new();
        zip.by_name("manifest.json")
            .map_err(|_| "manifest.json missing")?
            .take(65537)
            .read_to_end(&mut manifest_bytes)
            .map_err(|e| e.to_string())?;
        if manifest_bytes.len() > 65536 {
            return Err("manifest exceeds 64 KiB".into());
        }
        let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|e| format!("invalid manifest: {e}"))?;
        Self::validate_manifest(&manifest)?;
        if seen.len() != manifest.files.len() + 1
            || manifest.files.keys().any(|name| !seen.contains(name))
        {
            return Err("archive files do not exactly match manifest".into());
        }
        let revision = hash(&serde_json::to_vec(&manifest).unwrap());
        let destination = self.root.join("revisions").join(&revision);
        let staged = tempfile::Builder::new()
            .prefix("staging-")
            .tempdir_in(&self.root)
            .map_err(|e| e.to_string())?;
        for (name, digest) in &manifest.files {
            let mut bytes = Vec::new();
            zip.by_name(name)
                .map_err(|e| e.to_string())?
                .take(MAX_EXPANDED + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() as u64 > MAX_EXPANDED || hash(&bytes) != *digest {
                return Err(format!("package integrity mismatch: {name}"));
            }
            let file = staged.path().join(name);
            fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
            let mut output = File::create(file).map_err(|e| e.to_string())?;
            output.write_all(&bytes).map_err(|e| e.to_string())?;
            output.sync_all().map_err(|e| e.to_string())?;
        }
        atomic_json(&staged.path().join("manifest.json"), &manifest)?;
        if !destination.exists() {
            fs::rename(staged.path(), &destination).map_err(|e| e.to_string())?;
        }
        let mut candidate = self.installed.clone();
        candidate.insert(
            manifest.name.clone(),
            Selected {
                version: manifest.version,
                revision,
            },
        );
        self.validate_selection(&candidate)?;
        let installed = std::mem::replace(&mut self.installed, candidate);
        let previous = self.previous.replace(installed.clone());
        if let Err(error) = self.save() {
            self.installed = installed;
            self.previous = previous;
            return Err(error);
        }
        self.error = None;
        Ok(json!({"committed":true,"status":self.status()}))
    }
    pub fn remove(&mut self, name: &str) -> Result<Value, String> {
        if !self.installed.contains_key(name) {
            return Err("package is not installed".into());
        }
        let mut candidate = self.installed.clone();
        candidate.remove(name);
        self.validate_selection(&candidate)?;
        let installed = std::mem::replace(&mut self.installed, candidate);
        let previous = self.previous.replace(installed.clone());
        if let Err(error) = self.save() {
            self.installed = installed;
            self.previous = previous;
            return Err(error);
        }
        self.error = None;
        Ok(json!({"committed":true,"status":self.status()}))
    }
    pub fn select_previous(&mut self) -> Result<Value, String> {
        let candidate = self
            .previous
            .clone()
            .ok_or("no previous selection retained")?;
        self.validate_selection(&candidate)?;
        let installed = std::mem::replace(&mut self.installed, candidate);
        let previous = self.previous.replace(installed.clone());
        if let Err(error) = self.save() {
            self.installed = installed;
            self.previous = previous;
            return Err(error);
        }
        self.error = None;
        Ok(json!({"committed":true,"status":self.status()}))
    }
    /// Validate and materialize before the old runtime is closed. The directory is
    /// never modified or removed while any runtime may still import from it.
    pub fn prepare_active(&self) -> Result<PathBuf, String> {
        self.validate_selection(&self.installed)?;
        for (file, digest) in &self.baseline_manifest.files {
            validate_file(&self.baseline, file, digest)?;
        }
        let revision = hash(
            format!(
                "{}:{}",
                self.baseline_digest,
                selection_revision(&self.installed)
            )
            .as_bytes(),
        );
        let destination = self.root.join("active").join(revision);
        if destination.exists() {
            for (file, digest) in &self.baseline_manifest.files {
                validate_file(&destination, file, digest)?;
            }
            if let Some(selected) = self.installed.get(PACKAGE) {
                let manifest = self.read_manifest(&selected.revision)?;
                for (file, digest) in &manifest.files {
                    validate_file(&destination.join("packages/demo"), file, digest)?;
                }
            }
            return Ok(destination);
        }
        let staged = tempfile::Builder::new()
            .prefix("active-staging-")
            .tempdir_in(&self.root)
            .map_err(|e| e.to_string())?;
        for (file, _) in &self.baseline_manifest.files {
            let output = staged.path().join(file);
            fs::create_dir_all(output.parent().unwrap()).map_err(|e| e.to_string())?;
            fs::copy(self.baseline.join(file), output).map_err(|e| e.to_string())?;
        }
        let mut imports = String::new();
        let mut exports = Vec::new();
        if let Some(selected) = self.installed.get(PACKAGE) {
            let manifest = self.read_manifest(&selected.revision)?;
            let source = self.root.join("revisions").join(&selected.revision);
            copy_tree(&source, &staged.path().join("packages/demo"))?;
            imports.push_str(&format!(
                "import * as demo from {};\n",
                serde_json::to_string(&format!("./packages/demo/{}", manifest.entry)).unwrap()
            ));
            for export in &manifest.exports {
                exports.push(format!("demo[{}]", serde_json::to_string(export).unwrap()));
            }
        }
        fs::write(
            staged.path().join("selection.mjs"),
            format!("{imports}export const plugins = [{}];\n", exports.join(",")),
        )
        .map_err(|e| e.to_string())?;
        fs::rename(staged.path(), &destination).map_err(|e| e.to_string())?;
        Ok(destination)
    }
    pub fn activated(&mut self) {
        self.active = Some(self.installed.clone());
        self.error = None;
    }
    pub fn failed(&mut self, error: String) {
        self.active = None;
        self.error = Some(error);
    }
}
fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            return Err(format!(
                "symlink forbidden in runtime inputs: {}",
                entry.path().display()
            ));
        }
        let output = destination.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &output)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), output).map_err(|e| e.to_string())?;
        } else {
            return Err("special file forbidden in runtime inputs".into());
        }
    }
    Ok(())
}

fn validate_file(root: &Path, name: &str, digest: &str) -> Result<(), String> {
    let mut file = root.to_path_buf();
    for component in Path::new(name).components() {
        file.push(component);
        if fs::symlink_metadata(&file)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err(format!("symlink in immutable input: {name}"));
        }
    }
    let bytes = fs::read(file).map_err(|e| e.to_string())?;
    if hash(&bytes) != digest {
        return Err(format!("runtime integrity mismatch: {name}"));
    }
    Ok(())
}
