/** JSON-serialisable value. Server functions must return these (TanStack Start rejects `unknown`). */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }

/** Narrow a DB jsonb value (typed loosely) to Json for transport. Values originate from JSON already. */
export const asJson = (v: unknown) => v as JsonObject
export const asJsonArray = (v: unknown) => v as JsonObject[]
