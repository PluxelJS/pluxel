use embedded_launcher::{
    protocol,
    supervisor::{AppEvent, Mode, Options, Supervisor},
};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::net::UnixStream;
async fn connect(identity: &Value, role: &str) -> UnixStream {
    let mut stream = UnixStream::connect(identity["socket"].as_str().unwrap())
        .await
        .unwrap();
    protocol::write_frame(&mut stream,&json!({"jsonrpc":"2.0","id":"hello","method":"session.hello","params":{"protocol":1,"role":role,"instance":identity["instance"],"profile":identity["profile"],"token":identity["token"]}})).await.unwrap();
    let reply = protocol::read_frame(&mut stream).await.unwrap().unwrap();
    assert!(reply.get("result").is_some(), "{reply}");
    stream
}
async fn call(stream: &mut UnixStream, id: &str, method: &str, params: Value) -> Value {
    protocol::write_frame(
        stream,
        &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
    )
    .await
    .unwrap();
    protocol::read_frame(stream).await.unwrap().unwrap()
}
#[tokio::test(flavor = "current_thread")]
async fn local_transport_storage_and_session_receipts() {
    let directory = tempfile::tempdir().unwrap();
    let profile = directory.path().to_path_buf();
    let (handle, mut events) = Supervisor::start(Options {
        mode: Mode::Development,
        profile: profile.clone(),
    })
    .unwrap();
    assert!(
        Supervisor::start(Options {
            mode: Mode::Development,
            profile: profile.clone()
        })
        .is_err()
    );
    let identity: Value =
        serde_json::from_slice(&std::fs::read(profile.join("endpoint.json")).unwrap()).unwrap();
    let mut executor = connect(&identity, "executor").await;
    let reply = call(
        &mut executor,
        "attach",
        "host.attach",
        json!({"lease":"test-lease"}),
    )
    .await;
    assert_eq!(reply["result"]["accepted"], true);
    assert!(matches!(
        events.recv().await,
        Some(AppEvent::Connected { .. })
    ));
    let text = "{broken but must not be reset";
    assert_eq!(
        call(
            &mut executor,
            "write",
            "storage.write",
            json!({"key":"config","document":text})
        )
        .await["result"]["committed"],
        true
    );
    assert_eq!(
        call(
            &mut executor,
            "read",
            "storage.read",
            json!({"key":"config"})
        )
        .await["result"]["document"],
        text
    );
    assert!(
        call(
            &mut executor,
            "bad-key",
            "storage.read",
            json!({"key":"../private"})
        )
        .await
        .get("error")
        .is_some()
    );
    protocol::write_frame(&mut executor,&json!({"jsonrpc":"2.0","id":"delay","method":"native.echo","params":{"text":"cancelled","delayMs":5000}})).await.unwrap();
    protocol::write_frame(
        &mut executor,
        &json!({"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":"delay"}}),
    )
    .await
    .unwrap();
    let canceled =
        tokio::time::timeout(Duration::from_secs(1), protocol::read_frame(&mut executor))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    assert!(
        canceled["error"]["message"]
            .as_str()
            .unwrap()
            .contains("cancelled")
    );
    // An outbound Host call and inbound native request progress simultaneously.
    let host_call = handle.request("host.status", json!({}));
    let backend = async {
        let outbound = protocol::read_frame(&mut executor).await.unwrap().unwrap();
        assert_eq!(outbound["method"], "host.status");
        let echo = call(
            &mut executor,
            "echo",
            "native.echo",
            json!({"text":"native","delayMs":1}),
        )
        .await;
        assert_eq!(echo["result"]["text"], "native");
        protocol::write_frame(
            &mut executor,
            &protocol::response(
                outbound["id"].clone(),
                Ok(json!({"host":"same-active-session"})),
            ),
        )
        .await
        .unwrap();
    };
    let (result, ()) = tokio::time::timeout(Duration::from_secs(2), async {
        tokio::join!(host_call, backend)
    })
    .await
    .unwrap();
    assert_eq!(result.unwrap()["host"], "same-active-session");
    let mut cli = connect(&identity, "cli").await;
    assert!(
        call(
            &mut cli,
            "cli-denied",
            "storage.read",
            json!({"key":"config"})
        )
        .await
        .get("error")
        .is_some()
    );
    drop(executor);
    let disconnected = tokio::time::timeout(Duration::from_secs(1), events.recv())
        .await
        .unwrap();
    assert!(matches!(disconnected, Some(AppEvent::Disconnected { .. })));
    let mut replacement = connect(&identity, "executor").await;
    assert_eq!(
        call(
            &mut replacement,
            "new-attach",
            "host.attach",
            json!({"lease":"new-lease"})
        )
        .await["result"]["accepted"],
        true
    );
    drop(replacement);
    drop(cli);
    drop(events);
    handle.shutdown().await.unwrap();
    assert!(!profile.join("endpoint.json").exists());
}
#[tokio::test(flavor = "current_thread")]
async fn frame_validation_and_partial_header() {
    use tokio::io::AsyncWriteExt;
    let (mut writer, mut reader) = tokio::io::duplex(64);
    let write = tokio::spawn(async move {
        writer.write_all(&[0, 0]).await.unwrap();
    });
    write.await.unwrap();
    assert!(protocol::read_frame(&mut reader).await.is_err());
    assert!(protocol::validate(&json!({"jsonrpc":"2.0","id":"x","result":1,"error":{}})).is_err());
    assert!(protocol::validate(&json!({"jsonrpc":"2.0","method":"x","params":[]})).is_err());
}
