/**
 * The lock between a shape this window DECLARES and the schema that checks an answer has it.
 *
 * Everything the browser is told arrives as bytes from a socket or a `fetch`, and a `as T` on the
 * far side of `JSON.parse` is a claim nobody checked: the window then draws a field the server
 * stopped sending as `undefined`, branches on a discriminant that is not a member of its union, and
 * reports none of it. So the wire is PARSED — `lib/protocol.ts` for the two socket protocols,
 * `lib/records.ts` for the record browser, `lib/api.ts` for the HTTP answers — and this module is
 * the one thing those three share.
 *
 * `exact` is what stops a schema and a type from becoming two descriptions of one shape that quietly
 * disagree. The types stay the source of truth — they are what `tests/webProtocol.test.ts` pins to
 * the server's own declarations, in both directions, so a field renamed over there fails a typecheck
 * rather than emptying a panel — and every schema is written against one of them. A schema that
 * forgets a field, invents one, or makes a required field optional does not compile.
 */

import { z } from "zod";

/**
 * A shape as a PARSER can promise it: the same type, with its optional properties widened to admit
 * `undefined`.
 *
 * `exactOptionalPropertyTypes` is on in this project, so `{ meta?: number }` says the key may be
 * ABSENT and may not be present-holding-undefined. No schema can make that distinction — a Zod
 * `.optional()` accepts both — so the comparison in `exact` is against this widened form. Nothing
 * else is relaxed: a field the schema forgot, a field it invented, a required field it made optional
 * and a wrong primitive all still fail.
 *
 * ONE LEVEL, deliberately. A nested shape is built from its OWN `exact` schema — which hands back
 * the narrow type — so widening below the surface would ask a composite to be looser than the parts
 * it is made of. The rule that follows is worth knowing before writing a schema: an object nested
 * inside another gets its own `exact` declaration rather than being spelled inline, and a field that
 * is optional inside an inline one will say so by failing to compile.
 *
 * The distinction is only a compile-time one anyway, which is what makes `exact`'s single cast
 * honest. A JSON body cannot carry an explicit `undefined`, and Zod leaves an absent optional key
 * absent rather than writing one in — so what comes back out of a parse really is the narrower type.
 */
type Wire<T> = T extends object
  ? {
      // An index signature is passed through as it stands: `string extends K` is what tells one from
      // a named key, and a record of one value type has no `?` on any key to widen.
      [K in keyof T]: string extends K ? T[K] : K extends OptionalKeys<T> ? T[K] | undefined : T[K];
    }
  : T;

/**
 * Which of a shape's keys may be left out.
 *
 * Spelled through `Pick` because that is the only thing that can see the `?` itself: a mapped type
 * reading `T[K]` gets the property's type with `undefined` already stripped back off, so the
 * widening above has to be told which keys to put it back on.
 */
type OptionalKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never;
}[keyof T];

/**
 * Tie a schema to the type it stands for, and hand back a parser typed as that type.
 *
 * Read as two steps at the call site — `exact<Health>()(z.object({ … }))` — because TypeScript
 * infers all of a call's type arguments or none of them, and the shape has to be inferred while the
 * type it is checked against is named. The constraint runs both ways: the schema's output must be
 * assignable to the declared shape, and the declared shape must be assignable to the schema's
 * output, so neither side can hold a field the other does not.
 *
 * ONE CAST, HERE AND NOWHERE ELSE, and it is what `Wire` above buys: the parsed value is announced
 * as `T` rather than as the widened form the comparison is made in, which is what lets a caller hand
 * the result straight to a component expecting the mirrored type.
 */
export function exact<T>() {
  return <S extends z.ZodType<Wire<T>>>(
    schema: S & (Wire<T> extends z.infer<S> ? unknown : never),
  ): z.ZodType<T> => schema as unknown as z.ZodType<T>;
}
