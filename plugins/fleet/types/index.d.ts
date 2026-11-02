// fleet's state in $.state (it survives a hot reload of the module, not a restart: what must outlive a restart is in
// the project's .claude/fleet/ files). fleet adds no noun to $: nothing here is for other plugins.

/** A submit that carries a decision's answers and whose turn hasn't started yet: when, and by which copy of the module
 * (a hot reload loses the copy that waited on the submit) */
export type FleetInflight = { at: number; epoch: string }

/** Notes the person added to answers already on their way to this session's model (closeNow found them newer than
 * the delivery's read): delivered once, on their own; sent: their submit, while its turn hasn't started */
export type FleetLate = { notes: { q: number; question: string; text: string }[]; at: number; sent?: FleetInflight }

/** A Bash command run in the background (run_in_background, or moved there), until it completes: its thread, when it
 * started, and the world as it was then (path, time, size), to compare with when it's done */
export type FleetBg = { thread: string; at: number; before: [string, number, number][] }

/** A world file as one thread last read it (or wrote it): the version, when, and the newest version it was told of;
 * for a record, the version number fleet gave what it read */
export type FleetRead = { v: string; at: number; told?: string; rev?: number }

/** The outside content this conversation read (a web page, an outside service's result): when, and what it was */
export type FleetMark = { at: number; what: string }

declare module 'claude-code' {
  interface PluginState {
    fleet: {
      /** The questions nobody answered yet in this project (the band) */
      held: number
      /** The decisions this session asked and that aren't closed: id → how many questions */
      open: Record<string, number>
      /** The decisions whose answers were submitted and whose turn hasn't started */
      inflight: Record<string, FleetInflight>
      /** A submit was refused after an Esc: nothing more is submitted until the person types here */
      stopped: boolean
      /** After a submit that failed, when to try again */
      retryAt: number
      /** A turn of the main loop is running, and since when the session is idle */
      busy: boolean
      idleSince: number
      /** The numbering of the last /fleet listing shown in this session: "D-<n>.<question>" per number */
      listing: string[]
      /** The section fleet last put this session in ('fleet:asking', 'none'; '' not known yet) */
      section: string
      /** What each thread of this session read of the world: 'main' or a helper's agentId → path → the read */
      reads: Record<string, Record<string, FleetRead>>
      /** What the gate told each thread once already: thread → path → the version it was refused at; 'pins:<path>'
       * → the pin problems it was told (one per line); 'copy:<path>' → 'told' (a write of a worktree's copy, once) */
      warned: Record<string, Record<string, string>>
      /** What the band counts besides the questions: the project's suspect files and files failing a check */
      flags: number
      /** What this session's model was told about the files it owns (suspects, failed checks): key → when */
      ownTold: Record<string, number>
      /** The band's count of the roster's instances over their budget today */
      overBudget: number
      /** The short id this session's seed was submitted for (an instance is seeded once per session) */
      seedSent: string
      /** The budget state this instance's model was told of: "<day>|<warn|over>" */
      budgetTold: string
      /** When this instance's fleet submitted a nudge whose turn hasn't started yet (0: none) */
      nudgeAt: number
      /** This conversation read outside content (until /clear; kept through compaction and a restart): it can still do
       * everything, but a change it files waits for the person's apply */
      outside: FleetMark | null
      /** The person typed the prompt of the main thread's running turn, or into it: the turn, the start of his words,
       * and his words (up to 4,000 characters: what a taste recorded in the turn must be found in) */
      personTurn: { turnId: string; quoted: string; text?: string } | null
      /** Fleet's own prompt started the main thread's running turn to deliver the person's answers: the words of his it
       * carries (text answers, notes, reject reasons, why he dropped or overruled), which a taste may quote */
      fleetTurn: { turnId: string; words: string } | null
      /** The person's prompt that is about to start a turn (prompt.submit comes before turn.start) */
      pendingPerson: { text: string; at: number } | null
      /** Main-thread turns started in this process (a background session's first prompt can be its launch prompt) */
      turns: number
      /** When this conversation started (the session's start, or its last /clear): its period, for fresh periods */
      conversationAt: number
      /** When this session last landed something in the shared world (an instance's cadence) */
      landedAt: number
      /** When fleet last cleared this instance for a fresh period (0: never) */
      freshAt: number
      /** That fresh period's hand-off (its journal), until a turn carrying it starts: a dropped one is submitted again */
      handoff: { text: string; at: number } | null
      /** What the band says besides its counts: nobody sweeps, the world too big to scan ('' for nothing) */
      bandNote: string
      /** The intake records routed to this instance that its model was told of: id → when (first told) */
      intakeTold: Record<string, number>
      /** The intake records the conversation a /clear ended was told of: the new one hears them once more */
      intakeAgain: string[]
      /** The slot leases this session's model was told it holds: "<slot>/<n>/<taken at>" → when (0: held from before
       * a /clear, not told in this conversation yet) */
      slotTold: Record<string, number>
      /** The slots this session waits in line for */
      slotWait: string[]
      /** The person's overrules of a judge's answer to this session, submitted and whose turn hasn't started */
      overruling: Record<string, FleetInflight>
      /** The person's notes that came after this session's answers were on their way: decision id → them */
      lateNotes: Record<string, FleetLate>
      /** This session's Bash commands running in the background: task id → them */
      bgCommands: Record<string, FleetBg>
    }
  }
}
