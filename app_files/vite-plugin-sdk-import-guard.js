/**
 * Vite Plugin: OverSkill SDK Import Guard
 *
 * Apr 2026 (Todd's QA): the AI keeps hallucinating `useEntity` / `useEntities`
 * imports from `overskill-sdk`. Neither symbol is exported. Without this
 * guard, Vite happily transforms the (broken) import, the JS executes,
 * `useEntity is not defined` blows up at runtime, and the user sees a
 * blank screen with no helpful error.
 *
 * This plugin catches the hallucinated imports at TRANSFORM TIME and
 * throws a clear error pointing at the offending file + line, plus the
 * canonical fix. The agent prompt's BLOCKED IMPORTS section already
 * documents this; the plugin is the second layer of defense for cases
 * where the AI ignores the prompt.
 *
 * Hooked symbols:
 *   - useEntity, useEntities  → don't exist; use overskill.entities.X.list()
 *   - entities                → not a top-level export; same fix
 *
 * The valid exports from overskill-sdk are: createClient, OverSkillClient,
 * HttpClient, AuthClient, EntityClient, AuthContext, AuthProvider, useAuth.
 *
 * Failure mode: throws via `this.error()` which Vite formats with a
 * code frame, file path, and line number — exactly what the AI needs to
 * self-correct on the next iteration.
 */

const FORBIDDEN_NAMED_IMPORTS = ['useEntity', 'useEntities', 'entities'];
const FORBIDDEN_RE = new RegExp(
  `import\\s*\\{[^}]*\\b(${FORBIDDEN_NAMED_IMPORTS.join('|')})\\b[^}]*\\}\\s*from\\s*['"]overskill-sdk['"]`,
  'g'
);

const FIX_MESSAGE = `
  ❌ \`{ useEntity }\`, \`{ useEntities }\`, and \`{ entities }\` are NOT exported by overskill-sdk.

  ✅ The canonical pattern is:

      import { overskill } from '@/lib/auth'

      // Inside a component:
      const [items, setItems] = useState([])
      useEffect(() => {
        overskill.entities.todoItem.list().then(setItems)
      }, [])

  Valid named exports from 'overskill-sdk' are:
    createClient, OverSkillClient (type), HttpClient, AuthClient,
    EntityClient, AuthContext, AuthProvider, useAuth.

  See agent-prompt.txt → "SDK IMPORT ANTI-PATTERNS" for more.
`.trim();

export default function overskillSdkImportGuard() {
  return {
    name: 'overskill-sdk-import-guard',
    enforce: 'pre',

    transform(code, id) {
      // Only check user source files. Skip node_modules, the SDK itself,
      // and non-JS/TS files.
      if (id.includes('/node_modules/')) return null;
      if (!/\.(t|j)sx?$/.test(id)) return null;

      // May 2026 fix: strip comments before regex-matching so we don't
      // false-positive on documentation/JSDoc that *describes* the wrong
      // pattern (e.g. Dashboard.tsx canonical-example block listing
      // anti-patterns to avoid). Replace comment ranges with whitespace
      // of the same length so offset/line math below stays accurate.
      const stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => m.replace(/./g, ' '));

      // Reset the regex's lastIndex (global flag is stateful).
      FORBIDDEN_RE.lastIndex = 0;
      const match = FORBIDDEN_RE.exec(stripped);
      if (!match) return null;

      // Compute line/column for the matched import — Vite's `this.error`
      // accepts a position object and renders a code frame.
      const offset = match.index;
      const before = stripped.slice(0, offset);
      const line = before.split('\n').length;
      const lastNewline = before.lastIndexOf('\n');
      const column = lastNewline === -1 ? offset : offset - lastNewline - 1;

      const badName = match[1];
      const message =
        `[overskill-sdk-import-guard] '${badName}' is not an export of 'overskill-sdk'.\n\n` +
        FIX_MESSAGE;

      // `this.error` throws and Vite displays the frame nicely.
      this.error({
        message,
        loc: { line, column },
      });
      // Unreachable — this.error throws — but keep TS happy.
      return null;
    },
  };
}
