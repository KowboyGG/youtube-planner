// Инструменты MCP для Claude. Наполняется на следующих шагах.
export const TOOLS = [];
export async function makeToolContext(env, ctx) {
  return {env, ctx};
}
