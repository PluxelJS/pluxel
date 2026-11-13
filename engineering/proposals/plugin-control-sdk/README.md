# 从插件身份到可导入的控制 SDK

状态：设计提案，尚未实施。2026-11-13 对照当前 identity、semantic lowering、Script SDK、HMR 和包安装路径整理。已有地址规则由 [Plugin Identity](../../PLUGIN_IDENTITY.md) 维护，脚本执行由 [Agent Workflow](../../AGENT_WORKFLOW.md) 维护。本提案为这些机制增加生成的插件描述符与类型，不改变插件身份规则。

## 要解决的使用问题

agent 已经可以执行普通 TypeScript，但操作已知插件仍常常需要遍历 `sdk.plugins.list()`，按 `rootExportName` 和 variant 筛选。这个调用要求作者自己恢复目标身份；同名导出出现时，短名称还不足以确定目标。配置返回值也缺少与特定插件对应的输入和输出类型。

目标是直接 import 已知插件的控制端描述符，再使用同一套 SDK。以下为拟议用法，生成路径和类型尚未实现；示例假定 Counter 的原始配置包含 `step`：

```ts
import type { Script } from '@pluxel/host/agent'
import { Counter } from './generated/plugins/counter'

export default (async (sdk) => {
	const before = await sdk.config.get(Counter)
	if (!before.ok) return before
	const changed = await sdk.config.patch(
		Counter,
		{ set: { step: 2 } },
		{ expectedManagedRevision: before.managedRevision },
	)
	if (!changed.ok) return changed
	return { changed, actual: await sdk.config.get(Counter) }
}) satisfies Script
```

`Counter` 携带原插件的完整 definition address 和公开契约版本，类型声明提供配置输入、配置输出及可公开的业务接口。它不包含 Plugin 实现，不创建实例，也不充当 DI constructor。生成代码的文件路径和 import alias 可以改变，描述符里的插件地址保持不变。

## 设计判断

现有 `canonical entry + exportName` 适合继续作为 definition identity。它把插件定义与物理安装位置、构建输出、constructor 对象和运行 generation 分开，使 HMR、npm 升级、持久配置和远程操作可以指向同一逻辑定义。名称相同而 canonical entry 不同的插件自然区分。

这种稳定性有明确边界：源码相对路径、source space、公开包入口或 root export 改名会改变身份；同一包的两个物理版本不会自动成为两个定义。详细评价和取舍见 [身份设计的目标与边界](identity.md)。

当前规则已经说明格式、作用域和 canonicalization。缺口主要是动机与使用体验之间的衔接：编译器知道的完整身份，尚未成为 agent 可以直接 import 的值；现有文档中的名称筛选没有体现这一优势。

## 一条生成路径

```text
源码 / 包公开入口
  → 同一 semantic pipeline：canonical address + 公开配置与接口声明
      ├─ lowering / Host candidate → 当前 catalog 与运行实例
      └─ 控制制品生成 → 纯 JS 描述符 + .d.ts + 制品清单
                                ↓
                 agent import → 普通 Script SDK → 原 Host 用例
```

构建、Vite 和动态安装都消费这条路径的结果。它们负责产生或接纳不同来源，不各自制定地址算法。SDK 在实际操作时解析描述符、检查目标与契约，再使用原配置和生命周期实现。

## 文档与交付

- [身份设计的目标与边界](identity.md)：为什么使用逻辑入口、稳定性范围，以及 HMR/npm 的收益和限制。
- [描述符、生成与发布](design.md)：作者接口、JS/声明制品、构建、HMR、动态安装和运行期校验。
- [落地顺序与验收](delivery.md)：当前实现接入点、首批任务和必须跨越的真实验证边界。

首批交付以准确选中插件、配置类型和生命周期操作为主线，贯通构建、Vite 更新与已安装包。业务方法生成沿已有公开能力推进；不会把整份 class 声明当成可远程调用接口。

新 API 以清晰实用为准，不要求兼容旧 SDK。迁移已知脚本和文档示例，删除名称猜测的默认用法。`plugins.list()` 继续服务发现、巡检和批量操作；动态得到的完整节点地址仍可用于同一管理 API。
