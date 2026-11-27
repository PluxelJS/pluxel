# 插件的 Paraglide JS 国际化规范与编译工具提案

> 当前实现沿用工作区的 Paraglide 3。Inlang Message Format 支持单个路径或路径数组，开发与生产共用经 Rolldown 验证的 `locale-modules`。以下保留设计提案，现行契约见[插件国际化](../../docs/plugin-development/i18n.md)和[工具链](../TOOLCHAIN.md#paraglide)。

本提案收敛 Pluxel 接入 `@inlang/paraglide-js` v2 的用户面 API、目录规范与 Rolldown/Vite 编译和 HMR 机制。整体定位是**面向插件包的统一编译期工具能力**，**不新增运行时 `I18n` / `Locale` Host Service，也不把 i18n 渗透进 Core、Host、Config 或 Commands 的公共 API**。架构分层总原则见 [Plugin 系统：能力归属边界](../PLUGIN_SYSTEM.md#能力归属边界)。

## 1. 现状盘点：仓库里已有半成品原型

`@pluxel/rolldown` 当前已经内置了 `@inlang/paraglide-js` 依赖和一份早期原型 [paraglide.ts](../../packages/rolldown/src/vite/paraglide.ts)，但目前只接进了 Workbench producer 构建，且存在几处明确缺口：

1. **只接了 Workbench 构建，未接服务端与开发期**：[plugin-build.ts](../../packages/rolldown/src/cli/plugin-build.ts#L73-L115)（`pluxel build`）与 `vitePreset()` 服务端环境尚未接入，插件服务端源码无法使用 Paraglide。
2. **输出污染 `src/`**：[paraglide.ts](../../packages/rolldown/src/vite/paraglide.ts#L8) 默认输出到 `src/paraglide`，会把生成文件与声明写进源码树，与[仓库治理](../GOVERNANCE.md#L96)「生成声明只进入 dist 或可清理缓存」冲突。
3. **跨包相对路径缺陷**：[workbench-ui.ts](../../packages/rolldown/src/vite/workbench-ui.ts#L111-L128) 把相对路径 `./project.inlang` 与 `./src/paraglide` 传给 [workbench-vite-build.ts](../../packages/rolldown/src/vite/workbench-vite-build.ts#L50)，而后者 Vite 的 `root` 是 `applicationRoot`，构建 workspace 子包插件时会解析错目录。
4. **HMR 与缓存未联动**：[semantic-lowering.ts](../../packages/rolldown/src/workbench/semantic-lowering.ts#L2027-L2159) 的 `buildRevisionFor` 未将 `project.inlang` 与 `messages/*.json` 计入 `buildRevision` 和 `sources`，导致开发期编辑翻译文件不会触发 [workbenchArtifacts](../../packages/workbench/src/vite.ts#L116) 重建，也不会使 MF2 缓存失效。
5. **未固化跨平台安全参数**：直接调用 `paraglideVitePlugin({ project, outdir })` 会沿用上游默认 `strategy` 和 `disableAsyncLocalStorage: false`，可能向跨平台插件产物泄漏 `node:async_hooks` 与模块级全局语言状态。

---

## 2. 为什么不用 `defineI18n(import.meta.url, ...)` 顶层声明函数？

Pluxel 对 Workbench、Database 和 Node 制品都使用了顶层声明函数（`workbench.define(import.meta.url, ...)`、`defineDatabase({ schema })`、`defineNodeModule(import.meta.url, './entry.ts')`），但 **Paraglide i18n 不适合照搬这种写法**，原因有两点：

1. **TypeScript 类型来源不同**：`workbench.define` 的 RPC 类型来自作者写的 TS `interface`，`defineDatabase` 的表类型来自 Drizzle TS `schema`；而 Paraglide 的词条名和 `{param}` 参数全部来自 **`messages/*.json`**。`tsc --noEmit` 与 IDE 补全不运行 Rolldown 插件，只能读取落盘的生成声明（`.d.ts`）。如果作者已经通过生成模块导入强类型 `m.*`，再要求写一遍 `defineI18n(import.meta.url, ...)` 只会制造双份冗余声明。
2. **没有运行期 Host 身份与独立制品清单**：Workbench View、Node worker 和数据库迁移都需要 Host 按 canonical Plugin definition 接管生命周期与独立制品目录；Paraglide 编译出的只是普通静态 JS 函数，打包时直接按函数粒度 tree-shake 并内联进插件自身的 ESM 产物（`dist/index.mjs` 或 MF2 chunk），运行期对 Host 完全透明。

因此，**遵循上游标准目录约定 + 包内 `#i18n` subpath imports + Rolldown/Vite 按包自动编译与监听**，比新增 `defineI18n()` 更贴合 TypeScript 类型系统与上游工具生态（inlang CLI / IDE 插件可直接识别）。

---

## 3. 插件作者规范与最终用户面 API

### 3.1 包目录与 `package.json` 规范

遵循 inlang 官方默认约定：插件包根放置 `project.inlang/settings.json`，翻译文件默认放在 `messages/{locale}.json`（推荐在单文件 JSON 内使用嵌套对象分组，大插件可按上游 `@inlang/plugin-message-format` 的路径数组 `pathPattern` 拆分到 `messages/{locale}/*.json`）。**工具链以 `project.inlang/settings.json` 中的 `pathPattern` 为唯一事实来源**，不硬编码仅扫描 `messages/*.json`。

```text
my-plugin/
├── project.inlang/
│   └── settings.json          # 唯一事实来源：baseLocale、locales、modules、pathPattern
├── messages/
│   ├── en.json                # 默认约定，支持 JSON 嵌套对象（如 { "rules": { "empty": "..." } }）
│   └── zh-CN.json
├── .pluxel/
│   └── i18n/                  # 工具链生成（.gitignore 与 check-source-declarations 均已忽略）
│       ├── index.js           # 极薄入口：重导出 m、locales、baseLocale、isLocale 与 resolveLocale
│       ├── index.d.ts
│       ├── messages.js        # Paraglide 生成消息入口
│       └── runtime.js         # disableAsyncLocalStorage: true, strategy: ['baseLocale']
├── package.json
└── src/
    ├── index.ts
    └── ui/manager.tsx
```

标准 `project.inlang/settings.json` 模板（同时兼容 Sherlock VS Code 扩展与 `inlang check`）：

```json
{
	"$schema": "https://inlang.com/schema/project-settings",
	"baseLocale": "en",
	"locales": ["en", "zh-CN"],
	"modules": [
		"https://cdn.jsdelivr.net/npm/@inlang/plugin-message-format@latest/dist/index.js",
		"https://cdn.jsdelivr.net/npm/@inlang/plugin-m-function-matcher@latest/dist/index.js"
	],
	"plugin.inlang.messageFormat": {
		"pathPattern": "./messages/{locale}.json"
	}
}
```

插件 `package.json` 声明包内私有 subpath imports（仓库 `tsconfig.json` 已启用 `moduleResolution: "bundler"`，且治理脚本与 `check-source-declarations` 天然放行 `#i18n` 与 `.pluxel/`）：

```json
{
	"imports": {
		"#i18n": "./.pluxel/i18n/index.js",
		"#i18n/messages": "./.pluxel/i18n/messages.js"
	}
}
```

### 3.2 工具链生成的 `#i18n` 公开契约

编译产物 `.pluxel/i18n/index.js`（及对应 `index.d.ts`）保留 Paraglide 原生调用面，**不另包 `t(m.foo)` 之类的间接调用 wrapper**——否则会破坏 `@inlang/plugin-m-function-matcher` 与 Sherlock 的行内翻译预览、编辑及未使用词条检查：

```ts
export * as m from './messages.js'
export { baseLocale, isLocale, locales, type Locale } from './runtime.js'

/**
 * 将任意开放 BCP-47 字符串（如宿主 host.locale、Accept-Language 命中值）
 * 确定性地规范化并收窄为本插件支持的 Locale 字面量联合类型。
 * 匹配顺序：isLocale 精确匹配 → 标准化大小写/分隔符 → 逐段去 script/region 前缀回退 → baseLocale。
 */
export function resolveLocale(requested?: string | null): Locale
```

### 3.3 插件代码的实际写法（100% 原生 Paraglide + Sherlock 可识别）

**场景 A：Workbench React View（复用既有 `host.locale`，切换语言实时刷新）**

```tsx
import { m, resolveLocale } from '#i18n'
import { scope } from './scope'

export default scope.render(function PermissionsManager() {
	const { host } = scope.useWorkbench()
	const locale = resolveLocale(host.locale)

	return (
		<section>
			<h1>{m.permissions_title({}, { locale })}</h1>
			<p>{m['groups.count']({ count: 3 }, { locale })}</p>
		</section>
	)
})
```

**场景 B：服务端插件方法（显式传入业务 `locale`，并发与跨平台安全）**

```ts
import { m, resolveLocale } from '#i18n'

export function formatSummary(action: string, count: number, requestedLocale?: string) {
	const opt = { locale: resolveLocale(requestedLocale) }
	return `${m.permission_denied({ action }, opt)} (${m['groups.count']({ count }, opt)})`
}
```

---

## 4. Rolldown / Vite 编译与 HMR 机制

所有入口统一复用 `@pluxel/rolldown` 内的同一个包级编译器 `compilePluxelParaglide(packageRoot)`，按 `packageRoot`（而非单一应用 `root`）隔离构建，因此多插件 monorepo、独立插件包与宿主应用共用同一逻辑：

1. **统一编译选项（强约束）**：
   - 读取 `resolve(packageRoot, 'project.inlang/settings.json')` 并解析 `plugin.inlang.messageFormat.pathPattern`（单个路径字符串或路径数组）得到真实的源翻译文件集合；
   - 使用基于 `packageRoot` 的**绝对路径**调用 `@inlang/paraglide-js` 的 `compile()`：
     - `project: resolve(packageRoot, 'project.inlang')`
     - `outdir: resolve(packageRoot, '.pluxel/i18n')`
     - `strategy: ['baseLocale']`
     - `disableAsyncLocalStorage: true`
     - `emitTsDeclarations: true`
     - `outputStructure`：开发期优先 `'locale-modules'`（写入文件数为 O(语言数)，减少大量词条下的 HMR IO）；生产打包使用 `'message-modules'`（或经 Rolldown 实测确认等价后统一），确保函数级 tree-shaking；
   - 写入确定性的 `.pluxel/i18n/index.js` 与 `index.d.ts`（字节未变不改写 mtime），并对同一 `packageRoot` 做并发 single-flight。
2. **首次类型准备与 `pluxel build`**：
   - `pluxel build`（[plugin-build.ts](../../packages/rolldown/src/cli/plugin-build.ts)）在解析到包内 `#i18n` 导入（或检测到 `project.inlang`）时，在打包前完成该包编译；打包产物直接内联并 tree-shake 实际引用的消息函数，发布 tarball 无需携带 `messages/` 或 `.pluxel/`。
   - 提供显式准备入口（如 `pluxel i18n` 或纳入 `compile` 任务前置），保证干净 checkout 后执行 `tsc --noEmit` 前 `.pluxel/i18n/index.d.ts` 已就绪。
3. **Vite 开发期服务端 HMR（避免自触发死循环）**：
   - 在 `vitePreset()` / `pluginSourceVitePlugins()` 注册包感知的 `pluxel:paraglide` 插件：
     - 首次 `resolveId('#i18n' | '#i18n/*', importer)` 时沿 `importer` 定位 `packageRoot`，确认 `.pluxel/i18n` 已编译，并将 `project.inlang/settings.json` 与 `pathPattern` 解析出的全部消息文件登记到 Vite watcher；
     - [plugin-source.ts](../../packages/rolldown/src/vite/plugin-source.ts#L237) 已将 `**/.pluxel/**` 列入 `server.watch.ignored`，因此写入 `.pluxel/i18n/` 不会引发二次 watch 循环；
     - 当翻译文件或 `settings.json` 变动时，插件仅重编该 `packageRoot` 的 `.pluxel/i18n/`，再主动 invalidate Vite module graph 中对应 `.pluxel/i18n/*` 模块，由 Host-vite 现有 HMR 通道仅热替换受影响的插件。
4. **Workbench MF2 Producer 与冷启动解析顺序**：
   - [oxc.ts](../../packages/rolldown/src/resolver/oxc.ts#L85-L90) 对 `#...` 包内导入在目标文件缺失时会立即报错；因此 [semantic-lowering.ts](../../packages/rolldown/src/workbench/semantic-lowering.ts#L2027-L2159) 在对含 `project.inlang` 的 `buildRoot` 执行 `hashSourceGraph` 前，须先确保 `compilePluxelParaglide(buildRoot)` 已物化 `.pluxel/i18n/`；
   - `hashSourceGraph` 将 `project.inlang/settings.json` 与 `pathPattern` 命中的源文件纳入 `buildRevision` 哈希与 `sources`（不将 `.pluxel/i18n/*` 登记进 `sources`，保持单向源 → 缓存依赖）；[workbenchArtifacts](../../packages/workbench/src/vite.ts#L83) 自动监听源文件并在改动后后台重编 producer；
   - [workbench-vite-build.ts](../../packages/rolldown/src/vite/workbench-vite-build.ts#L158-L165) 改用 `producerRoot` 绝对路径复用同一编译结果，不再以相对路径写 `src/paraglide`。

---

## 5. 运行期衔接与克制边界

- **Workbench 前端**：复用既有的 [WorkbenchHostFacade.locale](../../packages/workbench/src/workbench/react-context.tsx#L76) 与 [runtime.tsx](../../packages/workbench/shell/src/workbench/runtime.tsx#L544-L565) 的 `host.updateAppearance({ locale, colorScheme })`。Workbench Shell 自身在其独立构建中静态接入 Paraglide，并将 [AppProviders.tsx](../../packages/workbench/shell/src/app/frames/AppProviders.tsx#L26) 升级为真实的语言切换状态即可联动所有远端 View。
- **服务端入口**：HTTP（`Accept-Language`）、Chatbot（用户/群偏好插件）与 Commands carrier 将 `locale` 当普通请求参数显式传入插件方法。
- **可选的窄补充（按需，非前置）**：仅当服务端 Workbench `RpcTarget` 或交互式 Content 确需返回本地化文案时，给 [WorkbenchOpenEntryInput](../../packages/workbench/src/workbench/client-protocol.ts#L95-L100) 与 [WorkbenchViewOpenContext](../../packages/workbench/src/workbench/definition.ts#L177-L181) 增加只读 `locale?: string`（固定为本次 open 快照，不因切语言销毁 RPC root）。
- **明确不做**：
  - 不新增 `I18n` / `Locale` Host Service，不扩展 Core Context；
  - 不改动 `@Plugin({ displayName })`、[entry-options.ts](../../packages/workbench/src/workbench/entry-options.ts) 的 `placement`、[valibot-form meta.ts](../../packages/valibot-form/src/core/meta.ts) 的 `formMeta()`、Content Markdown AST 或 Commands 描述契约；
  - 不翻译结构化日志（`ctx.logger`）与稳定程序错误码，不建设运行期词条覆写中心。

---

## 6. 落地前需验证的具体事项

1. **多包并发与生成物治理**：在 monorepo 中用两个含各自 `project.inlang` 的插件包同时跑 `pluxel build`、`tsc --noEmit`、`vp run governance:check` 与 `check-source-declarations`，核对 `.pluxel/i18n/` 不触发声明污染，且两个包的 `#i18n` 互不冲突、产物不含 `node:async_hooks`。
2. **HMR 与 MF2 缓存回归**：修改 `messages/zh-CN.json` 后核对：服务端插件经单次 HMR 更新无死循环；Workbench producer `buildRevision` 变化并触发重建；未改翻译时命中既有磁盘缓存。
3. **Tree-shaking 与开发期 `outputStructure` 实测**：确认通过 `import { m, resolveLocale } from '#i18n'` 只调用 1 条消息时，其余未引用消息不会打进最终 `dist/index.mjs` 或 MF2 chunk；并实测比较 Rolldown 下 `'locale-modules'` 与 `'message-modules'` 的产物大小与 HMR 耗时。
4. **Sherlock 与上游兼容验证**：在真实 VS Code + Sherlock 环境中核对 `project.inlang/settings.json`（含 `@inlang/plugin-m-function-matcher`）、`m.key({}, { locale })` 与嵌套键 `m['a.b']({}, { locale })` 的行内预览与编辑均可正常命中。
5. **旧原型收口**：移除或升级 [packages/rolldown/src/vite/paraglide.ts](../../packages/rolldown/src/vite/paraglide.ts) 中硬编码 `src/paraglide` 与相对路径的旧实现，并补齐对应单测。
