/** Read endpoint branches from the implementation, keeping step markers as navigation targets. */

/** Read the bodies owning step markers, including router callbacks, with the CLI flow reader. */
export function endpointFlow(source, endpoint, { buildFunctionFlow, removeOwnerBlocks, readRouteBlocks, tokenize }, layout = 'hono') {
  const present = new Set(endpoint.steps.map((step) => step.id));
  const code = removeOwnerBlocks(source, (block) => !present.has(block.id));
  const blocks = readRouteBlocks(code);
  if (blocks.length === 0) return undefined;
  const { tokens } = tokenize(code, 0, code.length);
  const pairs = new Map();
  const stack = [];
  tokens.forEach((token, index) => {
    if (token.type !== 'punct') return;
    if (['(', '[', '{'].includes(token.text)) stack.push(index);
    else if ([')', ']', '}'].includes(token.text)) {
      const open = stack.pop();
      if (open !== undefined) pairs.set(open, index);
    }
  });
  const bodies = new Map();
  tokens.forEach((token, index) => {
    if (token.text === '{' && tokens[index - 1]?.text === '=>') {
      const before = code.slice(Math.max(0, token.start - 120), token.start);
      const method = /\.(get|post|put|patch|delete)\(['"]([^'"]*)['"][^\n]*=>\s*$/i.exec(before);
      bodies.set(index, method ? `${method[1].toUpperCase()} ${method[2]}` : endpoint.methods.join(' | '));
    }
    if (token.type === 'word' && token.text === 'function') {
      let open = index + 1;
      while (open < tokens.length && tokens[open].text !== '(') open += 1;
      let body = (pairs.get(open) ?? tokens.length) + 1;
      while (body < tokens.length && tokens[body].text !== '{') body += 1;
      if (body < tokens.length) bodies.set(body, tokens[index + 1]?.text ?? endpoint.label);
    }
  });
  const handlers = new Map();
  for (const block of blocks) {
    const owner = [...bodies.keys()].filter((open) => tokens[open].start < block.index && tokens[pairs.get(open)]?.end > block.index).sort((a, b) => b - a)[0];
    if (owner === undefined) continue;
    const owned = handlers.get(owner) ?? [];
    owned.push(block);
    handlers.set(owner, owned);
  }
  const nodes = [];
  const edges = [];
  for (const [open, owned] of handlers) {
    const start = tokens[open].start;
    const end = tokens[pairs.get(open)].end;
    const names = new Map();
    const replacements = [];
    if (layout === 'hono') {
      for (const step of endpoint.steps) names.set(step.function, step.id);
    } else {
      // Name a call in each inline block, preserving surrounding branches and exits.
      owned.forEach((block, index) => {
        const stop = owned[index + 1]?.index ?? end;
        const call = tokens.findIndex((token, position) => token.start >= block.start && token.end < stop && token.type === 'word' && !['if', 'for', 'while', 'switch', 'catch', 'return', 'throw', 'typeof', 'await'].includes(token.text) && tokens[position + 1]?.text === '(' && (!(tokens[position - 1]?.text === '.' || tokens[position - 1]?.text === '?.') || tokens[position - 2]?.type === 'word'));
        const name = `__map_step_${index}`;
        names.set(name, block.id);
        if (call >= 0) {
          let receiver = call;
          while (tokens[receiver - 1]?.text === '.' || tokens[receiver - 1]?.text === '?.') receiver -= 2;
          if (tokens[receiver - 1]?.text === 'new') receiver -= 1;
          replacements.push({ start: tokens[receiver].start, end: tokens[call].end, text: name });
        } else replacements.push({ start: block.start, end: block.start, text: `\n${name}();` });
      });
    }
    let text = code.slice(start, end);
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
      text = text.slice(0, replacement.start - start) + replacement.text + text.slice(replacement.end - start);
    }
    const method = bodies.get(open);
    const flow = buildFunctionFlow({ source: text, body: { start: 0, end: text.length }, name: method, parameters: '', resolve: (name) => names.has(name) ? `step:${names.get(name)}` : undefined });
    if (!flow) throw new Error(`Cannot read control flow of ${endpoint.id}: ${method}`);
    const prefix = `h${nodes.length}:`;
    for (const node of flow.nodes) {
      const step = node.callee?.startsWith('step:') ? node.callee.slice(5) : undefined;
      nodes.push({ ...node, id: prefix + node.id, ...(step === undefined ? {} : { step }) });
    }
    for (const edge of flow.edges) edges.push({ ...edge, from: prefix + edge.from, to: prefix + edge.to });
  }
  return nodes.length === 0 ? undefined : { nodes, edges };
}
