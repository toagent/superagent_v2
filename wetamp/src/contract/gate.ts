export const gateHashInput = (round: string | number, carried = false) => {
  const workflow = `gate_${String(round)}${carried ? '_carried' : ''}_sha256`;
  return { workflow, env: `INPUTS_${workflow.toUpperCase()}` } as const;
};
