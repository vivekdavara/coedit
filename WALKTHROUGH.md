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

**Did your fixes break anything?** Yes, twice, and the second review found it. My copy of a caller's array read its
length live, so an array that grows while it's read got past the 1,000-item limit; and my fix for shared op objects
closed only that one channel: replicas sharing a cache of elements still passed, until the simulator started
checking that each step changes only the replica it's meant to. I found a third myself: the copies made
`harness-stats` count operations by identity on fresh copies (0.0 redeliveries). The README's numbers were
re-measured after each.

**What does the isolation check cost?** It snapshots every replica's text and state after every step, which made the
self-test 13 times slower at first (5.4 s against 0.4 s). Reusing each step's snapshot as the next one's "before"
halved it; the whole suite is under 4 s.

## The CRDT (day 2)

**Walk me through `apply` for an insert.** `packages/crdt/src/rga.ts`, `#insert`. The operation is first checked and
copied by `validateOp` (so nothing outside holds what the replica stores). Then: is its first id known? If it is the
same run (first id, origin, text) it's a duplicate and returns no changes; anything else touching a known id throws
`ConflictError`. Otherwise the clock moves up to the run's last counter, one element per code point is created and
indexed, and any of them deleted ahead of time are marked. If the origin isn't placed yet the run waits under its
origin's id. If it is, `#place` scans from the origin past every larger id, splices the run in, and returns the
visible change; then every run waiting on one of its elements is placed the same way, and so on (a queue, not
recursion).

**And for a delete?** `#delete`: each id in each span is looked up. A placed, visible element becomes a target; one
still waiting for its origin is just marked deleted (it will be placed as a tombstone); an unknown id is remembered as
deleted ahead. Then one pass over the sequence turns the targets into changes: their visible indices, grouped into
stretches of consecutive ones, each shifted left by the stretches before it so the changes apply one after another.

**How do you tell a duplicate from a conflict?** A run is made whole by one replica, which never reuses a counter, so
an honest resend is exactly the same run. So the check is on runs: same first id, origin and text is a duplicate;
anything else that touches a known id (another character, another origin, a longer or shorter run, a run starting
inside a known one) is a conflict. Checking element by element would be order-dependent: a run consisting of the tail
of a known run would pass as a duplicate if it came second and conflict if it came first. `rga-conflicts.test.ts` has
a property applying two overlapping inserts in both orders.

**What does `pending` count, and why did you change it?** Operations still waiting: runs whose origin isn't placed,
and distinct deletes that name an id no insert here has carried. In the first version only the first delete naming a
missing id waited for it, so two deletes naming the same missing id counted as one or two depending on arrival order.
Now each delete waits for all of its own missing ids, so `pending`, like `state()`, depends only on which operations
arrived. `rga-pending.test.ts` checks `pending` (and the visible length) against a model, and both `pending` and
`state()` for order independence; the model's first counterexample was a flaw in my model, not the code: two
replicas deleting the same text at once make byte-identical deletes, which a replica can't tell apart.

**Why is the Lamport clock bumped by waiting inserts and some deletes too?** So a replica's next id is never one it
already knows of. If a buggy peer used my replica id at counter 50 in an insert still waiting, or deleted `50@me` ahead
of time, and my clock were 10, my next edits would make `11@me`... and eventually `50@me`, which would conflict or
arrive pre-deleted. So waiting inserts move the clock, and so do delete spans under my own id. At first every delete
span moved it; review 1 pointed out that one delete naming `9007199254740991@anyone` then stopped my inserts for
good, while other replicas' ids can never collide with mine. Now only my own do.

**Why one array and linear scans?** It's the simplest structure whose correctness is easy to see, and the tests are
about correctness. Every operation is O(n): finding the origin, counting visible elements, splicing. Day 4 measures
it; if it's too slow at realistic sizes, an order-statistics tree replaces the array behind the same interface.

**What are `idBefore` and `indexAfter` for?** Presence. A cursor is sent as "just after element X" (an id), not an
index, because an index goes stale as soon as someone types before it. `indexAfter(X)` counts visible elements up to
and including X; if X has been deleted, that's where it was. It returns `undefined` for an element not placed here
rather than guess.

**What happens near 2^53?** Counters are safe integers; comparisons, never subtraction, decide the order. A replica
whose clock reaches 2^53 - 1 refuses edits that need ids (a replace too, whole), while deletes still work.
`rga-limits.test.ts` starts clocks at 2^53 - 4; the convergence properties also run with clocks near 2^31 (where
32-bit storage would wrap) and near 2^53 - 1 - 10,000.

## Testing the CRDT (day 2)

**How is the CRDT tested?** Through yesterday's simulator (`packages/crdt/test/harness/rga-subject.ts` adapts it):
every operation goes through the real codec, the state check is compulsory, local edits must land exactly where they
were made, every delivery's changes must replay on the text, and nothing may still wait at the end. Plus targeted
properties: concurrent typists at one spot keep their runs whole (`rga-intention.test.ts`), state is a function of the
set of operations received (`rga-pending.test.ts`), a cursor follows its text (`rga-presence.test.ts`), and whether
two inserts conflict doesn't depend on their order (`rga-conflicts.test.ts`).

**Converging isn't the same as being right. How do you know the order is RGA's?** `rga-order.test.ts` builds the
order DESIGN.md describes independently: every element a child of its origin, children sorted largest id first (with
a comparator written in the test, not imported), the tree read in preorder. Over 1,000 editing sessions delivered in
random orders, the replica's sequence of ids, tombstones included, is exactly that preorder. So the scan-and-skip code
in `#place` computes the tree the proof is about.

**How do you know those tests can fail?** Every mechanism was removed in turn and the tests run against the mutant:
removing or reversing the skip rule, dropping the cascade of waiting runs, either pre-delete path, the clock update,
the change index shift, the run-level duplicate check's four conditions, the limits' splits. Each fails at least one
test. Two guards failed none, and that taught me something: a doubled wait record is matched by a doubled release, so
they only kept memory from growing; one is gone and the other is documented as exactly that. A coverage test also
pins what the schedules exercise (an operation waited in 61% of seeded schedules), so a weakened generator fails.

**Why compute the expected order in the intention test by code units?** Because then the test also pins the id
order: with `localeCompare` the typists' runs come out in another order and the test fails, which the convergence
tests alone can't see (every replica in one process shares a locale).

## The reviews (day 2)

**What did the review find, and what was the worst of it?** Three defects and a rule that was too broad. The worst:
an element releasing the runs waiting on it spread the whole list into `push()`, which overflows the stack at about
110,000 arguments, and by then the releasing insert was placed and the runs were out of the waiting map, so they were
lost for good. Unrealistic in an editor, but it broke the one property a CRDT can't break: an operation either applies
or changes nothing. Also: `edit()` returned an internal id object as the insert's origin (a caller changing it renamed
an element), `pending` depended on arrival order (fixed already), and a delete naming 2^53 - 1 of anyone used up the
clock.

**How do you test a stack overflow at 110,000 runs without a slow test?** Run the same scenario in a child process
with a smaller stack (`--stack-size=100`), where the old code overflowed at 20,000 runs and not at 5,000; 20,000 runs
place in about 30 ms. And make the mistake hard to repeat: an ESLint rule forbids spreading into any call, and `apply`
and `Reflect` (it started as `push` and `unshift` only; rounds 2 and 3 found the ways round that)
in the CRDT's sources. The one spread left, into `splice`, is bounded by a run's 10,000 elements.

**What did the second review find?** That round 1's fixes held, and something older: a V8 `Map` holds at most 2^24
entries, so two maximal deletes of ids not yet present overflowed the deleted-ahead map partway through the second,
which then threw with half its ids recorded. JavaScript gives no way to make `Map.set` infallible, so the replica checks
first: it has a capacity (2^24 - 1 of each kind of entry, then 2^23 - 1 after round 3) and refuses, before changing
anything, an operation that would pass it. Refusal by capacity is the one way two replicas can disagree about accepting a valid operation, like any
resource limit; the day-3 server refuses such operations before any client sees them.

**What did you learn from the reviews about your measurement scripts?** That a smoke test checking a script's output
format proves little if the script prints what it was asked to do instead of what it did. Both day-2 scripts passed
with a mutant that measured nothing. Now they print fast-check's own run count and the replica's own count of what it
holds, so a script that stops measuring prints a number the smoke test refuses.

**And the third?** That my capacity was still too high. A V8 Map's table holds 2^24 entries, but deleted entries stay in
it as holes until it rehashes, and a full table can only compact (instead of growing past the limit) if at least half
of it is holes. The deleted-ahead map loses an entry whenever an id arrives, so it could fail with about 2^23 live
entries. I checked it with a plain Map before changing anything (holding 2^23 + 2 entries while deleting one and adding
one throws; 2^23 holds through 20 million turns), then lowered the capacity to 2^23 - 1 and churned 8.4 million ids
through a full deleted-ahead map as a check. The pattern of the day: each round found a bug in the previous round's
fix, and each time the fix's own claim ("the most a Map holds") was what was wrong.
