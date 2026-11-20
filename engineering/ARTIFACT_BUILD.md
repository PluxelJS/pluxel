# Workbench 与 Node 制品编译

Rolldown 将 server 声明编译为 browser producer/Content 和 Node artifact，Host 按已接纳 definition 读取制品。公开用法见 [Workbench](../docs/workbench/index.md) 与 [Node artifacts](../docs/plugin-development/node-artifacts.md)，运行/更新见 [Workbench](WORKBENCH.md) 与 [HMR](HMR.md)。UI build primitive 位于 `@pluxel/rolldown/vite/workbench-ui`。

## Workbench source declaration

semantic pass 在 TS 擦除前读取 workbench.define、entry key、kind，以及 literal markdown(import.meta.url, path, slots?)/entry(import.meta.url, path)，与 canonical definition 合成 identity。panel(region, options) 复用 author 纯准入，仅支持 left/right/bottom，将区域、标签、图标、排序投影到 View descriptor；Content/Attachment 保持自己的 placement。

Markdown 由 build-time CommonMark/GFM+directive compiler 生成有界 portable AST。HTML、图片、不安全/相对链接、task list、frontmatter、非法 slot topology 和不支持语法拒绝。data/action 只 lower metadata，真实 schema 留在 server；Markdown 加入 watch graph，但源码/parser 不交付 server/browser。

同 definition 的 renderer 合为一个 `WorkbenchFederationProducerPlan`，每项生成稳定 `./views/<key>` expose 与 React Bridge。Content 独立成为 definition-scoped immutable set；Content-only 不启动 MF builder、不检查 React/Mantine。生成器拥有 owner/remote/expose/public path/manifest/shared/Bridge，作者只声明业务。

Mixed Content/View 的 Bridge 只 import renderer identity projection。renderer 直接静态 import definition 时改写到 projection，dynamic/间接 import 拒绝。sentinel 检查 JS、source map、dynamic types，确保 schema/handler 不泄漏。UI entry 不进 server；browser graph 仅用 browser-safe definition、capnweb 类型、Workbench/react 和 UI peers，不带 Plugin implementation、Context、database 或 Node API。

### Node declarations 与 native owner

module-level `defineNodeModule(import.meta.url, literal)` 和 `defineWorkerTask<Input, Output>` 共用唯一 `pluginArtifactBuildPlugin`，在同次 server transform 收集已 lower plans/declarations。Node 输出 `dist/artifacts/node/<key>.mjs`，与 Workbench 分开 identity/revision/validator/target，只共享编排和有界接纳。`workbench: false` 跳过 renderer/Markdown compiler/accessor。

Node artifact 为单文件 ESM：普通 JS/TS 依赖内联，拒绝 Pluxel runtime/Core value import、CSS/browser asset 和嵌套声明。受控 native residual 必须由发出 import 的最近 package 在 direct dependencies/optionalDependencies 声明，并具有 napi/binary/gypfile 或 .node entry 证据。未声明与同名多 entry 解析拒绝。

static default/named native import 转为 owner-aware bridge：定位 entry package，沿源码 package chain 找实际 owner，再从 owner manifest createRequire。dynamic/namespace/export * native import 拒绝，最终静态 import 只留 Node builtins，`onNativeResidual` 向部署报告 binding。workspace 选 `@pluxel/hmr`、发布包选 publishConfig default，同用 validator。Worker 的 default export 与调度协议由 services/workers 拥有。

实现位于 [`plugin-artifact/`](../packages/rolldown/src/plugin-artifact/)、[`workbench/`](../packages/rolldown/src/workbench/) 与 [`vite/`](../packages/rolldown/src/vite/)。

## Development compiler

Workbench 编译仅消费 shared semantic pass 的完整 plan：

1. 按 definition/build revision/build root 去重，核对 renderer/Markdown graph hash 与 plan revision。
2. 同步 materialize Content，复用已验证 memory/disk producer；准备结果保持独立候选。
3. graph 接纳时同步提交 topology/Content/可用 producer。缺 producer 时撤旧 federation pointer，保留 placement 并显示 building。
4. 缺失 producer 后台构建；完成后核对 desired revision/epoch，作为 producer+同轮 Content tuple 原子提交；失败只发布 failed/message。
5. 校验 Manifest/Snapshot、exact exposes/shared/assets 和 Content digest/plan，进入有界 disk cache；stale/superseded 不能提交。

同 cache root 的 DTS/Vite transaction 串行，producer 成功提交使 session epoch 失效并整页 reload。building/failed 状态可轻量刷新；Content 不另设 reconnect 或页内 remote replacement。并发 slot/cohort 与接纳时点见 [HMR](HMR.md#构建并发与发布权限)。

Node 有独立 watcher、content-addressed build、staged setup 和 last-known-good。并发消费者可共享编译，每个消费构建仍独立写自己的输出并报告 residual。bridge 相对路径按最终 artifact 位置计算，output 到 package root 的布局进入缓存签名。

standalone 的 source resolution 选择 `@pluxel/hmr` 后仍执行 production lowering/conditions。部署根拥有已追踪 residual，bridge 从发行 root manifest 解析；普通包/开发继续 package owner chain。owner 模式和相对布局都进入签名。

### 解析根与缓存身份

entry literal 相对声明模块解析；lowering 在 owning package 的 `.pluxel/workbench-generated` 生成 Bridge，plan 保存 package-relative path。producer root 解析源码/依赖；application root 是 Vite root，决定 shared winner、compatibility signature、MF export detection；两者最小公共祖先作为声明 rootDir。入口、source graph 和 root 均来自真实解析，不接受第二套目录发现或 runtime fallback。

## Production build

| 输出                                               | 位置                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| producer manifest、remoteEntry、chunks、CSS、types | `dist/workbench/<producer>/<revision>/`                                             |
| Content plan                                       | `dist/workbench/content/<definition-digest>/<content-set-digest>/content-plan.json` |
| 根索引                                             | `dist/workbench/pluxel-workbench-producers.json`、`pluxel-workbench-content.json`   |

发布包和应用直接消费预编译 Content，不需 src/*.md。cache/build revision 包含已解析 UI 图、实际 metadata/subpath、fixed shared compatibility、compiler version，无关 lockfile 不参与。类型专用依赖以 manifest 参与，无需 JS 根；声明了 runtime 根则必须可解析。未安装 optionalDependencies（含断链）可跳过 runtime 解析但声明仍入 revision，实际源码 import 缺失仍报错。

standalone 选择精确固定 catalog：parser 保留 constructor lexical binding，semantic pass 从源码/已编译 ABI 映射 canonical definition，缺失或歧义失败。renderer/Markdown 读取前及 final assembly 都按该集合筛选；依赖 inventory 只接纳最终 server 模块中有 compiled ABI 的定义。本轮源码输出拥有对应 definition，其他 built definition 仍读其真实 owner，可在同包并存。未选 definition 不读取或复制制品树，已选 inventory 仍完整解析并验证 digest/collision；modules/插件包交付各自公开定义。

fixed shared/React ancestry/CSS 由 [Workbench](WORKBENCH.md#mf2-与-react-bridge)维护。application root 解析全部 Shell peers，producer 的 React/Workbench/Mantine 精确匹配 winner。开发用 source+development，生产源码用 source+production，distribution 用 built exports；builder 的 `packageMode: source` 明确选择路径，不按 dist 是否存在猜测。低层 builder 固定 Vite/shared/Bridge/并发/cache policy。

Rolldown 发布制品内联 Workbench transport 纯规则和 Host internal/shared-runtime metadata 叶子，不加载其 runtime。叶子检查 manifest/catalog/实际精确版本；Workbench target 与显式 TinyBase peer 的原生 Store 使用者生成版本事实，单用 Core 固定能力不标记。compile inputs 包含两个叶子与 owner manifest；能力 owner 的 manifest 定位 native 安装，无需其 JS 已构建。装配验证后共享 import 接 owner copy（TinyBase 为 Core），保留上游 subpath/环境条件。

全部 fixed shared 为 `import: false`，无 producer fallback。MF Vite used-export facade 曾遗漏真实 Mantine named exports：builder 在 expose analysis 前加内部 marker 的 bare side-effect import，后置删除，完整 shared surface/marker 均不打包。移除适配须以真实 Mantine producer 验证，即使升级上游也保留此边界。

Dynamic types 使用 MF 默认 tsc。开发默认省略，只验证 browser runtime；production/required 生成并验证 api/zip，缺 types/manifest/asset 即失败。required DTS 使用 producer-scoped `tsBuildInfoFile` 和串行 cache transaction。production 无 `sourcesContent` 内嵌源码 map，host-vite 保留开发 map。

Fonts 根入口保留静态 definition/publication，server DTO 仅在 RPC 快照读取时加载。纯 snapshot 类型单独维护，声明 shared chunk 不连 RPC；Typst 的 Fonts required constructor 仍为 direct value import。

### Node 输出选择

freezer 在 headless/workbench 都收集可达 Node artifacts，deployment 记录 key/file/SHA-256。native residual 从 bridge owner manifest 按 Node require 条件解析，再交 nf3 追踪实际 CJS/传递依赖，因此只在 worker 中出现的 binding 也能搬移运行。

compiler 把 artifact keys 写入 Rolldown module meta，builder/assembly 只选最终 rendered module 的引用，全部原始 module IDs 共同参与；query alias 被裁剪不覆盖仍存引用。source 引用读本轮输出，built 引用读实际 owner 的 inventory，不读取未引用旧 dist。source/built 同 key 必须 bytes 一致，未知目标文件也不能覆盖已选制品。

`@pluxel/core/federation` 是 Host-vite/Rolldown/Host 直接依赖的中立 build contract。

## 验证边界

声明回归覆盖 exact identity、browser 无 schema/handler、Content-only 零 MF、native owner chain。真实 Vite 验证双 producer/不同 root、同 output/cache 排序、superseded/迟到拒绝；生产验证 Manifest/Snapshot、digest、types、无 fallback，并从搬移后的发行目录加载 native residual。

## Loaded owner 的运行时读取

modules 的 `pluxel-modules.json` 记录编译 definition/chunk/SHA-256；工厂登记实际输出 URL，Host 在 service prepare 前验证。`artifactRoot` 只定位制品，不产生身份。

Node 的 `pluxel-node-artifacts.json` 即使为空也输出，Workbench 沿 producer/content inventory 验证。声明 nodeArtifacts/workbenchArtifacts 能力后，缺 inventory、坏摘要、重复或 realpath 越界均失败。未启用能力不创建 backend/compiler/watcher，native readers 不依赖 Vite/Rolldown，Vite 附件也使用同一 loaded owner。
