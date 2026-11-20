export type QueueItem = {
  repo: string
  number: number
  title: string
  kind: 'new' | 're_review' | 'unknown'
}

export type Queue =
  | { kind: 'ok'; total: number; isNew: number; reReview: number; isComplete: boolean; items: QueueItem[] }
  | { kind: 'error'; reason: string }

/**
 * starting: the review command ran and no subagent has taken it yet; running: a
 * subagent is reviewing; done: the review finished and waits to be posted;
 * failed: the review ended in an error or a refusal; posted: the review was
 * posted, and the line stays until the queue drops it.
 */
export type ReviewStatus = 'starting' | 'running' | 'done' | 'failed' | 'posted'

/** What a running reviewer is doing: in, reading input or waiting on a tool; out, writing. */
export type Activity = 'in' | 'out'

/**
 * A next step the agent offers on a pull request: the one or two palette glyphs
 * its button shows, and the instruction a press sends the agent.
 */
export type Choice = { glyph: string; action: string }

/** A hidden pull request, and the query of the session that hid it (the hash its cache file is named with). */
export type HiddenEntry = { ref: string; query: string }

declare module 'claude-code' {
  interface PluginState {
    'pr-review-queue': {
      isEnabled: boolean
      isExpanded: boolean
      queue: Shaped<Queue | null>
      statuses: Shaped<Record<string, ReviewStatus>>
      agents: Shaped<Record<string, string>>
      /** What each running review's subagent is doing, by PR. */
      activity: Shaped<Record<string, Activity>>
      /** The main turn that runs each starting PR's review command, by PR. */
      commandTurns: Shaped<Record<string, string>>
      /** Animation frame for clickable text on hover and running review markers. */
      frame: number
      /** Pull requests hidden with their visibility controls, also kept in the shared store. */
      hidden: Shaped<HiddenEntry[]>
      /** Hidden refs given a slot when the visibility controls opened, or null while closed. */
      hiddenAtEditStart: Shaped<string[] | null>
      /** The choice buttons the agent offered on each pull request, by PR. */
      choices: Shaped<Record<string, Choice[]>>
    }
  }
}
