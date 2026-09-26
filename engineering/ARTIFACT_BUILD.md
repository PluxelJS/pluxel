# Workbench 与 Node 制品编译

修改 declaration lowering、renderer/Content/Node artifact、构建缓存或 candidate publication 时读本页。UI build primitive 位于 `@pluxel/rolldown/vite/workbench-ui`。作者调用见 [Workbench](../docs/workbench/index.md) 与 [Node artifacts](../docs/runtime/node-artifacts.md)；运行期所有权见 [WORKBENCH](WORKBENCH.md) 与 [HMR](HMR.md)。

| 任务                                     | 入口                                                          |
| ---------------------------------------- | ------------------------------------------------------------- |
| 声明、browser/server 隔离、native import | [Workbench source declaration](#workbench-source-declaration) |
| 开发缓存、后台构建、过期候选             | [Development compiler](#development-compiler)                 |
| Manifest/types、共享模块与生产 inventory | [Production build](#production-build)                         |

## Workbench source declaration

Declaration 用法见 [Workbench](../docs/workbench/index.md)。

Semantic pass 在 TypeScript 擦除前解析 `workbench.define()`、entry key、Content/View/Attachment kind，以及 literal
`workbench.markdown(import.meta.url, relativePath, slots?)` / `workbench.entry(import.meta.url, relativePath)`，再与 owning
canonical `PluginDefinitionAddress` 合成 declaration identity。
Markdown 由 build-time CommonMark/GFM + directive compiler 降为有界 portable AST；HTML、图片、相对/不安全链接、task list、
frontmatter、错误 slot topology 和不支持的语法 fail-fast。`data()`/`action()` 的静态 declaration 被 lower 为 slot metadata；真实
schema 只保留在 server module，不求值、不序列化。Markdown source 进入 watch graph，但不进入 server bundle 或 browser parser。
同一 Plugin definition 的全部 renderers 被 lower 成一个 `WorkbenchFederationProducerPlan`；每个 declaration 生成一个
stable `./views/<key>` expose 和 generated React Bridge entry。作者不声明 owner、remote name、expose、public path、
manifest URL、shared 或 Bridge wrapper。Content 独立编译为一个 definition-scoped immutable Content set；Content-only definition 的
producer 数为零，不启动 Federation builder，也不做 React/Mantine compatibility 检查。

Mixed Content/View 的 generated Bridge 只导入 renderer descriptor 的 identity projection，不导入完整 definition。Renderer 若直接
静态 import definition，toolchain 将该 import 改写到同一 projection；dynamic/indirect definition import 直接拒绝。Packaging sentinel
检查 JS、source map 与 dynamic types，确保 Content schema/handler 不进入 browser outputs，而不是依赖普通 tree-shaking。

UI entry 不进入 server bundle。反向边界同样成立：UI source graph 只能引用 browser-safe Workbench definition、
`capnweb` 类型、`@pluxel/workbench/react` 和公开 UI peers，不得包含 Plugin implementation、
Context、database handle 或 Node API。

### Node declarations 与 native owner

额外 Node entry 使用 module-level `defineNodeModule(import.meta.url, literal)`；`defineWorkerTask<Input, Output>()` 复用同一 artifact pipeline。作者操作见 [Node artifacts](../docs/runtime/node-artifacts.md)。

唯一的 `pluginArtifactBuildPlugin` 在同一次 server transform 中收集已 lower 的 Workbench producer/Content plans 与 Node
declarations。Node branch 输出 `dist/artifacts/node/<artifact-key>.mjs`；Workbench 和 Node 使用独立 identity、
source/build revision、validator 和 target config，只共享 build orchestration 与 bounded admission。`workbench: false`
完全跳过 renderer 与 Markdown compiler/accessor。

Production lowering、`pluginArtifactBuildPlugin` coordinator 与 Node artifact compiler 位于
`packages/rolldown/src/plugin-artifact/`。Workbench semantic lowering、MF validation/build primitive 位于
`src/workbench/` 与 `src/vite/`；Node 和 browser output 不共用运行时 identity。

Node artifact 必须是单文件 ESM，不得 value-import Pluxel runtime/core、CSS/browser asset 或嵌套 Pluxel declaration。
普通 JS/TS dependency 继续内联。唯一受控 residual 是 source graph 中某个 package 自己 direct
`dependencies` / `optionalDependencies` 声明，且 metadata 明确含 `napi`、`binary`、`gypfile` 或入口解析为 `.node` 的 native
package。所有权按发出该 import 的文件最近 package root 校验，而不是要求最外层插件重复声明传递依赖；未声明 native import
与同名多 entry 解析都会失败。构建器把静态 default/named native import 编译成 package-owner-aware bridge：产物先定位 entry
package，再沿 source graph 的 package chain 定位真正 owner，最后从 owner manifest 用 `createRequire` 加载 binding。这样 pnpm
strict layout 下也不会错误地从最外层 artifact 解析 Canvas 的私有依赖；dynamic/namespace/`export *` native import 会被明确拒绝。
artifact 的静态 import 仍只剩 Node builtins，`onNativeResidual` 继续报告 binding 给部署追踪。workspace build 优先使用
`@pluxel/hmr` source condition，发布包使用 `publishConfig` 的 default entry，两条图应用相同 validator。`defineNodeModule`
本身不定义 worker protocol；`defineWorkerTask` 的 default export contract 与调度生命周期由 `@pluxel/services/workers` 统一拥有。

## Development compiler

Runtime-dev compiler 对 Workbench 只接受 shared semantic pass 产生的完整 producer/Content plan：

1. 按 definition + build revision + build root 去重 task；
2. 收集 renderer 与 Markdown source graph，并把 graph/hash 与 plan 的 build revision 交叉验证；
3. 同步 materialize Content set，并快速复用内存或磁盘上已验证的 producer candidate；
4. 先提交 definition topology、Content 与已可用 producer；缺失 producer 会撤掉该 definition 的当前 federation
   pointer，但对应 View/Attachment placement 仍保留在 layout 中并显示 building 状态；
5. 缺失 producer 进入后台 build queue，使用持久 Vite/cache root；同一 cache root 的访问串行化，避免 DTS/Vite
   临时文件竞争；
6. 后台完成后确认该 plan 仍是最新 desired revision，再把 producer 与同一轮 Content candidate 作为完整 tuple 原子提交；
7. 后台失败时不提交 producer inventory，而是把对应 layout entry 更新为 failed 状态和安全错误 message；
8. 验证 Manifest/Snapshot、exact exposes/shared/runtime assets，以及 Content definition/content digest 和 portable plan；
9. 有界保留 disk cache，stale/superseded candidate 不再获得 commit authority。

Node module 继续拥有独立 watcher、content-addressed build、staged setup 和 last-known-good。Workbench producer 成功 commit
通过 session epoch invalidation 驱动 full document reload；producer-status-only 的 building/failed 展示可在同一 session
轻量刷新，但不做 Content-local reconnect 或页内 remote replacement。

Node 制品并发构建只共享编译任务；每个消费构建仍独立发布到自己的输出目录并接收 native residual 部署事实，不能因缓存命中跳过。
原生依赖桥接的相对路径按最终制品目录计算，缓存身份包含该目录到 package root 的相对布局，不能把缓存目录的位置烘焙进发行文件。

### 解析根与缓存身份

`workbench.entry(import.meta.url, './renderer.tsx')` 的 literal path 相对声明模块解析；lowering 从实际
definition/renderer module 收集 source graph，在 owning package root 的 `.pluxel/workbench-generated/` 生成 Bridge entry，
并把 package-relative entry 写入 producer plan。Builder 明确区分三个目录事实：producer root 解析 Bridge/source 与 producer
依赖；host application root 作为 Vite root，并决定 fixed shared winner、compatibility signature 与 MF export detection；两者的
最小公共祖先作为 TypeScript declaration `rootDir`，覆盖跨 workspace link 的 producer。这里不接受调用方目录列表、absolute
renderer declaration、runtime-module fallback、root override 或第二套 filesystem discovery。

## Production build

生产构建输出 `dist/workbench/<producer>/<revision>/mf-manifest.json`、`remoteEntry.js`、expose chunks、CSS 和 dynamic
types；Content 输出 `dist/workbench/content/<definition-digest>/<content-set-digest>/content-plan.json`。Root 分别写
`dist/workbench/pluxel-workbench-producers.json` 与 `dist/workbench/pluxel-workbench-content.json`。发布包和 static application
都消费预编译 Content inventory，因此 distribution 不要求保留原始 `src/*.md`。Cache/build revision 包含解析后的 UI 源码图、
实际命中的 package metadata 与 subpath、fixed shared compatibility set 和 compiler version；无关 workspace lockfile 内容不参与。
Builder 不接受调用方覆盖 Vite、shared、Bridge、并发或 cache policy。

Fixed shared、React ancestry 与 CSS 所有权见 [WORKBENCH](WORKBENCH.md#mf2-与-react-bridge)。Application root 必须解析全部 Shell-provided peers；producer 的 React/Workbench/Mantine 与 winner 精确一致。开发显式选择源码 exports，distribution 使用 built exports，不从目录或已有 dist 猜测。Production builder 按同一 build contract 生成 Shell 与 producer，并用 canonical plan/compatibility set 校验全部候选。

固定 shared 全部使用 `import: false`，producer 不携带 fallback。MF Vite 1.22.1 在真实 Mantine producer 中仍会遗漏
used-export facade 的命名导出；builder 因此在 expose analysis 前注入带内部 marker 的 bare side-effect import，
并在后置 transform 删除，确保完整 export surface。Marker 和 shared implementation 都不进入产物。移除此适配前必须
验证真实 Mantine producer，不能仅凭简化 export fixture 或上游发布说明判断问题已解决。

Dynamic types 使用 MF 2.9 的默认 `tsc`，不再把绝对 compiler executable 交给 package manager。开发 producer 默认省略
dynamic type artifact，只校验浏览器运行时 contract；显式 required 或 production producer 仍生成并校验 `api` 与 `zip`
类型资产。required DTS build 使用 producer-scoped `tsBuildInfoFile` 与串行 cache transaction，避免并发 producer 共享
MF 默认 cache 文件；production 中类型、Manifest 或 asset 缺失都使 candidate 失败。

Production producer 不输出内嵌源码 sourcemap；host-dev producer 保留 sourcemap 供开发诊断。

static freezer 无论 headless/workbench variant 都收集可达 Node artifacts，并在 `pluxel-deployment.json` 记录 key、
relative file 与 sha256；artifact builder 同时把受控 native residual 的已解析 entry 交给 NF3，因此只在 worker entry 中出现的
binding 也会被复制进 deployment `node_modules`。variant 只改变 browser Workbench closure。

`@pluxel/core/federation` 是唯一 dependency-neutral build contract。host-dev、Rolldown 和 host 直接依赖该
contract，不通过 runtime 转手 re-export，也不引入反向 build dependency。

## 验证边界

声明测试验证 exact identity、server-only schema/handler 不进入 browser assets、Content-only 零 MF、Node artifact 的 native owner chain。开发回归使用真实 Vite，覆盖双 producer、不同 application root、同 output/cache 排序、superseded build 与迟到结果拒绝。生产回归检查 Manifest/Snapshot、所有 digest inventory、dynamic types 和无 fallback shared；Node 制品还需从最终发行目录加载 native residual。
