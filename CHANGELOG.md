# Changelog

## 1.0.0 (2026-11-01)

The first release: a collaborative plain-text editor on a hand-written RGA, built over five days. Protocol version 1.

### The CRDT (`@coedit/crdt`)

- RGA with Lamport ids (counter, then replica id by code unit), runs of characters placed by the skip rule, tombstones,
  and operations accepted in any order (waiting until their origin arrives) instead of requiring causal delivery.
- Conflicting inserts (a known id reused with other content) refused atomically; counters past a replica's capacity
  (2^23 - 1 elements, under V8's Map limit) refused up front.
- Positions as ids for presence (`idBefore`, `indexAfter`), so a remote cursor follows its text.
- Snapshots as ordinary operations in id order (`Rga.snapshot`), which rebuild a replica's state exactly and merge into
  one holding any part of the log.
- Elements kept in blocks of 512 with visible counts instead of one scanned array: local typing flat at about 260,000
  edits a second at 369,000 elements (1,462 a second before).
- Tombstone collection by the leaf rule (`Rga.collect`): a tombstone that is the last of its run and no run's origin,
  deleted long enough ago, is removed, cascading up; the collected ids kept as ranges so an operation naming one is
  told apart from one that is merely early.
- A strict JSON reader and a canonical encoder for the wire format, so two replicas never read one message two ways.

### The sync server (`@coedit/server`)

- One hub per document: a numbered log in causal order, the echo as the acknowledgement, catch-up from any `have` in
  batches paced by the socket, presence, refusals that leave the server's state byte for byte as it was.
- An op log on disk, appended and fsynced before anything is relayed; snapshots every 10,000 entries (temporary file,
  fsync, rename, directory fsync); recovery that drops a torn last line and refuses any other damage; idle documents
  unloaded after 60 s; a corrupt document refused while the others are served.
- Collection at each snapshot of what the snapshot lets go of, written with the snapshot; `resync` for a client that
  names a collected element. A snapshot whose directory can't be synced after its rename stops the hub, so the next
  join loads what is on disk; every open syncs the directory.
- `/healthz`, origin checks (`COEDIT_ORIGINS`), a 1 MiB message limit, a heartbeat, a slow-reader limit, signal
  handling, and `COEDIT_HOST`, `COEDIT_PORT`, `COEDIT_DATA`.

### The client (`@coedit/client`)

- A React textarea editor: each input becomes one edit in code points; remote changes patched into the text with the
  caret kept beside its element; remote cursors; held during IME composition; an offline switch.
- The sync client: an outbox resent from the right place after a reconnect, backoff, rebuilding from a snapshot (unsent
  edits gone over again, inserts from the first whose origin was collected on re-issued under new ids where a
  never-collecting server would put them), and rejoining after `resync`.

### Testing

- A network simulator for convergence properties, itself tested in both directions with deliberately broken toy CRDTs.
- Property tests against an independent implementation of the ordering spec, end-to-end convergence on the real server
  under generated schedules (with and without collection), SIGKILL while a client types, injected storage failures,
  and Playwright with two browsers editing at once and offline.
- Reviews on every day by a separate agent writing each finding as a failing test (the `review*` test files).

See the README for measured results and limitations.
