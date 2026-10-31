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
place in about 30 ms. And make the mistake hard to repeat: an ESLint rule forbids spreading into any call, and any use
of `apply` or `Reflect` it can see (it started as `push` and `unshift` only; rounds 2 to 4 found the ways round each
version, and `test/lint-rule.test.ts` now runs it on all of them). It can't see a key held in a variable (`fp[k]`): a
lint rule guards against the ordinary mistake, not against code written to get past it.
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

## Sync (day 3)

**Walk me through one keystroke, from one tab to another.** The textarea's input event: `App.tsx` compares the text
with `shown` (what the replica held when they last agreed) using `diffText` and the caret, and calls
`SyncClient.edit(index, deleteCount, text)` in code points. `edit` applies it to the tab's own replica at once (that
returns the operations), puts them in the outbox and, if online, sends an `ops` message. The server's session decodes
it strictly and hands it to the document's hub (`packages/server/src/hub.ts`, `submit`), which checks each operation
(`#check`), applies it to the server's replica, appends its canonical text to the log, and sends one `ops` message
numbered from the first new entry to every member, the sender included. The other tab's sync client checks the number
follows the last one it applied, applies the operation to its replica, and reports the visible changes; `App.tsx`
patches them into the textarea with `applyChanges`, which moves the caret too. The sender's copy is its echo: it
matches the outbox's first operation, which leaves the outbox.

**Why does the server echo the sender's own operations back?** It's the acknowledgement, and it costs nothing extra:
the server sends the same numbered message to everyone. In exchange every client sees one log with one numbering, so
"I have applied up to 41" means the same for all, and a reconnecting client can ask for exactly what it missed.

**How does the client know which echo is which?** The server relays a client's operations in the order it sent them,
so echoes come back in outbox order and only the outbox's first operation can match the next one. They're compared by
canonical text (`encodeOp`). Someone else's byte-identical delete (both deleted the same text at once) matches too,
which is right: its effect is the same, and the client's own copy, logged again, then changes nothing.

**What happens on reconnect?** `hello` with the last sequence number applied; the server sends `welcome` with where
its log ends, then everything after `have`. Only when the client has applied up to that point does it resend its
outbox (in batches of 1,000 operations and 1 MiB), then its cursor. Anything echoed meanwhile has left the outbox, so
the resend is what the server didn't have when the client joined. An insert the server does have (it arrived just
before the connection dropped and was logged after the new `welcome`) is recognized by the server's replica and not
logged twice; its first copy's echo reaches the client while it's still in the outbox.

**Why is a delete logged every time, even a repeat?** The sender waits for an echo of each operation. Two clients can
make byte-identical deletes, and each needs its echo; the server can't tell that from a resend. A repeated delete
changes nothing anywhere, so logging it costs a log entry, not correctness.

**Why does the server refuse operations whose dependencies it lacks, when the CRDT can hold them?** In this topology an
honest client only names elements it got from the server or made itself, and sends in order on one socket, so the
server always has an operation's dependencies. One it lacks means a bug, and holding it would let a waiting operation
sit in the log forever and every client hold it too. Refusing keeps the server's replica free of waiting operations
and its log in causal order. The check (`Rga.ready`) walks delete spans run by run: the largest delete the wire format
allows is 1,000 spans of 10,000 ids, which id by id is 10 million lookups (about 110 ms) and run by run 1,000.

**What's the counter rule, and why can't the clocks run out?** Every replica's clock takes the largest counter it
receives, so a single insert numbered near 2^53 - 1 would use up everyone's clock. An honest client's counters are at
most the server's clock (it has seen nothing the server hasn't) plus the elements it has made since, and its capacity
bounds those. So the server refuses an insert ending more than its capacity past its clock. Each accepted insert then
moves the clock at most a capacity, makes at least one element, and the server holds at most a capacity of elements:
the clock stays under capacity squared, about 2^46. `hub.test.ts` runs that with a capacity of 1,000: the largest
jumps fill the document at clock 10^6, and the next insert is refused because the document is full.

**What happens to the caret when someone else types?** `textarea.ts`: an insert strictly before it shifts it; one
exactly at it leaves it before the new text. The caret means "after the element before me", and the new text went
after that element too, so that's where the caret is; and the next character typed there gets a larger id than the
new text's, so RGA places it first, right at the caret. A delete around the caret pulls it to where the text began.
The CRDT counts code points and the textarea UTF-16 units, so each change is converted against the text just before
it. The property test runs remote edits on a real replica and checks the caret ends next to the element it was after.

**Why hold remote changes during an IME composition?** While a composition is open, the browser owns the textarea's
text and selection; changing them under it breaks the composition in some browsers. So the client holds incoming
operations (received, not applied), the composition becomes one edit when it ends (found against the text from before
it, which the replica must still hold), and then the held operations apply.

**How do you draw other people's cursors in a textarea?** A textarea can't. Behind it sits a copy of the text in a div
laid out the same way (font, padding, wrapping, scrollbar gutter), with the text transparent; the copy is cut at each
remote caret and selection end, selections are shaded and carets are coloured bars with a label. The textarea's
background is transparent, so they show through. It scrolls with the textarea. It's an approximation: a browser that
wraps a div differently from a textarea would draw a caret on the wrong line.

**What stops a random website from reading my documents?** A browser lets any page open a WebSocket to 127.0.0.1, and
WebSockets aren't covered by CORS. But the browser sends the page's origin with the handshake, so the server refuses
(HTTP 403) any origin not on its list: by default the client's dev server. A client that isn't a browser sends no
origin and is let through; it could send any origin it likes anyway, so this protects browser users, not the server.

**What if a client vanishes without closing?** A laptop whose lid closes sends nothing; TCP can take hours to notice.
The server pings every connection every 30 seconds and drops one that hasn't answered the previous ping, so its
cursor goes from everyone's screen within a minute. A client that's connected but not reading is dropped once 16 MiB
is queued for it; it reconnects and catches up from the log, which is what makes dropping it safe.

**What does the client do when the server refuses something?** It depends on the code. `server-error` means the
server failed, so the client reconnects with backoff (250 ms doubling to 10 s, with jitter, reset at each
`welcome`). Anything else would be refused again on retry (a malformed message, an operation the server's replica
refuses, `ahead-of-server`), so the client stops, says why, and keeps the text on screen.

## The review (day 3)

**What did the review find?** Three server defects, each written as a failing test first. The worst: a document with
a long log couldn't be opened by a new tab. The server wrote the whole catch-up at once, and the rule that drops a
client with more than 16 MiB queued counted all of it, so a client reading as fast as it could was dropped part way
through, then again on every reconnect. Now the catch-up goes one batch at a time, each after the socket has taken
the one before (ws's send callback), with live relays held back until the member reaches the end of the log, which
it reads from directly, so nothing is skipped or reordered. Second: one message of deletes whose spans all named the
same ids cost 20 million lookups, about 5 seconds of a blocked event loop; the server now refuses overlapping spans,
which no replica writes. Third: a refused handshake (404 or 403) reset by the client at once crashed the process,
because Node takes its socket error listener off before emitting `'upgrade'`.

**And the second round?** It reviewed only the fixes, and found five things they broke or missed. The overlap rule
bounded one delete, but a message can carry a thousand, so the server now also refuses a message whose deletes name
more ids than the document holds. The paced catch-up still sent presence relays to a member mid-catch-up, which
counted the batch in flight against the slow-reader limit; and it measured 1,000 log entries for each batch of 25.
A refused handshake's socket was never destroyed, so `close()` could hang. And the origin setting accepted spellings
no browser sends; now an origin must be what `new URL(origin).origin` returns. The lesson I take: a fix for a cost
problem needs its bound stated for the whole unit of work (a message, not an operation), and a fix that adds a new
mode (catching up) needs every other path checked against it.

**Why weren't those caught by your tests?** They're about scale and hostile timing, and the tests were about
correctness of ordinary use: no test made a log bigger than the slow-reader limit, sent overlapping spans, or reset a
connection mid-answer. The review also ran 44 mutants of the day's code; ten survived, and six of those now have tests
(the batch arithmetic to the byte, the hello timer, the readyState guard, two client checks), one led to a parser
fix, and three were equivalent, two of them because a field was dead and is now gone.

## Testing sync (day 3)

**How do you test sync end to end?** `sync-convergence.test.ts`: fast-check generates schedules for 2 to 4 sync
clients on the real server: edits at random positions, dropped connections, offline spells and pauses that let
messages through. After each, everyone comes back online, and once every outbox is empty and every client has the
whole log, each client's replica state (`Rga.state()`: ids, tombstones, order) must equal the server's, and the text
that client patched only from the reported changes (what the editor shows) must equal the server's text. It counts
what the schedules did and fails if they did too little; the first version asked for "up to 40 steps" and made 160
edits in 60 schedules, since fast-check's size, not the maximum, decides the length.

**And below that?** The hub has its own tests without sockets (`hub.test.ts`); the endpoint is tested over real
sockets with a small test client (`packages/server/test/client.ts`); the sync client against a scripted socket
(`sync-unit.test.ts`), where each message can be delivered, held or dropped exactly; and against the real server over
Node's own WebSocket (`sync.test.ts`).

**What broke while building it?** Three things the tests found. Node's WebSocket (23.11) fires `error` after a refused
connection and then nothing, staying CONNECTING for good, where browsers also fire `close`; the client only retried on
close, so a client started before the server waited forever. The server's command line printed "listening" before it
installed its signal handlers, and under the suite's new load the SIGTERM test hit that window once (the default
action killed the process); `signal-order.test.ts` checks the order from inside the child, without timing. And the
editor kept showing "1 edit not yet acknowledged" because an echo changes no text, so nothing re-rendered.

## Persistence (day 4)

**What's on disk, and when is it written?** One directory per document (`packages/server/src/store.ts`): the log in
segments, one JSON line per entry (`{"seq":n,"op":...}`), and the newest snapshot. `submit` applies a message's
operations to the server's replica, appends the new entries in one write, fsyncs, and only then relays them. So
anything a client has seen, the disk has: a restart can't leave a client ahead of the server, which before day 4 was
exactly what a restart did. `persistence.test.ts` checks the order directly: the relay's fake member reads the log
file while it's being sent the message, and the entry is already there.

**What if the process dies in the middle of a write?** The last line of the last segment may be cut off. Opening
drops a final piece with no newline and truncates the file there; that piece was never relayed (the relay comes after
the write) and its sender still has it in its outbox, so it comes again on reconnect. Anything else that doesn't read
back exactly (a bad line in the middle, a gap in the numbers, a snapshot short of its count) refuses the document
with `server-error` rather than serve it with something missing. `crash.test.ts` kills the server with SIGKILL while
a client types, three rounds, and checks the restarted log holds every entry the client saw echoed.

**What is a snapshot?** A list of ordinary operations that rebuilds the document: every run's original insert, in id
order, then deletes of the tombstones (`Rga.snapshot`). An insert's counter is always larger than its origin's, so
each origin is placed first, and any order with origins first builds the same sequence. Id order is also the fast
one: nothing larger is placed yet, so each insert stops right after its origin. My first version used sequence order
and was five times slower to load than the log, because an early tombstone sits after everything typed later at its
spot and placing it scanned past all of it. Because they're just operations, a client that already has part of the document applies a
snapshot like anything else: what it has is a duplicate, the rest merges. Runs go whole, not as the stretches the
sequence shows now, because a run's middle sent as a run of its own would conflict with a replica holding the run.

**Who gets one?** A client whose `have` is older than the oldest entry the server keeps. The server keeps the newest
snapshot and the entries since the one before it, so a client that missed less than one interval (10,000 entries)
catches up from the log as before. The snapshot comes in parts (1,000 operations, 1 MiB each), and the client moves
its sequence number only at the last, so a drop part way just asks again.

**What happens to the client's outbox when it gets a snapshot?** That's the subtle part. Operations of its own that
the server logged before the snapshot will never be echoed to it (their echoes were in the entries the snapshot
replaces), so the client would wait for them forever. The snapshot holds exactly what the server had logged by then,
so the client drops every insert whose run is in it and every delete all of whose ids are tombstones in it, and sends
the rest. A delete whose effect is there may not have been logged (someone else deleted the same text), but it needs
no echo: it changes nothing anywhere. `sync-unit.test.ts` has the cases, including a delete only partly covered,
which stays.

**What does a full disk do?** The append throws. The replica already has the message's operations and the disk may
not, so the hub can't go on: it sends `server-error` to every member (clients retry that), refuses everything, and the
server drops it. The next join loads the document from what reached the disk; the sender resends from its outbox.
Tested with `fs.writeSync` mocked to throw, all at once and after writing half.

**Why fsync every message, when it caps the server at about 340 messages a second?** Because an echo is a promise:
the client drops the operation from its outbox. Without fsync, a power loss after the echo loses an operation nobody
has any more. With it, on this Mac each fsync is `F_FULLFSYNC`, about 3 ms. Group commit (one fsync for every message
that arrived during the previous one) would keep the promise at a much higher rate; it isn't built, and the number is
in the README.

**Why escape capital letters in directory names?** Document names are case-sensitive (`Notes` and `notes` are two
documents) and macOS's file systems by default aren't, so both would share one directory. A capital is written as `^`
and the lower-case letter, which no document name contains.

## Measurements (day 4)

**How fast is the CRDT?** `npm run editing -w @coedit/crdt` runs a seeded synthetic session of 100,000 edits (typing,
backspaces, jumps, selections, pastes). With the elements in one array, local edits ran at about 21,000 a second in
the first tenth and fell to about 1,460 by 369,000 elements, because every operation scanned the array from the start
(O(n)), and a second replica applying all 95,043 operations managed about 3,300 a second, the same from JSON through
the strict decoder: placement was the cost, not decoding. With blocks (next answer) it's about 257,000 local edits a
second at the end and 375,000 operations a second remotely, and then the decoder is about half the cost.

**Was that a problem, and what did you do?** Not for typing: a person makes a few edits a second. It was for big
documents: loading a document of 100,000 one-character entries took 6 to 7 s, with the server's event loop blocked.
So the elements went into blocks of 512, each counting its visible elements, each element pointing at its block:
finding a visible index skips whole blocks, finding an element's position is its block's index plus an `indexOf`.
The same session then ran at about 257,000 local edits a second at 369,000 elements (from 1,462), and the document
loads in under half a second. The interface didn't change, and `rga-blocks.test.ts` checks the new structure against
the old one: the same random sessions with blocks of 1 to 3 elements (splitting all the time) and with one block that
never splits must give exactly the same operations, changes, positions, text and state. Six one-line mutants of the
block code each fail it.

**How big do documents get?** In that session 45% of the elements are tombstones at the end; each element is about
186 bytes of heap; a snapshot is about 40 bytes per visible character and the log about 50 (JSON around a few
characters per run).

## Tombstones (day 4)

**Why aren't tombstones collected?** Because knowing when one is safe to remove is the hard part, and day 4 built
persistence instead. Removing a tombstone changes nothing if no element has it as its origin and no operation still
to arrive names it: RGA places an insert just after its origin, past every larger id, so where a childless tombstone
was the first smaller id, the element after it is smaller still, and the insert stops at the same place. But only the
server's view of every client that may still send can say "nothing will name it", and an offline client can return
any time with operations made before it saw the delete. That needs a client message ("I have applied up to n", after
its outbox), a retention window, and a resync for a client returning past it that re-anchors its offline inserts.
DESIGN.md "Tombstones" has it; it's the main thing left in the CRDT.

## Testing end to end (day 4)

**How do you test two people at once?** Playwright (`packages/client/e2e/two-browsers.spec.ts`), two browser contexts
on the real dev server and sync server: typing seen both ways with the other's caret, both typing at one spot at once
(the result is one run then the other, as RGA promises), one offline while both edit and then back (both end with
everything, nothing unacknowledged), and a document opened after everyone left. It uses the installed Chrome, so CI
runs it too without downloading a browser.
