# Pi Agent 插件设计

PiAgentPlugin 拥有 Pi engine 与会话；业务 Plugin 显式 `expose()` Command。本包不依赖 AgentTools，不自动镜像 root Commands。发布句柄由实际调用者 Context 的 effects 撤销，命令调用同时持有 Pi provider 与发布者 invocation lease。

每个会话在创建时解析直接 Command 或 exposure 名称，拒绝缺失、重复与 Pi 不支持的输入 schema。已发布名称固定 publication record；同名重新发布不能更新旧会话。直接定义使用会话业务 context，exposure 使用发布时的 factory。context 准备与 authorize 都在 owner lease 内，先构造 context，再判断本次操作权限；await 后重新检查发布、会话 signal 和 owner。会话工具回调在 dispose 后失效。

工具描述的名称映射稳定，冲突即失败；输入 schema 的 examples 随参数 schema 传给 Pi。Pi 隐藏的内联 `turn_start` hook 在每轮模型请求前重算可见工具，发现授权持有 Pi provider 与发布者的 invocation lease，stop 等待异步授权退出；单次调用还重新执行授权。Command Result 的 Err 投影为 Pi 原生工具失败。Ok 字符串直接成为文本；严格 JSON 值编码为 JSON 文本。非 JSON 或超限值以 `OUTPUT_ENCODING` / `OUTPUT_LIMIT` 保留本地分类，模型只收到安全说明，已经执行的命令不会重跑。

Goal、subagent 和 prompt outcome 保持 Pi 原有契约。子会话继承父会话工具记录、principal、policy 和 owner，不能扩大权限；工具调用的可信 `context.meta.sessionId` 使用实际执行的子会话 ID。父会话关闭会等待尚在创建的子会话及其工作退出。owner effects 和会话 dispose 都会 abort、等待 Pi idle 并释放资源。内置文件与 shell 工具、外部 extensions、skills、templates、themes 和 context files 关闭；只有一个内部隐藏 hook 用于可见工具刷新。

验证见 `tests/controller.test.ts`：包含真实 Pi SDK 会话的直接工具执行、caller Plugin generation 撤销、授权与 context 的异步竞态、输出编码、subagent 和创建失败清理。

Pi 是可选的 Command 载体。RPC 会话与隔离 executor 由 RPC 所在边界直接拥有，不由 Pi 会话创建或管理。
