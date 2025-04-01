// ExtendedDIContainer.ts
import { Container, Newable } from "diod";

export interface DIContainer {
  get<T>(target: Newable<T>): T;
  getOptional<T>(target: Newable<T>): T | undefined;
}

export class ExtendedDIContainer implements DIContainer {
  private container: Container;

  constructor(container: Container) {
    this.container = container;
  }

  get<T>(target: Newable<T>): T {
    return this.container.get(target);
  }

  getOptional<T>(target: Newable<T>): T | undefined {
    try {
      return this.container.get(target);
    } catch (error) {
      return undefined;
    }
  }
}
