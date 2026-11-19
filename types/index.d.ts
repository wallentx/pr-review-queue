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
      /** The pulse's frame, which steps while any review runs. */
      frame: number
      /** Pull requests the person hid with the row's x, as `owner/repo#N`; also kept in the store. */
      hidden: Shaped<string[]>
      /** Whether the rows show their hide control (the header's square). */
      isEditing: boolean
      /** Whether hidden pull requests are listed, struck through, with a restore control. */
      isShowingHidden: boolean
    }
  }
}
