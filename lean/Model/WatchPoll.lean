/-!
This model checks the sequential arithmetic of the watch-pr polling loop.

Sources, in `plugins/pstack/skills/poteto-mode/scripts/watch-pr/`:

* `policy.ts:399-402`  `queryBackoffSeconds`
* `policy.ts:509-562`  `pollUntilTerminal`
* `policy.ts:63-85`    `NO_CHECKS_CONFIRM_SECONDS`, `noChecksConfirmer`
* `deadline.ts:9-20`   `WatchDeadline`, `WatchDeadline.remaining`
* `cli.ts:37-63,122-145,181-192`  the option ranges and the real clock

Assumptions the model makes. The code does not guarantee the ones marked (!).

1. (!) Every JavaScript number is a whole, non-negative count of seconds, so it
   is a `Nat`. The CLI accepts `0 < --interval <= 2147483.647` and any finite
   `--timeout >= 0`, fractions included (`cli.ts:37-57`), and the real clock is
   `performance.now() / 1_000` (`cli.ts:182,187`), which is fractional.
2. `2 ** (failures - 1)` is an exact natural power here. JavaScript overflows it
   to `Infinity` near `failures = 1025`. `Math.max(interval, 60)` is at least 60,
   so the product is `Infinity`, never `0 * Infinity = NaN`, and
   `Math.min(Infinity, 300)` is 300. The model returns 300 there too.
3. `failures - 1` is truncated in `Nat`, so `queryBackoffSeconds` is a faithful
   transcription only for `failures >= 1`. JavaScript computes `2 ** -1 = 0.5` at
   `failures = 0`; `queryBackoffHalfSeconds` carries that case in half-seconds.
4. `Infinity` (the deadline of `--timeout 0`, `deadline.ts:15`) is
   `Seconds.infinity`.
5. (!) One clock that never runs backwards serves `WatchDeadline.remaining` and
   `clock.sleep`. `RunDependencies` takes them as two separate objects.
6. (!) `deadline.remaining()` and the `clock.sleep` call that uses it happen at
   one instant. `policy.ts:541-549` emits a verdict between them.
7. The step result is the environment's choice: any outcome, taking any time,
   zero included. `StepOutcome` lists the six ways `await args.step()` can end.
8. A clock that advances by at least the slept amount is the theorem hypothesis
   `HonestClock`/`HonestRun`; the model itself lets the clock stand still. The
   real `clock.sleep` (`cli.ts:189-191`) meets it only for a delay a timer can
   hold, at most 2^31 - 1 ms. Every sleep is at most `--interval` or the 300
   second backoff cap, and `sleepSeconds` (`cli.ts:43-51`) rejects a longer
   `--interval`.
9. A head SHA is a `Nat`; the code only compares SHAs with `===`. The `Map`
   keyed by PR number is a total function to `Option`.
10. `State.retries` and `State.slept` are ghost counters. The code has neither.

`WatchPoll.mutations` lists the bugs this model must detect.
-/

namespace WatchPoll

/-! ## 1. `queryBackoffSeconds`, policy.ts:399-402 -/

/-- policy.ts:402 `Math.min(Math.max(interval, 60) * 2 ** (failures - 1), 300)`.
Faithful for `failures ≥ 1` (assumption 3). -/
def queryBackoffSeconds (interval failures : Nat) : Nat :=
  min (max interval 60 * 2 ^ (failures - 1)) 300

/-- Twice the JavaScript result of policy.ts:402, for every `failures ≥ 0`:
`2 * min (m * 2 ^ (f - 1)) 300 = min (m * 2 ^ f) 600` over the reals. Half-seconds
keep `failures = 0`, where JavaScript multiplies by `0.5`, inside `Nat`. -/
def queryBackoffHalfSeconds (interval failures : Nat) : Nat :=
  min (max interval 60 * 2 ^ failures) 600

/-- What `queryBackoffSeconds` guarantees at one input with `failures ≥ 1`: a
floor of 60, a cap of 300, no decrease at the next failure, the cap from the
fourth failure on, the first wait, doubling, and agreement with the half-second
form. -/
def BackoffSpec (interval failures : Nat) : Prop :=
  60 ≤ queryBackoffSeconds interval failures ∧
  queryBackoffSeconds interval failures ≤ 300 ∧
  queryBackoffSeconds interval failures ≤ queryBackoffSeconds interval (failures + 1) ∧
  (4 ≤ failures → queryBackoffSeconds interval failures = 300) ∧
  (failures = 1 → queryBackoffSeconds interval failures = min (max interval 60) 300) ∧
  queryBackoffSeconds interval (failures + 1) = min (2 * queryBackoffSeconds interval failures) 300 ∧
  queryBackoffHalfSeconds interval failures = 2 * queryBackoffSeconds interval failures

instance (interval failures : Nat) : Decidable (BackoffSpec interval failures) := by
  unfold BackoffSpec; infer_instance

/-- Intervals around every threshold of the function: the floor 60, the values
75, 150 and 300 that reach the cap one failure sooner, 120 and 600 for the
`failures = 0` case, and the largest whole number a double holds exactly. -/
def backoffIntervals : List Nat :=
  [0, 1, 30, 59, 60, 61, 74, 75, 76, 119, 120, 121, 149, 150, 151, 299, 300, 301, 599, 600, 601,
   3600, 9007199254740991]

/-- Failure counts from 1 past the cap, and around JavaScript's overflow of
`2 ** (failures - 1)` at 1024. -/
def backoffFailures : List Nat := [1, 2, 3, 4, 5, 6, 7, 8, 16, 53, 64, 1023, 1024, 1025, 1100]

/-- Inputs in the bound where `BackoffSpec` fails. -/
def badBackoff : List (Nat × Nat) :=
  (backoffIntervals.flatMap fun interval => backoffFailures.map fun failures => (interval, failures)).filter
    fun (interval, failures) => ¬ BackoffSpec interval failures

#eval badBackoff   -- []
#guard badBackoff.isEmpty

-- Reach: the bound holds values under the cap and at it, and 4 is the first
-- failure count that gives 300 for every interval.
#guard queryBackoffSeconds 60 1 == 60 && queryBackoffSeconds 60 3 == 240 && queryBackoffSeconds 60 4 == 300
#guard (backoffIntervals.filter fun interval => queryBackoffSeconds interval 3 < 300) == [0, 1, 30, 59, 60, 61, 74]

-- `failures = 0`: (interval, twice the JavaScript result). The floor of 60 seconds
-- (120 half-seconds) fails for every interval under 120.
#eval backoffIntervals.map fun interval => (interval, queryBackoffHalfSeconds interval 0)
#guard (backoffIntervals.filter fun interval => queryBackoffHalfSeconds interval 0 < 2 * 60)
  == [0, 1, 30, 59, 60, 61, 74, 75, 76, 119]

/-! ## 2. `WatchDeadline`, deadline.ts:9-20, and `pollUntilTerminal`, policy.ts:509-562 -/

/-- A JavaScript number of seconds that may be `Infinity`. -/
inductive Seconds
  | finite (seconds : Nat)
  | infinity
deriving Repr, DecidableEq

/-- deadline.ts:9-16. -/
structure WatchDeadline where
  expiresAt : Seconds
deriving Repr, DecidableEq

/-- deadline.ts:15 `timeout > 0 ? now() + timeout : Infinity`. -/
def WatchDeadline.create (timeout now : Nat) : WatchDeadline :=
  ⟨if timeout > 0 then .finite (now + timeout) else .infinity⟩

/-- deadline.ts:17-19 `Math.max(0, this.expiresAt - this.now())`. Truncated `Nat`
subtraction is the `Math.max(0, ·)`. -/
def WatchDeadline.remaining (d : WatchDeadline) (now : Nat) : Seconds :=
  match d.expiresAt with
  | .finite expiresAt => .finite (expiresAt - now)
  | .infinity => .infinity

/-- policy.ts:519 `deadline.remaining() > 0`. -/
def Seconds.positive : Seconds → Bool
  | .finite remaining => decide (0 < remaining)
  | .infinity => true

/-- policy.ts:537-540 and 557 `Math.min(seconds, deadline.remaining())`. -/
def Seconds.cap (remaining : Seconds) (seconds : Nat) : Nat :=
  match remaining with
  | .finite r => min seconds r
  | .infinity => seconds

/-- `deadline.remaining()` after the clock advances by `seconds`. -/
def Seconds.elapse (remaining : Seconds) (seconds : Nat) : Seconds :=
  match remaining with
  | .finite r => .finite (r - seconds)
  | .infinity => .infinity

-- deadline.ts at its boundaries: a timeout of 0 never expires; a positive one
-- counts down to 0 and stays there.
#guard (WatchDeadline.create 0 7).remaining 1000 == .infinity
#guard (WatchDeadline.create 30 7).remaining 7 == .finite 30 && (WatchDeadline.create 30 7).remaining 17 == .finite 20
#guard (WatchDeadline.create 30 7).remaining 37 == .finite 0 && (WatchDeadline.create 30 7).remaining 100 == .finite 0
#guard (Seconds.finite 20).elapse 5 == .finite 15 && (Seconds.finite 20).elapse 25 == .finite 0
  && Seconds.infinity.elapse 5 == .infinity

/-- `seconds ≤ remaining`, with `Infinity` above every number. -/
def Seconds.covers (remaining : Seconds) (seconds : Nat) : Prop :=
  match remaining with
  | .finite r => seconds ≤ r
  | .infinity => True

instance : (remaining : Seconds) → (seconds : Nat) → Decidable (remaining.covers seconds)
  | .finite r, seconds => inferInstanceAs (Decidable (seconds ≤ r))
  | .infinity, _ => inferInstanceAs (Decidable True)

/-- The fields of `T.PollingOptions` that `pollUntilTerminal` reads. -/
structure PollingOptions where
  interval : Nat
  maxQueryErrors : Nat
deriving Repr, DecidableEq

/-- How one `await args.step()` at policy.ts:522 ends. -/
inductive StepOutcome
  | terminal                       -- returned `{ kind: "terminal" }`
  | sleep (seconds : Nat)          -- returned `{ kind: "sleep", seconds }`
  | continue_                      -- returned `{ kind: "continue" }`
  | queryError (retryable : Bool)  -- threw `WatcherQueryError`
  | deadlineExceeded               -- threw `DeadlineExceeded`
  | otherError                     -- threw anything else
deriving Repr, DecidableEq

/-- The step returned, so policy.ts:523 `failures = 0` ran. -/
def StepOutcome.succeeded : StepOutcome → Bool
  | .terminal | .sleep _ | .continue_ => true
  | _ => false

/-- What the last pass of the loop did. -/
inductive Last
  | start                                 -- no pass yet
  | sleptPoll (seconds : Nat)             -- policy.ts:556 `clock.sleep(seconds)`
  | sleptRetry (seconds : Nat)            -- policy.ts:550 `clock.sleep(seconds)`
  | continued                             -- `continue` result: no sleep
  | returnedVerdict                       -- policy.ts:553
  | returnedStatusQuery (failures : Nat)  -- policy.ts:536
  | returnedOnDeadline                    -- policy.ts:561, from 519 or the `break` at 525
  | threw                                 -- policy.ts:526
deriving Repr, DecidableEq

/-- The loop is back at policy.ts:519. -/
def Last.running : Last → Bool
  | .start | .sleptPoll _ | .sleptRetry _ | .continued => true
  | _ => false

/-- The argument of the `clock.sleep` call the last pass made. -/
def Last.sleepSeconds : Last → Option Nat
  | .sleptPoll seconds | .sleptRetry seconds => some seconds
  | _ => none

structure State where
  failures : Nat        -- policy.ts:515
  remaining : Seconds   -- `deadline.remaining()` now
  last : Last
  retries : Nat         -- ghost: `clock.sleep` calls at policy.ts:550 since the last successful step
  slept : Nat           -- ghost: sum of every `clock.sleep` argument
deriving Repr, DecidableEq

/-- The environment's part of one pass: how the step ended, how far the clock
moved while it ran, and how far it moved during the sleep the pass makes. -/
structure Event where
  outcome : StepOutcome
  stepElapsed : Nat
  sleepElapsed : Nat
deriving Repr, DecidableEq

/-- policy.ts:515-518. -/
def init (remaining : Seconds) : State := ⟨0, remaining, .start, 0, 0⟩

/-- One pass from the loop head, policy.ts:519-561. `none` once the function has
returned or thrown. -/
def pollStep (o : PollingOptions) (s : State) (e : Event) : Option State :=
  if s.last.running = false then none
  else if s.remaining.positive = false then
    some { s with last := .returnedOnDeadline }                                    -- 519, 561
  else
    let remaining := s.remaining.elapse e.stepElapsed                              -- 522
    match e.outcome with
    | .terminal =>                                                                 -- 523, 553
      some { s with failures := 0, retries := 0, remaining := remaining, last := .returnedVerdict }
    | .sleep seconds =>                                                            -- 523, 554-558
      let requested := remaining.cap seconds
      some { failures := 0, retries := 0, remaining := remaining.elapse e.sleepElapsed,
             last := .sleptPoll requested, slept := s.slept + requested }
    | .continue_ =>                                                                -- 523, then 519
      some { s with failures := 0, retries := 0, remaining := remaining, last := .continued }
    | .deadlineExceeded => some { s with remaining := remaining, last := .returnedOnDeadline }  -- 525
    | .otherError => some { s with remaining := remaining, last := .threw }        -- 526
    | .queryError retryable =>
      let failures := s.failures + 1                                               -- 534
      if retryable = false ∨ failures ≥ o.maxQueryErrors then                      -- 535-536
        some { s with failures := failures, remaining := remaining, last := .returnedStatusQuery failures }
      else
        let retryInSeconds := remaining.cap (queryBackoffSeconds o.interval failures)  -- 537-540
        some { failures := failures, retries := s.retries + 1, remaining := remaining.elapse e.sleepElapsed,
               last := .sleptRetry retryInSeconds, slept := s.slept + retryInSeconds }  -- 550-551

/-- The state after a sequence of passes. -/
def run (o : PollingOptions) (s : State) : List Event → State
  | [] => s
  | e :: es =>
    match pollStep o s e with
    | some t => run o t es
    | none => s

/-- Every sleep the pass requests is at most the deadline budget at the moment of
the request, which is after the step ran. -/
def SleepWithinBudget (s : State) (e : Event) (t : State) : Prop :=
  match t.last.sleepSeconds with
  | some seconds => (s.remaining.elapse e.stepElapsed).covers seconds
  | none => True

instance (s : State) (e : Event) (t : State) : Decidable (SleepWithinBudget s e t) := by
  unfold SleepWithinBudget; split <;> infer_instance

/-- A retry sleep is the backoff for the failure count just reached, which is at
least 1, capped by the budget. So `queryBackoffSeconds` is never called at 0. -/
def RetryUsesBackoff (o : PollingOptions) (s : State) (e : Event) (t : State) : Prop :=
  match t.last with
  | .sleptRetry seconds =>
    1 ≤ t.failures ∧
      seconds = (s.remaining.elapse e.stepElapsed).cap (queryBackoffSeconds o.interval t.failures)
  | _ => True

instance (o : PollingOptions) (s : State) (e : Event) (t : State) : Decidable (RetryUsesBackoff o s e t) := by
  unfold RetryUsesBackoff; split <;> infer_instance

/-- A pass whose step returned leaves `failures` at 0. -/
def ResetsFailures (s : State) (e : Event) (t : State) : Prop :=
  s.remaining.positive = true → e.outcome.succeeded = true → t.failures = 0 ∧ t.retries = 0

instance (s : State) (e : Event) (t : State) : Decidable (ResetsFailures s e t) := by
  unfold ResetsFailures; infer_instance

/-- While the loop runs the ghost count of retry sleeps equals `failures`, and it
is 0 or under the error budget. -/
def Invariant (o : PollingOptions) (s : State) : Prop :=
  (s.last.running = true → s.retries = s.failures) ∧ (s.retries = 0 ∨ s.retries < o.maxQueryErrors)

instance (o : PollingOptions) (s : State) : Decidable (Invariant o s) := by
  unfold Invariant; infer_instance

/-- Consecutive retry sleeps are strictly fewer than `maxQueryErrors`. -/
def RetriesBelowMax (o : PollingOptions) (s : State) : Prop := s.retries < o.maxQueryErrors

instance (o : PollingOptions) (s : State) : Decidable (RetriesBelowMax o s) := by
  unfold RetriesBelowMax; infer_instance

/-- The deadline is finite, and what was slept plus what remains fits in `timeout`. -/
def WithinTimeout (timeout : Nat) (s : State) : Prop :=
  match s.remaining with
  | .finite remaining => s.slept + remaining ≤ timeout
  | .infinity => False

instance (timeout : Nat) (s : State) : Decidable (WithinTimeout timeout s) := by
  unfold WithinTimeout; split <;> infer_instance

/-- The clock advanced by at least the slept amount (assumption 8). -/
def HonestClock (e : Event) (t : State) : Prop :=
  match t.last.sleepSeconds with
  | some seconds => seconds ≤ e.sleepElapsed
  | none => True

instance (e : Event) (t : State) : Decidable (HonestClock e t) := by
  unfold HonestClock; split <;> infer_instance

/-- `HonestClock` on every pass of a run. -/
def HonestRun (o : PollingOptions) (s : State) : List Event → Prop
  | [] => True
  | e :: es =>
    match pollStep o s e with
    | some t => HonestClock e t ∧ HonestRun o t es
    | none => True

/-- The pass went back to the loop head and the clock did not move during it. -/
def Stalls (e : Event) (t : State) : Prop :=
  t.last.running = true ∧ e.stepElapsed = 0 ∧ (t.last.sleepSeconds = none ∨ e.sleepElapsed = 0)

instance (e : Event) (t : State) : Decidable (Stalls e t) := by
  unfold Stalls; infer_instance

/-- The CLI default (`cli.ts:126,144`), a budget of three, the smallest budget
with an interval over the cap, and the smallest interval. -/
def boundedOptions : List PollingOptions := [⟨60, 5⟩, ⟨60, 3⟩, ⟨400, 1⟩, ⟨1, 2⟩]

/-- No deadline, a deadline already spent, and budgets under and over the
constants 60 and 300. -/
def boundedBudgets : List Seconds := [.infinity, .finite 0, .finite 1, .finite 100, .finite 1000]

/-- Every outcome, with a step that takes no time or 20 seconds. The outcomes
that can lead to a sleep also vary the clock during it: it stands still, moves
60 seconds, or moves 400. -/
def boundedEvents (o : PollingOptions) : List Event :=
  [0, 20].flatMap fun stepElapsed =>
    ([StepOutcome.terminal, .continue_, .queryError false, .deadlineExceeded, .otherError].map fun outcome =>
      ⟨outcome, stepElapsed, 0⟩)
    ++ [StepOutcome.sleep 0, .sleep o.interval, .queryError true].flatMap fun outcome =>
      [0, 60, 400].map fun sleepElapsed => ⟨outcome, stepElapsed, sleepElapsed⟩

/-- The states exactly `depth` passes from the start. -/
def frontier (o : PollingOptions) (start : Seconds) : Nat → List State
  | 0 => [init start]
  | depth + 1 =>
    ((frontier o start depth).flatMap fun s => (boundedEvents o).filterMap (pollStep o s)).eraseDups

def reachable (o : PollingOptions) (start : Seconds) (depth : Nat) : List State :=
  (List.range (depth + 1)).flatMap (frontier o start)

structure Transition where
  options : PollingOptions
  start : Seconds
  before : State
  event : Event
  after : State
deriving Repr

/-- The timeout that gave the run its starting budget. -/
def Transition.timeout (x : Transition) : Nat :=
  match x.start with
  | .finite remaining => remaining
  | .infinity => 0

/-- Every pass from a state at most three passes from the start, so runs of up
to four passes. Four reaches the fourth consecutive failure, where the backoff
is at its cap, and the exit that spends an error budget of three. -/
def transitions : List Transition :=
  boundedOptions.flatMap fun o => boundedBudgets.flatMap fun start =>
    (reachable o start 3).flatMap fun s => (boundedEvents o).filterMap fun e =>
      (pollStep o s e).map fun t => ⟨o, start, s, e, t⟩

/-- The properties of one pass. Each theorem below proves one for every size. -/
def stepProperties : List (String × (Transition → Bool)) :=
  [("SleepWithinBudget", fun x => SleepWithinBudget x.before x.event x.after),
   ("RetryUsesBackoff", fun x => RetryUsesBackoff x.options x.before x.event x.after),
   ("ResetsFailures", fun x => ResetsFailures x.before x.event x.after),
   ("Invariant", fun x => Invariant x.options x.before ∧ Invariant x.options x.after),
   ("RetriesBelowMax", fun x => RetriesBelowMax x.options x.after),
   ("WithinTimeout", fun x =>
      WithinTimeout x.timeout x.before → HonestClock x.event x.after → WithinTimeout x.timeout x.after)]

/-- Find counter-examples: each property with a transition in the bound that
breaks it. -/
def badSteps : List (String × Transition) :=
  transitions.flatMap fun x => (stepProperties.filter fun (_, p) => !p x).map fun (name, _) => (name, x)

#eval badSteps   -- []
#guard badSteps.isEmpty

-- `maxQueryErrors = 0` is outside the CLI range (`cli.ts:58-63`). There the loop
-- makes zero retry sleeps, and 0 is not strictly less than 0.
#eval decide (RetriesBelowMax ⟨60, 0⟩ (init .infinity))   -- false
#guard ¬ RetriesBelowMax ⟨60, 0⟩ (init .infinity)

/-- The states the properties depend on. -/
def reachTargets : List (String × (Transition → Bool)) :=
  [("a retry sleep at the largest count the error budget allows", fun x =>
      x.options.maxQueryErrors ≥ 2 && x.after.retries + 1 == x.options.maxQueryErrors
        && x.event.outcome == .queryError true && x.after.last.sleepSeconds.isSome),
   ("the exit that spends the error budget on retryable failures", fun x =>
      x.event.outcome == .queryError true && x.after.last == .returnedStatusQuery x.options.maxQueryErrors),
   ("a retry sleep at the backoff cap", fun x => x.after.last == .sleptRetry 300),
   ("a retry sleep cut short by the deadline", fun x =>
      match x.after.last with
      | .sleptRetry seconds => 0 < seconds && seconds < 60
      | _ => false),
   ("a poll sleep cut short by the deadline", fun x =>
      match x.event.outcome, x.after.last with
      | .sleep asked, .sleptPoll seconds => 0 < seconds && seconds < asked
      | _, _ => false),
   ("a successful step after failures", fun x =>
      x.before.failures > 0 && x.event.outcome.succeeded && x.after.failures == 0),
   ("the loop-head exit with the budget spent", fun x =>
      x.before.last.running && x.before.remaining == .finite 0 && x.after.last == .returnedOnDeadline),
   ("an honest run that sleeps the whole timeout", fun x =>
      x.timeout > 0 && WithinTimeout x.timeout x.after && x.after.slept == x.timeout),
   ("a still clock that lets the sleeps pass the timeout, so the clock hypothesis is needed", fun x =>
      x.start != .infinity && x.after.slept > x.timeout)]

/-- The reach targets the bounded search misses. -/
def unreachedSteps : List String :=
  let all := transitions
  (reachTargets.filter fun (_, p) => !all.any p).map fun (name, _) => name

#eval (transitions.length, unreachedSteps)
#guard unreachedSteps.isEmpty

/-- The step outcomes of the passes in the bound that stall under an honest clock. -/
def stallOutcomes : List StepOutcome :=
  ((transitions.filter fun x => HonestClock x.event x.after ∧ Stalls x.event x.after).map
    fun x => x.event.outcome).eraseDups

-- The loop can go round without the clock advancing, on exactly these two results.
#eval stallOutcomes
#guard stallOutcomes.length == 2 && stallOutcomes.all fun outcome => outcome == .continue_ || outcome == .sleep 0

/-! ## 3. `noChecksConfirmer`, policy.ts:63-85 -/

/-- policy.ts:66. -/
def NO_CHECKS_CONFIRM_SECONDS : Nat := 60

/-- A value of the `firstSeen` map, policy.ts:70-73. `seenAt` is the field `at`. -/
structure Sighting where
  headRefOid : Nat
  seenAt : Nat
deriving Repr, DecidableEq

/-- The `firstSeen` map of policy.ts:70, keyed by PR number. -/
abbrev FirstSeen := Nat → Option Sighting

/-- policy.ts:79-82 `firstSeen.set(pr, sighting)`. -/
def firstSeenSet (firstSeen : FirstSeen) (pr : Nat) (sighting : Sighting) : FirstSeen :=
  fun n => if n = pr then some sighting else firstSeen n

/-- One call of the closure, policy.ts:74-84: the map after the call and the
result. Truncated `now - prior.seenAt` agrees with JavaScript, where a negative
difference is also below 60. -/
def confirm (firstSeen : FirstSeen) (now pr headRefOid : Nat) : FirstSeen × Bool :=
  match firstSeen pr with                                                          -- 76
  | some prior =>
    if prior.headRefOid = headRefOid then                                          -- 77
      (firstSeen, decide (now - prior.seenAt ≥ NO_CHECKS_CONFIRM_SECONDS))         -- 78
    else (firstSeenSet firstSeen pr ⟨headRefOid, now⟩, false)                      -- 79-83, head changed
  | none => (firstSeenSet firstSeen pr ⟨headRefOid, now⟩, false)                   -- 79-83, first sighting

/-- One call of the closure: the clock reading and the head it was given. -/
structure Call where
  now : Nat
  pr : Nat
  headRefOid : Nat
deriving Repr, DecidableEq

/-- The map after the calls in `past`, newest first, from the empty map of
policy.ts:70. -/
def firstSeenAfter : List Call → FirstSeen
  | [] => fun _ => none
  | c :: older => (confirm (firstSeenAfter older) c.now c.pr c.headRefOid).1

/-- The result of call `c` made after the calls in `past`, newest first. -/
def confirmAfter (past : List Call) (c : Call) : Bool :=
  (confirm (firstSeenAfter past) c.now c.pr c.headRefOid).2

/-- The results of a sequence of calls, oldest first. -/
def confirmAll (calls : List Call) : List Bool :=
  (List.range calls.length).filterMap fun i => calls[i]?.map (confirmAfter (calls.take i).reverse)

/-- The specification, read backwards from the newest call with no map: the
time `headRefOid` was first seen in the unbroken run of sightings of it that ends
at the latest sighting of `pr`. `none` when `pr` was never seen or its latest
sighting had another head. -/
def runStart (pr headRefOid : Nat) : List Call → Option Nat
  | [] => none
  | c :: older =>
    if c.pr = pr then
      if c.headRefOid = headRefOid then
        match runStart pr headRefOid older with
        | some earlier => some earlier
        | none => some c.now
      else none
    else runStart pr headRefOid older

/-- The confirmer returns true exactly when the head's current run on that PR
started at least 60 seconds before the call. -/
def ConfirmSpec (past : List Call) (c : Call) : Prop :=
  confirmAfter past c =
    match runStart c.pr c.headRefOid past with
    | some firstSeenAt => decide (firstSeenAt + 60 ≤ c.now)
    | none => false

instance (past : List Call) (c : Call) : Decidable (ConfirmSpec past c) := by
  unfold ConfirmSpec; infer_instance

/-- True only when an earlier call saw the same head on the same PR at least 60
seconds before. -/
def ConfirmSound (past : List Call) (c : Call) : Prop :=
  confirmAfter past c = true →
    ∃ p ∈ past, p.pr = c.pr ∧ p.headRefOid = c.headRefOid ∧ p.now + 60 ≤ c.now

instance (past : List Call) (c : Call) : Decidable (ConfirmSound past c) := by
  unfold ConfirmSound; infer_instance

/-- The first sighting of a PR returns false. -/
def FirstSightingFalse (past : List Call) (c : Call) : Prop :=
  (∀ p ∈ past, p.pr ≠ c.pr) → confirmAfter past c = false

instance (past : List Call) (c : Call) : Decidable (FirstSightingFalse past c) := by
  unfold FirstSightingFalse; infer_instance

/-- A head that differs from the PR's latest sighting returns false. -/
def HeadChangeFalse (past : List Call) (c : Call) : Prop :=
  match past.find? fun p => p.pr = c.pr with
  | some latest => latest.headRefOid ≠ c.headRefOid → confirmAfter past c = false
  | none => True

instance (past : List Call) (c : Call) : Decidable (HeadChangeFalse past c) := by
  unfold HeadChangeFalse; split <;> infer_instance

/-- No confirmation while every earlier call is under 60 seconds old, which
covers a clock that stands still or runs backwards. -/
def ClockMustAdvance (past : List Call) (c : Call) : Prop :=
  (∀ p ∈ past, c.now < p.now + 60) → confirmAfter past c = false

instance (past : List Call) (c : Call) : Decidable (ClockMustAdvance past c) := by
  unfold ClockMustAdvance; infer_instance

/-- Clock readings on both sides of the 60-second window, in every order, on two
PRs with two heads. -/
def boundedCalls : List Call :=
  [0, 59, 60, 61, 120].flatMap fun now => [1, 2].flatMap fun pr => [0, 1].map fun headRefOid =>
    ⟨now, pr, headRefOid⟩

/-- Every history of exactly `length` calls, newest first. -/
def histories : Nat → List (List Call)
  | 0 => [[]]
  | length + 1 => (histories length).flatMap fun past => boundedCalls.map fun c => c :: past

/-- A history of up to three calls and the call made after it. Three earlier
calls hold head A, then B, then A again before the call under test. -/
def confirmCases : List (List Call × Call) :=
  ((List.range 4).flatMap histories).flatMap fun past => boundedCalls.map fun c => (past, c)

/-- The properties of one call. Each theorem below proves one for every history. -/
def confirmProperties : List (String × (List Call → Call → Bool)) :=
  [("ConfirmSpec", fun past c => ConfirmSpec past c),
   ("ConfirmSound", fun past c => ConfirmSound past c),
   ("FirstSightingFalse", fun past c => FirstSightingFalse past c),
   ("HeadChangeFalse", fun past c => HeadChangeFalse past c),
   ("ClockMustAdvance", fun past c => ClockMustAdvance past c)]

/-- Find counter-examples: each property with a case in the bound that breaks it. -/
def badConfirms : List (String × List Call × Call) :=
  confirmCases.flatMap fun (past, c) =>
    (confirmProperties.filter fun (_, p) => !p past c).map fun (name, _) => (name, past, c)

#eval badConfirms   -- []
#guard badConfirms.isEmpty

/-- The cases the properties depend on. -/
def confirmTargets : List (String × (List Call → Call → Bool)) :=
  [("a confirmation", fun past c => confirmAfter past c),
   ("a refusal 59 seconds after the first sighting", fun past c =>
      past == [⟨0, 1, 0⟩] && c == ⟨59, 1, 0⟩ && !confirmAfter past c),
   ("a confirmation at exactly 60 seconds", fun past c =>
      past == [⟨0, 1, 0⟩] && c == ⟨60, 1, 0⟩ && confirmAfter past c),
   ("head A again after B, refused although A was first seen 120 seconds earlier", fun past c =>
      past == [⟨61, 1, 0⟩, ⟨59, 1, 1⟩, ⟨0, 1, 0⟩] && c == ⟨120, 1, 0⟩ && !confirmAfter past c),
   ("a clock that stands still", fun past c =>
      past == [⟨60, 1, 0⟩, ⟨60, 1, 0⟩, ⟨60, 1, 0⟩] && c == ⟨60, 1, 0⟩ && !confirmAfter past c),
   ("a clock that runs backwards", fun past c =>
      past == [⟨120, 1, 0⟩] && c == ⟨0, 1, 0⟩ && !confirmAfter past c)]

/-- The reach targets the bounded search misses. -/
def unreachedConfirms : List String :=
  let all := confirmCases
  (confirmTargets.filter fun (_, p) => !all.any fun (past, c) => p past c).map fun (name, _) => name

#eval (confirmCases.length, unreachedConfirms)
#guard unreachedConfirms.isEmpty

-- Head A, B, then A: the second run of A confirms 60 seconds after its own start.
#guard confirmAll [⟨0, 1, 0⟩, ⟨10, 1, 1⟩, ⟨100, 1, 0⟩, ⟨159, 1, 0⟩, ⟨160, 1, 0⟩]
  == [false, false, false, false, true]

/-! ## Theorems for every size -/

/-! ### `queryBackoffSeconds` -/

theorem queryBackoff_ge_60 (interval failures : Nat) (h : 1 ≤ failures) :
    60 ≤ queryBackoffSeconds interval failures := by
  -- The truncated model does not need `h`; it limits the claim to where the model is faithful.
  have _ := h
  have hpow : 2 ^ 0 ≤ 2 ^ (failures - 1) := Nat.pow_le_pow_right (by decide) (by omega)
  have hmul := Nat.mul_le_mul_left (max interval 60) hpow
  simp only [Nat.pow_zero, Nat.mul_one] at hmul
  unfold queryBackoffSeconds
  omega

theorem queryBackoff_le_300 (interval failures : Nat) : queryBackoffSeconds interval failures ≤ 300 := by
  unfold queryBackoffSeconds
  omega

theorem queryBackoff_mono (interval f g : Nat) (hf : 1 ≤ f) (hfg : f ≤ g) :
    queryBackoffSeconds interval f ≤ queryBackoffSeconds interval g := by
  have hpow : 2 ^ (f - 1) ≤ 2 ^ (g - 1) := Nat.pow_le_pow_right (by decide) (by omega)
  have hmul := Nat.mul_le_mul_left (max interval 60) hpow
  unfold queryBackoffSeconds
  omega

theorem queryBackoff_eq_300 (interval failures : Nat) (h : 4 ≤ failures) :
    queryBackoffSeconds interval failures = 300 := by
  have hpow : 2 ^ 3 ≤ 2 ^ (failures - 1) := Nat.pow_le_pow_right (by decide) (by omega)
  have hmul := Nat.mul_le_mul_left (max interval 60) hpow
  have height : (2 : Nat) ^ 3 = 8 := by decide
  rw [height] at hmul
  unfold queryBackoffSeconds
  omega

theorem queryBackoff_first (interval : Nat) : queryBackoffSeconds interval 1 = min (max interval 60) 300 := by
  simp [queryBackoffSeconds]

theorem queryBackoff_doubles (interval failures : Nat) (h : 1 ≤ failures) :
    queryBackoffSeconds interval (failures + 1) = min (2 * queryBackoffSeconds interval failures) 300 := by
  obtain ⟨k, rfl⟩ : ∃ k, failures = k + 1 := ⟨failures - 1, by omega⟩
  simp only [queryBackoffSeconds, Nat.add_sub_cancel]
  have hdouble : max interval 60 * 2 ^ (k + 1) = 2 * (max interval 60 * 2 ^ k) := by
    rw [Nat.pow_succ, ← Nat.mul_assoc, Nat.mul_comm]
  rw [hdouble]
  omega

theorem queryBackoffHalfSeconds_eq (interval failures : Nat) (h : 1 ≤ failures) :
    queryBackoffHalfSeconds interval failures = 2 * queryBackoffSeconds interval failures := by
  obtain ⟨k, rfl⟩ : ∃ k, failures = k + 1 := ⟨failures - 1, by omega⟩
  simp only [queryBackoffHalfSeconds, queryBackoffSeconds, Nat.add_sub_cancel]
  have hdouble : max interval 60 * 2 ^ (k + 1) = 2 * (max interval 60 * 2 ^ k) := by
    rw [Nat.pow_succ, ← Nat.mul_assoc, Nat.mul_comm]
  rw [hdouble]
  omega

theorem backoffSpec (interval failures : Nat) (h : 1 ≤ failures) : BackoffSpec interval failures := by
  unfold BackoffSpec
  refine ⟨queryBackoff_ge_60 interval failures h, queryBackoff_le_300 interval failures,
    queryBackoff_mono interval failures (failures + 1) h (Nat.le_succ failures),
    queryBackoff_eq_300 interval failures, ?_, queryBackoff_doubles interval failures h,
    queryBackoffHalfSeconds_eq interval failures h⟩
  intro hone
  subst hone
  exact queryBackoff_first interval

/-- At `failures = 0` JavaScript returns half of `min (max interval 60) 600`. -/
theorem queryBackoffHalfSeconds_zero (interval : Nat) :
    queryBackoffHalfSeconds interval 0 = min (max interval 60) 600 := by
  simp [queryBackoffHalfSeconds]

/-- At `failures = 0` the result is under the 60-second floor exactly when
`interval < 120`. -/
theorem queryBackoff_zero_below_floor (interval : Nat) :
    queryBackoffHalfSeconds interval 0 < 2 * 60 ↔ interval < 120 := by
  rw [queryBackoffHalfSeconds_zero]
  omega

/-! ### `WatchDeadline.remaining` -/

theorem remaining_create_finite (timeout t0 elapsed : Nat) (h : 0 < timeout) :
    (WatchDeadline.create timeout t0).remaining (t0 + elapsed) = .finite (timeout - elapsed) := by
  have hsub : t0 + timeout - (t0 + elapsed) = timeout - elapsed := by omega
  simp [WatchDeadline.create, WatchDeadline.remaining, h, hsub]

theorem remaining_create_infinity (t0 now : Nat) : (WatchDeadline.create 0 t0).remaining now = .infinity := by
  simp [WatchDeadline.create, WatchDeadline.remaining]

/-- `Seconds.elapse` is what a clock advance does to `WatchDeadline.remaining`. -/
theorem remaining_elapse (d : WatchDeadline) (now seconds : Nat) :
    d.remaining (now + seconds) = (d.remaining now).elapse seconds := by
  obtain ⟨expiresAt⟩ := d
  cases expiresAt <;> simp [WatchDeadline.remaining, Seconds.elapse, Nat.sub_add_eq]

/-! ### `pollUntilTerminal` -/

/-- Split `h : pollStep o s e = some t` into the paths through the loop body and
replace `t` by the state each path builds. -/
local macro "poll_paths " h:ident : tactic =>
  `(tactic| (
    simp only [pollStep] at $h:ident
    repeat' split at $h:ident
    all_goals first | cases $h:ident | skip))

theorem covers_cap (remaining : Seconds) (seconds : Nat) : remaining.covers (remaining.cap seconds) := by
  cases remaining <;> simp [Seconds.covers, Seconds.cap]
  omega

theorem pollStep_sleep_within_budget (o : PollingOptions) (s t : State) (e : Event)
    (h : pollStep o s e = some t) : SleepWithinBudget s e t := by
  poll_paths h <;> simp [SleepWithinBudget, Last.sleepSeconds, covers_cap]

theorem pollStep_retry_uses_backoff (o : PollingOptions) (s t : State) (e : Event)
    (h : pollStep o s e = some t) : RetryUsesBackoff o s e t := by
  poll_paths h <;> simp [RetryUsesBackoff]

theorem pollStep_resets_failures (o : PollingOptions) (s t : State) (e : Event)
    (h : pollStep o s e = some t) : ResetsFailures s e t := by
  poll_paths h <;> simp_all [ResetsFailures, StepOutcome.succeeded]

theorem invariant_init (o : PollingOptions) (remaining : Seconds) : Invariant o (init remaining) := by
  simp [Invariant, init]

theorem pollStep_keeps_invariant (o : PollingOptions) (s t : State) (e : Event)
    (hs : Invariant o s) (h : pollStep o s e = some t) : Invariant o t := by
  unfold Invariant at hs ⊢
  poll_paths h <;> simp_all [Last.running] <;> omega

theorem run_keeps_invariant (o : PollingOptions) (s : State) (es : List Event)
    (hs : Invariant o s) : Invariant o (run o s es) := by
  induction es generalizing s with
  | nil => exact hs
  | cons e es ih =>
    cases hstep : pollStep o s e with
    | none => simpa [run, hstep] using hs
    | some t =>
      simp only [run, hstep]
      exact ih t (pollStep_keeps_invariant o s t e hs hstep)

/-- `hmax` is the CLI's range for `--max-query-errors`, `cli.ts:58-63,140-145`. -/
theorem run_retries_below_max (o : PollingOptions) (remaining : Seconds) (es : List Event)
    (hmax : 0 < o.maxQueryErrors) : RetriesBelowMax o (run o (init remaining) es) := by
  have hinv := run_keeps_invariant o (init remaining) es (invariant_init o remaining)
  unfold Invariant at hinv
  unfold RetriesBelowMax
  omega

/-- `hclock` is assumption 8: the clock advanced by at least the slept amount. -/
theorem pollStep_keeps_timeout (timeout : Nat) (o : PollingOptions) (s t : State) (e : Event)
    (hs : WithinTimeout timeout s) (h : pollStep o s e = some t) (hclock : HonestClock e t) :
    WithinTimeout timeout t := by
  obtain ⟨failures, remaining, last, retries, slept⟩ := s
  cases remaining with
  | infinity => simp [WithinTimeout] at hs
  | finite remaining =>
    poll_paths h <;>
      simp_all [WithinTimeout, HonestClock, Last.sleepSeconds, Seconds.elapse, Seconds.cap] <;> omega

theorem run_keeps_timeout (timeout : Nat) (o : PollingOptions) (s : State) (es : List Event)
    (hs : WithinTimeout timeout s) (hclock : HonestRun o s es) : WithinTimeout timeout (run o s es) := by
  induction es generalizing s with
  | nil => exact hs
  | cons e es ih =>
    cases hstep : pollStep o s e with
    | none => simpa [run, hstep] using hs
    | some t =>
      simp only [HonestRun, hstep] at hclock
      simp only [run, hstep]
      exact ih t (pollStep_keeps_timeout timeout o s t e hs hstep hclock.1) hclock.2

theorem slept_le_of_withinTimeout (timeout : Nat) (s : State) (hs : WithinTimeout timeout s) :
    s.slept ≤ timeout := by
  unfold WithinTimeout at hs
  split at hs
  · omega
  · exact absurd hs id

/-- With a finite positive timeout and a clock that advances by at least the
slept amount, the loop's sleeps total at most the timeout. `elapsed` is the time
between creating the deadline and entering the loop. -/
theorem pollUntilTerminal_slept_le_timeout (o : PollingOptions) (timeout t0 elapsed : Nat) (es : List Event)
    (htimeout : 0 < timeout)
    (hclock : HonestRun o (init ((WatchDeadline.create timeout t0).remaining (t0 + elapsed))) es) :
    (run o (init ((WatchDeadline.create timeout t0).remaining (t0 + elapsed))) es).slept ≤ timeout := by
  rw [remaining_create_finite timeout t0 elapsed htimeout] at hclock ⊢
  have hinit : WithinTimeout timeout (init (.finite (timeout - elapsed))) := by
    simp [WithinTimeout, init]
  exact slept_le_of_withinTimeout timeout _ (run_keeps_timeout timeout o _ es hinit hclock)

/-- Under an honest clock, only a `continue` result or a `sleep` result with
`seconds = 0`, from a step that took no time, sends the loop round without the
clock advancing. -/
theorem stall_needs_continue_or_zero_sleep (o : PollingOptions) (s t : State) (e : Event)
    (h : pollStep o s e = some t) (hclock : HonestClock e t) (hstall : Stalls e t) :
    e.outcome = .continue_ ∨ e.outcome = .sleep 0 := by
  obtain ⟨failures, remaining, last, retries, slept⟩ := s
  have hfloor := queryBackoff_ge_60 o.interval (failures + 1) (by omega)
  cases remaining <;> poll_paths h <;>
    simp_all [Stalls, HonestClock, Last.running, Last.sleepSeconds, Seconds.positive, Seconds.elapse,
      Seconds.cap] <;> omega

/-- A `continue` result from a step that takes no time returns the loop to the
same state, so nothing in `pollUntilTerminal` bounds how often it repeats. -/
theorem continue_without_clock_repeats (o : PollingOptions) (s : State) (sleepElapsed : Nat)
    (hlast : s.last = .continued) (hbudget : s.remaining.positive = true)
    (hfailures : s.failures = 0) (hretries : s.retries = 0) :
    pollStep o s ⟨.continue_, 0, sleepElapsed⟩ = some s := by
  obtain ⟨failures, remaining, last, retries, slept⟩ := s
  cases remaining <;> simp_all [pollStep, Last.running, Seconds.elapse]

/-- The same for a `sleep` result with `seconds = 0`. -/
theorem zero_sleep_without_clock_repeats (o : PollingOptions) (s : State)
    (hlast : s.last = .sleptPoll 0) (hbudget : s.remaining.positive = true)
    (hfailures : s.failures = 0) (hretries : s.retries = 0) :
    pollStep o s ⟨.sleep 0, 0, 0⟩ = some s := by
  obtain ⟨failures, remaining, last, retries, slept⟩ := s
  cases remaining <;> simp_all [pollStep, Last.running, Seconds.elapse, Seconds.cap]

/-! ### `noChecksConfirmer` -/

theorem confirm_true_iff (firstSeen : FirstSeen) (now pr headRefOid : Nat) :
    (confirm firstSeen now pr headRefOid).2 = true ↔
      ∃ firstSeenAt, firstSeen pr = some ⟨headRefOid, firstSeenAt⟩ ∧ firstSeenAt + 60 ≤ now := by
  unfold confirm
  cases hprior : firstSeen pr with
  | none => simp
  | some prior =>
    obtain ⟨head, seenAt⟩ := prior
    by_cases hhead : head = headRefOid
    · subst hhead
      simp [NO_CHECKS_CONFIRM_SECONDS]
      omega
    · simp [hhead]

/-- A first sighting or a changed head returns false and restarts the timer. -/
theorem confirm_new_head_resets (firstSeen : FirstSeen) (now pr headRefOid : Nat)
    (hnew : ∀ firstSeenAt, firstSeen pr ≠ some ⟨headRefOid, firstSeenAt⟩) :
    (confirm firstSeen now pr headRefOid).2 = false ∧
      (confirm firstSeen now pr headRefOid).1 pr = some ⟨headRefOid, now⟩ := by
  unfold confirm
  cases hprior : firstSeen pr with
  | none => simp [firstSeenSet]
  | some prior =>
    obtain ⟨head, seenAt⟩ := prior
    have hhead : head ≠ headRefOid := by
      intro heq
      subst heq
      exact hnew seenAt hprior
    simp [hhead, firstSeenSet]

/-- Seeing the same head again does not restart the timer. -/
theorem confirm_same_head_keeps_first_seen (firstSeen : FirstSeen) (now pr headRefOid firstSeenAt : Nat)
    (hsame : firstSeen pr = some ⟨headRefOid, firstSeenAt⟩) :
    (confirm firstSeen now pr headRefOid).1 = firstSeen := by
  simp [confirm, hsame]

theorem confirm_other_pr_untouched (firstSeen : FirstSeen) (now pr headRefOid other : Nat)
    (hother : other ≠ pr) : (confirm firstSeen now pr headRefOid).1 other = firstSeen other := by
  unfold confirm
  split
  · split
    · rfl
    · simp [firstSeenSet, hother]
  · simp [firstSeenSet, hother]

/-- The map holds, for each PR, its latest head and when that head's run began. -/
theorem firstSeenAfter_spec (past : List Call) (pr headRefOid firstSeenAt : Nat) :
    firstSeenAfter past pr = some ⟨headRefOid, firstSeenAt⟩ ↔ runStart pr headRefOid past = some firstSeenAt := by
  induction past generalizing pr headRefOid firstSeenAt with
  | nil => simp [firstSeenAfter, runStart]
  | cons c older ih =>
    by_cases hpr : c.pr = pr
    · subst hpr
      by_cases hsame : ∃ earlier, firstSeenAfter older c.pr = some ⟨c.headRefOid, earlier⟩
      · -- The latest head is seen again: the map and the run start stay as they were.
        obtain ⟨earlier, hearlier⟩ := hsame
        have hrun := (ih c.pr c.headRefOid earlier).mp hearlier
        have hkeep := confirm_same_head_keeps_first_seen (firstSeenAfter older) c.now c.pr c.headRefOid
          earlier hearlier
        by_cases hhead : c.headRefOid = headRefOid
        · subst hhead
          simp [firstSeenAfter, runStart, hkeep, hearlier, hrun]
        · simp [firstSeenAfter, runStart, hkeep, hearlier, hhead]
      · -- A first sighting or a changed head: both restart at this call.
        have hnew : ∀ earlier, firstSeenAfter older c.pr ≠ some ⟨c.headRefOid, earlier⟩ :=
          fun earlier h => hsame ⟨earlier, h⟩
        have hrun : runStart c.pr c.headRefOid older = none := by
          cases hrs : runStart c.pr c.headRefOid older with
          | none => rfl
          | some earlier => exact absurd ((ih c.pr c.headRefOid earlier).mpr hrs) (hnew earlier)
        have hreset := (confirm_new_head_resets (firstSeenAfter older) c.now c.pr c.headRefOid hnew).2
        by_cases hhead : c.headRefOid = headRefOid
        · subst hhead
          simp [firstSeenAfter, runStart, hreset, hrun]
        · simp [firstSeenAfter, runStart, hreset, hhead]
    · have hkeep := confirm_other_pr_untouched (firstSeenAfter older) c.now c.pr c.headRefOid pr
        (fun h => hpr h.symm)
      simp only [firstSeenAfter, runStart, hkeep, hpr, ↓reduceIte]
      exact ih pr headRefOid firstSeenAt

theorem confirmAfter_true_iff (past : List Call) (c : Call) :
    confirmAfter past c = true ↔
      ∃ firstSeenAt, runStart c.pr c.headRefOid past = some firstSeenAt ∧ firstSeenAt + 60 ≤ c.now := by
  unfold confirmAfter
  rw [confirm_true_iff]
  constructor
  · intro ⟨firstSeenAt, hmap, hold⟩
    exact ⟨firstSeenAt, (firstSeenAfter_spec past c.pr c.headRefOid firstSeenAt).mp hmap, hold⟩
  · intro ⟨firstSeenAt, hrun, hold⟩
    exact ⟨firstSeenAt, (firstSeenAfter_spec past c.pr c.headRefOid firstSeenAt).mpr hrun, hold⟩

theorem confirmAfter_spec (past : List Call) (c : Call) : ConfirmSpec past c := by
  unfold ConfirmSpec
  have hiff := confirmAfter_true_iff past c
  cases hrun : runStart c.pr c.headRefOid past with
  | none =>
    cases hresult : confirmAfter past c with
    | false => rfl
    | true =>
      obtain ⟨firstSeenAt, hsome, _⟩ := hiff.mp hresult
      rw [hrun] at hsome
      cases hsome
  | some firstSeenAt =>
    rw [hrun] at hiff
    cases hresult : confirmAfter past c with
    | false =>
      have hnot : ¬ firstSeenAt + 60 ≤ c.now := fun hold =>
        absurd (hiff.mpr ⟨firstSeenAt, rfl, hold⟩) (by simp [hresult])
      simp [hnot]
    | true =>
      obtain ⟨other, hsome, hold⟩ := hiff.mp hresult
      cases hsome
      simp [hold]

theorem runStart_some_mem (pr headRefOid firstSeenAt : Nat) (past : List Call)
    (hrun : runStart pr headRefOid past = some firstSeenAt) :
    ∃ p ∈ past, p.pr = pr ∧ p.headRefOid = headRefOid ∧ p.now = firstSeenAt := by
  induction past with
  | nil => simp [runStart] at hrun
  | cons c older ih =>
    simp only [runStart] at hrun
    by_cases hpr : c.pr = pr
    · by_cases hhead : c.headRefOid = headRefOid
      · simp only [hpr, hhead, ↓reduceIte] at hrun
        cases holder : runStart pr headRefOid older with
        | none =>
          simp only [holder] at hrun
          exact ⟨c, List.mem_cons_self, hpr, hhead, Option.some.inj hrun⟩
        | some earlier =>
          simp only [holder] at hrun
          obtain ⟨p, hp, hfound⟩ := ih (hrun ▸ holder)
          exact ⟨p, List.mem_cons_of_mem c hp, hfound⟩
      · simp [hpr, hhead] at hrun
    · simp only [hpr, ↓reduceIte] at hrun
      obtain ⟨p, hp, hfound⟩ := ih hrun
      exact ⟨p, List.mem_cons_of_mem c hp, hfound⟩

theorem confirm_sound (past : List Call) (c : Call) : ConfirmSound past c := by
  intro hresult
  obtain ⟨firstSeenAt, hrun, hold⟩ := (confirmAfter_true_iff past c).mp hresult
  obtain ⟨p, hp, hpr, hhead, hnow⟩ := runStart_some_mem c.pr c.headRefOid firstSeenAt past hrun
  exact ⟨p, hp, hpr, hhead, by omega⟩

theorem confirm_first_sighting_false (past : List Call) (c : Call) : FirstSightingFalse past c := by
  intro hfirst
  cases hresult : confirmAfter past c with
  | false => rfl
  | true =>
    obtain ⟨p, hp, hpr, _⟩ := confirm_sound past c hresult
    exact absurd hpr (hfirst p hp)

theorem runStart_none_of_head_change (pr headRefOid : Nat) (past : List Call) (latest : Call)
    (hfind : (past.find? fun p => p.pr = pr) = some latest) (hne : latest.headRefOid ≠ headRefOid) :
    runStart pr headRefOid past = none := by
  induction past with
  | nil => simp at hfind
  | cons c older ih =>
    by_cases hpr : c.pr = pr
    · simp [List.find?, hpr] at hfind
      subst hfind
      simp [runStart, hpr, hne]
    · simp [List.find?, hpr] at hfind
      simp only [runStart, hpr, ↓reduceIte]
      exact ih hfind

theorem confirm_head_change_false (past : List Call) (c : Call) : HeadChangeFalse past c := by
  unfold HeadChangeFalse
  split
  · rename_i latest hfind
    intro hne
    cases hresult : confirmAfter past c with
    | false => rfl
    | true =>
      obtain ⟨firstSeenAt, hrun, _⟩ := (confirmAfter_true_iff past c).mp hresult
      rw [runStart_none_of_head_change c.pr c.headRefOid past latest hfind hne] at hrun
      cases hrun
  · trivial

theorem confirm_clock_must_advance (past : List Call) (c : Call) : ClockMustAdvance past c := by
  intro hrecent
  cases hresult : confirmAfter past c with
  | false => rfl
  | true =>
    obtain ⟨p, hp, _, _, hold⟩ := confirm_sound past c hresult
    have := hrecent p hp
    omega

/-- Head A, then B, then A: the second run of A counts from its own first
sighting, whatever came before B. -/
theorem confirm_aba_restarts (older : List Call) (pr a b t1 t2 now : Nat) (hab : a ≠ b) :
    confirmAfter (⟨t2, pr, a⟩ :: ⟨t1, pr, b⟩ :: older) ⟨now, pr, a⟩ = decide (t2 + 60 ≤ now) := by
  have hrun : runStart pr a (⟨t2, pr, a⟩ :: ⟨t1, pr, b⟩ :: older) = some t2 := by
    simp [runStart, Ne.symm hab]
  have hspec := confirmAfter_spec (⟨t2, pr, a⟩ :: ⟨t1, pr, b⟩ :: older) ⟨now, pr, a⟩
  unfold ConfirmSpec at hspec
  simpa [hrun] using hspec

/-! ## Differential vectors -/

/-- `(interval, failures)` inputs for `queryBackoffSeconds`. `failures = 0` is in
the list because the production function accepts it. -/
def backoffVectors : List (Nat × Nat) :=
  [0, 1, 30, 59, 60, 61, 74, 75, 76, 100, 119, 120, 149, 150, 151, 299, 300, 301, 600, 601, 3600,
   9007199254740991].flatMap fun interval =>
    [0, 1, 2, 3, 4, 5, 10, 64, 1024, 1025, 1100].map fun failures => (interval, failures)

/-- Call sequences for one `noChecksConfirmer` closure, oldest first. -/
def confirmVectors : List (List Call) :=
  [[⟨0, 1, 0⟩],
   [⟨0, 1, 0⟩, ⟨59, 1, 0⟩, ⟨60, 1, 0⟩, ⟨61, 1, 0⟩],
   [⟨1000, 1, 0⟩, ⟨1059, 1, 0⟩, ⟨1060, 1, 0⟩],
   [⟨5, 1, 0⟩, ⟨5, 1, 0⟩, ⟨5, 1, 0⟩, ⟨5, 1, 0⟩],
   [⟨0, 1, 0⟩, ⟨10, 1, 1⟩, ⟨100, 1, 0⟩, ⟨159, 1, 0⟩, ⟨160, 1, 0⟩],
   [⟨0, 1, 0⟩, ⟨30, 2, 0⟩, ⟨60, 1, 0⟩, ⟨60, 2, 0⟩, ⟨90, 2, 0⟩],
   [⟨100, 1, 0⟩, ⟨50, 1, 0⟩, ⟨110, 1, 0⟩, ⟨160, 1, 0⟩],
   [⟨0, 1, 0⟩, ⟨59, 1, 0⟩, ⟨118, 1, 0⟩],
   [⟨0, 1, 0⟩, ⟨60, 1, 0⟩, ⟨61, 1, 1⟩, ⟨120, 1, 1⟩, ⟨121, 1, 1⟩],
   [⟨0, 1, 0⟩, ⟨60, 2, 0⟩, ⟨60, 1, 1⟩, ⟨120, 2, 0⟩, ⟨120, 1, 1⟩],
   [⟨0, 1, 0⟩, ⟨0, 1, 1⟩, ⟨0, 1, 2⟩, ⟨60, 1, 2⟩, ⟨60, 1, 0⟩]]

/-- A half-second count as a JSON number of seconds. -/
def secondsJson (halfSeconds : Nat) : String :=
  if halfSeconds % 2 = 0 then toString (halfSeconds / 2) else toString (halfSeconds / 2) ++ ".5"

/-- Head 0 is "A", 1 is "B", 2 is "C". -/
def headJson (headRefOid : Nat) : String := "\"" ++ String.singleton (Char.ofNat (65 + headRefOid)) ++ "\""

-- One JSON object per line after `VECTOR `. A `calls` entry is `[now, pr, head]`.
#eval do
  for (interval, failures) in backoffVectors do
    let expect :=
      if failures = 0 then secondsJson (queryBackoffHalfSeconds interval 0)
      else toString (queryBackoffSeconds interval failures)
    IO.println ("VECTOR {\"fn\":\"queryBackoffSeconds\",\"interval\":" ++ toString interval
      ++ ",\"failures\":" ++ toString failures ++ ",\"expect\":" ++ expect ++ "}")
  for calls in confirmVectors do
    let callsJson := ",".intercalate (calls.map fun (c : Call) =>
      "[" ++ toString c.now ++ "," ++ toString c.pr ++ "," ++ headJson c.headRefOid ++ "]")
    let expect := ",".intercalate ((confirmAll calls).map toString)
    IO.println ("VECTOR {\"fn\":\"noChecksConfirmer\",\"calls\":[" ++ callsJson ++ "],\"expect\":["
      ++ expect ++ "]}")

end WatchPoll
