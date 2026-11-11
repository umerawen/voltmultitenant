// Runs before every build. Fails it if a component calls a React hook after an
// early return, e.g.
//
//   if (!state) return <Loading />;
//   useEffect(...)            // <- one more hook on the next render: React throws
//
// That mistake renders fine while loading and then takes the whole screen down
// ("Rendered more hooks than during the previous render"), which is how the
// tournament view went blank on 11 Nov 2026. The build can't see it; this can.
import { createRequire } from "module";
import fs from "fs";

const FILES = ["src/App.jsx", "src/tournament.jsx"];
const require = createRequire(import.meta.url);
let parser, traverse;
try {
  parser = require("@babel/parser");
  traverse = require("@babel/traverse").default;
} catch (e) {
  // Both ship with @vitejs/plugin-react. If that ever changes, don't block the build over it.
  console.warn("check-hooks: skipped (Babel not found)");
  process.exit(0);
}

const problems = [];
for (const file of FILES) {
  if (!fs.existsSync(file)) continue;
  const ast = parser.parse(fs.readFileSync(file, "utf8"), { sourceType: "module", plugins: ["jsx"] });
  traverse(ast, {
    Function(p) {
      const body = p.node.body;
      if (!body || body.type !== "BlockStatement") return;
      const name = p.node.id?.name || p.parent?.id?.name || "(anonymous)";
      let returnedAt = null;
      for (const st of body.body) {
        if (returnedAt) {
          // A hook called directly by this function, not by a function nested in it.
          let hook = null;
          traverse(st, { noScope: true,
            Function(q) { q.skip(); },
            CallExpression(q) {
              const c = q.node.callee;
              if (c.type === "Identifier" && /^use[A-Z]/.test(c.name)) { hook = `${c.name} (line ${q.node.loc.start.line})`; q.stop(); }
            },
          }, p.scope, p);
          if (hook) { problems.push(`${file}: ${name} calls ${hook} after the early return on line ${returnedAt}`); break; }
          continue;
        }
        if (st.type === "ReturnStatement") returnedAt = st.loc.start.line;
        else if (st.type === "IfStatement") {
          let returns = false;
          traverse(st, { noScope: true, Function(q) { q.skip(); }, ReturnStatement() { returns = true; } }, p.scope, p);
          if (returns) returnedAt = st.loc.start.line;
        }
      }
    },
  });
}

if (problems.length) {
  console.error("check-hooks: hooks must come before a component's early returns.\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log("check-hooks: ok");
