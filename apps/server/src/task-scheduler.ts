export type ScheduledTask = () => Promise<void>

export class ConcurrencyScheduler {
  private readonly queue: ScheduledTask[] = []
  private activeCount = 0

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('Scheduler concurrency must be a positive integer')
    }
  }

  enqueue(task: ScheduledTask): void {
    this.queue.push(task)
    this.pump()
  }

  get active(): number {
    return this.activeCount
  }

  get pending(): number {
    return this.queue.length
  }

  private pump(): void {
    while (this.activeCount < this.concurrency) {
      const task = this.queue.shift()
      if (!task) return
      this.activeCount += 1
      void task()
        .catch(() => undefined)
        .finally(() => {
          this.activeCount -= 1
          this.pump()
        })
    }
  }
}

interface BatchGroup {
  id: string
  expectedCount: number
  registeredCount: number
  completedCount: number
  activeCount: number
  tasks: ScheduledTask[]
  cancelled: boolean
  cancelWaiters: Array<() => void>
}

export class SerialBatchScheduler {
  private readonly groups = new Map<string, BatchGroup>()
  private readonly order: string[] = []
  private activeGroupId: string | null = null

  enqueue(groupId: string, expectedCount: number, task: ScheduledTask): void {
    let group = this.groups.get(groupId)
    if (!group) {
      group = {
        id: groupId,
        expectedCount: Math.max(1, expectedCount),
        registeredCount: 0,
        completedCount: 0,
        activeCount: 0,
        tasks: [],
        cancelled: false,
        cancelWaiters: [],
      }
      this.groups.set(groupId, group)
      this.order.push(groupId)
    }
    group.expectedCount = Math.max(group.expectedCount, expectedCount)
    group.registeredCount += 1
    group.tasks.push(task)
    this.pump()
  }

  /**
   * Cancels a batch's queued work and waits for work that has already started.
   * Pending groups are removed immediately; the active group is released after
   * its currently running tasks settle.
   */
  cancel(groupId: string): Promise<void> {
    const group = this.groups.get(groupId)
    if (!group) return Promise.resolve()

    if (group.id !== this.activeGroupId) {
      group.tasks.splice(0)
      this.groups.delete(groupId)
      const index = this.order.indexOf(groupId)
      if (index >= 0) this.order.splice(index, 1)
      return Promise.resolve()
    }

    const completion = new Promise<void>((resolve) => {
      group.cancelWaiters.push(resolve)
    })
    group.cancelled = true
    group.tasks.splice(0)
    group.expectedCount = group.completedCount + group.activeCount
    this.finishGroupIfReady(group)
    return completion
  }

  seal(groupId: string): void {
    const group = this.groups.get(groupId)
    if (!group) return
    group.expectedCount = group.registeredCount
    this.finishGroupIfReady(group)
  }

  get activeBatchId(): string | null {
    return this.activeGroupId
  }

  get pendingBatchCount(): number {
    return this.order.length - (this.activeGroupId ? 1 : 0)
  }

  private pump(): void {
    if (!this.activeGroupId) {
      const nextId = this.order[0]
      if (!nextId) return
      this.activeGroupId = nextId
    }
    const group = this.groups.get(this.activeGroupId)
    if (!group) {
      this.releaseActiveGroup()
      return
    }
    for (const task of group.tasks.splice(0)) {
      if (group.cancelled) break
      group.activeCount += 1
      void task()
        .catch(() => undefined)
        .finally(() => {
          group.activeCount -= 1
          group.completedCount += 1
          this.finishGroupIfReady(group)
        })
    }
  }

  private finishGroupIfReady(group: BatchGroup): void {
    if (
      group.id !== this.activeGroupId ||
      group.registeredCount < group.expectedCount ||
      group.completedCount < group.expectedCount
    ) {
      return
    }
    this.releaseActiveGroup()
  }

  private releaseActiveGroup(): void {
    const completedId = this.activeGroupId
    if (completedId) {
      const completedGroup = this.groups.get(completedId)
      this.groups.delete(completedId)
      const index = this.order.indexOf(completedId)
      if (index >= 0) this.order.splice(index, 1)
      for (const resolve of completedGroup?.cancelWaiters ?? []) resolve()
    }
    this.activeGroupId = null
    this.pump()
  }
}
