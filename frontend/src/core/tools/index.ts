import { mcpTools } from "../mcp";
import { annotationTools } from "./annotation-tools";
import type { Tool, ToolContext } from "./common";
import { kbTools } from "./kb-tools";
import { libraryTools } from "./library-tools";
import { paperTools } from "./paper-tools";
import { visionTools } from "./vision-tools";
import { webTools } from "./web-tools";

export type { ToolContext } from "./common";

/**
 * `mcpTools()` returns whatever `ensureMcp()` discovered: the built-in academic bridge is
 * always rebuilt synchronously, external servers only after their handshake, so building a
 * runtime never waits on the network.
 */
export function buildTools(ctx: ToolContext): Tool[] {
  return [...paperTools(ctx), ...visionTools(ctx), ...annotationTools(ctx), ...libraryTools(ctx), ...webTools(ctx), ...kbTools(ctx), ...mcpTools()];
}
