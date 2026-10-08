//! Run the browser-built npm fixture inside the actual embedded LLRT runtime.
//! cargo run --manifest-path projects/embedded-launcher/native/Cargo.toml --bin compatibility-check -- projects/embedded-launcher/dist
use embedded_launcher::embedded::{Embedded, live_runtimes};
use serde_json::{Value, json};
use std::{collections::BTreeMap, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
    task::JoinSet,
};

const LIMIT: usize = 1024 * 1024;
const EXPECTED: [&str; 14] = [
    "zod + yaml + semver",
    "noble AES-GCM + SHA256",
    "jose HS256 JWT sign/verify",
    "jose A256GCM JWE encrypt/decrypt",
    "wretch JSON POST",
    "wretch multipart Blob upload",
    "axios browser default adapter JSON POST",
    "fetch Blob multipart UTF-8 upload",
    "fetch Blob multipart binary upload",
    "fetch URL object",
    "fetch abort reason identity",
    "Response.clone simultaneous body reads",
    "fetch does not inject Origin",
    "Symbol.dispose + Symbol.asyncDispose",
];

async fn read_more(stream: &mut TcpStream, bytes: &mut Vec<u8>) -> Result<(), String> {
    let mut buffer = [0; 8192];
    let count = stream.read(&mut buffer).await.map_err(|e| e.to_string())?;
    if count == 0 {
        return Err("echo: incomplete HTTP request".into());
    }
    if bytes.len() + count > LIMIT {
        return Err("echo: request exceeds 1 MiB".into());
    }
    bytes.extend_from_slice(&buffer[..count]);
    Ok(())
}

async fn echo(mut stream: TcpStream) -> Result<bool, String> {
    let mut bytes = Vec::new();
    // An aborted Fetch can establish TCP then close without sending an HTTP request.
    // Count complete requests, not transport connections; partial requests still fail.
    let mut first = [0; 8192];
    let count = stream.read(&mut first).await.map_err(|e| e.to_string())?;
    if count == 0 {
        return Ok(false);
    }
    bytes.extend_from_slice(&first[..count]);
    let boundary = loop {
        if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            break index + 4;
        }
        if bytes.len() > 32768 {
            return Err("echo: headers exceed 32 KiB".into());
        }
        read_more(&mut stream, &mut bytes).await?;
    };
    let head = std::str::from_utf8(&bytes[..boundary]).map_err(|e| e.to_string())?;
    let mut lines = head.split("\r\n");
    let request = lines.next().ok_or("echo: missing request line")?;
    if !request.starts_with("GET /echo ") && !request.starts_with("POST /echo ") {
        return Err(format!("echo: unexpected request {request}"));
    }
    let mut headers = BTreeMap::<String, String>::new();
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or("echo: malformed header")?;
        let name = name.to_ascii_lowercase();
        if headers
            .insert(name.clone(), value.trim().to_owned())
            .is_some()
        {
            return Err(format!("echo: duplicate header {name}"));
        }
    }
    let body = if let Some(encoding) = headers.get("transfer-encoding") {
        if !encoding.eq_ignore_ascii_case("chunked") || headers.contains_key("content-length") {
            return Err("echo: unsupported or ambiguous body framing".into());
        }
        let mut cursor = boundary;
        let mut body = Vec::new();
        loop {
            let end = loop {
                if let Some(index) = bytes[cursor..].windows(2).position(|part| part == b"\r\n") {
                    break cursor + index;
                }
                read_more(&mut stream, &mut bytes).await?;
            };
            let line = std::str::from_utf8(&bytes[cursor..end]).map_err(|e| e.to_string())?;
            let size = usize::from_str_radix(line.split(';').next().unwrap(), 16)
                .map_err(|e| format!("echo: invalid chunk length: {e}"))?;
            cursor = end + 2;
            if size > LIMIT || body.len() + size > LIMIT {
                return Err("echo: chunk body exceeds 1 MiB".into());
            }
            while bytes.len() < cursor + size + 2 {
                read_more(&mut stream, &mut bytes).await?;
            }
            if bytes[cursor + size..cursor + size + 2] != *b"\r\n" {
                return Err("echo: invalid chunk delimiter or unsupported trailers".into());
            }
            if size == 0 {
                break;
            }
            body.extend_from_slice(&bytes[cursor..cursor + size]);
            cursor += size + 2;
        }
        body
    } else {
        let length = headers
            .get("content-length")
            .map(|value| value.parse::<usize>())
            .transpose()
            .map_err(|e| e.to_string())?
            .unwrap_or(0);
        if length > LIMIT - boundary {
            return Err("echo: body exceeds 1 MiB".into());
        }
        while bytes.len() < boundary + length {
            read_more(&mut stream, &mut bytes).await?;
        }
        bytes[boundary..boundary + length].to_vec()
    };
    let response = json!({
        "type": headers.get("content-type").map(String::as_str).unwrap_or(""),
        "body": String::from_utf8_lossy(&body),
        "bodyBytes": body,
        "headers": headers,
    })
    .to_string();
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        response.len()
    );
    stream
        .write_all(head.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stream.shutdown().await.map_err(|e| e.to_string())?;
    Ok(true)
}

async fn serve(listener: TcpListener, mut stop: oneshot::Receiver<()>) -> Result<usize, String> {
    let mut requests = JoinSet::new();
    let mut count = 0;
    let mut connections = 0;
    let mut failures = Vec::new();
    loop {
        tokio::select! {
            _ = &mut stop => break,
            accepted = listener.accept() => {
                let (stream, _) = accepted.map_err(|e| e.to_string())?;
                connections += 1;
                if connections > 64 { return Err("echo: excessive connections".into()); }
                requests.spawn(async move {
                    tokio::time::timeout(Duration::from_secs(10), echo(stream)).await
                        .map_err(|_| "echo request deadline".to_owned())?
                });
            }
            Some(result) = requests.join_next(), if !requests.is_empty() => {
                match result { Ok(Ok(served)) => count += usize::from(served), Ok(Err(error)) => failures.push(error), Err(error) => failures.push(error.to_string()) }
            }
        }
    }
    while let Some(result) = requests.join_next().await {
        match result {
            Ok(Ok(served)) => count += usize::from(served),
            Ok(Err(error)) => failures.push(error),
            Err(error) => failures.push(error.to_string()),
        }
    }
    if failures.is_empty() {
        Ok(count)
    } else {
        Err(failures.join("; "))
    }
}

async fn exercise(root: &str, url: &str, selected: Option<&str>) -> Result<Value, String> {
    eprintln!("{}", json!({"phase":"runtime-start"}));
    let (runtime, mut native) = Embedded::start(root, "compatibility.mjs").await?;
    eprintln!("{}", json!({"phase":"dispatch"}));
    let native_task = tokio::spawn(async move {
        let mut count = 0;
        while let Some(call) = native.recv().await {
            count += 1;
            let _ = call.reply.send(Err(
                "compatibility fixture must use runtime APIs directly".into()
            ));
        }
        count
    });
    let mut params = json!({"echoUrl":url});
    if let Some(case) = selected {
        params["case"] = json!(case);
    }
    let response = tokio::time::timeout(Duration::from_secs(45), runtime.dispatch(json!({
        "jsonrpc":"2.0", "id":"embedded-compatibility", "method":"compatibility.run", "params":params
    }).to_string())).await.map_err(|_| "compatibility dispatch deadline exceeded".to_owned()).and_then(|value| value);
    eprintln!(
        "{}",
        json!({"phase":"dispatch-settled", "response":response})
    );
    let diagnostics = runtime.take_diagnostics();
    let closed = runtime.close().await;
    let native_count = native_task.await.map_err(|e| e.to_string())?;
    closed?;
    if live_runtimes() != 0 || native_count != 0 {
        return Err(format!(
            "cleanup/native boundary: runtimes={}, bridge calls={native_count}",
            live_runtimes()
        ));
    }
    if !diagnostics.is_empty() {
        return Err(format!("runtime diagnostics: {diagnostics:?}"));
    }
    let response: Value = serde_json::from_str(&response?).map_err(|e| e.to_string())?;
    let cases = response["result"]["cases"]
        .as_array()
        .ok_or_else(|| format!("missing cases: {response}"))?;
    let expected: Vec<_> = EXPECTED
        .into_iter()
        .filter(|name| selected.is_none_or(|selected| selected == *name))
        .collect();
    if response["jsonrpc"] != "2.0"
        || response["id"] != "embedded-compatibility"
        || response.get("error").is_some()
        || response["result"]["ok"] != true
        || cases.len() != expected.len()
        || cases
            .iter()
            .zip(expected)
            .any(|(case, name)| case["name"] != name || case["ok"] != true)
    {
        return Err(format!("embedded compatibility failed: {response}"));
    }
    Ok(response)
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), String> {
    let root = std::env::args()
        .nth(1)
        .unwrap_or_else(|| format!("{}/../dist", env!("CARGO_MANIFEST_DIR")));
    let selected = std::env::args().nth(2);
    if selected
        .as_deref()
        .is_some_and(|name| !EXPECTED.contains(&name))
    {
        return Err("second argument must be an exact compatibility case name".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let url = format!(
        "http://{}/echo",
        listener.local_addr().map_err(|e| e.to_string())?
    );
    let (stop, stopped) = oneshot::channel();
    let server = tokio::spawn(serve(listener, stopped));
    let cycles = if selected.is_some() { 1 } else { 3 };
    let result = async {
        let mut responses = Vec::new();
        for cycle in 0..cycles {
            eprintln!("{}", json!({"cycle":cycle}));
            responses.push(exercise(&root, &url, selected.as_deref()).await?);
        }
        Ok::<_, String>(responses)
    }
    .await;
    let _ = stop.send(());
    let served = server.await.map_err(|e| e.to_string())?;
    let responses = result?;
    let served = served?;
    if selected.is_none() && served != 8 * cycles {
        return Err(format!(
            "expected {} real HTTP requests, observed {served}",
            8 * cycles
        ));
    }
    println!(
        "{}",
        json!({"runtime":"embedded-llrt", "scope":if selected.is_some(){"single-case-diagnostic"}else{"full-compatibility"}, "cycles":cycles, "responses":responses,"httpRequests":served,"liveRuntimesAfterClose":live_runtimes()})
    );
    Ok(())
}
