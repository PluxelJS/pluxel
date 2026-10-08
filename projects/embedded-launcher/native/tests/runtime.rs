use embedded_launcher::embedded::{Embedded, live_runtimes};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
fn fixtures() -> String {
    format!("{}/tests/fixtures", env!("CARGO_MANIFEST_DIR"))
}
fn request(method: &str, params: Value) -> String {
    json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}).to_string()
}
#[tokio::test(flavor = "current_thread")]
async fn actual_llrt_compatibility_and_lifecycle() {
    let bad = Embedded::start(fixtures(), "throw.mjs").await;
    assert!(
        bad.err()
            .unwrap()
            .contains("expected entry initialization failure")
    );
    for cycle in 0..5 {
        let (runtime, mut native) = Embedded::start(fixtures(), "runtime.mjs").await.unwrap();
        assert_eq!(live_runtimes(), 1);
        let (release, receipt) = tokio::sync::oneshot::channel();
        let native_task = tokio::spawn(async move {
            let mut receipt = Some(receipt);
            while let Some(call) = native.recv().await {
                if let Some(receipt) = receipt.take() {
                    receipt.await.unwrap();
                }
                let _ = call.reply.send(Ok(call.json));
            }
        });
        for method in ["exit", "globalExit", "throw"] {
            assert!(
                runtime.dispatch(request(method, json!({}))).await.is_err(),
                "{method}"
            );
        }
        for method in ["reject", "timerThrow", "interval"] {
            assert!(
                runtime.dispatch(request(method, json!({}))).await.is_ok(),
                "{method}"
            );
        }
        for name in [
            "/etc/passwd",
            "/opt/plugin.mjs",
            "../../../../package.json",
            "unknown-package",
        ] {
            assert!(
                runtime
                    .dispatch(request("import", json!({"name":name})))
                    .await
                    .is_err(),
                "loader accepted {name}"
            );
        }
        // Second dispatch must complete while the first awaits the native receipt.
        let delayed = runtime.dispatch(request("echo", json!({"cycle":cycle})));
        let immediate = async {
            let result = runtime.dispatch(request("ready", json!({}))).await;
            release.send(()).unwrap();
            result
        };
        let (first, second) = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            tokio::join!(delayed, immediate)
        })
        .await
        .expect("second dispatch was blocked by pending native receipt");
        assert!(first.unwrap().contains("cycle"));
        assert!(second.unwrap().contains("ready"));
        if cycle == 0 {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/upload", listener.local_addr().unwrap());
            let echo = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut data = Vec::new();
                let mut chunk = [0u8; 8192];
                let header_end = loop {
                    let n = socket.read(&mut chunk).await.unwrap();
                    assert!(n > 0);
                    data.extend_from_slice(&chunk[..n]);
                    if let Some(i) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i + 4;
                    }
                };
                let headers = String::from_utf8_lossy(&data[..header_end]).to_lowercase();
                let length: usize = headers
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .unwrap()
                    .trim()
                    .parse()
                    .unwrap();
                while data.len() < header_end + length {
                    let n = socket.read(&mut chunk).await.unwrap();
                    assert!(n > 0);
                    data.extend_from_slice(&chunk[..n]);
                }
                let origin = if headers.lines().any(|l| l.starts_with("origin:")) {
                    "present"
                } else {
                    "absent"
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {length}\r\nContent-Type: application/octet-stream\r\nx-received-origin: {origin}\r\nConnection: close\r\n\r\n"
                );
                socket.write_all(response.as_bytes()).await.unwrap();
                socket
                    .write_all(&data[header_end..header_end + length])
                    .await
                    .unwrap();
            });
            runtime
                .dispatch(request("web", json!({"url":url})))
                .await
                .unwrap();
            echo.await.unwrap();
        }
        let spin = runtime.dispatch(request("spin", json!({})));
        let interrupt = async {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            runtime.interrupt_execution();
        };
        let (interrupted, _) = tokio::join!(spin, interrupt);
        assert!(interrupted.is_err());
        runtime.dispatch(request("ready", json!({}))).await.unwrap();
        let diagnostics = runtime.take_diagnostics();
        assert!(
            diagnostics
                .iter()
                .any(|line| line.contains("expected unhandled rejection"))
        );
        assert!(
            diagnostics
                .iter()
                .any(|line| line.contains("expected timer callback failure"))
        );
        runtime.close().await.unwrap();
        native_task.await.unwrap();
        assert_eq!(live_runtimes(), 0);
        assert_eq!(llrt_core::modules::timers::runtime_timer_state_count(), 0);
    }
}
