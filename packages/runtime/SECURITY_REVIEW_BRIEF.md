# Security Review Brief

请只按当前实现审查，不要按历史版本、兼容层或可能的未来扩展审查。

## 审查目标

- `verification` 只回答一件事：
  当前 host 是否允许进入 control plane
- `vault` 只回答一件事：
  敏感数据是否被正确加密存储，并且当前 host 是否具备可用解锁材料
- host 在插件激活前完成 vault preflight；vault 不可用时不进入后续运行流程

## 当前模型

- 长期安全材料只有一个文件：
  `data/security/identity.json`
- `identity.json` 只承载两类长期材料：
  `verification` 的 gate + credentials
  `vault` 的 host identity + deploy recipients
- `ctx.root.verification`
  host-only gate
- `ctx.vault`
  插件与 runtime 共享的加密存储面，只负责数据读写
- `ctx.root.vaultAdmin`
  host-only vault 管理面
- `/security`
  唯一浏览器管理面
- `runtime security client`
  浏览器访问 `/security` 的专用 carrier，不属于通用 transport client
- OTP 与 passkey 的协议/密码学校验交给成熟库，runtime 自身只保留 host 状态与材料管理语义

## 必须成立的事实

- verification 与 vault 解耦
- verification 不参与 vault 解锁
- vault 不继承 verification session
- verification 不做业务校验、schema 校验、插件私有规则
- vault 不自建第二套认证体系
- namespace 只是存储分区，不表达权限
- transport 只承载和展示结果，不反向定义安全语义
- security 管理不进入 plugin control-plane
- security 管理不进入未来外部 tool surface
- 插件只使用 `ctx.vault` 存储面，不越过 host 边界管理 security

## 当前接口语义

- `ctx.root.verification.authorize()`
  纯读；只输出 `allow/reason`
- `ctx.root.verification.describe()`
  纯读；只输出 gate mode、method、users 概览、当前状态
- `ctx.root.verification.verifyPassword()` / `verifyOtp()` / `finishPasskeyAuthentication()`
  只在对应 method 成功时写当前 verification session
- `ctx.root.verification.clear()`
  清当前 verification session
- `ctx.root.verification.setMode()`
  只更新 gate mode，并写入 `identity.json`
- `ctx.root.verification.setMethod()`
  只切换全局验证方式，并清空不兼容 users
- `ctx.root.verification.upsertPasswordUser()`
  创建或覆盖 password user，并写入 `identity.json`
- `ctx.root.verification.provisionOtpUser()`
  生成或替换 OTP secret，并写入 `identity.json`
- `ctx.root.verification.beginPasskeyRegistration()` / `finishPasskeyRegistration()`
  显式注册 passkey user，并写入 `identity.json`
- `ctx.root.verification.deleteUser()`
  删除 verification user，并写入 `identity.json`

- `ctx.root.vaultAdmin.describe()`
  纯读；只做 mount/material/status 概览，不触发解锁
- `ctx.root.vaultAdmin.preflight()`
  检查 host 当前是否具备可用解锁条件
- `ctx.root.vaultAdmin.unlock()`
  执行显式解锁
- `ctx.root.vaultAdmin.rekey()`
  重写受管 envelope
- `ctx.root.vaultAdmin.ensureHostKey()`
  准备 host 长期身份
- `ctx.root.vaultAdmin.generateDeployKey()`
  生成 deploy keypair
- `ctx.root.vaultAdmin.setDeployRecipients()`
  更新 deploy recipients

## 状态约束

- verification 状态只表达：
  `mode`
  `method`
  `state.allow`
  `state.reason`
  `users[]` 这种必要概览
- verification 的 transport 路径、页面路径、cookie 名称不属于核心安全状态
- vault 状态只表达：
  mount 是否存在
  当前是否解锁
  解锁来源
  当前材料状态
  数据概览
- 任何只为 UI 展示、transport 跳转、缓存命中、调试方便存在的字段，都不应回流成核心安全语义

## Host 启动约束

- host 在插件运行前调用 `bootstrapHostVault(ctx)`
- `bootstrapHostVault(ctx)` 的顺序必须保持：
  `describe()` -> 仅在 mount 缺失且 host identity 缺失时 `ensureHostKey()` -> `preflight()`
- mount 不存在时，允许空 vault 启动
- mount 已存在且可解锁时，允许继续启动
- mount 已存在但当前材料无法解锁时，必须终止启动

## 审查重点

- 这个概念是否还能继续压缩
- 这个字段是否只是派生值
- 这个接口是否和别的接口表达同一件事
- 这层抽象是否只是为了假想扩展
- 这段实现是否忠实服务于 host gate 或 vault 加密目标
- 这段 transport / 页面 / API 代码是否把承载细节反向注入了核心语义
- 是否还存在任何 host-only 能力挂在插件侧语义上
- 是否还存在任何插件侧能力越过了 host 安全边界
- 是否还有可以删除的中间态、包装层、转发 helper、缓存壳

## 红线

- 不要重新引入 config 驱动的 gate 来源
- 不要重新引入第二份长期安全材料
- 不要把 verification session 带入 vault
- 不要把 vault 可用性绑定到 verification allow
- 不要让 `/security` 之外的 carrier 持有自己的安全真相
- 不要让 plugin API 或未来外部 tool surface 暴露 security 管理动作

## 期望输出

如果发现问题，优先指出：

- 哪个概念是重复的
- 哪个字段是派生值
- 哪个接口语义重叠
- 哪个文件夹或模块边界还能收缩
- 哪段实现让 transport/UI 反向侵入了核心安全模型

如果没有问题，也请明确说明：

- 当前模型是否已经足够闭合
- 哪些地方虽然还能继续抽象整理，但继续改动的收益已经很低
