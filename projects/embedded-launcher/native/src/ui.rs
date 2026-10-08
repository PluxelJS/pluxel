//! Native UI projections. The supervisor owns execution; this subscription only consumes events.
use crate::supervisor::{AppEvent, AppHandle};
use iced::futures::{SinkExt, StreamExt};
use iced::{
    Element, Fill, Font, Subscription, Task, Theme, keyboard,
    widget::{button, checkbox, column, container, row, scrollable, text, text_input},
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    hash::{Hash, Hasher},
    sync::{Arc, Mutex},
};
use tokio::sync::mpsc;

pub const FONT: &[u8] = include_bytes!("../../assets/fonts/NotoSansSC-Regular.otf");
pub const FONT_NAME: &str = "Noto Sans SC";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Page {
    Search,
    Plugins,
    Packages,
    Activity,
    Diagnostics,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplyKind {
    Query,
    Status,
    Config,
    ConfigRead,
    Mutation,
    Action,
    Command,
    Packages,
    PackageMutation,
    Capabilities,
}
#[derive(Debug, Clone)]
pub struct Request {
    pub method: &'static str,
    pub params: Value,
    pub kind: ReplyKind,
    pub session: String,
    pub revision: u64,
    pub attachment_revision: u64,
}
#[derive(Debug, Clone)]
pub enum Action {
    Input(String),
    Page(Page),
    Move(i32),
    Activate,
    Execute(String),
    Refresh,
    Start(String),
    Stop(String),
    AutoStart(String, bool),
    Precision(String),
    SavePrecision,
    RunCommand,
    Escape,
    RefreshPackages,
    ChoosePackage,
    PackageSelected(Option<std::path::PathBuf>),
    RemovePackage(String),
    SelectPrevious,
    ApplyPackages,
    RefreshCapabilities,
    Resize(u32, u32),
    Reply(Request, Result<Value, String>),
}
#[derive(Debug, Clone)]
struct ResultRow {
    title: String,
    subtitle: String,
    handle: String,
    label: String,
}

#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Control {
    Inspect,
    Input { text: String },
    Page { page: String },
    Select { index: usize },
    Activate,
    Precision { value: String },
    SavePrecision,
    Refresh,
    Start { plugin: String },
    Stop { plugin: String },
    AutoStart { plugin: String, enabled: bool },
    RunCommand,
    Escape,
    ChoosePackage,
    ApplyPackages,
    SelectPrevious,
    RemovePackage { name: String },
    Resize { width: u32, height: u32 },
}

/// UI state only: authoritative plugin/config facts arrive in Host receipts.
pub struct Model {
    pub page: Page,
    pub query: String,
    pub revision: u64,
    pub precision: String,
    pub connected: bool,
    session: String,
    attachment_revision: u64,
    lease: Option<String>,
    results: Vec<ResultRow>,
    query_errors: Value,
    selected: usize,
    loading: bool,
    busy: bool,
    config_dirty: bool,
    status: Vec<Value>,
    packages: Value,
    package_busy: bool,
    choosing_package: bool,
    capabilities: Value,
    window_size: iced::Size,
    notice: String,
    diagnostics: VecDeque<String>,
}
impl Default for Model {
    fn default() -> Self {
        Self {
            page: Page::Search,
            query: String::new(),
            revision: 0,
            precision: String::new(),
            connected: false,
            session: String::new(),
            attachment_revision: 0,
            lease: None,
            results: Vec::new(),
            query_errors: json!([]),
            selected: 0,
            loading: false,
            busy: false,
            config_dirty: false,
            status: Vec::new(),
            packages: Value::Null,
            package_busy: false,
            choosing_package: false,
            capabilities: Value::Null,
            window_size: iced::Size::new(760.0, 680.0),
            notice: "Waiting for the execution session · 等待插件连接".into(),
            diagnostics: VecDeque::new(),
        }
    }
}
impl Model {
    fn request(&self, method: &'static str, params: Value, kind: ReplyKind) -> Request {
        Request {
            method,
            params,
            kind,
            session: self.session.clone(),
            revision: self.revision,
            attachment_revision: self.attachment_revision,
        }
    }
    pub fn connect(&mut self, session: String) -> Request {
        self.attachment_revision += 1;
        self.session = session;
        self.connected = true;
        self.lease = None;
        self.results.clear();
        self.query_errors = json!([]);
        self.status.clear();
        self.capabilities = Value::Null;
        self.busy = false;
        self.notice = "Connected · 已连接".into();
        self.loading = true;
        self.request(
            "launcher.query",
            json!({"revision":self.revision,"text":self.query,"limit":20}),
            ReplyKind::Query,
        )
    }
    pub fn disconnect(&mut self, message: String) {
        self.attachment_revision += 1;
        self.session.clear();
        self.connected = false;
        self.results.clear();
        self.status.clear();
        self.capabilities = Value::Null;
        self.loading = false;
        self.busy = false;
        self.lease = None;
        self.notice = format!("Disconnected · {message}");
        self.log(message);
    }
    pub fn log(&mut self, message: String) {
        // Bound visible diagnostics independently of upstream transport batching.
        let message: String = message.chars().take(4096).collect();
        self.diagnostics.push_back(message);
        while self.diagnostics.len() > 100 {
            self.diagnostics.pop_front();
        }
    }
    pub fn projection(&mut self, value: Value) {
        if !self.connected || value["revision"].as_u64() != Some(self.revision) {
            return;
        }
        let Some(lease) = value["lease"].as_str() else {
            self.log("Query projection missing lease".into());
            return;
        };
        let Some(results) = value["results"].as_array() else {
            self.log("Query projection missing results".into());
            return;
        };
        let mut rows = Vec::new();
        for item in results.iter().take(30) {
            let (Some(title), Some(subtitle), Some(handle), Some(label)) = (
                item["title"].as_str(),
                item["subtitle"].as_str(),
                item["action"]["handle"].as_str(),
                item["action"]["label"].as_str(),
            ) else {
                self.log("Invalid launcher result DTO".into());
                return;
            };
            rows.push(ResultRow {
                title: title.into(),
                subtitle: subtitle.into(),
                handle: handle.into(),
                label: label.into(),
            });
        }
        self.lease = Some(lease.into());
        self.results = rows;
        self.selected = self.selected.min(self.results.len().saturating_sub(1));
        self.loading = false;
        if let Some(errors) = value["errors"].as_array() {
            self.query_errors = Value::Array(errors.clone());
            for error in errors {
                self.log(format!(
                    "{}: {}",
                    error["provider"].as_str().unwrap_or("Provider"),
                    error["message"].as_str().unwrap_or("Query failed")
                ));
            }
            if !errors.is_empty() {
                self.notice = format!("{} provider error(s) · See Diagnostics", errors.len());
            }
        }
    }
    fn set_status(&mut self, value: &Value) {
        if let Some(statuses) = value["statuses"].as_array() {
            self.status = statuses.clone();
        } else {
            self.log("Host returned no statuses array".into());
        }
    }
    pub fn update(&mut self, action: Action) -> Option<Request> {
        match action {
            Action::Input(value) => {
                self.query = value;
                self.revision += 1;
                self.results.clear();
                self.query_errors = json!([]);
                self.selected = 0;
                self.loading = self.connected;
                if self.connected {
                    return Some(self.request(
                        "launcher.query",
                        json!({"revision":self.revision,"text":self.query,"limit":20}),
                        ReplyKind::Query,
                    ));
                }
            }
            Action::Page(page) => {
                self.page = page;
                if page == Page::Packages {
                    return self.update(Action::RefreshPackages);
                }
                if page == Page::Activity {
                    return self.update(Action::RefreshCapabilities);
                }
                if page == Page::Plugins && self.connected {
                    return Some(self.request("host.status", json!({}), ReplyKind::Status));
                }
            }
            Action::Refresh => {
                if self.connected {
                    return Some(self.request("host.status", json!({}), ReplyKind::Status));
                }
            }
            Action::Move(delta) => {
                if self.page == Page::Search && !self.results.is_empty() {
                    self.selected = (self.selected as i32 + delta)
                        .clamp(0, self.results.len() as i32 - 1)
                        as usize;
                }
            }
            Action::Activate => {
                if self.page != Page::Search {
                    return None;
                }
                if let Some(result) = self.results.get(self.selected) {
                    return self.update(Action::Execute(result.handle.clone()));
                }
            }
            Action::Execute(handle) => {
                if self.connected
                    && !self.busy
                    && self.results.iter().any(|item| item.handle == handle)
                {
                    self.busy = true;
                    self.notice = "Action in progress…".into();
                    return Some(self.request(
                        "launcher.action",
                        json!({"handle":handle}),
                        ReplyKind::Action,
                    ));
                }
            }
            Action::Start(plugin) | Action::Stop(plugin) if !self.connected => {
                self.log(format!("Cannot operate {plugin}: disconnected"));
            }
            Action::Start(plugin) => {
                if !self.busy {
                    self.busy = true;
                    return Some(self.request(
                        "host.startNode",
                        json!({"plugin":plugin}),
                        ReplyKind::Mutation,
                    ));
                }
            }
            Action::Stop(plugin) => {
                if !self.busy {
                    self.busy = true;
                    return Some(self.request(
                        "host.stop",
                        json!({"plugin":plugin}),
                        ReplyKind::Mutation,
                    ));
                }
            }
            Action::AutoStart(plugin, auto_start) => {
                if self.connected && !self.busy {
                    self.busy = true;
                    return Some(self.request(
                        "host.autostart",
                        json!({"plugin":plugin,"autoStart":auto_start}),
                        ReplyKind::Mutation,
                    ));
                }
            }
            Action::Precision(value) => {
                self.precision = value;
                self.config_dirty = true;
            }
            Action::SavePrecision => {
                if self.connected && !self.busy {
                    match self.precision.parse::<u32>() {
                        Ok(precision) => {
                            self.busy = true;
                            return Some(self.request(
                                "host.config",
                                json!({"plugin":"Calculator","patch":{"precision":precision}}),
                                ReplyKind::Config,
                            ));
                        }
                        Err(_) => self.notice =
                            "Precision must be a whole number; Host validates the supported range."
                                .into(),
                    }
                }
            }
            Action::RunCommand => {
                if self.connected && !self.busy {
                    self.busy = true;
                    return Some(self.request(
                        "command.execute",
                        json!({"expression":self.query}),
                        ReplyKind::Command,
                    ));
                }
            }
            Action::Escape => {
                if self.page != Page::Search {
                    self.page = Page::Search;
                } else {
                    return self.update(Action::Input(String::new()));
                }
            }
            Action::RefreshPackages => {
                if !self.package_busy {
                    return Some(self.request("packages.status", json!({}), ReplyKind::Packages));
                }
            }
            Action::ChoosePackage | Action::Resize(_, _) => {}
            Action::PackageSelected(None) => {
                self.notice = "Package selection cancelled.".into();
            }
            Action::PackageSelected(Some(path)) => {
                if self.package_changes_available() {
                    self.package_busy = true;
                    self.notice = "Validating and installing package…".into();
                    return Some(self.request(
                        "packages.install",
                        json!({"path":path}),
                        ReplyKind::PackageMutation,
                    ));
                }
            }
            Action::RemovePackage(name) => {
                if self.package_changes_available() {
                    self.package_busy = true;
                    return Some(self.request(
                        "packages.remove",
                        json!({"name":name}),
                        ReplyKind::PackageMutation,
                    ));
                }
            }
            Action::SelectPrevious => {
                if self.package_changes_available() {
                    self.package_busy = true;
                    return Some(self.request(
                        "packages.selectPrevious",
                        json!({}),
                        ReplyKind::PackageMutation,
                    ));
                }
            }
            Action::ApplyPackages => {
                if self.package_changes_available() {
                    self.package_busy = true;
                    self.notice =
                        "Closing the current plugin runtime and applying the installed selection…"
                            .into();
                    return Some(self.request(
                        "packages.apply",
                        json!({}),
                        ReplyKind::PackageMutation,
                    ));
                }
            }
            Action::RefreshCapabilities => {
                if self.connected {
                    return Some(self.request(
                        "host.capabilities",
                        json!({}),
                        ReplyKind::Capabilities,
                    ));
                }
            }
            Action::Reply(request, result) => {
                let application_owned = matches!(
                    request.kind,
                    ReplyKind::Packages | ReplyKind::PackageMutation
                );
                if !application_owned
                    && (request.session != self.session
                        || request.attachment_revision != self.attachment_revision)
                {
                    if request.kind != ReplyKind::Query {
                        self.log(format!(
                            "Earlier Host receipt for {}: {:?}",
                            request.method, result
                        ));
                    }
                    return None;
                }
                if request.kind == ReplyKind::Query && request.revision != self.revision {
                    return None;
                }
                match result {
                    Err(error) => {
                        if request.kind == ReplyKind::Query {
                            self.loading = false;
                        } else if request.kind == ReplyKind::PackageMutation {
                            self.package_busy = false;
                        } else if matches!(
                            request.kind,
                            ReplyKind::Config
                                | ReplyKind::Mutation
                                | ReplyKind::Action
                                | ReplyKind::Command
                        ) {
                            self.busy = false;
                        }
                        self.notice = error.clone();
                        self.log(error);
                    }
                    Ok(value) => {
                        match request.kind {
                            // Only supervisor-validated Query events may update visible actions.
                            ReplyKind::Query => {}
                            ReplyKind::Status => {
                                self.set_status(&value);
                                return Some(self.request(
                                    "host.configGet",
                                    json!({"plugin":"Calculator"}),
                                    ReplyKind::ConfigRead,
                                ));
                            }
                            ReplyKind::Config | ReplyKind::ConfigRead => {
                                if request.kind == ReplyKind::Config {
                                    self.busy = false;
                                }
                                if value["ok"] == true {
                                    if let Some(precision) = value["config"]["precision"].as_u64() {
                                        if !self.config_dirty || request.kind == ReplyKind::Config {
                                            self.precision = precision.to_string();
                                            self.config_dirty = false;
                                        }
                                    }
                                    self.notice = match value["application"].as_str() {
                                    Some("applied") if value["saved"]==true=>"Configuration saved and applied.",
                                    Some("applied")=>"Current configuration is applied.",
                                    Some("deferred")=>"Configuration saved; application is deferred until the plugin starts.",
                                    Some("saved-not-applied")=>"Configuration saved but not applied. See Diagnostics for the Host failure.",
                                    _=>"Configuration receipt has an unknown application state. See Diagnostics.",
                                }.into();
                                } else {
                                    self.notice = value["message"]
                                        .as_str()
                                        .unwrap_or("Configuration rejected")
                                        .into();
                                }
                                self.log(value.to_string());
                            }
                            ReplyKind::Mutation => {
                                self.busy = false;
                                self.set_status(&value["status"]);
                                self.notice="Host operation settled · See actual plugin state and Diagnostics".into();
                                self.log(value["report"].to_string());
                            }
                            ReplyKind::Action | ReplyKind::Command => {
                                self.busy = false;
                                self.notice = receipt_notice(&value);
                                self.log(value.to_string());
                                if self.page == Page::Activity {
                                    return self.update(Action::RefreshCapabilities);
                                }
                            }
                            ReplyKind::Capabilities => {
                                self.capabilities = value;
                            }
                            ReplyKind::Packages => {
                                self.packages = value;
                            }
                            ReplyKind::PackageMutation => {
                                self.package_busy = false;
                                self.packages = value["status"].clone();
                                self.notice = if value["applied"] == false {
                                    value["error"].as_str().unwrap_or("The new runtime could not start. Review diagnostics and explicitly select the previous collection to recover.").into()
                                } else if value["applied"] == true {
                                    "Installed selection applied in a fresh plugin runtime.".into()
                                } else {
                                    "Installed selection saved. Apply changes to activate it."
                                        .into()
                                };
                                self.log(value.to_string());
                            }
                        }
                    }
                }
            }
        }
        None
    }
    fn package_changes_available(&self) -> bool {
        self.packages["mode"] == "embedded" && !self.package_busy && !self.choosing_package
    }
    pub fn control_action(&self, value: Value) -> Result<Option<Action>, String> {
        let control: Control = serde_json::from_value(value).map_err(|error| error.to_string())?;
        let action = match control {
            Control::Inspect => return Ok(None),
            Control::Resize { width, height } => {
                if !(420..=2400).contains(&width) || !(480..=1800).contains(&height) {
                    return Err("Window size must be within 420×480 and 2400×1800".into());
                }
                Action::Resize(width, height)
            }
            Control::Input { text } => {
                if text.len() > 16384 {
                    return Err("UI input exceeds 16 KiB".into());
                }
                Action::Input(text)
            }
            Control::Page { page } => Action::Page(match page.as_str() {
                "search" => Page::Search,
                "plugins" => Page::Plugins,
                "packages" => Page::Packages,
                "activity" => Page::Activity,
                "diagnostics" => Page::Diagnostics,
                _ => return Err("Unknown UI page".into()),
            }),
            Control::Select { index } => {
                if index >= self.results.len() {
                    return Err("Result index is not visible".into());
                }
                Action::Move(index as i32 - self.selected as i32)
            }
            Control::Activate => {
                if self.page != Page::Search
                    || !self.connected
                    || self.busy
                    || self.results.is_empty()
                {
                    return Err("Selected UI action is unavailable".into());
                }
                Action::Activate
            }
            Control::Precision { value } => Action::Precision(value),
            Control::SavePrecision => Action::SavePrecision,
            Control::Refresh => match self.page {
                Page::Packages => Action::RefreshPackages,
                Page::Activity => Action::RefreshCapabilities,
                _ => Action::Refresh,
            },
            Control::Start { plugin } => Action::Start(plugin),
            Control::Stop { plugin } => Action::Stop(plugin),
            Control::AutoStart { plugin, enabled } => Action::AutoStart(plugin, enabled),
            Control::RunCommand => Action::RunCommand,
            Control::Escape => Action::Escape,
            Control::ChoosePackage => Action::ChoosePackage,
            Control::ApplyPackages => Action::ApplyPackages,
            Control::SelectPrevious => Action::SelectPrevious,
            Control::RemovePackage { name } => Action::RemovePackage(name),
        };
        if matches!(
            action,
            Action::SavePrecision
                | Action::Start(_)
                | Action::Stop(_)
                | Action::AutoStart(_, _)
                | Action::RunCommand
        ) && (!self.connected || self.busy)
        {
            return Err("UI control is unavailable while disconnected or busy".into());
        }
        if matches!(
            action,
            Action::ChoosePackage
                | Action::ApplyPackages
                | Action::SelectPrevious
                | Action::RemovePackage(_)
        ) && !self.package_changes_available()
        {
            return Err("Package UI control is unavailable in this mode or while busy".into());
        }
        Ok(Some(action))
    }
    pub fn snapshot(&self) -> Value {
        json!({"session":self.session,"lease":self.lease,"errors":self.query_errors,"diagnostics":self.diagnostics,"packages":self.packages,"capabilities":self.capabilities,"windowSize":{"width":self.window_size.width,"height":self.window_size.height},"page":match self.page{Page::Search=>"search",Page::Plugins=>"plugins",Page::Packages=>"packages",Page::Activity=>"activity",Page::Diagnostics=>"diagnostics"},"query":self.query,"revision":self.revision,"connected":self.connected,"loading":self.loading,"busy":self.busy,"packageBusy":self.package_busy,"choosingPackage":self.choosing_package,"precision":self.precision,"selected":self.selected,"notice":self.notice,"results":self.results.iter().map(|item|json!({"title":item.title,"subtitle":item.subtitle,"handle":item.handle,"label":item.label})).collect::<Vec<_>>()})
    }
    pub fn view(&self) -> Element<'_, Action> {
        let connected = if self.connected {
            "● Connected"
        } else {
            "○ Disconnected"
        };
        let header = row![
            column![text("PLUXEL").size(14), text("Launcher / 启动器").size(26)].spacing(3),
            iced::widget::space::horizontal(),
            text(connected).size(13)
        ]
        .align_y(iced::Center);
        let tabs = row![
            button("Search").on_press(Action::Page(Page::Search)).style(
                if self.page == Page::Search {
                    button::primary
                } else {
                    button::secondary
                }
            ),
            button("Plugins")
                .on_press(Action::Page(Page::Plugins))
                .style(if self.page == Page::Plugins {
                    button::primary
                } else {
                    button::secondary
                }),
            button("Packages")
                .on_press(Action::Page(Page::Packages))
                .style(if self.page == Page::Packages {
                    button::primary
                } else {
                    button::secondary
                }),
            button("Activity")
                .on_press(Action::Page(Page::Activity))
                .style(if self.page == Page::Activity {
                    button::primary
                } else {
                    button::secondary
                }),
            button("Diagnostics")
                .on_press(Action::Page(Page::Diagnostics))
                .style(if self.page == Page::Diagnostics {
                    button::primary
                } else {
                    button::secondary
                })
        ]
        .spacing(8)
        .wrap();
        let content: Element<'_, Action> = match self.page {
            Page::Search => {
                let input = text_input("Calculate, search, or find a native action…", &self.query)
                    .id("launcher-search")
                    .on_input(Action::Input)
                    .on_submit(Action::Activate)
                    .padding(14)
                    .size(20);
                let mut results = column![].spacing(8);
                if !self.connected {
                    results=results.push(text("The window stays available while plugins reconnect.\n插件断开时仍可查看诊断。"));
                } else if self.loading {
                    results = results.push(text("Searching… / 查询中"));
                } else if self.results.is_empty() {
                    results = results
                        .push(text("No results / 无匹配结果").size(20))
                        .push(text("Try 1 / 3, or a native action name."));
                }
                for (index, item) in self.results.iter().enumerate() {
                    let label = column![
                        text(&item.title).size(23),
                        text(&item.subtitle).size(14),
                        text(&item.label).size(12)
                    ]
                    .spacing(5);
                    results = results.push(
                        button(label)
                            .width(Fill)
                            .padding(14)
                            .style(if index == self.selected {
                                button::primary
                            } else {
                                button::secondary
                            })
                            .on_press_maybe(
                                (!self.busy).then(|| Action::Execute(item.handle.clone())),
                            ),
                    );
                }
                column![
                    input,
                    text("↑ ↓ select · Enter execute · Esc clear / return").size(12),
                    scrollable(results).id("launcher-results").height(Fill),
                    button("Run through Commands").on_press_maybe(
                        (self.connected && !self.busy && !self.query.is_empty())
                            .then_some(Action::RunCommand)
                    )
                ]
                .spacing(12)
                .into()
            }
            Page::Plugins => {
                let mut plugins = column![
                    row![
                        text("Plugin management").size(22),
                        iced::widget::space::horizontal(),
                        button("Refresh").on_press_maybe(self.connected.then_some(Action::Refresh))
                    ]
                    .align_y(iced::Center)
                ]
                .spacing(12);
                plugins = plugins.push(
                    container(
                        column![
                            text("Calculator precision / 计算精度").size(18),
                            row![
                                text_input("Read from Host", &self.precision)
                                    .id("precision")
                                    .on_input(Action::Precision)
                                    .padding(10)
                                    .width(140),
                                button("Save precision").on_press_maybe(
                                    (self.connected && !self.busy).then_some(Action::SavePrecision)
                                )
                            ]
                            .spacing(8),
                            text("Changes are validated and persisted by the active Host.")
                                .size(12)
                        ]
                        .spacing(8),
                    )
                    .padding(14)
                    .style(container::rounded_box),
                );
                if self.status.is_empty() {
                    plugins = plugins.push(text(
                        "No plugin status available. Connect or refresh to inspect the Host.",
                    ));
                }
                for status in &self.status {
                    let name = status["rootExportName"].as_str().unwrap_or("");
                    let display = status["displayName"].as_str().unwrap_or(name);
                    let state = status["lifecycleState"].as_str().unwrap_or("unknown");
                    let available = self.connected && !self.busy && !name.is_empty();
                    let details = format!(
                        "{} · desired {} · {}",
                        state,
                        status["desiredState"].as_str().unwrap_or("unknown"),
                        status["availability"].as_str().unwrap_or("")
                    );
                    let mut card = column![
                        text(display).size(18),
                        text(details).size(13),
                        row![
                            button("Start")
                                .on_press_maybe(available.then(|| Action::Start(name.into()))),
                            button("Stop")
                                .on_press_maybe(available.then(|| Action::Stop(name.into()))),
                            checkbox(status["autoStart"] == true)
                                .label("Auto-start")
                                .on_toggle_maybe(available.then(|| {
                                    let name = name.to_owned();
                                    move |enabled| Action::AutoStart(name.clone(), enabled)
                                }))
                        ]
                        .spacing(8)
                    ]
                    .spacing(8);
                    if let Some(issues) = status["issues"].as_array() {
                        for issue in issues {
                            card = card.push(
                                text(
                                    issue["message"]
                                        .as_str()
                                        .unwrap_or("Host reported an issue"),
                                )
                                .size(12),
                            );
                        }
                    }
                    plugins = plugins.push(
                        container(card)
                            .padding(14)
                            .width(Fill)
                            .style(container::rounded_box),
                    );
                }
                scrollable(plugins).height(Fill).into()
            }
            Page::Packages => {
                let available = self.package_changes_available();
                let mut content = column![
                    row![
                        text("Plugin packages / 插件包").size(22),
                        iced::widget::space::horizontal(),
                        button("Refresh").on_press_maybe(
                            (!self.package_busy).then_some(Action::RefreshPackages)
                        )
                    ]
                    .align_y(iced::Center)
                ]
                .spacing(12);
                if self.packages.is_null() {
                    content = content.push(text("Reading native package selection…"));
                } else {
                    if self.packages["mode"] == "development" {
                        content=content.push(text("Development packages are managed by the Vite workspace. Package changes are available in the embedded profile."));
                    }
                    let active = self.packages["activeRevision"].as_str().unwrap_or("None");
                    let installed = self.packages["installedRevision"]
                        .as_str()
                        .unwrap_or("None");
                    content = content.push(
                        container(
                            column![
                                text(format!("Active: {active}")).size(13),
                                text(format!("Installed: {installed}")).size(13),
                                text(if self.packages["pending"] == true {
                                    "Installed changes are pending application."
                                } else {
                                    "No pending installed changes."
                                })
                            ]
                            .spacing(7),
                        )
                        .padding(12)
                        .style(container::rounded_box),
                    );
                    if let Some(error) = self.packages["error"].as_str() {
                        content = content.push(text(format!("Runtime unavailable: {error}")));
                    }
                    if self.package_busy {
                        content = content.push(text("Package operation in progress…"));
                    }
                    content = content.push(
                        row![
                            button("Install ZIP…")
                                .on_press_maybe(available.then_some(Action::ChoosePackage)),
                            button("Apply changes")
                                .on_press_maybe(available.then_some(Action::ApplyPackages)),
                            button("Select previous").on_press_maybe(
                                (available && self.packages["previousRevision"].is_string())
                                    .then_some(Action::SelectPrevious)
                            )
                        ]
                        .spacing(8)
                        .wrap(),
                    );
                    content=content.push(text("Installation does not replace the active runtime. New plugins remain disabled until explicitly enabled. Selecting a previous collection also requires Apply changes.").size(12));
                    if let Some(packages) = self.packages["packages"].as_array() {
                        for package in packages {
                            let name = package["name"].as_str().unwrap_or("Invalid package name");
                            content = content.push(
                                container(
                                    column![
                                        text(name).size(18),
                                        text(format!(
                                            "Installed {} · active {}",
                                            package["version"]
                                                .as_str()
                                                .unwrap_or("removed; pending apply"),
                                            package["activeVersion"]
                                                .as_str()
                                                .unwrap_or("not active")
                                        ))
                                        .size(13),
                                        text(package["revision"].as_str().unwrap_or("")).size(12),
                                        button("Remove from installed selection").on_press_maybe(
                                            (available && package["version"].is_string())
                                                .then(|| Action::RemovePackage(name.into()))
                                        )
                                    ]
                                    .spacing(8),
                                )
                                .padding(12)
                                .width(Fill)
                                .style(container::rounded_box),
                            );
                        }
                    }
                }
                scrollable(content).height(Fill).into()
            }
            Page::Activity => {
                let mut content=column![row![text("Observed capabilities / 能力观察").size(21),iced::widget::space::horizontal(),button("Refresh").on_press_maybe(self.connected.then_some(Action::RefreshCapabilities))].align_y(iced::Center),text("This session only. Application Service calls are observed; global IO is unobserved. These are usage records, not permissions.").size(13)].spacing(12);
                if self.capabilities.is_null() {
                    content = content.push(text(
                        "No capability snapshot available. Connect and refresh.",
                    ));
                } else {
                    let installed = self.capabilities["installed"]
                        .as_array()
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join(", ")
                        })
                        .unwrap_or_default();
                    content = content
                        .push(text(format!("Installed Host services: {installed}")).size(13));
                    if let Some(owners) = self.capabilities["owners"].as_array() {
                        for owner in owners {
                            let plugin = owner["plugin"].as_str().unwrap_or("Unknown owner");
                            let mut card = column![
                                text(plugin).size(18),
                                text(if owner["retired"] == true {
                                    "Retired owner · historical usage"
                                } else {
                                    "Current owner"
                                })
                                .size(12)
                            ]
                            .spacing(8);
                            if let Some(capabilities) = owner["capabilities"].as_array() {
                                for capability in capabilities {
                                    let name =
                                        capability["name"].as_str().unwrap_or("Unknown capability");
                                    card = card.push(
                                        text(format!(
                                            "{} · acquired {} · calls {} · active {}",
                                            name,
                                            capability["acquired"],
                                            capability["calls"],
                                            capability["active"]
                                        ))
                                        .size(13),
                                    );
                                    card = card.push(
                                        text(format!(
                                            "Completed {} · failed {} · cancelled {}",
                                            capability["completed"],
                                            capability["failed"],
                                            capability["cancelled"]
                                        ))
                                        .size(12),
                                    );
                                    let last = &capability["last"];
                                    if !last.is_null() {
                                        card = card.push(
                                            text(format!(
                                                "Last: {} {} {} · HTTP {} · {} ms · {} bytes read",
                                                last["outcome"].as_str().unwrap_or("unknown"),
                                                last["method"].as_str().unwrap_or(""),
                                                last["origin"].as_str().unwrap_or(""),
                                                last["status"],
                                                last["durationMs"],
                                                last["bodyBytesRead"]
                                            ))
                                            .size(12),
                                        );
                                    }
                                }
                            }
                            content = content.push(
                                container(card)
                                    .width(Fill)
                                    .padding(12)
                                    .style(container::rounded_box),
                            );
                        }
                    }
                }
                scrollable(content).height(Fill).into()
            }
            Page::Diagnostics => {
                let mut entries=column![text("Diagnostics / 运行诊断").size(22),text("Latest 100 records. Host reports and native receipts preserve actual outcomes.").size(13)].spacing(12);
                if self.diagnostics.is_empty() {
                    entries = entries.push(text("No diagnostics yet."));
                }
                for entry in self.diagnostics.iter().rev() {
                    entries = entries.push(
                        container(text(entry).size(13))
                            .padding(10)
                            .width(Fill)
                            .style(container::rounded_box),
                    );
                }
                scrollable(entries).height(Fill).into()
            }
        };
        let notice = scrollable(text(&self.notice).size(13)).height(48);
        container(column![header, tabs, content, notice].spacing(12))
            .padding(18)
            .width(Fill)
            .height(Fill)
            .into()
    }
}

fn receipt_notice(value: &Value) -> String {
    if value["ok"] == false {
        return value["error"]["message"]
            .as_str()
            .or_else(|| value["message"].as_str())
            .unwrap_or("The operation was rejected. See Diagnostics.")
            .into();
    }
    if let Some(text) = value["value"]["text"].as_str() {
        return format!("Result: {text}");
    }
    if value["committed"] == true {
        return value["message"]
            .as_str()
            .unwrap_or("Action completed.")
            .into();
    }
    "Operation returned a receipt. See Diagnostics for details.".into()
}

#[derive(Clone)]
struct EventSource(Arc<Mutex<Option<mpsc::Receiver<AppEvent>>>>);
impl Hash for EventSource {
    fn hash<H: Hasher>(&self, state: &mut H) {
        Arc::as_ptr(&self.0).hash(state);
    }
}
#[derive(Debug, Clone)]
enum Message {
    Ui(Action),
    Incoming(Arc<Mutex<Option<AppEvent>>>),
    Key(keyboard::Event),
    Close,
    Closed(Result<(), String>),
    ScreenshotWindow(Option<iced::window::Id>, CaptureTarget),
    Captured(iced::window::Screenshot, CaptureTarget),
    ScreenshotSaved(Result<Value, String>),
    WindowResized(iced::Size),
}
type CaptureTarget = Arc<
    Mutex<
        Option<(
            std::path::PathBuf,
            tokio::sync::oneshot::Sender<Result<Value, String>>,
        )>,
    >,
>;
struct Ui {
    model: Model,
    handle: AppHandle,
    events: EventSource,
    clipboard: Option<arboard::Clipboard>,
    theme: Theme,
}
fn events(source: &EventSource) -> iced::futures::stream::BoxStream<'static, Message> {
    let source = source.clone();
    iced::stream::channel(
        64,
        move |mut output: iced::futures::channel::mpsc::Sender<Message>| async move {
            let receiver = source.0.lock().unwrap().take();
            if let Some(mut receiver) = receiver {
                while let Some(event) = receiver.recv().await {
                    if output
                        .send(Message::Incoming(Arc::new(Mutex::new(Some(event)))))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
            std::future::pending::<()>().await;
        },
    )
    .boxed()
}
impl Ui {
    fn perform(&self, request: Option<Request>) -> Task<Message> {
        match request {
            None => Task::none(),
            Some(request) => {
                let handle = self.handle.clone();
                Task::perform(
                    async move {
                        let result = handle.request(request.method, request.params.clone()).await;
                        (request, result)
                    },
                    |(request, result)| Message::Ui(Action::Reply(request, result)),
                )
            }
        }
    }
    fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::Ui(action) => {
                if let Action::Resize(width, height) = action {
                    return iced::window::latest().and_then(move |id| {
                        iced::window::resize(id, iced::Size::new(width as f32, height as f32))
                    });
                }
                if matches!(action, Action::ChoosePackage) {
                    if !self.model.package_changes_available() {
                        return Task::none();
                    }
                    self.model.choosing_package = true;
                    return Task::perform(
                        async {
                            rfd::AsyncFileDialog::new()
                                .set_title("Install a precompiled Pluxel package")
                                .add_filter("Plugin package", &["zip"])
                                .pick_file()
                                .await
                                .map(|file| file.path().to_owned())
                        },
                        |path| Message::Ui(Action::PackageSelected(path)),
                    );
                }
                if matches!(action, Action::PackageSelected(_)) {
                    self.model.choosing_package = false;
                }
                let focus = matches!(action, Action::Escape | Action::Page(Page::Search));
                let moved = matches!(action, Action::Move(_));
                let request = self.model.update(action);
                let task = self.perform(request);
                if focus {
                    Task::batch([task, iced::widget::operation::focus("launcher-search")])
                } else if moved {
                    let offset = self.model.selected as f32
                        / self.model.results.len().saturating_sub(1).max(1) as f32;
                    Task::batch([
                        task,
                        iced::widget::operation::snap_to(
                            "launcher-results",
                            iced::widget::operation::RelativeOffset {
                                x: None,
                                y: Some(offset),
                            },
                        ),
                    ])
                } else {
                    task
                }
            }
            Message::Incoming(event) => {
                let Some(event) = event.lock().unwrap().take() else {
                    return Task::none();
                };
                match event {
                    AppEvent::Connected { session } => {
                        let request = self.model.connect(session);
                        let status =
                            self.model
                                .request("host.status", json!({}), ReplyKind::Status);
                        Task::batch([self.perform(Some(request)), self.perform(Some(status))])
                    }
                    AppEvent::Disconnected { message } => {
                        self.model.disconnect(message);
                        Task::none()
                    }
                    AppEvent::Query(value) => {
                        self.model.projection(value);
                        if self.model.page == Page::Activity {
                            let request = self.model.update(Action::RefreshCapabilities);
                            self.perform(request)
                        } else {
                            Task::none()
                        }
                    }
                    AppEvent::Diagnostics(entries) => {
                        for entry in entries {
                            self.model.log(entry);
                        }
                        Task::none()
                    }
                    AppEvent::Clipboard { text, reply } => {
                        let result = (|| {
                            if self.clipboard.is_none() {
                                self.clipboard =
                                    Some(arboard::Clipboard::new().map_err(|e| e.to_string())?);
                            }
                            self.clipboard
                                .as_mut()
                                .unwrap()
                                .set_text(text)
                                .map_err(|e| e.to_string())?;
                            Ok(json!({"committed":true}))
                        })();
                        if let Err(error) = &result {
                            self.model.log(format!("Clipboard write failed: {error}"));
                        }
                        let _ = reply.send(result);
                        Task::none()
                    }
                    AppEvent::Desktop { id, reply } => {
                        let result = if id == "toggle-theme" {
                            self.theme = if self.theme == Theme::TokyoNight {
                                Theme::Light
                            } else {
                                Theme::TokyoNight
                            };
                            Ok(json!({"committed":true,"message":"Theme changed"}))
                        } else {
                            Err(format!("Unknown desktop action: {id}"))
                        };
                        let _ = reply.send(result);
                        Task::none()
                    }
                    AppEvent::Screenshot { path, reply } => {
                        let target = Arc::new(Mutex::new(Some((path, reply))));
                        iced::window::latest()
                            .map(move |id| Message::ScreenshotWindow(id, target.clone()))
                    }
                    AppEvent::Shutdown => self.update(Message::Close),
                    AppEvent::UiControl { action, reply } => {
                        match self.model.control_action(action) {
                            Err(error) => {
                                let _ = reply.send(Err(error));
                                Task::none()
                            }
                            Ok(action) => {
                                let accepted = action.is_some();
                                let task = action
                                    .map(|action| self.update(Message::Ui(action)))
                                    .unwrap_or_else(Task::none);
                                let mut state = self.model.snapshot();
                                state["theme"] = json!(self.theme.to_string());
                                let _ = reply.send(Ok(json!({"accepted":accepted,"state":state})));
                                task
                            }
                        }
                    }
                }
            }
            Message::Key(keyboard::Event::KeyPressed { key, .. }) => match key.as_ref() {
                keyboard::Key::Named(keyboard::key::Named::ArrowDown) => {
                    self.update(Message::Ui(Action::Move(1)))
                }
                keyboard::Key::Named(keyboard::key::Named::ArrowUp) => {
                    self.update(Message::Ui(Action::Move(-1)))
                }
                keyboard::Key::Named(keyboard::key::Named::Enter) => {
                    self.update(Message::Ui(Action::Activate))
                }
                keyboard::Key::Named(keyboard::key::Named::Escape) => {
                    self.update(Message::Ui(Action::Escape))
                }
                _ => Task::none(),
            },
            Message::Key(_) => Task::none(),
            Message::Close => {
                self.model.notice = "Closing Host and draining work…".into();
                let handle = self.handle.clone();
                Task::perform(async move { handle.shutdown().await }, Message::Closed)
            }
            Message::Closed(Ok(())) => iced::exit(),
            Message::Closed(Err(error)) => {
                self.model.notice = format!("Shutdown failed: {error}");
                self.model.log(error);
                Task::none()
            }
            Message::ScreenshotWindow(Some(id), target) => iced::window::screenshot(id)
                .map(move |screenshot| Message::Captured(screenshot, target.clone())),
            Message::ScreenshotWindow(None, target) => {
                if let Some((_, reply)) = target.lock().unwrap().take() {
                    let _ = reply.send(Err("No native window available".into()));
                }
                Task::none()
            }
            Message::Captured(screenshot, target) => {
                let Some((path, reply)) = target.lock().unwrap().take() else {
                    return Task::none();
                };
                Task::perform(
                    async move {
                        let result =
                            tokio::task::spawn_blocking(move || save_screenshot(path, screenshot))
                                .await
                                .map_err(|error| error.to_string())
                                .and_then(|result| result);
                        let _ = reply.send(result.clone());
                        result
                    },
                    Message::ScreenshotSaved,
                )
            }
            Message::ScreenshotSaved(result) => {
                if let Err(error) = result {
                    self.model.log(format!("Screenshot failed: {error}"));
                }
                Task::none()
            }
            Message::WindowResized(size) => {
                self.model.window_size = size;
                Task::none()
            }
        }
    }
    fn view(&self) -> Element<'_, Message> {
        self.model.view().map(Message::Ui)
    }
    fn subscription(&self) -> Subscription<Message> {
        Subscription::batch([
            Subscription::run_with(self.events.clone(), events),
            keyboard::listen().map(Message::Key),
            iced::window::close_requests().map(|_| Message::Close),
            iced::window::resize_events().map(|(_, size)| Message::WindowResized(size)),
        ])
    }
}

fn save_screenshot(
    path: std::path::PathBuf,
    screenshot: iced::window::Screenshot,
) -> Result<Value, String> {
    use std::io::Write;
    // The supervisor selected the profile-local path. Refuse to follow an existing
    // file/symlink or silently overwrite earlier acceptance evidence.
    let file = std::fs::File::create_new(&path).map_err(|error| error.to_string())?;
    let mut output = std::io::BufWriter::new(file);
    let mut encoder = png::Encoder::new(&mut output, screenshot.size.width, screenshot.size.height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
    writer
        .write_image_data(&screenshot.rgba)
        .map_err(|error| error.to_string())?;
    writer.finish().map_err(|error| error.to_string())?;
    output.flush().map_err(|error| error.to_string())?;
    Ok(
        json!({"committed":true,"path":path,"width":screenshot.size.width,"height":screenshot.size.height,"scaleFactor":screenshot.scale_factor}),
    )
}

pub fn run(handle: AppHandle, receiver: mpsc::Receiver<AppEvent>) -> iced::Result {
    let events = EventSource(Arc::new(Mutex::new(Some(receiver))));
    iced::application(
        move || {
            (
                Ui {
                    model: Model::default(),
                    handle: handle.clone(),
                    events: events.clone(),
                    clipboard: None,
                    theme: Theme::TokyoNight,
                },
                iced::widget::operation::focus("launcher-search"),
            )
        },
        Ui::update,
        Ui::view,
    )
    .title("Pluxel Launcher")
    .subscription(Ui::subscription)
    .theme(|ui: &Ui| ui.theme.clone())
    .font(FONT)
    .default_font(Font::with_name(FONT_NAME))
    .window_size((760, 680))
    .window(iced::window::Settings {
        size: iced::Size::new(760.0, 680.0),
        min_size: Some(iced::Size::new(420.0, 480.0)),
        exit_on_close_request: false,
        ..Default::default()
    })
    .run()
}
