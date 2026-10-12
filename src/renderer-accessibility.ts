interface RendererDialogOptions {
    initialFocus?: HTMLElement | string | null;
    onEscape?: () => void;
}

interface RendererOpenDialogState {
    returnFocus: HTMLElement | null;
    onEscape?: () => void;
}

interface RendererFixedHeightVirtualListOptions {
    itemCount: () => number;
    rowHeight: number;
    overscan: number;
    render: (range: { start: number; end: number }) => void;
}

const RendererAccessibility = (() => {
    const dialogStack: string[] = [];
    const dialogStates = new Map<string, RendererOpenDialogState>();
    const focusSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    class RenderGeneration {
        private value = 0;

        next(): number {
            this.value += 1;
            return this.value;
        }

        isCurrent(generation: number): boolean {
            return generation === this.value;
        }

        cancel(): void {
            this.next();
        }
    }

    function getVirtualRange(scrollTop: number, viewportHeight: number, itemCount: number, rowHeight: number, overscan: number): { start: number; end: number } {
        if (itemCount <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
        const firstVisible = Math.max(0, Math.floor(scrollTop / rowHeight));
        const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight));
        return {
            start: Math.max(0, firstVisible - Math.max(0, overscan)),
            end: Math.min(itemCount, firstVisible + visibleCount + Math.max(0, overscan))
        };
    }

    function getNextFocusIndex(activeIndex: number, count: number, shiftKey: boolean): number {
        if (count < 1) return -1;
        if (shiftKey) return activeIndex <= 0 ? count - 1 : activeIndex - 1;
        return activeIndex >= count - 1 ? 0 : activeIndex + 1;
    }

    function getNextMenuIndex(activeIndex: number, count: number, key: string): number | null {
        if (count < 1 || key === 'Escape') return null;
        if (key === 'Home') return 0;
        if (key === 'End') return count - 1;
        if (key === 'ArrowDown') return activeIndex >= count - 1 ? 0 : activeIndex + 1;
        if (key === 'ArrowUp') return activeIndex <= 0 ? count - 1 : activeIndex - 1;
        return activeIndex;
    }

    function setDocumentLanguage(language: string): string {
        const normalized = language === 'en' ? 'en' : 'de';
        document.documentElement.lang = normalized;
        return normalized;
    }

    function setBusy(element: HTMLElement, busy: boolean): void {
        if (busy) element.setAttribute('aria-busy', 'true');
        else element.removeAttribute('aria-busy');
    }

    function createFixedHeightVirtualList(list: HTMLElement, options: RendererFixedHeightVirtualListOptions): { dispose(): void; render(): void } {
        let disposed = false;
        let scheduled = false;
        const render = (): void => {
            if (disposed) return;
            options.render(getVirtualRange(list.scrollTop, list.clientHeight, options.itemCount(), options.rowHeight, options.overscan));
        };
        const onScroll = (): void => {
            if (scheduled || disposed) return;
            scheduled = true;
            requestAnimationFrame(() => {
                scheduled = false;
                render();
            });
        };
        list.addEventListener('scroll', onScroll, { passive: true });
        render();
        return {
            dispose: () => {
                if (disposed) return;
                disposed = true;
                list.removeEventListener('scroll', onScroll);
            },
            render,
        };
    }

    function getFocusable(dialog: HTMLElement): HTMLElement[] {
        return Array.from(dialog.querySelectorAll<HTMLElement>(focusSelector)).filter((element) => element.getAttribute('aria-hidden') !== 'true');
    }

    function getInitialFocus(dialog: HTMLElement, initialFocus: RendererDialogOptions['initialFocus']): HTMLElement | null {
        if (typeof initialFocus === 'string') return dialog.querySelector<HTMLElement>(initialFocus);
        if (initialFocus && dialog.contains(initialFocus)) return initialFocus;
        return getFocusable(dialog)[0] ?? null;
    }

    function syncBackgroundInertness(): void {
        const shell = document.querySelector<HTMLElement>('.workspace-shell');
        if (shell) shell.inert = dialogStack.length > 0;
    }

    function isDialogOpen(id: string): boolean {
        return dialogStack.includes(id);
    }

    function openDialog(id: string, options: RendererDialogOptions = {}): void {
        const dialog = document.getElementById(id);
        if (!(dialog instanceof HTMLElement)) return;
        const existing = dialogStack.indexOf(id);
        if (existing >= 0) {
            dialogStack.splice(existing, 1);
        } else {
            const active = document.activeElement;
            dialogStates.set(id, {
                returnFocus: active instanceof HTMLElement && active !== document.body ? active : null,
                onEscape: options.onEscape
            });
        }
        dialogStack.push(id);
        dialog.classList.add('show');
        dialog.setAttribute('aria-hidden', 'false');
        syncBackgroundInertness();
        requestAnimationFrame(() => getInitialFocus(dialog, options.initialFocus)?.focus());
    }

    function closeDialog(id: string): void {
        const dialog = document.getElementById(id);
        if (!(dialog instanceof HTMLElement)) return;
        const index = dialogStack.indexOf(id);
        if (index < 0) return;
        const wasTopmost = index === dialogStack.length - 1;
        const state = dialogStates.get(id);
        dialogStack.splice(index, 1);
        dialogStates.delete(id);
        dialog.classList.remove('show');
        dialog.setAttribute('aria-hidden', 'true');
        syncBackgroundInertness();
        if (wasTopmost && state?.returnFocus?.isConnected) requestAnimationFrame(() => state.returnFocus?.focus());
    }

    function closeTopmostDialog(): boolean {
        const id = dialogStack.at(-1);
        if (!id) return false;
        const state = dialogStates.get(id);
        if (state?.onEscape) state.onEscape();
        else closeDialog(id);
        return true;
    }

    function installMenuKeyboardNavigation(menu: HTMLElement, close: () => void): void {
        menu.addEventListener('keydown', (event) => {
            const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).filter((item) => item.getAttribute('aria-disabled') !== 'true' && !(item instanceof HTMLButtonElement && item.disabled));
            const activeIndex = items.indexOf(document.activeElement as HTMLElement);
            const nextIndex = getNextMenuIndex(activeIndex < 0 ? 0 : activeIndex, items.length, event.key);
            if (event.key === 'Escape') {
                event.preventDefault();
                close();
                return;
            }
            if (nextIndex === activeIndex || nextIndex === null) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                items[nextIndex]?.focus();
            }
        });
    }

    function focusFirstMenuItem(menu: HTMLElement): void {
        menu.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"]):not([disabled])')?.focus();
    }

    document.addEventListener('keydown', (event) => {
        const id = dialogStack.at(-1);
        if (!id) return;
        const dialog = document.getElementById(id);
        if (!(dialog instanceof HTMLElement)) return;
        if (event.key === 'Escape') {
            const tooltip = Array.from(dialog.querySelectorAll('[aria-describedby]'))
                .flatMap(reference => (reference.getAttribute('aria-describedby') || '').split(/\s+/))
                .map(tooltipId => document.getElementById(tooltipId))
                .find(element => element?.matches('.vod-tooltip-position[data-open="true"]'));
            if (tooltip) {
                event.preventDefault();
                event.stopImmediatePropagation();
                tooltip.dispatchEvent(new Event('vod-tooltip-dismiss'));
                return;
            }
            if (id === 'clipModal' && (document.fullscreenElement || dialog.querySelector('.player-panel-position, .archive-player.cinema')
                || (event.target instanceof HTMLElement && ((event.target.matches('.archive-timeline') && dialog.querySelector('.fine-seek-position'))
                    || event.target.closest('.vod-range-markers[data-dragging="true"]'))))) return;
            const cancelRange = id === 'clipModal' && dialog.classList.contains('is-omitting') ? dialog.querySelector<HTMLButtonElement>('.vod-omission-row.is-editing [data-action="cancel-range"]') : null;
            if (cancelRange) {
                event.preventDefault();
                event.stopImmediatePropagation();
                cancelRange.click();
                return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            closeTopmostDialog();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = getFocusable(dialog);
        if (focusable.length === 0) {
            event.preventDefault();
            dialog.focus();
            return;
        }
        const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
        const nextIndex = getNextFocusIndex(activeIndex, focusable.length, event.shiftKey);
        if (activeIndex < 0 || nextIndex !== activeIndex + (event.shiftKey ? -1 : 1)) {
            event.preventDefault();
            focusable[nextIndex]?.focus();
        }
    }, true);

    return {
        RenderGeneration,
        getVirtualRange,
        getNextFocusIndex,
        getNextMenuIndex,
        setDocumentLanguage,
        setBusy,
        createFixedHeightVirtualList,
        isDialogOpen,
        openDialog,
        closeDialog,
        closeTopmostDialog,
        installMenuKeyboardNavigation,
        focusFirstMenuItem,
    };
})();

Object.assign(globalThis, { RendererAccessibility });
