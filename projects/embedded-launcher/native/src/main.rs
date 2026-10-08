use embedded_launcher::supervisor::{self, Mode, Options, Supervisor};
use serde_json::json;
use std::path::PathBuf;
fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let value = |name: &str| {
        args.iter()
            .position(|arg| arg == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let profile = PathBuf::from(value("--profile").unwrap_or_else(|| {
        let base = std::env::var("XDG_DATA_HOME").unwrap_or_else(|_| {
            format!(
                "{}/.local/share",
                std::env::var("HOME").unwrap_or(".".into())
            )
        });
        format!(
            "{base}/pluxel-embedded-launcher/{}",
            if args.iter().any(|arg| arg == "--dev") {
                "development"
            } else {
                "production"
            }
        )
    }));
    if args.first().is_some_and(|arg| arg == "cli") {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        let command = if let Some(i) = args.iter().position(|arg| arg == "--") {
            args[i + 1..].to_vec()
        } else {
            vec![]
        };
        let method = value("--method").unwrap_or("cli.execute".into());
        let params = if let Some(input) = value("--params") {
            serde_json::from_str(&input).map_err(|e| e.to_string())?
        } else {
            json!({"argv":command})
        };
        let result = runtime.block_on(supervisor::cli(&profile, &method, params))?;
        println!("{}", serde_json::to_string_pretty(&result).unwrap());
        if result.get("ok") == Some(&json!(false)) {
            return Err("command returned a domain failure".into());
        }
        return Ok(());
    }
    let mode = if args.iter().any(|arg| arg == "--dev") {
        Mode::Development
    } else {
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let root = value("--plugins")
            .map(PathBuf::from)
            .unwrap_or_else(|| executable.parent().unwrap().join("plugins"));
        Mode::Embedded {
            root,
            entry: "embedded.mjs".into(),
        }
    };
    let (handle, events) = Supervisor::start(Options { mode, profile })?;
    let shutdown = handle.clone();
    let result = embedded_launcher::ui::run(handle, events).map_err(|e| e.to_string());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let closed = runtime.block_on(shutdown.shutdown());
    result.and(closed)
}
