/** Random access into a file's track for the replay player (design §10.1, §12.1 panel 3). */
import { type Span, SpanList } from '@tap/core';
import type { FileTrack, TrackEvent } from './types.js';

export interface Frame {
  /** Number of events applied. */
  index: number;
  text: string;
  spans: Span[];
  /** Text brought back by undo or redo (origin 'undo-redo'); see Keyframe.undo. */
  undo: Span[];
}

/** Records in `undo` which text an event brought back by undo or redo. */
export function applyUndoMark(undo: SpanList, e: TrackEvent): void {
  undo.remove(e.off, e.del);
  undo.insert(e.off, e.ins.length, e.undo ? 'undo-redo' : 'typed', e.seq);
}

/** Applies one event to a text, its span list and its undo marks. */
export function applyEvent(text: string, spans: SpanList, e: TrackEvent, undo?: SpanList): string {
  spans.remove(e.off, e.del);
  spans.insert(e.off, e.ins.length, e.origin, e.seq);
  if (undo) applyUndoMark(undo, e);
  return text.slice(0, e.off) + e.ins + text.slice(e.off + e.del);
}

export function spanListOf(spans: readonly Span[]): SpanList {
  const list = new SpanList();
  let pos = 0;
  for (const s of spans) {
    list.insert(pos, s.len, s.origin, s.seq);
    pos += s.len;
  }
  return list;
}

/** The file after `index` events, starting from the nearest earlier keyframe. */
export function frameAt(track: FileTrack, index: number): Frame {
  const target = Math.max(0, Math.min(index, track.events.length));
  let lo = 0;
  let hi = track.keyframes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (track.keyframes[mid]!.index <= target) lo = mid;
    else hi = mid - 1;
  }
  const key = track.keyframes[lo]!;
  let text = key.text;
  const spans = spanListOf(key.spans);
  const undo = spanListOf(key.undo);
  for (let i = key.index; i < target; i++) text = applyEvent(text, spans, track.events[i]!, undo);
  return {
    index: target,
    text,
    spans: spans.toArray().map((s) => ({ ...s })),
    undo: undo.toArray().map((s) => ({ ...s })),
  };
}

/** Index of the first event with sequence number > seq (the position just after record seq). */
export function indexAfterSeq(track: FileTrack, seq: number): number {
  let lo = 0;
  let hi = track.events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (track.events[mid]!.seq <= seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Real time to wait before showing event `i` when playing: the gap since the previous event,
 * divided by the speed. With `skipIdle`, gaps are capped at one second of log time.
 */
export function delayBefore(track: FileTrack, i: number, speed: number, skipIdle: boolean): number {
  if (i <= 0 || i >= track.events.length) return 0;
  let gap = Math.max(0, track.events[i]!.t - track.events[i - 1]!.t);
  if (skipIdle) gap = Math.min(gap, 1000);
  return gap / Math.max(1, speed);
}
