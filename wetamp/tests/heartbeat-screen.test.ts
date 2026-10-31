import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Terminal } from '@xterm/headless';
import { openTerminalScreen } from '../src/board/screen';

class Input extends EventEmitter {
  isTTY = true;
  isRaw = false;
  raw: boolean[] = [];
  setRawMode(value: boolean): void {
    this.raw.push(value);
    this.isRaw = value;
  }
}
class Output {
  chunks: string[] = [];
  constructor(
    public columns: number,
    public rows: number
  ) {}
  write(value: string): void {
    this.chunks.push(value);
  }
  take(): string {
    return this.chunks.splice(0).join('');
  }
}
const write = (terminal: Terminal, value: string): Promise<void> =>
  new Promise(resolve => terminal.write(value, resolve));
const visible = (terminal: Terminal): string[] => {
  const lines = Array.from({ length: terminal.rows }, (_, row) =>
    terminal.buffer.active.getLine(row)?.translateToString(true)
  );
  while (lines.at(-1) === '') lines.pop();
  return lines as string[];
};

test('绝对整帧重画清除回显、旧帧和 resize 残影', async () => {
  const input = new Input();
  const output = new Output(78, 30);
  const signals = new EventEmitter();
  const exits: number[] = [];
  const screen = openTerminalScreen({ input, output, signals, onExit: code => exits.push(code) });
  const terminal = new Terminal({ cols: 78, rows: 30, allowProposedApi: true });
  const frames = [
    ['帧 A 独有', '第一屏内容'],
    ['帧 B 独有', '手机布局内容'],
    ['帧 C 独有', '桌面布局内容'],
  ];
  screen.render(frames[0]!.join('\n'));
  await write(terminal, output.take());
  expect(visible(terminal)).toEqual(frames[0]);

  await write(terminal, '^[[B^[[A\r\n模拟回显和杂字');
  terminal.resize(36, 20);
  output.columns = 36;
  output.rows = 20;
  screen.render(frames[1]!.join('\n'));
  await write(terminal, output.take());
  expect(visible(terminal)).toEqual(frames[1]);
  expect(visible(terminal).join('\n')).not.toContain('帧 A 独有');

  terminal.resize(155, 40);
  output.columns = 155;
  output.rows = 40;
  screen.render(frames[2]!.join('\n'));
  await write(terminal, output.take());
  expect(visible(terminal)).toEqual(frames[2]);
  expect(visible(terminal).join('\n')).not.toContain('模拟回显');
  signals.emit('SIGTERM');
  expect(exits).toEqual([143]);
  screen.close();
  await write(terminal, output.take());
  expect(input.raw).toEqual([true, false]);
  expect(terminal.buffer.active.type).toBe('normal');
});

test('相同帧与尺寸跳过写入，q 和 Ctrl-C 请求退出', () => {
  for (const [key, code] of [
    ['q', 0],
    ['\x03', 130],
  ] as const) {
    const input = new Input();
    const output = new Output(36, 10);
    const exits: number[] = [];
    const screen = openTerminalScreen({
      input,
      output,
      signals: new EventEmitter(),
      onExit: value => exits.push(value),
    });
    expect(screen.render('当前帧')).toBe(true);
    output.take();
    expect(screen.render('当前帧')).toBe(false);
    expect(output.take()).toBe('');
    input.emit('data', key);
    expect(exits).toEqual([code]);
    screen.close();
  }
});
