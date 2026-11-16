import { describe, expect, it } from 'vitest';
import { composeSheet, cropCells, drawText, labelStripHeight, scanTimes, sheetGeometry } from './frame-sheet';

function pixel(buffer: Buffer, width: number, x: number, y: number): number[] {
    const offset = (y * width + x) * 3;
    return [buffer[offset], buffer[offset + 1], buffer[offset + 2]];
}

function litPixels(buffer: Buffer, width: number, left: number, top: number, right: number, bottom: number): number {
    let count = 0;
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) if (pixel(buffer, width, x, y)[0] === 240) count++;
    return count;
}

describe('sheetGeometry', () => {
    it('keeps every sheet within 1536 pixels and uses 16:9 frames', () => {
        for (let columns = 1; columns <= 8; columns++) {
            const geometry = sheetGeometry(columns);
            const width = columns * geometry.frameWidth + (columns - 1) * 2;
            const height = geometry.rowsPerSheet * (geometry.frameHeight + labelStripHeight(geometry.frameWidth)) + (geometry.rowsPerSheet - 1) * 2;
            expect(width).toBeLessThanOrEqual(1536);
            expect(height).toBeLessThanOrEqual(1536);
            expect(geometry.frameWidth % 2).toBe(0);
            expect(geometry.frameHeight % 2).toBe(0);
            expect(Math.abs(geometry.frameWidth / geometry.frameHeight - 16 / 9)).toBeLessThan(0.02);
            expect(geometry.framesPerSheet).toBe(columns * geometry.rowsPerSheet);
        }
        expect(sheetGeometry(5)).toMatchObject({ columns: 5, frameWidth: 304, frameHeight: 172, rowsPerSheet: 7, framesPerSheet: 35 });
        expect(sheetGeometry(1)).toMatchObject({ frameWidth: 1536, frameHeight: 864, rowsPerSheet: 1 });
        expect(sheetGeometry(99).columns).toBe(8);
        expect(sheetGeometry(8).rowsPerSheet).toBeLessThanOrEqual(10);
    });
});

describe('drawText', () => {
    it('draws scaled digits and leaves the rest untouched', () => {
        const width = 40, buffer = Buffer.alloc(width * 20 * 3, 18);
        drawText(buffer, width, 2, 3, '1', 2);
        expect(pixel(buffer, width, 2 + 2 * 2, 3)).toEqual([240, 240, 240]);
        expect(pixel(buffer, width, 2, 3)).toEqual([18, 18, 18]);
        expect(litPixels(buffer, width, 0, 0, width, 20)).toBe(10 * 4);
        expect(litPixels(buffer, width, 14, 0, width, 20)).toBe(0);
    });

    it('never writes outside the image', () => {
        const buffer = Buffer.alloc(10 * 10 * 3, 18);
        expect(() => drawText(buffer, 10, 6, 6, '88:88', 3)).not.toThrow();
        expect(buffer.length).toBe(300);
    });
});

describe('composeSheet', () => {
    const geometry = { columns: 3, frameWidth: 16, frameHeight: 10 };
    const frame = (value: number) => Buffer.alloc(16 * 10 * 3, value);

    it('places frames in reading order with a time label below each one', () => {
        const sheet = composeSheet([
            { rgb: frame(100), label: '00:00:00' }, { rgb: frame(110), label: '00:01:00' }, { rgb: frame(120), label: '00:02:00' }, { rgb: frame(130), label: '00:03:00' },
        ], geometry);
        const strip = labelStripHeight(16);
        expect(sheet.width).toBe(3 * 16 + 2 * 2);
        expect(sheet.height).toBe(2 * (10 + strip) + 2);
        expect(sheet.rgb.length).toBe(sheet.width * sheet.height * 3);
        expect(pixel(sheet.rgb, sheet.width, 0, 0)).toEqual([100, 100, 100]);
        expect(pixel(sheet.rgb, sheet.width, 18, 9)).toEqual([110, 110, 110]);
        expect(pixel(sheet.rgb, sheet.width, 36, 5)).toEqual([120, 120, 120]);
        expect(pixel(sheet.rgb, sheet.width, 0, 10 + strip + 2)).toEqual([130, 130, 130]);
        expect(pixel(sheet.rgb, sheet.width, 16, 0)).toEqual([18, 18, 18]);
        expect(litPixels(sheet.rgb, sheet.width, 0, 10, sheet.width, 10 + strip)).toBeGreaterThan(50);
        expect(litPixels(sheet.rgb, sheet.width, 0, 0, sheet.width, 10)).toBe(0);
    });

    it('keeps the cell of an unreadable frame dark and still shows its time', () => {
        const sheet = composeSheet([{ rgb: frame(100), label: '00:00:00' }, { rgb: null, label: '00:01:00' }, { rgb: Buffer.alloc(5), label: '00:02:00' }], geometry);
        expect(pixel(sheet.rgb, sheet.width, 18, 4)).toEqual([18, 18, 18]);
        expect(pixel(sheet.rgb, sheet.width, 36, 4)).toEqual([18, 18, 18]);
        expect(litPixels(sheet.rgb, sheet.width, 18, 10, 34, sheet.height)).toBeGreaterThan(0);
    });

    it('shrinks a sheet with fewer frames than columns', () => {
        const sheet = composeSheet([{ rgb: frame(100), label: '00:00:00' }], { columns: 5, frameWidth: 16, frameHeight: 10 });
        expect(sheet.width).toBe(16);
        expect(sheet.height).toBe(10 + labelStripHeight(16));
    });
});

describe('cropCells', () => {
    it('cuts a sprite into its cells', () => {
        const sprite = Buffer.alloc(4 * 4 * 3);
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) sprite.fill((y < 2 ? 0 : 2) + (x < 2 ? 1 : 2), (y * 4 + x) * 3, (y * 4 + x) * 3 + 3);
        const cells = cropCells(sprite, 4, 2, 2, 2, 4);
        expect(cells.map(cell => cell![0])).toEqual([1, 2, 3, 4]);
        expect(cells.every(cell => cell!.length === 12)).toBe(true);
        expect(cropCells(sprite, 4, 2, 2, 2, 5)[4]).toBeNull();
    });
});

describe('scanTimes', () => {
    it('lists times at the interval and names where to continue', () => {
        expect(scanTimes(0, 600, 60, 80)).toEqual({ times: [0, 60, 120, 180, 240, 300, 360, 420, 480, 540], nextFrom: null });
        expect(scanTimes(100, 400, 100, 2)).toEqual({ times: [100, 200], nextFrom: 300 });
        expect(scanTimes(10, 13, 1.5, 10)).toEqual({ times: [10, 11.5], nextFrom: null });
    });
});
