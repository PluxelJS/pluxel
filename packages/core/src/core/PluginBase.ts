// PluginBase.ts
// 插件基类，负责接收系统上下文，并提供 init/dispose 生命周期，同时利用 symbol 隐藏内部状态

import { ScopedPluginContext } from "./ScopedContext";

const PLUGIN_INTERNAL = Symbol("plugin:internal");

interface PluginInternal {
  lifecycle: "initialized" | "running" | "disposed";
}

export abstract class BasePlugin {
  private _ctx!: ScopedPluginContext;

  // 利用 symbol 存储插件内部状态，不暴露给外部
  [PLUGIN_INTERNAL]: PluginInternal = {
    lifecycle: "initialized",
  };

  // 系统调用此方法注入插件上下文
  public setContext(ctx: ScopedPluginContext) {
    this._ctx = ctx;
  }

  // 插件内部通过 this.ctx 访问系统依赖及注册 disposable
  protected get ctx(): ScopedPluginContext {
    if (!this._ctx) {
      throw new Error("Plugin context has not been set.");
    }
    return this._ctx;
  }

  // 生命周期方法，插件必须实现 init 来完成初始化
  abstract init(): void;

  // 默认的 dispose 方法，插件可覆盖以扩展清理逻辑
  dispose(): void {
    (this as any)[PLUGIN_INTERNAL].lifecycle = "disposed";
    this.ctx.dispose();
  }
}
