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
  tasks: ScheduledTask[]
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
        tasks: [],
      }
      this.groups.set(groupId, group)
      this.order.push(groupId)
    }
    group.expectedCount = Math.max(group.expectedCount, expectedCount)
    group.registeredCount += 1
    group.tasks.push(task)
    this.pump()
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
      void task()
        .catch(() => undefined)
        .finally(() => {
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
      this.groups.delete(completedId)
      const index = this.order.indexOf(completedId)
      if (index >= 0) this.order.splice(index, 1)
    }
    this.activeGroupId = null
    this.pump()
  }
}
