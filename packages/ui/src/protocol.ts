/** Messages between the extension host (or a test page) and the viewer, and the viewer's worker. */
import type { SubmittedFile } from '@tap/core';
import type { ViewData } from './model/types.js';

/** Host → viewer. */
export type HostMessage =
  | {
      type: 'log';
      bytes: Uint8Array;
      /** Shown as the viewer's title (folder name). */
      title?: string;
      submission?: SubmittedFile[];
      /** Describes the submission, e.g. "the files in this folder". */
      comparedWith?: string;
    }
  | {
      type: 'append';
      bytes: Uint8Array;
      /** The files as they are now, when they may have changed too. */
      submission?: SubmittedFile[];
      comparedWith?: string;
    }
  | { type: 'submission'; submission: SubmittedFile[]; comparedWith: string }
  | { type: 'error'; message: string };

/** Viewer → host. */
export type ViewerMessage =
  | { type: 'ready' }
  | { type: 'openFile'; path: string }
  | {
      type: 'status';
      state: 'loading' | 'ready' | 'error';
      verdict?: string;
      entries?: number;
      message?: string;
    };

/** Viewer → worker. */
export type WorkerRequest =
  | { type: 'load'; bytes: Uint8Array; submission?: SubmittedFile[]; comparedWith?: string }
  | { type: 'append'; bytes: Uint8Array; submission?: SubmittedFile[]; comparedWith?: string }
  | { type: 'submission'; submission: SubmittedFile[]; comparedWith: string };

/** Worker → viewer. */
export type WorkerResponse =
  | { type: 'view'; data: ViewData; ms: number }
  | { type: 'error'; message: string };
