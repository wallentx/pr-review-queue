export type QueueItem = {
  repo: string
  number: number
  title: string
  kind: 'new' | 're_review' | 'unknown'
}

export type Queue =
  | { kind: 'ok'; total: number; isNew: number; reReview: number; isComplete: boolean; items: QueueItem[] }
  | { kind: 'error'; reason: string }

/** running: a review was started; done: the review finished and waits to be posted; posted: hidden until the queue drops it. */
export type ReviewStatus = 'running' | 'done' | 'posted'

declare module 'claude-code' {
  interface PluginState {
    'pr-review-queue': {
      isEnabled: boolean
      isExpanded: boolean
      queue: Shaped<Queue | null>
      statuses: Shaped<Record<string, ReviewStatus>>
      agents: Shaped<Record<string, string>>
      /** Pull requests the person hid with the row's x, as `owner/repo#N`; also kept in the store. */
      hidden: Shaped<string[]>
      /** The pull request whose row shows its hide control, or null for none. */
      revealed: string | null
    }
  }
}
