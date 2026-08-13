# Lagrange Images

A persistent image service and language platform built to sit on Lagrange.

The short version: an image is a durable object graph, not a VM memory dump and not a pile of source files. Languages are personalities over that graph. Lagrange eventually provides the distributed persistence, placement, transactions and compute substrate underneath it.

This repository starts before that integration is ready. The same image layer therefore runs against a small in-memory backend today and probes for `lagrange-server` as an optional library. Nothing above the backend boundary should care which one is in use.

## What is here now

- a language-neutral image/object model with stable identities
- optimistic object versions and append-only image history
- named snapshots
- a backend contract and useful in-memory mock
- automatic probing for the side-effect-free `lagrange-server` package
- a seam for a real Lagrange-backed adapter without changing image code
- a language registry with the first `symmetric-smalltalk` design profile
- a tiny HTTP service so the model can be exercised immediately
- tests and an executable demo

It is intentionally boring at the bottom. That is useful: the interesting object/language work should not be coupled to cluster bootstrapping details.

## Run it

Requires Node.js 22 or newer.

```sh
npm test
npm run demo
npm start
```

The service listens on port `7331` by default.

```sh
curl http://127.0.0.1:7331/health
curl -X POST http://127.0.0.1:7331/images \
  -H 'content-type: application/json' \
  -d '{"id":"playground","name":"Playground"}'

curl -X PUT http://127.0.0.1:7331/images/playground/objects/root \
  -H 'content-type: application/json' \
  -d '{"classId":"Workspace","slots":{"title":"hello"}}'
```

## Backend selection

`LAGRANGE_BACKEND` accepts `auto`, `mock`, or `lagrange`.

- `mock`: always use the in-memory backend.
- `auto` (default): try to import `lagrange-server`; use a Lagrange image backend when a compatible adapter exists, otherwise fall back to the mock and report why in `/health`.
- `lagrange`: require the library and a compatible adapter; fail instead of silently falling back.

For local integration work, clone Lagrange beside this repository and install/link it so Node can resolve its package name:

```sh
npm install --no-save ../lagrange
```

Lagrange currently exposes an embeddable public module, but does not yet expose the small image-store adapter expected here. The first integration task is therefore explicit rather than hidden behind imports from Lagrange internals. See [docs/lagrange-integration.md](docs/lagrange-integration.md).

## Shape

```text
HTTP / tools / future GUI
          |
     ImageService
          |
   durable object model  <---- language personalities
          |
     backend contract
       /        \
    mock      Lagrange
                 |
        distributed storage + compute
```

The important boundary is between image semantics and storage mechanics. Language implementations should depend on image/runtime interfaces, not on Lagrange tables. The Lagrange adapter should know nothing about Smalltalk syntax.

## First language

The first language design is called **Symmetric Smalltalk** for now. The main experiment is to keep Smalltalk's message/object model while making blocks the uniform executable/compositional representation as far up the stack as practical. The goal is Lisp-like regularity without turning the source language into Lisp.

That is a design direction, not a frozen grammar. Parser, evaluator, compiler and bootstrap are deliberately still marked unimplemented.

## Documentation

- [Architecture](docs/architecture.md)
- [Image model](docs/image-model.md)
- [Language platform](docs/language-platform.md)
- [Lagrange integration](docs/lagrange-integration.md)
- [Security boundary](docs/security.md)
- [Roadmap](docs/roadmap.md)
- [Backend boundary decision](docs/decisions/0001-backend-boundary.md)

## A rule worth keeping

Do not import from `lagrange-server/src/...` here. If the image service needs a capability, either use Lagrange's public package surface or make the missing public seam explicit. That keeps these two projects independently comprehensible and prevents the image model from becoming a second Lagrange daemon implementation.
