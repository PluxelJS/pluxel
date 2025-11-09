/**
 * GQty AUTO-GENERATED CODE: PLEASE DO NOT MODIFY MANUALLY
 */

import { type ScalarsEnumsHash } from "gqty";

export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = {
  [K in keyof T]: T[K];
};
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & {
  [SubKey in K]?: Maybe<T[SubKey]>;
};
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & {
  [SubKey in K]: Maybe<T[SubKey]>;
};
export type MakeEmpty<
  T extends { [key: string]: unknown },
  K extends keyof T
> = { [_ in K]?: never };
export type Incremental<T> =
  | T
  | {
      [P in keyof T]?: P extends " $fragmentName" | "__typename" ? T[P] : never;
    };
/** All built-in and custom scalars, mapped to their actual values */
export interface Scalars {
  ID: { input: string; output: string };
  String: { input: string; output: string };
  Boolean: { input: boolean; output: boolean };
  Int: { input: number; output: number };
  Float: { input: number; output: number };
}

export enum PluginStatusEntryLifecycleStage {
  disabled = "disabled",
  running = "running",
  stopped = "stopped",
}

export interface UpdatePluginGroupsGroupsInput {
  groupId: Scalars["String"]["input"];
  name: Scalars["String"]["input"];
  pluginIds: Array<Scalars["String"]["input"]>;
}

export enum UpdatePluginStatusStatusInput {
  disable = "disable",
  enable = "enable",
  restart = "restart",
  start = "start",
  stop = "stop",
}

export const scalarsEnumsHash: ScalarsEnumsHash = {
  Boolean: true,
  Float: true,
  PluginStatusEntryLifecycleStage: true,
  String: true,
  UpdatePluginStatusStatusInput: true,
};
export const generatedSchema = {
  BuildSnapshotResult: {
    __typename: { __type: "String!" },
    error: { __type: "String" },
    ok: { __type: "Boolean!" },
    path: { __type: "String" },
  },
  PluginDependency: {
    __typename: { __type: "String!" },
    isRunning: { __type: "Boolean!" },
    name: { __type: "String!" },
  },
  PluginDetail: {
    __typename: { __type: "String!" },
    dependencies: { __type: "[PluginDependency!]!" },
    desc: { __type: "String!" },
    name: { __type: "String!" },
  },
  PluginGroup: {
    __typename: { __type: "String!" },
    groupId: { __type: "String!" },
    name: { __type: "String!" },
    pluginIds: { __type: "[String!]!" },
  },
  PluginIdScope: {
    __typename: { __type: "String!" },
    name: { __type: "String!" },
  },
  PluginScope: {
    __typename: { __type: "String!" },
    detail: { __type: "PluginDetail!" },
    name: { __type: "String!" },
    status: { __type: "PluginStatusEntry!" },
  },
  PluginStatusEntry: {
    __typename: { __type: "String!" },
    isEnabled: { __type: "Boolean!" },
    isRunning: { __type: "Boolean!" },
    lifecycleStage: { __type: "PluginStatusEntryLifecycleStage!" },
    name: { __type: "String!" },
  },
  PluginStatusMutationResult: {
    __typename: { __type: "String!" },
    code: { __type: "String!" },
    error: { __type: "String" },
    isEnabled: { __type: "Boolean" },
    isRunning: { __type: "Boolean" },
    lifecycleStage: { __type: "PluginStatusEntryLifecycleStage" },
  },
  PluginStatusOverview: {
    __typename: { __type: "String!" },
    statuses: { __type: "[PluginStatusEntry!]!" },
    summary: { __type: "PluginStatusSummary!" },
  },
  PluginStatusSummary: {
    __typename: { __type: "String!" },
    disabled: { __type: "Float!" },
    running: { __type: "Float!" },
    stopped: { __type: "Float!" },
    total: { __type: "Float!" },
  },
  UpdatePluginGroupsGroupsInput: {
    groupId: { __type: "String!" },
    name: { __type: "String!" },
    pluginIds: { __type: "[String!]!" },
  },
  mutation: {
    __typename: { __type: "String!" },
    buildSnapshot: { __type: "BuildSnapshotResult!" },
    updatePluginGroups: {
      __type: "[PluginGroup!]!",
      __args: { groups: "[UpdatePluginGroupsGroupsInput!]!" },
    },
    updatePluginStatus: {
      __type: "PluginStatusMutationResult!",
      __args: { name: "String!", status: "UpdatePluginStatusStatusInput!" },
    },
  },
  query: {
    __typename: { __type: "String!" },
    _empty: { __type: "String!" },
    plugin: { __type: "PluginScope!", __args: { name: "String!" } },
    pluginGroups: { __type: "[PluginGroup!]!" },
    pluginId: { __type: "PluginIdScope!", __args: { name: "String!" } },
    pluginStatus: { __type: "PluginStatusOverview!" },
  },
  subscription: {},
} as const;

export interface BuildSnapshotResult {
  __typename?: "BuildSnapshotResult";
  error?: Maybe<Scalars["String"]["output"]>;
  ok?: Scalars["Boolean"]["output"];
  path?: Maybe<Scalars["String"]["output"]>;
}

export interface PluginDependency {
  __typename?: "PluginDependency";
  isRunning?: Scalars["Boolean"]["output"];
  name?: Scalars["String"]["output"];
}

export interface PluginDetail {
  __typename?: "PluginDetail";
  dependencies: Array<PluginDependency>;
  desc?: Scalars["String"]["output"];
  name?: Scalars["String"]["output"];
}

export interface PluginGroup {
  __typename?: "PluginGroup";
  groupId?: Scalars["String"]["output"];
  name?: Scalars["String"]["output"];
  pluginIds?: Array<Scalars["String"]["output"]>;
}

export interface PluginIdScope {
  __typename?: "PluginIdScope";
  name?: Scalars["String"]["output"];
}

export interface PluginScope {
  __typename?: "PluginScope";
  detail: PluginDetail;
  name?: Scalars["String"]["output"];
  status: PluginStatusEntry;
}

export interface PluginStatusEntry {
  __typename?: "PluginStatusEntry";
  isEnabled?: Scalars["Boolean"]["output"];
  isRunning?: Scalars["Boolean"]["output"];
  lifecycleStage?: PluginStatusEntryLifecycleStage;
  name?: Scalars["String"]["output"];
}

export interface PluginStatusMutationResult {
  __typename?: "PluginStatusMutationResult";
  code?: Scalars["String"]["output"];
  error?: Maybe<Scalars["String"]["output"]>;
  isEnabled?: Maybe<Scalars["Boolean"]["output"]>;
  isRunning?: Maybe<Scalars["Boolean"]["output"]>;
  lifecycleStage?: Maybe<PluginStatusEntryLifecycleStage>;
}

export interface PluginStatusOverview {
  __typename?: "PluginStatusOverview";
  statuses: Array<PluginStatusEntry>;
  summary: PluginStatusSummary;
}

export interface PluginStatusSummary {
  __typename?: "PluginStatusSummary";
  disabled?: Scalars["Float"]["output"];
  running?: Scalars["Float"]["output"];
  stopped?: Scalars["Float"]["output"];
  total?: Scalars["Float"]["output"];
}

export interface Mutation {
  __typename?: "Mutation";
  buildSnapshot: BuildSnapshotResult;
  updatePluginGroups: (args: {
    groups: Array<UpdatePluginGroupsGroupsInput>;
  }) => Array<PluginGroup>;
  updatePluginStatus: (args: {
    name: Scalars["String"]["input"];
    status: UpdatePluginStatusStatusInput;
  }) => PluginStatusMutationResult;
}

export interface Query {
  __typename?: "Query";
  _empty?: Scalars["String"]["output"];
  plugin: (args: { name: Scalars["String"]["input"] }) => PluginScope;
  pluginGroups: Array<PluginGroup>;
  pluginId: (args: { name: Scalars["String"]["input"] }) => PluginIdScope;
  pluginStatus: PluginStatusOverview;
}

export interface Subscription {
  __typename?: "Subscription";
}

export interface GeneratedSchema {
  query: Query;
  mutation: Mutation;
  subscription: Subscription;
}
