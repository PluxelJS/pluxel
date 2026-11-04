# 插件包发布格式

状态：设计草案，尚未实现。上级：[提案总览](README.md)。本页保留作者字段、生成 manifest 与制品边界的方向；当前先确定[市场底座](foundation.md)，具体发布 schema 后续验证再冻结。

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

首版应只包含以下已拥有生产者的事实；最终字段结构在[实施前验证](delivery-plan.md#实施前验证)中冻结：

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

1. 构建并校验作者声明，生成 manifest 与实际制品。
2. 打包真实 tarball；从 tarball 校验 exports、类型、manifest、资源、依赖范围与环境要求。
3. 在搬离 workspace 的消费环境中验证；项目安装与 Host 安装消费同一份字节。
4. 发布到作者选择的 registry；将完整来源坐标提交给索引生产端，或等待扫描发现。

npm 发布与索引收录是两个结果。索引失败不撤销 npm 发布，也不能回报为已经上架。
市场的评分、审核标记、封禁决定和认证凭据不进入作者 manifest。

## 依据与未决范围

标准字段遵循 [npm package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)；Plugin identity 遵循[当前身份边界](../../PLUGIN_IDENTITY.md)。
生成 schema 的具体对象结构、宿主能力引用方式及现有生成 metadata 的替换清单，需从一个真实通用插件和一个项目专属插件验证后确定。
