import { cleanup,render,screen } from "@testing-library/react";
import { afterEach,expect,it } from "vitest";
import { EngagementStats } from "./EngagementStats";
afterEach(cleanup);
it("marks missing reading measurements as unavailable rather than zero",()=>{
 render(<EngagementStats/>);
 expect(screen.getAllByText("Indisponible")).toHaveLength(3);
 expect(screen.getByText(/Aucune chronologie disponible/)).toBeInTheDocument();
 expect(screen.queryByText("0 s")).not.toBeInTheDocument();
});
it("labels repeated pixel requests and the experimental delay without calling them reading time",()=>{
 render(<EngagementStats metrics={{measuredMessages:10,observedMessages:3,openRequests:9,repeatedOpenMessages:2,proxyOpenRequests:5,automatedOpenRequests:1,directOpenRequests:2,meanOpenIntervalSeconds:120,delaySamples:1,meanOpenToClickSeconds:30}}/>);
 expect(screen.getByText("2 min")).toBeInTheDocument();expect(screen.getByText("30 s")).toBeInTheDocument();
 expect(screen.getByText("Aucune durée exploitable")).toBeInTheDocument();
 expect(screen.getByText(/1 origine inconnue/)).toBeInTheDocument();
});

it("separates uncapped reading samples, capped connections and exclusions",()=>{
 render(<EngagementStats metrics={{measuredMessages:10,observedMessages:3,openRequests:9,repeatedOpenMessages:2,proxyOpenRequests:5,automatedOpenRequests:1,directOpenRequests:2,meanOpenIntervalSeconds:120,delaySamples:1,meanOpenToClickSeconds:30,
 reading:{enabledMessages:10,attemptedMessages:8,samples:3,measuredProspects:2,meanSeconds:17.4,cappedSamples:1,incompatibleMessages:3,failedMessages:1,budgetLimitedMessages:0}}}/>);
 expect(screen.getByText("17 s")).toBeInTheDocument();
 expect(screen.getByText(/1 connexions d’au moins 50 s, hors moyenne/)).toBeInTheDocument();
 expect(screen.getByText("Moyenne des durées non plafonnées")).toBeInTheDocument();
});
it("never reports an exact 50 second mean when all readings are censored",()=>{
 render(<EngagementStats metrics={{measuredMessages:1,observedMessages:1,openRequests:1,repeatedOpenMessages:0,proxyOpenRequests:0,automatedOpenRequests:0,directOpenRequests:1,meanOpenIntervalSeconds:null,delaySamples:0,meanOpenToClickSeconds:null,
 reading:{enabledMessages:1,attemptedMessages:1,samples:0,measuredProspects:0,meanSeconds:null,cappedSamples:1,incompatibleMessages:0,failedMessages:0,budgetLimitedMessages:0}}}/>);
 expect(screen.getByText("≥ 50 s")).toBeInTheDocument();expect(screen.queryByText("50 s")).not.toBeInTheDocument();
});
