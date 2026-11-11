export interface AutoVodRule { include: string[]; exclude: string[]; minMinutes: number; maxMinutes: number; maxAgeHours: number }
export type AutoVodRules = Record<string, AutoVodRule>;
export function normalizeAutoVodRule(value: unknown): AutoVodRule {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid automatic VOD rule');
    const raw = value as Record<string, unknown>;
    function words(value: unknown): string[] {
        if (!Array.isArray(value) || value.length > 20 || value.some(word => typeof word !== 'string' || !word.trim() || word.length > 100)) throw new Error('Invalid title filter');
        return [...new Set((value as string[]).map(word => word.trim().toLowerCase()))];
    }
    for (const key of ['minMinutes', 'maxMinutes', 'maxAgeHours']) if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || !Number.isInteger(raw[key]) || Number(raw[key]) < 0) throw new Error('Invalid rule limit');
    const minMinutes = Number(raw.minMinutes), maxMinutes = Number(raw.maxMinutes), maxAgeHours = Number(raw.maxAgeHours);
    if (minMinutes > 1440 || maxMinutes > 1440 || (maxMinutes > 0 && maxMinutes < minMinutes) || maxAgeHours > 720) throw new Error('Invalid rule limits');
    return { include: words(raw.include), exclude: words(raw.exclude), minMinutes, maxMinutes, maxAgeHours };
}
export function normalizeAutoVodRules(value: unknown): AutoVodRules {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 500) throw new Error('Invalid automatic VOD rules');
    const result: AutoVodRules = Object.create(null);
    for (const [channel, rule] of Object.entries(value)) {
        if (!/^[a-zA-Z0-9_]{1,25}$/.test(channel) || ['__proto__','constructor','prototype'].includes(channel.toLowerCase())) throw new Error('Invalid rule channel');
        result[channel.toLowerCase()] = normalizeAutoVodRule(rule);
    }
    return result;
}
export function evaluateAutoVodRule(rule: AutoVodRule | undefined, vod: { title: string; duration: string; created_at: string }, now: number, globalAgeHours: number): 'match' | 'age' | 'include' | 'exclude' | 'duration' {
    const created = Date.parse(vod.created_at);
    if (!Number.isFinite(created) || created > now + 60000 || created < now - (rule?.maxAgeHours || globalAgeHours) * 3600000) return 'age';
    if (!rule) return 'match';
    const title = vod.title.toLowerCase();
    if (rule.include.length && !rule.include.some(word => title.includes(word))) return 'include';
    if (rule.exclude.some(word => title.includes(word))) return 'exclude';
    const parts = vod.duration.match(/\d{1,5}[hms]/g);
    if (!parts || parts.join('') !== vod.duration) return 'duration';
    let minutes = 0, previous = -1;
    for (const part of parts) {
        const order = 'hms'.indexOf(part.slice(-1));
        if (order <= previous) return 'duration';
        previous = order;
        minutes += Number(part.slice(0, -1)) * [60, 1, 1 / 60][order];
    }
    return minutes < rule.minMinutes || (rule.maxMinutes > 0 && minutes > rule.maxMinutes) ? 'duration' : 'match';
}
