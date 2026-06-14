import fs from "node:fs";

const file = "F:\\opencodeproject\\wechat-opencode\\src\\__tests__\\verify-display-commands.mjs";
let content = fs.readFileSync(file, "utf-8");
// Collapse "sm["flushNowForTest"]();\n    sm["flushNowForTest"]();"
// (double-injected) into a single call.
const doubled = /    sm\["flushNowForTest"\]\(\);\r?\n    sm\["flushNowForTest"\]\(\);\r?\n/g;
let count = 0;
content = content.replace(doubled, "    sm[\"flushNowForTest\"]();\r\n");
fs.writeFileSync(file, content, "utf-8");
console.log("Deduplicated " + count + " double-injections");
