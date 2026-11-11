// Pure-Format-Helpers, extrahiert aus main.ts. Keine Globals, keine I/O.

const FILENAME_INVALID_CHARACTERS = new Set('<>:"|?*\\/');

/**
 * Entfernt Windows-Filesystem-verbotene Zeichen und Pfad-Separatoren aus einem
 * Datei-Namen-Teilstring. Fallback wird zurueckgegeben, wenn nach Cleanup
 * nichts uebrig bleibt.
 */
export function sanitizeFilenamePart(input: string, fallback = 'unnamed'): string {
    const cleaned = Array.from(input || '', (character) => {
        return character.charCodeAt(0) < 32 || FILENAME_INVALID_CHARACTERS.has(character) ? '_' : character;
    }).join('')
        .trim();
    return cleaned || fallback;
}

/**
 * Twitch-Style Duration-Format: `1h2m3s`, `2m5s`, `42s`. Negative oder
 * NaN-Inputs werden auf 0 geclamt.
 */
export function formatTwitchDurationFromSeconds(totalSeconds: number): string {
    const seconds = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;

    if (h > 0) return `${h}h${m}m${s}s`;
    if (m > 0) return `${m}m${s}s`;
    return `${s}s`;
}

const DATE_TOKEN_RE = /yyyy|yy|MM|M|dd|d|HH|H|hh|h|mm|m|ss|s/g;

/**
 * Date-Formatter mit Pattern-Tokens (yyyy, yy, MM, M, dd, d, HH, H, hh, h,
 * mm, m, ss, s). Backslash-escapes (\T) lassen das Folgezeichen literal.
 */
export function formatDateWithPattern(date: Date, pattern: string): string {
    const tokenMap: Record<string, string> = {
        yyyy: date.getFullYear().toString(),
        yy: date.getFullYear().toString().slice(-2),
        MM: (date.getMonth() + 1).toString().padStart(2, '0'),
        M: (date.getMonth() + 1).toString(),
        dd: date.getDate().toString().padStart(2, '0'),
        d: date.getDate().toString(),
        HH: date.getHours().toString().padStart(2, '0'),
        H: date.getHours().toString(),
        hh: date.getHours().toString().padStart(2, '0'),
        h: date.getHours().toString(),
        mm: date.getMinutes().toString().padStart(2, '0'),
        m: date.getMinutes().toString(),
        ss: date.getSeconds().toString().padStart(2, '0'),
        s: date.getSeconds().toString(),
    };

    return pattern
        .replace(DATE_TOKEN_RE, token => tokenMap[token] ?? token)
        .replace(/\\(.)/g, '$1');
}

export type MergeGroupLanguage = 'de' | 'en';

/**
 * Label fuer den aktuellen Merge-Group-Phase-Status. Pure variant — Sprache
 * wird vom Caller injiziert.
 */
export function getMergeGroupPhaseText(phase: string, language: MergeGroupLanguage | string): string {
    const isEnglish = language === 'en';
    switch (phase) {
        case 'downloading': return isEnglish ? 'Downloading VOD' : 'VOD wird heruntergeladen';
        case 'merging': return isEnglish ? 'Merging...' : 'Zusammenfügen...';
        case 'splitting': return isEnglish ? 'Splitting Part' : 'Part wird erstellt';
        case 'cleanup': return isEnglish ? 'Cleaning up...' : 'Aufräumen...';
        default: return phase;
    }
}

export function sanitizeClipFilename(input: string, fallback = 'clip'): string {
    const cleaned = Array.from(sanitizeFilenamePart(input.normalize('NFC'), fallback)).slice(0, 80).join('').replace(/[. ]+$/g, '');
    const name = cleaned || fallback;
    return /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(name) ? '_' + name : name;
}
