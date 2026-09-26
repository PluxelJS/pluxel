# 静态应用构建

修改应用冻结、环境模板、Node bundle 闭包或部署装配时读本页。Plugin 声明语义由 [TOOLCHAIN](TOOLCHAIN.md) 拥有，browser/Node 独立制品由 [ARTIFACT_BUILD](ARTIFACT_BUILD.md) 拥有，最终 inventory/签名由 [DISTRIBUTION](DISTRIBUTION.md) 拥有。

## Static application freezer

static application 使用 `@pluxel/rolldown` 的 `pluxel()` tsdown 插件；入口与输出归普通 tsdown 配置。用法见 [构建部署](../docs/development/distribution.md)。

freezer 接受直接默认导出的 `defineHostApplication(factory)`。工厂是同步或异步的箭头/函数表达式，直接返回对象，或在块中以唯一、无条件的顶层 `return` 返回对象。返回对象不允许 spread。`plugins` 使用直接数组或模块级 const/imported 数组，不能依赖 startup 分支或函数调用；构建不会执行工厂或静态求值任意 JavaScript。它在同一 graph 中执行 macro、config metadata、lint、Workbench
remote extraction 和 production preprocessing，然后生成以 canonical entry 为 namespace import 的 platform bootstrap。Wrapper
从 module namespace 消费 default application，并用 runtime shared reader 消费可选 `product` named export；它不按 identifier
猜测 export、不静态求值 product，也不把产品字段复制进 deployment metadata。direct export、local export 与标准 re-export
因此具有相同语义。fixed plugins、runtime 和可达的
runtime/core 默认属于 application bundle closure；code splitting 允许，但输出不得残留 `@pluxel/*` deployment import。
静态插件清单是部署合同：模块声明与导入的数组在模块求值、配置工厂执行及其 helper/callback 中都必须保持原始成员，不能通过赋值、别名、mutator 或动态 import 追加插件。检查器拒绝工厂中的明显赋值、删除、mutator、引用别名和向 helper 传递数组；允许 `map`、`slice` 等读取，但作者仍须保证 callback 没有修改原数组。该检查只覆盖有限语法，不做跨模块副作用分析，也不证明任意 JavaScript 的清单完整性。需要可变插件时使用显式 `sources` 来源合同。

optional ref 不产生实现 import；只有 host fixed catalog 或其他可达代码显式引入的 provider 才进入 application closure。
缺席的 optional provider 不产生 chunk、virtual absent module、nf3 residual 或 deployment external。

bootstrap 在 host namespace 求值前先加载 static Elysia wiring。freezer 从 Services HTTP 所有的 Elysia manifest 读取全部显式 public
exports，并把 Elysia subpath、TypeBox 的 type/system/value/schema/compile namespace 与 `exact-mirror` 固定到同一 bundle identity；
随后调用 Elysia 公开 `setupTypebox()`。因此 source-linked Plugin 不能带入第二份 Elysia，搬离 workspace 的 schema-backed
distribution 也不依赖相对生成 chunk 的同步 module lookup。resolve hook 使用原生 id filter，非相关 graph import 不进入该插件。

### 环境绑定与无求值投影

同一个 static entry validator 解析可选 `envBindings`。它是直接数组，每项调用从 `@pluxel/host` 导入的 `envBinding(Plugin, { config?, vault?, namespace? })`；
`Plugin` 是静态目录中的直接标识符，config/vault 各自声明 `schema` 与 `mapping`。工具链解析显式 schema 引用，
不读取 Plugin 静态 schema 字段。mapping 是环境变量名字字符串或直接 object tree。Vault 顶层 key 对应完整凭据 record，可映射为一个 JSON
变量或多个字段变量。生成 `.env.example` 只包含变量名、输入类型与 schema 描述，不包含环境值或凭据默认值。
`fileBindings` 只在实际 Host 启动时读取 JSON 文件；构建不打开或复制这些文件，不把凭据烘焙进制品。

应用对象与映射的 spread、computed/duplicate property、非 portable 环境名直接拒绝；静态解析不执行工厂、Plugin 模块副作用、
validation、transform 或 default getter。环境值是否存在、解码及最终校验归 Host 启动。配置优先级与 env 路径只读规则见
[`CONFIG.md`](CONFIG.md)，Vault record 的来源和撤销规则由 Vault 服务负责。

Production projector 复用 config source resolver，把绑定中显式引用的 schema 还原为封闭的 Valibot schema DSL，再调用
`valibot-form` 的同一个 raw-input projector；它不执行 canonical application、配置工厂、Plugin module side effect、validation、
transform 或 default getter。无法安全静态还原或无法推导 transport 的 target 使 build 失败，不回退 string/JSON heuristic。

Plugin semantics、config source 与 route-specific validator 都只读 AST，并通过 `pluginUtils` 的 exact-source 有界缓存复用同一
module parse。缓存键包含 id、language 与完整 source bytes，原始源码和 lowering 后源码可以同时命中，全局最多保留 256 个 parse；
源码变化必须使用对应的新 AST，语法错误的 recovery AST 不进入缓存。各 pass 仍独立拥有自己的 semantic facts，不能修改共享 AST。
这不承诺复用 Rolldown/Vite 内部或第三方插件的 parser，也不跨不同源码版本复用 AST。

Binding 非空时 assembly 在 distribution finalization 前写 root `.env.example`。Environment name 按 UTF-8 bytes 排序并去重，
fan-out target 的 description/input facts 稳定聚合；placeholder 保持注释状态。文件编码为 UTF-8 + LF，不读取 build environment，
不输出 schema default/secret，不生成或加载 `.env`。该路径是 generated asset 保留路径；已有 assembly input 冲突时失败，文件作为
普通 asset 自然进入 distribution inventory，不修改 deployment/distribution manifest schema。

### Bundle 闭包与 residual packages

Node target 用 `nf3` externalize 并追踪 native/non-bundleable 或无法安全跨 CommonJS/ESM 边界内联的 residual packages，
复制到 distribution 自己的 `node_modules`。PostgreSQL `pg` 属于后一类：freezer 保留它的 Node package boundary，避免改变
`pg-pool` 的 CommonJS 构造器语义。这只是 bundler 无法安全内联部分的 fallback，不是部署端 package install 模式。当前
freezer 只发布 Node application；在提供真正 platform-neutral 的 runtime/service closure 前，不生成伪 neutral Worker bundle。
Managed database driver 默认同时追踪 PGlite 与 `pg`；`managedDatabaseDrivers` 可以按 deployment 收窄实际复制的 driver。
未选择的 driver 被 lowering 成明确 absent module，使 dead runtime branch 不会反向进入 bundle 或留下 unresolved external；
选择与 startup config 不一致会在真正加载 driver 时明确失败，而不是从 build config 猜测或改写 canonical 配置工厂。
Production source map 可用 `sourcemapExcludeSources` 省略重复的 `sourcesContent`，仍保留 Node stack mapping 所需的
source path、name 和 mapping；是否另存完整源码归档由 deployment/release policy 决定。

Host 来源 resolver 只在真正执行 module resolution 时通过 `createRequire()` 加载 OXC native binding。普通 static
application 虽然会从 runtime root 消费作者 API，但 tree-shake 后不得残留无调用者的 `oxc-resolver` side-effect import，
也不得让 NF3 把其 native binding 复制进发行物。

应用自己的 Node package 若通过 `createRequire()`、原生 binding loader 或运行时资源路径加载，可以在
`residualDependencies.packages` 中声明；freezer 会从 application root 预解析并交给 NFT 追踪，即使它不在 ESM module graph
中也会进入 distribution。无法由 NFT 静态发现的 package 内动态资源使用 `residualDependencies.fullTrace`，该列表自动隐含
`packages`。显式声明但无法解析的 package 必须使构建失败；最终实际闭包仍以 `pluxel-deployment.json` 为准。

### 装配、制品路径与 finalization

`pluxel-deployment.json` 记录 server entry、catalog hash、target、variant、Workbench MF producer/Content inventory 与 residual package facts。
runtime 以 bootstrap 注入的 deployment root 读取产物，不从 workspace package root 或 `process.cwd()` 推断。

同一 final assembly 的最后一步调用 `@pluxel/rolldown/distribution` 生成确定性 `pluxel-distribution.json`。如果外部任务之后继续写入
目录，必须用 `pluxel distribution create` 调用同一 finalizer。完整 inventory、DSSE、offline verification 和 marker 不变量见
[`DISTRIBUTION.md`](DISTRIBUTION.md)。

Workbench Shell、producer 和 Content plan 是 browser-facing outputs，不内联进 server chunk。Shell 使用
`workbench/public/`，producer 使用 `workbench/<producer>/<revision>/`，Content 使用
`workbench/content/<definition-digest>/<content-set-digest>/content-plan.json`；Workbench root 分别写唯一
`pluxel-workbench-producers.json` 与 `pluxel-workbench-content.json`。业务 SPA 可以独立输出到 `public/`，不会覆盖这些 inventory。
`variant: 'workbench'`
表示产物具备能力；是否在某次启动安装 Workbench 仍由 application 配置工厂 返回值决定。
headless 与 workbench 使用分离的 internal Node adapter；headless dependency graph 不解析 Workbench installer/backend，
不是只依赖 minifier 删除未用分支。

### URL 与磁盘目录分离

开发 route 的 URL 输出由 `host-dev` 的共享 presenter 负责，static/dynamic 不各自推断 ingress。存在 Portless origin 时它显示同一
origin 上的 Application `/` 与 Workbench `uiBasePath`；没有 Portless 时保留 Vite 原生 listener URL，并只追加 Workbench mount。
Workbench-only host 若让 UI 拥有 `/`，不得虚构第二个 Application root。

Workbench Shell 的 browser asset URL 使用 `/__pluxel/workbench/assets/**`；磁盘仍由 distribution 内部的 `workbench/public/`
inventory 提供。URL namespace 与 artifact filesystem layout 不耦合，也不得退回会与产品 public tree 竞争的 `/dist/public/**`。
Vite 只有在当前安装中确实存在 Workbench source entry 时才接入它的 client graph；独立消费 workspace 使用
`@pluxel/workbench` 随包交付的 built assets，不能生成只在 Pluxel monorepo 内成立的 源码 workspace 的 `/packages/**` URL。

## 实现与验证

实现从 `packages/rolldown/src/` 的 `pluxel()` preset、static application validator、CLI assembly 与 distribution finalizer 定位；环境投影位于 `rolldown/plugins/staticConfigEnvironment.ts` 和 `cli/static-config-environment-output.ts`。使用 [inspect](../docs/development/inspection.md) 核对实际应用输入，再沿 preset 调用定位装配阶段。

验证静态清单非法 mutation、schema 无求值、环境模板不含值/secret、headless 不加载 Workbench、动态来源 facade 身份与 native residual 完整性。最终用搬离 workspace 的产物启动并检查 HTTP/所选服务；source-mode 单元测试不能替代发行验证。`.env.example` 回归见 `packages/rolldown/tests/static-config-environment-output.test.ts`，完整性回归见 `packages/rolldown/tests/distribution.test.ts`。
