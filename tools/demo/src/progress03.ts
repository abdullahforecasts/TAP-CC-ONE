/**
 * Records a realistic, multi-day student session through the real recorder (the same Recorder
 * class the extension runs), driven by the editor simulator used in the extension's tests. The
 * builds are real: the files as saved at that moment are compiled with g++ and the exit code is
 * what g++ returned.
 *
 *   tsx --conditions=source tools/demo/src/progress03.ts <output folder>
 *
 * Writes <output>/project (the 12 source files, .tap/config.json, .tap/log.codelog) and
 * <output>/timeline.json (what happened, for the README).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LogWriter, scanForRecovery } from '@tap/core';
import { Sim, SimHost } from '../../../packages/extension/test/support/sim.js';
import * as src from './sources.js';

const out = path.resolve(process.argv[2] ?? 'progress-demo');
const project = path.join(out, 'project');

// ---- deterministic randomness and a virtual clock ----------------------------------------------
let seed = 20261012;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const host = new SimHost();
host.staleDirtyFlag = true; // like VS Code: the first edit after a save reports isDirty=false
host.tracked = (rel) => !rel.startsWith('.tap/');
const PKT = 5 * 3600_000; // the student is in Pakistan (UTC+5)
const at = (day: number, hh: number, mm: number) => Date.UTC(2026, 9, 12 + day, hh, mm) - PKT;
const setClock = (wall: number) => {
  host.mono += Math.max(0, wall - host.wall);
  host.wall = wall;
};

const story: Array<{ t: number; what: string }> = [];
const say = (what: string) => {
  story.push({ t: host.wall, what });
  console.log(`${new Date(host.wall + PKT).toISOString().slice(0, 16).replace('T', ' ')}  ${what}`);
};

let sim: Sim;
let lastFlush = 0;
let lastTick = 0;

/** What a real extension does in the background: flush every ~2 s, housekeeping every ~15 s. */
async function background(): Promise<void> {
  if (host.mono - lastFlush >= 2000) {
    lastFlush = host.mono;
    await sim.recorder.flush({ sweep: false });
  }
  if (host.mono - lastTick >= 15_000) {
    lastTick = host.mono;
    await sim.recorder.tick();
  }
}

async function wait(ms: number): Promise<void> {
  // Advance in 15 s steps so periodic checkpoints and sweeps happen as they would.
  while (ms > 0) {
    const step = Math.min(ms, 15_000);
    host.advance(step);
    ms -= step;
    await background();
  }
}

function text(rel: string): string {
  return sim.text(rel);
}

/** Types `t` at `off` like a person: per-key timing, Enter with auto-indent, thinking, typos. */
async function type(rel: string, off: number, t: string): Promise<number> {
  let pos = off;
  let i = 0;
  while (i < t.length) {
    let chunk: string;
    if (t[i] === '\n') {
      let j = i + 1;
      while (j < t.length && t[j] === ' ') j++;
      chunk = t.slice(i, j); // VS Code inserts the indentation with the newline
    } else {
      chunk = String.fromCodePoint(t.codePointAt(i)!);
    }
    let delay = 90 + rnd() * 260;
    if (chunk.startsWith('\n')) {
      delay += 600 + rnd() * 4000;
      if (rnd() < 0.3) delay += 20_000 + rnd() * 140_000; // reading, thinking
    }
    if (/[a-z]/i.test(chunk) && rnd() < 0.025) {
      // a typo, noticed and fixed with backspace
      host.advance(delay);
      sim.change(rel, [
        { rangeOffset: pos, rangeLength: 0, text: String.fromCharCode(97 + Math.floor(rnd() * 26)) },
      ]);
      host.advance(200 + rnd() * 500);
      sim.change(rel, [{ rangeOffset: pos, rangeLength: 1, text: '' }]);
      delay = 120 + rnd() * 200;
    }
    host.advance(delay);
    sim.change(rel, [{ rangeOffset: pos, rangeLength: 0, text: chunk }]);
    pos += chunk.length;
    i += chunk.length;
    await background();
  }
  return pos;
}

async function typeAtEnd(rel: string, t: string): Promise<void> {
  await type(rel, text(rel).length, t);
}

async function save(rel: string): Promise<void> {
  host.advance(400 + rnd() * 800);
  sim.save(rel);
  await background();
}

async function newFile(rel: string): Promise<void> {
  host.advance(3000 + rnd() * 6000);
  sim.createViaEditor(rel);
  sim.open(rel);
  await background();
}

/** Compiles the saved files with g++ (a real build) and records the run with its exit code. */
async function build(): Promise<number> {
  host.advance(2000 + rnd() * 3000);
  const rid = sim.recorder.runStarted('task', 'build: g++ -std=c++17 -Wall *.cpp -o sms');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-demo-build-'));
  for (const [rel, content] of host.disk) {
    if (rel.includes('/')) continue;
    fs.writeFileSync(path.join(dir, rel), content);
  }
  const cpps = [...host.disk.keys()].filter((r) => !r.includes('/') && r.endsWith('.cpp')).sort();
  const result = spawnSync('g++', ['-std=c++17', '-Wall', ...cpps, '-o', 'sms'], {
    cwd: dir,
    encoding: 'utf8',
  });
  fs.rmSync(dir, { recursive: true, force: true });
  const exit = result.status ?? 1;
  host.advance(1500 + rnd() * 4000);
  sim.recorder.runEnded(rid, exit);
  say(
    `build → g++ exit ${exit}${exit ? ` (${(result.stderr.split('\n').find((l) => l.includes('error')) ?? '').trim()})` : ''}`,
  );
  await background();
  return exit;
}

async function focusAway(ms: number, why: string): Promise<void> {
  sim.recorder.onFocusChanged(false);
  say(`left VS Code for ${Math.round(ms / 60_000)} min (${why})`);
  await wait(ms);
  sim.recorder.onFocusChanged(true);
}

async function settle(): Promise<void> {
  await sim.recorder.flush({ sweep: false });
  await sim.recorder.idle();
}

const ENV = { vsc: '1.105.1', app: 'vscode', os: 'linux', ext: '0.2.0' };

async function main(): Promise<void> {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(project, { recursive: true });

  // ================= Session 1: Monday, lab, 09:00–12:00, no internet ===========================
  setClock(at(0, 9, 0));
  host.disk.set('utils.h', src.UTILS_H);
  host.disk.set('main.cpp', src.MAIN_CPP_STARTER);
  sim = new Sim(host);
  await sim.start({ env: { ...ENV, aiExt: [] } });
  say('session 1 (lab, offline): recording starts; utils.h and main.cpp are starter code');

  await newFile('student.h');
  await type('student.h', 0, src.STUDENT_H);
  await save('student.h');
  say('student.h typed and saved');

  await newFile('student.cpp');
  await type('student.cpp', 0, src.STUDENT_CPP);
  await save('student.cpp');
  say('student.cpp typed and saved');

  await newFile('course.h');
  await type('course.h', 0, src.COURSE_H_BEFORE);
  const p = await type('course.h', text('course.h').length, src.COURSE_H_WRONG);
  host.advance(4000);
  sim.change(
    'course.h',
    [{ rangeOffset: p - src.COURSE_H_WRONG.length, rangeLength: src.COURSE_H_WRONG.length, text: '' }],
    'undo',
  );
  say('course.h: typed "int seats = 30;" and undid it');
  await typeAtEnd('course.h', src.COURSE_H_RIGHT + src.COURSE_H_AFTER);
  await save('course.h');

  await newFile('course.cpp');
  await type('course.cpp', 0, '#include "course.h"\n\n');
  host.advance(6000);
  sim.paste('course.cpp', text('course.cpp').length, src.IS_VALID_ID);
  say('course.cpp: pasted isValidId() copied from student.cpp (own file)');
  const nameAt = text('course.cpp').indexOf('isValidId');
  host.advance(1500);
  sim.change('course.cpp', [{ rangeOffset: nameAt, rangeLength: 'isValidId'.length, text: '' }]);
  await type('course.cpp', nameAt, 'isValidCourseId');
  await typeAtEnd('course.cpp', src.COURSE_CPP_DESCRIBE);
  await save('course.cpp');
  await build(); // fails: <sstream> is missing
  const incl = text('course.cpp').indexOf('\n') + 1;
  await type('course.cpp', incl, '#include <sstream>\n');
  await save('course.cpp');
  await build();

  await newFile('enrollment.h');
  await type('enrollment.h', 0, src.ENROLLMENT_H_V1);
  await save('enrollment.h');
  await newFile('enrollment.cpp');
  await type('enrollment.cpp', 0, src.ENROLLMENT_CPP_V1);
  await save('enrollment.cpp');
  say('enrollment.h / enrollment.cpp typed');

  await focusAway(6 * 60_000, 'reading the course page in the browser');

  await newFile('storage.h');
  await type('storage.h', 0, src.STORAGE_H);
  await save('storage.h');
  await newFile('storage.cpp');
  await type('storage.cpp', 0, src.STORAGE_CPP_HEAD);
  host.advance(25_000);
  sim.paste('storage.cpp', text('storage.cpp').length, src.STACKOVERFLOW_SPLIT);
  say('storage.cpp: pasted splitCsv() from a StackOverflow answer (outside)');
  await sim.recorder.addNote('splitCsv() in storage.cpp is adapted from a StackOverflow answer.');
  await typeAtEnd('storage.cpp', src.STORAGE_CPP_REST);
  await save('storage.cpp');

  await newFile('scratch/test_split.cpp');
  await type('scratch/test_split.cpp', 0, src.SCRATCH);
  await save('scratch/test_split.cpp');
  say('scratch/test_split.cpp: a quick test of splitCsv()');

  await sim.recorder.pause('tea break');
  say('paused recording (tea break)');
  await wait(14 * 60_000);
  await sim.recorder.resume();
  say('resumed recording');

  sim.open('main.cpp');
  await type('main.cpp', 0, src.MAIN_INCLUDES);
  const todo = text('main.cpp').indexOf(src.MAIN_TODO);
  host.advance(2000);
  sim.change('main.cpp', [{ rangeOffset: todo, rangeLength: src.MAIN_TODO.length, text: '' }]);
  await type('main.cpp', todo, src.MAIN_BODY_V1);
  await save('main.cpp');
  say('main.cpp: menu for choices 1–3 typed');
  await build();
  await settle();
  await sim.recorder.stop('close');
  say('session 1 ends (VS Code closed)');
  let bytes = sim.bytes;
  host.docs.clear();

  // ===== In the evening, with VS Code closed, Claude Code (in a terminal) writes report.h/.cpp =====
  setClock(at(0, 19, 40));
  host.disk.set('report.h', src.REPORT_H);
  host.disk.set('report.cpp', src.REPORT_CPP);
  say('VS Code closed: Claude Code (terminal) creates report.h and report.cpp');

  // ================= Session 2: Monday evening at home, online, AI extensions enabled ============
  setClock(at(0, 20, 5));
  const aiExt = ['anthropic.claude-code', 'github.copilot', 'github.copilot-chat', 'kilocode.kilo-code'];
  sim = new Sim(host);
  await sim.start({ existing: bytes, env: { ...ENV, aiExt } });
  say(`session 2 (home): Copilot, Copilot Chat, Kilo Code and Claude Code enabled`);

  await focusAway(9 * 60_000, 'asking Kilo Code to add drop() and studentsIn()');
  sim.open('enrollment.h');
  host.advance(20_000);
  const kiloAt = text('enrollment.h').indexOf(src.KILO_INSERT_AFTER) + src.KILO_INSERT_AFTER.length;
  sim.change('enrollment.h', [{ rangeOffset: kiloAt, rangeLength: 0, text: src.KILO_INSERT }]);
  say('enrollment.h: Kilo Code agent adds drop() and studentsIn() declarations');
  await wait(4 * 60_000);
  await save('enrollment.h');

  sim.open('enrollment.cpp');
  await typeAtEnd('enrollment.cpp', src.DROP_SIGNATURE);
  host.advance(1800);
  sim.insert('enrollment.cpp', text('enrollment.cpp').length, src.COPILOT_DROP_BODY);
  await typeAtEnd('enrollment.cpp', src.STUDENTS_IN_SIGNATURE);
  host.advance(1500);
  sim.insert('enrollment.cpp', text('enrollment.cpp').length, src.COPILOT_STUDENTS_IN_BODY);
  say('enrollment.cpp: signatures typed, bodies accepted from Copilot inline suggestions');
  await wait(5 * 60_000);
  await save('enrollment.cpp');

  sim.open('main.cpp');
  const repAt = text('main.cpp').indexOf('#include "storage.h"');
  await type('main.cpp', repAt, src.MAIN_REPORT_INCLUDE);
  const branch = text('main.cpp').indexOf(src.MAIN_BRANCH_ANCHOR) + src.MAIN_BRANCH_ANCHOR.length;
  host.advance(2500);
  sim.insert('main.cpp', branch, src.COPILOT_MAIN_BRANCH);
  say('main.cpp: report branch accepted from Copilot');
  await save('main.cpp');

  sim.open('report.cpp');
  const repLine = text('report.cpp').indexOf(src.REPORT_TYPED_AFTER) + src.REPORT_TYPED_AFTER.length;
  await type('report.cpp', repLine, src.REPORT_TYPED);
  await save('report.cpp');
  say("report.cpp: reviewed Claude Code's file and added a line by hand");
  await build();

  await focusAway(12 * 60_000, 'asking Claude Code in a terminal to make loading robust');
  sim.open('storage.cpp');
  host.advance(90_000);
  const storage = host.disk.get('storage.cpp')!;
  sim.externalWrite('storage.cpp', storage.replace(src.CLAUDE_LOAD_OLD, src.CLAUDE_LOAD_NEW));
  say('storage.cpp: Claude Code (terminal) rewrites loadRegistry() on disk while the file is open');
  await wait(3000);
  await build();
  await wait(2 * 60_000);
  await settle();
  say('battery dies: no clean end of session, last block half written');
  bytes = sim.bytes;
  const damaged = bytes.slice(0, bytes.length - 7);
  host.docs.clear();

  // ================= Session 3: Tuesday morning ======================================================
  setClock(at(1, 10, 15));
  const scan = scanForRecovery(damaged);
  sim = new Sim(host);
  await sim.start({
    existing: damaged.subarray(0, scan.validLength),
    recovery: LogWriter.recoveryBody(scan),
    env: { ...ENV, aiExt },
  });
  say(
    `session 3: log repaired after the crash (${damaged.length - scan.validLength} damaged bytes set aside)`,
  );
  sim.open('storage.cpp');
  await type(
    'storage.cpp',
    0,
    '// Students and courses are stored as CSV lines: S,id,name,email / C,id,code,title,capacity\n',
  );
  await save('storage.cpp');
  host.advance(30_000);
  sim.deleteViaEditor('scratch/test_split.cpp');
  say('deleted scratch/test_split.cpp');
  await build();
  await sim.recorder.addNote(
    'report.h and report.cpp were generated with Claude Code; I reviewed them and added the total line.',
  );
  await wait(60_000);
  await settle();
  await sim.recorder.stop('close');
  say('session 3 ends');
  bytes = sim.bytes;

  // ---- write the project folder ----
  for (const [rel, content] of host.disk) {
    const file = path.join(project, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  fs.mkdirSync(path.join(project, '.tap'), { recursive: true });
  fs.writeFileSync(path.join(project, '.tap', 'log.codelog'), bytes);
  fs.writeFileSync(
    path.join(project, '.tap', 'config.json'),
    `${JSON.stringify(
      {
        version: 1,
        label: 'student-management-system',
        include: ['**/*.{c,h,cpp,hpp,txt,md}'],
        exclude: ['**/build/**'],
        maxFileSizeKB: 1024,
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(project, '.tap', '.gitignore'), 'lock\nquarantine/\n');
  fs.writeFileSync(path.join(out, 'timeline.json'), `${JSON.stringify(story, null, 2)}\n`);
  if (host.errors.length) console.error('recorder errors:', host.errors);
  console.log(`\nlog: ${bytes.length} bytes → ${path.join(project, '.tap', 'log.codelog')}`);
}

await main();
