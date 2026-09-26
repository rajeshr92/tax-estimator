// Builds dist/index.html from src/App.jsx.
// JSX is compiled ahead of time with esbuild (no in-browser Babel); React loads from cdnjs.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { transformSync } from "esbuild";

let src = readFileSync("src/App.jsx", "utf8");
// React comes from the UMD globals loaded in the page shell
src = src.replace(/^import React.*$/m, "const { useState, useEffect, useRef, useMemo } = React;");
src = src.replace("export default function App()", "function App()");
src += '\n\nReactDOM.createRoot(document.getElementById("root")).render(<App />);\n';

const { code } = transformSync(src, { loader: "jsx", target: "es2018" });
const html =
  readFileSync("src/shell-head.html", "utf8") + code + readFileSync("src/shell-tail.html", "utf8");

mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", html);
console.log(`dist/index.html written (${html.length} bytes)`);
