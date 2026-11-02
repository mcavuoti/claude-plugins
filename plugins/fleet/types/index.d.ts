// fleet's state in $.state (it survives a hot reload of the module, not a restart: what must outlive a restart is in
// the project's .claude/fleet/ files). fleet adds no noun to $: nothing here is for other plugins.

/** A submit that carries a decision's answers and whose turn hasn't started yet: when, and by which copy of the module
 * (a hot reload loses the copy that waited on the submit) */
export type FleetInflight = { at: number; epoch: string }

/** A world file as one thread last read it (or wrote it): the version, when, and the newest version it was told of */
export type FleetRead = { v: string; at: number; told?: string }

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
      /** The version each thread's write of a path was refused at once already (the gate tells once): thread → path */
      warned: Record<string, Record<string, string>>
    }
  }
}
