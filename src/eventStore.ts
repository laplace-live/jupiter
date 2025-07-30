import type { Message } from '@laplace.live/event-types'

export class EventStore {
  private events: Message[] = []
  private readonly capacity: number

  constructor(capacity: number = 6000) {
    this.capacity = capacity
  }

  addEvent(event: Message): void {
    this.events.push(event)

    // Keep only the most recent events up to capacity
    if (this.events.length > this.capacity) {
      this.events.shift()
    }
  }

  getEvents(): Message[] {
    return [...this.events]
  }

  getRecentEvents(n: number = 20): Message[] {
    return this.events.slice(-n)
  }

  getEventsByUid(uid: number, count: number = 30): Message[] {
    const filtered: Message[] = []

    // Iterate from the end (most recent) to the beginning
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i]
      if (event && event.uid === uid) {
        filtered.push(event)
        if (filtered.length === count) {
          break
        }
      }
    }

    // Reverse to get chronological order (oldest to newest)
    return filtered.reverse()
  }
}

// Helper function to format recent messages context
export function formatMessagesContext(messages: Message[]): string {
  return messages.map(msg => `[${msg.username}](https://laplace.live/user/${msg.uid}): ${msg.message}`).join('\n')
}
