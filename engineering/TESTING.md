# 测试设施与验证边界

作者用法见[插件测试](../docs/plugin-development/testing.md)。测试设施复用生产 Host、compiler 和服务；本页记录它们的组合、关闭和任务缓存规则。

## Boundary selection

| 行为                                  | 验证入口                            |
| ------------------------------------- | ----------------------------------- |
| 普通领域函数/对象                     | 直接调用                            |
| 纯 Cap’n Web target                   | 原生 RpcStub 与资源协议             |
| Plugin DI、配置、lifecycle、服务      | `@pluxel/test`，显式选 services     |
| Core graph 内核                       | `@pluxel/core/internal/test`        |
| 应用 wiring                           | 固定 catalog 的装配测试             |
| 来源、HMR、carrier/browser/deployment | 对应真实 launcher、Vite、连接或制品 |

在拥有行为的最小边界断言一次；增加 carrier/browser 只用于它们自身的风险。public test host 不暴露 root/transaction/backend，Core 不反向依赖作者组合包；当前在线状态由既有[开发控制台](../docs/development/dev-console.md)检查。

## Unified author test host

`@pluxel/test.createTestHost()` 异步组合生产 `createHost`，services 默认 []，按需显式组合单项安装器。name/coreConfig/policy/config/vaultBindings 保持生产语义，Core 内建 FS、TinyBase 与 Vault；FS 默认 InMemory，`coreConfig.zenfs` 选择持久 backend，`config.document` 和 `policy.document` 控制文档读写。

作者 Host 与 Core `createCoreTestHost` 都以源码 `Plugin.nodeAddress(forkId?)` 选择节点。Core testing/test-primitives 在规范化前从私有 WeakMap 取 constructor，验证 identity/当前实现后交原候选装配；JSON/parse、生成地址、复制/其他 Core 副本不能提供实现，replacement 后旧地址仍 stale。字面量 batch 保留准确实例元组。

constructor 仅用于 catalog.add/remove、replaceDefinition、全局 provider default 等实现声明；override 的 consumer/provider 用源码节点地址，重复按 identity+精确实现判断。raw graph harness 的白盒 constructor 装配属于内部测试。

`workbench: true` 增加 Management、测试 backend 和本地 RPC driver，需显式 HTTP，与 `management: false` 冲突。关闭 Workbench 不初始化 backend；HTTP/commands driver 调真实已安装服务，缺失失败。服务声明与 installer 分离，使无服务 Host 不加载可选 Commands runtime。

无显式产物来源的 Node 服务接正式按需源码 compiler，组合层拥有其关闭；显式 artifact source 保持制品路径。Vitest plugin 只影响 test module graph，独立 Node artifact 自己编译。test 包声明实际安装依赖，生产包不依赖 test。

测试 draft 只负责断言、目标和同步回调作用域，写入/graph commit 仍由 Host。driver 拥有 body/RPC handle/lease，泄漏在关闭时报告并继续其余清理。关闭先同步拒收、drain invocation，再经 `beforeClose` 释放 Workbench lease，最后关 body/graph/services。内部 fixture 从 services/internal/test 导入。

## Vitest preset and bootstrap

`@pluxel/test/vitest` 的 definePluxelVitestConfig 是唯一 preset，原生 Vite/Vitest 配置在顶层，source lowering/extraction 参数在 pluxel namespace。

配置模块先于 resolve.conditions 求值，因此 source overlay 的任务先执行 pluxel source build `--package` `@pluxel/test`，再从正式 export 加载 preset。只构建该 owner 的真实前置（含 Services/Workbench 发布入口），不预构整个 source closure；构建不表示服务初始化。配置加载后 preset 为测试图设置 `@pluxel/source`、`@pluxel/hmr`。

SSR 条件会进 worker Node --conditions；不得全局加入 import，Node 需按每次 import/require 选择分支，否则 pg 等 CJS 内部会误载 ESM。[`packages/test/tests/vitest.test.ts`](../packages/test/tests/vitest.test.ts) 在真实 Vitest worker 中以原生 require 验证分支选择。

## 回归取舍与验证所有权

保留测试前，先明确哪条契约失效时调用方会看到什么结果。由拥有该行为的入口验证，例如重启后旧句柄拒绝调用、文件写入失败后已确认内容仍可读。相同前提和结果用一个场景验证，失败阶段、资源归属或传输方式引入独立风险时再增加用例。

- 重用同一组前置和资源来验证一个完整的操作序列。纯函数可以用表格覆盖代表输入。涉及进程、构建产物或 Host 的契约使用对应真实边界。
- 性能用代表性负载衡量。图和缓存的功能回归断言结果，内部索引、遍历次数和缓存布局可随实现调整。
- 用应用结果、事件或可控的 Promise 等待状态变化。只在验证超时或定时调度本身时推进测试时钟，外部文件和跨进程变更等待可观察的结果。
- 纯类型放 tests/*.typecheck.ts，由包含 tests 的 typecheck 验证；preset 行为执行真实配置，不扫描源码猜 API。
- 编译归 Rolldown，CLI 测真实 bin/产物，协议复用生产 adapter；连接/背压/关闭在 carrier 验证。
- exports/依赖/目录政策归 [Governance](GOVERNANCE.md)；迁移完成后删除专用旧符号检查。
- 模板/独立安装走对应 smoke，不用 manifest 文本代替行为。
- start/require 返回 raw instance；caller attribution/admission/withdrawal 需真实 Consumer dependency。
- Host 用 await using，RPC lease 用 using；操作结算后直接断言，仅外部 eventual observation 用 expect.poll。

## CI scheduling and cache

任务所有权见 [CLI 工作区任务图](CLI_WORKSPACES.md#工作区任务图)。本地迭代使用[局部验证](../docs/development/workspace-toolchain.md#局部验证)。CI 直接执行 `workspace:ci`，Vite Task 根据真实输入缓存；本地完整入口是 `workspace:verify`。双核 runner 并发两个 package tasks，日志保留任务耗时、命中和冷构建成本，真实 Redis/Vite/子进程集成随所属任务运行。

### 缓存输入与输出

cache 在当前 checkout 的 `node_modules/.vite/task-cache`，worktree 独立，CI 按键复用。repositoryTasks 默认排除本任务 outputs；显式 inputs 接管过滤时，排自己生成目录，保留依赖产物/前阶段输出/真实读写输入。否定 glob 优先，不能靠后续肯定重新纳入；分阶段展开后再应用默认。

Core、Host 和 Services 的库构建缓存排除包内 `tests/`。这些文件由各包的测试和类型检查任务读取。

不同产物各有 task/output，用依赖相连。Vite Task 将 && 拆为缓存步骤，CSS 生成不能与后续 pack 共用 dist/**，避免恢复覆盖/叠旧文件。消费本包发布制品的 test 显式依赖本包 build，失败/超时子进程也须回收。governance 用真实 vp run 验证冷恢复、source/dependency 变化、阶段输入和输出内保留输入。

嵌套 vendor Vitest 5 缓存按最近 lockfile 失效，根依赖/patch 更新后旧模块可用 `vp run --ignore-depends-on --no-cache @worksplit/react#check-tests --clearCache` 清理所属缓存，再正常测试。

Worksplit react/split-view/demo 为根成员，原生补丁由根 patchedDependencies 应用；`vp run worksplit:native:check` 在源码 build 后检查 Shell/Typst 实际安装、唯一实例和全部补丁文件，消费者 build/dev 也检查。导航/布局/草稿关闭仍走宿主验收，支持版本和移除条件见 [Worksplit](../vendor/split-like-vscode/docs/navigation-support.md)。

### 文档与浏览器示例

docs build/dev 共用 `prepare:docs`，准备 Core/Host/Services/valibot-form/Typst 浏览器库/Takumi Markdown/Playground 类型。Typst 仅 compile-lib，依赖前置准备 Context/Eventure 声明。Twoslash 用 source conditions，其他依赖声明仍需构建，直接 import 的包须列 docs 依赖；完整 docs 交 Vite Task 缓存，不另缓存仅以示例文本为键的类型结果。

[`projects/docs/tests/typst.browser.mjs`](../projects/docs/tests/typst.browser.mjs) 由 `vp run pluxel-docs#test:examples --url <Examples URL>` 对已运行 dev/production 页面验收。默认连接已有 Playwright `ws://127.0.0.1:3000`，可用 --ws/PLAYWRIGHT_WS_ENDPOINT 指定，`--artifacts` 保存截图。只释放自己 context/连接；不安装浏览器或关闭共享服务。

Examples 使用同一真实 Host/Typst WASM Worker。浏览器验收覆盖冷启动 WASM 延迟、编辑自动编译、离线页宽/SVG 变化、模板语法恢复、停止/重启、中文、编辑/预览双向定位和旧预览禁跳；主题切换核对 catalog 的 Theme replacement、Report restart、Typst 保留，且正文/undo/redo、Worker 和 WASM/字体请求保持。页面检查入口导航、桌面主编辑区、手机无横向溢出、热替换视图和深色截图，无源码 POST。详细 oracle 由测试脚本维护，Typst `check-wasm` 是较短生命周期回归。

Studio 已移至 [Pluxel Lab](https://github.com/PluxelJS/lab)，其测试与原生构建由消费仓维护；历史宿主验收见 [Worksplit 记录](records/worksplit-adoption.md)。

### Core benchmark

[`scripts/core-bench-compare.sh`](../scripts/core-bench-compare.sh) 用 Node 24 对比指定 base/head 的真实 workload/scenario；workload 变化需新基线，不兼容报告失败。两个 revision 独立 worktree/install，按包内 Pack 配置依次构建 Eventure/Context/Core，避免历史整仓任务加载无关未构建插件。当前未提交内容和制品不参与。Core/Context/场景/依赖构建变化触发比较，仅 tests/Markdown 不触发完整对比。

修改 shared test surface、export、runner config 或 Host close 后，运行直接 owner test/typecheck，再按受影响边界选择更外层验证。
