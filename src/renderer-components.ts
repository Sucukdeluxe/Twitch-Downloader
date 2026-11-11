const RendererElements = (() => {
    function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
        const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
    }
    function button(label: string, action: () => void, className = 'btn-secondary'): HTMLButtonElement {
        const node = element('button', className, label); node.type = 'button'; node.addEventListener('click', action); return node;
    }
    return { element, button };
})();
