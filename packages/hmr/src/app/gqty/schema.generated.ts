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

export const scalarsEnumsHash: ScalarsEnumsHash = {
  Boolean: true,
  Float: true,
  String: true,
};
export const generatedSchema = {
  Book: {
    __typename: { __type: "String!" },
    authorID: { __type: "Float!" },
    id: { __type: "Float!" },
    title: { __type: "String!" },
  },
  mutation: {},
  query: {
    __typename: { __type: "String!" },
    _empty: { __type: "String!" },
    books: { __type: "[Book!]!" },
    hello: { __type: "String!", __args: { name: "String" } },
  },
  subscription: {},
} as const;

export interface Book {
  __typename?: "Book";
  authorID: ScalarsEnums["Float"];
  id: ScalarsEnums["Float"];
  title: ScalarsEnums["String"];
}

export interface Mutation {
  __typename?: "Mutation";
}

export interface Query {
  __typename?: "Query";
  _empty: ScalarsEnums["String"];
  books: Array<Book>;
  hello: (args?: {
    name?: Maybe<ScalarsEnums["String"]>;
  }) => ScalarsEnums["String"];
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
} & {};
