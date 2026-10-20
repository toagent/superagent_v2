export interface OutputHandle<T, Conditional extends boolean = false> {
  readonly id: string;
  readonly conditional: Conditional;
  readonly __output?: T;
}

export const output = <T>(id: string): OutputHandle<T> => ({ id, conditional: false });
export const conditionalOutput = <T>(id: string): OutputHandle<T, true> => ({
  id,
  conditional: true,
});

type Present<T> = Exclude<T, undefined>;

export const ref = {
  value<T>(handle: OutputHandle<T>): string {
    return `$${handle.id}.output`;
  },
  optionalValue<T, F extends T | null>(
    handle: OutputHandle<T, true>,
    fallback: F
  ): { from: string; if_skipped: F } {
    return { from: `$${handle.id}.output`, if_skipped: fallback };
  },
  required<T>(handle: OutputHandle<T>, field: keyof T): string {
    return `$${handle.id}.output.${String(field)}`;
  },
  optional<T, K extends keyof T, F extends Present<T[K]>>(
    handle: OutputHandle<T, boolean>,
    field: K,
    fallback: F
  ): { from: string; if_skipped: F } {
    return { from: `$${handle.id}.output.${String(field)}`, if_skipped: fallback };
  },
};

export const untilStatus = <T extends { status?: unknown }>(
  handle: OutputHandle<T, boolean>,
  status: Present<T['status']>
): string =>
  `bun -e ${JSON.stringify(
    `const v=await Bun.file(process.env.ARTIFACTS_DIR+'/${handle.id}.json').json();process.exit(v.status===${JSON.stringify(status)}?0:1)`
  )}`;
