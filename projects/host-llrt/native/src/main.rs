use std::{
    error::Error,
    fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use http_body_util::Full;
use hyper::{
    Method, Request, Response, StatusCode,
    body::{Bytes, Incoming},
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use llrt_core::{CatchResultExt, Function, Module, Object, Promise, vm::Vm};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use tokio::{net::TcpListener, task::LocalSet};

type HostError = Box<dyn Error + Send + Sync>;

async fn serve_greetings(listener: TcpListener, requests: &AtomicUsize) -> Result<(), HostError> {
    loop {
        let (stream, _) = listener.accept().await?;
        let service = service_fn(|request: Request<Incoming>| async move {
            if request.method() != Method::GET || request.uri().path() != "/greeting" {
                return Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Full::new(Bytes::new()));
            }
            requests.fetch_add(1, Ordering::Relaxed);
            Response::builder()
                .header("content-type", "application/json")
                .body(Full::new(Bytes::from_static(
                    br#"{"source":"Rust loopback"}"#,
                )))
        });
        http1::Builder::new()
            .keep_alive(false)
            .serve_connection(TokioIo::new(stream), service)
            .await?;
    }
}

async fn run_host(
    entry: &Path,
    source_url: &str,
    installed: Option<String>,
) -> Result<String, HostError> {
    let expected_tickets = if installed.is_some() { 2 } else { 0 };
    let vm = Vm::new().await?;
    let tickets = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&tickets);
    let result = vm
        .ctx
        .async_with(async move |ctx| {
            let run: llrt_core::Result<String> = async {
                let exports: Object = Module::import(&ctx, entry.to_string_lossy().as_bytes())?
                    .into_future()
                    .await?;
                let start: Function = exports.get("run")?;
                let issue_ticket = Function::new(ctx.clone(), move |name: String| {
                    let sequence = counter.fetch_add(1, Ordering::Relaxed) + 1;
                    format!("{name}-{sequence}")
                })?;
                let finished: Promise =
                    start.call((source_url, issue_ticket, installed, std::process::id()))?;
                finished.into_future().await
            }
            .await;
            run.catch(&ctx).map_err(|error| format!("{error}"))
        })
        .await;
    vm.idle().await?;
    let report = result?;
    if tickets.load(Ordering::Relaxed) != expected_tickets {
        return Err("Native ticket count does not match the selected plugin".into());
    }
    Ok(report)
}

fn install(
    directory: &Path,
    selected: &Path,
    source: &Path,
    digest: &str,
) -> Result<(), HostError> {
    let bytes = fs::read(source)?;
    let actual: String = Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if actual != digest {
        return Err("TicketDesk SHA-256 mismatch".into());
    }
    fs::create_dir_all(directory)?;
    let mut staged = NamedTempFile::new_in(directory)?;
    staged.write_all(&bytes)?;
    staged.persist(selected)?;
    Ok(())
}

async fn run_application(source_url: &str, requests: &AtomicUsize) -> Result<(), HostError> {
    const USAGE: &str =
        "usage: pluxel-host-llrt RUNTIME_DIR [boot | install FILE SHA256 | uninstall]…";
    let mut args = std::env::args().skip(1);
    let root = PathBuf::from(args.next().ok_or(USAGE)?).canonicalize()?;
    let entry = root.join("bootstrap.mjs");
    let directory = root.join("installed");
    let selected = directory.join("ticket.mjs");
    let mut action = args.next().unwrap_or_else(|| "boot".into());
    loop {
        match action.as_str() {
            "boot" => {}
            "install" => {
                let source = args.next().ok_or(USAGE)?;
                let digest = args.next().ok_or(USAGE)?;
                install(&directory, &selected, Path::new(&source), &digest)?;
            }
            "uninstall" => fs::remove_file(&selected)?,
            _ => return Err(USAGE.into()),
        }
        // The installed file is the selection for this single-plugin example.
        let installed = match fs::symlink_metadata(&selected) {
            Ok(metadata) if metadata.is_file() => Some(
                selected
                    .to_str()
                    .ok_or("Expected a UTF-8 module path")?
                    .to_owned(),
            ),
            Ok(_) => return Err("Installed TicketDesk must be a regular ESM file".into()),
            Err(error) if error.kind() == ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        let before = requests.load(Ordering::Relaxed);
        let report = run_host(&entry, source_url, installed).await?;
        if requests.load(Ordering::Relaxed) - before != 4 {
            return Err("Expected four HTTP requests from this VM".into());
        }
        println!("{report}");

        // run_host drained and dropped this VM. The Rust HTTP server stays alive.
        match args.next() {
            Some(next) => action = next,
            None => return Ok(()),
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), HostError> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let source_url = format!("http://{}/greeting", listener.local_addr()?);
    let requests = AtomicUsize::new(0);
    let executor = LocalSet::new();
    tokio::select! {
        result = executor.run_until(run_application(&source_url, &requests)) => result,
        result = serve_greetings(listener, &requests) => {
            result?;
            Err("The greeting server stopped before the host closed".into())
        }
    }
}
