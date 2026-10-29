const steps = ["J0", "R1", "R2", "R3", "R4", "R5"] as const;
export interface SequenceStatusRow {
  step: string;
  status: string;
  content_version: number;
  technical_confirmation?: boolean;
  smtp_accepted_at?: string | null;
  sent_at?: string | null;
}

// Resolve versions before considering delivery state: an archived draft must
// never reappear after its newer version has been sent or cancelled.
export function sequenceStatus(rows: SequenceStatusRow[]) {
  const latest = new Map<string, SequenceStatusRow>();
  for (const row of rows) {
    if (!steps.includes(row.step as typeof steps[number])) continue;
    const previous = latest.get(row.step);
    if (!previous || row.content_version > previous.content_version) latest.set(row.step, row);
  }
  const ordered = steps.flatMap(step => latest.has(step) ? [latest.get(step)!] : []);
  const sent = (row: SequenceStatusRow) => row.technical_confirmation
    || row.status === "smtp_accepted" || row.status === "sent_manually";
  const current = ordered.find(row => !sent(row)) ?? ordered.at(-1);
  const timestamps = ordered.filter(sent).map(row => row.smtp_accepted_at || row.sent_at)
    .filter((value): value is string => !!value && Number.isFinite(Date.parse(value)));
  const lastSentAt = timestamps.sort((a,b) => Date.parse(b)-Date.parse(a))[0] ?? null;
  return { status: current?.status ?? null, lastSentAt };
}
