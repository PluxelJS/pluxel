use embedded_launcher::ui::{Action, FONT, FONT_NAME, Model, Page, ReplyKind};
use iced::{Font, Settings, Theme, keyboard};
use iced_test::Simulator;
use serde_json::json;

fn settings() -> Settings {
    Settings {
        fonts: vec![FONT.into()],
        default_font: Font::with_name(FONT_NAME),
        ..Default::default()
    }
}
fn result(model: &mut Model, title: &str) {
    model.projection(json!({"lease":"lease-1","revision":model.revision,"results":[{"id":"one","title":title,"subtitle":"Calculator · 计算结果","action":{"handle":"action-1","label":"Copy result / 复制结果"}}],"errors":[]}));
}

#[test]
fn search_typing_and_enter_produce_real_request_intents() {
    let mut model = Model::default();
    model.connect("session-a".into());
    let mut ui = Simulator::with_settings(settings(), model.view());
    ui.click(iced::widget::Id::new("launcher-search")).unwrap();
    ui.typewrite("1 / 3");
    let messages: Vec<_> = ui.into_messages().collect();
    assert!(
        messages
            .iter()
            .any(|message| matches!(message, Action::Input(_)))
    );
    let mut last = None;
    for message in messages {
        last = model.update(message).or(last);
    }
    let request = last.unwrap();
    assert_eq!(request.method, "launcher.query");
    // Text inputs deliver edits via messages; the simulator doesn't silently mutate the model.
    assert!(!request.params["text"].as_str().unwrap().is_empty());
    model.update(Action::Input("1 / 3".into()));
    result(&mut model, "0.3333333333");
    let mut ui = Simulator::with_settings(settings(), model.view());
    assert!(ui.find("0.3333333333").is_ok());
    ui.click(iced::widget::Id::new("launcher-search")).unwrap();
    ui.tap_key(keyboard::key::Named::Enter);
    let messages: Vec<_> = ui.into_messages().collect();
    assert!(
        messages
            .iter()
            .any(|message| matches!(message, Action::Activate))
    );
    let request = model.update(Action::Activate).unwrap();
    assert_eq!(request.method, "launcher.action");
    assert_eq!(request.params, json!({"handle":"action-1"}));
}

#[test]
fn stale_query_and_disconnected_actions_cannot_reappear() {
    let mut model = Model::default();
    model.connect("session-a".into());
    let old = model.update(Action::Input("old".into())).unwrap();
    model.update(Action::Input("new".into()));
    model.update(Action::Reply(old,Ok(json!({"lease":"old","revision":1,"results":[{"id":"old","title":"STALE","subtitle":"","action":{"handle":"old","label":"Execute"}}],"errors":[]}))));
    assert!(model.update(Action::Activate).is_none());
    result(&mut model, "current");
    model.disconnect("Connection lost".into());
    assert!(model.update(Action::Execute("action-1".into())).is_none());
    let mut ui = Simulator::with_settings(settings(), model.view());
    assert!(ui.find("○ Disconnected").is_ok());
    assert!(ui.find("current").is_err());
}

#[test]
fn read_receipts_do_not_release_management_write_or_replace_a_draft() {
    let mut model = Model::default();
    model.connect("session-a".into());
    let pending = model.update(Action::Stop("Calculator".into())).unwrap();
    let status = model.update(Action::Refresh).unwrap();
    let config = model
        .update(Action::Reply(
            status,
            Ok(json!({"statuses":[],"summary":{}})),
        ))
        .unwrap();
    model.update(Action::Precision("7".into()));
    model.update(Action::Reply(
        config,
        Ok(json!({"ok":true,"saved":false,"application":"applied","config":{"precision":10}})),
    ));
    assert_eq!(model.precision, "7");
    assert!(model.update(Action::SavePrecision).is_none());
    model.update(Action::Reply(
        pending,
        Ok(json!({"status":{"statuses":[],"summary":{}},"report":{}})),
    ));
    assert_eq!(
        model.update(Action::SavePrecision).unwrap().params["patch"]["precision"],
        7
    );
}

#[test]
fn raw_query_reply_cannot_bypass_supervisor_projection_validation() {
    let mut model = Model::default();
    let request = model.connect("session-a".into());
    model.update(Action::Reply(request,Ok(json!({"lease":"unvalidated","revision":model.revision,"results":[{"id":"one","title":"Unvalidated","subtitle":"","action":{"handle":"old","label":"Execute"}}],"errors":[]}))));
    assert!(model.update(Action::Activate).is_none());
    let old_status = model.update(Action::Refresh).unwrap();
    model.disconnect("Host lease detached".into());
    model.connect("session-a".into());
    assert!(
        model
            .update(Action::Reply(
                old_status,
                Ok(json!({"statuses":[],"summary":{}}))
            ))
            .is_none()
    );
}

#[test]
fn packages_preserve_active_facts_and_remain_manageable_after_failed_rebuild() {
    let mut model = Model::default();
    let request = model.update(Action::Page(Page::Packages)).unwrap();
    assert_eq!(request.method, "packages.status");
    let status = json!({"mode":"embedded","installedRevision":"v2","activeRevision":"v1","previousRevision":"v1","pending":true,"packages":[{"name":"demo","version":"2.0.0","revision":"v2","activeVersion":"1.0.0"}],"error":null});
    model.update(Action::Reply(request, Ok(status.clone())));
    let mut ui = Simulator::with_settings(settings(), model.view());
    assert!(
        ui.find("Installed changes are pending application.")
            .is_ok()
    );
    assert!(ui.find("Installed 2.0.0 · active 1.0.0").is_ok());
    ui.click("Apply changes").unwrap();
    let messages: Vec<_> = ui.into_messages().collect();
    let request = messages
        .into_iter()
        .find_map(|message| model.update(message))
        .unwrap();
    assert_eq!(request.method, "packages.apply");
    model.disconnect("Old runtime closed".into());
    let failed = json!({"mode":"embedded","installedRevision":"v2","activeRevision":null,"previousRevision":"v1","pending":true,"packages":[],"error":"New runtime failed"});
    model.update(Action::Reply(
        request,
        Ok(json!({"applied":false,"session":null,"status":failed,"error":"New runtime failed"})),
    ));
    let mut ui = Simulator::with_settings(settings(), model.view());
    assert!(ui.find("Runtime unavailable: New runtime failed").is_ok());
    ui.click("Select previous").unwrap();
    let messages: Vec<_> = ui.into_messages().collect();
    let request = messages
        .into_iter()
        .find_map(|message| model.update(message))
        .unwrap();
    assert_eq!(request.method, "packages.selectPrevious");
    assert!(!model.connected);
}

#[test]
fn native_controls_are_semantic_and_development_install_stays_disabled() {
    let mut model = Model::default();
    let action = model
        .control_action(json!({"type":"input","text":"中文 1+2"}))
        .unwrap()
        .unwrap();
    model.update(action);
    assert_eq!(model.snapshot()["query"], "中文 1+2");
    assert!(model.control_action(json!({"type":"activate"})).is_err());
    assert!(
        model
            .control_action(json!({"type":"input","text":"a","unknown":true}))
            .is_err()
    );
    let request = model.update(Action::Page(Page::Packages)).unwrap();
    model.update(Action::Reply(request,Ok(json!({"mode":"development","installedRevision":null,"activeRevision":null,"previousRevision":null,"pending":false,"packages":[],"error":null}))));
    assert!(
        model
            .control_action(json!({"type":"choosePackage"}))
            .is_err()
    );
    assert!(
        model
            .update(Action::PackageSelected(Some("/tmp/demo.zip".into())))
            .is_none()
    );
}

#[test]
fn activity_separates_service_observation_from_permissions_and_retired_owners() {
    let mut model = Model::default();
    model.connect("session-a".into());
    let request = model.update(Action::Page(Page::Activity)).unwrap();
    assert_eq!(request.method, "host.capabilities");
    model.update(Action::Reply(request,Ok(json!({"lease":"one","scope":"observed-session","coverage":"Application Services only; global IO is unobserved","installed":["Network"],"owners":[{"observationId":1,"plugin":"RemoteLookup","retired":true,"capabilities":[{"name":"Network","acquired":1,"calls":2,"active":0,"completed":1,"failed":0,"cancelled":1,"last":{"outcome":"cancelled","origin":"https://example.test","method":"GET","durationMs":30,"bodyBytesRead":0}}]}]}))));
    let mut ui = Simulator::with_settings(settings(), model.view());
    assert!(ui.find("Retired owner · historical usage").is_ok());
    assert!(ui.find("Network · acquired 1 · calls 2 · active 0").is_ok());
    assert!(ui.find("This session only. Application Service calls are observed; global IO is unobserved. These are usage records, not permissions.").is_ok());
}

#[test]
fn plugin_controls_and_failed_config_display_host_facts() {
    let mut model = Model::default();
    model.connect("session-a".into());
    let mut ui = Simulator::with_settings(settings(), model.view());
    ui.click("Plugins").unwrap();
    let messages: Vec<_> = ui.into_messages().collect();
    let status = messages
        .into_iter()
        .find_map(|message| model.update(message))
        .unwrap();
    assert_eq!(status.method, "host.status");
    let config=model.update(Action::Reply(status,Ok(json!({"statuses":[{"rootExportName":"Calculator","displayName":"Calculator","lifecycleState":"running","desiredState":"running","autoStart":true,"availability":"available","issues":[]}],"summary":{"running":1}})))).unwrap();
    assert_eq!(config.method, "host.configGet");
    model.update(Action::Reply(
        config,
        Ok(json!({"ok":true,"saved":false,"application":"applied","config":{"precision":10}})),
    ));
    assert_eq!(model.precision, "10");
    let mut ui = Simulator::with_settings(settings(), model.view());
    ui.click("Stop").unwrap();
    let request = ui
        .into_messages()
        .find_map(|message| model.update(message))
        .unwrap();
    assert_eq!(request.method, "host.stop");
    assert_eq!(request.params, json!({"plugin":"Calculator"}));
    model.update(Action::Reply(
        request,
        Ok(json!({"status":{"statuses":[],"summary":{}},"report":{"issues":[]}})),
    ));
    model.update(Action::Precision("99".into()));
    let request = model.update(Action::SavePrecision).unwrap();
    assert_eq!(request.kind, ReplyKind::Config);
    assert_eq!(request.params["patch"]["precision"], 99);
    model.update(Action::Reply(
        request,
        Ok(json!({"ok":false,"message":"Precision must be between 1 and 15","state":"unchanged"})),
    ));
    let mut ui = Simulator::with_settings(settings(), model.view());
    assert!(ui.find("Precision must be between 1 and 15").is_ok());
}

#[test]
fn narrow_and_regular_views_have_visible_controls_and_screenshots() {
    let mut model = Model::default();
    model.connect("session-a".into());
    model.update(Action::Input("1 / 3".into()));
    result(&mut model, "0.3333333333 · 中文结果");
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/ui-evidence");
    std::fs::create_dir_all(&directory).unwrap();
    for (name, width, height) in [("search", 760.0, 680.0), ("narrow", 420.0, 480.0)] {
        let mut ui = Simulator::with_size(settings(), iced::Size::new(width, height), model.view());
        for label in [
            "Search",
            "Plugins",
            "Diagnostics",
            "0.3333333333 · 中文结果",
        ] {
            let target = ui.find(label).unwrap();
            let bounds = target.visible_bounds().expect("control must be visible");
            assert!(
                bounds.x >= 0.0
                    && bounds.y >= 0.0
                    && bounds.x + bounds.width <= width + 1.0
                    && bounds.y + bounds.height <= height + 1.0,
                "{label}: {bounds:?}"
            );
        }
        let path = directory.join(name);
        // Fresh artifacts are inspection evidence; no self-created baseline is called a regression pass.
        let existing = directory.join(format!("{name}-tiny-skia.png"));
        if existing.exists() {
            std::fs::remove_file(existing).unwrap();
        }
        assert!(
            ui.snapshot(&Theme::TokyoNight)
                .unwrap()
                .matches_image(path)
                .unwrap()
        );
    }
    model.update(Action::Page(Page::Diagnostics));
    model
        .log("错误 / Error: a long diagnostic remains readable in a scrolling region. ".repeat(30));
    let mut ui = Simulator::with_size(settings(), iced::Size::new(420.0, 480.0), model.view());
    assert!(ui.find("Diagnostics / 运行诊断").is_ok());
}
