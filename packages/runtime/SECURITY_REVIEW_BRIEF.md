# Security Review Brief

请只按当前实现审查，不要按历史版本、兼容层或可能的未来扩展审查。

## 审查目标

- `verification` 只回答一件事：
  当前 host control-plane 是否允许访问
- `vault` 只回答一件事：
  敏感数据是否被正确加密存储，并且当前 host 是否具备可用解锁材料
- host 在插件激活前完成 vault preflight；vault 不可用时不进入后续运行流程

## 当前模型

- `ctx.root.verification`
  host-only access gate
- private exposure 下不做任何认证，直接 allow
- public exposure 下必须配置 OIDC，使用 issuer discovery + JWKS 校验 bearer JWT
- 绑定公网地址前必须通过 `verification.assertCanBindHost(host)` 检查 OIDC 配置
- Pluxel 不保存本地 verification users、password hash、OTP secret、passkey credential 或 verification session
- `data/security/identity.json` 只保存 vault host identity 和 deploy recipients
- `ctx.vault`
  插件与 runtime 共享的加密存储面，只负责数据读写
- `ctx.root.vaultAdmin`
  host-only vault 管理面
- `/security`
  浏览器管理面；只读展示 access policy，写操作只面向 vault

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
  纯读；输出 `allow/reason/principal`
- `ctx.root.verification.describe()`
  纯读；输出 access policy 概览和当前状态
- `ctx.root.verification.assertCanBindHost()`
  启动期检查；公网 bind 缺少 public OIDC 配置时抛错
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
  `exposure`
  `provider`
  `state.allow`
  `state.reason`
  `principal`
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

## 红线

- 不要重新引入本地 verification users
- 不要重新引入 password / OTP / passkey credential 存储
- 不要把 verification session 带入 vault
- 不要把 vault 可用性绑定到 verification allow
- 不要让 `/security` 之外的 carrier 持有自己的安全真相
- 不要让 plugin API 或未来外部 tool surface 暴露 security 管理动作
