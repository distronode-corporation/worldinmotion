import type { ChatTurn } from "./model.ts";

export interface ConversationOptions {
  /** Most turns sent to the model, the new message included. */
  maxTurns: number;
  /** Most characters of transcript sent to the model, the new message included. */
  maxChars: number;
  /** A thread idle this long is forgotten. */
  idleMs: number;
  now: () => number;
}

interface Exchange {
  user: string;
  assistant: string;
}

interface Thread {
  exchanges: Exchange[];
  /** Things seen in the thread that need no reply (results), shown with the next message. */
  notes: string[];
  lastActive: number;
}

const MAX_NOTES = 5;
const MAX_NOTE_CHARS = 2000;

/**
 * Per-thread transcripts. A thread is a sender address, or a task id for tasks. History is kept
 * as whole user/assistant exchanges so the transcript always starts with a user turn and
 * alternates, which Converse requires; trimming drops the oldest exchange first.
 */
export class Conversations {
  private readonly options: ConversationOptions;
  private readonly threads = new Map<string, Thread>();

  constructor(options: ConversationOptions) {
    this.options = options;
  }

  /** The transcript to send: as much recent history as fits, then the new user turn. */
  context(threadId: string, text: string): { messages: ChatTurn[]; userText: string } {
    const thread = this.thread(threadId);
    const userText = thread.notes.length === 0 ? text : `${thread.notes.join("\n")}\n\n${text}`;
    let turns = 1;
    let chars = userText.length;
    const kept: Exchange[] = [];
    for (let i = thread.exchanges.length - 1; i >= 0; i--) {
      const ex = thread.exchanges[i] as Exchange;
      const size = ex.user.length + ex.assistant.length;
      if (turns + 2 > this.options.maxTurns || chars + size > this.options.maxChars) break;
      kept.unshift(ex);
      turns += 2;
      chars += size;
    }
    const messages: ChatTurn[] = [];
    for (const ex of kept) {
      messages.push({ role: "user", text: ex.user }, { role: "assistant", text: ex.assistant });
    }
    messages.push({ role: "user", text: userText });
    return { messages, userText };
  }

  /** Stores a completed exchange; the notes it carried are now part of history. */
  commit(threadId: string, userText: string, assistantText: string): void {
    const thread = this.thread(threadId);
    thread.notes = [];
    thread.exchanges.push({ user: userText, assistant: assistantText });
    let chars = 0;
    for (const ex of thread.exchanges) chars += ex.user.length + ex.assistant.length;
    // Keep only what context() could still send; an empty thread passes both tests (maxTurns >= 1).
    while (
      thread.exchanges.length * 2 + 1 > this.options.maxTurns ||
      chars > this.options.maxChars
    ) {
      const dropped = thread.exchanges.shift() as Exchange;
      chars -= dropped.user.length + dropped.assistant.length;
    }
  }

  note(threadId: string, text: string): void {
    const thread = this.thread(threadId);
    thread.notes.push(text.slice(0, MAX_NOTE_CHARS));
    if (thread.notes.length > MAX_NOTES) thread.notes.shift();
  }

  get size(): number {
    this.expire();
    return this.threads.size;
  }

  private thread(id: string): Thread {
    this.expire();
    let thread = this.threads.get(id);
    if (thread === undefined) {
      thread = { exchanges: [], notes: [], lastActive: 0 };
      this.threads.set(id, thread);
    }
    thread.lastActive = this.options.now();
    return thread;
  }

  private expire(): void {
    const cutoff = this.options.now() - this.options.idleMs;
    for (const [id, thread] of this.threads) {
      if (thread.lastActive < cutoff) this.threads.delete(id);
    }
  }
}
