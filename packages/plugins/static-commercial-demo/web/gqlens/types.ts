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

export type Query = {
  __typename?: 'Query';
  summary: Summary;
  customers: Array<Customer>;
  customer: Customer;
  orders: Array<Order>;
  order: Order;
  ordersByStatus: Array<Order>;
};


export type QueryCustomerArgs = {
  id: Scalars['String']['input'];
};


export type QueryOrderArgs = {
  id: Scalars['String']['input'];
};


export type QueryOrdersByStatusArgs = {
  status: OrdersByStatusStatusInput;
};

export type Summary = {
  __typename?: 'Summary';
  revenue: Scalars['Float']['output'];
  margin: Scalars['Float']['output'];
  openOrders: Scalars['Float']['output'];
  approvedOrders: Scalars['Float']['output'];
};

export type Customer = {
  __typename?: 'Customer';
  id: Scalars['String']['output'];
  name: Scalars['String']['output'];
  owner: Scalars['String']['output'];
  tier: CustomerTier;
  region: Scalars['String']['output'];
  healthScore: Scalars['Float']['output'];
};

export type CustomerTier =
  | 'enterprise'
  | 'growth'
  | 'startup';

export type Order = {
  __typename?: 'Order';
  id: Scalars['String']['output'];
  customerId: Scalars['String']['output'];
  sku: Scalars['String']['output'];
  status: OrdersByStatusStatusInput;
  amount: Scalars['Float']['output'];
  margin: Scalars['Float']['output'];
};

export type OrdersByStatusStatusInput =
  | 'draft'
  | 'review'
  | 'approved'
  | 'fulfilled';

export type Mutation = {
  __typename?: 'Mutation';
  approveOrder: Order;
  updateOrderAmount: Order;
  setCustomerHealth: Customer;
};


export type MutationApproveOrderArgs = {
  id: Scalars['String']['input'];
};


export type MutationUpdateOrderAmountArgs = {
  id: Scalars['String']['input'];
  amount: Scalars['Float']['input'];
};


export type MutationSetCustomerHealthArgs = {
  id: Scalars['String']['input'];
  score: Scalars['Float']['input'];
};
