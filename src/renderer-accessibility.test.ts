import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { describe, expect, it } from 'vitest';

interface RendererAccessibilityApi {
    RenderGeneration: new () => { next(): number; isCurrent(generation: number): boolean; cancel(): void };
    getVirtualRange(scrollTop: number, viewportHeight: number, itemCount: number, rowHeight: number, overscan: number): { start: number; end: number };
    getNextFocusIndex(activeIndex: number, count: number, shiftKey: boolean): number;
    getNextMenuIndex(activeIndex: number, count: number, key: string): number | null;
    setDocumentLanguage(language: string): string;
}

function loadAccessibility(documentElement: { lang: string } = { lang: '' }): RendererAccessibilityApi {
    const source = readFileSync(join(__dirname, 'renderer-accessibility.ts'), 'utf8');
    const context = {
        document: { documentElement, addEventListener: () => undefined },
        requestAnimationFrame: (callback: () => void) => callback(),
        HTMLElement: class {},
        Element: class {},
        Node: class {},
    };
    const output = transpileModule(source, { compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 } }).outputText;
    runInNewContext(output, context);
    return (context as unknown as { RendererAccessibility: RendererAccessibilityApi }).RendererAccessibility;
}

describe('renderer accessibility helpers', () => {
    it('replaces stale chat work after rapid filters and close cancellation', () => {
        const { RenderGeneration } = loadAccessibility();
        const generations = new RenderGeneration();
        const initial = generations.next();
        const rapidFilter = generations.next();
        generations.cancel();

        expect(generations.isCurrent(initial)).toBe(false);
        expect(generations.isCurrent(rapidFilter)).toBe(false);
    });

    it('keeps a large chat render window bounded to the visible rows', () => {
        const { getVirtualRange } = loadAccessibility();
        expect(getVirtualRange(29_000, 580, 50_000, 29, 12)).toEqual({ start: 988, end: 1_032 });
    });

    it('wraps dialog tab order at the first and last focusable controls', () => {
        const { getNextFocusIndex } = loadAccessibility();
        expect(getNextFocusIndex(2, 3, false)).toBe(0);
        expect(getNextFocusIndex(0, 3, true)).toBe(2);
    });

    it('moves keyboard menus with arrows, Home, End and Escape semantics', () => {
        const { getNextMenuIndex } = loadAccessibility();
        expect(getNextMenuIndex(1, 4, 'ArrowDown')).toBe(2);
        expect(getNextMenuIndex(0, 4, 'ArrowUp')).toBe(3);
        expect(getNextMenuIndex(2, 4, 'Home')).toBe(0);
        expect(getNextMenuIndex(1, 4, 'End')).toBe(3);
        expect(getNextMenuIndex(1, 4, 'Escape')).toBeNull();
    });

    it('updates the document language when the application language changes', () => {
        const documentElement = { lang: 'en' };
        const { setDocumentLanguage } = loadAccessibility(documentElement);
        expect(setDocumentLanguage('de')).toBe('de');
        expect(documentElement.lang).toBe('de');
    });
});
