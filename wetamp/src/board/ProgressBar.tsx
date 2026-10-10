import { Text } from 'ink';
import type { ReactElement } from 'react';
import { progressLabel, type Progress } from './eta';

/** Existing Ink bars lack an overlay slot; each cell owns both its fill and label colour. */
export function ProgressBar({ progress, width, prefix = '' }: { progress: Progress; width: number; prefix?: string }): ReactElement {
  const label = prefix + progressLabel(progress), inner = Math.floor(width) - 2;
  if (width < 14 || Bun.stringWidth(label) > inner) return <Text>{label}</Text>;
  const full = Math.round(inner * (progress.pct ?? 0) / 100);
  const left = Math.floor((inner - Bun.stringWidth(label)) / 2);
  const cells: { text: string; full: boolean }[] = [];
  let column = 0;
  const put = (ch: string): void => { cells.push({ text: ch, full: column < full }); column += Bun.stringWidth(ch); };
  while (column < left) put(column < full ? '█' : '░');
  for (const ch of label) put(ch);
  while (column < inner) put(column < full ? '█' : '░');
  return <Text>▕{cells.map((c, i) => <Text key={i} color={c.full ? 'cyan' : undefined}>{c.text}</Text>)}▏</Text>;
}
