# 跨仓库源码开发

当应用需要同时修改尚未发布的 Pluxel 或其他独立仓库时，使用 `pluxel source`。它保持每个仓库的
Git、pnpm workspace 和 lockfile 独立，不需要把所有 checkout 放进一个父级 workspace，也不在
`pnpm-workspace.yaml`、`package.json` 或脚本中提交机器路径。

这项能力只负责开发期 package resolution 与所需 artifact 构建。Dynamic host 的 mutable plugin entry
仍由 `@pluxel/runtime-dynamic` 的 `sources` 管理；运行时 package 安装仍由可选
`@pluxel/package-manager` 插件管理，三者不是同一个生命周期。

## 声明源码仓库

消费方根目录提交 `pluxel.sources.jsonc`：

```jsonc
{
	"version": 1,
	"sources": ["https://github.com/PluxelJS/pluxel", "https://github.com/PluxelJS/chatbot"],
	"singletons": ["drizzle-orm"],
}
```

`sources` 只接受仓库 URL，不接受路径、package 列表或构建命令。Git HTTPS、SSH 和末尾 `.git` 会
归一化为同一个身份；未知字段、重复仓库和不支持的版本直接失败。源码仓库可以有自己的
`pluxel.sources.jsonc`，CLI 会先解析和安装它的上游，并拒绝依赖环。

`singletons` 默认是空数组，只用于确实具有 nominal/private 类型或进程级身份约束的外部 package。CLI
要求每个 singleton 在本次实际选中的源码 package 中恰好有一个 direct dependency owner；例如
`drizzle-orm` 自动定位到 `@pluxel/runtime`，即使同一源码仓库中未被消费的示例也声明了 Drizzle，
也不会造成歧义。等 owner checkout 安装完成后，CLI 再发布稳定代理。零个或多个选中 owner 都会失败，
不按目录或 hoist 猜测。普通库不要为了少装一份依赖加入这里。

每台机器登记一次实际 checkout：

```sh
pluxel source register ~/code/pluxel
pluxel source register ~/code/chatbot
```

默认 registry 位于 `$XDG_CONFIG_HOME/pluxel/source-checkouts.json`；没有 `XDG_CONFIG_HOME` 时使用
`~/.config/pluxel/source-checkouts.json`，Windows 优先使用 `%APPDATA%`。命令行 `--registry` 优先于
`PLUXEL_SOURCE_REGISTRY`，两者都优先于默认位置。registry 只保存绝对机器路径，不提交到项目。
checkout 移动后重新运行 `register` 即可。

## 安装、诊断与构建

```sh
pluxel source doctor
pluxel source install
pluxel source build
```

`doctor` 在任何安装或构建副作用前完成以下检查：

- 每个语义仓库都已登记且目录存在；
- checkout 的 `package.json` 或 Git origin 与声明仓库一致；
- 各源码仓库的 package 名称没有冲突；
- 每个 singleton 在实际选中的源码 package 中有且只有一个 direct dependency owner；
- 当前项目确实依赖至少一个声明来源提供的 package；
- 跨仓库源码依赖没有形成环。

`install` 按依赖顺序安装各 source checkout，默认只构建实际消费且需要生成物的 package，最后安装消费方。
每个 checkout 都从自己的 package 依赖推导 overlay，不会因“独立运行”或“被下游安装”而产生两份
lockfile；声明了精确 `packageManager: "pnpm@x.y.z"` 时通过 Corepack 使用该版本，避免调用方的 pnpm
污染上游。只想刷新链接时使用 `pluxel source install --no-build`。

`build` 不维护手写 package 清单。CLI 扫描消费方的 dependency/devDependency/peerDependency，再沿源码
package 的 runtime/optional/peer dependency 递归求闭包；上游自己的 devDependency 只服务其 checkout，
不会泄漏到消费方 overlay。拥有 `build` script 也不自动成为构建目标：只有 live manifest 的
`main/module/types/browser/exports/imports` 指向顶层 `.output/`、`build/`、`dist/`、`lib/`、`out/`，或
package 暴露 executable bin 时，CLI 才认定消费边界需要 artifact。直接导出 `src` 的 package 始终由
link 原位消费。

上游有 `turbo.json` 或 `turbo.jsonc` 时，CLI 只把这些精确目标交给 Turbo，由上游 task graph 决定真正
需要的 prerequisite；不使用 `package...` filter 绕过任务所有者的边界。其他 pnpm workspace 才使用带
dependency closure 的递归 `pnpm --filter`。CLI 已在启动 Turbo 前确定 checkout 使用 pnpm，所以会关闭
Turbo 重复执行的 package-manager 检查；合法的 `devEngines` pnpm range 不会被误判成无效的精确版本，
checkout 的 lockfile 和 pnpm 约束仍然生效。consumer 的 Corepack 选择不会泄漏进独立 checkout；nested workspace
声明了精确 `packageManager` 时仍由 pnpm 使用对应版本。消费仓库不复制 filter 或 dev dependency 清单。
`source doctor` 会分别列出链接的 `packages` 与真正需要构建的 `artifacts`。

项目通常保留短 script。dev 和直接导出源码的 application build 会立即看到 link 中的修改；需要验证
CLI、公开声明或 production default export 时，再由 `verify` 刷新精确 artifact：

```json
{
	"scripts": {
		"source:setup": "pluxel source install",
		"source:build": "pluxel source build",
		"verify": "pnpm source:build && turbo run typecheck test build"
	}
}
```

首次安装前，`pluxel` 命令本身必须已可用：可以使用已发布的 `@pluxel/cli`，也可以从已经安装并构建的
Pluxel checkout 执行 `pnpm --dir <pluxel-checkout> exec pluxel source install --root <consumer>`。首次
完成后，消费方的 `pnpm source:setup` 会使用源码 overlay 中的 CLI。

## pnpm 与 lockfile 语义

CLI 不改写 `pnpm-workspace.yaml`。首次 `source install` 会生成应提交的 `.pnpmfile.cjs`；它不含 source
清单或路径，只让 pnpm 的自动依赖校验与普通 script 调用也能读取当前源码策略。项目已有自定义
pnpmfile 时 CLI 不覆盖它，必须显式组合 `.pluxel/source-pnpmfile.cjs` 的 hooks。

安装前，CLI 在被忽略的 `.pluxel/` 生成两类机器状态：

- `source-pnpmfile.cjs`：本次语义 package → source package 的 pnpm override；
- `sources/<repository-hash>/<package-slug>-<package-hash>`：只指向实际消费 package 的本地目录链接；slug 保留包名用于 lockfile review，短 hash 负责消歧。

pnpm lockfile 只记录 `.pluxel/sources/<repository-hash>/<package-slug>-<package-hash>` 这种由仓库与 package 身份派生的
稳定路径，不记录真实 checkout 目录，也不把整个 checkout 暴露在 consumer 文件树下。移动 checkout 或 package
目录后，`register` + `source install` 只更新本地链接，lockfile 不发生路径漂移；第三方依赖仍由正常 lockfile
完整锁定。source package 目录本身不能包含 consumer workspace；CLI 会在安装前拒绝这种无法形成无环代理的
所有权拓扑。生成 pnpmfile 的 checksum 也只取决于语义映射，不取决于机器路径。

使用源码声明的私有项目应把 `pluxel source install` 作为唯一安装入口并提交更新后的 lockfile。等所有
依赖都改为 registry 发行版时，删除 `pluxel.sources.jsonc` 和源码 scripts，再运行普通 `pnpm install`
生成 registry lockfile；不要在两种模式之间静默复用不匹配的 lockfile。

CI 需要显式 checkout 每个私有源码仓库，在临时 registry 中注册后运行同一安装命令：

```sh
pluxel source register "$PLUXEL_CHECKOUT" --registry "$RUNNER_TEMP/pluxel-sources.json"
pluxel source register "$CHATBOT_CHECKOUT" --registry "$RUNNER_TEMP/pluxel-sources.json"
pluxel source install --frozen-lockfile --registry "$RUNNER_TEMP/pluxel-sources.json"
```

`--frozen-lockfile` 会同时应用于每个 source checkout 和消费方；任何 lockfile 漂移都会直接失败。首次建立
源码 overlay 或明确更新依赖时不使用该参数，review 并提交各仓库更新后的 lockfile，再恢复 frozen CI。

不要重新添加手写 `link:` override，也不要自行链接另一个 checkout 的 `node_modules`。React 等宿主/UI
身份优先由 package peer、宿主直接依赖和 Vite dedupe 处理；Drizzle 这种类型期也要求同一声明实例的已知
边界才声明 `singletons`，实际安装路径由 CLI 在上游安装后解析，不是项目契约。
