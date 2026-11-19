/**
 * A TS/JS call through a parameter whose default names another binding:
 * `function PlansApp({ api = plansApi })`, then `api.create(id)` in it or in a
 * function nested in it. Wherever the caller passes nothing for the parameter
 * — a React component rendered without the prop — the call runs
 * `plansApi.create`, and the default is the one binding the source writes for
 * it. So the call is resolved as if written on the default.
 *
 * A call site that passes something else (a test's fake) isn't seen; the
 * parameter's own default is still what the code says it holds. A receiver
 * that a declaration in between could rebind, or a nearer parameter without a
 * default binds, gets nothing from here.
 */
import type { Node } from '../types';
import type { ResolutionContext, UnresolvedRef } from './types';
import { escapeRegExp } from '../utils';

const JS_LANGUAGES: ReadonlySet<string> = new Set(['typescript', 'tsx', 'javascript', 'jsx']);
const MEMBER_CALL = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/;

/**
 * `default.member` for a call `receiver.member` whose receiver is a parameter
 * defaulting to an identifier, or null.
 */
export function jsParamDefaultReceiver(ref: UnresolvedRef, context: ResolutionContext): string | null {
  if (ref.referenceKind !== 'calls' || !JS_LANGUAGES.has(ref.language)) return null;
  const m = MEMBER_CALL.exec(ref.referenceName);
  if (!m) return null;
  const [, receiver, member] = m as unknown as [string, string, string];
  if (receiver === 'this') return null;
  // Only defs around the call that mention the name in their parameters can bind it.
  const around = context.getNodesInFile(ref.filePath)
    .filter((n: Node) => n.startLine <= ref.line && n.endLine >= ref.line && !!n.signature?.includes(receiver) &&
      (n.kind === 'function' || n.kind === 'method' || n.kind === 'component'))
    .sort((a, b) => b.startLine - a.startLine);
  const r = escapeRegExp(receiver);
  // The parameter as a list item: `api`, `api = x`, in `(…)` or a `{…}` pattern; `key: api` renames are not it.
  const param = new RegExp(String.raw`(?:^|[({,])\s*${r}\s*(?:=\s*([A-Za-z_$][\w$]*)\s*)?(?=[,)}]|$)`);
  for (const fn of around) {
    const hit = fn.signature ? param.exec(fn.signature) : null;
    if (!hit) continue;
    const fallback = hit[1];
    if (!fallback || fallback === receiver) return null;
    const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/) ?? [];
    // Any other assignment or declaration of the name; the default itself may sit on a signature's later line.
    const rebinds = new RegExp(String.raw`\b(?:const|let|var|function|class)\b[^=;]*(?<![\w$.])${r}(?![\w$])|(?<![\w$.])${r}\s*=(?!=)(?!\s*${escapeRegExp(fallback)}(?![\w$]))`);
    for (let i = fn.startLine; i < ref.line; i++) if (rebinds.test(lines[i] ?? '')) return null;
    return `${fallback}.${member}`;
  }
  return null;
}
