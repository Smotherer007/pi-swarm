/**
 * Schema pieces shared by the swarm tools.
 *
 * The scope list is derived from ALL_SCOPES instead of being repeated per tool:
 * five hand-written copies drifted apart once already, and a scope missing from
 * a schema is a feature nobody can switch on.
 */

import { Type } from "typebox";

import { ALL_SCOPES } from "../types.ts";

export const scopeSchema = Type.Union(ALL_SCOPES.map((scope) => Type.Literal(scope)));

/** "chat, knowledge:read, ..." for tool descriptions. */
export const SCOPE_LIST = ALL_SCOPES.join(", ");
