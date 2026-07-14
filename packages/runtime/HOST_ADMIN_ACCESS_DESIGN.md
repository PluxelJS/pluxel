# Host Access

实现入口：

- `packages/runtime/src/services/admin-access/AdminAccessService.ts`
- `packages/runtime/src/services/vault/VaultService.ts`
- `packages/runtime/src/services/vault.ts`
  显式 vault boundary，注册 `ctx.vault` 和 eager `ctx.root.vaultAdmin`
- `packages/runtime/src/api/http/security.ts`
- `packages/components/src/app/security/SecurityScreen.tsx`

## 核心原则

- adminAccess 只回答 host workbench admin surface 是否允许访问
- Pluxel 没有 workbench 非 admin 用户模型；通过验证的人就是 workbench admin
- Pluxel 不保存本地账号、密码、OTP secret 或 passkey credential
- `workbench: false` 不挂载 Workbench Plane，不要求 OIDC
- `workbench.enabled=true` 且 `workbench.access.exposure='private'` 不要求 OIDC
- `workbench.enabled=true` 且 `workbench.access.exposure='public'` 必须配置 OIDC，否则 fail fast

`AdminAccessService` 及其 config 是 runtime 内部由 `workbench` 派生的安全实现，不是独立宿主配置入口。

- OIDC 可以预先保留在 private/disabled 配置里，供后续切 public 使用
- listen/bind host 属于 launcher/deployment concern，不作为 runtime access policy 的唯一事实来源
- vault 只负责加密落盘，和 OIDC 身份验证解耦
- `data/security/identity.json` 只保存 vault host identity 和 deploy recipients

## 核心接口

- `ctx.root.adminAccess`
  `authorize()` / `describe()`；`allow=true` 表示允许进入 workbench admin surface
- `ctx.vault`
  `kv()` / `docs()` / `blobs()` / `namespace()` / `flush()`
- `ctx.root.vaultAdmin`
  `preflight()` / `describe()` / `unlock()` / `rekey()` / `ensureHostKey()` / `generateDeployKey()` / `setDeployRecipients()`
- host 启动引导
  `ctx.prepareServices()`
- `/security`
  对应专用 security client
  `readOverview()` / `listEvents()`
  `vault.unlock()` / `vault.ensureHostKey()` / `vault.generateDeployKey()` / `vault.setDeployRecipients()`

## 状态模型

- adminAccess
  `exposure: 'private' | 'public'`
  `provider: 'none' | 'oidc'`
  `allow: boolean`
  `reason?: 'private' | 'missing_oidc' | 'unauthenticated' | 'invalid_token' | 'forbidden'`
  `principal?: { provider: 'oidc', subject, claims }`

`adminAccess.oidc.requiredClaims` 是 admin 准入策略，不是普通登录策略。public
admin access 下，OIDC JWT 满足 issuer/audience/requiredClaims 后即视为 admin；不满足则不能进入后台。

- vault
  `present` / `unlocked` / `unlockedBy` / `lastError` / `deploy` / `hostIdentityPresent` / `namespaces`

## Host 启动约束

- public admin access 必须在 HTTP 服务初始化时通过 OIDC 配置校验
- Vault 只有一个启用入口：显式 import `@pluxel/runtime/services/vault`
- host 在插件运行前调用 `ctx.prepareServices()`；vaultAdmin 是 eager root service，会在
  自己的 `prepare()` 里完成 vault bootstrap。dynamic/HMR 不做插件级归因，使用方如果启用
  vault 也必须在插件运行前完成同一 service prepare
- vaultAdmin `prepare()` 的顺序必须保持：
  `describe()` -> 仅在 mount 缺失且 host identity 缺失时 `ensureHostKey()` -> `preflight()`
- mount 不存在时在启动期初始化一个空 mount 并保持已解锁
- mount 已存在且可解锁时通过
- mount 已存在但当前材料无法解锁时终止启动
- `ctx.vault` 只代表 ready storage；普通 kv/docs/blobs API 不做运行期自动解锁
- fail fast 不追踪具体插件消费者；排查使用
  `rg "@pluxel/runtime/services/vault|ctx\\.vault" .`
