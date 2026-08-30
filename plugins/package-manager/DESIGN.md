# Package Manager 插件设计

## 所有权

```text
PackageManagerPlugin
  ├─ @pnpm/napi adapter + managed manifest/lockfile/node_modules
  ├─ package.install / package.remove commands
  ├─ owner-bound Direct View target + /packages route
  └─ atomic entries/*.mjs publication
                         │ file add/change/unlink
                         ▼
@pluxel/runtime-dynamic  OXC resolve -> execute -> core graph transaction -> HMR/unload
```

package acquisition 是可替换的产品策略；file-source lifecycle 是 dynamic route 的机制。两者只共享 ESM 文件协议。
runtime 不知道 registry、market、版本选择、lockfile、安装进度或管理 UI，package plugin 不调用 loader 或直接修改 running
plugin instance。

插件只允许在声明了 `rootDir/entries` 与 `['*.mjs']` 的 dynamic host generation 中运行。`init()` 先解析目标目录并通过
`@pluxel/runtime-dynamic/source-producer` 校验声明，之后才加载 `@pnpm/napi`、创建 managed project、发布 entry 或注册
commands/Workbench publication。校验只读取 route generation 的 resolved declaration，不扫描文件系统，也不返回 loader handle。

## Mutation model

`@pnpm/napi` 暴露 full-manifest `install()`，不是 selected `add/remove`。store 因而维护一个受控 private manifest：

1. parse 并去重一批输入；
2. 在 manifest copy 上应用 dependency change；
3. 把完整 in-memory manifest 交给一次 `install()`；adapter 使用 `ignorePackageManifest`，失败不会先改写持久 manifest；
4. install 成功后先确认全部 direct dependency 已 materialize，再原子写 manifest；
5. 全部 wrapper 内容准备完成后逐文件原子发布并删除 stale wrapper；
6. dynamic watcher 把文件变化合并为自己的 graph batch。

同一进程内 mutation 串行，避免两个 manifest transaction 相互覆盖。pnpm failure 保持先前 manifest 且不发布新 entry；若
engine 已完成而后续 filesystem publication 失败，持久 manifest 保留实际已安装 graph，下一次 operation/initialize 会重新
发布 entries。插件不暴露 `reinstall`：native `update: true` 是全图更新，
不能诚实实现 selected-package reinstall，也不能把已请求 range 静默改成 `latest`。

wrapper re-export named exports，并把 package default export 继续作为 default。它不注入 Pluxel metadata、不决定 auto-start policy 或 session lifecycle，
也不建立第二份 plugin inventory。可信 package source、catalog、lifecycle 和 status 仍由 runtime graph 投影。

## Capability 与 UI

业务路径是两个 owner-bound commands；Workbench Direct View target 只服务插件自己的管理页面。Runtime session protocol
不增加 package-specific method、DTO 或 navigation kind。插件停止/replacement 时 command registration 和 View publication
随 owner effects 撤销；已打开 target 的 signal 会 abort，新的调用由 owner admission gate 拒绝。Workbench disabled 不影响
headless commands 和 package store。

snapshot 只返回 package name、requested/installed version、entry filename、受管目录、engine version 和 native engine 明确
报告的 build-script dependency identifiers。不得返回 registry URL、auth header、proxy credential、pnpm raw event 或任意
config object。

## 安全与升级

默认 `ignoreScripts: true`、空 `allowBuilds`、24 小时 minimum release age、isolated node linker 和 auto peer install。
放宽 scripts 必须同时显式设置 `ignoreScripts: false` 和非空 exact package allow-list；矛盾配置在插件启动时失败。所有输入
必须是小写规范 npm package name 加 registry version/range/dist-tag；npm alias、path、URL、Git source 属于另一个
source producer，不借 package manager 绕过 workspace boundary。

NAPI 只从 `pnpm-engine.ts` 同步加载。预发布版本 shape 改变时，adapter fail-fast，不在 store、plugin 或 UI 散布兼容分支。
native engine callback 默认不转发日志，因为事件可能携带 registry/auth context；需要诊断时只能在 adapter 中挑选明确无敏感
信息的字段。

## 不变量

- 安装、auto-start policy、session lifecycle 和 observed lifecycle 是彼此独立的事实；
- package mutation 不直接调用 dynamic/core internals；
- dynamic runtime 不依赖 package-manager package；
- static/普通 test host 和 source 声明不匹配在任何 native/filesystem/UI 副作用前失败；
- failed install 不发布新 entry；
- successful source batch 由 dynamic runtime 统一触发 optional availability retry；
- Workbench 页面是插件自带的可选投影，不是 Management API 的 package-manager 特例；
- market discovery、登录、支付、审核和推荐都属于其他插件或服务。
