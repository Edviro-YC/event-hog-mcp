// The Worker entry. workerd rejects named exports that aren't handlers or
// classes once a Durable Object is exported, so index.ts's helpers stay out.
export { default } from "./index";
export { Team } from "./team-do";
