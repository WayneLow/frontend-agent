// Thin WebMCP registry.
//
// Tools are registered with the native `document.modelContext` when the browser
// supports WebMCP (so browser-level agents can see them too), and kept in a local
// map so our own in-page agent can list and execute them in every browser.

const tools = new Map();

export function registerTool(tool) {
  tools.set(tool.name, tool);
  try {
    document.modelContext?.registerTool?.(tool);
  } catch (err) {
    console.warn(`[webmcp] native registerTool failed for ${tool.name}:`, err);
  }
}

export function listTools() {
  return [...tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export async function executeTool(name, args) {
  const tool = tools.get(name);
  if (!tool) return { status: 'error', message: `Unknown tool "${name}"` };
  try {
    return await tool.execute(args ?? {});
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

export const hasNativeWebMCP = () => Boolean(document.modelContext?.registerTool);
