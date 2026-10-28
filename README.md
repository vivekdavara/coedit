# Coedit

A real-time collaborative plain-text editor built on a hand-written sequence CRDT (RGA, the Replicated Growable
Array), in TypeScript: the CRDT, a WebSocket sync server (Node, `ws`) and a React client (Vite), as npm workspaces.

**Status: day 1 of 5.** The design (DESIGN.md), the workspace scaffold and CI. The CRDT itself arrives on day 2.

## Layout

| Path              | What                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `packages/crdt`   | `@coedit/crdt`: the CRDT and the sync protocol's messages; runs in the browser and in Node |
| `packages/server` | `@coedit/server`: the sync server (port 8110)                                              |
| `packages/client` | `@coedit/client`: the React editor (Vite dev server on port 5173)                          |

## How to run

Node 22.18 or later (the TypeScript runs on Node's own type stripping; nothing is compiled for the server or tests).

```bash
npm ci
npm run check
```

`npm run check` runs the type checker, ESLint and Prettier, the tests (Node's built-in runner) and the client
build. The pieces one at a time:

```bash
npm start -w @coedit/server
```

```bash
npm run dev -w @coedit/client
```

## License

MIT
