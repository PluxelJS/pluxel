# Plugin Identity、Source Canonicalization 与 Locator

> 状态：提案，尚未实现。本文不能覆盖当前
> [`PLUGIN_SYSTEM.md`](../PLUGIN_SYSTEM.md)、[`RUNTIME.md`](../RUNTIME.md) 与
> [`LOGGING.md`](../LOGGING.md) 的 API 事实。

## 问题

当前架构已经把 class name、constructor object 和 `displayName` 排除出 graph identity，并以
`PluginNodeSlot` 作为进程内身份、`PluginNodeAddressSnapshot` 作为跨进程和持久化身份。这个方向解决了同名
Plugin、fork、HMR constructor replacement 和持久状态误绑定，应该保留。

问题出在 address 的 `source-entry.source` 和面向人的 ID 被混为一种用途：

- semantic pass 目前用 host root 与模块路径生成相对 locator；`resolve()`、`relative()` 和 `/` 分隔符可以合并
  `.`、`..`、绝对/相对写法，但不会消除 symlink，也没有形成由 Core 验证的 canonical source grammar；
- Core 只能按 `source` 字符串 intern 和比较，因此两个字符串即使指向同一 filesystem entry，也可能成为两个
  Plugin definition；
- 完整结构化 address 适合 graph、control plane 和 persistence，不适合直接进入浏览器 path、日志标题或日常操作；
- catalog 当前可以把唯一的默认实例投影成 `rootExportName`，发生同名或 fork 时再追加 address digest。这个值可读，
  但它依赖当前 catalog 集合：后来加入同名 Plugin 会改变已有 Plugin 的 ID，不能成为 bookmark、缓存、日志关联或
  持久化协议。

本提案需要回答两个不同问题：什么是同一个 Plugin，以及人和 carrier 应该怎样引用它。它们不应共享一个裸字符串。

## 目标

- 同一 canonical module entry 的常见路径表达只生成一个 `source-entry` identity；
- package Plugin 继续以 canonical package root named export 为身份，不退回安装路径或 constructor identity；
- URL、CLI、GraphQL node ID 和可复制日志引用使用稳定、短、path-safe 的 locator；
- display name、package provenance 和 source provenance 可以改善可读性，但不参与 identity；
- runtime 热路径仍使用 interned slot，不引入 filesystem、全局 registry 或重复 hash 成本；
- 不把尚未实现的跨机器源码内容身份、npm version identity 或 inode identity 伪装成当前保证。

## 非目标

- 不让 Plugin 作者手写全局 ID；
- 不允许 package subpath、跨包 re-export 或 `displayName` 成为 definition identity；
- 不用 inode 合并 hard link。hard link 是两个合法目录项，inode 也不是可移植、可持久化的构建 identity；
- 不承诺 source tree 移动后仍保留同一 source Plugin identity；需要跨布局稳定性的 Plugin 应通过 package root 暴露；
- 不用 locator 替换持久化文件中的结构化 address。

## 建议模型

保留四个明确层级：

| 层级              | 形式                                              | 用途                                        | 稳定性                      |
| ----------------- | ------------------------------------------------- | ------------------------------------------- | --------------------------- |
| runtime identity  | interned `PluginNodeSlot`                         | graph、DI、lifecycle、owner binding         | 单个 root runtime           |
| canonical address | `PluginNodeAddressSnapshot`                       | control plane、persistence、跨进程精确匹配  | provenance 不变时稳定       |
| stable locator    | address 的版本化 path-safe encoding               | URL、GraphQL `id`、CLI 参数、可复制诊断引用 | 只由 canonical address 决定 |
| presentation      | `displayName`、export、package/source、fork label | UI 与日志文字                               | 可变化，不可 lookup         |

### Canonical address

结构保持当前含义：

```ts
type PluginDefinitionAddressSnapshot = {
	entry: { kind: 'package-root'; packageName: string } | { kind: 'source-entry'; source: string }
	exportName: string
}

type PluginNodeAddressSnapshot =
	| { definition: PluginDefinitionAddressSnapshot; instance: 'default' }
	| {
			definition: PluginDefinitionAddressSnapshot
			instance: 'fork'
			forkId: string
	  }
```

`package-root` 的 canonical key 是 canonical package name + root named export。包在 workspace 中通过 symlink、
store path 或发布产物被加载，都不能降级成物理安装路径。若未来必须同时加载同 package name 的多个版本，应另立
package provenance/version proposal；不能偷偷把版本或安装路径塞进现有 `packageName`。

`source-entry` 只表示没有 package-root provenance 的 host-local source。它的 `source` 必须是相对于 canonical host
source root 的 POSIX relative path，不允许绝对路径、反斜杠、空 segment、`.`、`..`、query、hash、NUL 或 filesystem URL。
虚拟测试模块不应借用 production `source-entry` grammar；测试 helper 应生成合法 fixture path，或以后引入明确的 internal
virtual provenance kind。

### Stable locator

新增一个 runtime/control-plane internal codec，而不是作者 API：

```ts
type PluginLocator = string & { readonly __pluginLocator: unique symbol }

pluginLocatorOf(address: PluginNodeAddressSnapshot): PluginLocator
parsePluginLocator(input: string): PluginLocator
```

首版建议采用版本前缀、可读 export hint 和足够长的 address digest，例如：

```text
p1-OrdersPlugin-k7QvN2w6H4m0J8rT2cX9aA
```

- digest 输入是 canonical address 的唯一版本化 binary/tuple encoding，不是普通 `JSON.stringify(object)`；
- digest 至少 128 bit，使用 base64url 或等价 path-safe 编码；
- export hint 先经过固定 ASCII slug 与长度限制，只用于诊断，解析和相等性只认版本与 digest；
- locator 对 default、fork、package-root 和 source-entry 使用同一规则；
- locator 不检查“当前是否冲突”后再变长。相同 address 永远得到相同 locator，catalog 新增条目不会改变旧 URL；
- catalog 建立 `locator -> structured address` 索引，并在极低概率 digest collision 时 fail-fast，而不是把请求路由到任意
  Plugin。若需要理论上的无碰撞协议，可改用完整 canonical encoding，但不能采用 catalog-dependent suffix。

包名适合作为 presentation provenance：例如 UI 显示 `CachePlugin — @acme/cache`。把包信息只在发生冲突时追加到
canonical ID 会让 ID 随 catalog 改变；把完整 scoped package name 永久塞进 path 又会重复 address、增加 escaping 问题。
因此它不作为 locator 的条件 suffix。UI 可以在同名时增强副标题，但 locator 保持不变。

`rootExportName` 单独作为短 alias 只能用于即时交互：当且仅当当前 catalog 唯一时，CLI 可以接受它并在歧义时报错列出
locator；它不能出现在 bookmark、GraphQL node identity、持久状态或服务间协议中。

## Source canonicalization

filesystem canonicalization 属于拥有 resolver 和 root 的 toolchain/route 边界，不能放进 Core parser。Core 不应执行 I/O，
也不知道 host root。建议建立一个 toolchain internal helper，并让 Vite、Rolldown、static 与 dynamic source route 共用：

```ts
canonicalizePluginSourceEntry({ resolvedModuleId, sourceRoot }): Promise<string>
```

算法约束：

1. 去掉 bundler query/hash，拒绝 NUL 与非 filesystem module ID；
2. 对 `sourceRoot` 和模块文件执行 native `realpath`，消除相对表达、dot segment 和 symlink；
3. 用 canonical root 到 canonical file 计算 relative path；文件必须严格位于 root 内；
4. 转为 POSIX `/`，拒绝空 segment、`.`、`..` 和反斜杠，并按平台实际 `realpath` 结果保留大小写；
5. semantic pass 的 definition、required edge、optional ref 和 HMR replacement 全部只消费这一结果；
6. package plan 一旦把模块映射为 `package-root`，不得再生成 source identity。

`realpath` 能合并 symlink 和常见不同路径表达，但不会合并 hard link；这是有意边界。大小写敏感性遵循实际 filesystem，
不能在 Linux 上盲目 lowercase。Unicode normalization 也不能在 Core 中擅自改变合法文件名；若目标平台要求 NFC，应在
distribution filesystem policy 中统一定义并验证。

为了避免 symlinked workspace package 的真实路径落到 host root 外，顺序必须是“先判断可信 package-root provenance，
否则再 canonicalize host-local source”。外部 source 不应以绝对路径兜底；static build fail-fast，dynamic source 必须由
其 source provider 提供稳定的逻辑 root 后再生成 relative locator。

Core 的 `parsePluginEntryAddress()` 只做纯结构验证，并拒绝非 canonical `source-entry`。它不能把两个非 canonical 输入
悄悄改写成同一个值，否则 persistence/config 中的错误来源会被隐藏。所有生产 address 必须在 toolchain 注入前已经 canonical。

## 各领域使用规则

### Graph、state、config 与 capabilities

- graph、Context 和 capability ownership 继续使用 slot；
- RuntimeState、config owner、log policy、Workbench preference 继续保存 structured address；
- physical database/schema/artifact namespace 可以使用统一 address digest helper，但不得把截断的 UI locator 当作唯一存储 key；
- 删除各包自行 `JSON.stringify()`、拼字符串或重复比较 address 的 helper，收敛到一个 canonical address codec。

### Workbench 与 HTTP

- catalog projection 同时返回 `locator`、structured `address` 和 presentation fields；
- 浏览器 `/plugins/:locator` 只携带 stable locator；layout/config/control 请求优先使用 locator，由 runtime catalog 在一次
  snapshot 中解析成 address；需要脱离 catalog 保存的 mutation payload 仍携带 structured address；
- 当前 `rootExportName` / collision-dependent digest ID 视为临时投影，实施本提案时替换，不为它建立长期兼容承诺；
- URL 不再编码 JSON address，也不把 scoped package 或 source path 拆成 route segment。

### Logging

- LogTape category 中的 machine identity 必须能稳定关联 canonical address；formatter 不直接把完整 source path 当作插件标题；
- runtime 为已知 catalog owner 投影 `displayName`、export 和 package/source provenance，推荐展示
  `Orders (@acme/orders)`，并提供 locator 作为可复制引用；
- filter、policy 和 store lookup 仍以 structured address/canonical codec 为准，不能按 display label 或短 alias 匹配；
- 若 category 最终只保存 digest，必须由 active runtime 的 address table 可逆解析并定义 unknown owner 行为；在此之前保留
  现有结构化 category 比引入第二套不完整 identity 更安全。

### CLI 与 diagnostics

- 输出优先显示 presentation label，附 stable locator；详细或 JSON 模式返回 structured address；
- 输入接受 exact locator；可以接受当前 catalog 唯一的 export alias，歧义时返回稳定错误并列出候选 package/source 与 locator；
- error message 面向人，程序分支继续依赖稳定 code，不依赖格式化 label。

## 为什么不撤销 address 重构

回到 class name 或手写 Plugin ID 会重新引入已经解决的问题：同名 package 冲突、constructor replacement 后身份变化、fork
字符串拼接、持久状态误绑定，以及 build/runtime 两套作者协议。真正需要修正的不是“结构化 address + interned slot”，而是：

1. `source-entry` 尚未在唯一 provenance 边界完成 filesystem canonicalization；
2. 完整 address 被误用为 UI/path 字符串；
3. 可读 alias 与稳定 locator 尚未分层；
4. address codec/key helper 分散在 Core、runtime、Workbench 和 persistence 中。

因此建议继续这套 identity 架构，但收紧路径模式并新增 locator projection；不建议再次把 identity 收缩成一个全局裸短 ID。

## 实施顺序

1. 在 toolchain 增加 source canonicalizer 与 fixture，覆盖 absolute/relative、`.`、`..`、symlink、query、Windows separator
   模拟、root escape 和 package-root 优先级；
2. 收紧 Core `source-entry` parser，并让所有测试 helper 生成 canonical source locator；
3. 提供唯一版本化 address codec、digest 和 stable locator，替换 runtime/workbench 私有 key 拼接；
4. catalog 同时投影 `locator` 与 presentation，Workbench route 和 GraphQL `id` 切换到 stable locator；
5. 调整日志 formatter 和 CLI，避免把完整 address 当作默认标题，同时保留 structured diagnostics；
6. 搜索并删除 JSON-in-path、catalog-dependent public ID、class/display lookup 和重复 address equality/key helper；
7. 更新 `engineering/PLUGIN_SYSTEM.md`、`RUNTIME.md`、`LOGGING.md`、`WORKBENCH.md` 与用户 docs，并为受影响 public package
   添加 Tegami changelog。

每一步都应能独立验证，不在 canonicalizer 尚未覆盖所有 route 时先收紧 Core parser。

## 验收条件

- 同一 host-local file 通过相对路径、绝对路径、dot segment 和 symlink 进入同一 build 时只得到一个 definition slot；
- source root 外文件不会产生包含机器绝对路径的 address；
- workspace/package symlink 仍得到 `package-root` identity；
- 新增同 export name Plugin 不改变已有 Plugin locator 或 bookmark；
- default 与 fork、同 export 不同 package、同 package 不同 export 的 locator 都不同；
- Workbench path、日志默认标题和 CLI 列表不泄漏 JSON address 或机器绝对路径；
- RuntimeState、config、log policy 和 Workbench preference 仍 round-trip structured address；
- 100,000-entry catalog 的 locator lookup 为预计算后的 O(1)，日志热路径不执行 filesystem I/O 或每条重新 hash。

## 未决问题

- 128-bit digest + runtime collision fail-fast 是否满足 locator contract，还是 locator 必须携带完整可逆 canonical encoding；
- dynamic source provider 的逻辑 root identity 是否已经足以跨重启稳定，还是需要在 `source-entry` 中显式加入 source namespace；
- locator 是 `@pluxel/core` 的 public codec、`@pluxel/runtime` 的 control-plane contract，还是先作为 internal API 验证；默认先
  internal，直到至少 Workbench、CLI 和日志三个真实调用方共享同一语义；
- GraphQL 现有 `id` 切换是否允许直接破坏式替换，或需要一个短期独立 `locator` field。仓库当前原则不鼓励长期 alias；
  实施时应根据已发布契约和真实调用方决定一次性迁移。
