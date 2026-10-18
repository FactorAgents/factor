import { redirect } from "next/navigation";

// The firms are listed with the agents: there is no page of their own for the list.
export default function Firms() {
  redirect("/agents#firms");
}
