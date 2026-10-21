import { describe, expect, it } from 'vitest';
import { maskCommand, programName } from '../src/recorder/terminal.js';

describe('terminal commands', () => {
  it('keeps ordinary commands as typed', () => {
    for (const cmd of [
      'g++ -Wall -std=c++17 main.cpp -o app',
      './app < input.txt',
      'python3 solve.py --n 5',
      'git commit -m "fix loop"',
      'javac Main.java && java Main',
    ]) {
      expect(maskCommand(cmd)).toBe(cmd);
    }
  });

  it('masks secrets', () => {
    expect(maskCommand('mysql -u root --password=hunter2 db')).toBe('mysql -u root --password=*** db');
    expect(maskCommand('curl --token abc123 https://x')).toBe('curl --token *** https://x');
    expect(maskCommand('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuv python bot.py')).toBe(
      'OPENAI_API_KEY=*** python bot.py',
    );
    expect(maskCommand('$env:GITHUB_TOKEN="ghp_abcdefghijklmnopqrstuvwxyz12"')).toBe('$env:GITHUB_TOKEN=***');
    expect(maskCommand('git clone https://user:s3cret@github.com/x/y.git')).toBe(
      'git clone https://user:***@github.com/x/y.git',
    );
    expect(maskCommand('curl -H "Authorization: Bearer abcdefghijkl123" x')).toBe(
      'curl -H "Authorization: Bearer ***" x',
    );
    expect(maskCommand('echo ghp_abcdefghijklmnopqrstuvwxyz1234')).toBe('echo ***');
    expect(maskCommand('aws s3 ls --profile x AKIAABCDEFGHIJKLMNOP')).toBe('aws s3 ls --profile x ***');
  });

  it('caps the length', () => {
    expect([...maskCommand(`echo ${'x'.repeat(9000)}`)]).toHaveLength(8000);
  });

  it('finds the program name', () => {
    expect(programName('g++ -Wall main.cpp')).toBe('g++');
    expect(programName('/usr/bin/python3 x.py')).toBe('python3');
    expect(programName('& "C:\\Program Files\\Python\\python.exe" x.py')).toBe('python');
    expect(programName('.\\build.bat')).toBe('build');
    expect(programName('   ')).toBeUndefined();
  });
});
