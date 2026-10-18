import fs from 'fs';
import { resolve } from 'path';
import type { Plugin } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
// import type { PluginOption } from 'vite';

// plugin to remove dev icons from prod build
export function stripDevIcons(isDev: boolean) {
  if (isDev) return null

  return {
    name: 'strip-dev-icons',
    resolveId(source: string) {
      return source === 'virtual-module' ? source : null
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
    renderStart(outputOptions: any, inputOptions: any) {
      const outDir = outputOptions.dir
      fs.rm(resolve(outDir, 'dev-icon-32.png'), () => console.log(`Deleted dev-icon-32.png from prod build`))
      fs.rm(resolve(outDir, 'dev-icon-128.png'), () => console.log(`Deleted dev-icon-128.png from prod build`))
    }
  }
}

/**
 * After crxjs emits `?script&module` chunks (ESM, possibly with shared imports),
 * rebuild each listed entry as a standalone classic IIFE and overwrite the chunk
 * contents so traditional `<script type="text/javascript">` injection works.
 */
export function classicPageScripts(entries: string[]): Plugin {
  const entrySet = new Set(entries.map((e) => resolve(e)));
  let root = process.cwd();
  let mode = 'production';
  let minify: boolean | 'esbuild' | 'terser' = true;
  let define: Record<string, string> | undefined;

  return {
    name: 'classic-page-scripts',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      root = config.root;
      mode = config.mode;
      minify = config.build.minify ?? true;
      define = config.define as Record<string, string> | undefined;
    },
    async generateBundle(_options, bundle) {
      const found = new Set<string>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || !chunk.facadeModuleId) continue;
        const facadePath = resolve(chunk.facadeModuleId.split('?')[0]);
        if (!entrySet.has(facadePath)) continue;
        found.add(facadePath);

        const { build } = await import('vite');
        const result = await build({
          configFile: false,
          root,
          mode,
          define,
          logLevel: 'warn',
          plugins: [tsconfigPaths()],
          build: {
            write: false,
            emptyOutDir: false,
            copyPublicDir: false,
            modulePreload: false,
            sourcemap: false,
            minify,
            rollupOptions: {
              input: facadePath,
              output: { format: 'iife', inlineDynamicImports: true },
            },
          },
        });

        const outputs = Array.isArray(result) ? result : [result];
        const output = outputs[0];
        if (!output || !('output' in output)) {
          this.error(`classic-page-scripts: inner build produced no output for ${facadePath}`);
        }
        const iifeChunks = output.output.filter(
          (item): item is Extract<typeof item, { type: 'chunk' }> => item.type === 'chunk'
        );
        if (iifeChunks.length !== 1) {
          this.error(
            `classic-page-scripts: expected exactly 1 IIFE chunk for ${facadePath}, got ${iifeChunks.length}`
          );
        }
        chunk.code = iifeChunks[0].code;
        chunk.imports = [];
        chunk.dynamicImports = [];
        chunk.map = null;
      }

      for (const entry of entrySet) {
        if (!found.has(entry)) {
          this.error(`classic-page-scripts: entry not found in bundle: ${entry}`);
        }
      }
    },
  };
}

// plugin to support i18n 
/*
export function crxI18n (options: { localize: boolean, src: string }): PluginOption {
  if (!options.localize) return null

  const getJsonFiles = (dir: string): Array<string> => {
    const files = fs.readdirSync(dir, {recursive: true}) as string[]
    return files.filter(file => !!file && file.endsWith('.json'))
  }
  const entry = resolve(__dirname, options.src)
  const localeFiles = getJsonFiles(entry)
  const files = localeFiles.map(file => {
    return {
      id: '',
      fileName: file,
      source: fs.readFileSync(resolve(entry, file))
    }
  })
  return {
    name: 'crx-i18n',
    enforce: 'pre',
    buildStart: {
      order: 'post',
      handler() {
        files.forEach((file) => {
            const refId = this.emitFile({
              type: 'asset',
              source: file.source,
              fileName: '_locales/'+file.fileName
            })
            file.id = refId
        })
      }
    }
  }
}*/