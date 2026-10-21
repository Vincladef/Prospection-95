import { addDays, set } from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";

export const FOLLOW_UP_DELAYS_DAYS = [0, 3, 7, 7, 14, 14] as const;
export type SequenceStep = "J0" | "R1" | "R2" | "R3" | "R4" | "R5";

export interface SendWindow {
  timezone: string;
  sendDays: number[];
  start: string;
  end: string;
}

function parseTime(value: string): [number, number] {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid local time: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid local time: ${value}`);
  return [hour, minute];
}

function isoWeekday(date: Date): number {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

function atLocalTime(date: Date, value: string, timezone: string): Date {
  const [hours, minutes] = parseTime(value);
  const zoned = toZonedTime(date, timezone);
  const local = set(zoned, { hours, minutes, seconds: 0, milliseconds: 0 });
  return fromZonedTime(local, timezone);
}

export function isWithinSendWindow(instant: Date, window: SendWindow): boolean {
  const zoned = toZonedTime(instant, window.timezone);
  if (!window.sendDays.includes(isoWeekday(zoned))) return false;
  const start = atLocalTime(instant, window.start, window.timezone);
  const end = atLocalTime(instant, window.end, window.timezone);
  return instant >= start && instant < end;
}

export function nextAllowedInstant(instant: Date, window: SendWindow): Date {
  if (!window.sendDays.length) throw new Error("At least one send day is required");
  if (isWithinSendWindow(instant, window)) return instant;
  for (let offset = 0; offset <= 14; offset += 1) {
    const candidateDay = addDays(toZonedTime(instant, window.timezone), offset);
    if (!window.sendDays.includes(isoWeekday(candidateDay))) continue;
    const candidate = fromZonedTime(
      set(candidateDay, {
        hours: parseTime(window.start)[0],
        minutes: parseTime(window.start)[1],
        seconds: 0,
        milliseconds: 0,
      }),
      window.timezone,
    );
    if (candidate >= instant) return candidate;
  }
  throw new Error("Unable to find an allowed send window");
}

export function nextSequenceDueAt(
  previousAcceptedAt: Date,
  nextStep: Exclude<SequenceStep, "J0">,
  window: SendWindow,
): Date {
  const index = Number(nextStep.slice(1));
  const raw = addDays(previousAcceptedAt, FOLLOW_UP_DELAYS_DAYS[index]);
  return nextAllowedInstant(raw, window);
}

export function deterministicMinuteOffset(key: string, availableMinutes: number): number {
  if (availableMinutes <= 0) return 0;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % availableMinutes;
}
