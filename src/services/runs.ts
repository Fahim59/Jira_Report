import type { ReportStage } from './report.js';

/** One progress update, sent to the browser over SSE. */
export type ProgressEvent =
  | { stage: ReportStage; issues?: number; done?: number; total?: number }
  | { stage: 'done' }
  | { stage: 'failed'; message: string };

type Listener = (e: ProgressEvent) => void;

interface Run {
  /** Set while POST /api/report is generating; absent when only a progress listener is waiting. */
  controller?: AbortController;
  last?: ProgressEvent;
  listeners: Set<Listener>;
}

/** Client-chosen ids: long enough to be unguessable in practice, safe in URLs and logs. */
export const RUN_ID = /^[A-Za-z0-9_-]{16,64}$/;

/** Upper bound on tracked runs, so stray progress subscriptions cannot grow memory without limit. */
const MAX_RUNS = 500;

/**
 * In-memory registry of reports being generated, keyed by a client-chosen id. It only carries
 * progress events and the AbortController (no report data). Entries disappear when the run finishes
 * and nobody is listening.
 */
export class RunRegistry {
  private readonly runs = new Map<string, Run>();

  get size(): number {
    return this.runs.size;
  }

  private entry(id: string): Run | undefined {
    let run = this.runs.get(id);
    if (!run) {
      if (this.runs.size >= MAX_RUNS) return undefined;
      run = { listeners: new Set() };
      this.runs.set(id, run);
    }
    return run;
  }

  /** Registers a run. Undefined if one with this id is already generating (double submit) or the registry is full. */
  start(id: string): AbortController | undefined {
    const run = this.entry(id);
    if (!run || run.controller) return undefined;
    run.controller = new AbortController();
    return run.controller;
  }

  isRunning(id: string): boolean {
    return !!this.runs.get(id)?.controller;
  }

  publish(id: string, e: ProgressEvent): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.last = e;
    run.listeners.forEach((fn) => fn(e));
  }

  /** Sends the final event and forgets the run. */
  finish(id: string, e: ProgressEvent): void {
    this.publish(id, e);
    this.runs.delete(id);
  }

  /** Aborts a running report. False if no such run is generating. */
  cancel(id: string): boolean {
    const run = this.runs.get(id);
    if (!run?.controller) return false;
    run.controller.abort();
    return true;
  }

  /**
   * Listens for progress; the latest event (if any) is replayed immediately. Returns an unsubscribe
   * function, or undefined when the registry is full.
   */
  subscribe(id: string, fn: Listener): (() => void) | undefined {
    const run = this.entry(id);
    if (!run) return undefined;
    run.listeners.add(fn);
    if (run.last) fn(run.last);
    return () => {
      run.listeners.delete(fn);
      if (!run.controller && run.listeners.size === 0 && this.runs.get(id) === run) this.runs.delete(id);
    };
  }
}
