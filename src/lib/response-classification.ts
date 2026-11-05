import type {ResponseClassification} from "../types";

export const responseLabels:Record<ResponseClassification,string>={
 positive:"Réponse positive",negative:"Refus",information:"Information",meeting:"Rendez-vous",
 ambiguous:"À clarifier",opposition:"Ne plus contacter",automatic_reply:"Réponse automatique",
 out_of_office:"Absence",bounce:"Échec de livraison",unrelated:"Hors sujet"
};

export function responseIsClosed(classification:ResponseClassification|null|undefined):boolean {
 return !!classification&&["negative","opposition","unrelated","automatic_reply","out_of_office","bounce"].includes(classification);
}
