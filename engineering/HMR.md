# HMR：候选、提交与失败恢复

HMR 以 definition replacement 切换模块、Core generation、effects 和制品。首次源码求值失败保留 watcher 恢复；Host 创建、服务/应用 prepare 的致命失败则清理资源并拒绝 configureServer，CLI 不发布 ready。运行中的更新按下述提交边界结算。

## 开发批次调度

每个 Vite 实例有唯一调度器，默认 auto，最多执行一批。后续事件按 canonical path 合入 pending；超过 4096 个不同文件折为 full rescan，仍经正常来源/候选验证。

- pause 关闭自动接纳，等待当前批次；watcher 继续观察。
- apply 等当前批次后取得一份 pending，保持 paused。
- resume 等当前批次后恢复 auto，应用一份 pending。
- 执行期间的新观察留给下一批；失败意图放回 pending，仅新观察或显式操作再次触发。
- close 停止接纳、丢弃未执行 pending，排空已经开始的工作。

屏障位于应用求值、制品准备和 lifecycle commit 之前。source watcher 观察来源入口，dependency watcher 观察其他已求值依赖，Vite hotUpdate 对它们让出接纳权；恢复/制品事件也进同一入口。watchChange 失效仅表示观察。client React/CSS HMR、config restart 与请求 transform 继续由 Vite 管理。

dev console 直接控制调度器，不经脚本 loader/Host ready/scope；模式跨 Host replacement 保留，随 Vite 关闭释放。状态提供 mode/running/有界 pending/观察与尝试 revision，候选结果由 `application.latestUpdate` 提供。attempted revision 仅代表尝试；脚本遇运行时 pending 报 `hmr_pending`，不越过暂停。用法见[批次控制](../docs/development/dev-console.md#hmr-批次控制)。

`onUpdateSettled` 订阅路由拥有的同一报告，首次接纳前可用，排空后随 Vite 会话释放。异步 observer 的失败由开发诊断记录，候选事务独立结算。

来源可能先求值最新字节、后收到 SDK 通知。仅普通 update 已对应被接纳入口，且 physical owner/完整 entry/模块及已知依赖摘要均未变时可消费通知；新增/删除/rescan/失败恢复仍重新验证，相同字节不能绕过失败后的重新接纳。

## Definition replacement

invalidation unit 是 `PluginDefinitionSlot`，同 definition 的 default/forks 在同一 graph plan replacement，保留 node address/config。producer build 按 definition/declaration 共享，不含 forkId；node publication/lease 仍独立，见 [Identity](PLUGIN_IDENTITY.md#各领域作用域)。

```text
module batch → immutable catalog candidate → coordinator prepare
  → stop old consumer/provider closure → drain effects
  → commit topology/Content/可复用 producer → start new generations
  → publish definitions → 后台构建缺失 producer
  → 验证并提交 producer inventory → 关闭 session epoch → 整页 reload
```

驱动每 namespace 消费唯一 candidate，提交整批 catalog。Host 在旧 admission 仍开放时验证 role/collision/forkability/bindings/combined graph；catalog/Host revision race 丢弃 overlay 重 plan。结构拒绝保留旧 revision；首次关闭旧 admission 是 PONR，之后 drain/init 失败记为新 lifecycle facts。optional provider 的增删/替换也走同一 consumer closure。

post-commit start/config 失败不写 session stop 或删 autoStart。下次有效 replacement 启动仍在 desired graph 的失败节点/required consumers；显式 Stop 移出 desired，源码修复不得覆盖。catalog no-op 不强开事务，不建立 timer retry。

### 更新报告：批次与节点事实

Host internal `PluginRecentUpdateTracker` 保存 route 的进程内历史，Host/Management 读取同一 reader，宿主替换继续沿用。batch 记录 scope/outcome/phase/sequence/duration，lifecycle 仅含 exact `CommitSummary` 中该 node（含 fork）的 phase/kind/message/blockedBy，未观察完整报告为 null。空 issues 只表示该批未报告错误。

| batch outcome/phase                    | 发生时点                                      |
| -------------------------------------- | --------------------------------------------- |
| retained-previous                      | PONR 前 evaluate/artifacts/inject/commit 拒绝 |
| applied-with-issues / commit           | catalog 已接纳后的 rejection                  |
| applied-with-issues / lifecycle        | commit 返回但有 lifecycle issue               |
| restored-previous / application-reload | fresh compensation Host 成功启动              |

批次错误不广播为全部节点失败，新 fork 不继承同 definition 的其他节点错误。attempt 在开始时分配 sequence，即使无 Plugin 提交也保留 latest。updates.snapshot/follow 复用 Management session，首帧当前值，慢消费者合并最新，dispose 撤观察。

记录器有 definition/node 上限，先验证整条记录；同 sequence 替换诊断不能带入旧 node 错误，后续运行状态不改历史。前端错误仅有界 message、相对文件和已观察 import 链，原异常写本地日志；影响不明仅报 application。UI 的 lifecycle 红色提示只取 node issue，历史 batch.error 不被新批原因覆盖。

### 失败候选的恢复输入

已提交图与失败候选恢复依赖分开。Vite 解析记录 importer/specifier，失败后观察已解析新文件、缺失候选、相关 manifest；忽略安装目录和 root 外缺文件用仅限候选的补充 watcher。扫描根合并 containment，精确路径过滤保持；提交后释放补充观察。

动态 entry 在 import 前加入恢复集合。已有 active Host 时，语法修复只失效受影响模块。首次求值失败后的重试重新求值已观察的模块，确保此前已求值的其他入口也重新生成随失败候选回滚的语义事实。关闭停止接纳并排空错误回调。Database replacement 的 active instance/lineage 规则由 [Database](DATABASE.md#schema-evolution)拥有。

## Workbench candidate inputs

附件读取本批 `HostViteCatalog` 的确切 module closure 和所选 definitions；source lowering/compiled ABI 都是正向证据。只为选中定义准备制品，预编译按确切 owner 读 dist/workbench 并校验；未选 export 不要求制品目录，第三方 raw source 不因此获得 lowering。

候选统一 prepare，graph 接纳时同步 commit，结构拒绝保留旧 tuple，移除统一撤回。补偿在失败 semantic generation rollback 后使用已接纳 catalog identity 缓存的旧 source/package plans，不读同路径新 inventory。缓存只存计划，旧 bytes 被删/改仍需校验并可导致补偿失败。

## Canonical Vite module graph

每 ViteDevServer 的 pluxel environment 只有一个 ModuleRunner/evaluated namespace，应用、fixed/source anchors、脚本和普通 ESM 都从这里求值。默认 SSR/ssrLoadModule 保持独立配置、缓存和寿命，不接 Host conditions/singleton/collector。

Core/Host 是通用 singleton；`serviceSingletons` 另外固定 Services/Workbench，并在验证消费者精确 peer/dev/安装版本后，将 capnweb 接 Host、tinybase 原生子路径接 Core copy。纯 externalize 不能合并物理副本；私有 RPC/Store 保持自己的解析。共享校验归 Host internal/shared-runtime，应用直接 owner 的剩余问题见[严格契约提案](proposals/STRICT_CONTRACT_REVIEW.md#host-共享运行时的应用所有权)。public/internal/workspace path 按 import 条件命中同 ESM；Context 仅在 host 直接安装时 bridge。

物理分类顺序为 singleton→CJS/native 交 Node→workspace ESM 交 Vite。bare、alias、/@fs 同用 classifier，Vite 拥有解析，Host 不另设 resolver 或可配置 bridge policy。factory 返回前装配 fetchModule，Vite 先解析再分类；只登记 canonical 物理身份，保持公开 runnable 工厂/方法边界，不替换 server.close 或私有 transport。pluxel 工厂名由 Host 独占。

source conditions/noExternal 仅作用 Host environment。`resolve.tsconfigPaths` 默认开但尊重 false；browser builtin guard 按 Vite external 结果报错并允许显式浏览器实现，preprocessor/client decorator 配置见 [Toolchain](TOOLCHAIN.md#vite-与-typescript-配置)。React plugin 由应用显式安装一次；starter smoke 验证 refresh。反代转发同 listener/HMR socket，业务 SPA、Workbench/RPC/MF/HMR 同源，用各自 path/upgrade 仲裁。

### Source/built 分类的接纳与撤销

artifact classification 只有三态：exact raw lowering 得 source-module，active closure 中 exact ABI literal 得 built-module，其他/冲突为 unreported。扩展名、目录和未命中 transform 不产生证据。

transform/evaluate/classification 在候选 artifact generation 的异步 scope 内运行，接纳才 commit，失败 rollback。并发 ambient transform 独立；commit 按 module 的起始 ambient version 检查，不覆盖更新事实，rollback 也不撤它。已结束 generation 的 continuation 只能读 committed facts。

## 固定 catalog 与可选动态来源

host({ entry }) 以唯一 runner 加载 canonical factory，hotUpdate 只向批次调度器提交一次事件。Plugin 依赖精确失效 importer；factory identity 改变则 full-host replacement。来源变化但 factory 不变时复用配置，只提交 catalog transaction。compiled local source-entry 由 modules inventory 证明 owner，不改 identity。

全 Host replacement 先成功求值候选工厂，再因 single-active logging root 停旧 Host。新服务/prepare/start 抛错时先清理失败 Host，再用上次成功 factory/startup 快照创建 fresh compensation Host；成功才报 restored，失败且无 active Host 报 failed/application-reload。start 正常返回的局部 issue 保留新 Host 并逐节点报告。

execution 由执行入口给出闭合合同：native fixed 为 built-module/application-bundle，native source 为 built-module，均 next-start；Vite fixed/source 可 source-module/built-module，对应 host-reload/definition-hmr。未知低层入口整体 unreported；已知路径缺证据是错误。batch scope application/definitions 描述实际更新范围。

### 来源发现与资源所有权

初次启动时，`plugins` 提供的构造器和 `sources` 发现的实现提交到同一 catalog，图解析可见全部 required provider。应用工厂可以计算 `{ file }` 或 `{ directory, include }` 列表，Host 接纳时验证并快照，Vite 私有会话持有 watcher 并合并重复入口。来源文件变化按本次接纳的规则处理，工厂重求值可切换整组来源规则。按地址的 `pluginNodes` 在实现缺席期间保留节点输入。

SDK 初始 epoch 收入口事件，ready 后在原队列验证完整来源。后续通知按路径合并最多 4096，25 ms 窗口，同来源单个校验；溢出比对 Chokidar 实际观察与已校验集合。raw/discovery 通知只请求校验，不凭它接纳 SDK 未观察文件。

校验失败合回该批并保留同路径新事件，只有新观察/显式读取再试。entries() 串行取得一批、重验 physical owner 后返回，期间新通知留后批；不等待全局空闲。工厂独立重评也须 await entries，不以缓存旧/空 catalog 掩盖坏发布。close 丢未开始 pending，释放 timer，drain 已接纳 IO。

Host discovery 拒绝声明根/命中 entry 的 symlink，不遍历 symlink 子目录；允许父别名，open 时固定 canonical path 并传覆盖事实。materialized ancestor 改指路径报 `PLUGIN_SOURCE_PATH_CHANGED/file`，同声明 Host replacement 不重新绑定；恢复原路径或重启 Vite 会话可恢复，fresh Native 可解析现有别名。

私有 source/dependency/recovery watchers 统一 100 ms polling/atomic，不用 awaitWriteFinish。Chokidar 环境覆盖只允许 USEPOLLING 省略/true/1、INTERVAL 省略/100，冲突明确拒绝，不改进程环境。关闭停止接纳、drain callback/discovery、释放 polling。

resolution/扫描以 application root 为基准，不 process.chdir；Plugin 明确按 cwd 解释的路径仍属 launcher cwd，应通过绝对数据路径消除歧义。producer 自己拥有 acquisition/registry/lock/install/RPC/UI，只原子发布 ESM entry；接纳后的唯一 catalog 为 Host snapshot。

### 关闭与生产边界

关闭顺序：停止 watcher/batch/direct 接纳→等待已接纳 startup→丢未开始 debounce→drain batch/direct warmup/Content refresh 共享 lane→Core cleanup→Vite hooks→`ModuleRunner` close。已接纳 Content 可完成原子发布但不再 browser reload；关闭后才取得 lane 的 direct call 抛 `HmrClosedError`，不访问 baseline/semantic/executor。

附件 `prepareCandidate` 可异步，`commit/rollback` 必须同步返回 undefined，`tracks` 必须同步 boolean。坏返回附附件/文件失败；已经产生的异步工作由原 effects 排空并保留 rejection。接纳时捕获方法/receiver，后来改方法别名不改变已接纳操作。

生产 /run 先关 Host，再插件 hooks 和 runner/server，持续清理并聚合原错，重复关闭同 Promise，startup/abort 同一路径。自有开发 bootstrap 用 `closeHostViteSession(server)` 关闭同 owner，再关 Vite/借用 bindings；无会话返回 undefined。

Native 每次启动仅扫描预编译来源，next-start，无 watcher。Vite /run 为 live production profile，强制发布条件，HTTP 由 Services，不公开 Vite middleware；拒绝 dev console/source Shell。production 用 native config loader，保持 token 身份且不写 .vite-temp。browser HMR 关闭后 dependency watcher 继续覆盖已求值普通 ESM，不扫未知插件/改变来源；built public 由已验证 factory 的 Elysia dispatcher 提供。

## Workbench producer build

服务附件只在 Workbench enabled 时装 UI source provider，Node provider 独立。semantic pass 一次生成完整 plan；compiler 不重新发现或计算 revision，位于 packages/workbench/src/development/。

每 transform 在异步前取得更新身份，publication/import facts 随模块候选一起替换，ambient version 防迟到覆盖。失败保留 committed facts，解析 Promise 仅活本次；删除/改普通模块撤 publication。Bridge/projection 目录含 build revision，不能覆盖旧 plan 正在引用的文件。

### 构建并发与发布权限

同 producer task 去重，新 plan supersede 旧 build。MF 当前进程两个 slots：同 application root 最多并发两个，不同 root 按到达顺序 cohort，切换前排空，后来的同 root 不能跨越等待中的其他 root。Node 独立两个 slots；同 output transaction 始终排序。

prepare 验 topology/Content，不改 current 或取消已接受后台工作。Core 接纳点同步激活，推进 publication epoch，再启动缺 producer；后台完成复查 epoch，旧结果不可提交。初启/纯 Content 共用 prepare/commit；可用 producer 快速复用。日志只报实际 build 或 disk reused 的 revision/耗时，memory hit 静默，失败保留原错。

Manifest/Snapshot/exposes/assets/shared/Bridge 规则见 [Workbench](WORKBENCH.md#mf2-与-react-bridge)，开发 building/failed 保留 placement，production 要求 types。编译缓存、目录和产物由 [Artifact Build](ARTIFACT_BUILD.md#development-compiler)拥有。

## Browser update policy

producer inventory 或 publication epoch 改变后：server 失效 session→Shell destroy Bridge/dispose handles→完整刷新→新 socket 认证/layout→加载 pinned manifest 和 fresh roots。连续刷新递增等待，10 秒达 3 次暂停并保留手动入口。认证撤回/broken 不自动刷。

保留 URL/持久布局，未保存草稿由页面自行保存。Shell source 传播到 document entry 时先释放 root/session 再导航，普通组件仍走 Vite HMR。旧 document 不注册新 remote/fallback；failed candidate 不推进 producer inventory，已接纳 topology 的 building/failed 可由 registry revision 更新。

## Node module update

NodeModules.use 对 consumer 串行 staged setup，新 setup 成功才 cleanup previous，失败保留 last-known-good。owner stop 失效 pending，迟到 setup 立即 cleanup。Worker 新 dispatch 读 content-addressed 新 URL，已运行任务保持原 module；取消/stop 等真实 worker 退出。

## 验证

[`projects/host-targets`](../projects/host-targets/README.md) 用同一个发布 tarball 验证三端运行，开发验收通过各自的更新通知驱动同一个页面。Node 业务路由借用已接纳实例，Vite 批次结算后通知页面。浏览器由页面重建 Dedicated Worker，Cloudflare Worker 通过 Vite 的 `import.meta.hot.accept` 接纳插件模块，再通知页面请求。三端的更新和状态寿命可从 generation 与调用结果观察。

重点覆盖 structural reject、PONR 后真实 facts、definition-wide forks/required/optional closure、显式 Stop、候选 rollback、迟到 producer 和 fresh-host compensation。真实 Vite 验 namespace、来源恢复/provenance、watcher close/drain、暂停最终编辑、执行中新观察、失败修复、auto 合并和 pending 上界；控制命令不被自身 replacement 撤回。DTO 验相对诊断和节点归因，browser/Node 在各自真实资源边界验证。

具体入口：packages/host-vite/tests 的 hmr-control、initial-source-recovery、environment-inputs，以及 Services 的 `tests/installed/plugin.smoke.mjs`。后者验证运行时 wrapper 新增、传递依赖替换、删除、包安装/升级/失败保留/卸载；发现入口后仍服从 auto-start/session intent。

## Development console execution

项目脚本使用同 runner，经真实 watcher 确认依赖再等有限已接纳更新序列。paused pending 拒绝，执行不锁整个 coordinator；replacement 撤旧 scope，后续 run 取新 epoch，HMR 控制仍绑定 Vite。完整责任见 [Dev Console](DEV_CONSOLE.md)。

## 来源观察失败

watcher/recovery/watchChange 错误在同队列结算并记 application attempt，不改 Plugin lifecycle 历史；候选已报告的失败只记日志，避免重复 sequence。最新成功可替换记录，此记录不承担持续 watcher 健康或重建。

候选 semantic scope 计算 provenance，committed catalog 发布；补偿在 rollback 后使用旧 facts/制品输入，旧 bytes 消失则报告失败。物理 node_modules 只采正向 compiled ABI，不启第三方 lowering。Shell source 通过 workbenchSourceShell 显式接当前 Vite 图，entry/React/CSS 由应用提供，见 [Workbench](WORKBENCH.md#host-http-与-shell-开发)。

## 实现边界

host 内部拥有候选/失效/恢复，`HostVitePluginApi` 附件参与原生命周期。renderer semantic reject 报 retained-previous/artifacts；已接受 plan 的后台失败才报 producer failed，两者都保留原错。

wrapper 重发按实际文件摘要只失效变化模块/importers，共享未变依赖保留 namespace。整批 resolver/classifier 清一次，Vite graph/runner 闭包各共用 visited，防重复失效。仅已加载、dependency watcher 覆盖且非恢复输入的字节相同迟到通知可在事务前忽略；未知/缺失/读错仍正常处理，来源校验不跳过。

## 观察与生产配置的接纳边界

新 dependency watcher ready 才切观察集合，打开失败关候选/保旧，同集合可显式重试。close 同时释放 active/opening watcher 并 drain 回调。

production /run 在全部 config hooks 后验证 `middlewareMode`、browser HMR、`NODE_ENV` define，冲突拒绝启动；host 未知顶层字段也拒绝，保留用户配置与拼写诊断。
