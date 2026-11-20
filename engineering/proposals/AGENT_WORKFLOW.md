# Agent 执行与控制的后续方向

当前 SDK、Node/Vite 执行、插件实例借用和材料同步见 [Agent Workflow](../AGENT_WORKFLOW.md)与 [Plugin Control](../PLUGIN_CONTROL.md)，公开调用见[自动化脚本](../../docs/development/scripts.md)。以下能力尚未完整交付，分别由真实调用方和部署验收推进。

## Cloudflare 执行后端

既有实验涉及可移植入口闭包、workerd Dynamic Worker 工厂和最小能力桥。正式后端需要独立的平台入口，并按当前统一 SDK 重新验证：异步控制操作成功返回值，失败抛 `ScriptError`；Host 继续拥有配置、生命周期与存储。脚本工厂以静态模块文本装入 Dynamic Worker，授权调用经 Workers RPC 回到原 Host。

首条部署路径是有明确寿命的单次执行：读配置、普通计算与分支、带版本条件写入、核对实际采用。验收覆盖取消传播、在途调用排空、能力桥释放、错误映射和目标环境限制。D1/KV 适配验证真实提交、读取与传播，采用结果仍由 Host 报告。

后端明确 run owner、超时、授权撤回和查询寿命。请求拥有的执行随请求寿命撤回；跨断线执行需要可路由到原操作的稳定 owner，例如 Durable Object。持久身份、重复提交与结果保留一起设计。

`describe.capabilities` 只声明实际提供的能力。管理可经授权桥调用；同进程 `plugin.instance()` 借用真实实例。跨 isolate 的业务调用需显式异步接口，分别定义取消、资源句柄、授权和 provider drain。

## 远程 Vite 入口

显式授权的远程入口复用共享执行 target 与项目加载器。目标 Vite 模块图继续拥有项目 import、Plugin/token 身份、实例、Context、源码屏障及 HMR pause/apply/resume。

连接位置与开发权限分别配置。失败报告原目标状态，receipt 查询继续归原 run owner。多人共享开发进程时，需要明确 HMR 控制的操作归属与可观察状态。

## 离线配置校验与 Vault 部署绑定

离线 validator 从原 Schema 生成可独立求值的制品，显式接收配置和环境。缺失动态定义、环境或 Schema 时报告校验范围；网络和凭据检查作为显式 preflight。现有配置源码类型用于理解和静态检查，运行校验由 Host 执行。

Vault 拥有凭据值和动态令牌。SDK 查询、计划、receipt 与日志展示引用及可用性；实际值验证发生在有授权的凭据边界。部署绑定与 OAuth 动态记录分别管理，需要重建 Host 的绑定修改保留原生报告。

## 控制材料与维护工具

- 不可变材料快照的自动清理需要当前导入与活动编译的保留依据；现阶段由显式维护清理废弃目录。
- 外部类型依赖的版本与声明指纹核验需要作者环境协议；当前同步验证交付材料，原包及其类型依赖由作者提供匹配版本。
- 浏览器脚本编辑器复用现有执行器；持久 scratch 分开处理纯数据与 generation 句柄。
- 通用 SQL 管理、Windows 私有通道和配置文件编辑分别确定权限、取消、资源寿命与真实验收任务。
