---- MODULE OrchStoreLock ----
(* The pid lock of the orch store, as N writer processes run it.

   Source: plugins/pstack/skills/poteto-mode/scripts/orch/store.ts
     holderIsDead                        lines 381-392
     acquireLock                         lines 394-540
       create                            lines 406-419
       lockOrHolder                      lines 424-442
       claimed                           lines 451-479
       takeOver                          lines 481-504
       the release function it returns   lines 521-539
     openStore: ensureLock, beginWrite   lines 1352-1378
     openStore: close                    lines 1729-1746
   and plugins/pstack/skills/poteto-mode/scripts/orch/orch.ts lines 219-240,
   where one CLI process opens the store, runs one operation and closes it.

   Each action is one filesystem call, labelled with its line. A writer never
   waits for the lock: a writer that cannot get it ends at "failed", which is
   the UserError of lines 486, 496, 500 or 515. The release does wait for the
   claim: it stages a new one (line 533) until the claimant finishes or dies.
   Crash stops a writer at any step and leaves its files in place. A crash is
   the only way to leave a step without running the finally blocks of lines
   417 and 474-477.

   `lock` is the lock file's actual owner. `got` is each writer's belief that
   it holds the lock. The two can differ, and the properties compare them.

   Assumptions the code does not guarantee:
   - A pid is never reused. A dead writer's pid stays dead, and no live
     process carries a pid found in a stale lock or claim.
   - process.kill(pid, 0) reports ESRCH exactly for a dead writer. A writer
     of another user (EPERM) counts as live, as in line 390.
   - Each filesystem call is atomic and every writer sees its effect at once,
     as on a local POSIX filesystem. NFS and other caching filesystems are
     outside the model.
   - rename replaces an empty directory and fails with ENOTEMPTY or EEXIST on
     one that holds a file (POSIX). The mutations file shows that property
     LateWriterAcquires depends on the first half.
   - With HardLinks = FALSE, link always fails with a code other than EEXIST
     and line 415 runs as two steps: the exclusive open, then the write.
   - No call fails for a reason outside the protocol (EACCES, ENOSPC, EIO).
   - Each process calls acquireLock once and opens one store on the directory.
     orch.ts does this. openStore itself lets a failed write retry (line 1365).
   - The randomUUID names of lines 407 and 452 never collide.
   - A live claimant keeps running. A claimant stopped for good (SIGSTOP)
     would hold the release in its retry loop; weak fairness rules that out.

   Merged steps. Lines 455 and 457 touch only the private staged directory
   and are one step. The liveness test and the rm of lines 459-460 are one
   step: a dead pid stays dead, so the test cannot go stale before the rm.
   The comparisons of lines 485 and 524 are part of the read that feeds them.

   `stolen` is a ghost variable: the owners of the locks that a takeover
   removed while the lock still named the holder it was called for. Such a
   writer was reported through onStaleLock or onLockStolen (lines 509, 512). *)
EXTENDS Naturals, FiniteSets

CONSTANTS Procs,      \* the writer pids
          Forcers,    \* the writers run with --force (options.force)
          HardLinks   \* FALSE: the filesystem has no hard links (line 415)

NoPid == "none"         \* no lock file; no holder read yet
Unknown == "unknown"    \* the text read from an empty or vanished lock

VARIABLES lock, blank,         \* .orch.lock: its creator, and whether it is still empty
          tdir, claimants,     \* .orch.lock.takeover: exists, and the pid files in it
          pidfile, staged,     \* the writers whose private pid file / staged directory exists
          pc, holder, retries, seen, got, closing,
          dead, stolen

lockfile == <<lock, blank>>
claim == <<tdir, claimants>>
temps == <<pidfile, staged>>
locals == <<holder, retries, seen, got, closing>>
env == <<dead, stolen>>
vars == <<lockfile, claim, temps, pc, locals, env>>

Init == /\ lock = NoPid /\ blank = FALSE
        /\ tdir = FALSE /\ claimants = {}
        /\ pidfile = {} /\ staged = {}
        /\ pc = [p \in Procs |-> "mkpid"]
        /\ holder = [p \in Procs |-> NoPid]
        /\ retries = [p \in Procs |-> 2]
        /\ seen = [p \in Procs |-> {}]
        /\ got = [p \in Procs |-> FALSE]
        /\ closing = [p \in Procs |-> FALSE]
        /\ dead = {} /\ stolen = {}

At(p, label) == p \notin dead /\ pc[p] = label
Goto(p, label) == pc' = [pc EXCEPT ![p] = label]
\* What readFile returns for a lock file that exists (lines 435, 474).
LockText == IF blank THEN Unknown ELSE lock
\* takeOver is running: its holder argument is set.
InTake(p) == holder[p] # NoPid
\* takeOver enters lockOrHolder with a fresh retry count (line 494).
StartCreate(p) == Goto(p, "mkpid") /\ retries' = [retries EXCEPT ![p] = 2]

\* create, line 408: write the private pid file.
MkPid(p) == /\ At(p, "mkpid")
            /\ pidfile' = pidfile \cup {p}
            /\ Goto(p, "link")
            /\ UNCHANGED <<lockfile, claim, staged, locals, env>>

\* create, line 410: link the pid file into place, or line 415: open the
\* lock exclusively. Both fail with EEXIST when the lock exists.
Link(p) == /\ At(p, "link")
           /\ IF lock # NoPid
                THEN Goto(p, "rmpid") /\ UNCHANGED <<lockfile, got>>
                ELSE /\ lock' = p
                     /\ blank' = ~HardLinks
                     /\ got' = [got EXCEPT ![p] = TRUE]
                     /\ Goto(p, IF HardLinks THEN "rmpid" ELSE "write")
           /\ UNCHANGED <<claim, temps, holder, retries, seen, closing, env>>

\* create, line 415 after the open: write the pid through the open file. The
\* write reaches the lock only if the lock is still the file this writer made.
Write(p) == /\ At(p, "write")
            /\ blank' = (blank /\ lock # p)
            /\ Goto(p, "rmpid")
            /\ UNCHANGED <<lock, claim, temps, locals, env>>

\* create, line 417: unlink the pid file. Then lockOrHolder returns null
\* (line 428) or goes on to read the lock.
RmPid(p) == /\ At(p, "rmpid")
            /\ pidfile' = pidfile \ {p}
            /\ Goto(p, IF ~got[p] THEN "read" ELSE IF InTake(p) THEN "unclaim" ELSE "held")
            /\ UNCHANGED <<lockfile, claim, staged, locals, env>>

\* lockOrHolder, lines 435-439: read the lock. ENOENT retries create twice.
\* In acquireLock the text is the holder (line 506); in takeOver any text is
\* a blocker (lines 494-496).
Read(p) == /\ At(p, "read")
           /\ IF lock = NoPid /\ retries[p] > 0
                THEN /\ retries' = [retries EXCEPT ![p] = @ - 1]
                     /\ Goto(p, "mkpid")
                     /\ UNCHANGED holder
                ELSE /\ IF InTake(p)
                          THEN Goto(p, "unclaim") /\ UNCHANGED holder
                          ELSE /\ holder' = [holder EXCEPT ![p] = IF lock = NoPid THEN Unknown ELSE LockText]
                               /\ Goto(p, "judge")
                     /\ UNCHANGED retries
           /\ UNCHANGED <<lockfile, claim, temps, seen, got, closing, env>>

\* acquireLock, lines 507-516: take over a dead holder's lock, or any lock
\* with --force; otherwise fail.
Judge(p) == /\ At(p, "judge")
            /\ Goto(p, IF holder[p] \in dead \/ p \in Forcers THEN "mkstaged" ELSE "failed")
            /\ UNCHANGED <<lockfile, claim, temps, locals, env>>

\* claimed, lines 455-457: make the staged directory and its pid file.
MkStaged(p) == /\ At(p, "mkstaged")
               /\ staged' = staged \cup {p}
               /\ Goto(p, "readdir")
               /\ UNCHANGED <<lockfile, claim, pidfile, locals, env>>

\* claimed, line 458: list the claimants.
ReadDir(p) == /\ At(p, "readdir")
              /\ seen' = [seen EXCEPT ![p] = claimants]
              /\ Goto(p, IF claimants = {} THEN "rename" ELSE "sweep")
              /\ UNCHANGED <<lockfile, claim, temps, holder, retries, got, closing, env>>

\* claimed, lines 459-460: remove one listed claimant's file if it is dead.
Sweep(p) == /\ At(p, "sweep")
            /\ \E c \in seen[p]:
                 /\ seen' = [seen EXCEPT ![p] = @ \ {c}]
                 /\ claimants' = IF c \in dead THEN claimants \ {c} ELSE claimants
                 /\ Goto(p, IF seen[p] = {c} THEN "rename" ELSE "sweep")
            /\ UNCHANGED <<lockfile, tdir, temps, holder, retries, got, closing, env>>

\* claimed, line 463: rename the staged directory onto the takeover
\* directory. It fails when that directory holds a file (lines 464-470).
Rename(p) == /\ At(p, "rename")
             /\ IF claimants = {}
                  THEN /\ tdir' = TRUE
                       /\ claimants' = {p}
                       /\ staged' = staged \ {p}
                       /\ Goto(p, IF closing[p] THEN "relread" ELSE "reread")
                  ELSE Goto(p, "busy") /\ UNCHANGED <<claim, staged>>
             /\ UNCHANGED <<lockfile, pidfile, locals, env>>

\* takeOver, lines 484-486: read the lock again behind the claim.
Reread(p) == /\ At(p, "reread")
             /\ IF lock = NoPid
                  THEN StartCreate(p)
                  ELSE /\ Goto(p, IF LockText = holder[p] THEN "unlink" ELSE "unclaim")
                       /\ UNCHANGED retries
             /\ UNCHANGED <<lockfile, claim, temps, holder, seen, got, closing, env>>

\* takeOver, line 488: unlink the lock, whatever it holds by now.
TUnlink(p) == /\ At(p, "unlink")
              /\ stolen' = IF lock # NoPid /\ LockText = holder[p] THEN stolen \cup {lock} ELSE stolen
              /\ lock' = NoPid
              /\ blank' = FALSE
              /\ StartCreate(p)
              /\ UNCHANGED <<claim, temps, holder, seen, got, closing, dead>>

\* claimed, line 475: rename the takeover directory back to the staged path.
Unclaim(p) == /\ At(p, "unclaim")
              /\ IF tdir
                   THEN tdir' = FALSE /\ claimants' = {} /\ staged' = staged \cup {p}
                   ELSE UNCHANGED <<claim, staged>>
              /\ Goto(p, "discard")
              /\ UNCHANGED <<lockfile, pidfile, locals, env>>

\* claimed, lines 465 and 476: remove the staged directory. A refused claim
\* ends takeOver (line 500) but makes the release try again (line 533).
Discard(p) == /\ p \notin dead
              /\ pc[p] \in {"busy", "discard"}
              /\ staged' = staged \ {p}
              /\ Goto(p, IF closing[p]
                           THEN IF pc[p] = "busy" THEN "mkstaged" ELSE "released"
                           ELSE IF got[p] THEN "held" ELSE "failed")
              /\ UNCHANGED <<lockfile, claim, pidfile, locals, env>>

\* store.close, lines 1729-1745: the holder chooses when to release. The
\* release runs behind the claim, so it starts by staging one (line 534).
Close(p) == /\ At(p, "held")
            /\ closing' = [closing EXCEPT ![p] = TRUE]
            /\ Goto(p, "mkstaged")
            /\ UNCHANGED <<lockfile, claim, temps, holder, retries, seen, got, env>>

\* release, line 524: read the lock and compare it with the own pid.
RelRead(p) == /\ At(p, "relread")
              /\ IF lock = p /\ ~blank
                   THEN Goto(p, "relunlink") /\ UNCHANGED got
                   ELSE Goto(p, "unclaim") /\ got' = [got EXCEPT ![p] = FALSE]
              /\ UNCHANGED <<lockfile, claim, temps, holder, retries, seen, closing, env>>

\* release, line 525: unlink the lock, whatever it holds by now.
RelUnlink(p) == /\ At(p, "relunlink")
                /\ lock' = NoPid
                /\ blank' = FALSE
                /\ got' = [got EXCEPT ![p] = FALSE]
                /\ Goto(p, "unclaim")
                /\ UNCHANGED <<claim, temps, holder, retries, seen, closing, env>>

\* The process dies. Its files stay.
Crash(p) == /\ p \notin dead
            /\ pc[p] \notin {"failed", "released"}
            /\ dead' = dead \cup {p}
            /\ UNCHANGED <<lockfile, claim, temps, pc, locals, stolen>>

Step(p) == \/ MkPid(p) \/ Link(p) \/ Write(p) \/ RmPid(p) \/ Read(p) \/ Judge(p)
           \/ MkStaged(p) \/ ReadDir(p) \/ Sweep(p) \/ Rename(p) \/ Reread(p)
           \/ TUnlink(p) \/ Unclaim(p) \/ Discard(p) \/ RelRead(p) \/ RelUnlink(p)

Ended(p) == p \in dead \/ pc[p] \in {"held", "failed", "released"}
\* Stutter at the end so that termination is not reported as a deadlock.
Done == (\A p \in Procs: Ended(p)) /\ UNCHANGED vars

Next == (\E p \in Procs: Step(p) \/ Close(p) \/ Crash(p)) \/ Done

\* Weak fairness on each writer's protocol steps. Close is the holder's
\* choice and Crash is the environment's, so neither is fair.
Spec == Init /\ [][Next]_vars /\ \A p \in Procs: WF_vars(Step(p))

----
TypeOK == /\ lock \in Procs \cup {NoPid}
          /\ blank \in BOOLEAN
          /\ blank => lock # NoPid /\ ~HardLinks
          /\ tdir \in BOOLEAN
          /\ claimants \subseteq Procs
          /\ claimants # {} => tdir
          /\ pidfile \subseteq Procs /\ staged \subseteq Procs
          /\ pc \in [Procs -> {"mkpid", "link", "write", "rmpid", "read", "judge",
                               "mkstaged", "readdir", "sweep", "rename", "busy",
                               "reread", "unlink", "unclaim", "discard", "held",
                               "relread", "relunlink", "released", "failed"}]
          /\ holder \in [Procs -> Procs \cup {NoPid, Unknown}]
          /\ retries \in [Procs -> 0..2]
          /\ seen \in [Procs -> SUBSET Procs]
          /\ got \in [Procs -> BOOLEAN]
          /\ closing \in [Procs -> BOOLEAN]
          /\ dead \subseteq Procs /\ stolen \subseteq Procs

\* The live writers that believe they hold the store lock.
Holders == {p \in Procs \ dead: got[p]}

\* (1) Two live writers never both believe they hold the lock, apart from a
\* writer whose lock a takeover removed by name.
OneHolder == Cardinality(Holders \ stolen) <= 1

\* The lock file names the live writer that believes it holds the lock.
LockNamesHolder == \A p \in Holders \ stolen: lock = p

\* A writer between its claim (line 463) and its release of it (line 475):
\* a takeover replacing the lock, or a release removing its own.
Claiming(p) == \/ InTake(p) /\ pc[p] \in {"reread", "unlink", "mkpid", "link", "write",
                                          "rmpid", "read", "unclaim"}
               \/ closing[p] /\ pc[p] \in {"relread", "relunlink", "unclaim"}
\* The takeover directory holds at most one claim, and it is the claim of
\* each live writer that believes it has one.
ClaimExclusive == /\ Cardinality(claimants) <= 1
                  /\ \A p \in Procs \ dead: Claiming(p) => claimants = {p}

\* A writer that returned from acquireLock or release without crashing left
\* no private file and no claim, and one that holds nothing left no lock.
\* The release's read and unlink run behind its own claim.
NoResidue == \A p \in Procs \ dead:
               /\ pc[p] \in {"held", "relread", "relunlink", "failed", "released"}
                    => p \notin pidfile \cup staged
               /\ pc[p] \in {"held", "failed", "released"} => p \notin claimants
               /\ pc[p] \in {"failed", "released"} => lock # p

Moved(p, from, to) == pc[p] = from /\ pc'[p] = to

\* (2) The unlink of line 488 removes the lock that line 484 read, the lock
\* of the holder takeOver was called for.
TakeoverRemovesNamedLock ==
  [][\A p \in Procs: Moved(p, "unlink", "mkpid") /\ lock # NoPid => LockText = holder[p]]_vars

\* (2) A writer without --force never removes a live writer's lock.
TakeoverSparesLiveHolder ==
  [][\A p \in Procs \ Forcers: Moved(p, "unlink", "mkpid") => lock \in dead \cup {NoPid}]_vars

\* (3) The unlink of line 525 removes only the releasing writer's own lock.
ReleaseRemovesOwnLock ==
  [][\A p \in Procs: Moved(p, "relunlink", "unclaim") => lock \in {p, NoPid}]_vars

\* No writer waits: each one ends holding the lock, failed, released or dead.
Terminates == \A p \in Procs: <>Ended(p)

\* close returns once it is called.
CloseTerminates == \A p \in Procs: closing[p] ~> (pc[p] = "released" \/ p \in dead)

\* A writer that has not started while every other writer is dead or has
\* ended without the lock.
Late(p) == /\ At(p, "mkpid")
           /\ holder[p] = NoPid
           /\ \A q \in Procs \ {p}: q \in dead \/ pc[q] \in {"failed", "released"}

\* (4) Whatever crashed holders and crashed claimants left behind, a later
\* writer acquires the lock unless it crashes too.
LateWriterAcquires == \A p \in Procs: Late(p) ~> (pc[p] = "held" \/ p \in dead)

----
\* States the properties depend on (reach checks in OrchStoreLock.matrix).
StaleLock == lock \in dead /\ ~blank
DeadClaimant == claimants \cap dead # {}
EmptyTakeoverDir == tdir /\ claimants = {}
StaleLockReplaced == \E p \in Procs \ dead: pc[p] = "held" /\ holder[p] \in dead
ClaimRefused == \E p \in Procs \ dead: pc[p] = "busy"
ReleaseBlocked == \E p \in Procs \ dead: closing[p] /\ pc[p] = "busy"
LockVanished == \E p \in Procs \ dead: retries[p] < 2 /\ ~InTake(p)
RetriesExhausted == \E p \in Procs \ dead: retries[p] = 0 /\ holder[p] = Unknown
ReleaseWindow == \E p \in Procs \ dead: pc[p] = "relunlink"
LateWriterMeetsWreck == \E p \in Procs: Late(p) /\ StaleLock /\ DeadClaimant
LateWriterMeetsEmptyDir == \E p \in Procs: Late(p) /\ StaleLock /\ EmptyTakeoverDir
OrphanBlankLock == blank /\ lock \in dead
ForcedSteal == \E p \in Forcers \ dead: pc[p] = "held" /\ holder[p] \in Procs \ dead
====
