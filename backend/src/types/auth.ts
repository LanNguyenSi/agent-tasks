export type ActorType = "human" | "agent";

export interface HumanActor {
  type: "human";
  userId: string;
  teamId?: string;
  role?: "ADMIN" | "HUMAN_MEMBER" | "REVIEWER";
}

export interface AgentActor {
  type: "agent";
  tokenId: string;
  teamId: string;
  scopes: string[];
}

export type Actor = HumanActor | AgentActor;

export interface SessionData {
  userId: string;
  githubAccessToken: string;
}
