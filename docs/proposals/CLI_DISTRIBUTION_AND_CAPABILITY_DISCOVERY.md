# CLI 分发与可选能力

> 状态：implemented。本文保留设计取舍与边界说明；当前用户契约以 `user-docs/` 和包 README 为准。

## 目标

让用户可以：

```sh
pnpm create @pluxel
pnpm add -g @pluxel/cli
pluxel build
```

`pluxel` 是统一入口，但不是 runtime、构建、HMR 或发行协议的所有者。全局 CLI 应能使用当前项目已经
安装的官方能力；项目固定了本地 CLI 时则优先使用本地版本，保证 CI 和团队协作可复现。未使用的可选能力
不应在启动和帮助阶段产生加载成本。

## 核心判断：第一阶段不做发现系统

当前只有一组封闭的官方命令，命令名和能力 owner 都已知。因此第一阶段采用：

```text
静态命令目录 -> 用户选择命令 -> lazy import 官方 owner -> 执行 public use case
```

不扫描依赖来生成命令树，也不定义 provider manifest、capability slot、第三方 CLI plugin 或 command cache。
这比“根据安装状态动态组装命令”更确定：同一 CLI 版本的 `--help` 始终相同，安装或 hoist 一个包不会静默
增加、删除或覆盖命令。

所有官方命令始终出现在帮助中；需要可选包的命令在静态说明中标出 owner 和安装方式。只有用户真正执行
该命令时才解析并 import owner。缺失时输出可操作的安装提示，而不是自动安装。

这仍然满足能力按需组合，只是把“发现”收敛为执行时的可用性检查，而不是一个扩展系统。

这个组合与社区常见 CLI 模式一致：

| 需求                  | 采用的模式                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 随处可用的入口        | 全局 launcher；进入项目后 local-first delegation，类似 [Nx](https://nx.dev/docs/getting-started/installation) 和 [`import-local`](https://github.com/sindresorhus/import-local) |
| 一次性创建项目        | `@scope/create` scoped initializer                                                                                                                                              |
| 使用项目安装的工具链  | resolve-from-cwd，只解析明确的官方 package，不扫描 `node_modules`                                                                                                               |
| 快速帮助与 completion | 静态 command manifest，handler 和 owner 都 lazy load                                                                                                                            |

不采用“全局 CLI 捆绑全部构建/runtime 包”的做法：那会增加全局安装体积，并让全局工具链版本越过项目 lockfile。
也不要求只有一个全局 shim 再为每条命令启动包管理器；命令执行不应隐式联网或修改安装状态。

## 两个分发入口

- `@pluxel/create`：一次性 initializer，规范入口是 `pnpm create @pluxel`。
- `@pluxel/cli`：提供唯一的 `pluxel` executable，可全局安装；需要可复现自动化的项目应在 workspace root
  固定为 `devDependency`。

`@pluxel/create` 只包含一个 executable，并以相同精确版本依赖 `@pluxel/cli`。它把 argv 原样交给这份
CLI 的 `pluxel new`，不复制模板、prompt 或安装逻辑，也不导出 library API。调用时必须绕过项目本地版本
委托，保证 initializer 使用自己携带的 CLI；这个绕过是两个官方包之间的 internal launcher protocol，不是
用户参数或公开环境变量。

两个包进入 Changesets fixed group，使 initializer 与其调用的 CLI 始终同步发布。不再发布语义重复的
unscoped `create-pluxel` package；`@pluxel/create` 内部的 `create-pluxel` bin 只服务 package manager
的 create/init 约定。

这遵循 pnpm/npm 的 scoped initializer 约定：`pnpm create <@scope>` 和 `npm init <@scope>` 解析
`@scope/create`。参考：[pnpm create](https://pnpm.io/cli/create)、[npm init](https://docs.npmjs.com/cli/v11/commands/npm-init/)。

## 全局入口优先使用项目 CLI

全局安装用于提供随处可用的 `pluxel` 命令，不作为项目版本来源。

launcher 从 `cwd` 向上查找最近一个在 `dependencies` 或 `devDependencies` 中直接声明 `@pluxel/cli` 的
`package.json`，并从该 manifest 解析 executable：

- 找到且不是当前 executable：直接 `await import()` 项目 executable，让它在当前进程进入自己的 CLI main；
- 找到的就是当前 executable：直接进入 CLI，避免递归；
- 找到声明但无法解析其安装：报告本地安装不完整，不回退到全局版本；
- 没找到：运行当前安装的 CLI，并从当前项目解析被调用命令所需的官方能力。

这里不需要识别 pnpm/yarn workspace 格式，也不扫描全部 `node_modules`。直接声明既是版本选择点，也是清晰
的项目所有权信号。项目内的 `--help` 和 `--version` 同样委托本地版本，不提供 `--global` 这条平行行为。

launcher 在委托前不加载 Gunshi、command manifest 或任何全局 CLI state，因此 in-process import 不会混合两份
CLI。它比再启动 Node child process 更轻，也让 cwd、stdio、环境、用户 argv、signal 和 exit status 天然保持
当前进程语义。递归保护比较 global/local executable 的 realpath，不依赖环境计数器。

因此只全局安装一次 `@pluxel/cli`，就可以进入任何安装了兼容 owner 的项目执行 `pluxel build`、
`pluxel hmr` 等命令；不要求该项目同时安装 CLI。CI 和 package scripts 仍统一使用本地 `pluxel` 或
`pnpm exec pluxel`，避免全局升级改变自动化结果。生成的 app monorepo 与 standalone plugin 都应在
workspace root 固定 `@pluxel/cli`，让全局入口可以稳定委托项目版本。

## 命令与能力所有权

| Command / feature                      | 能力 owner                               |
| -------------------------------------- | ---------------------------------------- |
| `build`                                | `@pluxel/rolldown/build`                 |
| `database`                             | `@pluxel/rolldown/database`              |
| `distribution`                         | `@pluxel/rolldown/distribution`          |
| `hmr` diagnostics                      | `@pluxel/runtime-dynamic/hmr/diagnose`   |
| `publish --webhook`                    | `@pluxel/market`                         |
| `workspace` inspection/filesystem      | `@pluxel/rolldown/workspace/info`, `/fs` |
| `new`, `source`, workspace UI/mutation | `@pluxel/cli`                            |

CLI adapter 只负责 argv、交互、输出和调用 owner 的 public use case，不复制 Plugin lifecycle、build pipeline、
HMR discovery 或 distribution protocol。runtime `@pluxel/commands` catalog 也不隐式接入 workspace CLI。

## tsdown 打包边界

`@pluxel/cli` 继续由 tsdown 生成 lazy command chunks，但只打包 CLI 自己拥有的实现：command manifest、adapter、
scaffold、TUI，以及适合内联的 UI runtime。模板和 user docs 继续作为资源复制。bin launcher 保持为极小的原生
ESM 文件，在 import CLI main/Gunshi 前完成 local-first delegation。

executable 和 CLI main 必须用 top-level `await` 返回完整执行结果，不保留 `void main()` 这类 fire-and-forget
启动。这样 global launcher import 本地 executable 时，会等到命令完成或失败，且 rejection、exit code 和 teardown
仍属于同一个调用链。

以下 package 保持 `deps.neverBundle`：

- `@pluxel/rolldown`、`@pluxel/runtime-dynamic`、`@pluxel/market` 等能力 owner；
- `tsdown`、Rolldown、Vite 和项目 runtime 等由 owner 使用的工具链或 peer。

不能通过把 owner 内联进 CLI 来实现“全局可用”。例如 `@pluxel/rolldown/build` 会直接运行 `tsdown`；内联后它的
bare dependencies 将从全局 CLI 安装闭包解析，项目 lockfile 中的 tsdown/Rolldown 版本不再是执行版本。若继续
把这些依赖和 native binding 一并打包，则全局安装明显膨胀，并形成一套越过项目依赖图的隐藏工具链。

也不选择性内联看似较小的 `database` 或 `distribution`：同一官方 owner 一部分从 CLI bundle 执行、一部分从
项目 package 执行，会造成两套版本、错误和模块身份语义。所有 optional owner 统一 external、统一从项目解析，
边界更容易解释和验证。

tsdown 的职责是 code splitting 和保护 external boundary，不负责 capability resolution。构建产物中不得存在
optional owner 的 runtime bare import；所有 value import 都经过下文的 project-anchored loader。type-only import
可以保留用于编译，构建后必须被擦除。像 HMR TUI 这类嵌套 chunk 也不能静态 import diagnostics module：顶层
command 加载一次 owner 后，把 typed module 传给 TUI/helper，或由共享 loader cache 取得同一个 module。

版本范围检查使用成熟 semver 实现，不自行编写 `^`/prerelease 规则。它可以进入 capability loader 的 lazy chunk；
root help、`new` 和不使用 owner 的命令不加载 semver。

`@pluxel/cli` 用 optional peer dependencies 声明官方 owner 的兼容版本。能力 loader 通过
`createRequire()` 建立以 `cwd` 为基准的 Node resolver，先解析 owner package root，再解析 public subpath，最后
把结果转成 URL dynamic import；不能使用从全局 CLI 文件位置出发的 bare import。这样同一条加载路径同时
适用于全局和本地 CLI，也自然遵循当前 package/workspace 的 Node 解析结果。

依赖解析基准始终是进程启动时的 `cwd`。各命令的 `--root` 只表示该领域的输入目录，不暗中改变 Node dependency
resolution；需要操作另一个项目时先进入该项目目录。这样避免 `distribution <artifact-root>` 等非项目路径被误当
成依赖根，也不新增一套 workspace root 猜测。

全局安装时，包管理器无法替当前项目校验 CLI 的 peer range。因此 loader 在 import 前读取已解析 owner 的
`package.json`，用 CLI 自己的 optional peer range 检查版本；不兼容时报告 CLI version、owner version 和支持
范围后 fail-fast。这里不是通用版本协商，也不选择多个 provider，只检查这一条确定的解析结果。
owner manifest 从已解析的 package root entry 向上定位并校验 package name，不要求 owner 额外导出
`./package.json`。

第一阶段不判断 direct/transitive/hoisted：这些不会改变静态命令目录，而且能力只在用户明确调用命令后加载。
用户文档仍要求把 owner 作为项目 direct `devDependency`，保证安装意图和 lockfile 清晰。

每个可选能力只保留一份内部静态 metadata：owner package、import subpath 和安装提示；兼容范围直接读取
CLI 自己的 `peerDependencies`，不再抄一份。命令加载与错误诊断共用这些信息，避免 command map、错误映射
和文档各维护一套 package 名。导入 owner 后发生的内部依赖错误必须保留原始 cause，不能误报成 owner 未安装。

loader 按阶段给出确定错误，不靠 `ERR_MODULE_NOT_FOUND` message 猜测：

1. owner root 无法解析：能力未安装，显示安装命令；
2. owner 已安装但版本超出 optional peer range：显示 CLI version、owner version 和支持范围，并建议固定兼容的
   项目 CLI 或升级 owner；
3. owner root 可解析但 public subpath 不存在：报告安装损坏或 API 不兼容；
4. subpath 已解析但 import 失败：这是 owner 或其依赖的加载失败，保留原始 `cause`。

resolver 只在用户选定命令后运行，并按 `(cwd, owner, subpath)` 在单次进程内缓存。它不遍历 workspace，通常只
产生两次 Node resolution 和一次很小的 `package.json` 读取；相对真正的 build/HMR 工作可忽略。

约束：

- `--help`、`--version` 和 shell completion 不 import provider、不访问 registry、不启动 watcher；
- 缺失或不兼容时 fail-fast，不修改 `package.json`、lockfile，也不自动执行包管理器；
- 未执行 capability 命令时，不创建 compiler、watcher、transport 或持久状态；
- 只有显式执行 capability 命令才会 import 项目代码；目录探测、help 和 completion 不构成信任触发点；
- CLI adapter 与 provider metadata 都是 `@pluxel/cli` internal，不发布 `cli-kit` 或 extension API。

第一阶段支持 Node 原生 `node_modules` resolution，覆盖 npm、pnpm 和 Yarn node-modules linker。全局进程不会
额外注入 Yarn PnP loader；PnP 项目应通过项目本地 CLI/package-manager 执行，避免在 launcher 中再实现一套
package-manager resolution。

至少出现两个真实的仓库外 provider，且它们确实需要新增命令后，再单独设计第三方扩展。届时必须回答命名
冲突、版本协商、信任、取消和 cleanup；当前方案不为这个假设场景预留半公开协议。

## 用户路径

创建项目：

```sh
pnpm create @pluxel
```

已安装全局入口的用户也可以：

```sh
pluxel new --template app-monorepo --name @acme/my-app
```

日常自动化使用项目版本：

```sh
pnpm exec pluxel build
pnpm exec pluxel database check
```

个人机器也可以只固定能力 owner，使用全局入口：

```sh
pnpm add -D @pluxel/rolldown
pluxel build
```

如果 `@pluxel/rolldown` 未安装，`pluxel build` 仍能在帮助中看到，但执行时会失败并提示：

```sh
pnpm add -D @pluxel/rolldown
```

## 实施顺序

1. app monorepo 模板固定本地 `@pluxel/cli`，先保证生成项目和 CI 有可复现的执行版本。
2. 把 bin 拆成无重型 import 的 launcher 和 CLI main，在加载 Gunshi 前以 in-process import 完成
   global-to-local 委托。
3. 新增 thin `@pluxel/create`，通过 internal direct mode 复用唯一的 `pluxel new`。
4. 保留现有静态 lazy command 目录，增加唯一的 project-anchored owner loader，并把版本检查、owner metadata
   和缺失依赖诊断收敛成单一来源；替换 CLI 内所有 optional owner 的 runtime bare import，包括嵌套在
   `workspace` 和 `publish` helper 中的 import。
5. 保持 owner/toolchain 的 `deps.neverBundle`，增加 build artifact 检查，阻止 command chunk 或 TUI chunk
   重新出现 optional owner runtime bare import。

## 验收

- `pnpm create @pluxel` 与相同版本、相同参数的 `pluxel new` 生成相同文件树；在已有旧版项目 CLI 的目录中
  调用 initializer 也不会被委托到旧版本；
- initializer、CLI 和模板均通过 `npm pack` 后的仓库外 smoke；
- global/local 任意版本组合只在一个进程中执行一次项目本地 CLI，并覆盖嵌套 cwd、symlink、Ctrl-C 和 exit
  status；
- 只有全局 CLI、项目只有 owner 的仓库外 smoke 可以执行 `build`、`database`、`distribution` 和 `hmr`；owner
  总是从项目而不是全局安装目录解析；
- 从 workspace member 启动时遵循标准 Node nearest resolution；`--root` 不改变 capability resolution base；
- clean CI 无需 global CLI 即可执行项目命令；
- 安装或移除 owner 不改变同一 CLI 版本的 help 和 completion；help 不加载 Rolldown、runtime-dynamic、market、
  React 或 Vite；
- npm-packed CLI 的所有 executable chunk 都不包含 optional owner runtime bare import；owner、tsdown、Rolldown
  和 Vite 不被内联进 CLI artifact；
- 缺少 owner 时只影响被调用的能力并给出安装提示；owner 自身的加载错误保留原始诊断；
- owner 版本超出 CLI optional peer range 时，在 import 前给出双方版本和支持范围；
- capability 未被调用时不产生 compiler、watcher、transport 或持久状态。

## 暂不处理

- 第三方命令 provider 与公开 extension contract；
- registry 驱动的能力发现或自动安装；
- 全局 CLI 对 Yarn PnP dependency graph 的自定义解析；
- 动态 shell completion cache；静态命令目录已经足够生成 completion。
