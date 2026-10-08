//! Application lifetime owner. UI consumes projections and performs UI-thread
//! capabilities; it never owns a JS runtime or a writable Host graph.
use crate::{
    embedded::{Embedded, QUEUE_CAPACITY},
    packages::PackageStore,
    protocol::{self, Peer},
};
use fs2::FileExt;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    net::{UnixListener, UnixStream},
    sync::{mpsc, oneshot, watch},
};

#[derive(Debug)]
pub enum AppEvent {
    UiControl {
        action: Value,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Shutdown,
    Screenshot {
        path: PathBuf,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Connected {
        session: String,
    },
    Disconnected {
        message: String,
    },
    Query(Value),
    Clipboard {
        text: String,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Desktop {
        id: String,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Diagnostics(Vec<String>),
}
pub type AppEventReceiver = mpsc::Receiver<AppEvent>;
#[derive(Clone, Debug)]
pub struct AppHandle {
    tx: mpsc::Sender<Action>,
    closing: Arc<AtomicBool>,
    completion: watch::Receiver<Option<Result<(), String>>>,
}
impl AppHandle {
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        if self.closing.load(Ordering::SeqCst) {
            return Err("application closing; request not admitted".into());
        }
        let (reply, receipt) = oneshot::channel();
        self.tx
            .try_send(Action::Request {
                method: method.into(),
                params,
                reply,
            })
            .map_err(|_| "application request queue full or stopped".to_string())?;
        receipt
            .await
            .map_err(|_| "application stopped; operation outcome unknown".to_string())?
    }
    pub async fn shutdown(&self) -> Result<(), String> {
        if !self.closing.swap(true, Ordering::SeqCst) {
            self.tx
                .send(Action::Shutdown)
                .await
                .map_err(|_| "application shutdown owner stopped".to_string())?;
        }
        let mut completion = self.completion.clone();
        loop {
            if let Some(result) = completion.borrow().clone() {
                return result;
            }
            completion
                .changed()
                .await
                .map_err(|_| "application stopped before shutdown receipt".to_string())?;
        }
    }
}
#[derive(Debug)]
enum Action {
    Request {
        method: String,
        params: Value,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Shutdown,
}
pub enum Mode {
    Development,
    Embedded { root: PathBuf, entry: String },
}
pub struct Options {
    pub mode: Mode,
    pub profile: PathBuf,
}
pub struct Supervisor;
#[derive(Clone)]
enum Backend {
    Embedded {
        runtime: Arc<Embedded>,
        session: String,
    },
    Remote(Peer),
}
impl Backend {
    fn session(&self) -> &str {
        match self {
            Self::Embedded { session, .. } => session,
            Self::Remote(peer) => &peer.session,
        }
    }
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        match self {
            Self::Remote(peer) => peer.request(method, params).await,
            Self::Embedded { runtime, .. } => {
                static ID: AtomicU64 = AtomicU64::new(1);
                let raw=runtime.dispatch(json!({"jsonrpc":"2.0","id":format!("r:{}",ID.fetch_add(1,Ordering::Relaxed)),"method":method,"params":params}).to_string()).await?;
                protocol::result(serde_json::from_str(&raw).map_err(|e| e.to_string())?)
            }
        }
    }
}
struct Shared {
    backend: Mutex<Option<Backend>>,
    session: Mutex<Option<String>>,
    lease: Mutex<Option<String>>,
    query: Mutex<Option<Value>>,
    invalidate: mpsc::Sender<()>,
    contribution: Mutex<u64>,
    events: mpsc::Sender<AppEvent>,
    profile: PathBuf,
    instance: String,
    token: String,
    development: bool,
    packages: Mutex<Option<PackageStore>>,
    package_error: Mutex<Option<String>>,
    accepting: AtomicBool,
    actions: mpsc::Sender<Action>,
}
impl Supervisor {
    pub fn start(options: Options) -> Result<(AppHandle, AppEventReceiver), String> {
        let (tx, rx) = mpsc::channel(QUEUE_CAPACITY);
        let actor_tx = tx.clone();
        let (completion_tx, completion) = watch::channel(None);
        let (events, receiver) = mpsc::channel(QUEUE_CAPACITY);
        let (ready, started) = std::sync::mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("launcher-supervisor".into())
            .spawn(move || {
                match tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => {
                        runtime.block_on(run(options, rx, events, ready, completion_tx, actor_tx));
                    }
                    Err(error) => {
                        let _ = ready.send(Err(error.to_string()));
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        started
            .recv()
            .map_err(|_| "supervisor startup failed".to_string())??;
        Ok((
            AppHandle {
                tx,
                closing: Arc::new(AtomicBool::new(false)),
                completion,
            },
            receiver,
        ))
    }
}
fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 24];
    File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn profile_lock(profile: &Path) -> Result<File, String> {
    std::fs::create_dir_all(profile).map_err(|e| e.to_string())?;
    std::fs::set_permissions(profile, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(profile.join("instance.lock"))
        .map_err(|e| e.to_string())?;
    file.try_lock_exclusive()
        .map_err(|_| "profile is already owned by another application instance".to_string())?;
    Ok(file)
}
async fn run(
    options: Options,
    mut actions: mpsc::Receiver<Action>,
    events: mpsc::Sender<AppEvent>,
    ready: std::sync::mpsc::SyncSender<Result<(), String>>,
    completion: watch::Sender<Option<Result<(), String>>>,
    actor_tx: mpsc::Sender<Action>,
) {
    let (invalidate, mut invalidated) = mpsc::channel(1);
    let startup = (|| {
        let lock = profile_lock(&options.profile)?;
        let profile = options.profile.canonicalize().map_err(|e| e.to_string())?;
        let socket = profile.join("launcher.sock");
        if socket.exists() {
            std::fs::remove_file(&socket).map_err(|e| e.to_string())?;
        }
        let listener = UnixListener::bind(&socket).map_err(|e| e.to_string())?;
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
        let instance = random_id()?;
        let token = random_id()?;
        let shared = Arc::new(Shared {
            backend: Mutex::new(None),
            session: Mutex::new(None),
            lease: Mutex::new(None),
            query: Mutex::new(None),
            invalidate,
            contribution: Mutex::new(0),
            events: events.clone(),
            profile: profile.clone(),
            instance: instance.clone(),
            token: token.clone(),
            development: matches!(options.mode, Mode::Development),
            packages: Mutex::new(None),
            package_error: Mutex::new(None),
            accepting: AtomicBool::new(true),
            actions: actor_tx,
        });
        let identity = json!({"event":"ready","socket":socket,"instance":instance,"profile":profile,"token":token,"pid":std::process::id()});
        let mut file = tempfile::NamedTempFile::new_in(&profile).map_err(|e| e.to_string())?;
        file.write_all(identity.to_string().as_bytes())
            .map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        file.persist(profile.join("endpoint.json"))
            .map_err(|e| e.to_string())?;

        Ok::<_, String>((lock, listener, shared, identity))
    })();
    let (_lock, listener, shared, identity) = match startup {
        Ok(value) => value,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    if shared.development {
        println!("{identity}");
    }
    let (stop_tx, stop_rx) = watch::channel(false);
    let accept_shared = shared.clone();
    let mut accept_stop = stop_rx.clone();
    let listener_task = tokio::spawn(async move {
        let mut peers = tokio::task::JoinSet::new();
        loop {
            tokio::select! {_ = accept_stop.changed()=>break, accepted=listener.accept()=>match accepted{Ok((stream,_))=>{let shared=accept_shared.clone();peers.spawn(async move{let _=serve_peer(stream,shared).await;});},Err(_)=>break}, _=peers.join_next(),if !peers.is_empty()=>{}}
        }
        peers.abort_all();
        while peers.join_next().await.is_some() {}
    });
    let invalidation_shared = shared.clone();
    let mut invalidation_stop = stop_rx.clone();
    let invalidation_task = tokio::spawn(async move {
        loop {
            tokio::select! { _ = invalidation_stop.changed() => break, notification = invalidated.recv() => if notification.is_none() { break; } }
            let query = invalidation_shared.query.lock().unwrap().clone();
            if let Some(query) = query {
                if let Err(error) =
                    call_backend(&invalidation_shared, "launcher.query", query).await
                {
                    let _ = invalidation_shared
                        .events
                        .send(AppEvent::Diagnostics(vec![error]))
                        .await;
                }
            }
        }
    });
    let mut native_task = None;
    if let Mode::Embedded { root, entry } = options.mode {
        let prepared = PackageStore::open(&shared.profile, &root).and_then(|store| {
            let active = store.prepare_active()?;
            *shared.packages.lock().unwrap() = Some(store);
            Ok(active)
        });
        let started = match prepared {
            Ok(active) => start_runtime(shared.clone(), active, &entry).await,
            Err(error) => Err(error),
        };
        match started {
            Ok(task) => {
                native_task = Some(task);
                if let Some(store) = shared.packages.lock().unwrap().as_mut() {
                    store.activated();
                }
            }
            Err(error) => {
                if let Some(store) = shared.packages.lock().unwrap().as_mut() {
                    store.failed(error.clone());
                }
                *shared.package_error.lock().unwrap() = Some(error.clone());
                let _ = events.send(AppEvent::Disconnected { message: error }).await;
            }
        }
    }
    let signal_events = events.clone();
    let mut signal_stop = stop_rx.clone();
    let signal_task = tokio::spawn(async move {
        if let (Ok(mut terminate), Ok(mut interrupt)) = (
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()),
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()),
        ) {
            tokio::select! { _ = terminate.recv() => {}, _ = interrupt.recv() => {}, _ = signal_stop.changed() => return }
            let _ = signal_events.send(AppEvent::Shutdown).await;
        }
    });
    let _ = ready.send(Ok(()));
    let mut pending = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            action=actions.recv()=>match action{Some(Action::Request{method,params,reply})=>{if method.starts_with("packages."){let result=package_request(&shared,&method,params,&mut native_task).await;let _=reply.send(result);continue;}if pending.len()>=QUEUE_CAPACITY{let _=reply.send(Err("application in-flight limit reached".into()));continue;}let shared=shared.clone();pending.spawn(async move{let result=call_backend(&shared,&method,params).await;let _=reply.send(result);});},Some(Action::Shutdown)=>break,None=>break},
            _=pending.join_next(),if !pending.is_empty()=>{}
        }
    }
    let backend = shared.backend.lock().unwrap().take();
    let mut closed = Ok(());
    let _ = stop_tx.send(true);
    let _ = listener_task.await;
    let _ = signal_task.await;
    invalidation_task.abort();
    let _ = invalidation_task.await;
    pending.abort_all();
    while pending.join_next().await.is_some() {}
    if let Some(Backend::Embedded { runtime, .. }) = backend {
        if let Err(error) = runtime.close().await {
            closed = Err(error);
        }
    }
    if let Some(task) = native_task {
        let _ = task.await;
    }
    let _ = std::fs::remove_file(shared.profile.join("launcher.sock"));
    let _ = std::fs::remove_file(shared.profile.join("endpoint.json"));
    let _ = completion.send(Some(closed));
}
async fn call_backend(shared: &Arc<Shared>, method: &str, params: Value) -> Result<Value, String> {
    if method.starts_with("packages.") {
        let (reply, receipt) = oneshot::channel();
        shared
            .actions
            .try_send(Action::Request {
                method: method.into(),
                params,
                reply,
            })
            .map_err(|_| "application management queue is full".to_string())?;
        return receipt
            .await
            .map_err(|_| "package operation outcome unknown".to_string())?;
    }
    if method == "ui.control" {
        let action = params
            .get("action")
            .filter(|v| v.is_object())
            .cloned()
            .ok_or("action object is required")?;
        let (reply, receipt) = oneshot::channel();
        shared
            .events
            .send(AppEvent::UiControl { action, reply })
            .await
            .map_err(|_| "UI disconnected".to_string())?;
        return receipt
            .await
            .map_err(|_| "UI action outcome unknown".to_string())?;
    }
    if method == "ui.screenshot" {
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("launcher.png");
        let stem = name
            .strip_suffix(".png")
            .ok_or("screenshot name must end in .png")?;
        if stem.is_empty()
            || stem.len() > 64
            || !stem
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("screenshot name must be a simple ASCII basename".into());
        }
        let directory = shared.profile.join("screenshots");
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let (reply, receipt) = oneshot::channel();
        shared
            .events
            .send(AppEvent::Screenshot {
                path: directory.join(name),
                reply,
            })
            .await
            .map_err(|_| "UI disconnected".to_string())?;
        return receipt
            .await
            .map_err(|_| "screenshot outcome unknown: UI disconnected".to_string())?;
    }
    if !shared.accepting.load(Ordering::SeqCst) {
        return Err("runtime changing; request not admitted".into());
    }
    if method == "launcher.query" {
        *shared.query.lock().unwrap() = Some(params.clone());
    }
    let backend = shared
        .backend
        .lock()
        .unwrap()
        .clone()
        .ok_or("plugin execution session disconnected")?;
    let session = backend.session().to_owned();
    let result = backend.request(method, params.clone()).await?;
    if method == "launcher.query" {
        let current = shared
            .query
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|v| v.get("revision"))
            .cloned();
        let active = shared
            .backend
            .lock()
            .unwrap()
            .as_ref()
            .map(|b| b.session() == session)
            .unwrap_or(false);
        if active
            && current.as_ref() == params.get("revision")
            && shared.lease.lock().unwrap().as_deref() == result["lease"].as_str()
        {
            let _ = shared.events.send(AppEvent::Query(result.clone())).await;
        }
    }
    Ok(result)
}
async fn native_request(
    shared: Arc<Shared>,
    session: &str,
    method: &str,
    params: Value,
    mut cancel: watch::Receiver<bool>,
) -> Result<Value, String> {
    if shared.session.lock().unwrap().as_deref() != Some(session) {
        return Err("stale execution session".into());
    }
    match method {
        "native.echo" => {
            let text = params["text"].as_str().ok_or("text is required")?;
            let delay = params["delayMs"].as_u64().unwrap_or(2).min(30_000);
            tokio::select! {_=tokio::time::sleep(Duration::from_millis(delay))=>Ok(json!({"text":text})),_=cancel.changed()=>Err("native echo cancelled before completion".into())}
        }
        "clipboard.write" => {
            let text = params["text"]
                .as_str()
                .ok_or("text is required")?
                .to_owned();
            let (reply, receipt) = oneshot::channel();
            shared
                .events
                .send(AppEvent::Clipboard { text, reply })
                .await
                .map_err(|_| "UI disconnected".to_string())?;
            receipt
                .await
                .map_err(|_| "clipboard outcome unknown: UI disconnected".to_string())?
        }
        "desktop.list" => Ok(
            json!({"actions":[{"id":"toggle-theme","title":"切换明暗主题","subtitle":"改变当前原生窗口主题"}]}),
        ),
        "desktop.execute" => {
            let id = params["id"].as_str().ok_or("id is required")?;
            if id != "toggle-theme" {
                return Err("unknown desktop action".into());
            }
            let (reply, receipt) = oneshot::channel();
            shared
                .events
                .send(AppEvent::Desktop {
                    id: id.into(),
                    reply,
                })
                .await
                .map_err(|_| "UI disconnected".to_string())?;
            receipt
                .await
                .map_err(|_| "desktop outcome unknown: UI disconnected".to_string())?
        }
        "storage.read" | "storage.write" => {
            let key = params["key"].as_str().ok_or("storage key is required")?;
            if !matches!(key, "config" | "state") {
                return Err("storage key must be config or state".into());
            }
            let path = shared.profile.join(format!("{key}.json"));
            if method == "storage.read" {
                let document = match std::fs::read_to_string(path) {
                    Ok(document) => Some(document),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                    Err(e) => return Err(e.to_string()),
                };
                Ok(json!({"document":document}))
            } else {
                let document = params["document"]
                    .as_str()
                    .ok_or("document must be a string")?;
                let mut temp =
                    tempfile::NamedTempFile::new_in(&shared.profile).map_err(|e| e.to_string())?;
                temp.write_all(document.as_bytes())
                    .map_err(|e| e.to_string())?;
                temp.as_file().sync_all().map_err(|e| e.to_string())?;
                temp.persist(path).map_err(|e| e.to_string())?;
                File::open(&shared.profile)
                    .and_then(|f| f.sync_all())
                    .map_err(|e| e.to_string())?;
                Ok(json!({"committed":true}))
            }
        }
        "host.attach" => {
            let lease = params["lease"]
                .as_str()
                .ok_or("lease is required")?
                .to_owned();
            *shared.lease.lock().unwrap() = Some(lease);
            *shared.contribution.lock().unwrap() = 0;
            shared
                .events
                .send(AppEvent::Connected {
                    session: session.into(),
                })
                .await
                .map_err(|_| "UI disconnected".to_string())?;
            Ok(json!({"accepted":true}))
        }
        "host.detach" => {
            let lease = params["lease"].as_str().ok_or("lease is required")?;
            if shared.lease.lock().unwrap().as_deref() == Some(lease) {
                *shared.lease.lock().unwrap() = None;
                let _ = shared
                    .events
                    .send(AppEvent::Disconnected {
                        message: "Host lease detached".into(),
                    })
                    .await;
            }
            Ok(json!({"accepted":true}))
        }
        "launcher.invalidate" => {
            let lease = params["lease"].as_str().ok_or("lease is required")?;
            if shared.lease.lock().unwrap().as_deref() != Some(lease) {
                return Err("stale Host lease".into());
            }
            if !params["contributionRevision"].is_u64() {
                return Err("contributionRevision must be unsigned integer".into());
            }
            let revision = params["contributionRevision"].as_u64().unwrap();
            let mut contribution = shared.contribution.lock().unwrap();
            if revision > *contribution {
                *contribution = revision;
                let _ = shared.invalidate.try_send(());
            }
            Ok(json!({"accepted":true}))
        }
        _ => Err(format!("native method not available: {method}")),
    }
}
async fn serve_peer(mut stream: UnixStream, shared: Arc<Shared>) -> Result<(), String> {
    if stream.peer_cred().map_err(|e| e.to_string())?.uid()
        != std::fs::metadata(&shared.profile)
            .map_err(|e| e.to_string())?
            .uid()
    {
        return Err("Unix peer must have the profile owner uid".into());
    }
    let hello = tokio::time::timeout(Duration::from_secs(5), protocol::read_frame(&mut stream))
        .await
        .map_err(|_| "handshake deadline exceeded")??
        .ok_or("empty handshake")?;
    let params = &hello["params"];
    let role = params["role"].as_str().unwrap_or("");
    if hello["method"] != "session.hello"
        || params["protocol"] != 1
        || params["instance"] != shared.instance
        || params["profile"] != shared.profile.to_string_lossy().as_ref()
        || params["token"] != shared.token
        || !matches!(role, "executor" | "cli")
        || (role == "executor" && !shared.development)
    {
        protocol::write_frame(
            &mut stream,
            &protocol::response(
                hello["id"].clone(),
                Err("handshake identity, role or credential mismatch".into()),
            ),
        )
        .await?;
        return Err("handshake rejected".into());
    }
    let session = random_id()?;
    let (tx, mut outgoing) = mpsc::channel(QUEUE_CAPACITY);
    let peer = Peer::new(tx, session.clone());
    if role == "executor" {
        let mut backend = shared.backend.lock().unwrap();
        if backend.is_some() {
            return Err("an executor is already active".into());
        }
        *backend = Some(Backend::Remote(peer.clone()));
        *shared.session.lock().unwrap() = Some(session.clone());
    }
    protocol::write_frame(&mut stream,&protocol::response(hello["id"].clone(),Ok(json!({"protocol":1,"session":session,"instance":shared.instance,"profile":shared.profile})))).await?;
    let (mut reader, mut writer) = stream.into_split();
    let writer_task = tokio::spawn(async move {
        while let Some(value) = outgoing.recv().await {
            protocol::write_frame(&mut writer, &value).await?;
        }
        Ok::<_, String>(())
    });
    let mut pending = tokio::task::JoinSet::new();
    let cancellations = Arc::new(Mutex::new(HashMap::<String, watch::Sender<bool>>::new()));
    let result = loop {
        while pending.try_join_next().is_some() {}
        match protocol::read_frame(&mut reader).await {
            Ok(Some(value)) => {
                if value.get("method").is_none() {
                    peer.settle(value);
                    continue;
                }
                if value["method"] == "$/cancelRequest" {
                    if let Some(cancel) = cancellations
                        .lock()
                        .unwrap()
                        .get(&value["params"]["id"].to_string())
                    {
                        let _ = cancel.send(true);
                    }
                    continue;
                }
                let Some(id) = value.get("id").cloned() else {
                    continue;
                };
                if pending.len() >= QUEUE_CAPACITY {
                    peer.send(protocol::response(
                        id,
                        Err("incoming request limit reached".into()),
                    ))
                    .await?;
                    continue;
                }
                let method = value["method"].as_str().unwrap().to_owned();
                let params = value.get("params").cloned().unwrap_or(json!({}));
                let shared = shared.clone();
                let peer = peer.clone();
                let is_executor = role == "executor";
                let (cancel, cancelled) = watch::channel(false);
                let key = id.to_string();
                cancellations.lock().unwrap().insert(key.clone(), cancel);
                let cancellations = cancellations.clone();
                pending.spawn(async move {
                    let result = if is_executor {
                        native_request(shared, &peer.session, &method, params, cancelled).await
                    } else if method.starts_with("host.")
                        || method.starts_with("launcher.")
                        || method == "command.execute"
                        || method == "cli.execute"
                        || method == "ui.screenshot"
                        || method == "ui.control"
                        || method.starts_with("packages.")
                    {
                        call_backend(&shared, &method, params).await
                    } else {
                        Err("method unavailable to CLI role".into())
                    };
                    cancellations.lock().unwrap().remove(&key);
                    let _ = peer.send(protocol::response(id, result)).await;
                });
            }
            Ok(None) => break Ok(()),
            Err(error) => break Err(error),
        }
    };
    peer.disconnect();
    pending.abort_all();
    while pending.join_next().await.is_some() {}
    if role == "executor" {
        let active = shared
            .backend
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|backend| backend.session() == session);
        if active {
            *shared.backend.lock().unwrap() = None;
            *shared.session.lock().unwrap() = None;
            *shared.lease.lock().unwrap() = None;
            let _ = shared
                .events
                .send(AppEvent::Disconnected {
                    message: "execution session disconnected; pending operation outcomes unknown"
                        .into(),
                })
                .await;
        }
    }
    writer_task.abort();
    let _ = writer_task.await;
    result
}
pub async fn cli(profile: &Path, method: &str, params: Value) -> Result<Value, String> {
    let identity: Value = serde_json::from_slice(
        &std::fs::read(profile.join("endpoint.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let mut socket = UnixStream::connect(identity["socket"].as_str().ok_or("missing socket")?)
        .await
        .map_err(|e| e.to_string())?;
    protocol::write_frame(&mut socket,&json!({"jsonrpc":"2.0","id":"cli:hello","method":"session.hello","params":{"protocol":1,"role":"cli","instance":identity["instance"],"profile":identity["profile"],"token":identity["token"]}})).await?;
    protocol::result(
        protocol::read_frame(&mut socket)
            .await?
            .ok_or("missing handshake reply")?,
    )?;
    protocol::write_frame(
        &mut socket,
        &json!({"jsonrpc":"2.0","id":"cli:request","method":method,"params":params}),
    )
    .await?;
    protocol::result(
        protocol::read_frame(&mut socket)
            .await?
            .ok_or("CLI disconnected before receipt; outcome unknown")?,
    )
}

async fn start_runtime(
    shared: Arc<Shared>,
    root: PathBuf,
    entry: &str,
) -> Result<tokio::task::JoinHandle<()>, String> {
    let (runtime, mut requests) = Embedded::start(root, entry).await?;
    let session = random_id()?;
    let runtime = Arc::new(runtime);
    *shared.session.lock().unwrap() = Some(session.clone());
    let backend = Backend::Embedded {
        runtime: runtime.clone(),
        session: session.clone(),
    };
    *shared.backend.lock().unwrap() = Some(backend.clone());
    let native_shared = shared.clone();
    let task = tokio::spawn(async move {
        let mut pending = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                request=requests.recv()=>{let Some(request)=request else{break};if pending.len()>=QUEUE_CAPACITY{let _=request.reply.send(Err("native request limit reached".into()));continue;}let shared=native_shared.clone();let session=session.clone();pending.spawn(async move{let parsed=serde_json::from_str::<Value>(&request.json).map_err(|e|e.to_string());let response=match parsed{Ok(value)=>{let id=value["id"].clone();let(_cancel_sender,cancel)=watch::channel(false);protocol::response(id,native_request(shared,&session,value["method"].as_str().unwrap_or(""),value.get("params").cloned().unwrap_or(json!({})),cancel).await).to_string()},Err(error)=>{let _=request.reply.send(Err(error));return;}};let _=request.reply.send(Ok(response));});},
                _=pending.join_next(),if !pending.is_empty()=>{}
            }
        }
        while pending.join_next().await.is_some() {}
    });
    if let Err(error) = backend.request("host.start", json!({})).await {
        let closed = runtime.close().await;
        *shared.backend.lock().unwrap() = None;
        *shared.session.lock().unwrap() = None;
        let _ = task.await;
        return Err(match closed {
            Ok(()) => error,
            Err(cleanup) => format!("{error}; cleanup failed: {cleanup}"),
        });
    }
    Ok(task)
}
async fn package_request(
    shared: &Arc<Shared>,
    method: &str,
    params: Value,
    native_task: &mut Option<tokio::task::JoinHandle<()>>,
) -> Result<Value, String> {
    if method == "packages.status" {
        return Ok(if shared.development {
            json!({"mode":"development","installedRevision":null,"activeRevision":null,"previousRevision":null,"pending":false,"packages":[],"error":null})
        } else {
            shared.packages.lock().unwrap().as_ref().map(PackageStore::status).unwrap_or_else(||json!({"mode":"embedded","installedRevision":null,"activeRevision":null,"previousRevision":null,"pending":false,"packages":[],"error":shared.package_error.lock().unwrap().clone()}))
        });
    }
    if shared.development {
        return Err(
            "package changes unavailable in development; workspace definitions belong to Vite"
                .into(),
        );
    }
    if method != "packages.apply" {
        let mut store = shared.packages.lock().unwrap();
        let store = store
            .as_mut()
            .ok_or("package store unavailable; inspect the retained error")?;
        return match method {
            "packages.install" => store.install(Path::new(
                params["path"]
                    .as_str()
                    .ok_or("absolute package path is required")?,
            )),
            "packages.remove" => {
                store.remove(params["name"].as_str().ok_or("package name is required")?)
            }
            "packages.selectPrevious" => store.select_previous(),
            _ => Err("unknown package management method".into()),
        };
    }
    // All compatibility and integrity checks happen before closing the active Host.
    let root = shared
        .packages
        .lock()
        .unwrap()
        .as_ref()
        .ok_or("package store unavailable")?
        .prepare_active()?;
    shared.accepting.store(false, Ordering::SeqCst);
    let old = shared.backend.lock().unwrap().take();
    let close = if let Some(Backend::Embedded { runtime, .. }) = old {
        runtime.close().await
    } else {
        Ok(())
    };
    if let Some(task) = native_task.take() {
        let _ = task.await;
    }
    *shared.lease.lock().unwrap() = None;
    *shared.session.lock().unwrap() = None;
    let started = match close {
        Ok(()) => start_runtime(shared.clone(), root, "embedded.mjs").await,
        Err(error) => Err(format!("previous runtime cleanup incomplete: {error}")),
    };
    let result = match started {
        Ok(task) => {
            *native_task = Some(task);
            shared
                .packages
                .lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .activated();
            *shared.package_error.lock().unwrap() = None;
            json!({"applied":true,"session":shared.session.lock().unwrap().clone(),"status":shared.packages.lock().unwrap().as_ref().unwrap().status()})
        }
        Err(error) => {
            shared
                .packages
                .lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .failed(error.clone());
            *shared.package_error.lock().unwrap() = Some(error.clone());
            let _ = shared
                .events
                .send(AppEvent::Disconnected {
                    message: format!("runtime unavailable: {error}"),
                })
                .await;
            json!({"applied":false,"session":null,"status":shared.packages.lock().unwrap().as_ref().unwrap().status(),"error":error})
        }
    };
    shared.accepting.store(true, Ordering::SeqCst);
    let _ = shared.invalidate.try_send(());
    Ok(result)
}
