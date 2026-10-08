---- MODULE PiScheduler ----
(* The Pi wakeup and /loop scheduler: one pending wakeup, one fixed-interval
   loop and one self-paced loop per session, and the `sealed` flag that stops
   a run the user cut off from re-arming the loop.

   Source followed:
     plugins/pstack/pi/schedule.ts:23-93    class Scheduler
     plugins/pstack/pi/schedule.ts:131-226  registerSchedule: the
                                            schedule_wakeup tool, the
                                            agent_start and agent_settled
                                            handlers, /loop
     plugins/pstack/pi/index.ts:29-34       session_shutdown calls stopAll()

   One Node.js event loop runs every task to completion, so each action below
   is one task: a timer callback, a tool call, a command handler, an event
   handler. There is no lock and no program counter per thread. The state a
   thread model would keep in a pc is in `run` (the session's run) and in the
   timer tables.

   A wakeup that finds the session busy re-arms itself (schedule.ts:49-52).
   It waits in `wtimer` as "armed" or "due" and only its own timer wakes it.
   The user can always type another command, so a wakeup that is dropped while
   it waits never shows as a TLC deadlock. It shows as a violation of the
   liveness property WakeupDelivered.

   Assumptions. The code does not guarantee these; the Pi host or Node does.
   A1  clearTimeout and clearInterval stop a timer whose delay has passed but
       whose callback has not started (Node's timer lists).
   A2  schedule_wakeup runs only while a run is active, and the active run is
       the only caller.
   A3  ctx.isIdle() is false exactly while a run is active or a manual
       compaction is in progress (Pi 1.0.0, agent-session.js:1038-1039).
   A4  Every active run ends, and Pi then clears the run and calls the
       agent_settled handler with no timer or input task between the two
       (agent-session.js:671-677, 1369-1377).
   A5  Not one-shot mode: oneShot.exits(ctx) is false, so schedule.ts:155-157
       and 199-202 are not modelled.
   A6  A wakeup or loop prompt is plain text or "/loop <prompt>". A prompt
       that is itself "/loop stop" or "/loop 5m ..." is not modelled.
   A7  No scheduler call follows session_shutdown.
   A8  Strong fairness, for WakeupDelivered only: the session is idle at some
       expiry of the wakeup's timer, and the callback then runs before a new
       run starts. In real time: the session stays idle for IDLE_RETRY_MS.
       Weak fairness is not enough. The mutation "only weak fairness" in
       PiScheduler.mutations gives the starvation trace.
   A9  Pi emits agent_start to extensions in the same task chain that sets
       its run-active flag (agent-session.js:1352, then pi-agent-core
       agent-loop.js:50 before any model call), and agent_settled follows
       every run, aborted or failed (the finally at agent-session.js:1369-
       1377). So the extension's `running` flag is TRUE exactly while
       run = "active", and no schedule_wakeup call precedes agent_start.

   Three constants switch on host behaviour that the comments in schedule.ts
   assume away. With all three FALSE every property holds.
   CompactCmd  the user can run /loop while a manual compaction is in
               progress (Pi interactive-mode.js:2652-2658 does this).
   StartGap    a prompt that fire() sends becomes an active run in a later
               task, so isIdle() stays true in between (Pi's prompt() awaits
               hooks before agent-session.js:1352).
   StartRace   another run can start while a /loop start waits in the slot:
               the user types a prompt, or an interval tick lands, before the
               wakeup's next retry. *)
EXTENDS Naturals, FiniteSets

CONSTANTS MaxWakeups, MaxLoops, CompactCmd, StartGap, StartRace

None == 0
W == 1..MaxWakeups   \* one id per scheduleWakeup call, which is one deliver closure
L == 1..MaxLoops     \* one id per startLoop call

VARIABLES
  slot, loop, selfPaced, sealed,   \* Scheduler fields, schedule.ts:24-36
  running,                         \* Scheduler.running: a run is in flight, schedule.ts:36
  wtimer, ltimer,                  \* Node's timers: "off", "armed", or "due" (delay passed, callback not yet run)
  run, compacting, down,           \* the Pi session
  startedBy,                       \* the wakeup whose prompt started the current run, else None
  nextW, nextL, wby, wkind,        \* next free id; who scheduled each wakeup ("cmd": /loop during a run,
                                   \* "compact": /loop during a compaction) and what its prompt is
  fired, cancelled,                \* history: wakeups delivered; wakeups cancelled or replaced
  cut,                             \* history: the user ran /loop while the current run was in flight
  quiet,                           \* history: the last /loop was "stop" and no run was in flight
  refusedFresh, startStolen        \* history: a run that was not cut was refused; a run cancelled a /loop start

slotVars == <<slot, wtimer, nextW, wby, wkind, cancelled>>
loopVars == <<loop, ltimer, nextL>>
session == <<run, compacting, down, startedBy>>
history == <<fired, cut, quiet, refusedFresh, startStolen>>
vars == <<slotVars, loopVars, selfPaced, sealed, running, session, history>>

Init == /\ slot = None /\ loop = None /\ selfPaced = FALSE /\ sealed = FALSE /\ running = FALSE
        /\ wtimer = [w \in W |-> "off"] /\ ltimer = [l \in L |-> "off"]
        /\ run = "none" /\ compacting = FALSE /\ down = FALSE /\ startedBy = None
        /\ nextW = 1 /\ nextL = 1
        /\ wby = [w \in W |-> "tool"] /\ wkind = [w \in W |-> "plain"]
        /\ fired = {} /\ cancelled = {}
        /\ cut = FALSE /\ quiet = FALSE /\ refusedFresh = FALSE /\ startStolen = FALSE

Idle == run # "active" /\ ~compacting                  \* ctx.isIdle()
Started == IF StartGap THEN "transit" ELSE "active"    \* the run state after fire() on an idle session
Pending == IF slot = None THEN {} ELSE {slot}
StartPending == slot # None /\ wby[slot] # "tool"      \* a /loop start waits in the slot
LiveW == {w \in W : wtimer[w] # "off"}
LiveL == {l \in L : ltimer[l] # "off"}

\* clearTimeout(this.wakeup), schedule.ts:62, and clearInterval(this.loop), :75.
Cleared == [w \in W |-> IF w = slot THEN "off" ELSE wtimer[w]]
StoppedLoop == [l \in L |-> IF l = loop THEN "off" ELSE ltimer[l]]

\* cancelWakeup, schedule.ts:60-65.
Cancel == /\ wtimer' = Cleared /\ slot' = None
          /\ cancelled' = cancelled \cup Pending
          /\ UNCHANGED <<nextW, wby, wkind>>

\* scheduleWakeup, schedule.ts:44-58: cancel, arm a new timer, keep its handle.
Arm(by, kind) ==
  /\ nextW <= MaxWakeups
  /\ wtimer' = [Cleared EXCEPT ![nextW] = "armed"]
  /\ slot' = nextW /\ nextW' = nextW + 1
  /\ wby' = [wby EXCEPT ![nextW] = by] /\ wkind' = [wkind EXCEPT ![nextW] = kind]
  /\ cancelled' = cancelled \cup Pending

\* stopLoop, schedule.ts:73-78, and startLoop after it, :67-71.
StopLoop == ltimer' = StoppedLoop /\ loop' = None /\ UNCHANGED nextL
StartLoop == /\ nextL <= MaxLoops
             /\ ltimer' = [StoppedLoop EXCEPT ![nextL] = "armed"]
             /\ loop' = nextL /\ nextL' = nextL + 1

\* fire, schedule.ts:40-42, on an idle session. With no gap the run is active
\* at once and Pi emits agent_start (A9), schedule.ts:169-171.
Fire(by) == run' = Started /\ running' = (Started = "active") /\ startedBy' = by

\* The user types /loop stop, /loop <interval> <prompt> ("fixed") or
\* /loop <prompt> ("dynamic"): schedule.ts:181-224. The first prompt waits
\* whenever the session is not idle; the seal needs a run in flight.
Cmd(c) ==
  LET midRun == ~Idle IN                                               \* :183
  /\ ~down
  /\ compacting => CompactCmd
  /\ sealed' = (sealed \/ running)                                     \* :90, :209
  /\ selfPaced' = (c = "dynamic")                                      \* :89, :81
  /\ IF c = "fixed" THEN StartLoop ELSE StopLoop                       \* :91, :214
  /\ IF c # "stop" /\ midRun THEN Arm(IF running THEN "cmd" ELSE "compact", "plain") ELSE Cancel  \* :87, :190-191
  /\ IF c # "stop" /\ ~midRun THEN Fire(None) ELSE UNCHANGED <<run, running, startedBy>>  \* :195-197
  \* A start that lands in the StartGap window sends its first prompt into the
  \* run in transit. That run's re-arm may then be the new loop's own, so only
  \* a stop marks the run in transit as cut.
  /\ cut' = (cut \/ run = "active" \/ (run = "transit" /\ c = "stop"))
  /\ quiet' = (c = "stop" /\ run = "none")
  /\ UNCHANGED <<compacting, down, fired, refusedFresh, startStolen>>

\* The active run calls schedule_wakeup with a delay and a prompt: schedule.ts:145-165.
ToolSchedule(kind) ==
  LET refused == sealed IN                                             \* :148
  /\ run = "active" /\ ~down
  /\ IF refused
       THEN /\ refusedFresh' = (refusedFresh \/ ~cut)
            /\ UNCHANGED <<slotVars, startStolen>>
       ELSE /\ Arm("tool", kind)                                       \* :159
            /\ startStolen' = (startStolen \/ StartPending)
            /\ UNCHANGED refusedFresh
  /\ UNCHANGED <<loopVars, selfPaced, sealed, running, session, fired, cut, quiet>>

\* The active run calls schedule_wakeup with stop: true: schedule.ts:139-144.
ToolStop ==
  LET guarded == sealed IN                                             \* :141
  /\ run = "active" /\ ~down
  /\ IF guarded
       THEN /\ refusedFresh' = (refusedFresh \/ (~cut /\ slot # None))
            /\ UNCHANGED <<slotVars, startStolen>>
       ELSE /\ Cancel
            /\ startStolen' = (startStolen \/ StartPending)
            /\ UNCHANGED refusedFresh
  /\ UNCHANGED <<loopVars, selfPaced, sealed, running, session, fired, cut, quiet>>

\* Node: the wakeup timer's delay passes and its callback is queued.
Expire(w) ==
  /\ ~down /\ wtimer[w] = "armed"
  /\ wtimer' = [wtimer EXCEPT ![w] = "due"]
  /\ UNCHANGED <<slot, nextW, wby, wkind, cancelled, loopVars, selfPaced, sealed, running, session, history>>

\* deliver on a busy session, schedule.ts:49-52: re-arm and keep the new handle.
Retry(w) ==
  /\ ~down /\ wtimer[w] = "due" /\ ~Idle
  /\ wtimer' = [wtimer EXCEPT ![w] = "armed"]
  /\ slot' = w
  /\ UNCHANGED <<nextW, wby, wkind, cancelled, loopVars, selfPaced, sealed, running, session, history>>

\* deliver on an idle session, schedule.ts:53-54. A "/loop <prompt>" prompt is
\* the self-paced re-arm: Pi runs the /loop handler in place, :219-222.
DeliverFire(w) ==
  /\ ~down /\ wtimer[w] = "due" /\ Idle
  /\ wtimer' = [wtimer EXCEPT ![w] = "off"]
  /\ slot' = None
  /\ fired' = fired \cup {w}
  /\ Fire(w)
  /\ IF wkind[w] = "loop" THEN selfPaced' = TRUE /\ StopLoop
                          ELSE UNCHANGED <<selfPaced, loopVars>>
  /\ quiet' = FALSE
  /\ UNCHANGED <<nextW, wby, wkind, cancelled, sealed, compacting, down, cut, refusedFresh, startStolen>>

\* Node: the interval's delay passes; then its callback, schedule.ts:69, which
\* fires on an idle session and drops the tick on a busy one.
LExpire(l) ==
  /\ ~down /\ ltimer[l] = "armed"
  /\ ltimer' = [ltimer EXCEPT ![l] = "due"]
  /\ UNCHANGED <<loop, nextL, slotVars, selfPaced, sealed, running, session, history>>

TickFire(l) ==
  /\ ~down /\ ltimer[l] = "due" /\ Idle
  /\ StartRace \/ ~StartPending
  /\ ltimer' = [ltimer EXCEPT ![l] = "armed"]
  /\ Fire(None)
  /\ quiet' = FALSE
  /\ UNCHANGED <<loop, nextL, slotVars, selfPaced, sealed, compacting, down, fired, cut, refusedFresh, startStolen>>

TickDrop(l) ==
  /\ ~down /\ ltimer[l] = "due" /\ ~Idle
  /\ ltimer' = [ltimer EXCEPT ![l] = "armed"]
  /\ UNCHANGED <<loop, nextL, slotVars, selfPaced, sealed, running, session, history>>

\* The user types a prompt on an idle session.
UserPrompt ==
  /\ ~down /\ run = "none" /\ ~compacting
  /\ StartRace \/ ~StartPending
  /\ Fire(None)
  /\ quiet' = FALSE
  /\ UNCHANGED <<slotVars, loopVars, selfPaced, sealed, compacting, down, fired, cut, refusedFresh, startStolen>>

\* With StartGap: the prompt in transit becomes the active run and Pi emits
\* agent_start: schedule.ts:169-171.
RunStart ==
  /\ ~down /\ run = "transit"
  /\ run' = "active"
  /\ running' = TRUE
  /\ UNCHANGED <<slotVars, loopVars, selfPaced, sealed, compacting, down, startedBy, history>>

\* The run settles and Pi emits agent_settled: schedule.ts:172-175.
RunSettle ==
  /\ ~down /\ run = "active"
  /\ run' = "none" /\ startedBy' = None
  /\ running' = FALSE
  /\ sealed' = FALSE
  /\ cut' = FALSE
  /\ UNCHANGED <<slotVars, loopVars, selfPaced, compacting, down, fired, quiet, refusedFresh, startStolen>>

\* Manual compaction. Pi aborts the run first, so none is in flight.
CompactStart ==
  /\ ~down /\ run = "none" /\ ~compacting
  /\ compacting' = TRUE
  /\ UNCHANGED <<slotVars, loopVars, selfPaced, sealed, running, run, down, startedBy, history>>

CompactEnd ==
  /\ ~down /\ compacting
  /\ compacting' = FALSE
  /\ UNCHANGED <<slotVars, loopVars, selfPaced, sealed, running, run, down, startedBy, history>>

\* session_shutdown: stopAll() with midRun false, index.ts:29-34.
Shutdown ==
  /\ ~down
  /\ down' = TRUE
  /\ Cancel /\ StopLoop
  /\ selfPaced' = FALSE
  /\ UNCHANGED <<sealed, running, run, compacting, startedBy, history>>

\* Stutter after shutdown so that the end is not reported as a deadlock.
Done == down /\ UNCHANGED vars

Next == \/ \E c \in {"stop", "fixed", "dynamic"} : Cmd(c)
        \/ \E k \in {"plain", "loop"} : ToolSchedule(k)
        \/ ToolStop
        \/ \E w \in W : Expire(w) \/ Retry(w) \/ DeliverFire(w)
        \/ \E l \in L : LExpire(l) \/ TickFire(l) \/ TickDrop(l)
        \/ UserPrompt \/ RunStart \/ RunSettle
        \/ CompactStart \/ CompactEnd \/ Shutdown \/ Done

\* Runs start and end and compaction ends. No fairness on anything the user or
\* the agent chooses to do. The two strong conjuncts are assumption A8.
Fairness == /\ WF_vars(RunStart) /\ WF_vars(RunSettle) /\ WF_vars(CompactEnd)
            /\ \A w \in W : /\ WF_vars(Retry(w))
                            /\ SF_vars(Idle /\ Expire(w))
                            /\ SF_vars(DeliverFire(w))

Spec == Init /\ [][Next]_vars /\ Fairness

TypeOK ==
  /\ slot \in W \cup {None} /\ loop \in L \cup {None}
  /\ selfPaced \in BOOLEAN /\ sealed \in BOOLEAN /\ running \in BOOLEAN
  /\ wtimer \in [W -> {"off", "armed", "due"}] /\ ltimer \in [L -> {"off", "armed", "due"}]
  /\ run \in {"none", "transit", "active"} /\ (run = "transit" => StartGap)
  /\ running = (run = "active")                                        \* A9
  /\ compacting \in BOOLEAN /\ down \in BOOLEAN
  /\ startedBy \in W \cup {None} /\ (run = "none" => startedBy = None)
  /\ nextW \in 1..(MaxWakeups + 1) /\ nextL \in 1..(MaxLoops + 1)
  /\ wby \in [W -> {"tool", "cmd", "compact"}] /\ wkind \in [W -> {"plain", "loop"}]
  /\ fired \subseteq W /\ cancelled \subseteq W
  /\ cut \in BOOLEAN /\ quiet \in BOOLEAN
  /\ refusedFresh \in BOOLEAN /\ startStolen \in BOOLEAN

\* (1) At most one wakeup timer is alive.
OneWakeup == Cardinality(LiveW) <= 1
\* Ownership: a timer is alive exactly when the Scheduler field holds its handle.
TimersOwned == LiveW = Pending /\ LiveL = (IF loop = None THEN {} ELSE {loop})
\* (2) A wakeup that was cancelled or replaced never delivers its prompt.
NoCancelledDelivery == fired \cap cancelled = {}
\* (3) A run the user cut off with /loop never has a wakeup of its own pending.
NoRearmByCutRun == cut => (slot = None \/ wby[slot] = "cmd")
\* (3) sealed is set only against a run that /loop cut off, and is clear once that run settles...
SealedOnlyAgainstCutRun == sealed => (run = "active" /\ cut)
\* ...so a run that started after the /loop command is never refused.
FreshRunNotRefused == ~refusedFresh
\* The /loop start that waits in the slot is cancelled only by /loop or shutdown, never by a run.
StartSurvivesRuns == ~startStolen
\* The fixed loop and the self-paced loop are never both live.
OneLoopKind == ~(loop # None /\ selfPaced)
\* (5), terminal state: after /loop stop with no run in flight, and after
\* shutdown, no timer is pending and no loop is live.
Terminal == slot = None /\ loop = None /\ ~selfPaced /\ LiveW = {} /\ LiveL = {}
StoppedIsTerminal == (quiet \/ down) => Terminal
\* (4) The wakeup path delivers only to an idle session.
IdleDelivery == [][fired' # fired => Idle]_vars
\* (5) After /loop stop with no run in flight, nothing fires again.
Fires == fired' # fired \/ \E l \in L : TickFire(l)
NothingFiresAfterStop == [][quiet => ~Fires]_vars
\* (6) A pending wakeup is delivered unless it is cancelled or replaced.
WakeupDelivered == \A w \in W : (wtimer[w] # "off") ~> (w \in fired \/ w \in cancelled)

\* Reachable states the properties depend on (reach lines in PiScheduler.matrix).
ParkedWakeup == \E w \in W : wtimer[w] = "due" /\ ~Idle            \* a due wakeup waits for idle
DueWhileIdle == \E w \in W : wtimer[w] = "due" /\ Idle             \* a stop can land before the callback
TickWhileBusy == \E l \in L : ltimer[l] = "due" /\ ~Idle           \* a tick about to be dropped
StartBehindCutRun == sealed /\ cut /\ StartPending                 \* a /loop start waits behind the run it cut
LoopAndWakeup == loop # None /\ slot # None                        \* the interval and a wakeup both alive
SelfPacedRearm == selfPaced /\ slot # None /\ wkind[slot] = "loop" \* the self-paced loop's own re-arm pending
StoppedAfterDelivery == quiet /\ fired # {}                        \* /loop stop on an idle session that had fired
ShutdownCancelled == down /\ cancelled # {}                        \* shutdown cancelled a pending wakeup
AllDelivered == W # {} /\ fired = W                                \* every wakeup the bound allows was delivered
\* The consequence of each finding on the host that allows it.
\* CompactCmd: a self-paced loop started during a compaction is in its first
\* iteration and that run's own re-arm is pending.
CompactionLoopRearmed == SelfPacedRearm /\ startedBy # None /\ wby[startedBy] = "compact"
\* StartGap: a wakeup fired, the user stopped the loop, and the run re-armed it.
StoppedLoopRearmed == cut /\ fired # {} /\ slot # None /\ wby[slot] = "tool" /\ wkind[slot] = "loop"
====
