import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve } from 'node:path';
import { publishBuildFile } from './build-output.mjs';

const rootDirectory = fileURLToPath(new URL('../', import.meta.url));
const sourceDirectory = resolve(rootDirectory, 'src');
const outputDirectory = resolve(rootDirectory, 'dist');
const rendererDirectory = resolve(outputDirectory, 'renderer');
const sourceHtml = await readFile(resolve(sourceDirectory, 'index.html'), 'utf8');
const assets = [...sourceHtml.matchAll(/(?:href|src)="((?:\.\/|\.\.\/dist\/)[^"/]+\.(?:css|js))"/g)];
await mkdir(rendererDirectory, { recursive: true });
let rendererHtml = sourceHtml.replaceAll('../build/', '../../build/');
for (const [, reference] of assets) {
    const file = resolve(sourceDirectory, reference);
    const content = await readFile(file);
    if (!content.length) throw new Error('Empty renderer asset: ' + reference);
    const extension = extname(file);
    const stem = reference.split('/').at(-1).slice(0, -extension.length);
    const digest = createHash('sha256').update(content).digest('hex').slice(0, 16);
    const name = stem + '.' + digest + extension;
    await publishBuildFile(resolve(rendererDirectory, name), content);
    rendererHtml = rendererHtml.replaceAll('"' + reference + '"', '"./' + name + '"');
}
await publishBuildFile(resolve(rendererDirectory, 'index.html'), rendererHtml);
