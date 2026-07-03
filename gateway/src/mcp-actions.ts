import { z } from "zod";

// Shared scaffolding for the in-process MCP action servers (browser/mcp.ts and
// computer/mcp.ts): result shapes, the action-spec registry types, and the
// batch execution loop. Each server keeps its own ACTION_SPECS, tool
// names/descriptions, and final result rendering — this module owns only the
// plumbing that must not drift between them.

export type ToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ToolResult = { content: ToolResultContent[]; isError?: boolean };

export function errorResult(error: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
    isError: true,
  };
}

/** Structural screenshot shape so both BrowserScreenshot and Screenshot fit. */
export function shotContent(shot: {
  base64: string;
  width: number;
  height: number;
}): ToolResultContent[] {
  return [
    { type: "text", text: `Screenshot (${shot.width}x${shot.height}):` },
    { type: "image", data: shot.base64, mimeType: "image/png" },
  ];
}

export type ActionSpec<Control, Shape extends z.ZodRawShape> = {
  name: string;
  description: string;
  shape: Shape;
  /** Perform the action; returns a one-line note for the result text. */
  perform: (
    control: Control,
    args: z.infer<z.ZodObject<Shape>>,
  ) => Promise<string>;
};

/** What a heterogeneous const tuple of ActionSpecs widens to: perform's args
 * parameter collapses to never under the union, which is fine — runAction
 * validates args against the spec's own shape before calling. */
export type AnyActionSpec<Control> = {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  perform: (control: Control, args: never) => Promise<string>;
};

/** Curried identity helper: keeps each spec's Shape narrow inside a const
 * tuple while pinning the Control type once per registry. */
export function defineSpec<Control>() {
  return <Shape extends z.ZodRawShape>(
    s: ActionSpec<Control, Shape>,
  ): ActionSpec<Control, Shape> => s;
}

export function actionNames(
  specs: readonly { name: string }[],
): [string, ...string[]] {
  return specs.map((s) => s.name) as [string, ...string[]];
}

export async function runAction<Control>(
  control: Control,
  actionSpec: AnyActionSpec<Control>,
  args: unknown,
): Promise<string> {
  const parsed = z.object(actionSpec.shape).parse(args);
  // The registries are heterogeneous const tuples, so calling perform through
  // the union collapses its parameter to never; parse() above already
  // validated args against this spec's own shape.
  return await actionSpec.perform(control, parsed as never);
}

/** Run a batch's actions in order, stopping at the first failure. Returns the
 * numbered summary (with a "FAILED at step N" line when applicable) and the
 * failure itself so the caller can render its own trailing content. */
export async function runBatch<Control>(
  control: Control,
  specs: readonly AnyActionSpec<Control>[],
  items: ReadonlyArray<{ action: string } & Record<string, unknown>>,
): Promise<{ summary: string; failure: unknown }> {
  const notes: string[] = [];
  let failure: unknown = null;
  for (const item of items) {
    const actionSpec = specs.find((s) => s.name === item.action);
    if (actionSpec === undefined) {
      failure = new Error(`unknown action "${item.action}"`);
      break;
    }
    try {
      const { action: _action, ...rest } = item;
      notes.push(await runAction(control, actionSpec, rest));
    } catch (error) {
      failure = error;
      break;
    }
  }
  const summary = [
    ...notes.map((note, i) => `${i + 1}. ${note}`),
    ...(failure === null
      ? []
      : [
          `FAILED at step ${notes.length + 1}: ${
            failure instanceof Error ? failure.message : String(failure)
          }`,
        ]),
  ].join("\n");
  return { summary, failure };
}
