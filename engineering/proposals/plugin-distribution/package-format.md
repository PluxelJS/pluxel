# 插件包发布格式

状态：新的独立 Plugin manifest 尚未实现。上级：[提案总览](README.md)。现有依赖 metadata、打包与发布流程由[插件包构建](../../../docs/development/plugin-package.md)和 [Releasing](../../RELEASING.md)维护；本页设计后续静态格式。市场底座已经实现，不再作为这项格式设计的前置待办。

## 发布单位与命名

发布和安装单位是 npm 包，启用单位是 Plugin。一个包可以提供多个 Plugin、显式子路径和普通库导出。
市场的包详情必须能列出其中的 Plugin，安装一个包不会默认启用全部导出。

| 用途                | 推荐包名                     |
| ------------------- | ---------------------------- |
| 无 scope 的通用插件 | `pluxel-plugin-orders`       |
| 第三方通用插件      | `@acme/pluxel-plugin-orders` |
| 官方插件            | `@pluxel/plugin-orders`      |
| 项目专属插件        | `@myapp/plugin-orders`       |

完整 `pluxel` 便于辨认和检索；名称是约定，不是准入判据。普通合法 npm 名称也可携带有效 manifest。
`keywords: ["pluxel-plugin"]` 是发现线索；扫描器不凭前缀或关键词认定包有效。
包名、公开子路径或具名导出改名仍会改变 Plugin identity，不能用市场 display name 或 alias 暗中迁移状态。

## package.json 的字段归属

| 字段                                                            | 作者维护的语义                                           |
| --------------------------------------------------------------- | -------------------------------------------------------- |
| name、version、description、license、repository、homepage、bugs | npm 身份与介绍，复用标准字段                             |
| exports、files                                                  | 公开模块与随包文件；发行入口指向已编译制品               |
| dependencies、optionalDependencies                              | 插件私有实现依赖，保留原生依赖语义                       |
| peerDependencies、peerDependenciesMeta                          | 与宿主共享的框架、服务或 provider 包的版本要求与可选关系 |
| engines、os、cpu 等 npm 环境字段                                | 适用执行环境；Pluxel 准入对相关条件做实际检查            |
| publishConfig                                                   | 发布目的地等原生发布设置，不决定消费者安装来源           |
| pluxel.manifest                                                 | 指向包内生成 manifest 的相对文件路径                     |

下面是关键字段示意，不是完整模板或当前 API。版本范围为示例；实际下限由插件使用的 API 决定。

```json
{
	"name": "@acme/pluxel-plugin-orders",
	"version": "0.1.0",
	"type": "module",
	"exports": {
		".": {
			"types": "./dist/index.d.mts",
			"import": "./dist/index.mjs"
		}
	},
	"files": ["dist"],
	"keywords": ["pluxel-plugin"],
	"peerDependencies": { "@pluxel/core": "^1.1.0" },
	"pluxel": { "manifest": "./dist/pluxel.manifest.json" }
}
```

不增加第二份 Core semver 范围或平行的 registry 认证字段。发布前 workspace/catalog 声明必须经标准打包转换为真实可消费的依赖范围。
包名或 peer 范围相同不证明实际模块共享，运行期接线仍由 Host 的能力边界校验。
原生字段语义与安装支持范围分别判断；依赖求解和共享模块责任见[安装依赖边界](installation.md#插件依赖与普通-npm-依赖)。

## 生成 manifest

manifest 是静态 JSON，由标准构建从真实声明和制品生成，单独携带 `formatVersion`。
格式版本只描述读取协议，Core peer 描述 API 兼容；两者独立校验。未知格式明确拒绝。

首版应只包含以下已拥有生产者的事实；最终字段结构在[分阶段验证](delivery-plan.md#分阶段验证)中冻结：

| 事实                                    | 生产与校验                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| Plugin 列表：公开 entry 与 named export | 从公开 exports 和 lowering 结果生成；禁止重复或跨包冒用身份                    |
| required / optional Plugin 引用         | 从编译事实生成，引用稳定公开地址；与作者 peer 声明核对                         |
| 配置 schema 与可用制品                  | 从构建结果生成文件索引，路径和摘要必须对应实际打包内容                         |
| 宿主能力要求                            | 可可靠提取的生成；无法提取的由作者显式声明并校验，不扫描任意 JavaScript 猜需求 |
| 有条件的执行或交互要求                  | 由相应能力的契约负责；不能将可选 UI 变成所有插件的必需服务                     |

manifest 不是任意安装脚本或运行生命周期脚本入口。生产插件不能靠消费者重新编译 TypeScript 才获得声明事实。
manifest 路径、制品路径限定在包内；缺失、逃逸、摘要不符或与 exports 不符都拒绝。
摘要证明文件关联，不证明作者诚实或代码安全；真正求值和 Host 接纳仍执行运行契约校验。

## 跨项目兼容

“适用于某项目”可以是描述标签，机器判断依据为实际条件：框架/服务/provider 版本、执行环境和已安装宿主能力。
安装某服务的 npm 包不等于服务已装配进 Host；缺少能力时报告具体缺口，不动态扩展固定 Context。
optional integration 只在条件满足时参与；不因为市场发现相关包就安装或启动它。

不要求作者手写一张永远同步不了的兼容项目名单，也不强制通用插件依赖 Workbench。
需要多个环境时由真实制品和消费验收支持，不能只靠一个 `platforms` 字符串数组获得兼容承诺。

## 发布交付

下表描述新 manifest 接入后的目标流程。已有版本、依赖声明、构建和原生打包继续沿用正式文档；新增工作是把 manifest 与真实 tarball 校验连接起来：

| 阶段             | 所有者与输出                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------- |
| version          | 作者的发布工具确定包版本、依赖范围变更与发布计划；本仓库使用 Tegami                      |
| build            | `pluxel build` 消费已确定的声明，生成 Plugin facts、manifest、类型与制品，并校验依赖角色 |
| pack             | 原生包管理器形成真实 tarball，将 workspace/catalog 声明转换为消费者可用的依赖声明        |
| verify           | 以 tarball 为对象检查发布契约，在搬离 workspace 的环境消费                               |
| publish / notify | 按计划发布同一制品与 npm provenance，再通知市场实际已发布的版本                          |

当前 build 已有依赖角色校验与生成 metadata 的边界，见[现有构建用法](../../../docs/development/plugin-package.md#依赖-metadata-如何生成)；本提案的新 manifest 仍待实现。
本仓库的版本传播和发布重试由 [Tegami 发布流程](../../RELEASING.md)拥有；第三方插件可以使用自己的发布工具，不必采用本仓库与 Core 同步版本的政策。

具体顺序为：

1. 显式应用并审查版本计划及依赖变更，更新 lockfile；CI 从对应提交和锁定依赖开始。
2. 执行标准 build，生成并校验作者声明、manifest 与实际制品；依赖任务由所属 workspace 的构建图编排。
3. 原生打包真实 tarball；检查包内 exports、类型、manifest、资源、转换后的依赖和环境要求，并在搬离 workspace 的消费环境验证。
4. 在支持的 CI 中按 npm 原生方式发布已验证的 tarball 及 provenance；若发布器重新打包，必须确认最终字节仍与验证对象一致，变化后重新验证。
5. 仅对实际发布成功的包通知市场 registry、包名和精确版本，见 [CI 发布通知](index-production.md#ci-发布通知与-npm-provenance)。人工登记与扫描仍可发现其他发行。

npm 发布、通知接收与索引收录分别报告；通知失败可单独重试，索引失败不撤销 npm 发布，也不能回报为已经上架。
市场仍从 registry 获取实际包及 npm provenance。来源证明沿用 npm 契约，Plugin manifest 不增加仓库认证或公开程度字段。
市场的评分、审核标记、封禁决定和认证凭据不进入作者 manifest。

### 构建如何协同处理版本与依赖

构建从 constructor、optional reference、可达 Part 和公开入口生成真实 Plugin 依赖事实，再核对作者维护的 `peerDependencies` 与 optional 标记。
共享的 Core、服务和 provider 保持外部依赖；不能通过打入第二份实现使依赖检查通过。普通实现依赖、只用于构建的依赖和发布类型仍引用的依赖按实际用途声明，依据[依赖治理](../../GOVERNANCE.md#依赖与版本)。

包版本与兼容范围来自版本计划、`package.json` 和所属 workspace/catalog。编译通过或当前安装了某个版本，都不能推导作者愿意承诺的最低兼容版本。
build 自动生成确定的事实并报告声明冲突，不递增包版本、不猜 peer 范围、不隐式搬移作者的依赖字段；需要自动修正时使用独立、可审查的维护操作。
manifest 的 Plugin 引用使用稳定公开地址，npm 兼容范围仍由发布后的 `package.json` 拥有，不再复制一套平行版本规则。

`workspace:` / `catalog:` 在原生 pack/publish 阶段转换，沿用 [pnpm workspace](https://pnpm.io/workspaces#publishing-workspace-packages) 与 [catalog](https://pnpm.io/catalogs#publishing) 语义。例如目标包版本为 `1.2.3` 时，`workspace:^` 发布为 `^1.2.3`，`workspace:*` 发布为 `1.2.3`。
发布校验以转换后的 tarball 为准，检查消费者依赖和类型引用不存在未解析的 workspace/catalog 或开发机路径；不能只检查源码 `package.json` 或 `dist/`。
构建 lockfile 固定构建环境，发布依赖范围表达消费者兼容要求，安装端再拥有自己的求解与锁定结果。

同批发布由发布工具编排 provider 与 consumer 的顺序及部分失败重试；只在本地存在的版本不算 registry 已可获取。
市场和安装端保留缺失依赖的实际结果，不改用同名最新包，也不自动启用 optional provider。跨 registry 和共享模块的实际接纳继续由[安装能力](installation.md#插件依赖与普通-npm-依赖)负责。

## 依据与未决范围

标准字段遵循 [npm package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)；Plugin identity 遵循[当前身份边界](../../PLUGIN_IDENTITY.md)。
生成 schema 的具体对象结构、宿主能力引用方式及现有生成 metadata 的替换清单，需从一个真实通用插件和一个项目专属插件验证后确定。
