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
  groupNode: PluginGroupNode;
  groups: Array<PluginGroup>;
};


export type PluginCatalogPluginArgs = {
  id: Scalars['String']['input'];
};


export type PluginCatalogGroupArgs = {
  id: Scalars['String']['input'];
};


export type PluginCatalogGroupNodeArgs = {
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
  nodes: Array<PluginGroupNode>;
};

export type PluginGroupNode = {
  __typename?: 'PluginGroupNode';
  id: Scalars['String']['output'];
  reference: Scalars['String']['output'];
  route: Scalars['String']['output'];
  displayName: Scalars['String']['output'];
  label: Scalars['String']['output'];
  rootExportName: Scalars['String']['output'];
  address: PluginAddress;
};

export type PluginAddress = {
  __typename?: 'PluginAddress';
  definition: PluginAddressDefinition;
  variant: PluginAddressVariant;
  forkId?: Maybe<Scalars['String']['output']>;
};

export type PluginAddressDefinition = {
  __typename?: 'PluginAddressDefinition';
  entry: PluginAddressDefinitionEntry;
  exportName: Scalars['String']['output'];
};

export type PluginAddressDefinitionEntry = {
  __typename?: 'PluginAddressDefinitionEntry';
  kind: Scalars['String']['output'];
  packageName?: Maybe<Scalars['String']['output']>;
  sourceSpace?: Maybe<Scalars['String']['output']>;
  path?: Maybe<Scalars['String']['output']>;
};

export type PluginAddressVariant =
  | 'default'
  | 'fork';

export type Plugin = {
  __typename?: 'Plugin';
  id: Scalars['String']['output'];
  reference: Scalars['String']['output'];
  route: Scalars['String']['output'];
  displayName: Scalars['String']['output'];
  label: Scalars['String']['output'];
  rootExportName: Scalars['String']['output'];
  address: PluginAddress;
  detail: PluginDetail;
  status: PluginStatus;
};

export type PluginDetail = {
  __typename?: 'PluginDetail';
  label: Scalars['String']['output'];
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

export type Query = {
  __typename?: 'Query';
  _empty: Scalars['String']['output'];
  pluginCatalog: PluginCatalog;
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
  nodes: Array<UpdatePluginGroupsGroupsNodesInput>;
};

export type UpdatePluginGroupsGroupsNodesInput = {
  definition: UpdatePluginGroupsGroupsNodesDefinitionInput;
  variant: PluginAddressVariant;
  forkId?: InputMaybe<Scalars['String']['input']>;
};

export type UpdatePluginGroupsGroupsNodesDefinitionInput = {
  entry: UpdatePluginGroupsGroupsNodesDefinitionEntryInput;
  exportName: Scalars['String']['input'];
};

export type UpdatePluginGroupsGroupsNodesDefinitionEntryInput = {
  kind: Scalars['String']['input'];
  packageName?: InputMaybe<Scalars['String']['input']>;
  sourceSpace?: InputMaybe<Scalars['String']['input']>;
  path?: InputMaybe<Scalars['String']['input']>;
};
