import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';

type Listener = (event: FakeEvent) => void;

class FakeEvent {
    defaultPrevented = false;
    immediatePropagationStopped = false;

    constructor(
        readonly type: string,
        readonly key = '',
        readonly shiftKey = false,
        readonly ctrlKey = false,
        readonly metaKey = false,
        readonly altKey = false
    ) { }

    preventDefault(): void {
        this.defaultPrevented = true;
    }

    stopImmediatePropagation(): void {
        this.immediatePropagationStopped = true;
    }
}

class FakeClassList {
    private readonly values = new Set<string>();

    add(...tokens: string[]): void {
        tokens.forEach((token) => this.values.add(token));
    }

    remove(...tokens: string[]): void {
        tokens.forEach((token) => this.values.delete(token));
    }

    contains(token: string): boolean {
        return this.values.has(token);
    }
}

class FakeDocument {
    readonly documentElement = { lang: '' };
    readonly body: FakeElement;
    readonly elements = new Map<string, FakeElement>();
    readonly listeners = new Map<string, Listener[]>();
    activeElement: FakeElement;
    readyState = 'complete';

    constructor() {
        this.body = new FakeElement('body', this);
        this.activeElement = this.body;
    }

    addEventListener(type: string, listener: Listener): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    dispatch(event: FakeEvent): void {
        for (const listener of this.listeners.get(event.type) ?? []) {
            if (event.immediatePropagationStopped) break;
            listener(event);
        }
    }

    createElement(tagName: string): FakeElement {
        return tagName === 'button' ? new FakeButton(this) : new FakeElement(tagName, this);
    }

    createDocumentFragment(): FakeElement {
        return new FakeElement('fragment', this);
    }

    getElementById(id: string): FakeElement | null {
        return this.elements.get(id) ?? null;
    }

    querySelector(selector: string): FakeElement | null {
        if (selector === '.workspace-shell') return this.elements.get('workspace-shell') ?? null;
        return null;
    }

    register(element: FakeElement, id: string): FakeElement {
        element.id = id;
        this.elements.set(id, element);
        return element;
    }
}

class FakeElement {
    id = '';
    value = '';
    textContent = '';
    className = '';
    tabIndex = -1;
    inert = false;
    disabled = false;
    isConnected = true;
    clientHeight = 0;
    scrollTop = 0;
    readonly children: FakeElement[] = [];
    readonly classList = new FakeClassList();
    readonly attributes = new Map<string, string>();
    readonly dataset: Record<string, string> = {};
    readonly style: Record<string, string> = {};
    readonly listeners = new Map<string, Listener[]>();
    parentElement: FakeElement | null = null;

    constructor(readonly tagName: string, protected readonly document: FakeDocument) { }

    get firstChild(): FakeElement | null {
        return this.children[0] ?? null;
    }

    appendChild(child: FakeElement): FakeElement {
        if (child.tagName === 'fragment') {
            child.children.slice().forEach((entry) => this.appendChild(entry));
            return child;
        }
        child.parentElement = this;
        this.children.push(child);
        return child;
    }

    append(...children: FakeElement[]): void {
        children.forEach((child) => this.appendChild(child));
    }

    removeChild(child: FakeElement): FakeElement {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
        child.parentElement = null;
        return child;
    }

    replaceChildren(...children: FakeElement[]): void {
        this.children.splice(0).forEach((child) => { child.parentElement = null; });
        children.forEach((child) => this.appendChild(child));
    }

    remove(): void {
        this.parentElement?.removeChild(this);
        this.isConnected = false;
    }

    contains(node: FakeElement): boolean {
        return node === this || this.children.some((child) => child.contains(node));
    }

    setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
    }

    getAttribute(name: string): string | null {
        return this.attributes.get(name) ?? null;
    }

    removeAttribute(name: string): void {
        this.attributes.delete(name);
    }

    addEventListener(type: string, listener: Listener): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: Listener): void {
        const listeners = this.listeners.get(type) ?? [];
        this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
    }

    dispatch(event: FakeEvent): void {
        for (const listener of this.listeners.get(event.type) ?? []) {
            if (event.immediatePropagationStopped) break;
            listener(event);
        }
    }

    listenerCount(type: string): number {
        return (this.listeners.get(type) ?? []).length;
    }

    focus(): void {
        this.document.activeElement = this;
    }

    querySelectorAll(selector: string): FakeElement[] {
        const all = this.descendants();
        if (selector.includes('[role="menuitem"]')) return all.filter((element) => element.getAttribute('role') === 'menuitem');
        if (selector.includes('button') || selector.includes('input') || selector.includes('[tabindex]')) return all.filter((element) => element.tabIndex >= 0 || element.tagName === 'button' || element.tagName === 'input');
        return [];
    }

    querySelector(selector: string): FakeElement | null {
        if (selector.startsWith('#')) return this.descendants().find((element) => element.id === selector.slice(1)) ?? null;
        return this.querySelectorAll(selector)[0] ?? null;
    }

    private descendants(): FakeElement[] {
        return this.children.flatMap((child) => [child, ...child.descendants()]);
    }
}

class FakeButton extends FakeElement {
    type = 'button';

    constructor(document: FakeDocument) {
        super('button', document);
    }
}

interface AccessibilityApi {
    openDialog(id: string, options?: { initialFocus?: FakeElement; onEscape?: () => void }): void;
    closeDialog(id: string): void;
    installMenuKeyboardNavigation(menu: FakeElement, close: () => void): void;
    focusFirstMenuItem(menu: FakeElement): void;
    createFixedHeightVirtualList(list: FakeElement, options: { itemCount: () => number; rowHeight: number; overscan: number; render: (range: { start: number; end: number }) => void }): { dispose(): void };
    setBusy(element: FakeElement, busy: boolean): void;
}

interface Runtime {
    document: FakeDocument;
    context: Record<string, unknown>;
    accessibility: AccessibilityApi;
}

function compile(sourcePath: string): string {
    return transpileModule(readFileSync(join(__dirname, sourcePath), 'utf8'), {
        compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 }
    }).outputText;
}

function createRuntime(): Runtime {
    const document = new FakeDocument();
    const context: Record<string, unknown> = {
        document,
        HTMLElement: FakeElement,
        HTMLButtonElement: FakeButton,
        Element: FakeElement,
        Node: FakeElement,
        requestAnimationFrame: (callback: () => void) => callback(),
        setTimeout: (callback: () => void) => callback(),
        performance: { now: () => 0 },
        console,
    };
    context.window = context;
    runInNewContext(compile('renderer-accessibility.ts'), context);
    return {
        document,
        context,
        accessibility: (context as unknown as { RendererAccessibility: AccessibilityApi }).RendererAccessibility,
    };
}

function attachDialog(runtime: Runtime, id: string): { dialog: FakeElement; first: FakeButton; last: FakeButton } {
    const dialog = runtime.document.register(new FakeElement('div', runtime.document), id);
    const first = new FakeButton(runtime.document);
    const last = new FakeButton(runtime.document);
    dialog.append(first, last);
    return { dialog, first, last };
}

describe('renderer accessibility integration', () => {
    it('keeps dialog focus, inert background and Escape restoration in one interaction path', () => {
        const runtime = createRuntime();
        const shell = runtime.document.register(new FakeElement('main', runtime.document), 'workspace-shell');
        const trigger = new FakeButton(runtime.document);
        runtime.document.activeElement = trigger;
        const { dialog, first, last } = attachDialog(runtime, 'dialog');

        runtime.accessibility.openDialog('dialog', { initialFocus: first });
        expect(dialog.classList.contains('show')).toBe(true);
        expect(dialog.getAttribute('aria-hidden')).toBe('false');
        expect(shell.inert).toBe(true);
        expect(runtime.document.activeElement).toBe(first);

        runtime.document.activeElement = last;
        const tab = new FakeEvent('keydown', 'Tab');
        runtime.document.dispatch(tab);
        expect(tab.defaultPrevented).toBe(true);
        expect(runtime.document.activeElement).toBe(first);

        const escape = new FakeEvent('keydown', 'Escape');
        runtime.document.dispatch(escape);
        expect(escape.immediatePropagationStopped).toBe(true);
        expect(dialog.classList.contains('show')).toBe(false);
        expect(shell.inert).toBe(false);
        expect(runtime.document.activeElement).toBe(trigger);
    });

    it('navigates production menu elements and removes its only scroll listener on disposal', () => {
        const runtime = createRuntime();
        const menu = new FakeElement('div', runtime.document);
        const first = new FakeButton(runtime.document);
        const second = new FakeButton(runtime.document);
        const third = new FakeButton(runtime.document);
        [first, second, third].forEach((item) => {
            item.setAttribute('role', 'menuitem');
            menu.appendChild(item);
        });
        let closes = 0;
        runtime.accessibility.installMenuKeyboardNavigation(menu, () => { closes++; });
        runtime.accessibility.focusFirstMenuItem(menu);
        expect(runtime.document.activeElement).toBe(first);
        menu.dispatch(new FakeEvent('keydown', 'ArrowDown'));
        expect(runtime.document.activeElement).toBe(second);
        menu.dispatch(new FakeEvent('keydown', 'End'));
        expect(runtime.document.activeElement).toBe(third);
        menu.dispatch(new FakeEvent('keydown', 'Escape'));
        expect(closes).toBe(1);

        const list = new FakeElement('div', runtime.document);
        list.clientHeight = 58;
        const ranges: Array<{ start: number; end: number }> = [];
        const virtual = runtime.accessibility.createFixedHeightVirtualList(list, {
            itemCount: () => 50_000,
            rowHeight: 29,
            overscan: 12,
            render: (range) => ranges.push(range),
        });
        expect(list.listenerCount('scroll')).toBe(1);
        list.scrollTop = 290;
        list.dispatch(new FakeEvent('scroll'));
        expect(ranges.at(-1)).toEqual({ start: 0, end: 24 });
        virtual.dispose();
        expect(list.listenerCount('scroll')).toBe(0);
    });

    it('drives the production command palette combobox and clears busy state', () => {
        const runtime = createRuntime();
        const shell = runtime.document.register(new FakeElement('main', runtime.document), 'workspace-shell');
        const trigger = new FakeButton(runtime.document);
        runtime.document.activeElement = trigger;
        const modal = runtime.document.register(new FakeElement('div', runtime.document), 'commandPaletteModal');
        const input = runtime.document.register(new FakeElement('input', runtime.document), 'commandPaletteInput');
        const list = runtime.document.register(new FakeElement('ul', runtime.document), 'commandPaletteList');
        modal.append(input, list);
        runtime.context.UI_TEXT = {
            static: {
                commandPaletteCommands: {
                    vods: { label: 'VODs', keywords: 'vod' },
                    clips: { label: 'Clips', keywords: 'clip' },
                    cutter: { label: 'Cutter', keywords: 'cut' },
                    merge: { label: 'Merge', keywords: 'merge' },
                    stats: { label: 'Stats', keywords: 'stats' },
                    archive: { label: 'Archive', keywords: 'archive' },
                    settings: { label: 'Settings', keywords: 'settings' },
                },
                commandPaletteOpenHint: 'Open',
                commandPaletteStreamerHint: 'Streamer',
            }
        };
        runtime.context.config = { streamers: [] };
        runtime.context.showTab = () => undefined;
        runInNewContext(compile('renderer-command-palette.ts'), runtime.context);

        runtime.document.dispatch(new FakeEvent('keydown', 'k', false, true));
        expect(modal.classList.contains('show')).toBe(true);
        expect(shell.inert).toBe(true);
        expect(input.getAttribute('aria-expanded')).toBe('true');
        expect(input.getAttribute('aria-activedescendant')).toBe('commandPaletteOption-0');
        runtime.document.dispatch(new FakeEvent('keydown', 'ArrowDown'));
        expect(input.getAttribute('aria-activedescendant')).toBe('commandPaletteOption-1');
        const escape = new FakeEvent('keydown', 'Escape');
        runtime.document.dispatch(escape);
        expect(escape.immediatePropagationStopped).toBe(true);
        expect(modal.classList.contains('show')).toBe(false);
        expect(shell.inert).toBe(false);
        expect(runtime.document.activeElement).toBe(trigger);

        runtime.accessibility.setBusy(list, true);
        runtime.accessibility.setBusy(list, false);
        expect(list.getAttribute('aria-busy')).toBeNull();
    });
});
