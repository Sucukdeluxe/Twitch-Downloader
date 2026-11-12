const names = ['01 · Kompakter Versionsdialog','02 · Geteilte Release-Übersicht','03 · Kompaktes Navigationspanel','04 · Seitliches Update-Center','05 · Redaktionelle Release-Ansicht','06 · Geführte Installation','07 · Horizontale Release-Karte','08 · Übersicht mit Infokacheln','09 · Änderungsinspektor','10 · Reduzierter Bestätigungsdialog'];
let current = Math.min(10, Math.max(1, Number(new URLSearchParams(location.search).get('v')) || 1));
let timer = null, percent = 0, phase = 'available', toastTimer;
const $ = id => document.getElementById(id);
const svg = (path, cls = '') => '<svg class="' + cls + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
const chevron = svg('<path d="m6 9 6 6 6-6"/>');
const down = svg('<path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5"/>');
const check = svg('<path d="m5 12 4 4L19 6"/>');
const closeIcon = svg('<path d="m6 6 12 12M18 6 6 18"/>');
const mark = svg('<path d="M5 4h14v11l-4 5H9l-4-5ZM9 8v5m6-5v5"/>');
const title = '<h2 id="dialogTitle">Update verfügbar</h2>';
const eyebrow = '<div class="eyebrow">Twitch Downloader</div>';
const description = '<p class="description">Version 1.1.7 ist bereit. Lade das Update herunter und installiere es mit einem Neustart.</p>';
const versionPair = '<div class="version-pair"><div><span>Installiert</span><strong>1.1.6</strong></div><span class="version-divider"></span><div><span>Verfügbar</span><strong>1.1.7</strong></div></div>';
const metadata = '<dl class="metadata"><div><dt>Veröffentlicht</dt><dd>16. Oktober 2026</dd></div><div><dt>Plattform</dt><dd>Windows · 64 Bit</dd></div><div><dt>Download</dt><dd>106 MB</dd></div></dl>';
const digest = '<div class="digest"><div><span class="mini-icon">'+check+'</span><p><strong>Updates per Klick</strong><span>Kein zusätzliches Popup beim Darüberfahren.</span></p></div><div><span class="mini-icon">'+check+'</span><p><strong>Zuverlässige Zeitfenster</strong><span>Automatische Aufträge warten bis zum nächsten erlaubten Zeitraum.</span></p></div></div>';
const noteContent = '<section><h3>Verbesserungen <span>3</span></h3><ul><li>Die Update-Anzeige in der Navigation öffnet sich ausschließlich per Klick.</li><li>Die Änderungsübersicht lässt sich mit animiertem Auf- und Zuklappen bedienen.</li><li>Installierte Version, neue Version und Downloadgröße sind direkt sichtbar.</li></ul></section><section><h3>Fehlerbehebungen <span>2</span></h3><ul><li>Nach Ende des Zeitfensters startet kein weiterer automatischer Download. Laufende Aufträge dürfen fertig werden.</li><li>Wartende Aufträge werden nach einem Neustart im nächsten erlaubten Zeitfenster fortgesetzt.</li></ul></section><p class="sample-note">Beispielinhalt zur Beurteilung dieses Entwurfs.</p>';
function accordion(label = 'Änderungsübersicht', subtitle = '3 Verbesserungen · 2 Fehlerbehebungen') {
 return '<section class="changelog"><button class="toggle" aria-expanded="false" aria-controls="notes" aria-label="Änderungsübersicht aufklappen"><span class="toggle-label"><strong>'+label+'</strong><small>'+subtitle+'</small></span><span class="chevron-control">'+chevron+'</span></button><div class="collapse" id="notes" inert><div><div class="notes">'+noteContent+'</div></div></div></section>';
}
const progress = '<section class="progress" aria-live="polite"><div class="progress-row"><strong id="progressTitle">Download läuft</strong><span id="percent">0 %</span></div><div class="meter" role="progressbar" aria-label="Update herunterladen" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="fill"></div></div><p id="transfer">0 von 106 MB · Vorschau</p></section>';
const preserve = '<p class="preserve">'+check+'<span>Downloads und Einstellungen bleiben erhalten.</span></p>';
const buttons = '<div class="action-buttons"><button id="later" class="secondary">Später</button><button id="download" class="primary">'+down+'<span>Jetzt herunterladen</span></button></div>';
const skip = '<button class="skip" id="skip">Diese Version überspringen</button>';
const footer = '<footer class="dialog-footer">'+preserve+progress+buttons+'<div class="footer-bottom">'+skip+'<span class="simulation">Vorschau</span></div></footer>';
const closeButton = '<button class="close" aria-label="Schließen">'+closeIcon+'</button>';
const section = (cls, content) => '<div class="'+cls+'">'+content+'</div>';
function template(v) {
 switch(v) {
 case 1:return section('heading',eyebrow+title+description)+versionPair+accordion()+footer;
 case 2:return section('release-aside','<div class="product-mark">'+mark+'</div>'+eyebrow+'<div class="release-version">1.1.7</div><span class="tag">Neue Version</span><p>Eine aktualisierte Oberfläche und zuverlässigere automatische Downloads.</p>'+metadata)+section('release-main',title+digest+accordion('Alle Änderungen')+footer);
 case 3:return section('heading','<span class="status-dot"></span><span class="tag">Neue Version · 1.1.7</span>'+title+'<p>Ein Update für Twitch Downloader steht bereit.</p>')+section('compact-info','<span>Aktuell <b>1.1.6</b></span><span>Windows · 106 MB</span>')+accordion('Was ist neu?','Verbesserungen und Fehlerbehebungen')+footer;
 case 4:return section('drawer-head',eyebrow+title+'<p>Update-Center</p>')+section('drawer-content',versionPair+metadata+'<h3 class="section-title">Das ändert sich</h3>'+digest+accordion('Vollständige Änderungen'))+footer;
 case 5:return section('editorial-head',eyebrow+'<div class="editorial-meta"><span>Release 1.1.7</span><span>16. Oktober 2026</span></div>'+title+'<p class="lead">Update-Anzeige und<br>Download-Zeitfenster.</p>')+section('editorial-body','<div class="editorial-intro"><h3>Im Überblick</h3><p>Der Update-Dialog wird klarer. Automatische Downloads berücksichtigen Zeitfenster auch zwischen zwei Aufträgen.</p></div>'+accordion('Details zu dieser Version','5 Änderungen · Änderungsübersicht'))+section('editorial-footer',versionPair+footer);
 case 6:return section('heading',eyebrow+title+'<p>Das Update wird zuerst heruntergeladen. Den Neustart bestimmst du anschließend selbst.</p>')+'<ol class="steps"><li class="step active"><span>1</span><strong>Herunterladen</strong></li><li class="step"><span>2</span><strong>Neu starten</strong></li><li class="step"><span>3</span><strong>Aktuell</strong></li></ol>'+section('install-package','<div class="package-symbol">'+mark+'</div><div><strong>Twitch Downloader 1.1.7</strong><small>Windows · 64 Bit · 106 MB</small></div><span class="tag">Bereit</span>')+accordion('Änderungen ansehen','Installiert: 1.1.6 · Neu: 1.1.7')+footer;
 case 7:return section('ticket-side','<span class="eyebrow">Neue Version</span><div class="release-version">1.1.7</div><p>Windows · 64 Bit</p><strong class="ticket-size">106 <small>MB</small></strong><span class="ticket-date">16. Oktober 2026</span>')+section('ticket-content',title+'<p>Bereit zum Herunterladen.<br>Deine installierte Version: <b>1.1.6</b></p>'+accordion('Release-Details','Alle 5 Änderungen')+footer);
 case 8:return section('heading',eyebrow+title+'<p>Die wichtigsten Informationen vor dem Update.</p>')+'<div class="bento"><div class="bento-version"><small>Neue Version</small><strong>1.1.7</strong><span>Aktuell installiert: 1.1.6</span></div><div class="bento-size"><small>Download</small><strong>106 <span>MB</span></strong><span>Windows · 64 Bit</span></div><div class="bento-change"><strong>5 Änderungen</strong><span>3 Verbesserungen und 2 Fehlerbehebungen</span></div></div>'+accordion('Änderungen im Detail','Veröffentlicht am 16. Oktober 2026')+footer;
 case 9:return section('inspector-header',eyebrow+title+'<span class="tag">Version 1.1.7</span>')+section('inspector-grid',section('inspector-summary','<h3>Versionsinformationen</h3>'+metadata+versionPair)+section('inspector-notes','<h3>Schwerpunkte</h3>'+digest+accordion('Komplette Änderungsübersicht','Alle Verbesserungen und Fehlerbehebungen')))+footer;
 case 10:return section('minimal-head','<span class="tag">1.1.6 → 1.1.7</span>'+title+'<p>Eine neue Version von Twitch Downloader ist verfügbar.</p>')+section('minimal-release','<strong>Version 1.1.7</strong><span>106 MB · Windows</span>')+accordion('Änderungsübersicht','16. Oktober 2026')+footer;
 }
}
function render() {
 clearInterval(timer); timer=null; percent=0; phase='available';
 $('variant').value=current;
 $('overlay').className='overlay'+(current===4?' side':current===3?' corner':'');
 $('dialog').className='dialog v'+current;
 $('dialog').innerHTML=closeButton+template(current);
 document.querySelector('.close').onclick=close;
 document.querySelector('.toggle').onclick=e=>{const b=e.currentTarget, expanded=b.getAttribute('aria-expanded')!=='true';b.setAttribute('aria-expanded',String(expanded));b.setAttribute('aria-label','Änderungsübersicht '+(expanded?'zuklappen':'aufklappen'));$('notes').classList.toggle('expanded',expanded);$('notes').inert=!expanded;};
 $('later').onclick=()=>{if(phase==='downloading'){render();open();toast('Download abgebrochen');}else close();};
 $('skip').onclick=()=>{close();toast('Version übersprungen · Über Update erneut öffnen');};
 $('download').onclick=download;
}
function open() {$('overlay').classList.add('open');$('appShell').inert=true;document.querySelector('.close').focus({preventScroll:true});}
function close() {clearInterval(timer);timer=null;$('overlay').classList.remove('open');$('appShell').inert=false;$('update').focus({preventScroll:true});}
function toast(text){clearTimeout(toastTimer);$('toast').textContent=text;$('toast').classList.add('show');toastTimer=setTimeout(()=>$('toast').classList.remove('show'),2800);}
function download(){
 if(phase==='ready'){close();toast('Neustart simuliert · Es wurde nichts installiert');return;}
 phase='downloading';document.querySelector('.progress').classList.add('show');$('download').disabled=true;$('download').innerHTML='<span>Download läuft …</span>';$('later').textContent='Abbrechen';$('skip').disabled=true;
 timer=setInterval(()=>{percent=Math.min(percent+5,100);$('percent').textContent=percent+' %';document.querySelector('.fill').style.width=percent+'%';document.querySelector('.meter').setAttribute('aria-valuenow',percent);$('transfer').textContent=Math.round(percent*1.06)+' von 106 MB · Vorschau';if(percent===100){clearInterval(timer);timer=null;phase='ready';$('progressTitle').textContent='Bereit zur Installation';$('transfer').textContent='Das Update wird beim Neustart installiert.';$('download').disabled=false;$('download').innerHTML=check+'<span>Jetzt neu starten</span>';$('later').textContent='Später';document.querySelectorAll('.step').forEach((s,i)=>s.classList.toggle('active',i===1));}},160);
}
$('variant').innerHTML=names.map((n,i)=>'<option value="'+(i+1)+'">'+n+'</option>').join('');
$('variant').onchange=()=>{current=Number($('variant').value);history.replaceState(null,'','?v='+current+'&revision=2');render();open();};
$('prev').onclick=()=>{current=current===1?10:current-1;$('variant').value=current;$('variant').onchange();};
$('next').onclick=()=>{current=current===10?1:current+1;$('variant').value=current;$('variant').onchange();};
$('update').innerHTML=down+'<span>Update</span>';
$('update').onclick=()=>{render();open();};
$('overlay').addEventListener('pointerdown',e=>{window.backdropStart=e.target===$('overlay');});
$('overlay').onclick=e=>{if(e.target===$('overlay')&&window.backdropStart)close();};
document.addEventListener('keydown',e=>{if(!$('overlay').classList.contains('open'))return;if(e.key==='Escape')close();if(e.key==='Tab'){const a=[...$('dialog').querySelectorAll('button:not([disabled]),a[href]')].filter(el=>el.offsetParent!==null&&!el.closest('[inert]')),first=a[0],last=a[a.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
render();open();
