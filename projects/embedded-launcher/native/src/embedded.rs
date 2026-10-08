//! LLRT stays on one dedicated current-thread Tokio executor. Only bounded JSON
//! strings and oneshot receipts cross the thread boundary.
use llrt_core::{
    AsyncContext, AsyncRuntime, CatchResultExt, Ctx, Error, Exception, Function, Module, Object,
    Promise, Result as JsResult,
    loader::{BuiltinResolver, ImportAttributes, Loader, ModuleLoader, Resolver},
    module::{Declarations, Exports, ModuleDef},
    prelude::{Async, Func},
};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread::JoinHandle,
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

pub const MAX_FRAME: usize = 1024 * 1024;
pub const QUEUE_CAPACITY: usize = 64;
static LIVE_RUNTIMES: AtomicUsize = AtomicUsize::new(0);
type Diagnostics = Arc<Mutex<VecDeque<String>>>;
fn record(diagnostics: &Diagnostics, mut message: String) {
    if message.len() > 4096 {
        let mut end = 4096;
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        message.truncate(end);
    }
    let mut log = diagnostics.lock().unwrap();
    if log.len() == 128 {
        log.pop_front();
    }
    log.push_back(message);
}
static INIT: OnceLock<Result<(), String>> = OnceLock::new();
pub fn live_runtimes() -> usize {
    LIVE_RUNTIMES.load(Ordering::SeqCst)
}

pub struct NativeRequest {
    pub json: String,
    pub reply: oneshot::Sender<Result<String, String>>,
}
enum Command {
    Dispatch(String, oneshot::Sender<Result<String, String>>),
    Close(oneshot::Sender<Result<(), String>>),
}
pub struct Embedded {
    tx: mpsc::Sender<Command>,
    thread: Mutex<Option<JoinHandle<Result<(), String>>>>,
    interrupt: Arc<AtomicBool>,
    diagnostics: Diagnostics,
}

impl Embedded {
    pub async fn start(
        root: impl AsRef<Path>,
        entry: &str,
    ) -> Result<(Self, mpsc::Receiver<NativeRequest>), String> {
        let root = root.as_ref().canonicalize().map_err(|e| e.to_string())?;
        let entry = root.join(entry).canonicalize().map_err(|e| e.to_string())?;
        if !entry.starts_with(&root) {
            return Err("entry outside active root".into());
        }
        let (tx, rx) = mpsc::channel(QUEUE_CAPACITY);
        let (native_tx, native_rx) = mpsc::channel(QUEUE_CAPACITY);
        let (ready_tx, ready_rx) = oneshot::channel();
        let interrupt = Arc::new(AtomicBool::new(false));
        let thread_interrupt = interrupt.clone();
        let diagnostics = Diagnostics::default();
        let thread_diagnostics = diagnostics.clone();
        let thread = std::thread::Builder::new()
            .name("launcher-llrt".into())
            .spawn(move || {
                let executor = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|e| e.to_string())?;
                executor.block_on(tokio::task::LocalSet::new().run_until(run(
                    root,
                    entry,
                    rx,
                    native_tx,
                    ready_tx,
                    thread_interrupt,
                    thread_diagnostics,
                )))
            })
            .map_err(|e| e.to_string())?;
        match ready_rx
            .await
            .map_err(|_| "LLRT initialization worker stopped".to_string())?
        {
            Ok(()) => Ok((
                Self {
                    tx,
                    thread: Mutex::new(Some(thread)),
                    interrupt,
                    diagnostics,
                },
                native_rx,
            )),
            Err(error) => {
                let _ = thread.join();
                Err(error)
            }
        }
    }
    /// Drain up to 128 bounded runtime diagnostics for application projection.
    pub fn take_diagnostics(&self) -> Vec<String> {
        self.diagnostics.lock().unwrap().drain(..).collect()
    }
    /// Interrupt the currently executing CPU-bound JS frame; this does not undo effects.
    pub fn interrupt_execution(&self) {
        self.interrupt.store(true, Ordering::SeqCst);
    }
    pub async fn dispatch(&self, json: String) -> Result<String, String> {
        validate_json(&json)?;
        let (tx, rx) = oneshot::channel();
        self.tx
            .try_send(Command::Dispatch(json, tx))
            .map_err(|e| format!("runtime admission: {e}"))?;
        rx.await
            .map_err(|_| "runtime ended before receipt; outcome unknown".to_string())?
    }
    pub async fn close(&self) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::Close(tx))
            .await
            .map_err(|_| "runtime already stopped".to_string())?;
        let receipt = rx
            .await
            .map_err(|_| "runtime stopped during close".to_string())?;
        let thread = self.thread.lock().unwrap().take();
        if let Some(thread) = thread {
            thread
                .join()
                .map_err(|_| "runtime thread panicked".to_string())??;
        }
        receipt
    }
}
impl Drop for Embedded {
    fn drop(&mut self) {
        self.interrupt.store(true, Ordering::SeqCst);
    }
}
fn validate_json(json: &str) -> Result<(), String> {
    if json.len() > MAX_FRAME {
        return Err("JSON frame exceeds 1 MiB".into());
    }
    serde_json::from_str::<serde_json::Value>(json).map_err(|e| format!("invalid JSON: {e}"))?;
    Ok(())
}

struct BridgeSender(mpsc::Sender<NativeRequest>, Diagnostics);
// Contains no JS references; its lifetime is independent of the context.
unsafe impl<'js> llrt_core::JsLifetime<'js> for BridgeSender {
    type Changed<'to> = BridgeSender;
}
struct Bridge;
impl ModuleDef for Bridge {
    fn declare(d: &Declarations) -> JsResult<()> {
        d.declare("request")?;
        Ok(())
    }
    fn evaluate<'js>(ctx: &Ctx<'js>, exports: &Exports<'js>) -> JsResult<()> {
        let sender = ctx
            .userdata::<BridgeSender>()
            .expect("bridge sender installed")
            .0
            .clone();
        exports.export(
            "request",
            Func::from(Async(move |ctx: Ctx<'js>, json: String| {
                let sender = sender.clone();
                async move {
                    validate_json(&json).map_err(|e| Exception::throw_type(&ctx, &e))?;
                    let (reply, receipt) = oneshot::channel();
                    sender
                        .try_send(NativeRequest { json, reply })
                        .map_err(|e| {
                            Exception::throw_message(&ctx, &format!("native admission: {e}"))
                        })?;
                    let json = receipt
                        .await
                        .map_err(|_| {
                            Exception::throw_message(&ctx, "native disconnected; outcome unknown")
                        })?
                        .map_err(|e| Exception::throw_message(&ctx, &e))?;
                    validate_json(&json).map_err(|e| Exception::throw_type(&ctx, &e))?;
                    Ok::<_, Error>(json)
                }
            })),
        )?;
        Ok(())
    }
}

#[derive(Clone)]
struct ActiveFiles(PathBuf);
impl Resolver for ActiveFiles {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _attrs: Option<ImportAttributes<'js>>,
    ) -> JsResult<String> {
        let path = if Path::new(name).is_absolute() {
            PathBuf::from(name)
        } else if name.starts_with("./") || name.starts_with("../") {
            Path::new(base).parent().unwrap_or(&self.0).join(name)
        } else {
            return Err(Error::new_resolving(base, name));
        };
        let path = path
            .canonicalize()
            .map_err(|_| Error::new_resolving(base, name))?;
        if !path.starts_with(&self.0)
            || !matches!(
                path.extension().and_then(|s| s.to_str()),
                Some("js" | "mjs")
            )
        {
            return Err(Error::new_resolving(base, name));
        }
        Ok(path.to_string_lossy().into_owned())
    }
}
impl Loader for ActiveFiles {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _attrs: Option<ImportAttributes<'js>>,
    ) -> JsResult<Module<'js>> {
        let path = Path::new(name)
            .canonicalize()
            .map_err(|_| Error::new_loading(name))?;
        if !path.starts_with(&self.0) {
            return Err(Error::new_loading(name));
        }
        let source = std::fs::read(&path).map_err(|_| Error::new_loading(name))?;
        Module::declare(ctx.clone(), name, source)
    }
}

async fn run(
    root: PathBuf,
    entry: PathBuf,
    mut incoming: mpsc::Receiver<Command>,
    native: mpsc::Sender<NativeRequest>,
    ready: oneshot::Sender<Result<(), String>>,
    interrupt: Arc<AtomicBool>,
    diagnostics: Diagnostics,
) -> Result<(), String> {
    let initialized = INIT.get_or_init(|| {
        llrt_core::init_embedded().map_err(|e| e.to_string())?;
        llrt_core::libs::context::set_spawn_error_handler(|ctx, error| {
            if let Some(state) = ctx.userdata::<BridgeSender>() {
                record(&state.1, format!("asynchronous callback error: {error:?}"));
            }
        });
        Ok(())
    });
    if let Err(error) = initialized {
        let _ = ready.send(Err(error.clone()));
        return Err(error.clone());
    }
    let runtime = AsyncRuntime::new().map_err(|e| e.to_string())?;
    runtime.set_memory_limit(256 * 1024 * 1024).await;
    runtime.set_max_stack_size(1024 * 1024).await;
    runtime
        .set_interrupt_handler(Some(Box::new(move || {
            interrupt.swap(false, Ordering::SeqCst)
        })))
        .await;
    let rejection_diagnostics = diagnostics.clone();
    runtime
        .set_host_promise_rejection_tracker(Some(Box::new(
            move |_ctx, _promise, reason, handled| {
                // QuickJS calls this before a caller may attach its handler. Do not label
                // every first rejection as permanently unhandled.
                if !handled {
                    record(
                        &rejection_diagnostics,
                        format!("promise rejected before handler attachment: {reason:?}"),
                    );
                }
            },
        )))
        .await;
    let (resolver, loader, globals) = llrt_core::vm::VmOptions::default().module_builder.build();
    runtime
        .set_loader(
            (
                BuiltinResolver::default().with_module("launcher:bridge"),
                resolver,
                llrt_core::modules::embedded::resolver::EmbeddedResolver,
                ActiveFiles(root.clone()),
            ),
            (
                ModuleLoader::default().with_module("launcher:bridge", Bridge),
                loader,
                llrt_core::modules::embedded::loader::EmbeddedLoader,
                ActiveFiles(root),
            ),
        )
        .await;
    let context = AsyncContext::full(&runtime)
        .await
        .map_err(|e| e.to_string())?;
    let init = context
        .with(|ctx| {
            use llrt_core::libs::utils::primordials::{BasePrimordials, Primordial};
            (|| {
                ctx.store_userdata(BridgeSender(native, diagnostics))
                    .map_err(|_| Error::Unknown)?;
                BasePrimordials::init(&ctx)?;
                globals.attach(&ctx)?;
                llrt_core::vm::init_embedded_globals(&ctx)?;
                Ok::<_, Error>(())
            })()
            .catch(&ctx)
            .map_err(|e| format!("LLRT globals: {e:?}"))
        })
        .await;
    if let Err(error) = init {
        let _ = ready.send(Err(error.clone()));
        return Err(error);
    }
    let imported = context
        .async_with(async |ctx| {
            let result: JsResult<()> = async {
                let exports: Object =
                    Module::import(&ctx, entry.to_string_lossy().as_bytes().to_vec())?
                        .into_future()
                        .await?;
                ctx.globals().set("__launcher_exports", exports)?;
                Ok(())
            }
            .await;
            result.catch(&ctx).map_err(|e| format!("LLRT entry: {e:?}"))
        })
        .await;
    if let Err(error) = imported {
        context
            .with(|ctx| llrt_core::modules::timers::cancel_runtime_timers(&ctx))
            .await;
        runtime.idle().await;
        context
            .with(|ctx| llrt_core::modules::timers::dispose_runtime_timers(&ctx))
            .await;
        let _ = ready.send(Err(error.clone()));
        return Err(error);
    }
    LIVE_RUNTIMES.fetch_add(1, Ordering::SeqCst);
    struct Live;
    impl Drop for Live {
        fn drop(&mut self) {
            LIVE_RUNTIMES.fetch_sub(1, Ordering::SeqCst);
        }
    }
    let _live = Live;
    let _ = ready.send(Ok(()));
    let mut pending = tokio::task::JoinSet::new();
    loop {
        let command = tokio::select! { command = incoming.recv() => command, _ = runtime.drive() => continue, _ = pending.join_next(), if !pending.is_empty() => continue };
        match command {
            Some(Command::Dispatch(json, reply)) => {
                if pending.len() >= QUEUE_CAPACITY {
                    let _ = reply.send(Err("runtime in-flight limit reached".into()));
                    continue;
                }
                let context = context.clone();
                pending.spawn_local(async move {
                    let result = context
                        .async_with(async |ctx| {
                            let result: JsResult<String> = async {
                                let exports: Object = ctx.globals().get("__launcher_exports")?;
                                let dispatch: Function = exports.get("dispatch")?;
                                let promise: Promise = dispatch.call((json,))?;
                                promise.into_future::<String>().await
                            }
                            .await;
                            result
                                .catch(&ctx)
                                .map_err(|e| format!("LLRT dispatch: {e:?}"))
                        })
                        .await
                        .and_then(|json| {
                            validate_json(&json)?;
                            Ok(json)
                        });
                    let _ = reply.send(result);
                });
            }
            command => {
                let result = context
                    .async_with(async |ctx| {
                        let result: JsResult<()> = async {
                            let exports: Object = ctx.globals().get("__launcher_exports")?;
                            let close: Function = exports.get("close")?;
                            let promise: Promise = close.call(())?;
                            promise.into_future::<()>().await?;
                            ctx.globals().remove("__launcher_exports")?;
                            Ok(())
                        }
                        .await;
                        result.catch(&ctx).map_err(|e| format!("LLRT close: {e:?}"))
                    })
                    .await;
                let settled = tokio::time::timeout(Duration::from_secs(5), async {
                    while pending.join_next().await.is_some() {}
                })
                .await;
                if settled.is_err() {
                    pending.abort_all();
                    while pending.join_next().await.is_some() {}
                }
                context
                    .with(|ctx| llrt_core::modules::timers::cancel_runtime_timers(&ctx))
                    .await;
                let drained = tokio::time::timeout(Duration::from_secs(5), runtime.idle()).await;
                let result = result
                    .and_then(|_| settled.map_err(|_| "LLRT requests did not drain".to_string()))
                    .and_then(|_| {
                        drained.map_err(|_| "LLRT drain timed out; cleanup incomplete".into())
                    });
                if let Some(Command::Close(reply)) = command {
                    let _ = reply.send(result.clone());
                }
                context
                    .with(|ctx| llrt_core::modules::timers::dispose_runtime_timers(&ctx))
                    .await;
                drop(context);
                runtime.run_gc().await;
                drop(runtime);
                return result;
            }
        }
    }
}
