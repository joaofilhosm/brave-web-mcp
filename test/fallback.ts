import { webSearch } from "../src/search.js";
import { duckduckgoSearch } from "../src/duckduckgo.js";

// 1) DDG directly, with no Brave key in play
const ddg = await duckduckgoSearch("model context protocol", 5);
console.log("[ddg] results:", ddg.length);
for (const r of ddg) console.log("   -", r.title.slice(0, 60), "|", r.url.slice(0, 50));

// 2) Unified search with an invalid Brave key -> must fall back to DDG
const outcome = await webSearch("model context protocol", "web", {
  count: 5,
  searchLang: "pt-br",
  country: "BR",
});
console.log("\n[unified] engine:", outcome.engine);
console.log("[unified] results:", outcome.results.length);
console.log("[unified] fallbackReason:", outcome.fallbackReason ?? "(none)");
for (const r of outcome.results) console.log("   -", r.title.slice(0, 60));
