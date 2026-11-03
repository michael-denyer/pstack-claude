---
name: principle-type-system-discipline
description: "Apply when designing types, reviewing a function signature, or writing code in any statically-typed language. Make illegal states unrepresentable, brand semantic primitives, parse external data at boundaries, exhaust variants, derive from authoritative schemas."
user-invocable: false
---

# Type System Discipline

Make the compiler reject impossible states, mismatched primitives, and unhandled variants. Prefer defining errors and special cases out of existence over proliferating handlers. For TypeScript syntax, see the `typescript-best-practices` skill.

- **Make illegal states unrepresentable.** Model variants as sum types (discriminated unions, enums with payloads, sealed classes), not as a bag of optional fields where contradictory combinations compile. `{ completed: boolean; completedAt?: Date }` admits `completed: true` with no date. Derive the boolean from `completedAt`, or model `{ kind: 'open' } | { kind: 'done'; at: Date }`. If you can write a comment explaining when a combination of fields is valid, split it into a sum type.
- **Brand semantic primitives.** `UserId` and `OrderId` are strings underneath but should not be interchangeable. Give each its own type, such as a branded intersection in TypeScript or a newtype elsewhere. Validate once at creation, trust the type downstream. If two arguments share a primitive type but mean different things, brand them.
- **External data is untyped until parsed.** RPC payloads, JSON, IPC messages, CLI args, config files, environment variables, database rows. Have a parse function at every boundary that turns unstructured input into the typed model. The **boundary-discipline** principle skill says where to put validation.
- **Exhaustive matching is the compiler's job.** A match on a sum type must fail compilation when a new variant is added without handling, so the compiler tells the next agent where to add a case. Use your language's idiom: a `never`-typed binding in TypeScript, an unannotated `match` in Rust, `-Werror=incomplete-patterns` in Haskell, sealed-class match exhaustiveness in Kotlin.
- **Derive types from authoritative schemas.** When a protocol buffer, OpenAPI spec, GraphQL schema, database migration, design-token file, or another file owns a shape, derive from it instead of hand-rolling a parallel type. See the **encode-lessons-in-structure** principle skill.
