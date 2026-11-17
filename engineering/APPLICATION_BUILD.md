# 应用交付构建

应用 preset 决定包边界、runtime closure 与最终部署目录。Plugin 声明由 [Toolchain](TOOLCHAIN.md)分析，独立 browser/Node 制品由 [Artifact Build](ARTIFACT_BUILD.md)生成，完整性和签名由 [Distribution](DISTRIBUTION.md)维护。

构建宿主为 `vite-plus/pack` 的 tsdown API，pluxel() 保持 tsdownConfig hook。`tsdown.config.ts` 拥有选项，`vite.config.ts.pack` 引用同配置；冷扫描不能提前加载框架产物的任务，在前置完成后通过 `scripts/pack.mjs` 调 build({ config: '`tsdown.config.ts`', watch: false })。vp pack --config 不选择独立 tsdown 配置。

同次编译生成 control/ 声明、闭包和配置源码。modules metadata 与 standalone bootstrap 分别绑定所属材料，运行端不安装源码编译器；规则见 [Plugin Control](PLUGIN_CONTROL.md)。

## 交付选择与 modules

pluxel({ delivery }) 默认 standalone；modules 保留真实包边界和目录来源。delivery 与 headless/workbench variant 独立，创建插件时校验并复制选项，后续修改原对象不影响异步构建。managedDatabaseDrivers/residualDependencies 只用于 standalone；生产启动由应用 launch 选择。

modules 复用共享 pipeline，不执行工厂。相对模块和 `package.json`#imports 指向的本地模块参与编译，外部 #imports/bare import 保持真实 package boundary，public source export 输出对应 ESM entry。app.mjs 默认导出应用工厂并保留 product/named exports，启动显式调用 `runHostApplication`。自定义 entryFileNames 需保持 .mjs；exports/server entry 来自真实 chunk。共享 parser 校验 application/bindings，静态 catalog 限制只用于 standalone。

manifest 声明 `artifactRoot`、Node/Workbench 能力和 modules 版本；`pluxel-modules.json` 记录本包编译的 definition、chunk/SHA-256。Native 在工厂解析时验证文件、边界与摘要，按实际已求值 owner 为本地 source-entry 绑定输出，canonical identity 保持原值。能力声明的 inventory 缺失/损坏则失败，运行期不回源码编译。

含 View/Attachment target 的 modules 按发布包规则验证 capnweb peer/dev/实际安装版，部署清单写 `pluxel.workbenchCapnweb`；headless 或无 target 不继承来源 marker。deployment kind 为 pluxel-modules-application、runtimeClosure 为 packages，经同一 finalizer 完成。依赖显式安装，runtime data 放在发行目录外；产物可搬移、删源码并只读运行。startup.root/sharedPackages 与持续更新的 Vite /run 用法见[生产构建](../docs/host/configuration.md#生产构建)。

## Static application freezer

standalone 由 pluxel() 在普通 tsdown entry/output 上生成 platform bootstrap。bootstrap 加载应用、装配 Host、绑定 provenance 后调用共享 `startHostApplication`，导出 host/ctx/start/stop 和应用显式 named exports。保留名冲突（含 alias/export *）在启动时检查 namespace，并在读取 deployment/求值工厂前拒绝。HTTP fetch/address/publicDir 由应用选择；prepare/start/close 逻辑仍归 Host。

freezer 接受直接默认导出的 `defineHostApplication`(factory)，factory 为同步/异步函数表达式，以直接对象或块中唯一无条件顶层 return 返回对象，返回对象无 spread。plugins 为直接数组或模块级 const/imported 数组，不依赖 startup 分支或任意函数求值。standalone 拒绝 sources，目录来源使用 modules。

静态数组在模块求值、工厂及 helper/callback 中须保持成员不变。检查器拒绝明显赋值、删除、mutator、别名和向 helper 传数组，允许 map/slice 等读取；跨模块副作用和 callback 仍由作者保持该约束，检查范围限可判定语法。

同图执行 macro、config metadata、lint、remote extraction 和 production preprocessor。wrapper 用 canonical entry namespace 读取 default application 和 product，沿原 export 语义处理 direct/local/re-export，不静态复制产品字段。fixed plugins/Core/runtime 进入 bundle closure，可 code-split，默认不得残留框架 deployment import。

官方 services/plugins 使用 production exports，对应 Services 发布 Workbench inventory；普通插件的 @pluxel/hmr/相对源码仍正常编译。optional ref 仅在 catalog/可达代码显式导入 provider 时带入实现，缺席 provider 不产生 chunk、virtual module 或 residual。

HTTP 真正进入闭包才配置 Elysia：从 Services HTTP 的 manifest 读取 public exports，将 Elysia/typebox/exact-mirror 合法子路径固定到同 bundle identity，schema 使用前调 `setupTypebox`。原生 id filter 限定相关 import，纯 Host 不解析 HTTP 依赖。

### 环境绑定与无求值投影

validator 解析直接 `envBindings` 数组，每项使用 Host `envBinding`(Plugin.nodeAddress(), { config?, vault?, namespace? })，Plugin 为静态 catalog 直接标识符。config/vault 显式提供 schema/mapping，mapping 是环境名字符串或 direct object tree。Vault 顶层为完整 record，可映射一个 JSON 变量或多个字段。

`.env.example` 仅输出名称、input type、schema 描述，构建不读取环境/凭据/fileBindings JSON。应用或 mapping 的 spread、computed/duplicate property、非 portable 环境名拒绝。Host 启动负责读取、解码和最终校验，优先级与 env 只读见 [Config](CONFIG.md)。

projector 复用 config source resolver，将显式 schema 还原成封闭 Valibot DSL，再调用 valibot-form 的 raw-input projector。它不执行工厂、模块副作用、validation/transform/default getter；不能安全还原/推导 transport 则失败。

共享 exact-source parse 缓存以 id/language/完整 bytes 为键，最多 256 个 AST；原始与 lowered source 可各自命中，错误 recovery AST 不缓存。pass 各自维护 semantics，不能修改共享 AST，也不复用其他版本或第三方 parser 的结果。

非空 binding 在 finalization 前写 root `.env.example`：按 UTF-8 bytes 排序去重，稳定聚合 fan-out 描述，placeholder 保持注释，编码 UTF-8+LF。该路径保留为 generated asset，已有 assembly input 冲突则失败；文件随普通 inventory 交付，不生成/加载 `.env`。

### Bundle 闭包与 residual packages

Node freezer 用 nf3 追踪 native/non-bundleable 或无法安全内联的 CJS/ESM package，复制到发行目录 node_modules。pg 保留真实 Node package boundary，以保持 pg-pool 构造器语义。当前只交付 Node application。

`managedDatabaseDrivers` 默认 PGlite+pg，可收窄部署 driver。未选 driver lower 为 absent module，避免无用分支进入闭包；启动配置选择未交付 driver 时在真实加载处失败。`sourcemapExcludeSources` 可省重复 `sourcesContent`，保留 stack mapping 的 path/name/mapping；完整源码归档由发行政策决定。

createRequire/native loader/运行期资源可在 `residualDependencies.packages` 显式声明；不能静态发现的动态资源用 fullTrace（隐含 packages）。从 application root 预解析，找不到即构建失败。显式追踪的独立 @pluxel 原生库可保留包布局；Core/Host 必须内联，直接 residual 或 trace 闭包带入副本均拒绝。实际闭包写入 deployment。

Native source resolver 使用 Node registerHooks/createRequire；运行期安装/制品 reader 的闭包不包含 OXC/Vite/Rolldown/chokidar。

### 装配、制品路径与 finalization

`pluxel-deployment.json` 记录 server entry、catalog hash、target/variant、Workbench/Content 与 residual。bootstrap 注入 deployment root，运行期据此读制品，目录不由 cwd/workspace 推断。

最终 assembly 调同一 distribution finalizer 生成确定性 `pluxel-distribution.json`；之后若再写 browser assets，显式运行 pluxel distribution create。inventory/DSSE/offline 验证见 [Distribution](DISTRIBUTION.md)。

| 制品           | 发行目录                                                                       |
| -------------- | ------------------------------------------------------------------------------ |
| Shell          | `workbench/public/`                                                            |
| MF producer    | `workbench/<producer>/<revision>/`                                             |
| Content        | `workbench/content/<definition-digest>/<content-set-digest>/content-plan.json` |
| Workbench 索引 | workbench/pluxel-workbench-producers.json、`pluxel-workbench-content.json`     |
| 独立业务 SPA   | `public/`                                                                      |

standalone 只收集固定 catalog 的 producer/Content，选择按 [Artifact Build](ARTIFACT_BUILD.md#production-build) 的 definition 绑定。variant 表达交付能力，启动是否安装 Workbench 仍由工厂决定；headless 使用独立 Node adapter，解析图不加载 Workbench backend。

### URL 与磁盘目录分离

Host-vite presenter 统一显示入口：有 publicOrigin 时 Application / 和 Workbench uiBasePath 同源，否则保留 Vite listener URL 并追加 mount。Workbench-only 占 / 时只显示实际 UI。

Shell browser URL 为 `/__pluxel/workbench/assets/**`，磁盘仍由 workbench/public inventory 供给；独立业务 public tree 保持自己的 namespace。Vite 仅在安装中有 Workbench source entry 时接入源码图，其他项目使用包内 built assets，不能生成只在 monorepo 成立的 /packages URL。

## 实现与验证

实现从 [`packages/rolldown/src/`](../packages/rolldown/src/) 的 pluxel preset、static validator、CLI assembly/finalizer 定位；环境投影在 rolldown/plugins/staticConfigEnvironment.ts 与 cli/static-config-environment-output.ts。

验证 static mutation 拒绝、schema 无求值、模板无值/secret、headless 无 Workbench、modules/source identity 和 residual。发行边界使用搬离 workspace 的产物启动真实所选服务；环境模板回归见 [`static-config-environment-output.test.ts`](../packages/rolldown/tests/static-config-environment-output.test.ts)，完整性见 [`distribution.test.ts`](../packages/rolldown/tests/distribution.test.ts)。
