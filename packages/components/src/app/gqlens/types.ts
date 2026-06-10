export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = { [_ in K]?: never };
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
};

export type PluginCatalog = {
  __typename?: 'PluginCatalog';
  plugin: Plugin;
  plugins: Array<Plugin>;
  status: PluginStatusOverview;
  group: PluginGroup;
  groups: Array<PluginGroup>;
};


export type PluginCatalogPluginArgs = {
  id: Scalars['String']['input'];
};


export type PluginCatalogGroupArgs = {
  id: Scalars['String']['input'];
};

export type PluginStatusOverview = {
  __typename?: 'PluginStatusOverview';
  plugins: Array<Plugin>;
  summary: PluginStatusSummary;
};

export type PluginStatusSummary = {
  __typename?: 'PluginStatusSummary';
  total: Scalars['Float']['output'];
  running: Scalars['Float']['output'];
  stopped: Scalars['Float']['output'];
  disabled: Scalars['Float']['output'];
};

export type PluginGroup = {
  __typename?: 'PluginGroup';
  id: Scalars['String']['output'];
  groupId: Scalars['String']['output'];
  name: Scalars['String']['output'];
  pluginIds: Array<Scalars['String']['output']>;
};

export type Plugin = {
  __typename?: 'Plugin';
  id: Scalars['String']['output'];
  name: Scalars['String']['output'];
  detail: PluginDetail;
  status: PluginStatus;
};

export type PluginDetail = {
  __typename?: 'PluginDetail';
  name: Scalars['String']['output'];
  desc: Scalars['String']['output'];
  dependencies: Array<Plugin>;
};

export type PluginStatus = {
  __typename?: 'PluginStatus';
  isRunning: Scalars['Boolean']['output'];
  isEnabled: Scalars['Boolean']['output'];
  lifecycleStage: PluginStatusLifecycleStage;
  source: PluginSourceInfo;
};

export type PluginStatusLifecycleStage =
  | 'running'
  | 'stopped'
  | 'disabled';

export type PluginSourceInfo = {
  __typename?: 'PluginSourceInfo';
  kind: PluginSourceInfoKind;
  moduleId?: Maybe<Scalars['String']['output']>;
  packageName?: Maybe<Scalars['String']['output']>;
  version?: Maybe<Scalars['String']['output']>;
  tag?: Maybe<Scalars['String']['output']>;
};

export type PluginSourceInfoKind =
  | 'hmr'
  | 'package'
  | 'unknown';

export type PackageManager = {
  __typename?: 'PackageManager';
  loadIssue: PackageLoadIssue;
  loadIssues: Array<PackageLoadIssue>;
  inventoryEntry: PackageInventoryEntry;
  inventory: Array<PackageInventoryEntry>;
};


export type PackageManagerLoadIssueArgs = {
  id: Scalars['String']['input'];
};


export type PackageManagerInventoryEntryArgs = {
  id: Scalars['String']['input'];
  includeUntracked?: InputMaybe<Scalars['Boolean']['input']>;
};


export type PackageManagerInventoryArgs = {
  includeUntracked?: InputMaybe<Scalars['Boolean']['input']>;
};

export type PackageLoadIssue = {
  __typename?: 'PackageLoadIssue';
  id: Scalars['String']['output'];
  spec: PackageIssueSpec;
  source: PackageLoadIssueSource;
  message: Scalars['String']['output'];
  error?: Maybe<Scalars['String']['output']>;
  moduleId?: Maybe<Scalars['String']['output']>;
  recordedAt: Scalars['Float']['output'];
};

export type PackageIssueSpec = {
  __typename?: 'PackageIssueSpec';
  key: Scalars['String']['output'];
  name: Scalars['String']['output'];
  version?: Maybe<Scalars['String']['output']>;
  tag?: Maybe<Scalars['String']['output']>;
  target: Scalars['String']['output'];
  raw: Scalars['String']['output'];
};

export type PackageLoadIssueSource =
  | 'load'
  | 'restore'
  | 'retry';

export type PackageInventoryEntry = {
  __typename?: 'PackageInventoryEntry';
  id: Scalars['String']['output'];
  spec: PackageIssueSpec;
  installedVersion?: Maybe<Scalars['String']['output']>;
  requestedVersion?: Maybe<Scalars['String']['output']>;
  loaded: Scalars['Boolean']['output'];
  moduleId?: Maybe<Scalars['String']['output']>;
  issues?: Maybe<Array<PackageLoadIssue>>;
};

export type Query = {
  __typename?: 'Query';
  _empty: Scalars['String']['output'];
  pluginCatalog: PluginCatalog;
  packageManager: PackageManager;
};

export type Mutation = {
  __typename?: 'Mutation';
  updatePluginGroups: Array<PluginGroup>;
};


export type MutationUpdatePluginGroupsArgs = {
  groups: Array<UpdatePluginGroupsGroupsInput>;
};

export type UpdatePluginGroupsGroupsInput = {
  groupId: Scalars['String']['input'];
  name: Scalars['String']['input'];
  pluginIds: Array<Scalars['String']['input']>;
};
