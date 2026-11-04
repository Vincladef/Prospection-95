import {beforeEach,afterEach,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen,waitFor,within} from "@testing-library/react";
import {MailboxView} from "./MailboxView";
import {api} from "../lib/api";
import type {MailboxDetail,MailboxPage,MailboxThread,Campaign} from "../types";
vi.mock("../lib/api",()=>({api:{mailbox:vi.fn(),mailboxDetail:vi.fn(),mailboxState:vi.fn(),mailboxDraft:vi.fn(),mailboxSend:vi.fn(),mailboxRefresh:vi.fn()}}));
const t:MailboxThread={id:"thread-1",accountId:"account-1",accountEmail:"sender@example.test",conversationId:null,prospectId:null,campaignId:"campaign-1",campaignName:"Campagne test",name:"Alice Exemple",email:"alice@example.test",organization:"Organisation test",subject:"Re: Proposition",category:"normal",archived:false,unread:false,priority:false,needsReply:true,version:1,lastMessageId:"message-1",lastMessageAt:"2026-11-04T09:00:00Z",snippet:"Votre proposition m’intéresse.",lastDirection:"inbound",lastSyncedAt:null,syncError:null,pendingSync:0};
const page:MailboxPage={threads:[t],total:1,page:1,counts:{inbox:1,action:1,waiting:0,archive:0,other:0,unread:0},accounts:[{id:"account-1",email:t.accountEmail,status:"active",lastSyncAt:null,lastErrorCode:null,lastUid:"0",caughtUpAt:null}]};
function detail(thread=t):MailboxDetail{return {thread:{...thread,gmailUrl:"https://mail.google.com/mail/u/?authuser=sender%40example.test#all/112210f47de98115",draftBody:"",draftVersion:1,draftSyncedVersion:0,draftRemoteBody:null,canReply:true,followupsStoppedAt:"2026-11-04T09:00:00Z",nextFollowupAt:null},messages:[{id:"message-1",direction:"inbound",kind:"reply",subject:t.subject,body:t.snippet,from:t.email,to:[t.accountEmail],cc:[],status:"received",at:t.lastMessageAt}],hasOlder:false,send:null};}
const renderView=()=>render(<MailboxView campaigns={[{id:"campaign-1",name:"Campagne test"} as Campaign]} onOpenCampaign={vi.fn()} onOpenProspect={vi.fn()}/>);
afterEach(()=>cleanup());
beforeEach(()=>{vi.resetAllMocks();sessionStorage.clear();vi.mocked(api.mailbox).mockResolvedValue(page);vi.mocked(api.mailboxDetail).mockResolvedValue(detail());vi.mocked(api.mailboxRefresh).mockResolvedValue({});vi.mocked(api.mailboxState).mockResolvedValue({version:2});vi.mocked(api.mailboxDraft).mockResolvedValue({version:2});vi.mocked(api.mailboxSend).mockResolvedValue({id:"job",status:"pending"});});
it("shows the reply inline with its Gmail sender and no modal",async()=>{
 renderView();expect(await screen.findByRole("textbox",{name:"Votre réponse"})).toBeInTheDocument();
 expect(screen.queryByRole("dialog")).not.toBeInTheDocument();expect(screen.getByText("Depuis")).toHaveTextContent("sender@example.test");
 expect(screen.getByText("Votre proposition m’intéresse.",{selector:".message-body"})).toBeInTheDocument();
});
it("labels sent and received messages separately throughout the conversation history",async()=>{
 const d=detail();const received=d.messages[0];
 d.messages=[{...received,id:"sent-1",direction:"outbound",kind:"manual",from:t.accountEmail,to:[t.email],body:"Notre proposition",status:"sent_manually"},received];
 vi.mocked(api.mailboxDetail).mockResolvedValue(d);renderView();
 await screen.findByRole("article",{name:"Message reçu"});
 fireEvent.click(screen.getByRole("button",{name:/Afficher les messages précédents/}));
 expect(within(screen.getByRole("article",{name:"Message envoyé"})).getByText("↗ Envoyé")).toBeInTheDocument();
 expect(within(screen.getByRole("article",{name:"Message envoyé"})).getByText("Vous")).toBeInTheDocument();
 expect(within(screen.getByRole("article",{name:"Message reçu"})).getByText("↙ Reçu")).toBeInTheDocument();
});
it("opens the corresponding Gmail conversation in a separate tab",async()=>{
 renderView();const link=await screen.findByRole("link",{name:"Ouvrir dans Gmail ↗"});
 expect(link).toHaveAttribute("href",detail().thread.gmailUrl);
 expect(link).toHaveAttribute("target","_blank");expect(link).toHaveAttribute("rel","noopener noreferrer");
});
it("disables the Gmail shortcut when no reliable conversation link exists yet",async()=>{
 const d=detail();d.thread.gmailUrl=null;vi.mocked(api.mailboxDetail).mockResolvedValue(d);renderView();
 expect(await screen.findByRole("button",{name:"Ouvrir dans Gmail ↗"})).toBeDisabled();
 expect(screen.queryByRole("link",{name:"Ouvrir dans Gmail ↗"})).not.toBeInTheDocument();
});
it("combines campaign and Gmail filters instead of clearing one",async()=>{
 renderView();await screen.findByRole("textbox",{name:"Votre réponse"});
 fireEvent.change(screen.getByLabelText("Filtrer les conversations par campagne"),{target:{value:"campaign-1"}});
 fireEvent.change(screen.getByLabelText("Filtrer les conversations par adresse Gmail"),{target:{value:"account-1"}});
 await waitFor(()=>{const params=vi.mocked(api.mailbox).mock.calls.at(-1)![0];expect(params.get("campaign")).toBe("campaign-1");expect(params.get("account")).toBe("account-1");});
});
it("automatically saves the real draft after editing",async()=>{
 renderView();const editor=await screen.findByRole("textbox",{name:"Votre réponse"});fireEvent.change(editor,{target:{value:"Bonjour Alice"}});
 await waitFor(()=>expect(api.mailboxDraft).toHaveBeenCalledWith(t.id,1,"Bonjour Alice"),{timeout:2500});
 expect(editor).toHaveValue("Bonjour Alice");expect(await screen.findByText("Brouillon enregistré.")).toBeInTheDocument();
});
it("flushes the correct thread draft when changing conversation",async()=>{
 const second={...t,id:"thread-2",name:"Bob Exemple",email:"bob@example.test"};
 vi.mocked(api.mailbox).mockResolvedValue({...page,threads:[t,second],total:2});vi.mocked(api.mailboxDetail).mockImplementation(async id=>detail(id===t.id?t:second));
 renderView();fireEvent.change(await screen.findByRole("textbox",{name:"Votre réponse"}),{target:{value:"Réponse pour Alice"}});
 fireEvent.click(screen.getByRole("button",{name:/Bob Exemple/}));
 await waitFor(()=>expect(api.mailboxDraft).toHaveBeenCalledWith(t.id,1,"Réponse pour Alice"));
 expect(await screen.findByRole("textbox",{name:"Votre réponse"})).toHaveValue("");
});
it("waits for draft persistence and sends with the new version and parent identity",async()=>{
 renderView();fireEvent.change(await screen.findByRole("textbox",{name:"Votre réponse"}),{target:{value:"Réponse"}});
 fireEvent.click(screen.getByRole("button",{name:"Envoyer ↗"}));
 await waitFor(()=>expect(api.mailboxSend).toHaveBeenCalledWith(t.id,2,"message-1",expect.any(String)));
 expect(vi.mocked(api.mailboxDraft).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.mailboxSend).mock.invocationCallOrder[0]);
});
it("keeps an unsaved response when persistence fails and never sends it",async()=>{
 vi.mocked(api.mailboxDraft).mockRejectedValue(new Error("Conflit de brouillon"));renderView();
 const editor=await screen.findByRole("textbox",{name:"Votre réponse"});fireEvent.change(editor,{target:{value:"Texte à conserver"}});fireEvent.click(screen.getByRole("button",{name:"Envoyer ↗"}));
 expect(await screen.findByRole("alert")).toHaveTextContent("Conflit de brouillon");expect(editor).toHaveValue("Texte à conserver");expect(api.mailboxSend).not.toHaveBeenCalled();
});
it("protects a pending or uncertain send from a second click",async()=>{
 vi.mocked(api.mailboxDetail).mockResolvedValue({...detail(),send:{id:"job",status:"uncertain",errorCode:"timeout",body:"Réponse"}});
 renderView();expect(await screen.findByRole("button",{name:"Envoyer ↗"})).toBeDisabled();expect(screen.getByText(/Résultat SMTP incertain/)).toBeInTheDocument();
});
