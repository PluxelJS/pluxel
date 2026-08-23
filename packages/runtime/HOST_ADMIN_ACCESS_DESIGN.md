# Host Access

实现入口：

- `packages/runtime/src/services/admin-access/AdminAccessService.ts`
- `packages/runtime/src/services/vault/VaultService.ts`
- `packages/runtime/src/services/vault.ts`
  Vault public types；是否安装 capability 只由 host `vault` config 决定
- `packages/runtime/src/api/http/security.ts`
- `packages/workbench-app/src/app/security/SecurityScreen.tsx`

## 核心原则

- adminAccess 只回答 host management surface 是否允许访问
- Pluxel 没有 workbench 非 admin 用户模型；通过验证的人就是 workbench admin
- Pluxel 不保存本地账号、密码、OTP secret 或 passkey credential
- `workbench: false` 不挂载 Workbench Plane；同时省略 `management` 时也不安装 Management Plane
- `workbench.enabled=true` 隐式启用 private management，不要求 OIDC
- 顶层 `management` object 显式安装 headless management；`management.access` 指定 access policy
- `management.access.exposure='public'` 必须在同一 access object 配置 OIDC，否则 fail fast

`AdminAccessService` 是 runtime 内部实现；顶层 `management` 是宿主配置入口。object 的存在会在 Workbench disabled 时启用
headless Management Plane；没有第二个 `enabled` flag。`management.access` 或整个 `management` 省略时，Workbench-enabled host
使用 private default。

- private policy 可以携带 OIDC 配置，只有切换到 public 后才参与授权
- listen/bind host 属于 launcher/deployment concern，不作为 runtime access policy 的唯一事实来源
- vault 只负责加密落盘，和 OIDC 身份验证解耦
- `data/security/identity.json` 只保存 vault host identity 和 deploy recipients

## 核心接口

- `ctx.root.adminAccess`
  `authorize()` / `describe()`；`allow=true` 表示允许进入 management surface
- `ctx.vault`
  `kv()` / `docs()` / `blobs()` / `namespace()` / `flush()`
- `ctx.root.vaultAdmin`
  `preflight()` / `describe()` / `unlock()` / `rekey()` / `ensureHostKey()` / `generateDeployKey()` / `setDeployRecipients()`
- host 启动引导
  在 Plugin lifecycle 前统一 prepare immutable Context plan 的 eager leaf capabilities
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

`management.access.oidc.requiredClaims` 是 admin 准入策略，不是普通登录策略。public
admin access 下，OIDC JWT 满足 issuer/audience/requiredClaims 后即视为 admin；不满足则不能进入后台。

- vault
  `present` / `unlocked` / `unlockedBy` / `lastError` / `deploy` / `hostIdentityPresent` / `namespaces`

## Host 启动约束

- public admin access 必须在 HTTP 服务初始化时通过 OIDC 配置校验
- Vault 只有一个启用入口：host `vault` 为配置对象；omitted/`false` 时 capability 和 backend 都 absent
- host 在插件运行前 prepare Context plan；vaultAdmin backing 的 eager leaf hook 完成 vault bootstrap。
  dynamic/HMR 不做插件级归因，也必须在首个 Plugin lifecycle 前完成同一 plan prepare
- vaultAdmin `prepare()` 的顺序必须保持：
  `describe()` -> 仅在 mount 缺失且 host identity 缺失时 `ensureHostKey()` -> `preflight()`
- mount 不存在时在启动期初始化一个空 mount 并保持已解锁
- mount 已存在且可解锁时通过
- mount 已存在但当前材料无法解锁时终止启动
- `ctx.vault` 只代表 ready storage；普通 kv/docs/blobs API 不做运行期自动解锁
- fail fast 不追踪具体插件消费者；排查使用
  `rg "vault:|ctx\\.vault" .`
