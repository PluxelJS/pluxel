# Fonts 插件设计

`@pluxel/fonts` 是服务端渲染进程中字体事实与管理状态的唯一 owner。Canvas native backend 是
`@napi-rs/canvas` 的进程级 `GlobalFonts`；managed/caller sources 另外投影成 renderer-neutral portable bytes。

## 两类资源所有权

- provider-owned managed collection：Workbench 上传、删除、统一默认值和持久化全部属于 FontsPlugin。provider
  启动自动恢复 `managed/` 下的原子记录；损坏或无法注册会让 provider 启动失败，所有 renderer dependent 随正常
  graph 语义被阻塞。
- caller-owned programmatic registration：业务包随代码携带的字体可调用 `register()` / `registerFromPath()`，但
  native key 仍封装在 FontsPlugin 内。caller stop/replacement 自动删除，handle 只提供幂等提前 `dispose()`。

两类资源分别使用 `maxManagedFonts` 和 `maxRegistrationsPerConsumer`，不会让某个 renderer 的代码字体挤占统一上传
集合，也不会因 Canvas/ECharts stop 卸载所有 renderer 正在使用的 managed font。

provider restart、rollback 或 shutdown 会批量移除仍存活的 key，但绝不调用 `GlobalFonts.removeAll()`，因此不会破坏
系统字体或进程中不属于 Pluxel 的注册。`families` 是 detached snapshot，不是可修改 native registry。

## 系统发现、默认值与 revision

`@napi-rs/canvas` 在模块加载时通过平台 font manager 发现 Windows、macOS 与 Linux 系统/用户字体。Fonts 在每个
provider generation 启动时捕获 baseline，并在 `families[].source` 中区分后续 registration。不建立第二套目录
scanner/watcher；进程中后来安装的系统字体在 provider/process restart 后出现。

默认 family 解析顺序为：持久化 Workbench override、host `defaultFamily`、操作系统已安装字体优先表、
`sans-serif` generic。`defaultFont` 同时给出 raw family 与 CSS-safe family。选择 mutation 在 provider queue 中串行并
原子持久化；选择暂时不可用时保留 preference、运行期降级，family 重现后自动恢复。

默认选择放在 constructor 创建的稳定 state object，避免 caller-bound prototype view 的顶层 scalar assignment 变成
caller-local shadow。`revision` 跟随 FontsPlugin 管理的 native registration/default selection 变化，并由包模块共享以
反映进程级 `GlobalFonts`；renderer measurement cache 可据此丢弃旧宽度。外部直接修改 `GlobalFonts` 不在契约内。
`defaultFont` 与 detached `families` snapshot 按该 revision 缓存并冻结；重复 renderer 调用不再扫描 native registry，
registration/selection 变化仍会在下一次读取时原子生成新 snapshot。

## 可移植 renderer 资源

managed record 和 caller registration 保存内容寻址 source；同一 bytes + family alias 共享 portable ID/refcount。
`portableFonts` 只返回按 resource revision 缓存的 frozen metadata，`readPortableFont(id)` 才复制 bytes，避免 renderer
轮询 revision 时复制整个 collection。最后一个 registration 释放时撤销 source；provider stop 清除当前 generation
全部 source。System discovery 不暴露可信 file path/bytes，因此 system-only family 不进入 portable snapshot。

这条 contract 服务所有拥有独立 font registry 的 renderer，不暴露 `GlobalFonts` 或 Takumi type。没有为字体创建
Runtime Context special case：Fonts 仍是正常 Plugin capability，consumer 通过 required edge、caller facade 与 lifecycle
使用它。

## Workbench 与 Port

FontsPlugin 的正常 Workbench View 持有内部 manager RPC，只有这里提供上传和删除；完整 manager contract 不从包的
Workbench 子入口导出。`FontsSelectionPort` 是复用同一 renderer bundle 的窄投影：Canvas、ECharts 或第三方 consumer
选择 placement，绑定 `selectionManager()`，Port UI 只列出 FontsPlugin 的候选并修改统一默认值。
`selectionManager('portable')` 使用同一 contract，但只投影/接受真正拥有 portable source 的 family，供 Takumi 等
不能读取 Canvas system registry 的 renderer 使用。

因此 Port outlet 的 resource grant/placement 属于 consumer，字体集合与 mutation 实现仍属于 provider；关闭
Workbench 只消除 UI artifact、resource 和 transport，不影响 managed collection、默认选择或服务端渲染。

## 有意不包含

- per-renderer 上传集合；portable bytes 只在 consumer 明确 read 时生成 detached copy；
- Workbench 服务端路径选择、URL 下载或浏览器字体分发；
- `GlobalFonts`、`FontKey`、`removeAll()` 或可变 registry 的公开逃生口；
- 为单个 native backend 增加 runtime/core 特例。
