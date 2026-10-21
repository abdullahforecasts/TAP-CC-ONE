/** The work the viewer does off the UI thread: read the log, build the model, verify. */
import { createAnchorVerifier } from '@tap/anchor';
import type { AnchorVerifier, SubmittedFile } from '@tap/core';
import { LogLoader } from './model/load.js';
import type { ViewData } from './model/types.js';
import type { WorkerRequest, WorkerResponse } from './protocol.js';

export class Engine {
  private readonly loader = new LogLoader();
  private submission: SubmittedFile[] | undefined;
  private comparedWith: string | undefined;
  /** Checks timestamp tokens against the bundled TSA roots; caches results across refreshes. */
  private readonly verifier: AnchorVerifier;

  constructor(verifier: AnchorVerifier = createAnchorVerifier()) {
    this.verifier = verifier;
  }

  handle(req: WorkerRequest): WorkerResponse {
    const started = performance.now();
    try {
      if (req.type === 'load') {
        this.submission = req.submission;
        this.comparedWith = req.comparedWith;
        this.loader.reset(req.bytes);
      } else if (req.type === 'append') {
        if (req.submission) {
          this.submission = req.submission;
          this.comparedWith = req.comparedWith;
        }
        this.loader.append(req.bytes);
      } else {
        this.submission = req.submission;
        this.comparedWith = req.comparedWith;
      }
      return { type: 'view', data: this.view(), ms: Math.round(performance.now() - started) };
    } catch (e) {
      return { type: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  }

  view(): ViewData {
    const data: ViewData = {
      model: this.loader.model(),
      report: this.loader.verify(this.submission, this.verifier),
    };
    if (this.comparedWith !== undefined) data.comparedWith = this.comparedWith;
    return data;
  }
}
