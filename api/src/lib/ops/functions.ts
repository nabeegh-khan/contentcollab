// The serverless function card of the Operations page (D39): whether a function is configured and the
// last invocations, newest first, from the Redis list every API replica writes to.
import type { Invocation } from "../functionDiff.js";

export interface FunctionsCard {
  configured: boolean;
  invocations: Invocation[];
}
