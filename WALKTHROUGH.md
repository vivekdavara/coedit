# Walkthrough

Questions an interviewer is likely to ask about Coedit, with short answers grounded in the code. DESIGN.md has the
full specification; this file is for explaining it out loud.

## The idea (day 1)

**What is it, in one breath?** A plain-text editor several people can edit at once. Each browser tab holds a replica
of a sequence CRDT (RGA); local edits apply immediately and go out as operations; the server orders, stores and relays
them. Operations commute, so every replica that has applied the same operations shows the same text, whatever order
they arrived in.

**Why a CRDT instead of operational transformation?** OT transforms each pair of concurrent edits against each other,
which needs a central server for correctness in practice and is notoriously easy to get subtly wrong, especially with
offline edits. With a CRDT every replica is equal and merging is just applying operations; the server is a relay that
also checks what it relays. (DESIGN.md "Decisions".)

**How does RGA decide where concurrent inserts go?** Every element has an id `(counter, replica)` and names the element
it was typed after (its origin). To place element `x` after origin `o`, start after `o` and skip every element with an
id larger than `x`'s; stop at the first smaller one. Picture each element as a child of its origin, children sorted by
id from largest to smallest, the document as a preorder walk. A child's id is always larger than its parent's (Lamport
clock), so a sibling larger than `x` has a whole subtree larger than `x`, and skipping "larger" skips exactly that
subtree. The result depends only on which elements exist, not on arrival order. (DESIGN.md "Insert".)

**What if an insert's counter isn't larger than its origin's?** Then the skip rule can stop inside someone else's
subtree, and replicas that integrated in different orders put it in different places: permanent divergence. A correct
client can't produce one (its Lamport clock is at least the origin's counter), so the decoder refuses it:
`packages/crdt/src/protocol.ts`, `op()`, "must be less than the insert's counter".

**Why does typing at the same spot not interleave?** A run "abc" is a chain: `a`'s origin is the cursor's element,
`b`'s origin is `a`, `c`'s is `b`. Two concurrent runs are two chains under the same origin, and a preorder walk
visits each chain whole. What does interleave is typing backwards (Home before every key), because then every
character has the same origin; Fugue fixes that with a right-hand origin. Documented, not fixed.

**Why are elements code points, not UTF-16 units or graphemes?** With UTF-16 units, a concurrent insert could land
between the two halves of an emoji and leave lone surrogates in everyone's document. Code points can't be split.
Graphemes (emoji with modifiers, accents) still can, but the result is still valid text and the same everywhere;
grapheme segmentation is locale- and version-dependent, which is the last thing a CRDT wants.

**Why not require causal delivery?** Because it's a property of the whole network that's easy to lose (reconnects,
resends). The CRDT holds an operation whose origin or delete target it hasn't seen yet and applies it when that
arrives, so delivery only needs to be eventual. Duplicates are no-ops by id. (DESIGN.md "Order of delivery".)

## The wire format (day 1)

**Why write your own JSON reader?** Because `JSON.parse` lets one message mean different things to different
readers, and in a CRDT that is divergence. It keeps the last of duplicate keys (another implementation may keep the
first), it returns lone surrogates from `"\ud800"`, it silently rounds `9007199254740993` to `...992` and `1e400` to
Infinity, and it reads `-0` as negative zero, which equals 0 but isn't the same value. `packages/crdt/src/json.ts` refuses all of those, plus fractions and exponents (nothing in the
protocol is fractional) and nesting past 32 (so a deeply nested message can't overflow the stack). Where it accepts,
it agrees with `JSON.parse`: a property test checks both random JSON values and 20,000 random texts over JSON's
alphabet.

**What does the decoder check beyond JSON?** Every field, exactly: no unknown or missing keys, names matching
`[A-Za-z0-9_-]`, integers in range, text 1 to 10,000 code points with no lone surrogates, a run's last counter inside
the safe-integer range, the insert/origin counter rule. Errors name the field (`ops[2].origin.counter`). The encoder
runs the same checks before writing, so a replica can't send what others would refuse, and it writes one canonical
text per message.

**Tell me about a bug the tests caught.** The check that a run of ids stays in the safe range was
`first + count - 1 > MAX_SAFE_INTEGER`. For `first = MAX`, `count = 2`, `MAX + 2` isn't representable and rounds to
`MAX + 1`, minus 1 is `MAX`: the check passed a run whose last id doesn't exist. The boundary tests (counters drawn
near both ends of the range) failed on it; the fix compares `count - 1 > MAX - first`, where nothing overflows.

**How fast is the strict decoder?** A keystroke's message decodes in about 1.7 µs, 3x `JSON.parse`; a 1.1 MB paste in
about 4.7 ms, 6x. A profile showed a third of the paste's time in the reader's character loop and a quarter counting
code points (twice per insert), so long strings are now scanned with a native regex after the first 16 characters and
the second count is skipped when it can't matter: the paste went from 6.6 to 4.7 ms. README "Results" has the
numbers and the command.

## Testing convergence (day 1)

**How do you test that replicas converge?** A deterministic network simulator
(`packages/crdt/test/harness/network.ts`): fast-check generates schedules of local edits at random replicas,
deliveries of random in-flight messages, and redeliveries; every message also goes back to its sender, as the server's
echo will. At the end everything left is delivered in a random order and all replicas must show the same text. A
failing schedule shrinks to a few steps and prints them.

**How do you know the simulator can catch anything?** It's tested in both directions
(`packages/crdt/test/harness.test.ts`): a correct toy CRDT must pass, and three broken toys must fail, each only when
the network freedom that exposes its flaw is switched on: edits by index fail only with concurrent edits, a
non-idempotent text only with redelivery or echo, one that drops a delete arriving before its insert only with
reordering, and one that removes a deleted character outright only with the state check. With every freedom on, each
is caught within a median of 1 or 2 schedules, at most 11 (`npm run harness-stats -w @coedit/crdt`).

**Why compare the replicas' state, not just their text?** Two RGA replicas can show the same text while a tombstone
sits in a different place in each; the next insert next to it then lands differently and they diverge for good. So a
replica can write out its whole state canonically (`state()`), and the simulator compares that too. The toy that drops
a tombstone shows both sides: without redelivery its texts always agree and only the state check fails it; with
redelivery even the texts diverge, because a duplicate insert brings the deleted character back, which is exactly what
tombstones are for.

**What was wrong with the first version of the simulator?** Its schedules were too tame. fast-check keeps arrays near
10 items by default, whatever `maxLength` says, and edits were one of three equally likely steps, so a schedule had 1.3
edits on average and only a quarter had any concurrent edit. Weighting edits and using `size: 'medium'` gave 4.9 edits
and 68% (5.3 and 71% after the review widened it), and the early-delete flaw went from a median of 13 schedules to
catch to 2. I found it by measuring what the schedules contain, not by a failing test: a weak generator fails
silently. The same trap was still in the final flush (its picks stopped at 10), which the review found.

## The client and server (day 1)

**How does a textarea edit become a CRDT operation?** The browser gives the text before and after an input and the
caret; `diffText` (`packages/client/src/edit.ts`) finds the one changed span. Plain diffing is ambiguous in a run of
equal characters ("aa" to "aaa"), and the choice decides whose text a concurrent edit lands next to. After typing,
pasting or deleting the caret sits right after the inserted text, so the common suffix may not extend left of the
caret: suffix first, then prefix. A property checks that a random edit with the caret where the browser leaves it comes
back exactly; checked by hand in Chrome too.

**What does the server do so far?** Only `/healthz` (status and protocol version), strict `COEDIT_PORT` parsing (no
`08110`), a close that doesn't wait on keep-alive clients, and a second Ctrl-C that exits at once. The sync protocol is
day 3.

**Why does the server echo a client's own operations back?** It's the acknowledgement: an operation leaves the outbox
when it comes back with a sequence number. Every client then sees the same numbered log, so "I have up to 1,234"
means the same thing for everyone on reconnect. The cost is the sender's own edits coming back once.

**Why Node's test runner and type stripping, not Vitest or tsx?** Node runs the `.ts` files directly (types are
erased), so the server and tests need no build step and `tsc` only checks types. Also, on this machine's Node 23,
Vitest 5's and ESLint 10's engine ranges exclude it; Node's own runner needs nothing.

## The reviews (day 1)

**What did the review find, and what was the worst of it?** Eight defects, each as a failing test. The worst: the
simulator gave every replica the same operation object, so state could travel through it. A toy that never applied a
remote delete, but flagged the element object it kept (the received operation itself), passed 2,000 schedules,
because the flag showed up on every replica at once. A real network gives each replica its own decoded copy; the
simulator now copies at send and at each delivery, and a test pins each copy. Others: the flush's order was random
only for its first 10 deliveries, a flaky test, an encoder that an Array subclass could trick, docs that were wrong
about `diffText`, and an empty host binding every interface. README "Review of day 1" lists them with their commits.

**What did you learn about testing the tester?** The self-test (broken toys must fail) can't see a weak generator: the
toys fail under weak schedules too. The review weakened the generator six ways with every test passing. What pins it
is measuring the schedules directly (`harness-coverage.test.ts`) and testing each delivery mechanism on hand-written
schedules (`harness-mechanics.test.ts`); every survivor was then re-run as a mutant and fails.

**Did your fixes break anything?** One, found before the second review: the copies made `harness-stats` count
operations by identity on objects that were now fresh copies, so it reported 0.0 redeliveries. The numbers in the
README were re-measured after fixing it.
