use embedded_launcher::{
    embedded::{Embedded, live_runtimes},
    supervisor::{AppEvent, Mode, Options, Supervisor},
};
use serde_json::{Value, json};
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), String> {
    let root = std::path::PathBuf::from(
        std::env::args()
            .nth(1)
            .unwrap_or("projects/embedded-launcher/dist".into()),
    );
    for cycle in 0..3 {
        let profile = tempfile::tempdir().map_err(|e| e.to_string())?;
        let (handle, mut events) = Supervisor::start(Options {
            mode: Mode::Embedded {
                root: root.clone(),
                entry: "embedded.mjs".into(),
            },
            profile: profile.path().to_path_buf(),
        })?;
        let event_task = tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                match event {
                    AppEvent::Clipboard { reply, .. }
                    | AppEvent::Desktop { reply, .. }
                    | AppEvent::Screenshot { reply, .. } => {
                        let _ = reply.send(Err(
                            "this lifecycle smoke does not execute UI actions".into()
                        ));
                    }
                    AppEvent::Diagnostics(messages) => {
                        eprintln!("runtime diagnostics: {messages:?}");
                    }
                    _ => {}
                }
            }
        });
        let evidence = handle.request("smoke.run", json!({})).await?;
        assert_eq!(evidence["before"]["value"]["text"], "0.3333333333");
        assert_eq!(evidence["after"]["value"]["text"], "0.333");
        assert_eq!(evidence["stopped"]["error"]["code"], "COMMAND_NOT_FOUND");
        assert_eq!(evidence["restarted"]["value"]["text"], "3");
        println!("cycle {cycle}: {evidence}");
        handle.shutdown().await?;
        handle.shutdown().await?;
        event_task.await.map_err(|e| e.to_string())?;
        assert_eq!(live_runtimes(), 0);
    }
    let (runtime, mut requests) = Embedded::start(&root, "lifecycle.mjs").await?;
    let native = tokio::spawn(async move {
        while let Some(request) = requests.recv().await {
            let input: Value = serde_json::from_str(&request.json).unwrap();
            let result = if input["method"] == "native.echo" {
                tokio::time::sleep(std::time::Duration::from_millis(
                    input["params"]["delayMs"].as_u64().unwrap_or(2),
                ))
                .await;
                Ok(json!({"jsonrpc":"2.0","id":input["id"],"result":{"text":input["params"]["text"]}}).to_string())
            } else {
                Err(format!(
                    "unsupported lifecycle native method: {}",
                    input["method"]
                ))
            };
            let _ = request.reply.send(result);
        }
    });
    let response = runtime
        .dispatch(json!({"jsonrpc":"2.0","id":1,"method":"smoke.run","params":{}}).to_string())
        .await?;
    let result: Value = serde_json::from_str(&response).map_err(|e| e.to_string())?;
    for key in [
        "nativeRejected",
        "facadeRejected",
        "commandRejected",
        "freshWorks",
        "oldStillRejected",
    ] {
        assert_eq!(result["result"][key], true, "{key}: {response}");
    }
    println!("lifecycle: {response}");
    runtime.close().await?;
    native.await.map_err(|e| e.to_string())?;
    assert_eq!(live_runtimes(), 0);
    Ok(())
}
