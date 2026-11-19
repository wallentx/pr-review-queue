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
      /** Whether the rows show their hide control (the header's square). */
      isEditing: boolean
      /** Whether hidden pull requests are listed, struck through, with a restore control. */
      isShowingHidden: boolean
    }
  }
}
