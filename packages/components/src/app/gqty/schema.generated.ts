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

export interface UpdatePluginGroupsGroupsInput {
  groupId: Scalars["String"]["input"];
  name: Scalars["String"]["input"];
  pluginIds: Array<Scalars["String"]["input"]>;
}

export enum UpdatePluginStatusStatusInput {
  restart = "restart",
  start = "start",
  stop = "stop",
}

export const scalarsEnumsHash: ScalarsEnumsHash = {
  Boolean: true,
  Float: true,
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
    optional: { __type: "Boolean!" },
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
    isRunning: { __type: "Boolean!" },
    name: { __type: "String!" },
  },
  PluginStatusMutationResult: {
    __typename: { __type: "String!" },
    code: { __type: "String!" },
    error: { __type: "String" },
    isRunning: { __type: "Boolean" },
  },
  PluginStatusOverview: {
    __typename: { __type: "String!" },
    statuses: { __type: "[PluginStatusEntry!]!" },
    summary: { __type: "PluginStatusSummary!" },
  },
  PluginStatusSummary: {
    __typename: { __type: "String!" },
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
  error?: Maybe<ScalarsEnums["String"]>;
  ok: ScalarsEnums["Boolean"];
  path?: Maybe<ScalarsEnums["String"]>;
}

export interface PluginDependency {
  __typename?: "PluginDependency";
  isRunning: ScalarsEnums["Boolean"];
  name: ScalarsEnums["String"];
  optional: ScalarsEnums["Boolean"];
}

export interface PluginDetail {
  __typename?: "PluginDetail";
  dependencies: Array<PluginDependency>;
  desc: ScalarsEnums["String"];
  name: ScalarsEnums["String"];
}

export interface PluginGroup {
  __typename?: "PluginGroup";
  groupId: ScalarsEnums["String"];
  name: ScalarsEnums["String"];
  pluginIds: Array<ScalarsEnums["String"]>;
}

export interface PluginIdScope {
  __typename?: "PluginIdScope";
  name: ScalarsEnums["String"];
}

export interface PluginScope {
  __typename?: "PluginScope";
  detail: PluginDetail;
  name: ScalarsEnums["String"];
  status: PluginStatusEntry;
}

export interface PluginStatusEntry {
  __typename?: "PluginStatusEntry";
  isRunning: ScalarsEnums["Boolean"];
  name: ScalarsEnums["String"];
}

export interface PluginStatusMutationResult {
  __typename?: "PluginStatusMutationResult";
  code: ScalarsEnums["String"];
  error?: Maybe<ScalarsEnums["String"]>;
  isRunning?: Maybe<ScalarsEnums["Boolean"]>;
}

export interface PluginStatusOverview {
  __typename?: "PluginStatusOverview";
  statuses: Array<PluginStatusEntry>;
  summary: PluginStatusSummary;
}

export interface PluginStatusSummary {
  __typename?: "PluginStatusSummary";
  running: ScalarsEnums["Float"];
  stopped: ScalarsEnums["Float"];
  total: ScalarsEnums["Float"];
}

export interface Mutation {
  __typename?: "Mutation";
  buildSnapshot: BuildSnapshotResult;
  updatePluginGroups: (args: {
    groups: Array<UpdatePluginGroupsGroupsInput>;
  }) => Array<PluginGroup>;
  updatePluginStatus: (args: {
    name: ScalarsEnums["String"];
    status: UpdatePluginStatusStatusInput;
  }) => PluginStatusMutationResult;
}

export interface Query {
  __typename?: "Query";
  _empty: ScalarsEnums["String"];
  plugin: (args: { name: ScalarsEnums["String"] }) => PluginScope;
  pluginGroups: Array<PluginGroup>;
  pluginId: (args: { name: ScalarsEnums["String"] }) => PluginIdScope;
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

export type ScalarsEnums = {
  [Key in keyof Scalars]: Scalars[Key] extends { output: unknown }
    ? Scalars[Key]["output"]
    : never;
} & {
  UpdatePluginStatusStatusInput: UpdatePluginStatusStatusInput;
};
