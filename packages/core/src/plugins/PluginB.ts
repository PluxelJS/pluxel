// PluginB.ts
import { Plugin } from "../core/PluginDecorator";
import { BasePlugin } from "../core/PluginBase";
import { PluginC } from "./PluginC";

@Plugin({ name: "PluginB", type: "hook" })
export class PluginB extends BasePlugin {
  constructor() {
    super();
  }

  init(): void {
    this.ctx.logger.info("PluginB initialized");
  }

  doSomething(): void {
    this.ctx.logger.info("PluginB doing something...");
  }
}
