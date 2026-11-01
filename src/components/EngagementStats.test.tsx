import { cleanup,render,screen } from "@testing-library/react";
import { afterEach,expect,it } from "vitest";
import { EngagementStats } from "./EngagementStats";
afterEach(cleanup);
it("marks missing reading measurements as unavailable rather than zero",()=>{
 render(<EngagementStats/>);
 expect(screen.getAllByText("Indisponible")).toHaveLength(2);
 expect(screen.getByText(/Aucune chronologie disponible/)).toBeInTheDocument();
 expect(screen.queryByText("0 s")).not.toBeInTheDocument();
});
it("labels repeated pixel requests and the experimental delay without calling them reading time",()=>{
 render(<EngagementStats metrics={{measuredMessages:10,observedMessages:3,openRequests:9,repeatedOpenMessages:2,proxyOpenRequests:5,automatedOpenRequests:1,directOpenRequests:2,meanOpenIntervalSeconds:120,delaySamples:1,meanOpenToClickSeconds:30}}/>);
 expect(screen.getByText("2 min")).toBeInTheDocument();expect(screen.getByText("30 s")).toBeInTheDocument();
 expect(screen.getByText(/lecture réelle indisponible/)).toBeInTheDocument();
 expect(screen.getByText(/1 origine inconnue/)).toBeInTheDocument();
});
