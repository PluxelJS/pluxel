# 插件设置与 Vault：两个数据入口，一处宿主绑定

> 讨论草案，尚未采纳或实现。本文只提出设计，不启动迁移。
> 当前行为以 [CONFIG](../CONFIG.md) 和 [Vault 文档](../../docs/runtime/vault.md) 为准。
> 以下绑定与操作名称仅表达语义，不是已实现 API。

## 1. 目标与模型

同一个插件既能通过 env/文件部署，也能通过 Workbench 手动配置、扫码和管理多个账号。
插件不判断部署方式；coding agent 能从固定入口找到数据结构、来源和更新行为。

只保留两个数据入口：

| 入口 | 内容 | 示例 |
| --- | --- | --- |
| config | 不含 secret 明文的运行设置 | endpoint、超时、默认账号 ID、路由规则 |
| Vault KV | 按插件隔离的结构化加密记录 | API key、账号 token、refresh token、加密业务状态 |

账号是插件业务概念，以稳定账号 ID 组织 KV；config 通过账号 ID 选择它，不复制凭据目录。
密码连接串应拆分或整体进入 Vault。无需新增 Secrets、Credentials 或独立 Documents/collection 服务。

## 2. 插件声明数据，宿主显式绑定来源

### 唯一应用入口：defineConfig(factory)

应用只使用 `defineConfig(factory)`，不提供对象重载或嵌套 `configure`。Host 每次创建时传入独立 startup，
调用工厂并等待其返回完整配置；同步、异步工厂使用同一契约。模块导入时不执行工厂。
固定配置也写成 `defineConfig(() => ({ ... }))`，无需另一种作者模式。

`defineConfig` 提供 startup 类型推导和明确的应用声明边界；省略字段是否合法仍由类型决定。
用户可以在工厂内调用普通 helper，按 env/bindings 选择插件目录、服务和运行策略。
工厂描述装配，不创建连接或监听器；资源准备、回滚与关闭仍由 Host 所有。
删除顶层配置与 configure 返回值的合并规则，也不引入隐式 `getStartup()`。

插件声明 config schema，以及需要供外部配置的 Vault 记录 schema。校验、类型与说明各写一次，
不声明 env 名称；私有 KV 状态不自动成为部署入口。Vault 声明的具体语法留待 API 设计。

宿主直接声明 `envBindings`，由 Host 消费本次 `startup.env`。不安装 `environment()` 服务，
不重复传递 `values: startup.env`，也不增加 `ctx.env`。候选 API 如下：

```ts
export default defineConfig(async (startup) => ({
  plugins: [StoragePlugin],
  services: await appServices(startup),

  envBindings: [
    {
      plugin: StoragePlugin,
      config: {
        endpoint: 'STORAGE_ENDPOINT',
      },
      vault: {
        primary: {
          accessKeyId: 'AWS_ACCESS_KEY_ID',
          secretAccessKey: 'AWS_SECRET_ACCESS_KEY',
        },
        // 也可将一个 JSON 变量绑定为完整记录。
        secondary: 'STORAGE_SECONDARY_JSON',
      },
    },
  ],
}))
```

`appServices` 是应用自己的组合函数，不是新增框架 API。`primary`、`secondary` 是 Vault 记录 key。
字符串绑定整个目标，object 按字段组装；同一目标不能同时绑定整体与后代。输入类型来自插件 schema，
不在绑定中重复声明。以上 `envBindings` 是拟议替代入口，不与旧 bootstrap 长期并存。

没有声明就不读取。允许显式把多个变量组装为一条记录，再整体校验；不自动生成变量映射、扫描账号或猜测字段名。
框架从已声明的绑定生成 .env.example 和输入说明。文件来源也指向同样的目标，具体文件绑定语法另定。
owner 使用宿主明确引用的插件身份，账号 ID 和字段路径必须校验，不能依赖 displayName 推断。

### 跨运行时输入与启动顺序

保留现有 `startup.env` / `startup.bindings` 边界：前者承载字符串变量，后者承载平台资源对象。
Node/Bun 适配器可从进程环境取值；Cloudflare Workers 适配器应从平台传入的 bindings 提取字符串变量，
KV/R2/D1 等对象留在 `startup.bindings`。这说明适配责任，不表示当前已完成 Workers 支持。
适配器显式确定输入时机与 Host 实例范围，不能在请求间覆盖一个共享的可变环境对象。

测试或嵌入式调用者可提供完整启动输入，不暗中合并机器环境；`.env` 加载也由适配器决定。
Host 读取同一启动快照，接纳声明并验证绑定，准备所需 Vault backend，再解析值，最后启动插件。
顺序由 Host 负责，不依赖 services 数组排列。绑定到 Vault 必须显式安装该能力，缺失时报告装配错误。
动态 catalog 候选接纳时同样先验证和绑定，再进入插件生命周期。

### 构建期边界：实施前必须解决

任意工厂不能由静态分析完整推导。当前工具链依赖直接导出的应用对象；采用本方案必须同步调整，
不能仅替换类型 helper。构建不得执行工厂读取部署环境，也不能把构建机的条件分支当成唯一插件目录。
插件/schema/制品清单的构建来源，以及 env 示例如何覆盖条件分支，是实施前的决策项。
运行时绑定清单可从工厂返回值验证，但不能因此宣称构建期已经获得完整清单。

目录接纳与自动启动仍是不同决策：返回 plugins 表示本次可用，启动策略决定是否运行。
应用或服务装配变化需要新的 Host；插件运行中启停继续由 graph 管理。

### 来源与写入规则

来源规则固定为：

| 目标 | 规则 |
| --- | --- |
| config | 基础对象/文件 < 管理保存值 < env；合并后由 schema 补默认值、校验 |
| Vault 条目 | 显式绑定 env/file 时整条记录只读；否则使用已装配的可写加密 KV |

config 对象按字段合并、数组整体替换；缺失的 config env 不产生覆盖，空值与 null 按 schema 校验。
实际由 env 控制的路径禁止管理修改，
移除 env 后恢复下层值。env 不落盘，首版启动时读取，不提供隐式热更新。
Vault 不把 env 中的新 token 与旧 KV 中的 refresh token 混合，也不在输入缺失时偷偷回退。
自动刷新需要可写条目；导入 env 后改由 KV 管理必须是显式操作，不能每次启动重新播种。

Vault 统一读取契约与磁盘 backend 分开装配：env-only 可使用 Vault 读取能力，但不创建密钥、磁盘或持久化依赖。
映射和 IO 由宿主负责，Core 不读取进程环境，插件不获得整个 env。

## 3. Vault 保留什么

Vault 以结构化 KV 为唯一记录模型，提供：

- 按 owner/key 读取、写入、删除及有界列举。
- 不可变快照、revision、expectedRevision 条件写入。
- 同一 backend 内的原子 batch，以及持久提交确认。
- 提交后的记录观察；取得初始快照与建立观察之间不能漏更新。
- owner/generation 隔离、停止后旧 handle 失效，以及备份、恢复、密钥轮换。

Documents/collection 的按 ID 存 JSON、列举和更新并入 KV；多账号不需要第二套存储 API。
blobs 是否保留先查真实消费者，不把它加入本轮核心模型。复杂查询使用数据库。
部署只读条目与可写条目共用读取形态，但写入权限明确，不能通过底层入口绕过绑定限制。

解锁材料独立于待解锁记录。已选择的加密 backend 不可解锁或损坏时明确失败，不能当空仓库覆盖。
持久提交失败不发布新 revision；通知失败不把已保存结果误报为未保存。首版不承诺跨进程 writer 或跨 config/Vault 事务。

## 4. 扫码与实时应用走一条业务路径

```text
Workbench ──Cap’n Web──→ 插件开始扫码
                         ↓
                 平台返回 token（仅服务端）
                         ↓
                 Vault 提交账号记录 R
                         ↓
                 插件观察更新、切换客户端
                         ↓
                 UI 显示已保存 / 已连接
```

扫码 attempt 属于插件临时状态，不依赖单个 RpcTarget 存活。页面刷新可重新查询；取消、过期或插件停止结束流程。
首版宿主重启后重新扫码。Workbench 只接收二维码、必要账号信息和状态，不接收 token。
完成扫码时重新检查权限、目标账号、可写性和预期 revision，避免覆盖期间发生的新授权。
同一业务方法也可由 headless 宿主调用，不把逻辑藏在 Workbench adapter 里。

Vault 负责保存和通知，插件负责真正使用新值：

- 动态读取认证信息的客户端可使用最新快照；固定 token 的 SDK 需重建并切换客户端。
- 按账号串行应用，切换前核对 revision 和 generation，撤销旧订阅并回收旧客户端。
- 删除凭据后停止接纳该账号的新请求；在途请求如何结束由插件决定。
- UI 区分 Vault 的 committedRevision 与插件的 appliedRevision；保存成功不等于已连接。

通知允许合并为最新状态，消费者应可重复处理并收敛；它不是 exactly-once 业务队列。
回调在存储锁外执行，不因一个账号连接失败阻塞其他账号。

自动刷新在事务外请求平台，再以读到的 revision 条件提交整条新凭据；插件按账号串行刷新。
旧刷新不能覆盖新扫码结果。条件写入不撤销平台已经发生的轮换；平台成功而本地保存失败时报告恢复或重新授权需要。

## 5. Workbench 与 agent 如何理解它

一个插件设置页面可以同时展示普通配置、账号列表和扫码操作，不要求它们共用一个存储事务。

```text
config.defaultAccountId = primary
vault[primary]   env 管理    只读    已连接
vault[secondary] KV 管理     可写    已保存 R8 / 已应用 R7
```

“新增账号并设为默认”先保存账号，再修改 config。第二步失败就报告“账号已保存，默认选择未修改”，允许重试。
删除被引用账号由业务用例要求改选或明确解除；引用缺失时报告未就绪，不擅自换用另一个账号。
配置选择变化与凭据变化都由插件连接逻辑处理，切换前核对最新账号选择。

agent 的固定阅读路径是：

1. 数据声明：config schema、对外的 Vault 记录 schema。
2. 宿主绑定：哪些 env/file 进入哪些目标。
3. 业务方法：扫码、刷新、连接、断开。
4. 更新处理：哪里观察变化、切换客户端、报告应用结果。
5. Workbench adapter：哪些 RPC 调用哪些业务方法。

这是职责约定，不强制拆成五个文件。框架从声明和绑定提供 describe/validate/explain，
展示来源、权限、存在性和 revision；Vault 明文不进入管理返回、错误、日志和默认导出。
在线开发操作继续使用已有开发控制台，无需 agent 专用控制面。

## 6. 采纳前验证

用以下场景验证设计，再定 public API：

- 工厂隔离：同一模块创建两个不同 startup 的 Host 不串值；异步工厂正确等待，构建不执行工厂且能覆盖条件插件制品。
- 单 token 部署：无 Workbench、无磁盘 backend，显式 env 绑定后官方插件可完成真实操作。
- 双账号扫码：分别保存和更新，运行请求实际采用新凭据，默认账号切换不串线。
- 并发与失败：旧刷新冲突、提交失败、应用失败、删除重建、HMR 均有准确结果且不会倒退。
- 生命周期与恢复：提交后重启可读，旧订阅失效，密钥轮换失败保留旧数据，备份可恢复。
- 下游与数据：审计 Documents/blobs 使用；必要时显式迁移，不能因为重设计就丢弃既有数据。

下一轮优先评审工厂模式下的构建清单来源；其余为 Vault 声明/观察 API、绑定类型与文件语法、动态 owner 未出现时的处理，以及 blobs 的保留需求。
实施后再更新当前工程文档、用户文档和发布记录。本提案不将这些新规则描述为现有能力。
