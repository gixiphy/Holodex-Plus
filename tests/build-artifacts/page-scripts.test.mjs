import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ASSET_REF_RE = /"\/assets\/([^"]+\.js)"/g;

function listInjectedPageScripts(distDir) {
  const assetsDir = path.join(distDir, "assets");
  const names = fs.readdirSync(assetsDir).filter((n) => n.endsWith(".js") && !n.includes("-loader"));
  const injected = new Set();
  for (const name of names) {
    const code = fs.readFileSync(path.join(assetsDir, name), "utf8");
    for (const m of code.matchAll(ASSET_REF_RE)) {
      injected.add(m[1]);
    }
  }
  return injected;
}

function hasTopLevelImportOrExport(code) {
  return /^\s*(import|export)[\s{*]/m.test(code);
}

for (const distName of ["dist_chrome", "dist_firefox"]) {
  const distDir = path.join(REPO_ROOT, distName);

  describe(distName, () => {
    test(
      "dist_has_manifest",
      { timeout: 20000 },
      () => {
        const manifestPath = path.join(distDir, "manifest.json");
        assert.ok(
          fs.existsSync(manifestPath),
          "先執行 yarn build"
        );
        JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      }
    );

    test(
      "finds_injected_page_scripts",
      { timeout: 20000 },
      () => {
        const injected = listInjectedPageScripts(distDir);
        const holodex = [...injected].filter((n) => n.startsWith("holodex-inject.ts-"));
        const ytChat = [...injected].filter((n) => n.startsWith("inject.ts-"));
        assert.equal(holodex.length, 1, `expected exactly one holodex-inject.ts-*; got ${[...injected].join(", ")}`);
        assert.equal(ytChat.length, 1, `expected exactly one inject.ts-*; got ${[...injected].join(", ")}`);
        for (const name of [...holodex, ...ytChat]) {
          assert.ok(
            fs.existsSync(path.join(distDir, "assets", name)),
            `missing on disk: ${name}`
          );
        }
      }
    );

    test(
      "page_scripts_parse_as_classic_script",
      { timeout: 20000 },
      () => {
        const injected = listInjectedPageScripts(distDir);
        const targets = [...injected].filter(
          (n) => n.startsWith("holodex-inject.ts-") || n.startsWith("inject.ts-")
        );
        assert.ok(targets.length >= 2, "expected holodex-inject and yt-chat inject");
        for (const name of targets) {
          const filePath = path.join(distDir, "assets", name);
          const code = fs.readFileSync(filePath, "utf8");
          assert.doesNotThrow(
            () => new vm.Script(code, { filename: name }),
            `vm.Script failed for ${name}`
          );
          assert.ok(!/\bimport\s*\(/.test(code), `${name} contains dynamic import(`);
          assert.ok(!/\bimport\.meta\b/.test(code), `${name} contains import.meta`);
          assert.ok(
            !hasTopLevelImportOrExport(code),
            `${name} has top-level import/export`
          );
        }
      }
    );

    test(
      "page_scripts_are_web_accessible_on_their_site",
      { timeout: 20000 },
      () => {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(distDir, "manifest.json"), "utf8")
        );
        const war = manifest.web_accessible_resources || [];
        const holodexGroup = war.find((g) =>
          (g.matches || []).some((m) => m.includes("*.holodex.net"))
        );
        const youtubeGroup = war.find((g) =>
          (g.matches || []).some((m) => m.includes("*.youtube.com"))
        );
        assert.ok(holodexGroup, "missing holodex.net WAR group");
        assert.ok(youtubeGroup, "missing youtube.com WAR group");

        const injected = listInjectedPageScripts(distDir);
        const holodex = [...injected].find((n) => n.startsWith("holodex-inject.ts-"));
        const ytChat = [...injected].find((n) => n.startsWith("inject.ts-"));
        const holodexRes = holodexGroup.resources || [];
        const youtubeRes = youtubeGroup.resources || [];
        assert.ok(
          holodexRes.some((r) => r === `assets/${holodex}` || r.endsWith(`/${holodex}`) || r === holodex),
          `holodex WAR missing ${holodex}; have ${holodexRes.join(", ")}`
        );
        assert.ok(
          youtubeRes.some((r) => r === `assets/${ytChat}` || r.endsWith(`/${ytChat}`) || r === ytChat),
          `youtube WAR missing ${ytChat}; have ${youtubeRes.join(", ")}`
        );

        for (const group of war) {
          for (const rel of group.resources || []) {
            const abs = path.join(distDir, rel);
            assert.ok(fs.existsSync(abs), `WAR resource missing on disk: ${rel}`);
          }
        }
      }
    );

    test(
      "holodex_page_script_runs_and_sets_flags",
      { timeout: 20000 },
      () => {
        const injected = listInjectedPageScripts(distDir);
        const holodex = [...injected].find((n) => n.startsWith("holodex-inject.ts-"));
        assert.ok(holodex, "holodex-inject page script not found");
        const code = fs.readFileSync(path.join(distDir, "assets", holodex), "utf8");
        const dom = new JSDOM("<!doctype html><head></head><body></body>", {
          url: "https://holodex.net/multiview",
          runScripts: "outside-only",
        });
        const w = dom.window;
        try {
          w.eval(code);
          assert.equal(w.HOLODEX_PLUS_INSTALLED, true);
          assert.equal(w.HOLODEX_PLUS_INSTALLED_V3, true);
          assert.equal(w.ARCHIVE_CHAT_OVERRIDE, true);
          assert.equal(typeof w.__HDX_AUDIO_LOCK_HANDLE__?.dispose, "function");
        } finally {
          try {
            w.__HDX_AUDIO_LOCK_HANDLE__?.dispose();
          } catch {
            /* ignore */
          }
          w.close();
        }
      }
    );
  });
}
