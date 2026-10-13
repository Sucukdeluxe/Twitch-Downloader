import type { DownloadProgress } from '../../types';

const PACKET_SIZE = 188;
const CLOCK_RATE = 90000;
const CLOCK_WRAP = 2 ** 33;

export class MpegTsProgress {
    private pending = Buffer.alloc(0);
    private clocks = new Map<number, { timestamp: number; elapsed: number }>();
    private discontinuities = new Set<number>();
    private elapsed = 0;
    private observed = false;

    get seconds(): number | null { return this.observed ? this.elapsed / CLOCK_RATE : null; }

    push(chunk: Buffer): void {
        const data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
        let offset = 0;
        while (offset + PACKET_SIZE <= data.length) {
            if (data[offset] !== 0x47 || (offset + PACKET_SIZE < data.length && data[offset + PACKET_SIZE] !== 0x47)) { offset++; continue; }
            this.readPacket(data.subarray(offset, offset + PACKET_SIZE));
            offset += PACKET_SIZE;
        }
        this.pending = Buffer.from(data.subarray(offset));
    }

    private readPacket(packet: Buffer): void {
        if (packet[1] & 0x80) return;
        const pid = ((packet[1] & 0x1f) << 8) | packet[2];
        const adaptation = (packet[3] >> 4) & 3;
        if (!adaptation) return;
        let offset = 4;
        if (adaptation & 2) {
            if (packet[4] > 0 && (packet[5] & 0x80)) this.discontinuities.add(pid);
            offset += packet[4] + 1;
        }
        if (!(adaptation & 1) || !(packet[1] & 0x40) || offset + 14 > PACKET_SIZE) return;
        if (packet[offset] !== 0 || packet[offset + 1] !== 0 || packet[offset + 2] !== 1) return;
        const stream = packet[offset + 3];
        if ((stream < 0xc0 || stream > 0xef) && stream !== 0xbd) return;
        if (!(packet[offset + 7] & 0x80) || packet[offset + 8] < 5) return;
        const pts = offset + 9;
        if (!(packet[pts] & 1) || !(packet[pts + 2] & 1) || !(packet[pts + 4] & 1)) return;
        const timestamp = ((packet[pts] >> 1) & 7) * 2 ** 30 + packet[pts + 1] * 2 ** 22
            + (packet[pts + 2] >> 1) * 2 ** 15 + packet[pts + 3] * 2 ** 7 + (packet[pts + 4] >> 1);
        const previous = this.clocks.get(pid);
        if (!previous) {
            this.clocks.set(pid, { timestamp, elapsed: 0 });
            this.discontinuities.delete(pid);
            return;
        }
        if (this.discontinuities.delete(pid)) { previous.timestamp = timestamp; return; }
        const difference = (timestamp - previous.timestamp + CLOCK_WRAP * 1.5) % CLOCK_WRAP - CLOCK_WRAP / 2;
        if (difference <= 0) return;
        previous.timestamp = timestamp;
        if (difference > CLOCK_RATE * 60) return;
        previous.elapsed += difference;
        this.elapsed = Math.max(this.elapsed, previous.elapsed);
        this.observed = true;
    }
}

export function aggregateDownloadProgress(progress: DownloadProgress, completedSeconds: number, partSeconds: number, totalSeconds: number): DownloadProgress {
    return { ...progress, progress: progress.progress < 0 || totalSeconds <= 0 ? -1
        : Math.min(100, (completedSeconds + partSeconds * Math.min(100, progress.progress) / 100) / totalSeconds * 100) };
}

interface Mp4Box { type: string; body: Buffer }
interface Mp4Clock { scale: number; defaultDuration: number; origin?: number; lastEnd: number; offset: number }

function mp4Boxes(data: Buffer): Mp4Box[] {
    const boxes: Mp4Box[] = [];
    for (let offset = 0; offset + 8 <= data.length;) {
        let size = data.readUInt32BE(offset), header = 8;
        if (size === 1) {
            if (offset + 16 > data.length) break;
            size = Number(data.readBigUInt64BE(offset + 8)); header = 16;
        }
        if (!Number.isSafeInteger(size) || size < header || offset + size > data.length) break;
        boxes.push({ type: data.toString('ascii', offset + 4, offset + 8), body: data.subarray(offset + header, offset + size) });
        offset += size;
    }
    return boxes;
}

export class FragmentedMp4Progress {
    private header = Buffer.alloc(0);
    private remaining = 0;
    private type = '';
    private parts: Buffer[] = [];
    private clocks = new Map<number, Mp4Clock>();
    private nextEnd = 0;
    private elapsed: number | null = null;
    private invalid = false;

    get seconds(): number | null { return this.elapsed; }

    push(data: Buffer): void {
        if (this.invalid) return;
        let offset = 0;
        while (offset < data.length) {
            if (this.remaining === 0) {
                const length = this.header.length >= 8 && this.header.readUInt32BE(0) === 1 ? 16 : 8;
                const count = Math.min(length - this.header.length, data.length - offset);
                this.header = Buffer.concat([this.header, data.subarray(offset, offset + count)]);
                offset += count;
                if (this.header.length < 8 || (this.header.readUInt32BE(0) === 1 && this.header.length < 16)) continue;
                const size = this.header.readUInt32BE(0) === 1 ? Number(this.header.readBigUInt64BE(8)) : this.header.readUInt32BE(0);
                this.type = this.header.toString('ascii', 4, 8);
                if (!Number.isSafeInteger(size) || size < this.header.length) { this.invalid = true; return; }
                this.remaining = size - this.header.length;
                if ((this.type === 'moov' || this.type === 'moof') && this.remaining > 4 * 1024 * 1024) { this.invalid = true; return; }
                this.header = Buffer.alloc(0);
                this.parts = [];
                if (!this.remaining) continue;
            }
            const count = Math.min(this.remaining, data.length - offset);
            if (this.type === 'moov' || this.type === 'moof') this.parts.push(Buffer.from(data.subarray(offset, offset + count)));
            offset += count; this.remaining -= count;
            if (this.remaining === 0) {
                if (this.type === 'moov') this.readTracks(Buffer.concat(this.parts));
                if (this.type === 'moof') this.readFragment(Buffer.concat(this.parts));
                if (this.type === 'mdat' && this.nextEnd > 0) this.elapsed = Math.max(this.elapsed || 0, this.nextEnd);
                this.parts = [];
            }
        }
    }

    private readTracks(data: Buffer): void {
        const boxes = mp4Boxes(data);
        for (const trak of boxes.filter(box => box.type === 'trak')) {
            const children = mp4Boxes(trak.body);
            const tkhd = children.find(box => box.type === 'tkhd')?.body;
            const mdia = children.find(box => box.type === 'mdia');
            if (!tkhd || !mdia) continue;
            const media = mp4Boxes(mdia.body);
            const mdhd = media.find(box => box.type === 'mdhd')?.body;
            const hdlr = media.find(box => box.type === 'hdlr')?.body;
            const idOffset = tkhd[0] === 1 ? 20 : 12;
            const scaleOffset = mdhd?.[0] === 1 ? 20 : 12;
            if (tkhd.length < idOffset + 4 || !mdhd || mdhd.length < scaleOffset + 4 || !hdlr || hdlr.length < 12
                || !['vide', 'soun'].includes(hdlr.toString('ascii', 8, 12))) continue;
            const id = tkhd.readUInt32BE(idOffset), scale = mdhd.readUInt32BE(scaleOffset);
            if (!scale) continue;
            if (this.clocks.get(id)?.scale !== scale) this.clocks.set(id, { scale, defaultDuration: 0, lastEnd: 0, offset: this.elapsed || 0 });
        }
        for (const mvex of boxes.filter(box => box.type === 'mvex')) for (const trex of mp4Boxes(mvex.body)) {
            if (trex.type !== 'trex' || trex.body.length < 16) continue;
            const clock = this.clocks.get(trex.body.readUInt32BE(4));
            if (clock) clock.defaultDuration = trex.body.readUInt32BE(12);
        }
    }

    private readFragment(data: Buffer): void {
        for (const traf of mp4Boxes(data).filter(box => box.type === 'traf')) {
            const boxes = mp4Boxes(traf.body);
            const tfhd = boxes.find(box => box.type === 'tfhd')?.body;
            const tfdt = boxes.find(box => box.type === 'tfdt')?.body;
            if (!tfhd || tfhd.length < 8 || !tfdt || tfdt.length < (tfdt[0] === 1 ? 12 : 8)) continue;
            const clock = this.clocks.get(tfhd.readUInt32BE(4));
            if (!clock) continue;
            const flags = tfhd.readUIntBE(1, 3);
            const offset = 8 + (flags & 1 ? 8 : 0) + (flags & 2 ? 4 : 0);
            let sampleDuration = clock.defaultDuration;
            if (flags & 8) { if (offset + 4 > tfhd.length) continue; sampleDuration = tfhd.readUInt32BE(offset); }
            const decodeTime = tfdt[0] === 1 ? Number(tfdt.readBigUInt64BE(4)) : tfdt.readUInt32BE(4);
            if (!Number.isSafeInteger(decodeTime)) continue;
            let duration = 0;
            for (const trun of boxes.filter(box => box.type === 'trun')) {
                const body = trun.body;
                if (body.length < 8) continue;
                const options = body.readUIntBE(1, 3), count = body.readUInt32BE(4);
                const stride = (options & 0x100 ? 4 : 0) + (options & 0x200 ? 4 : 0) + (options & 0x400 ? 4 : 0) + (options & 0x800 ? 4 : 0);
                const start = 8 + (options & 1 ? 4 : 0) + (options & 4 ? 4 : 0);
                if (start + count * stride > body.length || count > 1000000) continue;
                if (!(options & 0x100)) duration += count * sampleDuration;
                else for (let i = 0; i < count; i++) duration += body.readUInt32BE(start + i * stride);
            }
            if (clock.origin === undefined || decodeTime < clock.lastEnd - clock.scale) {
                if (clock.origin !== undefined) clock.offset += (clock.lastEnd - clock.origin) / clock.scale;
                clock.origin = decodeTime;
            }
            clock.lastEnd = Math.max(decodeTime, decodeTime + duration);
            this.nextEnd = Math.max(this.nextEnd, clock.offset + (clock.lastEnd - clock.origin) / clock.scale);
        }
    }
}

export class MediaDownloadProgress {
    private pending = Buffer.alloc(0);
    private tracker: MpegTsProgress | FragmentedMp4Progress | null = null;
    get seconds(): number | null { return this.tracker?.seconds ?? null; }
    push(chunk: Buffer): void {
        if (this.tracker) { this.tracker.push(chunk); return; }
        this.pending = Buffer.concat([this.pending, chunk]);
        if (this.pending.length < 8) return;
        this.tracker = ['ftyp', 'styp', 'moov'].includes(this.pending.toString('ascii', 4, 8)) ? new FragmentedMp4Progress() : new MpegTsProgress();
        this.tracker.push(this.pending);
        this.pending = Buffer.alloc(0);
    }
}
