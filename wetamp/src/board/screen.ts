const CSI = '\x1b[';
const ENTER = `${CSI}?1049h${CSI}?25l${CSI}?7l`;
const LEAVE = `${CSI}?7h${CSI}?25h${CSI}?1049l`;
const FRAME_START = `${CSI}?2026h${CSI}H`;
const FRAME_END = `${CSI}J${CSI}?2026l`;
// Terminal control sequences necessarily contain ESC and BEL bytes.
// eslint-disable-next-line no-control-regex
const ANSI = /^\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

interface ScreenInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(enabled: boolean): unknown;
  on(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown;
  off(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown;
}

interface ScreenOutput {
  columns?: number;
  rows?: number;
  write(value: string): unknown;
}

type ScreenSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';
interface SignalSource {
  on(event: ScreenSignal, listener: () => void): unknown;
  off(event: ScreenSignal, listener: () => void): unknown;
}

export interface TerminalScreen {
  render(frame: string): boolean;
  close(): void;
}

const clip = (line: string, columns: number): string => {
  if (Bun.stringWidth(line) <= columns) return line;
  let output = '';
  let visible = '';
  for (let offset = 0; offset < line.length; ) {
    const escape = ANSI.exec(line.slice(offset))?.[0];
    if (escape) {
      output += escape;
      offset += escape.length;
      continue;
    }
    const character = graphemes.segment(line.slice(offset))[Symbol.iterator]().next()
      .value?.segment;
    if (!character) break;
    if (Bun.stringWidth(visible + character) > columns) break;
    output += character;
    visible += character;
    offset += character.length;
  }
  return `${output}${CSI}0m`;
};

export function openTerminalScreen({
  input,
  output,
  signals,
  onExit,
}: {
  input: ScreenInput;
  output: ScreenOutput;
  signals: SignalSource;
  onExit: (code: number) => void;
}): TerminalScreen {
  let closed = false;
  let lastFrame: string | undefined;
  const previousRaw = input.isRaw ?? false;
  const stop = (code: number): void => {
    onExit(code);
  };
  const data = (chunk: string | Uint8Array): void => {
    const value = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    if (value.includes('\x03')) stop(130);
    else if (value.includes('q')) stop(0);
  };
  const signalListeners = (
    [
      ['SIGINT', 130],
      ['SIGTERM', 143],
      ['SIGHUP', 129],
    ] as const
  ).map(([signal, code]) => {
    const listener = (): void => {
      stop(code);
    };
    signals.on(signal, listener);
    return [signal, listener] as const;
  });

  if (input.isTTY && input.setRawMode) {
    input.setRawMode(true);
    input.on('data', data);
  }
  output.write(ENTER);

  return {
    render(frame): boolean {
      const columns = Math.max(1, Math.floor(output.columns ?? 100));
      const rows = Math.max(1, Math.floor(output.rows ?? 30));
      const key = `${String(columns)}\0${String(rows)}\0${frame}`;
      if (key === lastFrame) return false;
      lastFrame = key;
      const lines = frame
        .split('\n')
        .slice(0, rows)
        .map(line => `${clip(line.replace(/\r$/, ''), columns)}${CSI}K`);
      output.write(`${FRAME_START}${lines.join('\r\n')}${FRAME_END}`);
      return true;
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const [signal, listener] of signalListeners) signals.off(signal, listener);
      if (input.isTTY && input.setRawMode) {
        input.off('data', data);
        input.setRawMode(previousRaw);
      }
      output.write(LEAVE);
    },
  };
}
