import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { publishBuildFile } from './build-output.mjs';

const options = {
    absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
    entryPoints: ['src/vod-player/workspace.jsx'],
    bundle: true,
    outfile: 'dist/renderer-vod-player.js',
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    minify: true,
    write: false,
    plugins: [{ name: 'atomic-player-output', setup(builder) {
        builder.onEnd(async result => {
            if (result.errors.length) return;
            for (const file of result.outputFiles) {
                if (!file.contents.length) throw new Error('Empty player output: ' + file.path);
                await publishBuildFile(file.path, file.contents);
            }
        });
    } }],
    legalComments: 'eof',
    define: { 'process.env.NODE_ENV': '"production"' },
};

if (process.argv.includes('--watch')) await (await context(options)).watch();
else await build(options);
