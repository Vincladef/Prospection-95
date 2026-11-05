import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {BobworkHistoryChart} from "./BobworkHistoryChart";
beforeEach(()=>{vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));});
afterEach(()=>{cleanup();vi.useRealTimers();});
const email="sender@example.test";
const points=[{at:"2026-10-20T06:00:00Z",spamRate7d:0,sent7d:5,errors7d:0},{at:"2026-11-04T06:00:00Z",spamRate7d:10.2,sent7d:20,errors7d:2}];
it("switches between spam, volumes and errors and allows keyboard inspection of observations",()=>{
 render(<BobworkHistoryChart points={points} accountEmail={email}/>);
 expect(screen.getByText("10,2 %")).toBeInTheDocument();
 fireEvent.change(screen.getByRole("slider"),{target:{value:"0"}});expect(screen.getByText("0 %",{selector:"b"})).toBeInTheDocument();
 fireEvent.change(screen.getByRole("combobox",{name:`Indicateur BobWork de ${email}`}),{target:{value:"sent7d"}});
 expect(screen.getByText("20",{selector:"b"})).toBeInTheDocument();
 fireEvent.change(screen.getByRole("combobox",{name:`Indicateur BobWork de ${email}`}),{target:{value:"errors7d"}});
 expect(screen.getByText("2",{selector:"b"})).toBeInTheDocument();
});
it("filters the actual observation dates and does not invent a trend from a single point",()=>{
 render(<BobworkHistoryChart points={points} accountEmail={email}/>);
 fireEvent.change(screen.getByRole("combobox",{name:`Période BobWork de ${email}`}),{target:{value:"7"}});
 expect(document.querySelectorAll("circle")).toHaveLength(1);expect(screen.getByText(/Une seule mesure/)).toBeInTheDocument();
});
it("does not connect through missing measurements or replace them with zeros",()=>{
 render(<BobworkHistoryChart points={[points[0],{at:"2026-10-25T06:00:00Z",spamRate7d:null,sent7d:null,errors7d:null},points[1]]} accountEmail={email}/>);
 expect(document.querySelectorAll("polyline")).toHaveLength(2);expect(document.querySelectorAll("circle")).toHaveLength(2);
});
it("clearly reports an empty history",()=>{
 render(<BobworkHistoryChart points={[]} accountEmail={email}/>);
 expect(screen.getByText(/Une donnée absente n’est pas un zéro/)).toBeInTheDocument();expect(screen.queryByRole("img")).not.toBeInTheDocument();
});
