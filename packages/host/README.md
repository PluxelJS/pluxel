# @pluxel/host

用显式服务清单组合插件宿主；省略清单时只安装 Core 能力。官方服务组合使用同一个 Host coordinator，并在其上安装服务与持久化策略。

```ts
import { pluginDefinitionAddressOf } from '@pluxel/core'
import { createHost } from '@pluxel/host'
import { MyPlugin } from './plugin.js'

const host = await createHost({
	plugins: [MyPlugin],
	state: {
		initial: {
			autoStart: [{ definition: pluginDefinitionAddressOf(MyPlugin), variant: 'default' }],
		},
	},
})

await host.start()
// 退出时先停止接收新操作，排空已经接纳的更新，再释放 Plugin generation 和 root effects。
await host.close()
```

`createHost()` 返回 Promise，完整校验服务声明和固定插件目录后创建 root，完成服务准备才返回宿主。`services` 是正向服务清单，省略时不安装附加服务。服务准备失败会释放已创建资源，并拒绝创建；不会返回半初始化的宿主。

服务作者从 `@pluxel/core/host` 定义 token 和同步 Context descriptor，使用 `defineHostService({ name, capabilities, requires, prepare })` 组织安装声明。`requires` 用 token 声明依赖，`prepare({ ctx, dependencies, effects })` 按该声明取得类型化的值；Host 不自动安装 provider。准备依赖必须能在 root 读取，不能使用 owner-only token。重复能力、属性冲突、缺失依赖和依赖循环都在工厂执行前拒绝。

声明可用于多个 Host；每个 Host 独立准备服务。资源获取放在 `prepare()`，成功后立即登记到该次调用的 `effects`，不要在安装声明求值时打开连接。Host 按依赖顺序准备，先停止 Plugin generation，再按相反顺序释放服务。各服务内部的 effects phase 不改变服务之间的清理顺序。`close()` 幂等并复用原来的 Promise；清理失败不阻止其他资源清理。

`configRecords: { initial, storage, mode }` 和 `state: { initial, storage, mode }` 支持借用文档存储；省略 storage 时使用内存，提供时默认 writable，可显式 readonly。已有记录优先于 initial；Host 关闭排空自己的写入，不关闭借用的 backend。完整示例见[组合 Host 服务](../../docs/reference/runtime-services.md)。

`plugins` 是完整的显式定义目录，`state.initial.autoStart` 是启动策略。未指定策略时不会自动启动目录中的插件；可以通过 `startNode()` 启动。
`updateCatalog()` 替换显式目录，并保留仍存在地址的运行意图。新定义必须经过 Pluxel 源码转换或来自已构建的插件产物。

动态发现由同包的 `@pluxel/host/dynamic` 提供。传入 `root`、`sources` 和 `loadModule(path)` 即可组合相同的宿主。Host 核心不创建 Vite，也不实现 Node 模块缓存；同包 `/dynamic` 负责文件发现，调用方的 loader 负责路径解析和更新后的模块身份。失败候选保留已提交目录，通过 `onSourceError` 报告；关闭时会先停止并释放来源监听。

`assertPluginSource(ctx, requirement)` 供 Package Manager 等来源生产者验证宿主是否声明了目标来源。它不创建来源会话，也不启动监听。

`/internal` 是服务端框架集成入口，不是 Plugin 作者 API。`/internal/protocol` 单独提供无 IO 的 execution/update snapshots 与验证函数，供浏览器和服务端共享；浏览器不能通过服务端 `/internal` 导入这些协议。

开发时使用 `@pluxel/host-dev/vite` 的 `host({ entry: './app.ts' })`。`app.ts` 默认导出 `defineConfig(factory)` 声明的配置工厂，Vite 接入负责加载模块和动态来源；应用声明无需自己传 loader。

```ts
// app.ts
import { defineConfig } from '@pluxel/host'
import { MyPlugin } from './plugin.js'

export default defineConfig(() => ({
	plugins: [MyPlugin],
}))
```

配置工厂每次创建 Host 时接收独立 startup，并同步或异步返回完整配置。`HostApplicationFactory` 表示工厂，`HostApplication` 表示返回对象；模块导入不执行工厂。

工厂 identity 变化（包含固定插件 import 更新）会创建新宿主；动态来源更新且工厂未变时在当前宿主内提交目录事务。失败候选不覆盖已接受的模块事实，修复缺失导入后会通过同一开发队列重新求值。

开发驱动会在来源 entry 重新发布时失效其已观察的 ESM 依赖闭包，并重新解析 package metadata。CommonJS 与 native 模块继续由 Node 执行：正常安装应发布新的不可变包路径；直接覆盖已经加载的 CommonJS/native 文件需要重启进程，不承诺清空 Node 全局模块缓存。

## 动态文件来源

```ts
import { dynamicSource } from '@pluxel/host/dynamic'

const sources = [
	dynamicSource({ kind: 'directory', path: '.pluxel/managed-plugins/entries', include: ['*.mjs'] }),
]
```

`dynamicSource()` 只校验并复制声明，不启动 IO。Host 打开来源会话后扫描并监听新增、修改、删除；尚不存在的目录可在启动后创建。路径相对于应用 root，include glob 必须留在声明目录内。来源只交付路径，加载与提交仍由 Host 和开发驱动负责。关闭会立即停止通知并等待 watcher 释放，重复关闭复用同一 Promise。

来源生产者从 `@pluxel/host/dynamic/source-producer` 调用 `requireDynamicPluginSource(ctx, declaration)`，在创建目录或安装包前确认 Host 已声明目标来源；此校验不授予修改 catalog 的权限。

原生生产加载支持初始 entry、新路径与撤回；已经求值的路径重新发布时返回 `PLUGIN_SOURCE_RESTART_REQUIRED`，需要重启进程。Node ESM 缓存无法靠给入口追加 query 完整刷新，开发更新交给 Vite 的同一个 Pluxel environment。

## 显式部署输入

插件继续通过任意命名的 `this.configs.use(schema)` 字段声明配置，包括普通 TypeScript
`private` 字段。需要部署绑定时导出同一个 schema 值，应用导入它，使用 helper 获得输入字段补全：

```ts
import { defineConfig, envBinding, fileBinding } from '@pluxel/host'
import { MyPlugin, ConfigSchema, CredentialRecords } from './plugin.js'

export default defineConfig(() => ({
	plugins: [MyPlugin],
	envBindings: [
		envBinding(MyPlugin, {
			config: { schema: ConfigSchema, mapping: { endpoint: 'APP_ENDPOINT' } },
			vault: { schema: CredentialRecords, mapping: { credentials: { token: 'APP_TOKEN' } } },
		}),
	],
	fileBindings: [
		fileBinding(MyPlugin, {
			config: { schema: ConfigSchema, path: './settings.json' },
		}),
	],
}))
```

不需要 `static configSchema`、`static vaultSchema` 或声明生成插件。配置 schema 只定义一次；
Host 首次解析时检查它与 `configs.use()` 提取的 schema 为同一对象。补全来自显式传入 schema
的 Input 类型，保留默认值前的可选性和 transform 前的字段；不会从 Plugin constructor 反推私有字段。

Vault 的根 schema 是应用固定的部署契约，验证记录名与完整记录，包括动态 `record` 的 key
约束。使用 `vault: { schema, paths: { credentials: './credentials.json' } }` 绑定 JSON 文件。
插件替换不会改变或重新执行这个固定部署 schema；修改契约需要重新加载应用。插件私有 KV
仍由业务代码验证，不受部署 schema 自动约束。

配置的文件值作为基础值，环境输入作为只读覆盖，不写回持久化配置。数组和嵌套动态对象应
使用一个环境变量传入完整 JSON；Vault 根层允许选择动态记录名。Vault 环境和文件输入均为
整条只读记录，缺少映射输入时拒绝启动，错误不会包含输入值。
