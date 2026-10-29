import { describe, expect, it } from "vitest";
import { sequenceStatus, type SequenceStatusRow } from "../sequence-status.mts";
const row = (step: string, status: string, content_version=6): SequenceStatusRow => ({step,status,content_version});
describe("sequence status across archived versions", () => {
  it("shows the scheduled follow-up rather than archived initial drafts", () => {
    const data = [row("J0","draft",5),row("J0","smtp_accepted"),row("R1","draft",5),row("R1","scheduled"),row("R2","approved")];
    data[1].technical_confirmation=true;
    data[1].smtp_accepted_at="2026-10-29T15:25:12.158Z";
    expect(sequenceStatus(data)).toEqual({status:"scheduled",lastSentAt:"2026-10-29T15:25:12.158Z"});
  });
  it("shows a validated latest revision instead of older pending or draft versions", () => {
    expect(sequenceStatus([row("J0","draft",1),row("J0","approved",2)])).toEqual({status:"approved",lastSentAt:null});
  });
  it("keeps the latest manual draft and cancelled or failed statuses authoritative", () => {
    for(const status of ["draft","cancelled","failed","uncertain","sending"]) {
      expect(sequenceStatus([row("J0","approved",1),row("J0",status,2),row("R1","approved")]).status).toBe(status);
    }
  });
  it("shows the last sent step after the entire sequence is sent", () => {
    const initial={...row("J0","smtp_accepted"),technical_confirmation:true,smtp_accepted_at:"2026-10-20T09:00:00Z"};
    const last={...row("R5","sent_manually"),technical_confirmation:true,sent_at:"2026-10-29T09:00:00Z"};
    expect(sequenceStatus([initial,row("J0","draft",5),last,row("R5","draft",5)])).toEqual({status:"sent_manually",lastSentAt:last.sent_at});
  });
  it("returns no invented status before any message exists", () => {
    expect(sequenceStatus([])).toEqual({status:null,lastSentAt:null});
  });
});
