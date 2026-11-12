const RendererAutoVodRules = (() => {
    type Rule = import('./main/domain/auto-vod-rules').AutoVodRule;
    let dialog: HTMLDialogElement | null = null, busy = false;
    const text = (de: string, en: string) => currentLanguage === 'de' ? de : en;
    const input = (id: string) => document.getElementById(id) as HTMLInputElement;
    const channel = () => (document.getElementById('autoRuleChannel') as HTMLSelectElement).value;
    function status(message: string) { document.getElementById('autoRuleStatus')!.textContent = message; }
    function fill() {
        const rule = config.auto_vod_rules?.[channel()] || { include: [], exclude: [], minMinutes: 0, maxMinutes: 0, maxAgeHours: 0 };
        input('autoRuleInclude').value = rule.include.join('; '); input('autoRuleExclude').value = rule.exclude.join('; ');
        input('autoRuleMin').value = String(rule.minMinutes); input('autoRuleMax').value = String(rule.maxMinutes); input('autoRuleAge').value = String(rule.maxAgeHours);
        document.getElementById('autoRuleResults')!.replaceChildren(); status('');
    }
    function read(): Rule {
        if (!channel()) throw new Error(text('Kanal auswählen.', 'Select a channel.'));
        const words = (id: string) => input(id).value.split(';').map(value => value.trim()).filter(Boolean);
        const rule = { include: words('autoRuleInclude'), exclude: words('autoRuleExclude'), minMinutes: input('autoRuleMin').valueAsNumber, maxMinutes: input('autoRuleMax').valueAsNumber, maxAgeHours: input('autoRuleAge').valueAsNumber };
        if (!dialog!.querySelector<HTMLFormElement>('form')!.reportValidity() || rule.include.length > 20 || rule.exclude.length > 20 || [...rule.include,...rule.exclude].some(word=>word.length>100) || (rule.maxMinutes > 0 && rule.minMinutes > rule.maxMinutes)) throw new Error(text('Regelwerte prüfen.', 'Check rule values.'));
        return rule;
    }
    async function run(mode: 'preview' | 'save' | 'remove') {
        if (busy) return;
        let rule: Rule; try { rule = mode === 'remove' ? { include: [], exclude: [], minMinutes: 0, maxMinutes: 0, maxAgeHours: 0 } : read(); if (!channel()) throw new Error(text('Kanal auswählen.', 'Select a channel.')); } catch(error) { status(String((error as Error).message)); return; }
        busy = true; const selected = channel(); const controls = Array.from(dialog!.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('form input, form button, form select')); controls.forEach(node=>node.disabled=true);
        try {
            if (mode === 'preview') {
                status(text('VODs werden geprüft …', 'Checking VODs …'));
                const rows = await window.api.previewAutoVodRule(selected, rule), list = document.getElementById('autoRuleResults')!; list.replaceChildren();
                const reasons = { match:text('Passend','Matches'), age:text('Alter','Age'), include:text('Titel fehlt','Title mismatch'), exclude:text('Titel ausgeschlossen','Excluded title'), duration:text('Dauer','Duration') };
                for (const row of rows) { const item = document.createElement('div'); item.className='auto-rule-result'; const name=document.createElement('strong'); name.textContent=row.title; const outcome=document.createElement('span'); outcome.textContent=row.downloaded ? text('Bereits geladen','Already downloaded') : reasons[row.result]; item.append(name,outcome); list.append(item); }
                status(text('Passend: ','Matches: ') + formatUiNumber(rows.filter(row=>row.result==='match'&&!row.downloaded).length));
            } else {
                const rules = { ...config.auto_vod_rules }; if (mode === 'remove') delete rules[selected]; else rules[selected] = rule;
                config = await window.api.saveConfig({ auto_vod_rules: rules });
                if (mode === 'remove') fill();
                status(mode==='remove' ? text('Regel entfernt.','Rule removed.') : text('Regel gespeichert.','Rule saved.'));
            }
        } catch { status(text('Aktion fehlgeschlagen. Erneut versuchen.','Action failed. Try again.')); }
        finally { busy=false; controls.forEach(node=>node.disabled=false); }
    }
    function open() {
        if (busy) return;
        dialog?.remove(); dialog=document.createElement('dialog'); dialog.className='clip-discovery-dialog auto-rule-dialog'; dialog.id='autoRuleDialog';
        const header=document.createElement('header'); header.className='clip-discovery-header'; const title=document.createElement('h2'); title.textContent=text('Kanalregeln','Channel rules'); title.id='autoRuleTitle'; dialog.setAttribute('aria-labelledby',title.id); const close=document.createElement('button'); close.type='button'; close.className='btn-secondary'; close.textContent=text('Schließen','Close'); close.onclick=()=>dialog?.close(); header.append(title,close); dialog.append(header);
        const form=document.createElement('form'); form.className='auto-rule-form'; form.onsubmit=e=>e.preventDefault(); const channelLabel=document.createElement('label'); channelLabel.textContent=text('Kanal','Channel'); const select=document.createElement('select'); select.id='autoRuleChannel'; for (const name of [...new Set(config.streamers || [])]) { const option=document.createElement('option'); option.value=name.toLowerCase(); option.textContent=name; select.append(option); } select.onchange=fill; channelLabel.append(select); form.append(channelLabel);
        for (const [id,label,type,max] of [
            ['autoRuleInclude',text('Titel enthält','Title contains'),'text',''], ['autoRuleExclude',text('Titel ohne','Title excludes'),'text',''],
            ['autoRuleMin',text('Mind. Minuten','Min. minutes'),'number','1440'], ['autoRuleMax',text('Max. Minuten','Max. minutes'),'number','1440'], ['autoRuleAge',text('Max. Stunden','Max. hours'),'number','720']
        ]) { const field=document.createElement('label'); field.textContent=label; const node=document.createElement('input'); node.id=id; node.type=type; if(type==='number'){node.min='0';node.max=max;node.step='1';node.required=true;field.className='auto-rule-number';}else{node.maxLength=2040;node.placeholder=text('Begriffe mit ; trennen','Separate terms with ;');} field.append(node); form.append(field); }
        const help=document.createElement('p'); help.className='auto-rule-help'; help.textContent=text('0: kein Dauerlimit / globales Alter. Mehrere Suchbegriffe: Einer muss passen.','0: no duration limit / global age. Multiple search terms: Any term may match.'); form.append(help);
        const actions=document.createElement('div'); actions.className='auto-rule-actions'; for(const [mode,label] of [['remove',text('Entfernen','Remove')],['preview',text('Vorschau','Preview')],['save',text('Speichern','Save')]] as const){const button=document.createElement('button');button.type='button';button.className='btn-secondary';button.textContent=label;button.disabled=!select.options.length;button.onclick=()=>{void run(mode)};actions.append(button);}form.append(actions);dialog.append(form);
        const message=document.createElement('p');message.id='autoRuleStatus';message.setAttribute('role','status');const list=document.createElement('div');list.id='autoRuleResults';list.className='clip-discovery-list';dialog.append(message,list);document.body.append(dialog);fill();if(!select.options.length)status(text('Zuerst einen Streamer hinzufügen.','Add a streamer first.'));dialog.showModal();
    }
    return { open };
})();
