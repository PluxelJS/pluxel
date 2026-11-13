# 描述符、生成与发布

状态：拟议设计。当前普通 Script SDK 及执行器保持为操作入口，新增描述符与类型生成；运行期规则见 [Agent Workflow](../../AGENT_WORKFLOW.md)。

## 可导入的值与类型

生成的插件描述符是 immutable data，携带原 `PluginDefinitionAddress` 和公开契约版本。JS 文件只包含必要数据；`.d.ts` 提供配置输入、校验输出和可发布业务能力的类型关系。运行时目标解析不依赖客户端的对象引用相等。

拟议的描述符示意如下，字段名在实现时与 SDK 一起确定：

```ts
export const Counter = {
	definition: {
		entry: { kind: 'source-entry', sourceSpace: 'app', path: 'plugins/counter.ts' },
		exportName: 'Counter',
	},
	contract: '生成的公开契约版本',
}
```

生成器输出真正的不可变值，示意省略 freeze 与类型声明。descriptor 的类型标记在编译后擦除，地址和契约版本仍然存在。它不能 `new`，不继承 Plugin，不传入 DI，也不会触发插件初始化。`Reference` 在现有 identity 文档中专指地址的可逆文本；新对象称为描述符，避免与该 codec 或 DI 的 `definePluginRef` 混淆。

`sdk.config.get(Counter)`、`sdk.plugins.restart(Counter)` 等操作使用默认节点。fork 使用显式选择，例如拟议的 `{ plugin: Counter, forkId: 'east' }`；选择节点不负责创建 fork。Part 配置仍归 owning node，不生成独立 Plugin 目标。

动态发现得到的完整节点地址仍可传给同一操作。描述符输入提供具体类型，只有地址的输入保留未知配置类型；不能对未知目标返回虚构的泛型类型。管理操作和日志过滤共用目标解析，在一个位置得到原 node address，随后复用 Host/Logging 用例。

## 类型范围

配置声明需要分别生成原始输入和校验输出类型。patch 接受可管理的原始输入，get 的有效配置按输出类型表达；默认值、optional 字段和 transform 不应被压成同一种类型。Part 组合遵守当前配置路径规则，服务端仍执行完整 Schema 校验。

声明来自原 TypeScript/Schema 定义和公开 metadata，不能从当前配置值或降级的 JSON Schema 反推完整类型。编译器可以使用类型分析和 declaration emit，但不能为了生成类型运行 Plugin init 或应用工厂。无法生成可独立消费的声明时，指出具体定义与依赖；不得用 `any` 假装已经获得准确类型。

业务方法只从已有明确公开的 capability/Commands 契约生成。接口中的权限、输入验证、异步返回及撤回规则由原能力维护。class 的私有状态、Context、原生资源和任意同步方法不自动成为远端接口。Vite 项目模式继续提供真实实例访问，描述符本身不伪装为实例。

## 一个身份生产者，多个交付入口

现有 semantic pipeline 在 TS 擦除前确定 canonical entry、root export 与依赖/配置声明。控制制品生成消费同一份 resolved definition facts，不重新根据生成文件路径、dist chunk、`rootExportName` 或磁盘扫描推导身份，见 [Toolchain](../../TOOLCHAIN.md#plugin-package-build)。

| 来源                 | 生成与装配职责                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| Plugin package build | 按公开 entry 生成该包的描述符和类型，记录它们对应的原 definition；与实现同次构建交付              |
| 应用构建             | 汇总实际 catalog 中的包描述符，并为应用内 source definitions 生成控制制品；使用本次构建确认的地址 |
| Vite 开发            | 根据同一 semantic pipeline 和已接纳的 catalog 维护控制制品，跟随原更新调度器发布                  |
| 动态 npm 安装        | 读取所选包已经生成的制品，随真实来源接纳更新 catalog 的控制材料，不在生产端重新分析插件源码       |

Package 的生成入口与插件实现入口分开。引用生成入口时，描述符仍指向原插件公开 entry。应用汇总允许普通 re-export 和本地 alias；同名插件可使用按来源分开的子模块，无需把 exportName 当成全局唯一键。

生成物包括纯 JS、声明闭包及一份可验证清单。清单记录格式版本、definition 对应关系、公开契约版本和实际文件摘要；借用既有 distribution inventory 和完整性检查，不另建签名或包解析体系。应用输出可以汇总包文件，但由同一 emitter/已验证制品产生，不维护第二套类型模板。

编译脚本时只打包纯描述符 JS。当前 [`compileScript`](../../../packages/rolldown/src/scripts.ts) 按 `@pluxel/*` 前缀和 runtime package 拒绝运行时 import，实施时需要区分生成的控制入口与真正的实现闭包。不能仅凭文件名叫 `agent` 就授予例外，也不能因此允许 Core、Plugin constructor 或服务器依赖进入上传包。

## 身份、契约与制品版本

地址负责定位，公开契约版本负责检查作者类型是否适用，制品摘要负责内容完整性。三者分别保存。npm 版本、整个应用的 build hash 和 HMR revision 都不拼入插件地址。

契约版本由同一生成器对确定生成的公开描述与类型计算，运行定义/catalog 携带对应版本。仅实现代码变化而公开描述不变时，地址和控制契约可以保持不变；配置声明或公开接口变化时更新契约。类型摘要不证明自定义 validator 的行为等价，实际调用仍以当前 Schema 校验与领域结果为准。

首批采用明确的契约版本匹配：缺失定义、缺少控制材料或版本不匹配给出可分支诊断，提示获取对应制品。匹配算法以后可以扩展，但不通过短名称、最新 npm 版本或强制类型断言继续调用。一次调用中的查找、契约检查与领域接纳沿原 coordinator 边界进行，避免检查后在 await 间隙换到另一份定义。

描述符是可以跨 run 保存的数据；实际 SDK、实例和业务 handle 仍绑定 Host/run/generation。描述符也不是授权凭证，服务器独立验证调用权限与参数。

## 构建与 HMR 的发布时机

构建输出来自一次一致的 compilation snapshot。实现、地址、描述符和声明清单一起进入发行 finalization；生成失败时不能交付声称完整的控制 SDK。客户端可以取得这份独立材料，目标服务器不需要保留源码或编译器。

Vite 开发控制材料描述已接纳 catalog。原 driver 提交候选后，使用与该候选相同的 semantic/type 输入发布对应版本；不能读取下一次磁盘修改的类型并配到上一次 catalog。身份只由原 semantic pipeline 确认，控制附件不另开 watcher 或成为第二个 HMR 调度器。

只修改方法实现时，未变化的描述符无需改写。公开契约变化、定义新增或删除时，发布对应材料并让消费它的脚本取得新版本。生成目录不进入 Plugin source discovery；脚本模块的失效由既有加载/更新接线精确处理，避免生成文件反过来触发 Plugin 重建或无限刷新。

paused pending、候选失败或 Host replacement 都必须关联实际 catalog 状态。未接纳的新源码不能伪装成在线 SDK。若 Host 已提交而控制文件生成/发布失败，保留真实 Host 结果，报告当前 catalog 的 SDK 尚不可用；旧材料保留自己的版本，不标为最新，不为它回滚应用。采用不可变内容和最后发布的版本清单，避免读到新 JS 配旧 `.d.ts`。

上述发布协调是本提案需要验证的新增接线。原 HMR 的有限 barrier、失败恢复和运行状态含义保持由 [HMR](../../HMR.md) 拥有。

## 动态安装与材料获取

Plugin package 随实现发行控制材料。Package Manager 继续负责 registry、版本、完整性和安装 publication，Host 继续负责 catalog 接纳。控制材料由当前 catalog 所属的实际 package revision 提供，不根据 package name 去 registry 拉一个“最新 SDK”。

安装 wrapper 已发布而 Host 尚未接纳时，报告已安装与当前可操作目标的差异。Native 的 next-start 安装不能提前出现在“当前运行 catalog 的 SDK”中；Vite 成功接纳后才发布对应材料。卸载、部分 publication 失败和更新失败同样按实际 catalog 反映。

agent 可直接使用构建交付的控制目录，也可显式从已连接目标同步其材料到工作区。后者是后续获取方式，使用同一制品格式；不需要新代码生成算法。旧包没有控制材料时准确报告缺失，动态地址查询仍可工作，但不假装获得插件专属类型。

材料获取只读公开描述与类型，不返回配置值、默认凭据、环境值或源代码实现。若类型含有无法独立交付的依赖，生成阶段必须处理或报错，不能将内部服务器 import 链留给 agent 修复。
