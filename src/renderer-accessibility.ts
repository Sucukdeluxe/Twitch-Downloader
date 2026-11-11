interface RendererDialogOptions {
    initialFocus?: HTMLElement | string | null;
    onEscape?: () => void;
    onBackdrop?: () => void;
}

interface RendererOpenDialogState {
    returnFocus: HTMLElement | null;
    onEscape?: () => void;
    disposeBackdrop?: () => void;
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

    function hasNativeDialog(): boolean {
        return document.querySelector('dialog[open]') !== null;
    }

    function isDialogOpen(id: string): boolean {
        return dialogStack.includes(id);
    }

    function installBackdropDismiss(dialog: HTMLElement, dismiss: () => void, isActive: () => boolean): () => void {
        let pointer: { id: number; x: number; y: number } | null = null;
        let released = false;
        const isBackdrop = (event: MouseEvent): boolean => {
            if (event.target !== dialog) return false;
            if (dialog.tagName !== 'DIALOG') return true;
            const bounds = dialog.getBoundingClientRect();
            return event.clientX < bounds.left || event.clientX >= bounds.right || event.clientY < bounds.top || event.clientY >= bounds.bottom;
        };
        const reset = (): void => { pointer = null; released = false; };
        const onPointerDown = (event: PointerEvent): void => {
            reset();
            if (event.isPrimary && event.button === 0 && isActive() && isBackdrop(event)) {
                pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
            }
        };
        const onPointerMove = (event: PointerEvent): void => {
            if (pointer?.id === event.pointerId && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 6) reset();
        };
        const onPointerUp = (event: PointerEvent): void => {
            released = pointer?.id === event.pointerId && event.button === 0 && isActive() && isBackdrop(event)
                && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) <= 6;
            if (!released) reset();
        };
        const onClick = (event: MouseEvent): void => {
            const shouldDismiss = released && event.button === 0 && isActive() && isBackdrop(event);
            reset();
            if (!shouldDismiss) return;
            event.preventDefault();
            event.stopPropagation();
            dismiss();
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('pointermove', onPointerMove, true);
        document.addEventListener('pointerup', onPointerUp, true);
        document.addEventListener('pointercancel', reset, true);
        document.addEventListener('click', onClick, true);
        window.addEventListener('blur', reset);
        return () => {
            reset();
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('pointermove', onPointerMove, true);
            document.removeEventListener('pointerup', onPointerUp, true);
            document.removeEventListener('pointercancel', reset, true);
            document.removeEventListener('click', onClick, true);
            window.removeEventListener('blur', reset);
        };
    }

    function openDialog(id: string, options: RendererDialogOptions = {}): void {
        const dialog = document.getElementById(id);
        if (!(dialog instanceof HTMLElement)) return;
        const previous = dialogStates.get(id);
        previous?.disposeBackdrop?.();
        const existing = dialogStack.indexOf(id);
        if (existing >= 0) dialogStack.splice(existing, 1);
        const active = document.activeElement;
        dialogStates.set(id, {
            returnFocus: previous ? previous.returnFocus : active instanceof HTMLElement && active !== document.body ? active : null,
            onEscape: options.onEscape,
            disposeBackdrop: options.onBackdrop ? installBackdropDismiss(dialog, options.onBackdrop, () => dialogStack.at(-1) === id && !hasNativeDialog()) : undefined
        });
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
        state?.disposeBackdrop?.();
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
        if (hasNativeDialog()) return;
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
        hasNativeDialog,
        isDialogOpen,
        installBackdropDismiss,
        openDialog,
        closeDialog,
        closeTopmostDialog,
        installMenuKeyboardNavigation,
        focusFirstMenuItem,
    };
})();

Object.assign(globalThis, { RendererAccessibility });
