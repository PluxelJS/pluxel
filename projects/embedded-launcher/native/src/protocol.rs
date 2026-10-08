//! Local JSON-RPC transport. Every queue and frame has an admission bound.
use crate::embedded::{MAX_FRAME, QUEUE_CAPACITY};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{mpsc, oneshot},
};

pub async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Option<Value>, String> {
    let mut header = [0u8; 4];
    if reader
        .read(&mut header[..1])
        .await
        .map_err(|e| e.to_string())?
        == 0
    {
        return Ok(None);
    }
    reader
        .read_exact(&mut header[1..])
        .await
        .map_err(|e| format!("truncated frame header: {e}"))?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err("frame length must be 1..=1048576".into());
    }
    let mut bytes = vec![0; length];
    reader
        .read_exact(&mut bytes)
        .await
        .map_err(|e| e.to_string())?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("invalid JSON frame: {e}"))?;
    validate(&value)?;
    Ok(Some(value))
}
pub async fn write_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    value: &Value,
) -> Result<(), String> {
    validate(value)?;
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_FRAME {
        return Err("frame exceeds 1 MiB".into());
    }
    writer
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .await
        .map_err(|e| e.to_string())?;
    writer.write_all(&bytes).await.map_err(|e| e.to_string())?;
    writer.flush().await.map_err(|e| e.to_string())
}
pub fn validate(value: &Value) -> Result<(), String> {
    if !value.is_object() || value["jsonrpc"] != "2.0" {
        return Err("expected JSON-RPC 2.0 object".into());
    }
    if let Some(id) = value.get("id") {
        if !(id.is_string() || id.as_u64().is_some()) {
            return Err("id must be a string or unsigned integer".into());
        }
    }
    if let Some(method) = value.get("method") {
        if method.as_str().is_none_or(str::is_empty)
            || value.get("result").is_some()
            || value.get("error").is_some()
        {
            return Err("invalid request envelope".into());
        }
        if let Some(params) = value.get("params") {
            if !params.is_object() {
                return Err("params must be an object".into());
            }
        }
    } else if value.get("id").is_none()
        || value.get("result").is_some() == value.get("error").is_some()
    {
        return Err("invalid response envelope".into());
    }
    Ok(())
}
pub fn response(id: Value, result: Result<Value, String>) -> Value {
    match result {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
        Err(message) => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":message}}),
    }
}
pub fn result(envelope: Value) -> Result<Value, String> {
    if let Some(error) = envelope.get("error") {
        return Err(format!(
            "RPC {}: {}",
            error["code"],
            error["message"].as_str().unwrap_or("unknown error")
        ));
    }
    envelope
        .get("result")
        .cloned()
        .ok_or("missing response result".into())
}
type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;
#[derive(Clone)]
pub struct Peer {
    tx: mpsc::Sender<Value>,
    pending: Pending,
    next: Arc<AtomicU64>,
    pub session: String,
}
impl Peer {
    pub fn new(tx: mpsc::Sender<Value>, session: String) -> Self {
        Self {
            tx,
            pending: Default::default(),
            next: Arc::new(AtomicU64::new(1)),
            session,
        }
    }
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = format!("r:{}", self.next.fetch_add(1, Ordering::Relaxed));
        let (reply, receipt) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            if pending.len() >= QUEUE_CAPACITY {
                return Err("remote in-flight request limit reached".into());
            }
            pending.insert(json!(id).to_string(), reply);
        }
        if self
            .tx
            .try_send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .is_err()
        {
            self.pending.lock().unwrap().remove(&json!(id).to_string());
            return Err("remote send queue full or disconnected; request not admitted".into());
        }
        receipt
            .await
            .map_err(|_| "remote disconnected; operation outcome unknown".to_string())?
    }
    pub fn settle(&self, value: Value) {
        if let Some(id) = value.get("id") {
            let reply = self.pending.lock().unwrap().remove(&id.to_string());
            if let Some(reply) = reply {
                let _ = reply.send(result(value));
            }
        }
    }
    pub fn disconnect(&self) {
        for (_, reply) in self.pending.lock().unwrap().drain() {
            let _ = reply.send(Err(
                "execution session disconnected; operation outcome unknown; no replay".into(),
            ));
        }
    }
    pub async fn send(&self, value: Value) -> Result<(), String> {
        self.tx
            .send(value)
            .await
            .map_err(|_| "connection closed".into())
    }
}
